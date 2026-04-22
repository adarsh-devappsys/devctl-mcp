// ─── Log Store ───────────────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: number;
  stream: 'stdout' | 'stderr';
  line: string;
}

// ─── Process Lifecycle ────────────────────────────────────────────────────────

export type ProcessStatus =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'crashed';

export type FrameworkType =
  | 'flutter'
  | 'nextjs'
  | 'spring-boot'
  | 'vite'
  | 'generic';

export interface ManagedProcess {
  name: string;
  projectPath: string;
  framework: FrameworkType;
  status: ProcessStatus;
  pid?: number;
  startedAt?: number;
  exitCode?: number;
  exitSignal?: string;
  command: string;
  // Flutter-specific
  vmServiceUrl?: string;
  vmServiceWsUrl?: string;
}

export interface ProcessSummary {
  name: string;
  status: ProcessStatus;
  framework: FrameworkType;
  pid?: number;
  uptimeSeconds?: number;
  command: string;
  vmServiceUrl?: string;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export interface StartOptions {
  // Flutter
  device?: string;
  useFvm?: boolean;
  // JS frameworks
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  // Spring Boot
  buildTool?: 'maven' | 'gradle';
  // Generic
  command?: string;
  customArgs?: string[];
}

export interface SpawnCommand {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
}

export interface Adapter {
  readonly frameworkType: FrameworkType;
  detect(projectPath: string): Promise<boolean>;
  buildCommand(projectPath: string, options: StartOptions): Promise<SpawnCommand>;
}
