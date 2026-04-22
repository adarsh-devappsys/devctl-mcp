import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ProcessManager } from './process-manager.js';
import { registerProcessTools } from './tools/process-tools.js';
import { registerFlutterTools } from './tools/flutter-tools.js';

const log = (...args: unknown[]) =>
  process.stderr.write('[devctl-mcp] ' + args.join(' ') + '\n');

async function main() {
  log('Starting devctl-mcp server...');

  const processManager = new ProcessManager();

  const server = new McpServer(
    {
      name: 'devctl-mcp',
      version: '1.0.0',
    },
    {
      capabilities: { tools: {} },
    }
  );

  registerProcessTools(server, processManager);
  registerFlutterTools(server, processManager);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('devctl-mcp ready. Listening for MCP messages on stdio.');

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down — stopping all processes...');
    await processManager.stopAll();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[devctl-mcp] Fatal error: ${err}\n`);
  process.exit(1);
});
