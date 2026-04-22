import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import type { Adapter, SpawnCommand, StartOptions, FrameworkType } from '../types.js';

function fileExists(p: string): boolean {
  return existsSync(p);
}

function isFvmInstalled(): Promise<boolean> {
  return new Promise(resolve => {
    const proc = spawn('which', ['fvm'], { stdio: 'ignore' });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

function isFvmProject(projectPath: string): boolean {
  return (
    fileExists(join(projectPath, '.fvm', 'flutter_sdk')) ||
    fileExists(join(projectPath, 'fvm_config.json')) ||
    fileExists(join(projectPath, '.fvmrc'))
  );
}

export class FlutterAdapter implements Adapter {
  readonly frameworkType: FrameworkType = 'flutter';

  async detect(projectPath: string): Promise<boolean> {
    return fileExists(join(projectPath, 'pubspec.yaml'));
  }

  async buildCommand(projectPath: string, options: StartOptions): Promise<SpawnCommand> {
    let useFvm = options.useFvm;

    if (useFvm === undefined) {
      const fvmInstalled = await isFvmInstalled();
      useFvm = fvmInstalled && isFvmProject(projectPath);
    }

    const executable = useFvm ? 'fvm' : 'flutter';
    const args: string[] = useFvm ? ['flutter', 'run'] : ['run'];

    if (options.device) {
      args.push('-d', options.device);
    }

    if (options.customArgs) {
      args.push(...options.customArgs);
    }

    return { executable, args, cwd: projectPath };
  }
}
