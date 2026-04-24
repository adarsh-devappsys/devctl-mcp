import type { Adapter, SpawnCommand, StartOptions, FrameworkType } from '../types.js';

export class GenericAdapter implements Adapter {
  readonly frameworkType: FrameworkType = 'generic';

  async detect(_projectPath: string): Promise<boolean> {
    return true; // Always matches — must be last in chain
  }

  async buildCommand(projectPath: string, options: StartOptions): Promise<SpawnCommand> {
    if (!options.command) {
      throw new Error(
        'Generic adapter requires a "command" option. ' +
        'No recognized framework was detected in the project directory.'
      );
    }

    // Use shell execution to support env vars (FOO=bar cmd), pipes, redirects, etc.
    const fullCommand = options.customArgs?.length
      ? `${options.command} ${options.customArgs.join(' ')}`
      : options.command;

    const shell = process.platform === 'win32' ? 'cmd' : '/bin/sh';
    const shellFlag = process.platform === 'win32' ? '/c' : '-c';

    return { executable: shell, args: [shellFlag, fullCommand], cwd: projectPath };
  }
}
