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

    // Split command into executable + args
    const parts = options.command.trim().split(/\s+/);
    const executable = parts[0];
    const args = [...parts.slice(1), ...(options.customArgs ?? [])];

    return { executable, args, cwd: projectPath };
  }
}
