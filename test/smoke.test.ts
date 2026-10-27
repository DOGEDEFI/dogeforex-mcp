// Opt-in legacy V1 live read-only smoke test against DogeOS Chikyu testnet.
// Default npm test skips this suite without loading config or touching RPC.
// No signer env vars are set, so write tools must fail fast before chain access.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildTools, type ToolDef } from '../src/tools.js';

const RUN_LIVE = process.env.DOGEOS_LIVE_TESTS === '1';
const here = dirname(fileURLToPath(import.meta.url));
const registryPath = resolve(here, '../../dogeforex-protocol/deployments/k9usd.chikyu.json');
const tools: Record<string, ToolDef> = RUN_LIVE
  ? buildTools(await loadConfig({ DOGEOS_REGISTRY_PATH: registryPath }))
  : {};

async function call(def: ToolDef, args: unknown): Promise<any> {
  const parsed = z.object(def.inputSchema).parse(args);
  return def.handler(parsed);
}

describe.skipIf(!RUN_LIVE)('dogeforex-mcp legacy V1 smoke (opt-in live testnet, read-only)', () => {
  it('list_instances returns all 11 instances with live state', async () => {
    const res = await call(tools.list_instances!, {});
    expect(res.count).toBe(11);
    expect(res.instances).toHaveLength(11);
    for (const inst of res.instances) {
      expect(typeof inst.code).toBe('string');
      expect(inst.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(parseFloat(inst.totalSupply)).toBeGreaterThan(0);
      expect(parseFloat(inst.equityPrice)).toBeGreaterThan(0);
      // guardian paused state is REPORTED ONLY — rehearsals may pause it.
      console.log(
        `${inst.code}: symbol=${inst.symbol} supply=${inst.totalSupply} ` +
          `equityPrice=${inst.equityPrice} guardianPaused=${inst.guardianPaused} gate=${inst.admissionGatePaused}`,
      );
    }
  });

  it('instance_state(EUR) returns full snapshot', async () => {
    const res = await call(tools.instance_state!, { code: 'EUR' });
    expect(res.code).toBe('EUR');
    expect(res.symbol).toBe('K9EUR');
    expect(res.token.totalSupply).toBeDefined();
    expect(parseFloat(res.token.totalSupply)).toBeGreaterThan(0);
    expect(parseFloat(res.equity.price)).toBeGreaterThan(0);
    expect(typeof res.bootstrap.executed).toBe('boolean');
    expect(typeof res.guardian.paused).toBe('boolean');
    expect(typeof res.guardian.admissionGatePaused).toBe('boolean');
    // paused value reported, never asserted
    console.log(`EUR guardian: paused=${res.guardian.paused} gate=${res.guardian.admissionGatePaused}`);
  });

  it('fee_quote(EUR, mint) quotes total fee and fee regime', async () => {
    const res = await call(tools.fee_quote!, { code: 'EUR', tool: 'mint' });
    expect(res.tool).toBe('mint');
    expect(parseFloat(res.totalFeeDoge)).toBeGreaterThan(0);
    expect(parseFloat(res.l1FeeDoge)).toBeGreaterThan(0);
    expect(res.ratioVsBaseline).toBeGreaterThan(0);
    expect(typeof res.regimeShift).toBe('boolean');
    expect(res.perByteRateDoge).toBeDefined();
    console.log(
      `fee_quote mint@EUR: total=${res.totalFeeDoge} DOGE (l1=${res.l1FeeDoge} l2=${res.l2FeeDoge}) ` +
        `rate=${res.perByteRateDoge} DOGE/B ratio=${res.ratioVsBaseline} regimeShift=${res.regimeShift}`,
    );
  });

  it('write tool without signer env var fails fast naming the env var', async () => {
    await expect(call(tools.mint!, { code: 'USD', position: '0x0000000000000000000000000000000000000000', amount: '1', dryRun: true })).rejects.toThrow(
      /DOGEFOREX_TREASURY_KEY/,
    );
    await expect(call(tools.guardian_pause!, { code: 'EUR', dryRun: true })).rejects.toThrow(/DOGEFOREX_GUARDIAN_KEY/);
    await expect(call(tools.launch_challenge!, {
      code: 'USD',
      position: '0x0000000000000000000000000000000000000000',
      size: '1',
      bid: '1',
      dryRun: true,
    })).rejects.toThrow(/DOGEFOREX_BOT_KEY/);
  });

  it('rejects unknown currency codes', async () => {
    await expect(call(tools.instance_state!, { code: 'XXX' })).rejects.toThrow(/unknown instance code/);
  });
});
