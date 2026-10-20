import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpConfig } from './config.js';
import { buildTools } from './tools.js';

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function errMessage(err: unknown): string {
  // Never leak key material: errors are surfaced verbatim only because no
  // code path puts secrets into Error messages; strip anything 0x64-hex-shaped
  // defensively.
  const raw = err instanceof Error ? (err.stack ? `${err.message}` : String(err)) : String(err);
  return raw.replace(/0x[0-9a-fA-F]{64}/g, '0x[redacted]');
}

export function createMcpServer(config: McpConfig): McpServer {
  const server = new McpServer({ name: 'dogeforex-mcp', version: '0.1.0' });
  const tools = buildTools(config);
  for (const [name, def] of Object.entries(tools)) {
    server.registerTool(
      name,
      { description: def.description, inputSchema: def.inputSchema },
      async (args) => {
        try {
          const result = await def.handler(args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, jsonReplacer, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Error: ${errMessage(err)}` }], isError: true };
        }
      },
    );
  }
  return server;
}
