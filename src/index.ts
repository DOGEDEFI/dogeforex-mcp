#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  const server = createMcpServer(config);
  await server.connect(new StdioServerTransport());

  // Diagnostics on stderr only — stdout carries the MCP stdio protocol.
  const roles = (Object.keys(config.signers) as Array<keyof typeof config.signers>)
    .filter((r) => config.signers[r] !== null)
    .join(', ');
  console.error(
    `dogeforex-mcp 0.2.0 | stdio | generation=${config.protocolGeneration} | chain=${config.chainId} (${config.network}) | ` +
      `rpc=${config.rpcUrl} | registry=${config.registryPath} | signers configured: ${roles || 'none'}${config.protocolGeneration === 'v2' ? ' | read-only' : ''}`,
  );
  config.provider
    .getNetwork()
    .then((n) => {
      if (n.chainId !== BigInt(config.chainId)) {
        console.error(`WARNING: RPC chainId ${n.chainId} does not match registry chainId ${config.chainId}`);
      }
    })
    .catch((err: unknown) => console.error(`WARNING: could not verify RPC chain id: ${err instanceof Error ? err.message : String(err)}`));
}

main().catch((err: unknown) => {
  console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
