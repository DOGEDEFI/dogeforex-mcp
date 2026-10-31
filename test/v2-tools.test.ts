import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  formatDecimal,
  parseV2Registry,
  UINT256_MAX,
  V2_TOKEN_ABI,
  V2ChainMismatchError,
  V2MissingCodeError,
  V2ReadError,
} from '@dogeforex/sdk/v2';
import type { V2McpConfig } from '../src/config.js';
import type { ToolDef } from '../src/tools.js';
import { buildV2Tools } from '../src/v2-tools.js';
import { makeV2Artifact } from './v2-fixtures.js';
import { makeProtocolMock } from './v2-mock.js';

type Mock = ReturnType<typeof makeProtocolMock>;

function makeConfig(mock: Mock): V2McpConfig {
  return {
    protocolGeneration: 'v2',
    rpcUrl: 'http://offline.invalid',
    registryPath: 'synthetic-offline',
    registry: parseV2Registry(makeV2Artifact()),
    network: 'synthetic-v2',
    chainId: 6_281_971,
    provider: mock.provider,
    signers: { deployer: null, treasury: null, guardian: null, bot: null },
  };
}

async function call(def: ToolDef, args: unknown): Promise<any> {
  return def.handler(z.object(def.inputSchema).parse(args));
}

function newPositionArgs(mock: Mock): Record<string, unknown> {
  return {
    code: 'USD',
    caller: mock.caller,
    collateralToken: mock.collateralAddress,
    collateralDecimals: 6,
    minCollateral: '3500',
    initialCollateral: '4000',
    mintingMaximum: '100000',
    initPeriodSeconds: '259200',
    durationSeconds: '2592000',
    challengePeriodSeconds: '86400',
    riskPremiumPPM: '5000',
    liquidationPrice: '2',
    reserveContributionPPM: '200000',
    plannedMintAmount: '1000',
  };
}

describe('V2 instance and position reads (synthetic offline RPC)', () => {
  it('lists current state and five minters without guardian/bootstrap calls', async () => {
    const mock = makeProtocolMock();
    const tools = buildV2Tools(makeConfig(mock));
    const list = await call(tools.list_instances!, {});
    expect(list.protocolGeneration).toBe('v2');
    expect(list.network).toBe('synthetic-v2');
    expect(list.count).toBe(1);
    const row = list.instances[0];
    expect(row.currentReads.minterCandidates.formatted).toHaveLength(5);
    expect(row.currentReads.token.formatted.totalSupply).toEqual({
      raw: '10000000000000000000000',
      value: '10000.0',
      decimals: 18,
      unit: 'sUSD',
    });
    expect(row.currentReads.sourceBridge.formatted.sourceLocked).toMatchObject({
      raw: '40000000000', value: '40000.0', decimals: 6, unit: 'sUSDC',
    });
    expect(row.deploymentEvidence.kind).toContain('not current chain state');

    const instance = await call(tools.instance_state!, { code: 'USD' });
    expect(instance.currentReads.minterCandidates.formatted).toHaveLength(5);
    expect(instance.currentReads.savings.formatted.currentRatePPM).toMatchObject({ raw: '20000', value: '2.0', unit: 'percent' });
    expect(instance.currentReads.equity.formatted.sharePrice).toMatchObject({ raw: '300000000000000000', value: '0.3' });
    expect(instance.deploymentEvidence.postconditions.complete).toBe(true);
    expect(JSON.stringify(instance)).not.toMatch(/guardian|bootstrap/i);
    expect(mock.provider.calls.some((entry) => /guardian|bootstrap|admission/i.test(entry.signature))).toBe(false);
  });

  it('uses exact collateral decimals and returns complete eligibility for position_state', async () => {
    const mock = makeProtocolMock();
    const tools = buildV2Tools(makeConfig(mock));
    const result = await call(tools.position_state!, {
      code: 'USD', positionAddress: mock.positionAddress, grossAmount: '1000',
    });
    expect(result.formatted.minimumCollateral).toMatchObject({ raw: '3500000000', value: '3500.0', decimals: 6, unit: 'sCOL' });
    expect(result.formatted.challengedAmount).toMatchObject({ raw: '0', value: '0.0', decimals: 6 });
    expect(result.formatted.collateral.balance).toMatchObject({ raw: '10000000000', value: '10000.0', decimals: 6 });
    expect(result.formatted.liquidationPrice).toMatchObject({ raw: `2${'0'.repeat(30)}`, value: '2.0', decimals: 30 });
    expect(result.formatted.quote.grossAmount).toMatchObject({ raw: `1000${'0'.repeat(18)}`, value: '1000.0' });
    expect(result.eligible).toBeNull();
    expect(result.formatted.checks).toHaveLength(11);
    expect(result.formatted.checks.find((check: any) => check.code === 'CALLER_OWNER_OR_ROLLER').status).toBe('unknown');
    expect(result.formatted.expiredPurchasePrice).toMatchObject({ value: '20.0', decimals: 30 });

    const owner = await call(tools.v2_position_mint!, {
      code: 'USD', position: mock.positionAddress, caller: mock.caller, recipient: mock.caller, usableAmount: '1',
    });
    expect(owner.eligible).toBe(true);
    expect(owner.formatted.quote.grossAmount.value).toBe('1.253217636281151858');
    expect(owner.formatted.quote.usableAmount.value).toBe('1.0');
    expect(mock.provider.calls.some((entry) => entry.signature === 'getMintAmount(uint256)')).toBe(true);
  });

  it('verifies links and reads complete new-proposal terms, funding, and illustrative quotes', async () => {
    const mock = makeProtocolMock();
    const tools = buildV2Tools(makeConfig(mock));
    const verified = await call(tools.v2_verify!, { code: 'USD' });
    expect(verified.formatted.verified).toBe(true);
    expect(verified.formatted.checkedAddresses).toHaveLength(8);
    expect(verified.formatted.savingsRatePPM).toMatchObject({ raw: '20000', value: '2.0' });

    const proposal = await call(tools.v2_new_position!, newPositionArgs(mock));
    expect(proposal.valid).toBe(true);
    expect(proposal.validityScope).toBe('opening terms and funding only; not later mint eligibility');
    expect(proposal.formatted.issues).toEqual([]);
    expect(proposal.formatted.terms.minCollateral).toMatchObject({ raw: '3500000000', value: '3500.0', decimals: 6 });
    expect(proposal.formatted.terms.mintingMaximum).toMatchObject({ value: '100000.0', decimals: 18 });
    expect(proposal.formatted.funding.openingFee).toMatchObject({ value: '1000.0', unit: 'sUSD' });
    expect(proposal.formatted.illustrativeMintQuote.grossAmount).toMatchObject({ value: '1000.0' });
    expect(proposal.formatted.plannedMintReview.eligible).toBe(true);
    expect(proposal.formatted.plannedMintReview.checks).toEqual({
      openingTermsAndFunding: true,
      capacity: true,
      overflowSafe: true,
      backing: true,
      positiveUsableAmount: true,
    });
    expect(proposal.plannedMintReview.eligible).toBe(true);
    expect(proposal.formatted.quoteBasis).toContain('openPosition does not mint immediately');
    expect(proposal.formatted.plannedMintReview.basis).toContain('requires fresh state and requote');
    expect(proposal.transactionSimulation).toBe('not_performed');

    const withoutQuoteArgs = newPositionArgs(mock);
    delete withoutQuoteArgs.plannedMintAmount;
    const withoutQuote = await call(tools.v2_new_position!, withoutQuoteArgs);
    expect(withoutQuote.formatted.plannedMintReview.eligible).toBeNull();
    expect(withoutQuote.formatted.plannedMintReview.checks).toBeNull();
    expect(withoutQuote.formatted.plannedMintReview.unavailableReason).toContain('future-mint eligibility was not inferred');

    await expect(call(tools.v2_new_position!, { ...newPositionArgs(mock), collateralDecimals: 18 }))
      .rejects.toThrow(/supplied collateralDecimals 18 does not match chain value 6/);
    await expect(call(tools.v2_new_position!, { ...newPositionArgs(mock), minCollateral: '0.0000001' }))
      .rejects.toThrow(/more than 6 decimal places/);
  });

  it('reviews planned future mint capacity, backing, and overflow separately from opening validity', async () => {
    const mock = makeProtocolMock();
    const tools = buildV2Tools(makeConfig(mock));
    const large = await call(tools.v2_new_position!, { ...newPositionArgs(mock), plannedMintAmount: '200000' });
    expect(large.valid).toBe(true);
    expect(large.formatted.valid).toBe(true);
    expect(large.formatted.issues).toEqual([]);
    expect(large.validityScope).toBe('opening terms and funding only; not later mint eligibility');
    expect(large.formatted.plannedMintReview.eligible).toBe(false);
    expect(large.formatted.plannedMintReview.checks).toEqual({
      openingTermsAndFunding: true,
      capacity: false,
      overflowSafe: true,
      backing: false,
      positiveUsableAmount: true,
    });
    expect(large.formatted.plannedMintReview.grossAmount).toMatchObject({
      raw: `200000${'0'.repeat(18)}`, value: '200000.0', decimals: 18, unit: 'sUSD',
    });
    expect(large.formatted.plannedMintReview.initialCollateralValue).toMatchObject({
      raw: `8000${'0'.repeat(36)}`, value: '8000.0', decimals: 36,
    });
    expect(large.formatted.plannedMintReview.requiredBackingValue).toMatchObject({
      raw: `200000${'0'.repeat(36)}`, value: '200000.0', decimals: 36,
    });

    const overflow = await call(tools.v2_new_position!, {
      ...newPositionArgs(mock),
      plannedMintAmount: formatDecimal(UINT256_MAX, 18),
    });
    expect(overflow.valid).toBe(true);
    expect(overflow.formatted.plannedMintReview.eligible).toBe(false);
    expect(overflow.formatted.plannedMintReview.checks.overflowSafe).toBe(false);
    expect(overflow.formatted.plannedMintReview.checks.backing).toBe(false);
  });

  it('uses parent collateral decimals, family capacity, and absolute child expiration for clones', async () => {
    const mock = makeProtocolMock();
    const tools = buildV2Tools(makeConfig(mock));
    const expiration = mock.provider.blockTimestamp + 10n * 86_400n;
    const result = await call(tools.v2_clone_position!, {
      code: 'USD',
      parent: mock.positionAddress,
      collateralFunder: mock.caller,
      childOwner: mock.helper,
      initialCollateral: '4000',
      initialMint: '1000',
      expiration: expiration.toString(),
    });
    expect(result.eligible).toBe(true);
    expect(result.formatted.initialCollateral).toMatchObject({ raw: '4000000000', value: '4000.0', decimals: 6 });
    expect(result.formatted.familyCapacity).toMatchObject({ value: '20000.0', unit: 'sUSD' });
    expect(result.formatted.quote.expiration.raw).toBe(expiration.toString());
    expect(result.formatted.quote.expiration.raw).not.toBe(mock.state.expiration.toString());
    expect(mock.provider.calls.some((entry) => entry.signature === 'calculateFee(uint256)')).toBe(true);
  });

  it('separates wallet repayment, debt reduction, withdrawal, and closure', async () => {
    const mock = makeProtocolMock();
    const tools = buildV2Tools(makeConfig(mock));
    const repayment = await call(tools.v2_repayment!, {
      code: 'USD', position: mock.positionAddress, caller: mock.caller, amount: '100',
    });
    expect(repayment.formatted.quote.walletAmount).toMatchObject({ value: '100.0', unit: 'sUSD' });
    expect(repayment.formatted.quote.grossDebtReduction).toMatchObject({ value: '125.0' });
    expect(repayment.formatted.quote.assignedReserve).toMatchObject({ value: '25.0' });
    expect(repayment.formatted.quote.remainingDebt).toMatchObject({ value: '875.0' });
    expect(repayment.formatted.fullCandidate.complete).toBe(true);
    expect(repayment.formatted.simulationRequired).toBe(true);

    const anonymous = await call(tools.v2_repayment!, { code: 'USD', position: mock.positionAddress, amount: '100' });
    expect(anonymous.formatted.quoteFunded).toBeNull();

    const withdrawal = await call(tools.v2_withdrawal!, {
      code: 'USD', position: mock.positionAddress, caller: mock.caller, amount: '100',
    });
    expect(withdrawal.eligible).toBe(true);
    expect(withdrawal.formatted.amount).toMatchObject({ raw: '100000000', value: '100.0', decimals: 6 });
    expect(withdrawal.formatted.balanceAfter).toMatchObject({ value: '9900.0' });
    expect(withdrawal.formatted.wouldClose).toBe(false);

    mock.state.minted = 0n;
    const closure = await call(tools.v2_withdrawal!, {
      code: 'USD', position: mock.positionAddress, caller: mock.caller, amount: '10000',
    });
    expect(closure.formatted.wouldClose).toBe(true);
    expect(closure.eligible).toBe(true);
  });

  it('keeps first-phase challenge activity distinct from unknown settlement', async () => {
    const mock = makeProtocolMock();
    const tools = buildV2Tools(makeConfig(mock));
    const empty = await call(tools.v2_challenge!, { code: 'USD', challengeIndex: '0' });
    expect(empty.formatted.empty).toBe(true);
    expect(empty.formatted.firstPhaseActive).toBe(false);
    expect(empty.formatted.settlementComplete).toBeNull();
    expect(empty.formatted.size).toBeNull();

    mock.state.challengeActive = true;
    const active = await call(tools.v2_challenge!, { code: 'USD', challengeIndex: '0' });
    expect(active.formatted.firstPhaseActive).toBe(true);
    expect(active.formatted.settlementComplete).toBeNull();
    expect(active.formatted.size).toMatchObject({ raw: '100000000', value: '100.0', decimals: 6 });
    expect(active.formatted.currentPrice).toMatchObject({ value: '2.0', decimals: 30 });

    mock.provider.setBlock(mock.state.challengeStart + mock.state.challengePeriod + 1n);
    const expiredPhase = await call(tools.v2_challenge!, { code: 'USD', challengeIndex: '0' });
    expect(expiredPhase.formatted.firstPhaseActive).toBe(false);
    expect(expiredPhase.formatted.settlementComplete).toBeNull();
    await expect(call(tools.list_challenges!, { code: 'USD' })).rejects.toThrow(/use v2_challenge/);
  });
});

describe('V2 module reads (synthetic offline RPC)', () => {
  it('formats source bridge mints, burns, credits, and local remainders exactly', async () => {
    const mock = makeProtocolMock();
    const tools = buildV2Tools(makeConfig(mock));
    const mint = await call(tools.v2_bridge!, { code: 'USD', account: mock.caller, mintSourceAmount: '1' });
    expect(mint.formatted.mintPlan.sourceAmount).toMatchObject({ raw: '1000000', value: '1.0', decimals: 6, unit: 'sUSDC' });
    expect(mint.formatted.mintPlan.localAmount).toMatchObject({ raw: `1${'0'.repeat(18)}`, value: '1.0', decimals: 18 });
    expect(mint.formatted.mintPlan.eligible).toBe(true);

    const burn = await call(tools.v2_bridge!, {
      code: 'USD', account: mock.caller, burnLocalAmount: '1.000000000000000999', credit: true,
    });
    expect(burn.formatted.burnPlan.sourceAmount).toMatchObject({ raw: '1000000', value: '1.0' });
    expect(burn.formatted.burnPlan.remainderLocalAmount).toMatchObject({ raw: '999', value: '0.000000000000000999' });
    expect(burn.formatted.burnPlan.resultingCredit).toMatchObject({ raw: '41000000', value: '41.0', decimals: 6 });
    expect(burn.formatted.burnPlan.eligible).toBe(true);
    await expect(call(tools.v2_bridge!, { code: 'USD', mintSourceAmount: '1', burnLocalAmount: '1' }))
      .rejects.toThrow(/mutually exclusive/);
  });

  it('reads savings, equity quotes, and account clocks without confusing units', async () => {
    const mock = makeProtocolMock();
    const tools = buildV2Tools(makeConfig(mock));
    const savings = await call(tools.v2_savings!, { code: 'USD', account: mock.caller });
    expect(savings.formatted.currentRatePPM).toMatchObject({ raw: '20000', value: '2.0', unit: 'percent' });
    expect(savings.formatted.account.saved).toMatchObject({ value: '500.0', unit: 'sUSD' });
    expect(savings.formatted.account.accruedInterest).toMatchObject({ value: '7.0' });
    expect(savings.formatted.account.locked).toBe(false);

    const equity = await call(tools.v2_equity!, {
      code: 'USD', account: mock.caller, investment: '10', redemptionShares: '2',
    });
    expect(equity.formatted.sharePrice).toMatchObject({ value: '0.3', unit: 'sUSD per sUSDPS' });
    expect(equity.formatted.quotedShares).toMatchObject({ value: '100.0', unit: 'sUSDPS' });
    expect(equity.formatted.quotedProceeds).toMatchObject({ value: '4.0', unit: 'sUSD' });
    expect(equity.formatted.account.canRedeem).toBe(true);
  });

  it('requires governance caller context and preserves the strict vote boundary and zero-vote behavior', async () => {
    const mock = makeProtocolMock();
    const tools = buildV2Tools(makeConfig(mock));
    const zero = await call(tools.v2_governance!, { code: 'USD', caller: mock.caller });
    expect(zero.qualified).toBe(false);
    expect(zero.formatted.relativeVotes).toBeNull();
    expect(mock.provider.calls.some((entry) => entry.signature === 'relativeVotes(address)')).toBe(false);

    mock.state.totalVotes = 1_000n;
    mock.state.ownVotes = 20n;
    expect((await call(tools.v2_governance!, { code: 'USD', caller: mock.caller })).qualified).toBe(false);
    mock.state.ownVotes = 21n;
    expect((await call(tools.v2_governance!, { code: 'USD', caller: mock.caller })).qualified).toBe(true);
    mock.state.ownVotes = 10n;
    mock.state.helperVotes = 11n;
    expect((await call(tools.v2_governance!, { code: 'USD', caller: mock.caller, helpers: [mock.helper] })).qualified).toBe(true);
  });
});

describe('V2 errors and read-only write barriers (synthetic offline RPC)', () => {
  it('surfaces wrong-chain, missing-code, failed-read, and invalid-quote states', async () => {
    const wrong = makeProtocolMock(2);
    await expect(call(buildV2Tools(makeConfig(wrong)).v2_savings!, { code: 'USD' })).rejects.toBeInstanceOf(V2ChainMismatchError);

    const missing = makeProtocolMock();
    missing.provider.setCode(missing.instance.bridge, '0x');
    await expect(call(buildV2Tools(makeConfig(missing)).v2_verify!, { code: 'USD' })).rejects.toBeInstanceOf(V2MissingCodeError);

    const failed = makeProtocolMock();
    failed.provider.onCall(failed.instance.token, V2_TOKEN_ABI, 'totalSupply()', () => {
      throw new Error('synthetic offline RPC failure');
    });
    await expect(call(buildV2Tools(makeConfig(failed)).list_instances!, {})).rejects.toBeInstanceOf(V2ReadError);

    const invalid = makeProtocolMock();
    await expect(call(buildV2Tools(makeConfig(invalid)).position_state!, {
      code: 'USD', positionAddress: invalid.positionAddress, grossAmount: '1', usableAmount: '1',
    })).rejects.toThrow(/mutually exclusive/);
  });

  it('disables every V2 write and fee quote before signer lookup, fee sampling, staticCall, or send', async () => {
    const mock = makeProtocolMock();
    const config = makeConfig(mock);
    const tools = buildV2Tools(config);
    const send = vi.spyOn(mock.provider, 'send');
    const cases: Array<[string, Record<string, unknown>]> = [
      ['mint', { code: 'USD', position: mock.positionAddress, amount: '1' }],
      ['launch_challenge', { code: 'USD', position: mock.positionAddress, size: '1', bid: '1' }],
      ['place_bid', { code: 'USD', challengeNumber: '0', size: '1', postpone: false }],
      ['open_position', {
        code: 'USD', collateralToken: mock.collateralAddress, minAmount: '1000', minCollateral: '3500',
        initialCollateral: '4000', liqPrice: '2', durationSeconds: '2592000',
      }],
      ['guardian_pause', { code: 'USD' }],
      ['guardian_schedule_unpause', { code: 'USD' }],
      ['guardian_unpause', { code: 'USD' }],
    ];
    for (const [name, args] of cases) {
      for (const dryRun of [true, false]) {
        await expect(call(tools[name]!, { ...args, dryRun })).rejects.toThrow(/disabled in V2 read-only integration/);
      }
    }
    for (const name of ['guardian_pause', 'guardian_schedule_unpause', 'guardian_unpause']) {
      await expect(call(tools[name]!, { code: 'USD', dryRun: true })).rejects.toThrow(/legacy V1 only/);
    }
    await expect(call(tools.fee_quote!, { code: 'USD', tool: 'mint' })).rejects.toThrow(/disabled in V2 read-only integration/);
    expect(send).not.toHaveBeenCalled();
    expect(mock.provider.calls).toHaveLength(0);
  });
});
