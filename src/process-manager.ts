import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { LogStore } from './log-store.js';
import { detectAdapter } from './adapters/registry.js';
import type {
  ManagedProcess,
  ProcessSummary,
  ProcessStatus,
  StartOptions,
  LogEntry,
  Adapter,
} from './types.js';

const log = (...args: unknown[]) =>
  process.stderr.write('[devctl-mcp] ' + args.join(' ') + '\n');

// VM service URL pattern printed by flutter run
const VM_SERVICE_PATTERN =
  /(?:A Dart VM Service|The Dart VM service) on .+ is available at:\s*(https?:\/\/\S+)/i;

// Also match newer flutter output format
const VM_SERVICE_PATTERN2 = /Flutter run key commands.*\nDart VM Service: (https?:\/\/\S+)/;

interface ProcessRecord {
  meta: ManagedProcess;
  logs: LogStore;
  process: ChildProcess;
  projectPath: string;
  options: StartOptions;
  adapter: Adapter;
}

export class ProcessManager {
  private registry = new Map<string, ProcessRecord>();

  async start(
    name: string,
    projectPath: string,
    options: StartOptions = {}
  ): Promise<ManagedProcess> {
    if (!existsSync(projectPath)) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }

    const existing = this.registry.get(name);
    if (existing && (existing.meta.status === 'running' || existing.meta.status === 'starting')) {
      throw new Error(`Process "${name}" is already ${existing.meta.status}. Stop it first.`);
    }

    const adapter = await detectAdapter(projectPath);
    const spawnCmd = await adapter.buildCommand(projectPath, options);

    log(`Starting "${name}" [${adapter.frameworkType}]: ${spawnCmd.executable} ${spawnCmd.args.join(' ')}`);

    const child = spawn(spawnCmd.executable, spawnCmd.args, {
      cwd: spawnCmd.cwd,
      env: { ...process.env, ...spawnCmd.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const logs = new LogStore();
    const commandStr = `${spawnCmd.executable} ${spawnCmd.args.join(' ')}`;

    const meta: ManagedProcess = {
      name,
      projectPath,
      framework: adapter.frameworkType,
      status: 'starting',
      pid: child.pid,
      command: commandStr,
    };

    const record: ProcessRecord = {
      meta,
      logs,
      process: child,
      projectPath,
      options,
      adapter,
    };

    this.registry.set(name, record);

    // Pipe stdout
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line) continue;
        logs.append('stdout', line);
        if (meta.status === 'starting') {
          meta.status = 'running';
          meta.startedAt = Date.now();
        }
        this.parseVmServiceUrl(meta, line);
      }
    });

    // Pipe stderr
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line) continue;
        logs.append('stderr', line);
        if (meta.status === 'starting') {
          meta.status = 'running';
          meta.startedAt = Date.now();
        }
        this.parseVmServiceUrl(meta, line);
      }
    });

    // Handle process exit
    child.on('exit', (code, signal) => {
      meta.exitCode = code ?? undefined;
      meta.exitSignal = signal ?? undefined;
      const wasRunning = meta.status !== 'stopping';
      meta.status = code === 0 ? 'stopped' : 'crashed';
      const msg = `[devctl-mcp] Process exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      logs.append('stderr', msg);
      log(`"${name}" ${wasRunning && code !== 0 ? 'crashed' : 'stopped'} (code=${code})`);
    });

    child.on('error', (err) => {
      meta.status = 'crashed';
      logs.append('stderr', `[devctl-mcp] Spawn error: ${err.message}`);
      log(`"${name}" spawn error: ${err.message}`);
    });

    return meta;
  }

  async stop(name: string): Promise<void> {
    const record = this.registry.get(name);
    if (!record) throw new Error(`No process named "${name}"`);

    const { meta, process: child } = record;
    if (meta.status === 'stopped' || meta.status === 'crashed') {
      return; // Already stopped
    }

    meta.status = 'stopping';

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        log(`"${name}" did not exit after SIGTERM, sending SIGKILL`);
        child.kill('SIGKILL');
        resolve();
      }, 5000);

      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      child.kill('SIGTERM');
    });
  }

  async restart(name: string): Promise<ManagedProcess> {
    const record = this.registry.get(name);
    if (!record) throw new Error(`No process named "${name}"`);

    const { projectPath, options } = record;
    await this.stop(name);
    this.registry.delete(name);
    return this.start(name, projectPath, options);
  }

  get(name: string): ManagedProcess {
    const record = this.registry.get(name);
    if (!record) throw new Error(`No process named "${name}"`);
    return record.meta;
  }

  getRecord(name: string): ProcessRecord {
    const record = this.registry.get(name);
    if (!record) throw new Error(`No process named "${name}"`);
    return record;
  }

  list(): ProcessSummary[] {
    const now = Date.now();
    return Array.from(this.registry.values()).map(({ meta }) => ({
      name: meta.name,
      status: meta.status,
      framework: meta.framework,
      pid: meta.pid,
      uptimeSeconds:
        meta.startedAt && meta.status === 'running'
          ? Math.floor((now - meta.startedAt) / 1000)
          : undefined,
      command: meta.command,
      vmServiceUrl: meta.vmServiceUrl,
    }));
  }

  getLogs(name: string, count?: number, filter?: string): LogEntry[] {
    const record = this.registry.get(name);
    if (!record) throw new Error(`No process named "${name}"`);
    return record.logs.getLines(count, filter);
  }

  clearLogs(name: string): void {
    const record = this.registry.get(name);
    if (!record) throw new Error(`No process named "${name}"`);
    record.logs.clear();
  }

  sendInput(name: string, text: string): void {
    const record = this.registry.get(name);
    if (!record) throw new Error(`No process named "${name}"`);
    if (!record.process.stdin) throw new Error(`Process "${name}" has no stdin`);
    record.process.stdin.write(text + '\n');
  }

  async stopAll(): Promise<void> {
    const stops = Array.from(this.registry.keys()).map(name => this.stop(name).catch(() => {}));
    await Promise.all(stops);
  }

  private parseVmServiceUrl(meta: ManagedProcess, line: string): void {
    if (meta.vmServiceUrl) return; // Already found

    const m = VM_SERVICE_PATTERN.exec(line) ?? VM_SERVICE_PATTERN2.exec(line);
    if (!m) return;

    const httpUrl = m[1].trim();
    meta.vmServiceUrl = httpUrl;

    // Derive WebSocket URL: http://host:port/token=/ → ws://host:port/token=/ws
    try {
      const u = new URL(httpUrl);
      u.protocol = 'ws:';
      if (!u.pathname.endsWith('/')) u.pathname += '/';
      u.pathname += 'ws';
      meta.vmServiceWsUrl = u.toString();
      log(`VM service detected for "${meta.name}": ${meta.vmServiceUrl}`);
    } catch {
      // Not a valid URL, ignore
    }
  }
}
