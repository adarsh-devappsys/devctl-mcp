import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Adapter, SpawnCommand, StartOptions, FrameworkType } from '../types.js';

function fileExists(p: string): boolean {
  return existsSync(p);
}

function detectPackageManager(projectPath: string): 'bun' | 'pnpm' | 'yarn' | 'npm' {
  if (fileExists(join(projectPath, 'bun.lockb'))) return 'bun';
  if (fileExists(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fileExists(join(projectPath, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

export class NextjsAdapter implements Adapter {
  readonly frameworkType: FrameworkType = 'nextjs';

  async detect(projectPath: string): Promise<boolean> {
    const pkgPath = join(projectPath, 'package.json');
    if (!fileExists(pkgPath)) return false;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return 'next' in deps;
    } catch {
      return false;
    }
  }

  async buildCommand(projectPath: string, options: StartOptions): Promise<SpawnCommand> {
    const pm = options.packageManager ?? detectPackageManager(projectPath);
    const args = ['run', 'dev'];

    if (options.customArgs) {
      args.push(...options.customArgs);
    }

    return { executable: pm, args, cwd: projectPath };
  }
}
