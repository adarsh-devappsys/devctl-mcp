import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { LogStore } from './log-store.js';
import { detectAdapter } from './adapters/registry.js';
import { Store } from './store.js';
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
  process: ChildProcess | null; // null for orphaned processes
  projectPath: string;
  options: StartOptions;
  adapter: Adapter | null; // null for orphaned processes
}

export class ProcessManager {
  private registry = new Map<string, ProcessRecord>();
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Called once at startup — loads previously running processes and checks if their PIDs are alive. */
  async recoverOrphans(): Promise<void> {
    const orphans = this.store.getOrphans();
    if (orphans.length === 0) return;

    log(`Checking ${orphans.length} previously active process(es) for dangling PIDs...`);

    for (const row of orphans) {
      const isAlive = row.pid != null && isPidOurs(row.pid, row.command, row.projectPath);
      const status: ProcessStatus = isAlive ? 'orphaned' : 'crashed';

      this.store.updateStatus(row.name, status);

      const options: StartOptions = JSON.parse(row.optionsJson ?? '{}');

      const meta: ManagedProcess = {
        name: row.name,
        projectPath: row.projectPath,
        framework: row.framework,
        status,
        pid: row.pid ?? undefined,
        startedAt: row.startedAt ?? undefined,
        command: row.command,
        vmServiceUrl: row.vmServiceUrl ?? undefined,
      };

      this.registry.set(row.name, {
        meta,
        logs: new LogStore(),
        process: null,
        projectPath: row.projectPath,
        options,
        adapter: null,
      });

      log(
        `  "${row.name}" (PID ${row.pid}) → ${status}` +
        (isAlive ? ' — call stop_process to kill it' : '')
      );
    }
  }

  async start(
    name: string,
    projectPath: string,
    options: StartOptions = {}
  ): Promise<ManagedProcess> {
    if (!existsSync(projectPath)) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }

    const existing = this.registry.get(name);
    if (existing) {
      const s = existing.meta.status;
      if (s === 'running' || s === 'starting') {
        throw new Error(`Process "${name}" is already ${s}. Stop it first.`);
      }
      if (s === 'orphaned') {
        throw new Error(
          `Process "${name}" is orphaned (PID ${existing.meta.pid} may still be running). ` +
          `Call stop_process first to kill the dangling process.`
        );
      }
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
    this.store.upsert(meta, options);

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
          this.store.updateStatus(name, 'running');
          this.store.updateStartedAt(name, meta.startedAt);
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
          this.store.updateStatus(name, 'running');
          this.store.updateStartedAt(name, meta.startedAt);
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
      this.store.updateStatus(name, meta.status);
      const msg = `[devctl-mcp] Process exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      logs.append('stderr', msg);
      log(`"${name}" ${wasRunning && code !== 0 ? 'crashed' : 'stopped'} (code=${code})`);
    });

    child.on('error', (err) => {
      meta.status = 'crashed';
      this.store.updateStatus(name, 'crashed');
      logs.append('stderr', `[devctl-mcp] Spawn error: ${err.message}`);
      log(`"${name}" spawn error: ${err.message}`);
    });

    return meta;
  }

  async stop(name: string): Promise<void> {
    const record = this.registry.get(name);
    if (!record) throw new Error(`No process named "${name}"`);

    const { meta } = record;

    // Orphaned process — kill by PID directly since we have no ChildProcess handle
    if (meta.status === 'orphaned' && meta.pid != null) {
      log(`Killing orphaned process "${name}" (PID ${meta.pid})`);
      killPid(meta.pid);
      meta.status = 'stopped';
      this.store.updateStatus(name, 'stopped');
      return;
    }

    if (meta.status === 'stopped' || meta.status === 'crashed') {
      return; // Already stopped
    }

    const child = record.process;
    if (!child) return;

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
    if (!record.process?.stdin) throw new Error(`Process "${name}" has no stdin`);
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
    this.store.updateVmServiceUrl(meta.name, httpUrl);

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that the process at `pid` is actually the one we spawned by checking
 * its command line via `ps`. Guards against PID recycling — the OS may have
 * reused the PID for an unrelated process after our process died.
 *
 * Checks that ps output contains the executable (e.g. "fvm"/"flutter") or
 * the project path — either is sufficient to confirm identity.
 */
function isPidOurs(pid: number, command: string, projectPath: string): boolean {
  try {
    const psOutput = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();

    if (!psOutput) return false;

    const executable = command.split(' ')[0]; // e.g. "fvm" or "flutter"
    return psOutput.includes(executable) || psOutput.includes(projectPath);
  } catch {
    return false; // ps failed or PID doesn't exist — not ours
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
    // Give it 3 seconds then SIGKILL
    setTimeout(() => {
      try {
        if (isPidAlive(pid)) process.kill(pid, 'SIGKILL');
      } catch { /* already dead */ }
    }, 3000);
  } catch { /* already dead */ }
}
