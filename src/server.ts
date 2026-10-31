import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpConfig } from './config.js';
import { buildTools, isErrorResult, type ToolErrorResult } from './tools.js';

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Never leak key material: errors are surfaced verbatim only because no
 * code path puts secrets into Error messages; strip anything 0x64-hex-shaped
 * defensively. Exported for offline tests.
 */
export function errMessage(err: unknown): string {
  const raw = err instanceof Error ? (err.stack ? `${err.message}` : String(err)) : String(err);
  return raw.replace(/0x[0-9a-fA-F]{64}/g, '0x[redacted]');
}

export interface ToolOkResult {
  content: [{ type: 'text'; text: string }];
  [key: string]: unknown;
}

export type ToolResponse = ToolOkResult | ToolErrorResult;

/**
 * Map a handler return value to an MCP tool result. An isError-shaped result
 * returned by a handler (a reverted on-chain write, MCP-03) is passed through
 * untouched — it must never be JSON-stringified into a nested "success"
 * payload, which would bury the failure one encoding level deep.
 */
export function toToolResult(result: unknown): ToolResponse {
  if (isErrorResult(result)) return result;
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, jsonReplacer, 2) }] };
}

function instructionsFor(config: McpConfig): string {
  if (config.protocolGeneration === 'legacy') {
    return 'Legacy IMF V1 integration. Keep legacy registry semantics separate from protocol V2. Write-capable legacy tools default to dryRun: true and require separately configured signer roles; never infer confirmation from a quote or dry run.';
  }
  return 'International Money Foundry (IMF) V2 agent integration. Use v2_verify(code) before relying on current reads. Each currency is independent: never sum native units or infer shared reserves across currencies. Preserve protocolGeneration, network, chainId, code, sourceBlock and raw integer strings in answers. Unknown, failed, stale or missing reads are not zero. list_instances, instance_state, position_state and v2_* tools provide current reads and non-executable plans. Quotes, eligibility and planning output are not transaction simulation, authorization or execution. V2 is read-only: never request private keys, sign, broadcast, run keepers or imply human approval. Separately authorized guided wallet writes belong to the IMF app, not this MCP server.';
}

export function createMcpServer(config: McpConfig): McpServer {
  const server = new McpServer(
    { name: 'dogeforex-mcp', version: '0.2.0' },
    { instructions: instructionsFor(config) },
  );
  const tools = buildTools(config);
  for (const [name, def] of Object.entries(tools)) {
    server.registerTool(
      name,
      { description: def.description, inputSchema: def.inputSchema },
      async (args) => {
        try {
          return toToolResult(await def.handler(args));
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Error: ${errMessage(err)}` }], isError: true };
        }
      },
    );
  }
  return server;
}
