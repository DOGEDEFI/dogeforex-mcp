// Offline fee-regime math tests (MCP-09b) — no network, no mocks: synthetic
// sample batches are fed straight into the real fit/quote/abort functions.
//
// Fee model under test: l1Fee ≈ fixed + perByte·bytes with the documented
// baseline fixed ≈ 0.04 DOGE and per-byte 7.1e-5 DOGE/B. The abort rule
// trips when EITHER the fitted slope or the median sampled total exceeds
// 2x baseline (MCP-01), the fit rejects outliers beyond 2.5x the running
// median and requires >= 8 inliers (MCP-02).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertFeeRegime,
  BASELINE_TOTAL_DOGE,
  fitFeeModel,
  L1_FEE_BASELINE_PER_BYTE_DOGE,
  quoteFee,
  rejectOutliers,
  resetSamplerState,
  samplerState,
  type L1Sample,
} from '../src/fee-regime.js';

const FIXED = BASELINE_TOTAL_DOGE; // 0.04 — documented fixed component
const SLOPE = L1_FEE_BASELINE_PER_BYTE_DOGE; // 7.1e-5

/** n samples on an exact baseline-regime line, bytes spread 100..100*n. */
function baselineSamples(n: number): L1Sample[] {
  return Array.from({ length: n }, (_, i) => {
    const bytes = 100 * (i + 1);
    return { bytes, l1Doge: FIXED + SLOPE * bytes };
  });
}

/** Same sizes as baselineSamples(n) but with `factor` applied to the fixed part only. */
function fixedSpikeSamples(n: number, factor: number): L1Sample[] {
  return Array.from({ length: n }, (_, i) => {
    const bytes = 100 * (i + 1);
    return { bytes, l1Doge: FIXED * factor + SLOPE * bytes };
  });
}

/** Same sizes as baselineSamples(n) but with `factor` applied to the slope only. */
function slopeSpikeSamples(n: number, factor: number): L1Sample[] {
  return Array.from({ length: n }, (_, i) => {
    const bytes = 100 * (i + 1);
    return { bytes, l1Doge: FIXED + SLOPE * factor * bytes };
  });
}

describe('fee-regime fit and guards (offline)', () => {
  beforeEach(() => resetSamplerState());

  it('baseline batch: clean fit, both guards at ~1x, abort does not fire', () => {
    const model = fitFeeModel(baselineSamples(10), {});
    expect(model.perByteDoge).toBeCloseTo(SLOPE, 10);
    expect(model.fixedDoge).toBeCloseTo(FIXED, 10);
    expect(model.sampleCount).toBe(10);
    expect(model.medianTotalDoge).toBeCloseTo(FIXED + SLOPE * 550, 10);

    // Both baselines recorded in the sampler state (MCP-01).
    expect(samplerState.baselinePerByteDoge).toBe(SLOPE);
    expect(samplerState.baselineTotalDoge).toBeCloseTo(FIXED + SLOPE * 550, 10);
    expect(samplerState.baselineBytes).toBe(550);

    const quote = quoteFee(model, 500, 2_000_000_000_000n);
    expect(quote.fixedDoge).toBe('0.040000');
    expect(quote.ratioVsBaseline).toBe(1);
    expect(quote.totalRatioVsBaseline).toBeCloseTo(1, 1);
    expect(quote.regimeShift).toBe(false);
    expect(() => assertFeeRegime(quote)).not.toThrow();
  });

  it('12x-spike receipts are outlier-rejected before fitting; the batch still passes', () => {
    // 8 clean samples + 2 receipts carrying ~12x total fees (the documented
    // historical spike shape). They must not swing the fit (MCP-02) and the
    // remaining inliers must still establish a healthy regime.
    const spiked: L1Sample[] = [
      { bytes: 300, l1Doge: 12 * (FIXED + SLOPE * 300) },
      { bytes: 400, l1Doge: 12 * (FIXED + SLOPE * 400) },
    ];
    const model = fitFeeModel([...baselineSamples(8), ...spiked], {});
    expect(model.sampleCount).toBe(8); // the two spike receipts were rejected
    expect(model.perByteDoge).toBeCloseTo(SLOPE, 10);

    const quote = quoteFee(model, 500, 0n);
    expect(quote.regimeShift).toBe(false);
    expect(() => assertFeeRegime(quote)).not.toThrow();
  });

  it('pure fixed-fee spike (10x fixed, slope unchanged) trips the TOTAL guard only (MCP-01)', () => {
    const model = fitFeeModel(fixedSpikeSamples(10, 10), {});
    // The slope guard sees a perfectly normal rate — this is the regime the
    // old rule missed entirely.
    expect(model.perByteDoge).toBeCloseTo(SLOPE, 10);
    const quote = quoteFee(model, 500, 0n);
    expect(quote.ratioVsBaseline).toBe(1);
    expect(quote.totalRatioVsBaseline).toBeGreaterThan(2);

    let message = '';
    try {
      assertFeeRegime(quote);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/fee regime shift/);
    expect(message).toMatch(/median total L1 fee/);
    expect(message).not.toMatch(/per-byte rate is/);
  });

  it('slope spike (3x per-byte) trips the SLOPE guard', () => {
    const model = fitFeeModel(slopeSpikeSamples(10, 3), {});
    const quote = quoteFee(model, 500, 0n);
    expect(quote.ratioVsBaseline).toBe(3);
    expect(quote.regimeShift).toBe(true);
    expect(() => assertFeeRegime(quote)).toThrow(/per-byte rate .* is 3x/);
  });

  it('fails closed when fewer than 8 inlier samples are available', () => {
    expect(() => fitFeeModel(baselineSamples(5), {})).toThrow(/insufficient stable samples/);
  });

  it('outlier rejection that starves the batch below 8 inliers also fails closed', () => {
    // 7 clean + 2 twelve-x spike receipts: spikes rejected, 7 inliers left.
    const spiked: L1Sample[] = [
      { bytes: 800, l1Doge: 12 * (FIXED + SLOPE * 800) },
      { bytes: 900, l1Doge: 12 * (FIXED + SLOPE * 900) },
    ];
    expect(() => fitFeeModel([...baselineSamples(7), ...spiked], {})).toThrow(/insufficient stable samples \(7 of 9/);
  });

  it('fails closed on a non-positive fitted slope instead of clamping to 0 (MCP-02)', () => {
    // 8 inliers with a negative size/fee correlation, all within 2.5x of the
    // median so the outlier filter keeps them — the old Math.max(0, perByte)
    // clamp would have zeroed the guard's ratio; the fit must fail closed.
    const descending: L1Sample[] = Array.from({ length: 8 }, (_, i) => ({
      bytes: 100 * (i + 1),
      l1Doge: 0.1 - 0.00005 * 100 * (i + 1),
    }));
    expect(() => fitFeeModel(descending, {})).toThrow(/insufficient stable samples .* not positive/);
  });

  it('fails closed when every sample has identical calldata size (slope unidentified)', () => {
    const identical: L1Sample[] = [0.05, 0.052, 0.054, 0.055, 0.056, 0.057, 0.058, 0.06].map((l1Doge) => ({
      bytes: 200,
      l1Doge,
    }));
    expect(() => fitFeeModel(identical, {})).toThrow(/insufficient stable samples .* identical calldata size/);
  });

  it('DOGEFOREX_BASELINE_TOTAL bakes in the total baseline', () => {
    const tight = { DOGEFOREX_BASELINE_TOTAL: '0.02' };
    const model = fitFeeModel(baselineSamples(10), tight);
    expect(model.baselineTotalDoge).toBe(0.02);
    expect(samplerState.baselineTotalDoge).toBe(0.02);
    const quote = quoteFee(model, 500, 0n);
    expect(quote.totalRatioVsBaseline).toBeGreaterThan(2);
    expect(() => assertFeeRegime(quote)).toThrow(/median total L1 fee/);

    // And a generous baked-in baseline keeps the same batch healthy.
    resetSamplerState();
    const relaxed = fitFeeModel(baselineSamples(10), { DOGEFOREX_BASELINE_TOTAL: '0.5' });
    expect(() => assertFeeRegime(quoteFee(relaxed, 500, 0n))).not.toThrow();
  });

  it('rejects a malformed DOGEFOREX_BASELINE_TOTAL', () => {
    expect(() => fitFeeModel(baselineSamples(10), { DOGEFOREX_BASELINE_TOTAL: 'abc' })).toThrow(
      /DOGEFOREX_BASELINE_TOTAL/,
    );
    expect(() => fitFeeModel(baselineSamples(10), { DOGEFOREX_BASELINE_TOTAL: '-1' })).toThrow(
      /DOGEFOREX_BASELINE_TOTAL/,
    );
  });

  it('recorded baseline total is reused across batches once derived', () => {
    fitFeeModel(baselineSamples(10), {});
    const derived = samplerState.baselineTotalDoge;
    expect(derived).not.toBeNull();
    // Second batch with a different size mix reuses the recorded baseline.
    fitFeeModel(baselineSamples(8).concat([{ bytes: 4000, l1Doge: FIXED + SLOPE * 4000 }]), {});
    expect(samplerState.baselineTotalDoge).toBe(derived);
  });

  it('rejectOutliers drops both directions beyond 2.5x the running median', () => {
    const samples = baselineSamples(8);
    const high = { bytes: 500, l1Doge: 5 * (FIXED + SLOPE * 500) };
    const low = { bytes: 600, l1Doge: (FIXED + SLOPE * 600) / 5 };
    const kept = rejectOutliers([...samples, high, low]);
    expect(kept).toHaveLength(8);
    expect(kept).not.toContain(high);
    expect(kept).not.toContain(low);
  });
});
