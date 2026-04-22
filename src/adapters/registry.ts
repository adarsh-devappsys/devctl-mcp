import type { Adapter } from '../types.js';
import { FlutterAdapter } from './flutter.js';
import { SpringBootAdapter } from './spring-boot.js';
import { NextjsAdapter } from './nextjs.js';
import { ViteAdapter } from './vite.js';
import { GenericAdapter } from './generic.js';

// Priority order: most specific first, generic always last
const ADAPTER_CHAIN: Adapter[] = [
  new FlutterAdapter(),
  new SpringBootAdapter(),
  new NextjsAdapter(),
  new ViteAdapter(),
  new GenericAdapter(),
];

export async function detectAdapter(projectPath: string): Promise<Adapter> {
  for (const adapter of ADAPTER_CHAIN) {
    if (await adapter.detect(projectPath)) {
      return adapter;
    }
  }
  // GenericAdapter.detect() always returns true, so this is unreachable
  throw new Error('No adapter found');
}
