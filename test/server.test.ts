import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseV2Registry } from '@dogeforex/sdk/v2';
import { describe, expect, it } from 'vitest';
import type { V2McpConfig } from '../src/config.js';
import { createMcpServer } from '../src/server.js';
import { makeV2Artifact } from './v2-fixtures.js';
import { makeProtocolMock } from './v2-mock.js';

const EXPECTED_V2_TOOLS = [
  'instance_state',
  'list_instances',
  'position_state',
  'v2_bridge',
  'v2_challenge',
  'v2_clone_position',
  'v2_equity',
  'v2_governance',
  'v2_new_position',
  'v2_position_mint',
  'v2_repayment',
  'v2_savings',
  'v2_verify',
  'v2_withdrawal',
];

describe('MCP agent discovery', () => {
  it('advertises V2 instructions and exactly the 14 read/plan tools', async () => {
    const mock = makeProtocolMock();
    const config: V2McpConfig = {
      protocolGeneration: 'v2',
      rpcUrl: 'http://offline.invalid',
      registryPath: 'synthetic-offline',
      registry: parseV2Registry(makeV2Artifact()),
      network: 'synthetic-v2',
      chainId: 6_281_971,
      provider: mock.provider,
      signers: { deployer: null, treasury: null, guardian: null, bot: null },
    };
    const server = createMcpServer(config);
    const client = new Client({ name: 'imf-agent-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(client.getInstructions()).toContain('International Money Foundry');
      expect(client.getInstructions()).toContain('v2_verify');
      expect(client.getInstructions()).toContain('sourceBlock');
      expect(client.getInstructions()).toContain('read-only');
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_V2_TOOLS);
      expect(tools.some((tool) => /\b(?:sign|signing|broadcast|private keys?)\b/i.test(tool.description ?? ''))).toBe(false);
      expect(mock.provider.calls).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
