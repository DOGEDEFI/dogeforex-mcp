import { getAddress } from 'ethers';
import { z } from 'zod';
import {
  createV2Client,
  formatDecimal,
  formatLiquidationPrice,
  formatPPM,
  parseDecimal,
  parseLiquidationPrice,
  parsePPM,
  priceDecimals,
  UINT256_MAX,
  v2InstanceOf,
  type V2BridgeSnapshot,
  type V2ChallengeSnapshot,
  type V2CloneSnapshot,
  type V2EquitySnapshot,
  type V2GovernanceSnapshot,
  type V2MinterSnapshot,
  type V2NewPositionSnapshot,
  type V2PositionMintQuote,
  type V2PositionSnapshot,
  type V2PositionState,
  type V2QuoteRequest,
  type V2RepaymentQuote,
  type V2RepaymentSnapshot,
  type V2SavingsSnapshot,
  type V2SourceBlock,
  type V2TokenSnapshot,
  type V2Verification,
  type V2WithdrawalSnapshot,
} from '@dogeforex/sdk/v2';
import { requireV2Code, type V2McpConfig } from './config.js';
import type { ToolDef } from './tools.js';

interface AmountView {
  raw: string;
  value: string;
  decimals: number;
  unit: string;
}

const sCode = z.string().min(3).max(4).describe('V2 currency code available in the supplied registry');
const sAddress = z.string().refine((value) => {
  try {
    getAddress(value);
    return true;
  } catch {
    return false;
  }
}, 'must be a valid EVM address');
const sAmount = z.string().min(1).describe('unsigned human decimal amount; scientific notation and signs are rejected');
const sWhole = z.string().regex(/^\d+$/, 'unsigned integer decimal string');
const sDryRun = z.boolean().default(true);

function amount(raw: bigint, decimals: number, unit: string): AmountView {
  return { raw: raw.toString(), value: formatDecimal(raw, decimals), decimals, unit };
}

function signedAmount(raw: bigint, decimals: number, unit: string): AmountView {
  return {
    raw: raw.toString(),
    value: raw < 0n ? `-${formatDecimal(-raw, decimals)}` : formatDecimal(raw, decimals),
    decimals,
    unit,
  };
}

function maybeAmount(raw: bigint | null, decimals: number, unit: string): AmountView | null {
  return raw === null ? null : amount(raw, decimals, unit);
}

function priceAmount(raw: bigint, collateralDecimals: number, unit: string): AmountView {
  return {
    raw: raw.toString(),
    value: formatLiquidationPrice(raw, collateralDecimals),
    decimals: priceDecimals(collateralDecimals),
    unit,
  };
}

function ppm(raw: bigint | null): { raw: string; value: string; decimals: 4; unit: 'percent' } | null {
  return raw === null ? null : { raw: raw.toString(), value: formatPPM(raw), decimals: 4, unit: 'percent' };
}

function seconds(raw: bigint | null): { raw: string; unit: 'seconds' } | null {
  return raw === null ? null : { raw: raw.toString(), unit: 'seconds' };
}

function timestamp(raw: bigint): { raw: string; iso: string; unit: 'Unix seconds' } {
  return { raw: raw.toString(), iso: new Date(Number(raw) * 1000).toISOString(), unit: 'Unix seconds' };
}

function sourceBlock(block: V2SourceBlock): Record<string, unknown> {
  return { number: block.number, hash: block.hash, timestamp: timestamp(block.timestamp) };
}

function rawValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(rawValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rawValue(entry)]));
  }
  return value;
}

function view(snapshot: { sourceBlock: V2SourceBlock }, formatted: unknown): Record<string, unknown> {
  return {
    sourceBlock: sourceBlock(snapshot.sourceBlock),
    snapshot: rawValue(snapshot),
    formatted,
  };
}

function envelope(
  config: V2McpConfig,
  code: string,
  snapshot: { sourceBlock: V2SourceBlock },
  formatted: unknown,
): Record<string, unknown> {
  return {
    protocolGeneration: 'v2' as const,
    network: config.network,
    chainId: config.chainId,
    code,
    readOnly: true,
    transactionSimulation: 'not_performed',
    ...view(snapshot, formatted),
  };
}

function clientFor(config: V2McpConfig, rawCode: string) {
  const code = requireV2Code(config.registry, rawCode);
  const instance = v2InstanceOf(config.registry, code);
  return { code, instance, client: createV2Client(instance, config.provider) };
}

function formatToken(snapshot: V2TokenSnapshot): Record<string, unknown> {
  const decimals = snapshot.decimals;
  const unit = snapshot.symbol;
  return {
    totalSupply: amount(snapshot.totalSupply, decimals, unit),
    minterReserve: amount(snapshot.minterReserve, decimals, unit),
    equityAmount: amount(snapshot.equityAmount, decimals, unit),
    account: snapshot.account === null ? null : {
      balance: amount(snapshot.account.balance, decimals, unit),
      allowance: snapshot.account.allowance === null ? null : amount(snapshot.account.allowance.amount, decimals, unit),
    },
  };
}

function formatMinters(snapshot: V2MinterSnapshot): unknown {
  return snapshot.minters.map((minter) => ({
    label: minter.label,
    address: minter.address,
    validityStart: timestamp(minter.validityStart),
    active: minter.active,
  }));
}

function formatBridge(snapshot: V2BridgeSnapshot, localSymbol: string): Record<string, unknown> {
  const sourceDecimals = snapshot.sourceDecimals;
  const sourceUnit = snapshot.sourceSymbol;
  const local = (raw: bigint) => amount(raw, 18, localSymbol);
  const maybeLocal = (raw: bigint | null) => maybeAmount(raw, 18, localSymbol);
  const source = (raw: bigint) => amount(raw, sourceDecimals, sourceUnit);
  const maybeSource = (raw: bigint | null) => maybeAmount(raw, sourceDecimals, sourceUnit);
  return {
    sourceLocked: source(snapshot.sourceLocked),
    limitLocal: local(snapshot.limitLocal),
    mintedLocal: local(snapshot.mintedLocal),
    capacityLocal: local(snapshot.capacityLocal),
    creditBalance: maybeSource(snapshot.creditBalance),
    horizon: timestamp(snapshot.horizon),
    acceptsDeposits: snapshot.acceptsDeposits,
    mintPlan: snapshot.mintPlan === null ? null : {
      sourceAmount: source(snapshot.mintPlan.sourceAmount),
      localAmount: local(snapshot.mintPlan.localAmount),
      capacityLocal: local(snapshot.mintPlan.capacityLocal),
      sourceBalance: maybeSource(snapshot.mintPlan.sourceBalance),
      sourceAllowance: maybeSource(snapshot.mintPlan.sourceAllowance),
      withinCapacity: snapshot.mintPlan.withinCapacity,
      acceptsDeposits: snapshot.mintPlan.acceptsDeposits,
      funded: snapshot.mintPlan.funded,
      approved: snapshot.mintPlan.approved,
      eligible: snapshot.mintPlan.eligible,
    },
    burnPlan: snapshot.burnPlan === null ? null : {
      requestedLocalAmount: local(snapshot.burnPlan.requestedLocalAmount),
      alignedLocalAmount: local(snapshot.burnPlan.alignedLocalAmount),
      remainderLocalAmount: local(snapshot.burnPlan.remainderLocalAmount),
      sourceAmount: source(snapshot.burnPlan.sourceAmount),
      resultingCredit: maybeSource(snapshot.burnPlan.resultingCredit),
      localBalance: maybeLocal(snapshot.burnPlan.localBalance),
      credit: snapshot.burnPlan.credit,
      creditWithinRange: snapshot.burnPlan.creditWithinRange,
      funded: snapshot.burnPlan.funded,
      withinOutstanding: snapshot.burnPlan.withinOutstanding,
      backedBySource: snapshot.burnPlan.backedBySource,
      eligible: snapshot.burnPlan.eligible,
    },
  };
}

function formatSavings(snapshot: V2SavingsSnapshot, localSymbol: string): Record<string, unknown> {
  const local = (raw: bigint) => amount(raw, 18, localSymbol);
  return {
    currentRatePPM: ppm(snapshot.currentRatePPM),
    nextRatePPM: ppm(snapshot.nextRatePPM),
    equityAmount: local(snapshot.equityAmount),
    nextChange: timestamp(snapshot.nextChange),
    interestDelay: seconds(snapshot.interestDelay),
    rateChangePending: snapshot.rateChangePending,
    rateChangeReady: snapshot.rateChangeReady,
    acceptsDeposits: snapshot.acceptsDeposits,
    account: snapshot.account === null ? null : {
      saved: local(snapshot.account.saved),
      accruedInterest: local(snapshot.account.accruedInterest),
      locked: snapshot.account.locked,
      remainingLockSeconds: seconds(snapshot.account.remainingLockSeconds),
    },
  };
}

function formatEquity(snapshot: V2EquitySnapshot, localSymbol: string): Record<string, unknown> {
  const shares = (raw: bigint) => amount(raw, snapshot.decimals, snapshot.symbol);
  const local = (raw: bigint) => amount(raw, 18, localSymbol);
  const maybeLocal = (raw: bigint | null) => maybeAmount(raw, 18, localSymbol);
  return {
    totalShares: shares(snapshot.totalShares),
    sharePrice: amount(snapshot.sharePrice, 18, `${localSymbol} per ${snapshot.symbol}`),
    equityAmount: local(snapshot.equityAmount),
    minimumHoldingDuration: seconds(snapshot.minimumHoldingDuration),
    investment: maybeLocal(snapshot.investment),
    quotedShares: maybeAmount(snapshot.quotedShares, snapshot.decimals, snapshot.symbol),
    redemptionShares: maybeAmount(snapshot.redemptionShares, snapshot.decimals, snapshot.symbol),
    quotedProceeds: maybeLocal(snapshot.quotedProceeds),
    account: snapshot.account === null ? null : {
      shares: shares(snapshot.account.shares),
      votes: amount(snapshot.account.votes, 18, 'time-weighted votes'),
      holdingDurationSeconds: seconds(snapshot.account.holdingDurationSeconds),
      canRedeem: snapshot.account.canRedeem,
      delegate: snapshot.account.delegate,
    },
  };
}

function formatMintQuote(quote: V2PositionMintQuote, localSymbol: string): Record<string, unknown> {
  return {
    grossAmount: maybeAmount(quote.grossAmount, 18, localSymbol),
    usableAmount: maybeAmount(quote.usableAmount, 18, localSymbol),
    feePPM: ppm(quote.feePPM),
    reservePPM: ppm(quote.reservePPM),
    expiration: timestamp(quote.expiration),
    expired: quote.expired,
  };
}

function formatPosition(snapshot: V2PositionState, localSymbol: string): Record<string, unknown> {
  const collateralDecimals = snapshot.collateral.decimals;
  const collateralUnit = snapshot.collateral.symbol;
  const collateral = (raw: bigint) => amount(raw, collateralDecimals, collateralUnit);
  const local = (raw: bigint) => amount(raw, 18, localSymbol);
  const priceUnit = `${localSymbol} per ${collateralUnit}`;
  return {
    collateral: {
      address: snapshot.collateral.address,
      symbol: collateralUnit,
      decimals: collateralDecimals,
      balance: collateral(snapshot.collateral.balance),
    },
    liquidationPrice: priceAmount(snapshot.price, collateralDecimals, priceUnit),
    limit: local(snapshot.limit),
    minted: local(snapshot.minted),
    minimumCollateral: collateral(snapshot.minimumCollateral),
    challengedAmount: collateral(snapshot.challengedAmount),
    challengeData: {
      liquidationPrice: priceAmount(snapshot.challengeData.liquidationPrice, collateralDecimals, priceUnit),
      period: seconds(snapshot.challengeData.period),
    },
    challengePeriod: seconds(snapshot.challengePeriod),
    start: timestamp(snapshot.start),
    cooldown: timestamp(snapshot.cooldown),
    expiration: timestamp(snapshot.expiration),
    availableForMinting: local(snapshot.availableForMinting),
    availableForClones: local(snapshot.availableForClones),
    expiredPurchasePrice: priceAmount(snapshot.expiredPurchasePrice, collateralDecimals, priceUnit),
    reserveContributionPPM: ppm(snapshot.reserveContributionPPM),
    riskPremiumPPM: ppm(snapshot.riskPremiumPPM),
    annualInterestPPM: ppm(snapshot.annualInterestPPM),
    currentFeePPM: ppm(snapshot.currentFeePPM),
    closed: snapshot.closed,
    expired: snapshot.expired,
    registeredWithHub: snapshot.registeredWithHub,
    hubMatchesRegistry: snapshot.hubMatchesRegistry,
    tokenMatchesRegistry: snapshot.tokenMatchesRegistry,
  };
}

function formatPositionSnapshot(snapshot: V2PositionSnapshot, localSymbol: string): Record<string, unknown> {
  return {
    ...formatPosition(snapshot, localSymbol),
    quote: formatMintQuote(snapshot.quote, localSymbol),
    checks: snapshot.checks,
    eligible: snapshot.eligible,
    eligibilityBasis: 'read-derived checks only; not transaction simulation',
  };
}

function formatPlannedMintReview(snapshot: V2NewPositionSnapshot, localSymbol: string): Record<string, unknown> {
  const basis =
    'read-derived review of a possible later mint after opening; openPosition does not mint immediately; requires fresh state and requote; not simulation or authorization';
  const quote = snapshot.illustrativeMintQuote;
  if (quote === null) {
    return {
      eligible: null,
      unavailableReason: 'plannedMintAmount was not provided or an exact illustrative quote is unavailable; future-mint eligibility was not inferred',
      basis,
      grossAmount: null,
      usableAmount: null,
      checks: null,
    };
  }

  const initialCollateralValue = snapshot.terms.initialCollateral * snapshot.terms.liquidationPrice;
  const requiredBackingValue = quote.grossAmount * 10n ** 18n;
  const overflowSafe = initialCollateralValue <= UINT256_MAX && requiredBackingValue <= UINT256_MAX;
  const capacity = quote.grossAmount <= snapshot.terms.mintingMaximum;
  const backing = overflowSafe && initialCollateralValue >= requiredBackingValue;
  const positiveUsableAmount = quote.usableAmount > 0n;
  const product = (raw: bigint): AmountView => {
    const digits = raw.toString().padStart(37, '0');
    const whole = digits.slice(0, -36);
    const fraction = digits.slice(-36).replace(/0+$/, '');
    return {
      raw: raw.toString(),
      value: `${whole}.${fraction || '0'}`,
      decimals: 36,
      unit: `${localSymbol} backing value`,
    };
  };
  const checks = {
    openingTermsAndFunding: snapshot.valid,
    capacity,
    overflowSafe,
    backing,
    positiveUsableAmount,
  };
  return {
    eligible: snapshot.valid && capacity && overflowSafe && backing && positiveUsableAmount,
    unavailableReason: null,
    basis,
    grossAmount: amount(quote.grossAmount, 18, localSymbol),
    usableAmount: amount(quote.usableAmount, 18, localSymbol),
    mintingMaximum: amount(snapshot.terms.mintingMaximum, 18, localSymbol),
    initialCollateralValue: product(initialCollateralValue),
    requiredBackingValue: product(requiredBackingValue),
    checks,
  };
}

function formatNewPosition(snapshot: V2NewPositionSnapshot, localSymbol: string): Record<string, unknown> {
  const decimals = snapshot.terms.collateralDecimals;
  const collateralUnit = snapshot.collateralSymbol;
  const collateral = (raw: bigint) => amount(raw, decimals, collateralUnit);
  const local = (raw: bigint) => amount(raw, 18, localSymbol);
  return {
    terms: {
      collateralDecimals: decimals,
      minCollateral: collateral(snapshot.terms.minCollateral),
      initialCollateral: collateral(snapshot.terms.initialCollateral),
      mintingMaximum: local(snapshot.terms.mintingMaximum),
      liquidationPrice: priceAmount(snapshot.terms.liquidationPrice, decimals, `${localSymbol} per ${collateralUnit}`),
      initPeriodSeconds: seconds(snapshot.terms.initPeriodSeconds),
      durationSeconds: seconds(snapshot.terms.durationSeconds),
      challengePeriodSeconds: seconds(snapshot.terms.challengePeriodSeconds),
      riskPremiumPPM: ppm(snapshot.terms.riskPremiumPPM),
      reserveContributionPPM: ppm(snapshot.terms.reserveContributionPPM),
    },
    funding: {
      openingFee: local(snapshot.funding.openingFee),
      localBalance: local(snapshot.funding.localBalance),
      collateralBalance: collateral(snapshot.funding.collateralBalance),
      collateralAllowance: collateral(snapshot.funding.collateralAllowance),
      openingFeeFunded: snapshot.funding.openingFeeFunded,
      collateralFunded: snapshot.funding.collateralFunded,
      collateralApproved: snapshot.funding.collateralApproved,
    },
    illustrativeMintQuote: snapshot.illustrativeMintQuote === null ? null : {
      grossAmount: local(snapshot.illustrativeMintQuote.grossAmount),
      usableAmount: local(snapshot.illustrativeMintQuote.usableAmount),
      feePPM: ppm(snapshot.illustrativeMintQuote.feePPM),
      reservePPM: ppm(snapshot.illustrativeMintQuote.reservePPM),
    },
    assumedStart: timestamp(snapshot.assumedStart),
    assumedExpiration: timestamp(snapshot.assumedExpiration),
    annualInterestPPM: ppm(snapshot.annualInterestPPM),
    issues: snapshot.issues,
    valid: snapshot.valid,
    validityScope: 'opening terms and funding only; not later mint eligibility',
    plannedMintReview: formatPlannedMintReview(snapshot, localSymbol),
    quoteBasis: 'current reads and explicitly assumed future timestamps for a possible later mint; openPosition does not mint immediately; not a guaranteed future quote or transaction simulation',
  };
}

function formatClone(snapshot: V2CloneSnapshot, localSymbol: string): Record<string, unknown> {
  const decimals = snapshot.parent.collateral.decimals;
  const unit = snapshot.parent.collateral.symbol;
  const collateral = (raw: bigint) => amount(raw, decimals, unit);
  const local = (raw: bigint) => amount(raw, 18, localSymbol);
  return {
    parent: formatPosition(snapshot.parent, localSymbol),
    initialCollateral: collateral(snapshot.initialCollateral),
    initialMint: local(snapshot.initialMint),
    expiration: timestamp(snapshot.expiration),
    originalExpiration: timestamp(snapshot.originalExpiration),
    familyCapacity: local(snapshot.familyCapacity),
    collateralBalance: collateral(snapshot.collateralBalance),
    collateralAllowance: collateral(snapshot.collateralAllowance),
    collateralFunded: snapshot.collateralFunded,
    collateralApproved: snapshot.collateralApproved,
    quote: formatMintQuote(snapshot.quote, localSymbol),
    checks: snapshot.checks,
    eligible: snapshot.eligible,
    eligibilityBasis: 'read-derived checks only; not transaction simulation',
  };
}

function formatRepaymentQuote(quote: V2RepaymentQuote, localSymbol: string): Record<string, unknown> {
  const local = (raw: bigint) => amount(raw, 18, localSymbol);
  return {
    walletAmount: local(quote.walletAmount),
    grossDebtReduction: local(quote.grossDebtReduction),
    assignedReserve: signedAmount(quote.assignedReserve, 18, localSymbol),
    calculatedAssignedReserve: local(quote.calculatedAssignedReserve),
    remainingDebt: maybeAmount(quote.remainingDebt, 18, localSymbol),
    excessDebtReduction: local(quote.excessDebtReduction),
    wouldRevert: quote.wouldRevert,
  };
}

function formatRepayment(snapshot: V2RepaymentSnapshot, localSymbol: string): Record<string, unknown> {
  const local = (raw: bigint) => amount(raw, 18, localSymbol);
  return {
    minted: local(snapshot.minted),
    reserveContributionPPM: ppm(snapshot.reserveContributionPPM),
    assignedReserveForMinted: local(snapshot.assignedReserveForMinted),
    quote: formatRepaymentQuote(snapshot.quote, localSymbol),
    fullCandidate: {
      ...formatRepaymentQuote(snapshot.fullCandidate, localSymbol),
      complete: snapshot.fullCandidate.complete,
    },
    callerBalance: maybeAmount(snapshot.callerBalance, 18, localSymbol),
    callerAllowance: maybeAmount(snapshot.callerAllowance, 18, localSymbol),
    quoteFunded: snapshot.quoteFunded,
    fullCandidateFunded: snapshot.fullCandidateFunded,
    simulationRequired: snapshot.simulationRequired,
    caveats: snapshot.caveats,
  };
}

function formatWithdrawal(snapshot: V2WithdrawalSnapshot, localSymbol: string): Record<string, unknown> {
  const decimals = snapshot.position.collateral.decimals;
  const unit = snapshot.position.collateral.symbol;
  return {
    position: formatPosition(snapshot.position, localSymbol),
    amount: amount(snapshot.amount, decimals, unit),
    balanceAfter: maybeAmount(snapshot.balanceAfter, decimals, unit),
    wouldClose: snapshot.wouldClose,
    checks: snapshot.checks,
    eligible: snapshot.eligible,
    eligibilityBasis: 'read-derived withdrawal checks only; repayment eligibility is separate and no transaction was simulated',
  };
}

function formatChallenge(
  snapshot: V2ChallengeSnapshot,
  position: V2PositionState | null,
  localSymbol: string,
): Record<string, unknown> {
  return {
    size: position === null ? null : amount(snapshot.size, position.collateral.decimals, position.collateral.symbol),
    currentPrice: position === null ? null : priceAmount(
      snapshot.currentPrice,
      position.collateral.decimals,
      `${localSymbol} per ${position.collateral.symbol}`,
    ),
    start: timestamp(snapshot.start),
    period: seconds(snapshot.period),
    deadline: snapshot.deadline === null ? null : timestamp(snapshot.deadline),
    empty: snapshot.empty,
    firstPhaseActive: snapshot.active,
    settlementComplete: null,
    settlementNote: 'active describes only the first challenge phase; inactive or empty does not prove complete settlement, and no logs are enumerated',
  };
}

function formatGovernance(snapshot: V2GovernanceSnapshot): Record<string, unknown> {
  const votes = (raw: bigint) => amount(raw, 18, 'time-weighted votes');
  return {
    ownVotes: votes(snapshot.ownVotes),
    votes: votes(snapshot.votes),
    totalVotes: votes(snapshot.totalVotes),
    relativeVotes: snapshot.relativeVotes === null ? null : {
      raw: snapshot.relativeVotes.toString(),
      value: formatDecimal(snapshot.relativeVotes, 16),
      decimals: 16,
      unit: 'percent',
    },
    qualifiedByVotes: snapshot.qualifiedByVotes,
    qualified: snapshot.qualified,
    rule: 'strictly greater than 2%; zero total votes is not qualified',
  };
}

async function currentInstanceReads(config: V2McpConfig, rawCode: string) {
  const { code, instance, client } = clientFor(config, rawCode);
  const [token, minters, bridge, savings, equity] = await Promise.all([
    client.tokenSnapshot(),
    client.minterSnapshot(),
    client.bridgeSnapshot(),
    client.savingsSnapshot(),
    client.equitySnapshot(),
  ]);
  return {
    code,
    instance,
    reads: {
      token: view(token, formatToken(token)),
      minterCandidates: view(minters, formatMinters(minters)),
      sourceBridge: view(bridge, formatBridge(bridge, instance.symbol)),
      savings: view(savings, formatSavings(savings, instance.symbol)),
      equity: view(equity, formatEquity(equity, instance.symbol)),
    },
  };
}

function deploymentEvidence(instance: ReturnType<typeof v2InstanceOf>, full: boolean): Record<string, unknown> {
  return {
    kind: 'deployment artifact evidence only; not current chain state or live verification',
    source: rawValue(instance.sourceEvidence),
    configuredRate: rawValue(instance.rateEvidence),
    constructorArgs: rawValue(instance.constructorArgs),
    ...(full ? { transactions: rawValue(instance.transactions), postconditions: rawValue(instance.postconditions) } : {}),
  };
}

function quoteRequest(grossAmount?: string, usableAmount?: string): V2QuoteRequest | undefined {
  if (grossAmount !== undefined && usableAmount !== undefined) {
    throw new Error('grossAmount and usableAmount are mutually exclusive');
  }
  if (grossAmount !== undefined) return { grossAmount: parseDecimal(grossAmount, 18) };
  if (usableAmount !== undefined) return { usableAmount: parseDecimal(usableAmount, 18) };
  return undefined;
}

async function positionRead(
  config: V2McpConfig,
  rawCode: string,
  address: string,
  args: { caller?: string; recipient?: string; grossAmount?: string; usableAmount?: string },
) {
  const { code, instance, client } = clientFor(config, rawCode);
  const quote = quoteRequest(args.grossAmount, args.usableAmount);
  const snapshot = await client.positionSnapshot(getAddress(address), {
    ...(args.caller === undefined ? {} : { caller: getAddress(args.caller) }),
    ...(args.recipient === undefined ? {} : { recipient: getAddress(args.recipient) }),
    ...(quote === undefined ? {} : { quote }),
  });
  return {
    ...envelope(config, code, snapshot, formatPositionSnapshot(snapshot, instance.symbol)),
    eligible: snapshot.eligible,
  };
}

function disabled(tool: string, guardian = false): never {
  throw new Error(`${tool}: ${guardian ? 'legacy V1 only; ' : ''}disabled in V2 read-only integration`);
}

const positionOptionalSchema = {
  caller: sAddress.optional(),
  recipient: sAddress.optional(),
  grossAmount: sAmount.optional().describe('gross local token amount, 18 decimals'),
  usableAmount: sAmount.optional().describe('desired usable local token amount, 18 decimals'),
};

export function buildV2Tools(config: V2McpConfig): Record<string, ToolDef> {
  const disabledWrite = (name: string, guardian = false): ToolDef => ({
    description: guardian ? 'Legacy V1 guardian write; unavailable for protocol V2.' : 'Legacy write; disabled for protocol V2 read-only integration.',
    inputSchema: { code: sCode, dryRun: sDryRun },
    handler: async () => disabled(name, guardian),
  });

  return {
    list_instances: {
      description: 'List supplied V2 instances with current token, five-minter, bridge, savings, and equity reads; no guardian/bootstrap calls.',
      inputSchema: {},
      handler: async () => {
        const rows = [];
        for (const code of config.registry.codes) {
          const { instance, reads } = await currentInstanceReads(config, code);
          rows.push({
            protocolGeneration: 'v2',
            network: config.network,
            chainId: config.chainId,
            code,
            symbol: instance.symbol,
            token: instance.token,
            source: instance.source,
            bridge: instance.bridge,
            deploymentEvidence: deploymentEvidence(instance, false),
            currentReads: reads,
          });
        }
        return {
          protocolGeneration: 'v2',
          network: config.network,
          chainId: config.chainId,
          count: rows.length,
          readOnly: true,
          transactionSimulation: 'not_performed',
          instances: rows,
        };
      },
    },

    instance_state: {
      description: 'Current V2 token/minter/bridge/savings/equity snapshots plus separately labelled deployment evidence; no guardian/bootstrap reads.',
      inputSchema: { code: sCode },
      handler: async ({ code }: { code: string }) => {
        const { instance, code: c, reads } = await currentInstanceReads(config, code);
        return {
          protocolGeneration: 'v2',
          network: config.network,
          chainId: config.chainId,
          code: c,
          symbol: instance.symbol,
          readOnly: true,
          transactionSimulation: 'not_performed',
          contracts: rawValue(instance.addresses),
          deploymentEvidence: deploymentEvidence(instance, true),
          currentReads: reads,
        };
      },
    },

    position_state: {
      description: 'V2 position state, exact collateral/price units, optional mint quote, expiry, and complete read-derived eligibility.',
      inputSchema: { code: sCode, positionAddress: sAddress, ...positionOptionalSchema },
      handler: async (args: { code: string; positionAddress: string; caller?: string; recipient?: string; grossAmount?: string; usableAmount?: string }) =>
        positionRead(config, args.code, args.positionAddress, args),
    },

    list_challenges: {
      description: 'Unavailable on V2 because this integration does not enumerate logs; use v2_challenge with an explicit index.',
      inputSchema: { code: sCode, position: sAddress.optional() },
      handler: async () => {
        throw new Error('list_challenges: V2 log enumeration is not provided; use v2_challenge with an explicit challengeIndex');
      },
    },

    fee_quote: {
      description: 'Disabled on V2 because all legacy writes and fee sampling are unavailable.',
      inputSchema: { code: sCode, tool: z.string() },
      handler: async () => disabled('fee_quote'),
    },

    v2_verify: {
      description: 'Verify V2 chain ID, bytecode, metadata, and cross-contract links with view reads at one source block.',
      inputSchema: { code: sCode },
      handler: async ({ code }: { code: string }) => {
        const { client, code: c, instance } = clientFor(config, code);
        const snapshot: V2Verification = await client.verify();
        return envelope(config, c, snapshot, {
          verified: snapshot.verified,
          chainId: snapshot.chainId,
          checkedAddresses: snapshot.checkedAddresses,
          sourceDecimals: snapshot.sourceDecimals,
          decimalMultiplier: snapshot.decimalMultiplier.toString(),
          savingsRatePPM: ppm(snapshot.savingsRatePPM),
          localSymbol: instance.symbol,
        });
      },
    },

    v2_new_position: {
      description: 'Read-only V2 openPosition terms, static bounds/issues, opening funding, and illustrative gross/usable quote; never a simulation or write.',
      inputSchema: {
        code: sCode,
        caller: sAddress,
        collateralToken: sAddress,
        collateralDecimals: z.number().int().min(0).max(24),
        minCollateral: sAmount,
        initialCollateral: sAmount,
        mintingMaximum: sAmount.describe('gross local minting limit, 18 decimals'),
        initPeriodSeconds: sWhole,
        durationSeconds: sWhole,
        challengePeriodSeconds: sWhole,
        riskPremiumPPM: sWhole,
        liquidationPrice: sAmount.describe('local per whole collateral; 36 - collateralDecimals decimal places'),
        reserveContributionPPM: sWhole,
        plannedMintAmount: sAmount.optional().describe('optional illustrative gross local mint, 18 decimals'),
      },
      handler: async (args: {
        code: string;
        caller: string;
        collateralToken: string;
        collateralDecimals: number;
        minCollateral: string;
        initialCollateral: string;
        mintingMaximum: string;
        initPeriodSeconds: string;
        durationSeconds: string;
        challengePeriodSeconds: string;
        riskPremiumPPM: string;
        liquidationPrice: string;
        reserveContributionPPM: string;
        plannedMintAmount?: string;
      }) => {
        const { client, code, instance } = clientFor(config, args.code);
        const snapshot = await client.newPositionSnapshot({
          caller: getAddress(args.caller),
          collateral: getAddress(args.collateralToken),
          minCollateral: parseDecimal(args.minCollateral, args.collateralDecimals),
          initialCollateral: parseDecimal(args.initialCollateral, args.collateralDecimals),
          mintingMaximum: parseDecimal(args.mintingMaximum, 18),
          initPeriodSeconds: BigInt(args.initPeriodSeconds),
          durationSeconds: BigInt(args.durationSeconds),
          challengePeriodSeconds: BigInt(args.challengePeriodSeconds),
          riskPremiumPPM: parsePPM(args.riskPremiumPPM),
          liquidationPrice: parseLiquidationPrice(args.liquidationPrice, args.collateralDecimals),
          reserveContributionPPM: parsePPM(args.reserveContributionPPM),
          ...(args.plannedMintAmount === undefined ? {} : { plannedMintAmount: parseDecimal(args.plannedMintAmount, 18) }),
        });
        if (snapshot.terms.collateralDecimals !== args.collateralDecimals) {
          throw new Error(`v2_new_position: supplied collateralDecimals ${args.collateralDecimals} does not match chain value ${snapshot.terms.collateralDecimals}`);
        }
        const formatted = formatNewPosition(snapshot, instance.symbol);
        return {
          ...envelope(config, code, snapshot, formatted),
          valid: snapshot.valid,
          validityScope: formatted.validityScope,
          plannedMintReview: formatted.plannedMintReview,
        };
      },
    },

    v2_clone_position: {
      description: 'Read-only V2 clone terms and quote using original family capacity and the absolute child expiration.',
      inputSchema: {
        code: sCode,
        parent: sAddress,
        collateralFunder: sAddress,
        childOwner: sAddress,
        initialCollateral: sAmount,
        initialMint: sAmount.describe('initial gross local mint, 18 decimals'),
        expiration: sWhole.describe('absolute child expiration as Unix seconds'),
      },
      handler: async (args: {
        code: string;
        parent: string;
        collateralFunder: string;
        childOwner: string;
        initialCollateral: string;
        initialMint: string;
        expiration: string;
      }) => {
        const { client, code, instance } = clientFor(config, args.code);
        const parent = getAddress(args.parent);
        const initialState = await client.positionState(parent);
        const snapshot = await client.cloneSnapshot({
          parent,
          collateralFunder: getAddress(args.collateralFunder),
          childOwner: getAddress(args.childOwner),
          initialCollateral: parseDecimal(args.initialCollateral, initialState.collateral.decimals),
          initialMint: parseDecimal(args.initialMint, 18),
          expiration: BigInt(args.expiration),
        });
        if (snapshot.parent.collateral.decimals !== initialState.collateral.decimals) {
          throw new Error('v2_clone_position: collateral decimals changed between reads; retry at a later block');
        }
        return {
          ...envelope(config, code, snapshot, formatClone(snapshot, instance.symbol)),
          eligible: snapshot.eligible,
        };
      },
    },

    v2_position_mint: {
      description: 'V2 existing-position mint state and exact gross/usable quote with complete caller/capacity/backing/challenge/expiry eligibility.',
      inputSchema: { code: sCode, position: sAddress, ...positionOptionalSchema },
      handler: async (args: { code: string; position: string; caller?: string; recipient?: string; grossAmount?: string; usableAmount?: string }) =>
        positionRead(config, args.code, args.position, args),
    },

    v2_repayment: {
      description: 'V2 wallet repayment versus gross debt reduction, assigned reserve, funding, and roller full-repayment candidate caveats.',
      inputSchema: { code: sCode, position: sAddress, caller: sAddress.optional(), amount: sAmount.optional() },
      handler: async (args: { code: string; position: string; caller?: string; amount?: string }) => {
        const { client, code, instance } = clientFor(config, args.code);
        const snapshot = await client.repaymentSnapshot(getAddress(args.position), {
          ...(args.caller === undefined ? {} : { caller: getAddress(args.caller) }),
          ...(args.amount === undefined ? {} : { amount: parseDecimal(args.amount, 18) }),
        });
        return envelope(config, code, snapshot, formatRepayment(snapshot, instance.symbol));
      },
    },

    v2_withdrawal: {
      description: 'V2 collateral withdrawal/closure and post-withdrawal backing checks, separate from repayment eligibility.',
      inputSchema: { code: sCode, position: sAddress, caller: sAddress.optional(), amount: sAmount },
      handler: async (args: { code: string; position: string; caller?: string; amount: string }) => {
        const { client, code, instance } = clientFor(config, args.code);
        const position = getAddress(args.position);
        const initialState = await client.positionState(position);
        const snapshot = await client.withdrawalSnapshot(position, {
          ...(args.caller === undefined ? {} : { caller: getAddress(args.caller) }),
          amount: parseDecimal(args.amount, initialState.collateral.decimals),
        });
        if (snapshot.position.collateral.decimals !== initialState.collateral.decimals) {
          throw new Error('v2_withdrawal: collateral decimals changed between reads; retry at a later block');
        }
        return {
          ...envelope(config, code, snapshot, formatWithdrawal(snapshot, instance.symbol)),
          eligible: snapshot.eligible,
        };
      },
    },

    v2_challenge: {
      description: 'Read one explicit V2 challenge index; active is the first phase only and settlement completion is not inferred or enumerated.',
      inputSchema: { code: sCode, challengeIndex: sWhole.describe('explicit uint32 challenge index') },
      handler: async (args: { code: string; challengeIndex: string }) => {
        const { client, code, instance } = clientFor(config, args.code);
        const snapshot = await client.challengeSnapshot(BigInt(args.challengeIndex));
        const position = snapshot.empty ? null : await client.positionState(snapshot.position);
        return envelope(config, code, snapshot, formatChallenge(snapshot, position, instance.symbol));
      },
    },

    v2_bridge: {
      description: 'V2 source bridge state/account credits and an optional source-mint or local-burn plan with exact source/local units.',
      inputSchema: {
        code: sCode,
        account: sAddress.optional(),
        mintSourceAmount: sAmount.optional(),
        burnLocalAmount: sAmount.optional(),
        credit: z.boolean().default(false),
      },
      handler: async (args: { code: string; account?: string; mintSourceAmount?: string; burnLocalAmount?: string; credit: boolean }) => {
        if (args.mintSourceAmount !== undefined && args.burnLocalAmount !== undefined) {
          throw new Error('v2_bridge: mintSourceAmount and burnLocalAmount are mutually exclusive');
        }
        const { client, code, instance } = clientFor(config, args.code);
        const snapshot = await client.bridgeSnapshot({
          ...(args.account === undefined ? {} : { account: getAddress(args.account) }),
          ...(args.mintSourceAmount === undefined ? {} : { mintSourceAmount: parseDecimal(args.mintSourceAmount, instance.sourceDecimals) }),
          ...(args.burnLocalAmount === undefined ? {} : { burnLocalAmount: parseDecimal(args.burnLocalAmount, 18) }),
          credit: args.credit,
        });
        if (snapshot.sourceDecimals !== instance.sourceDecimals) {
          throw new Error(`v2_bridge: chain source decimals ${snapshot.sourceDecimals} do not match registry evidence ${instance.sourceDecimals}`);
        }
        return envelope(config, code, snapshot, formatBridge(snapshot, instance.symbol));
      },
    },

    v2_savings: {
      description: 'Current V2 savings rates, clocks, deposit acceptance, equity amount, and optional account interest/lock state.',
      inputSchema: { code: sCode, account: sAddress.optional() },
      handler: async (args: { code: string; account?: string }) => {
        const { client, code, instance } = clientFor(config, args.code);
        const snapshot = await client.savingsSnapshot(args.account === undefined ? {} : { account: getAddress(args.account) });
        return envelope(config, code, snapshot, formatSavings(snapshot, instance.symbol));
      },
    },

    v2_equity: {
      description: 'Current V2 equity price/supply/holding state with optional local-investment and share-redemption view quotes.',
      inputSchema: {
        code: sCode,
        account: sAddress.optional(),
        investment: sAmount.optional().describe('local token investment, 18 decimals'),
        redemptionShares: sAmount.optional().describe('equity shares, 18 decimals'),
      },
      handler: async (args: { code: string; account?: string; investment?: string; redemptionShares?: string }) => {
        const { client, code, instance } = clientFor(config, args.code);
        const snapshot = await client.equitySnapshot({
          ...(args.account === undefined ? {} : { account: getAddress(args.account) }),
          ...(args.investment === undefined ? {} : { investment: parseDecimal(args.investment, 18) }),
          ...(args.redemptionShares === undefined ? {} : { redemptionShares: parseDecimal(args.redemptionShares, 18) }),
        });
        if (snapshot.decimals !== 18) throw new Error(`v2_equity: unsupported equity decimals ${snapshot.decimals}; expected 18`);
        return envelope(config, code, snapshot, formatEquity(snapshot, instance.symbol));
      },
    },

    v2_governance: {
      description: 'V2 own/delegated/total votes and strict greater-than-2% qualification; caller is required and zero totals do not qualify.',
      inputSchema: { code: sCode, caller: sAddress, helpers: z.array(sAddress).optional() },
      handler: async (args: { code: string; caller: string; helpers?: string[] }) => {
        const { client, code } = clientFor(config, args.code);
        const snapshot = await client.governanceSnapshot(
          getAddress(args.caller),
          (args.helpers ?? []).map((helper) => getAddress(helper)),
        );
        return {
          ...envelope(config, code, snapshot, formatGovernance(snapshot)),
          qualified: snapshot.qualified,
        };
      },
    },

    mint: {
      description: 'Legacy write; disabled for protocol V2 read-only integration.',
      inputSchema: { code: sCode, position: sAddress, amount: sAmount, dryRun: sDryRun },
      handler: async () => disabled('mint'),
    },
    launch_challenge: {
      description: 'Legacy write; disabled for protocol V2 read-only integration.',
      inputSchema: { code: sCode, position: sAddress, size: sAmount, bid: sAmount, dryRun: sDryRun },
      handler: async () => disabled('launch_challenge'),
    },
    place_bid: {
      description: 'Legacy write; disabled for protocol V2 read-only integration.',
      inputSchema: { code: sCode, challengeNumber: sWhole, size: sAmount, postpone: z.boolean().default(false), dryRun: sDryRun },
      handler: async () => disabled('place_bid'),
    },
    open_position: {
      description: 'Legacy write; disabled for protocol V2 read-only integration. Use v2_new_position for read-only planning.',
      inputSchema: {
        code: sCode,
        collateralToken: sAddress,
        minAmount: sAmount,
        minCollateral: sAmount,
        initialCollateral: sAmount,
        liqPrice: sAmount,
        durationSeconds: sWhole,
        feePPM: sWhole.optional(),
        initPeriodSeconds: sWhole.optional(),
        challengePeriodSeconds: sWhole.optional(),
        reserveContributionPPM: sWhole.optional(),
        dryRun: sDryRun,
      },
      handler: async () => disabled('open_position'),
    },
    guardian_pause: disabledWrite('guardian_pause', true),
    guardian_schedule_unpause: disabledWrite('guardian_schedule_unpause', true),
    guardian_unpause: disabledWrite('guardian_unpause', true),
  };
}
