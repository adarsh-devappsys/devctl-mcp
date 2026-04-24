import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProcessManager } from '../process-manager.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ErrorResult = ToolResult & { isError: true };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ErrorResult {
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
}

export function registerProcessTools(server: McpServer, pm: ProcessManager): void {
  // ── list_processes ──────────────────────────────────────────────────────────
  server.tool(
    'list_processes',
    'List all managed dev processes with their status, uptime, PID and framework',
    {},
    async () => {
      const processes = pm.list();
      if (processes.length === 0) {
        return ok({ message: 'No processes running', processes: [] });
      }
      return ok({ processes });
    }
  );

  // ── start_process ───────────────────────────────────────────────────────────
  server.tool(
    'start_process',
    'Start a dev server process. Auto-detects the framework from the project directory.',
    {
      name: z.string().describe('Unique name for this process (e.g. "myapp", "backend")'),
      project_path: z.string().describe('Absolute path to the project directory'),
      device: z.string().optional().describe('(Flutter) Target device ID. Use list_devices to see options'),
      use_fvm: z.boolean().optional().describe('(Flutter) Force enable/disable FVM. Default: auto-detect from project'),
      package_manager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).optional()
        .describe('(JS projects) Override package manager. Default: auto-detect from lockfile'),
      build_tool: z.enum(['maven', 'gradle']).optional()
        .describe('(Spring Boot) Override build tool. Default: auto-detect from pom.xml/build.gradle'),
      command: z.string().optional()
        .describe('Custom command (required for unrecognized frameworks, e.g. "python manage.py runserver")'),
      custom_args: z.array(z.string()).optional()
        .describe('Additional arguments appended to the run command'),
      env: z.record(z.string()).optional()
        .describe('Environment variables to set for the process (e.g. {"SPRING_PROFILES_ACTIVE": "local", "DATABASE_URL": "jdbc:..."})'),
    },
    async (args) => {
      try {
        const meta = await pm.start(args.name, args.project_path, {
          device: args.device,
          useFvm: args.use_fvm,
          packageManager: args.package_manager,
          buildTool: args.build_tool,
          command: args.command,
          customArgs: args.custom_args,
          env: args.env,
        });
        return ok({
          message: `Started "${args.name}" [${meta.framework}]`,
          process: {
            name: meta.name,
            framework: meta.framework,
            status: meta.status,
            pid: meta.pid,
            command: meta.command,
          },
        });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── stop_process ────────────────────────────────────────────────────────────
  server.tool(
    'stop_process',
    'Gracefully stop a managed dev process (SIGTERM, then SIGKILL after 5s)',
    {
      name: z.string().describe('Process name to stop'),
    },
    async (args) => {
      try {
        await pm.stop(args.name);
        return ok({ message: `Stopped "${args.name}"` });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── restart_process ─────────────────────────────────────────────────────────
  server.tool(
    'restart_process',
    'Stop and restart a managed process with its original configuration',
    {
      name: z.string().describe('Process name to restart'),
    },
    async (args) => {
      try {
        const meta = await pm.restart(args.name);
        return ok({
          message: `Restarted "${args.name}"`,
          process: { name: meta.name, status: meta.status, pid: meta.pid },
        });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── get_logs ────────────────────────────────────────────────────────────────
  server.tool(
    'get_logs',
    'Get recent log output from a managed process (stdout + stderr)',
    {
      name: z.string().describe('Process name'),
      lines: z.number().int().positive().optional()
        .describe('Number of most recent lines to return (default: 100)'),
      filter: z.string().optional()
        .describe('Only return lines containing this string (case-sensitive)'),
      include_timestamps: z.boolean().optional()
        .describe('Prefix each line with ISO timestamp (default: false)'),
    },
    async (args) => {
      try {
        const entries = pm.getLogs(args.name, args.lines ?? 100, args.filter);
        const lines = entries.map(e => {
          const prefix = args.include_timestamps
            ? `[${new Date(e.timestamp).toISOString()}] [${e.stream}] `
            : `[${e.stream}] `;
          return prefix + e.line;
        });
        return ok({
          name: args.name,
          total_lines: lines.length,
          logs: lines.join('\n'),
        });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── clear_logs ──────────────────────────────────────────────────────────────
  server.tool(
    'clear_logs',
    'Clear the log buffer for a managed process',
    {
      name: z.string().describe('Process name'),
    },
    async (args) => {
      try {
        pm.clearLogs(args.name);
        return ok({ message: `Cleared logs for "${args.name}"` });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── send_input ──────────────────────────────────────────────────────────────
  server.tool(
    'send_input',
    'Send raw text to a process stdin. Useful for interactive prompts or manual commands.',
    {
      name: z.string().describe('Process name'),
      text: z.string().describe('Text to send (a newline is appended automatically)'),
    },
    async (args) => {
      try {
        pm.sendInput(args.name, args.text);
        return ok({ message: `Sent input to "${args.name}": ${JSON.stringify(args.text)}` });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );
}
