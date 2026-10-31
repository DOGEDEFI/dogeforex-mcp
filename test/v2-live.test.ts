import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildTools, type ToolDef } from '../src/tools.js';

const RUN_LIVE = process.env.DOGEOS_LIVE_V2_TESTS === '1';
const here = dirname(fileURLToPath(import.meta.url));
const registryPath = resolve(here, '../../dogeforex-protocol/scripts/deployment/deployments/chikyuV2');
const config = RUN_LIVE
  ? await loadConfig({ DOGEOS_REGISTRY_PATH: registryPath, DOGEOS_RPC_URL: 'https://rpc.testnet.dogeos.com' })
  : null;
const tools: Record<string, ToolDef> = config ? buildTools(config) : {};
const codes = ['AUD', 'BDT', 'BRL', 'CHF', 'CNY', 'EUR', 'GBP', 'INR', 'JPY', 'NGN', 'PKR', 'USD'];

async function call(def: ToolDef, args: unknown): Promise<any> {
  return def.handler(z.object(def.inputSchema).parse(args));
}

function expectReadOnlyRpc(send: ReturnType<typeof vi.spyOn>): void {
  const methods = send.mock.calls.map(([method]) => method);
  expect(methods).not.toContain('eth_sendTransaction');
  expect(methods).not.toContain('eth_sendRawTransaction');
  expect(methods).not.toContain('eth_sign');
  expect(methods).not.toContain('personal_sign');
}

describe.skipIf(!RUN_LIVE)('IMF V2 agent-ready live testnet reads', () => {
  it('verifies all 12 real registries through MCP tools without signers or writes', async () => {
    if (!config || config.protocolGeneration !== 'v2') throw new Error('V2 config required');
    const send = vi.spyOn(config.provider, 'send');
    expect(Object.values(config.signers)).toEqual([null, null, null, null]);
    for (const code of codes) {
      const result = await call(tools.v2_verify!, { code });
      expect(result.formatted.verified).toBe(true);
      expect(result.code).toBe(code);
      expect(result.chainId).toBe(6_281_971);
      expect(result.readOnly).toBe(true);
      expect(result.transactionSimulation).toBe('not_performed');
      expect(result.sourceBlock.number).toBeGreaterThan(0);
    }
    expectReadOnlyRpc(send);
  }, 240_000);

  it('lists current source-block reads for all 12 independent currencies', async () => {
    if (!config || config.protocolGeneration !== 'v2') throw new Error('V2 config required');
    const send = vi.spyOn(config.provider, 'send');
    const result = await call(tools.list_instances!, {});
    expect(result.count).toBe(12);
    expect(result.readOnly).toBe(true);
    expect(result.transactionSimulation).toBe('not_performed');
    expect(result.instances.map((instance: any) => instance.code)).toEqual(codes);
    for (const instance of result.instances) {
      expect(instance.currentReads.token.sourceBlock.number).toBeGreaterThan(0);
      expect(instance.currentReads.sourceBridge.sourceBlock.number).toBeGreaterThan(0);
      expect(instance.currentReads.savings.sourceBlock.number).toBeGreaterThan(0);
      expect(instance.currentReads.equity.sourceBlock.number).toBeGreaterThan(0);
    }
    expectReadOnlyRpc(send);
  }, 240_000);
});
