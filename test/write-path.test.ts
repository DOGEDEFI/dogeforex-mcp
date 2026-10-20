// Offline write-path tests (MCP-09a + MCP-09c) — no network anywhere. The
// SDK client and the chain sampler are mocked at the module boundary; the
// registry is the real deployment JSON (file read only). Covers MCP-03:
// a reverted on-chain write (mined receipt with status 0) must surface as an
// isError result shaped like the server's normal error responses, never as a
// success-shaped payload with "status": 0 buried in it — and the server
// wrapper must pass that result through without re-wrapping it.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MINT_REVERT_HASH = `0x${'ab'.repeat(32)}`;
const GUARDIAN_REVERT_HASH = `0x${'ef'.repeat(32)}`;
const OK_HASH = `0x${'cd'.repeat(32)}`;
const KEY_SHAPED = `0x${'11'.repeat(32)}`; // well-formed fake key, never a real one

// Mutable state shared with the module mocks (vi.mock factories are hoisted,
// so this must be created via vi.hoisted).
const h = vi.hoisted(() => ({
  receipts: {
    mint: { hash: '', status: 0, blockNumber: 12_345, logs: [] as unknown[] },
    guardianPause: { hash: '', status: 0, blockNumber: 12_346, logs: [] as unknown[] },
  },
  // Healthy fee model: both guards sit at ~1x baseline.
  model: {
    fixedDoge: 0.04,
    perByteDoge: 7.1e-5,
    sampleCount: 10,
    medianTotalDoge: 0.0791,
    baselineTotalDoge: 0.0791,
  },
  minedFees: {
    l2Fee: 2_000_000_000_000n,
    l1Fee: 40_000_000_000_000_000n,
    total: 42_000_000_000_000_000n,
  },
}));
h.receipts.mint.hash = MINT_REVERT_HASH;
h.receipts.guardianPause.hash = GUARDIAN_REVERT_HASH;

vi.mock('@dogeforex/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dogeforex/sdk')>();
  return {
    ...actual,
    // The mocked send path: SDK sends and waits internally, then returns the
    // mined receipt — here one whose wait() resolved to status 0 (reverted).
    createClient: () => ({
      position: () => ({}),
      positionState: async () => ({ minted: 1_000_000_000_000_000_000n, availableForMinting: 500_000_000_000_000_000n }),
      positionDerived: async () => ({ mintingFeePPM: 0n }),
      guardianState: async () => ({
        guardian: '0x00000000000000000000000000000000000000aa',
        paused: false,
        timelockSeconds: 259200n,
        unpauseAvailableAt: null,
        admissionGatePaused: false,
      }),
      mint: async () => h.receipts.mint,
      guardianPause: async () => h.receipts.guardianPause,
    }),
    attachPosition: () => ({
      mint: {
        staticCall: async () => undefined,
        populateTransaction: async () => ({ data: `0x${'12'.repeat(200)}` }),
      },
    }),
    attachGuardianTimelock: () => ({
      pause: {
        staticCall: async () => undefined,
        populateTransaction: async () => ({ data: '0x0123' }),
      },
    }),
    totalTxFee: async () => h.minedFees,
  };
});

vi.mock('../src/fee-regime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fee-regime.js')>();
  return {
    ...actual,
    sampleFeeModel: async () => ({ ...h.model }),
    assertFeeRegime: () => undefined,
  };
});

const { loadConfig } = await import('../src/config.js');
const { buildTools, executeWriteTx, isErrorResult } = await import('../src/tools.js');
const { createMcpServer, errMessage, toToolResult } = await import('../src/server.js');
type ToolErrorResult = import('../src/tools.js').ToolErrorResult;

const here = dirname(fileURLToPath(import.meta.url));
const registryPath = resolve(here, '../../dogeforex-protocol/deployments/k9usd.chikyu.json');

// Explicit env: fake role keys (validated, never committed), real registry
// file (sibling repo), RPC URL pointing nowhere — the provider is swapped for
// a stub below so nothing ever touches the network.
const config = loadConfig({
  DOGEOS_RPC_URL: 'http://127.0.0.1:9',
  DOGEOS_REGISTRY_PATH: registryPath,
  DOGEFOREX_TREASURY_KEY: KEY_SHAPED,
  DOGEFOREX_GUARDIAN_KEY: KEY_SHAPED,
  DOGEFOREX_BOT_KEY: KEY_SHAPED,
});
config.provider = {
  getFeeData: async () => ({ gasPrice: 1_000_000_000n, maxFeePerGas: null, maxPriorityFeePerGas: null }),
} as unknown as typeof config.provider;

const tools = buildTools(config);

const MINT_ARGS = { code: 'USD', position: '0x0000000000000000000000000000000000000000', amount: '1', dryRun: false };

function errorText(result: unknown): string {
  return (result as ToolErrorResult).content[0].text;
}

describe('write path: reverted on-chain writes (MCP-03, offline)', () => {
  beforeEach(() => {
    h.receipts.mint.status = 0;
    h.receipts.guardianPause.status = 0;
  });

  it('executeWriteTx maps a status-0 receipt to an isError result naming tool, status, and hash', async () => {
    const result = await executeWriteTx('place_bid', () => Promise.resolve({ hash: MINT_REVERT_HASH, status: 0 }));
    expect(isErrorResult(result)).toBe(true);
    expect(errorText(result)).toBe(
      `place_bid: transaction REVERTED on-chain (status 0, txHash ${MINT_REVERT_HASH}) — do not treat as executed`,
    );
  });

  it('executeWriteTx returns the receipt untouched when the tx succeeds', async () => {
    const receipt = { hash: OK_HASH, status: 1 };
    const result = await executeWriteTx('mint', () => Promise.resolve(receipt));
    expect(result).toBe(receipt);
  });

  it('mint handler: a reverted write is returned as an isError result, not { txSent: true, status: 0 }', async () => {
    const result = await tools.mint!.handler({ ...MINT_ARGS });
    expect(isErrorResult(result)).toBe(true);
    const text = errorText(result);
    expect(text).toContain('mint: transaction REVERTED on-chain');
    expect(text).toContain('status 0');
    expect(text).toContain(MINT_REVERT_HASH);
    // No success-shaped shell around the error:
    expect(JSON.stringify(result)).not.toContain('txSent');
    expect(JSON.stringify(result)).not.toContain('"status": 0');
  });

  it('guardian handler: reverted guardian write is an isError result naming the tool', async () => {
    const result = await tools.guardian_pause!.handler({ code: 'EUR', dryRun: false });
    expect(isErrorResult(result)).toBe(true);
    const text = errorText(result);
    expect(text).toContain('guardian_pause: transaction REVERTED on-chain');
    expect(text).toContain(GUARDIAN_REVERT_HASH);
  });

  it('mint handler: a mined success keeps the normal success shape', async () => {
    h.receipts.mint.status = 1;
    h.receipts.mint.hash = OK_HASH;
    const result = (await tools.mint!.handler({ ...MINT_ARGS })) as Record<string, unknown>;
    expect(isErrorResult(result)).toBe(false);
    expect(result.txSent).toBe(true);
    expect(result.status).toBe(1);
    expect(result.txHash).toBe(OK_HASH);
    expect(result.dryRun).toBe(false);
    expect((result.fee as Record<string, string>).totalFeeDoge).toBeDefined();
  });

  it('server wrapper passes an isError handler result through without double-wrapping', async () => {
    const server = createMcpServer(config);
    const registered = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })
      ._registeredTools.mint!;
    const result = (await registered.handler({ ...MINT_ARGS })) as ToolErrorResult;
    expect(result.isError).toBe(true);
    // The text must be the plain revert message, not a JSON-encoded wrapper.
    expect(result.content[0].text).toContain('mint: transaction REVERTED on-chain');
    expect(result.content[0].text).not.toContain('"{\\"isError\\"');
    expect(result.content[0].text.trim().startsWith('{')).toBe(false);
  });

  it('server wrapper stringifies a normal success result bigint-safely', async () => {
    const server = createMcpServer(config);
    h.receipts.mint.status = 1;
    h.receipts.mint.hash = OK_HASH;
    const registered = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })
      ._registeredTools.mint!;
    const result = (await registered.handler({ ...MINT_ARGS })) as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(parsed.txSent).toBe(true);
  });
});

describe('result wrapping and key-material scrubber (MCP-09c, offline)', () => {
  it('toToolResult passes an isError-shaped result through untouched', () => {
    const errorResult: ToolErrorResult = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    expect(toToolResult(errorResult)).toBe(errorResult);
  });

  it('toToolResult JSON-stringifies normal results with the bigint-safe replacer', () => {
    const ok = toToolResult({ count: 1n, nested: { fee: 42n } });
    expect(JSON.parse(ok.content[0].text)).toEqual({ count: '1', nested: { fee: '42' } });
  });

  it('errMessage redacts key-shaped strings from error text', () => {
    const scrubbed = errMessage(new Error(`signing failed for key ${KEY_SHAPED} — retry`));
    expect(scrubbed).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(scrubbed).toContain('0x[redacted]');
    expect(scrubbed).toContain('signing failed for key');
  });

  it('errMessage leaves ordinary error text intact', () => {
    expect(errMessage(new Error('fee regime shift: retry later'))).toBe('fee regime shift: retry later');
    expect(errMessage('plain failure')).toBe('plain failure');
  });
});
