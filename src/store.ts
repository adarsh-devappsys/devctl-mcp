import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ManagedProcess, StartOptions, FrameworkType, ProcessStatus } from './types.js';

const DB_DIR = join(homedir(), '.devctl-mcp');
const DB_PATH = join(DB_DIR, 'state.db');

export interface PersistedProcess {
  name: string;
  pid: number | null;
  projectPath: string;
  framework: FrameworkType;
  status: ProcessStatus;
  command: string;
  startedAt: number | null;
  optionsJson: string; // JSON-serialized StartOptions
  vmServiceUrl: string | null;
}

export class Store {
  private db: Database.Database;

  constructor() {
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processes (
        name        TEXT PRIMARY KEY,
        pid         INTEGER,
        project_path TEXT NOT NULL,
        framework   TEXT NOT NULL,
        status      TEXT NOT NULL,
        command     TEXT NOT NULL,
        started_at  INTEGER,
        options_json TEXT NOT NULL DEFAULT '{}',
        vm_service_url TEXT
      );
    `);
  }

  upsert(meta: ManagedProcess, options: StartOptions): void {
    this.db.prepare(`
      INSERT INTO processes (name, pid, project_path, framework, status, command, started_at, options_json, vm_service_url)
      VALUES (@name, @pid, @projectPath, @framework, @status, @command, @startedAt, @optionsJson, @vmServiceUrl)
      ON CONFLICT(name) DO UPDATE SET
        pid           = excluded.pid,
        project_path  = excluded.project_path,
        framework     = excluded.framework,
        status        = excluded.status,
        command       = excluded.command,
        started_at    = excluded.started_at,
        options_json  = excluded.options_json,
        vm_service_url = excluded.vm_service_url
    `).run({
      name: meta.name,
      pid: meta.pid ?? null,
      projectPath: meta.projectPath,
      framework: meta.framework,
      status: meta.status,
      command: meta.command,
      startedAt: meta.startedAt ?? null,
      optionsJson: JSON.stringify(options),
      vmServiceUrl: meta.vmServiceUrl ?? null,
    });
  }

  updateStatus(name: string, status: ProcessStatus): void {
    this.db.prepare(`UPDATE processes SET status = ? WHERE name = ?`).run(status, name);
  }

  updateVmServiceUrl(name: string, url: string): void {
    this.db.prepare(`UPDATE processes SET vm_service_url = ? WHERE name = ?`).run(url, name);
  }

  updateStartedAt(name: string, startedAt: number): void {
    this.db.prepare(`UPDATE processes SET started_at = ? WHERE name = ?`).run(startedAt, name);
  }

  /** Returns all processes that were active (starting/running) when the server last shut down. */
  getOrphans(): PersistedProcess[] {
    return (this.db.prepare(`
      SELECT name, pid, project_path as projectPath, framework, status, command, started_at as startedAt, options_json as optionsJson, vm_service_url as vmServiceUrl
      FROM processes
      WHERE status IN ('starting', 'running', 'orphaned')
    `).all() as PersistedProcess[]);
  }

  getAll(): PersistedProcess[] {
    return (this.db.prepare(`
      SELECT name, pid, project_path as projectPath, framework, status, command, started_at as startedAt, options_json as optionsJson, vm_service_url as vmServiceUrl
      FROM processes
    `).all() as PersistedProcess[]);
  }

  remove(name: string): void {
    this.db.prepare(`DELETE FROM processes WHERE name = ?`).run(name);
  }

  close(): void {
    this.db.close();
  }
}
