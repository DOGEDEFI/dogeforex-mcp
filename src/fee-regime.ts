import { formatUnits } from 'ethers';
import type { JsonRpcProvider } from 'ethers';

/**
 * L1 data-fee regime on DogeOS Chikyu (OP-stack L2).
 *
 * Raw receipts carry an `l1Fee` field (wei of tDOGE). The GasPriceOracle
 * predeploy is NOT wired on this chain (eth_call returns empty), so the
 * regime is sampled from recent mined transactions: l1Fee vs calldata size
 * fits l1Fee ≈ fixed + perByte * bytes. The ops abort rule compares the
 * marginal per-byte rate against the 14 Oct 2026 baseline of 7.1e-5 DOGE/B
 * (abort if > 2x = 1.42e-4), per deployments/k9usd.chikyu.json feePreflight.
 */
export const L1_FEE_BASELINE_PER_BYTE_DOGE = 7.1e-5;
export const L1_FEE_ABORT_RATIO = 2;

const SAMPLE_BLOCKS = 6;
const TXS_PER_BLOCK = 6;
const MIN_SAMPLES = 5;

export interface FeeModel {
  /** Fixed per-tx L1 cost (DOGE) — dominant on this chain (~0.04). */
  fixedDoge: number;
  /** Marginal L1 cost per calldata byte (DOGE) — the regime indicator. */
  perByteDoge: number;
  sampleCount: number;
}

export interface FeeQuote {
  calldataBytes: number;
  l1FeeDoge: string;
  l2FeeDoge: string;
  totalFeeDoge: string;
  perByteRateDoge: string;
  baselinePerByteDoge: string;
  ratioVsBaseline: number;
  regimeShift: boolean;
}

interface L1Sample {
  bytes: number;
  l1Doge: number;
}

/** Fit fixed + per-byte L1 cost from recent mined txs. */
export async function sampleFeeModel(provider: JsonRpcProvider): Promise<FeeModel> {
  const latest = await provider.getBlockNumber();
  const samples: L1Sample[] = [];

  for (let back = 1; back <= SAMPLE_BLOCKS && samples.length < 60; back++) {
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

  if (samples.length < MIN_SAMPLES) {
    throw new Error(`fee preflight: only ${samples.length} recent txs with l1Fee found — cannot establish the L1 fee regime`);
  }

  const n = samples.length;
  const sx = samples.reduce((a, s) => a + s.bytes, 0);
  const sy = samples.reduce((a, s) => a + s.l1Doge, 0);
  const sxx = samples.reduce((a, s) => a + s.bytes * s.bytes, 0);
  const sxy = samples.reduce((a, s) => a + s.bytes * s.l1Doge, 0);
  const denom = n * sxx - sx * sx;
  // Degenerate fallback if every sample had the same size: attribute the
  // whole fee to the per-byte rate so the regime check stays conservative.
  const perByte = denom === 0 ? sy / n / (sx / n || 1) : (n * sxy - sx * sy) / denom;
  const fixed = (sy - perByte * sx) / n;
  return { fixedDoge: Math.max(0, fixed), perByteDoge: Math.max(0, perByte), sampleCount: n };
}

/** Quote an L1+L2 total fee for a prospective transaction. */
export function quoteFee(model: FeeModel, calldataBytes: number, l2FeeWei: bigint): FeeQuote {
  const l1 = model.fixedDoge + model.perByteDoge * calldataBytes;
  const l2 = Number(formatUnits(l2FeeWei, 18));
  const ratio = model.perByteDoge / L1_FEE_BASELINE_PER_BYTE_DOGE;
  return {
    calldataBytes,
    l1FeeDoge: l1.toFixed(6),
    l2FeeDoge: l2.toFixed(6),
    totalFeeDoge: (l1 + l2).toFixed(6),
    perByteRateDoge: model.perByteDoge.toExponential(3),
    baselinePerByteDoge: L1_FEE_BASELINE_PER_BYTE_DOGE.toExponential(2),
    ratioVsBaseline: Number(ratio.toFixed(2)),
    regimeShift: ratio > L1_FEE_ABORT_RATIO,
  };
}

/**
 * Hard ops abort rule: before SENDING any write, sample the fee regime and
 * throw when the marginal per-byte L1 rate exceeds 2x the baseline.
 */
export function assertFeeRegime(quote: FeeQuote): void {
  if (quote.regimeShift) {
    throw new Error(
      `fee regime shift: L1 rate ${quote.perByteRateDoge} DOGE/B is ${quote.ratioVsBaseline}x ` +
        `the ${L1_FEE_BASELINE_PER_BYTE_DOGE} baseline (> ${L1_FEE_ABORT_RATIO}x abort rule) — retry later`,
    );
  }
}
