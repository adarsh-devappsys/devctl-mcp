import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import WebSocket from 'ws';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProcessManager } from '../process-manager.js';

const execFileAsync = promisify(execFile);
const log = (...args: unknown[]) =>
  process.stderr.write('[devctl-mcp] ' + args.join(' ') + '\n');

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ErrorResult = ToolResult & { isError: true };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ErrorResult {
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
}

// ── Dart VM Service RPC ───────────────────────────────────────────────────────

interface VmRpcResult {
  [key: string]: unknown;
}

function vmServiceRpc(
  wsUrl: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<VmRpcResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 100000);

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`VM service RPC timeout calling ${method}`));
    }, 8000);

    ws.once('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as {
        id: number;
        result?: VmRpcResult;
        error?: { message: string };
      };
      if (msg.id !== id) return; // Not our response
      clearTimeout(timeout);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result ?? {});
    });

    ws.once('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

async function getIsolateId(wsUrl: string): Promise<string> {
  const vm = await vmServiceRpc(wsUrl, 'getVM');
  const isolates = vm['isolates'] as Array<{ id: string }>;
  if (!isolates?.length) throw new Error('No isolates found in Dart VM');
  return isolates[0].id;
}

async function hotReload(wsUrl: string): Promise<void> {
  const isolateId = await getIsolateId(wsUrl);
  log(`Hot reload: reloadSources isolate=${isolateId}`);
  await vmServiceRpc(wsUrl, 'reloadSources', { isolateId, force: false, pause: false });
  log(`Hot reload: reassemble`);
  await vmServiceRpc(wsUrl, 'callServiceExtension', {
    isolateId,
    method: 'ext.flutter.reassemble',
  });
}

async function hotRestart(wsUrl: string): Promise<void> {
  const isolateId = await getIsolateId(wsUrl);
  log(`Hot restart: callService hotRestart isolate=${isolateId}`);
  await vmServiceRpc(wsUrl, 'callService', { isolateId, method: 'hotRestart' });
}

// ── Flutter Devices ───────────────────────────────────────────────────────────

interface FlutterDevice {
  id: string;
  name: string;
  platform: string;
  emulator: boolean;
  sdk: string;
}

async function listFlutterDevices(): Promise<FlutterDevice[]> {
  // Try regular flutter first, then fvm flutter
  const commands: [string, string[]][] = [
    ['flutter', ['devices', '--machine']],
    ['fvm', ['flutter', 'devices', '--machine']],
  ];

  for (const [executable, args] of commands) {
    try {
      const { stdout } = await execFileAsync(executable, args, { timeout: 15_000 });
      const devices = JSON.parse(stdout) as Array<{
        id: string;
        name: string;
        targetPlatform: string;
        emulator?: boolean;
        sdk: string;
      }>;
      return devices.map(d => ({
        id: d.id,
        name: d.name,
        platform: d.targetPlatform,
        emulator: d.emulator ?? false,
        sdk: d.sdk,
      }));
    } catch {
      continue;
    }
  }

  throw new Error('Could not list Flutter devices. Is Flutter installed?');
}

// ── Register Tools ────────────────────────────────────────────────────────────

export function registerFlutterTools(server: McpServer, pm: ProcessManager): void {
  // ── flutter_hot_reload ────────────────────────────────────────────────────
  server.tool(
    'flutter_hot_reload',
    'Trigger Flutter hot reload on a running flutter process. Uses Dart VM service if available, falls back to sending "r" to stdin.',
    {
      name: z.string().describe('Name of the running Flutter process'),
    },
    async (args) => {
      try {
        const meta = pm.get(args.name);
        if (meta.status !== 'running') {
          return err(`Process "${args.name}" is not running (status: ${meta.status})`);
        }
        if (meta.framework !== 'flutter') {
          return err(`Process "${args.name}" is not a Flutter process (framework: ${meta.framework})`);
        }

        if (meta.vmServiceWsUrl) {
          try {
            await hotReload(meta.vmServiceWsUrl);
            return ok({ message: `Hot reload triggered for "${args.name}" via VM service` });
          } catch (vmErr) {
            log(`VM service hot reload failed, falling back to stdin: ${(vmErr as Error).message}`);
            pm.sendInput(args.name, 'r');
            return ok({
              message: `Hot reload triggered for "${args.name}" via stdin (VM service failed: ${(vmErr as Error).message})`,
            });
          }
        } else {
          pm.sendInput(args.name, 'r');
          return ok({
            message: `Hot reload sent to "${args.name}" via stdin. Note: VM service URL not yet available — app may still be starting up.`,
          });
        }
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── flutter_hot_restart ───────────────────────────────────────────────────
  server.tool(
    'flutter_hot_restart',
    'Trigger Flutter hot restart (full widget tree rebuild) on a running flutter process. Uses Dart VM service if available, falls back to "R" stdin.',
    {
      name: z.string().describe('Name of the running Flutter process'),
    },
    async (args) => {
      try {
        const meta = pm.get(args.name);
        if (meta.status !== 'running') {
          return err(`Process "${args.name}" is not running (status: ${meta.status})`);
        }
        if (meta.framework !== 'flutter') {
          return err(`Process "${args.name}" is not a Flutter process (framework: ${meta.framework})`);
        }

        if (meta.vmServiceWsUrl) {
          try {
            await hotRestart(meta.vmServiceWsUrl);
            return ok({ message: `Hot restart triggered for "${args.name}" via VM service` });
          } catch (vmErr) {
            log(`VM service hot restart failed, falling back to stdin: ${(vmErr as Error).message}`);
            pm.sendInput(args.name, 'R');
            return ok({
              message: `Hot restart triggered for "${args.name}" via stdin (VM service failed: ${(vmErr as Error).message})`,
            });
          }
        } else {
          pm.sendInput(args.name, 'R');
          return ok({
            message: `Hot restart sent to "${args.name}" via stdin. Note: VM service URL not yet available — app may still be starting up.`,
          });
        }
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── list_devices ──────────────────────────────────────────────────────────
  server.tool(
    'list_devices',
    'List all available Flutter devices and emulators',
    {},
    async () => {
      try {
        const devices = await listFlutterDevices();
        if (devices.length === 0) {
          return ok({ message: 'No Flutter devices found. Connect a device or start an emulator.', devices: [] });
        }
        return ok({ devices });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );
}
