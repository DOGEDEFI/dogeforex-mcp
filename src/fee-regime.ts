import { formatUnits } from 'ethers';
import type { JsonRpcProvider } from 'ethers';

/**
 * L1 data-fee regime on DogeOS Chikyu (OP-stack L2).
 *
 * Raw receipts carry an `l1Fee` field (wei of tDOGE). The GasPriceOracle
 * predeploy is NOT wired on this chain (eth_call returns empty), so the
 * regime is sampled from recent mined transactions: l1Fee vs calldata size
 * fits l1Fee ≈ fixed + perByte * bytes. The ops abort rule has TWO guards,
 * either of which aborts a write when it exceeds 2x baseline (MCP-01/02):
 *
 *  1. slope guard — the fitted marginal per-byte rate vs the 14 Oct 2026
 *     baseline of 7.1e-5 DOGE/B (abort if > 2x = 1.42e-4), per
 *     deployments/k9usd.chikyu.json feePreflight.
 *  2. total guard — the median TOTAL L1 fee of the sampled txs vs a baseline
 *     total. The L1 fee is fixed-dominant (~0.04 DOGE/tx fixed; the
 *     historical ~12x spike was a fixed-regime event that left the slope
 *     looking normal), so a pure fixed spike must trip too. The baseline
 *     total is BASELINE_TOTAL_DOGE (documented fixed component) plus the
 *     baseline per-byte rate times the typical calldata size, derived from
 *     the first sample batch and recorded in `samplerState` (or baked in
 *     wholesale via the DOGEFOREX_BASELINE_TOTAL env var).
 *
 * The fit itself is robustified (MCP-02): >= 8 inlier samples are required,
 * samples beyond 2.5x the running median are rejected before fitting, and a
 * non-positive fitted slope fails closed instead of being clamped to 0
 * (which would zero the guard's ratio and disable it).
 */

/** Baseline marginal L1 rate, 14 Oct 2026 (deployments/k9usd.chikyu.json). */
export const L1_FEE_BASELINE_PER_BYTE_DOGE = 7.1e-5;
export const L1_FEE_ABORT_RATIO = 2;

/**
 * Documented baseline FIXED per-tx L1 component (DOGE). The deployment
 * registry records the L1 data fee as fixed-dominant: ~0.04 DOGE/tx at
 * baseline (0.04-0.09 observed across calldata sizes), marginal 7.1e-5
 * DOGE/B. This is the fixed part of the total guard's baseline; the whole
 * baseline total can be overridden via DOGEFOREX_BASELINE_TOTAL.
 */
export const BASELINE_TOTAL_DOGE = 0.04;

const SAMPLE_BLOCKS = 6;
const TXS_PER_BLOCK = 6;
const MIN_SAMPLES = 8;
const OUTLIER_RATIO = 2.5;

export interface FeeModel {
  /** Fixed per-tx L1 cost (DOGE) — dominant on this chain (~0.04). */
  fixedDoge: number;
  /** Marginal L1 cost per calldata byte (DOGE) — the slope-guard indicator. */
  perByteDoge: number;
  /** Inlier samples the fit used (after outlier rejection). */
  sampleCount: number;
  /** Median TOTAL L1 fee (DOGE) across the inliers — total-guard input. */
  medianTotalDoge: number;
  /** Baseline total L1 fee (DOGE) the total guard compares against. */
  baselineTotalDoge: number;
}

export interface FeeQuote {
  calldataBytes: number;
  /** Fitted fixed L1 component (DOGE), surfaced for transparency (MCP-01). */
  fixedDoge: string;
  l1FeeDoge: string;
  l2FeeDoge: string;
  totalFeeDoge: string;
  medianTotalFeeDoge: string;
  baselineTotalFeeDoge: string;
  perByteRateDoge: string;
  baselinePerByteDoge: string;
  ratioVsBaseline: number;
  totalRatioVsBaseline: number;
  /** True when EITHER guard exceeds the abort ratio. */
  regimeShift: boolean;
}

export interface L1Sample {
  bytes: number;
  l1Doge: number;
}

/**
 * Recorded sampler baselines. `baselineTotalDoge` is baked in from
 * DOGEFOREX_BASELINE_TOTAL when that env var is set; otherwise it is derived
 * once from the first sample batch — BASELINE_TOTAL_DOGE (documented fixed)
 * + the baseline per-byte rate x the batch's median calldata size (the
 * "typical" component) — and then reused, so the abort threshold stays
 * stable even if the tx-size mix drifts between batches. `baselineBytes` is
 * the median calldata size it was derived from.
 */
export const samplerState: {
  baselinePerByteDoge: number;
  baselineTotalDoge: number | null;
  baselineBytes: number | null;
} = {
  baselinePerByteDoge: L1_FEE_BASELINE_PER_BYTE_DOGE,
  baselineTotalDoge: null,
  baselineBytes: null,
};

/** Reset the recorded baseline state (offline tests). */
export function resetSamplerState(): void {
  samplerState.baselineTotalDoge = null;
  samplerState.baselineBytes = null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Reject samples beyond OUTLIER_RATIO x the running median (recomputed after
 * each pass, in both directions). One large-batch or reverted-but-mined tx
 * receipt must not swing the fit either way (MCP-02).
 */
export function rejectOutliers(samples: L1Sample[]): L1Sample[] {
  let pool = [...samples];
  for (;;) {
    if (pool.length <= 1) return pool;
    const med = median(pool.map((s) => s.l1Doge));
    if (med <= 0) return pool;
    const kept = pool.filter((s) => s.l1Doge <= med * OUTLIER_RATIO && s.l1Doge * OUTLIER_RATIO >= med);
    if (kept.length === pool.length) return kept;
    pool = kept;
  }
}

/** Resolve (and, on first use, record) the total-guard baseline. */
function resolveBaselineTotal(env: NodeJS.ProcessEnv, medianBytes: number): number {
  const raw = env.DOGEFOREX_BASELINE_TOTAL;
  if (raw != null && raw !== '') {
    const baked = Number(raw);
    if (!Number.isFinite(baked) || baked <= 0) {
      throw new Error(`DOGEFOREX_BASELINE_TOTAL: expected a positive DOGE amount, got "${raw}"`);
    }
    samplerState.baselineTotalDoge = baked;
    return baked;
  }
  if (samplerState.baselineTotalDoge != null) return samplerState.baselineTotalDoge;
  const derived = BASELINE_TOTAL_DOGE + L1_FEE_BASELINE_PER_BYTE_DOGE * medianBytes;
  samplerState.baselineBytes = medianBytes;
  samplerState.baselineTotalDoge = derived;
  return derived;
}

/**
 * Fit fixed + per-byte L1 cost from raw samples. Pure (no RPC) so the math
 * is unit-testable offline; sampleFeeModel() only gathers chain data and
 * delegates here.
 *
 * Fails closed (MCP-02): fewer than MIN_SAMPLES inliers after outlier
 * rejection, an unidentified slope (all identical calldata sizes), or a
 * non-positive fitted slope all throw rather than produce a guard-disabled
 * model. There is deliberately no clamp: a negative slope means the sample
 * cannot establish the regime, and the write must not proceed on a
 * fabricated zero rate.
 */
export function fitFeeModel(samples: L1Sample[], env: NodeJS.ProcessEnv = process.env): FeeModel {
  const inliers = rejectOutliers(samples);
  if (inliers.length < MIN_SAMPLES) {
    throw new Error(
      `fee preflight: insufficient stable samples (${inliers.length} of ${samples.length} usable, need >= ${MIN_SAMPLES}) — cannot establish the L1 fee regime`,
    );
  }

  const n = inliers.length;
  const sx = inliers.reduce((a, s) => a + s.bytes, 0);
  const sy = inliers.reduce((a, s) => a + s.l1Doge, 0);
  const sxx = inliers.reduce((a, s) => a + s.bytes * s.bytes, 0);
  const sxy = inliers.reduce((a, s) => a + s.bytes * s.l1Doge, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) {
    throw new Error(
      'fee preflight: insufficient stable samples — all sampled txs have identical calldata size, per-byte slope unidentified',
    );
  }
  const perByte = (n * sxy - sx * sy) / denom;
  if (!Number.isFinite(perByte) || perByte <= 0) {
    throw new Error(
      `fee preflight: insufficient stable samples — fitted per-byte rate ${perByte} DOGE/B is not positive, fee model inconclusive`,
    );
  }
  const fixed = (sy - perByte * sx) / n;
  const medianTotal = median(inliers.map((s) => s.l1Doge));
  const baselineTotal = resolveBaselineTotal(env, median(inliers.map((s) => s.bytes)));
  return {
    fixedDoge: fixed,
    perByteDoge: perByte,
    sampleCount: n,
    medianTotalDoge: medianTotal,
    baselineTotalDoge: baselineTotal,
  };
}

/** Fit fixed + per-byte L1 cost from recent mined txs. */
export async function sampleFeeModel(provider: JsonRpcProvider): Promise<FeeModel> {
  const latest = await provider.getBlockNumber();
  const samples: L1Sample[] = [];

  for (let back = 1; back <= SAMPLE_BLOCKS; back++) {
    const block = await provider.getBlock(latest - back, false);
    if (!block) continue;
    const hashes = block.transactions.slice(0, TXS_PER_BLOCK);
    const fetched = await Promise.all(
      hashes.map(async (hash) => {
        const [tx, raw] = await Promise.all([
          provider.getTransaction(hash),
          provider.send('eth_getTransactionReceipt', [hash]) as Promise<{ l1Fee?: string } | null>,
        ]);
        if (!tx || !tx.data || tx.data.length < 10 || !raw?.l1Fee) return null;
        return { bytes: (tx.data.length - 2) / 2, l1Doge: Number(formatUnits(BigInt(raw.l1Fee), 18)) };
      }),
    );
    for (const s of fetched) if (s) samples.push(s);
  }

  return fitFeeModel(samples);
}

/** Quote an L1+L2 total fee for a prospective transaction. */
export function quoteFee(model: FeeModel, calldataBytes: number, l2FeeWei: bigint): FeeQuote {
  const l1 = model.fixedDoge + model.perByteDoge * calldataBytes;
  const l2 = Number(formatUnits(l2FeeWei, 18));
  const ratio = model.perByteDoge / L1_FEE_BASELINE_PER_BYTE_DOGE;
  const totalRatio = model.medianTotalDoge / model.baselineTotalDoge;
  const regimeShift = ratio > L1_FEE_ABORT_RATIO || totalRatio > L1_FEE_ABORT_RATIO;
  return {
    calldataBytes,
    fixedDoge: model.fixedDoge.toFixed(6),
    l1FeeDoge: l1.toFixed(6),
    l2FeeDoge: l2.toFixed(6),
    totalFeeDoge: (l1 + l2).toFixed(6),
    medianTotalFeeDoge: model.medianTotalDoge.toFixed(6),
    baselineTotalFeeDoge: model.baselineTotalDoge.toFixed(6),
    perByteRateDoge: model.perByteDoge.toExponential(3),
    baselinePerByteDoge: L1_FEE_BASELINE_PER_BYTE_DOGE.toExponential(2),
    ratioVsBaseline: Number(ratio.toFixed(2)),
    totalRatioVsBaseline: Number(totalRatio.toFixed(2)),
    regimeShift,
  };
}

/**
 * Hard ops abort rule: before SENDING any write, sample the fee regime and
 * throw when EITHER guard exceeds 2x baseline (MCP-01) — the fitted per-byte
 * slope, or the median sampled total L1 fee (catches fixed-dominant spikes
 * that leave the slope unchanged).
 */
export function assertFeeRegime(quote: FeeQuote): void {
  if (!quote.regimeShift) return;
  const reasons: string[] = [];
  if (quote.ratioVsBaseline > L1_FEE_ABORT_RATIO) {
    reasons.push(
      `per-byte rate ${quote.perByteRateDoge} DOGE/B is ${quote.ratioVsBaseline}x the ` +
        `${L1_FEE_BASELINE_PER_BYTE_DOGE} baseline`,
    );
  }
  if (quote.totalRatioVsBaseline > L1_FEE_ABORT_RATIO) {
    reasons.push(
      `median total L1 fee ${quote.medianTotalFeeDoge} DOGE is ${quote.totalRatioVsBaseline}x the ` +
        `${quote.baselineTotalFeeDoge} DOGE baseline`,
    );
  }
  throw new Error(
    `fee regime shift: ${reasons.join('; ')} (> ${L1_FEE_ABORT_RATIO}x abort rule on either guard) — retry later`,
  );
}
