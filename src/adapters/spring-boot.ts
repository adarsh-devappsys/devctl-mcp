import { existsSync } from 'fs';
import { join } from 'path';
import type { Adapter, SpawnCommand, StartOptions, FrameworkType } from '../types.js';

function fileExists(p: string): boolean {
  return existsSync(p);
}

export class SpringBootAdapter implements Adapter {
  readonly frameworkType: FrameworkType = 'spring-boot';

  async detect(projectPath: string): Promise<boolean> {
    return (
      fileExists(join(projectPath, 'pom.xml')) ||
      fileExists(join(projectPath, 'build.gradle')) ||
      fileExists(join(projectPath, 'build.gradle.kts'))
    );
  }

  async buildCommand(projectPath: string, options: StartOptions): Promise<SpawnCommand> {
    let buildTool = options.buildTool;

    if (!buildTool) {
      const hasMaven = fileExists(join(projectPath, 'pom.xml'));
      buildTool = hasMaven ? 'maven' : 'gradle';
    }

    let executable: string;
    let args: string[];

    if (buildTool === 'maven') {
      const hasMvnw = fileExists(join(projectPath, 'mvnw'));
      executable = hasMvnw ? './mvnw' : 'mvn';
      args = ['spring-boot:run'];
    } else {
      const hasGradlew = fileExists(join(projectPath, 'gradlew'));
      executable = hasGradlew ? './gradlew' : 'gradle';
      args = ['bootRun'];
    }

    if (options.customArgs) {
      args.push(...options.customArgs);
    }

    return { executable, args, cwd: projectPath };
  }
}
