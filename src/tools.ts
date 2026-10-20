import { Interface, getAddress, type TransactionReceipt } from 'ethers';
import { z } from 'zod';
import {
  GUARDIAN_TIMELOCK_ABI,
  MINTING_HUB_ABI,
  POSITION_ABI,
  attachGuardianTimelock,
  attachMintingHub,
  attachPosition,
  attachToken,
  createClient,
  formatDoge,
  formatPPM,
  formatStable,
  formatTimestamp,
  formatUnits,
  parseStable,
  parseUnits,
  totalTxFee,
  type CurrencyCode,
  type DogeForexClient,
  type InstanceDescriptor,
  type OpenPositionParams,
  type PositionState,
} from '@dogeforex/sdk';
import type { McpConfig } from './config.js';
import { requireCode, requireSigner } from './config.js';
import { assertFeeRegime, quoteFee, sampleFeeModel } from './fee-regime.js';
import type { FeeQuote } from './fee-regime.js';

export interface ToolDef {
  description: string;
  inputSchema: z.ZodRawShape;
  /** Args are already zod-parsed/validated (defaults applied). */
  handler: (args: any) => Promise<unknown>;
}

// Rough L2 execution-gas estimates per write tool. The L2 component is
// small vs the L1 data fee; eth_estimateGas needs a funded, authorized
// sender and reverts otherwise, so constants are used for quoting.
const GAS_ESTIMATE: Record<string, bigint> = {
  mint: 200_000n,
  launch_challenge: 500_000n,
  place_bid: 400_000n,
  open_position: 1_500_000n,
  guardian_pause: 100_000n,
  guardian_schedule_unpause: 100_000n,
  guardian_unpause: 100_000n,
};

const IFACE_HUB = new Interface(MINTING_HUB_ABI);
const IFACE_POS = new Interface(POSITION_ABI);
const IFACE_GUARDIAN = new Interface(GUARDIAN_TIMELOCK_ABI);

// ---------------------------------------------------------------------------
// argument schemas
// ---------------------------------------------------------------------------

const sCode = z.string().min(3).max(4).describe('Currency code: USD, EUR, JPY, GBP, AUD, CNY, BRL, PKR, BDT, INR, NGN');
const sAddress = z
  .string()
  .refine((v) => {
    try {
      getAddress(v);
      return true;
    } catch {
      return false;
    }
  }, 'must be a checksummed address');
const sAmount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'decimal string in human units, e.g. "3500"');
const sWhole = z.string().regex(/^\d+$/, 'integer (seconds) as a string');
const sPPM = z.string().regex(/^\d{1,7}$/, 'integer PPM as a string, e.g. "100000" = 10%');
const sDryRun = z.boolean().default(true).describe('true (default): staticCall only, no tx sent; false: send the transaction');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clientFor(config: McpConfig, raw: string): { client: DogeForexClient; code: CurrencyCode; instance: InstanceDescriptor } {
  const code = requireCode(config.registry, raw);
  const instance = config.registry.instances[code];
  return { client: createClient(instance, config.provider), code, instance };
}

async function feeFromReceipt(config: McpConfig, receipt: TransactionReceipt) {
  // L1-inclusive helper — never receipt.fee (L2-only on this chain).
  const { l2Fee, l1Fee, total } = await totalTxFee(config.provider, receipt.hash);
  return { l1FeeDoge: formatDoge(l1Fee), l2FeeDoge: formatDoge(l2Fee), totalFeeDoge: formatDoge(total) };
}

async function quoteWriteTx(config: McpConfig, populated: { data?: string }, gasEstimate: bigint): Promise<FeeQuote> {
  const model = await sampleFeeModel(config.provider);
  const feeData = await config.provider.getFeeData();
  const data = typeof populated.data === 'string' ? populated.data : '0x';
  return quoteFee(model, Math.max(0, (data.length - 2) / 2), gasEstimate * (feeData.gasPrice ?? 0n));
}

async function fmtPositionState(client: DogeForexClient, p: PositionState) {
  // Liquidation price carries (36 - collateral.decimals) decimals.
  const collateralDecimals = Number(await attachToken(p.collateral, client.provider).decimals());
  const priceDecimals = 36 - collateralDecimals;
  return {
    address: p.address,
    owner: p.owner,
    collateral: p.collateral,
    liquidationPrice: formatUnits(p.price, priceDecimals),
    limit: formatStable(p.limit),
    minted: formatStable(p.minted),
    availableForMinting: formatStable(p.availableForMinting),
    minimumCollateral: formatStable(p.minimumCollateral),
    challengedAmount: formatStable(p.challengedAmount),
    challengePeriodSeconds: p.challengePeriod.toString(),
    start: formatTimestamp(p.start),
    cooldownEnd: formatTimestamp(p.cooldown),
    expiration: formatTimestamp(p.expiration),
    original: p.original,
    isClosed: p.isClosed,
    reserveContributionPPM: `${p.reserveContribution.toString()} (${formatPPM(p.reserveContribution)}%)`,
    riskPremiumPPM: p.riskPremiumPPM.toString(),
    annualInterestPPM: p.annualInterestPPM.toString(),
  };
}

function eventPresent(receipt: TransactionReceipt, iface: Interface, name: string): boolean {
  for (const log of receipt.logs) {
    try {
      if (iface.parseLog(log)?.name === name) return true;
    } catch {
      // log from a foreign contract
    }
  }
  return false;
}

/** Representative calldata for fee_quote — same size class as the real call. */
function representativeCalldata(tool: string, instance: InstanceDescriptor): { to: string; data: string } {
  const amt = parseStable('1000');
  switch (tool) {
    case 'mint':
      return { to: instance.mintingHub, data: IFACE_POS.encodeFunctionData('mint', [instance.mintingHub, amt]) };
    case 'launch_challenge':
      return { to: instance.mintingHub, data: IFACE_HUB.encodeFunctionData('challenge', [instance.mintingHub, amt, amt]) };
    case 'place_bid':
      return { to: instance.mintingHub, data: IFACE_HUB.encodeFunctionData('bid', [1n, amt, false]) };
    case 'open_position':
      return {
        to: instance.mintingHub,
        data: IFACE_HUB.encodeFunctionData('openPosition', [
          instance.token, amt, amt, amt, 432_000, 31_536_000, 86_400, 0, parseStable('1'), 100_000,
        ]),
      };
    case 'guardian_pause':
      return { to: instance.guardianTimelock ?? instance.mintingHub, data: IFACE_GUARDIAN.encodeFunctionData('pause', []) };
    case 'guardian_schedule_unpause':
      return { to: instance.guardianTimelock ?? instance.mintingHub, data: IFACE_GUARDIAN.encodeFunctionData('scheduleUnpause', []) };
    case 'guardian_unpause':
      return { to: instance.guardianTimelock ?? instance.mintingHub, data: IFACE_GUARDIAN.encodeFunctionData('unpause', []) };
    default:
      throw new Error(`fee_quote: unknown write tool "${tool}" — have: ${Object.keys(GAS_ESTIMATE).join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// tool table
// ---------------------------------------------------------------------------

export function buildTools(config: McpConfig): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {
    // ------------------------------------------------------------- reads ---

    list_instances: {
      description:
        'List all DogeForex currency instances: token symbol/address, equity share price, total supply, ' +
        'minter reserve, and guardian paused state. Read-only; no signer required.',
      inputSchema: {},
      handler: async () => {
        const rows: Array<Record<string, unknown>> = [];
        for (const code of config.registry.codes) {
          const { client } = clientFor(config, code);
          const [supply, minterReserve, price, guardian] = await Promise.all([
            client.token.totalSupply(),
            client.token.minterReserve(),
            client.equity.price(),
            client.guardianState(),
          ]);
          rows.push({
            code,
            symbol: client.instance.symbol,
            token: client.instance.token,
            totalSupply: formatStable(supply),
            minterReserve: formatStable(minterReserve),
            // share price is 18-dec fixed point (SDK formatSharePrice divides by 1e3 — mis-scaled, not used)
            equityPrice: formatUnits(price, 18),
            guardianPaused: guardian.paused,
            admissionGatePaused: guardian.admissionGatePaused,
          });
        }
        return { chainId: config.registry.chainId, chainName: config.registry.chainName, count: rows.length, instances: rows };
      },
    },

    instance_state: {
      description:
        'Full snapshot of one instance: token supply/minterReserve/registered minters, equity price/shares, ' +
        'genesis bootstrap status, guardian + timelock state, and the MintingHub admission gate. Read-only.',
      inputSchema: { code: sCode },
      handler: async ({ code }: { code: string }) => {
        const { client, code: c, instance } = clientFor(config, code);
        const [token, equity, bootstrap, guardian] = await Promise.all([
          client.tokenState(),
          client.equityState(),
          client.bootstrapState(),
          client.guardianState(),
        ]);
        const minterCandidates = [
          instance.mintingHub,
          instance.positionFactory,
          instance.equity,
          instance.genesisBootstrap,
          ...(instance.positionRoller ? [instance.positionRoller] : []),
          ...(instance.savings ? [instance.savings] : []),
        ];
        const minters = (
          await Promise.all(
            minterCandidates.map(async (addr) => {
              const info = await client.minterInfo(addr);
              return info.isMinter ? { address: addr, validityStart: formatTimestamp(info.validityStart) } : null;
            }),
          )
        ).filter((m): m is { address: string; validityStart: string } => m !== null);
        return {
          code: c,
          currency: instance.currency,
          symbol: instance.symbol,
          contracts: {
            token: instance.token,
            equity: instance.equity,
            mintingHub: instance.mintingHub,
            positionFactory: instance.positionFactory,
            positionRoller: instance.positionRoller,
            savings: instance.savings,
            genesisBootstrap: instance.genesisBootstrap,
            guardianTimelock: instance.guardianTimelock,
          },
          token: {
            name: token.name,
            symbol: token.symbol,
            totalSupply: formatStable(token.totalSupply),
            minterReserve: formatStable(token.minterReserve),
            equity: token.equity,
            reserve: token.reserve,
          },
          minters,
          equity: {
            price: formatUnits(equity.price, 18),
            totalShares: formatStable(equity.totalShares),
            valuationFactor: equity.valuationFactor.toString(),
            minHoldingDurationSeconds: equity.minHoldingDuration.toString(),
          },
          bootstrap: {
            executed: bootstrap.executed,
            endTime: formatTimestamp(bootstrap.endTime),
            totalFloat: formatStable(bootstrap.totalFloat),
          },
          guardian: {
            guardian: guardian.guardian,
            paused: guardian.paused,
            timelockSeconds: guardian.timelockSeconds?.toString() ?? null,
            unpauseAvailableAt: guardian.unpauseAvailableAt != null ? formatTimestamp(guardian.unpauseAvailableAt) : null,
            admissionGatePaused: guardian.admissionGatePaused,
          },
        };
      },
    },

    position_state: {
      description:
        'Snapshot of one position: collateral, liquidation price, minting limit, minted, cooldown/mintable-at, ' +
        'plus derived current minting fee and reserve contribution. Read-only.',
      inputSchema: { code: sCode, positionAddress: sAddress },
      handler: async ({ code, positionAddress }: { code: string; positionAddress: string }) => {
        const { client } = clientFor(config, code);
        const position = getAddress(positionAddress);
        const [p, derived, mintable] = await Promise.all([
          client.positionState(position),
          client.positionDerived(position),
          client.isMintable(position),
        ]);
        return {
          code: requireCode(config.registry, code),
          ...(await fmtPositionState(client, p)),
          derived: {
            mintingFeePPM: derived.mintingFeePPM.toString(),
            mintingFeePercent: formatPPM(derived.mintingFeePPM),
            annualInterestPPM: derived.annualInterestPPM.toString(),
            reserveContributionPPM: derived.reserveContributionPPM.toString(),
            feeOn1000: formatStable(derived.feeFor(parseStable('1000'))),
            reserveOn1000: formatStable(derived.reserveFor(parseStable('1000'))),
          },
          isMintable: mintable,
        };
      },
    },

    list_challenges: {
      description:
        'Open challenges on an instance (optionally filtered to one position): deadline, size, challenger, active flag. Read-only.',
      inputSchema: { code: sCode, position: sAddress.optional() },
      handler: async ({ code, position }: { code: string; position?: string }) => {
        const { client } = clientFor(config, code);
        const filter = position ? getAddress(position) : null;
        const all = await client.listChallenges();
        const rows = all
          .filter((ch) => (filter ? ch.position.toLowerCase() === filter.toLowerCase() : true))
          .map((ch) => ({
            challengeNumber: ch.index.toString(),
            challenger: ch.challenger,
            position: ch.position,
            size: formatStable(ch.size),
            start: formatTimestamp(ch.start),
            deadline: formatTimestamp(ch.deadline),
            active: ch.active,
          }));
        return { code: requireCode(config.registry, code), count: rows.length, challenges: rows };
      },
    },

    fee_quote: {
      description:
        'Estimate the total tx fee (L1 data fee + L2 execution fee, DOGE) for one of the write tools on an instance, ' +
        'using the sampled L1 fee model. Reports the current per-byte rate vs the 7.1e-5 DOGE/B baseline with a ' +
        'regimeShift warning when it exceeds 2x. Read-only.',
      inputSchema: { code: sCode, tool: z.string().describe(`Write tool name: ${Object.keys(GAS_ESTIMATE).join(', ')}`) },
      handler: async ({ code, tool }: { code: string; tool: string }) => {
        const { code: c, instance } = clientFor(config, code);
        const calldata = representativeCalldata(tool, instance);
        const model = await sampleFeeModel(config.provider);
        const feeData = await config.provider.getFeeData();
        const gas = GAS_ESTIMATE[tool] ?? 150_000n;
        const quote = quoteFee(model, (calldata.data.length - 2) / 2, gas * (feeData.gasPrice ?? 0n));
        return {
          code: c,
          tool,
          gasEstimate: gas.toString(),
          feeModelSamples: model.sampleCount,
          note: 'L2 component uses a static per-tool gas estimate; L1 component is sampled from recent mined txs',
          ...quote,
        };
      },
    },

    // ------------------------------------------------------------- writes --

    mint: {
      description:
        'Mint stablecoins from a position (signer: DOGEFOREX_TREASURY_KEY). amount in human units. ' +
        'dryRun=true (default) runs staticCall only and reports the fee quote + projected deltas; ' +
        'dryRun=false sends, applies the 2x fee-regime abort rule, and reports the positionState delta ' +
        'and the actual L1-inclusive total fee.',
      inputSchema: { code: sCode, position: sAddress, amount: sAmount, dryRun: sDryRun },
      handler: async ({ code, position, amount, dryRun }: { code: string; position: string; amount: string; dryRun: boolean }) => {
        const signer = requireSigner(config, 'treasury', 'mint');
        const signerAddress = await signer.getAddress();
        const amountBase = parseStable(amount);
        const { client, code: c } = clientFor(config, code);
        const posAddr = getAddress(position);
        const pos = client.position(posAddr);
        const posW = attachPosition(posAddr, signer);
        const [before, derived] = await Promise.all([client.positionState(posAddr), client.positionDerived(posAddr)]);
        await posW.mint.staticCall(signerAddress, amountBase);
        const quote = await quoteWriteTx(config, await posW.mint.populateTransaction(signerAddress, amountBase), GAS_ESTIMATE.mint ?? 150_000n);
        if (dryRun) {
          const usable = await pos.getUsableMint(amountBase, false);
          return {
            tool: 'mint', code: c, dryRun: true, txSent: false, signerRole: 'treasury', signerAddress,
            staticCall: 'OK — mint would succeed',
            wouldHappen: {
              mintedDelta: formatStable(amountBase),
              availableForMintingDelta: `-${formatStable(amountBase)}`,
              targetReceives: formatStable(usable),
              mintingFeePPM: derived.mintingFeePPM.toString(),
            },
            position: await fmtPositionState(client, before),
            feeQuote: quote,
            feeRegimeShift: quote.regimeShift,
          };
        }
        assertFeeRegime(quote);
        const receipt = await client.mint(signer, posAddr, amountBase);
        const fee = await feeFromReceipt(config, receipt);
        const after = await client.positionState(posAddr);
        return {
          tool: 'mint', code: c, dryRun: false, txSent: true, signerRole: 'treasury', signerAddress,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          status: receipt.status ?? null,
          fee,
          positionDelta: {
            minted: { before: formatStable(before.minted), after: formatStable(after.minted), delta: formatStable(after.minted - before.minted) },
            availableForMinting: {
              before: formatStable(before.availableForMinting),
              after: formatStable(after.availableForMinting),
              delta: formatStable(after.availableForMinting - before.availableForMinting),
            },
          },
        };
      },
    },

    launch_challenge: {
      description:
        'Launch a challenge against a position (signer: DOGEFOREX_BOT_KEY). size in collateral units, bid in ' +
        'K9XXX units, both human units. Returns the challenge number from ChallengeStarted. dryRun=true (default) ' +
        'runs staticCall only.',
      inputSchema: { code: sCode, position: sAddress, size: sAmount, bid: sAmount, dryRun: sDryRun },
      handler: async ({ code, position, size, bid, dryRun }: { code: string; position: string; size: string; bid: string; dryRun: boolean }) => {
        const signer = requireSigner(config, 'bot', 'launch_challenge');
        const signerAddress = await signer.getAddress();
        const { client, code: c, instance } = clientFor(config, code);
        const posAddr = getAddress(position);
        const collateral = await client.position(posAddr).collateral();
        const collateralDecimals = Number(await attachToken(collateral, config.provider).decimals());
        const sizeBase = parseUnits(size, collateralDecimals);
        const bidBase = parseStable(bid);
        const hubW = attachMintingHub(instance.mintingHub, signer);
        await hubW.challenge.staticCall(posAddr, sizeBase, bidBase);
        const quote = await quoteWriteTx(config, await hubW.challenge.populateTransaction(posAddr, sizeBase, bidBase), GAS_ESTIMATE.launch_challenge ?? 400_000n);
        if (dryRun) {
          return {
            tool: 'launch_challenge', code: c, dryRun: true, txSent: false, signerRole: 'bot', signerAddress,
            staticCall: 'OK — challenge would succeed',
            wouldHappen: { position: posAddr, size, bid },
            feeQuote: quote,
            feeRegimeShift: quote.regimeShift,
          };
        }
        assertFeeRegime(quote);
        const result = await client.challenge(signer, posAddr, sizeBase, bidBase);
        const fee = await feeFromReceipt(config, result.receipt);
        return {
          tool: 'launch_challenge', code: c, dryRun: false, txSent: true, signerRole: 'bot', signerAddress,
          challengeNumber: result.number.toString(),
          txHash: result.txHash,
          blockNumber: result.receipt.blockNumber,
          status: result.receipt.status ?? null,
          fee,
        };
      },
    },

    place_bid: {
      description:
        'Bid on an open challenge (signer: DOGEFOREX_BOT_KEY). size in collateral units. Returns whether the bid ' +
        'closed the challenge (ChallengeSucceeded event presence). dryRun=true (default) runs staticCall only.',
      inputSchema: {
        code: sCode,
        challengeNumber: z.string().regex(/^\d+$/, 'integer challenge number'),
        size: sAmount,
        postpone: z.boolean().default(false).describe('postpone collateral return to the owner'),
        dryRun: sDryRun,
      },
      handler: async ({ code, challengeNumber, size, postpone, dryRun }: { code: string; challengeNumber: string; size: string; postpone: boolean; dryRun: boolean }) => {
        const signer = requireSigner(config, 'bot', 'place_bid');
        const signerAddress = await signer.getAddress();
        const { client, code: c, instance } = clientFor(config, code);
        const index = BigInt(challengeNumber);
        const challenge = await client.challengeInfo(index);
        const collateral = await client.position(challenge.position).collateral();
        const dec = Number(await attachToken(collateral, config.provider).decimals());
        const sizeBase = parseUnits(size, dec);
        const hubW = attachMintingHub(instance.mintingHub, signer);
        await hubW.bid.staticCall(index, sizeBase, postpone);
        const quote = await quoteWriteTx(config, await hubW.bid.populateTransaction(index, sizeBase, postpone), GAS_ESTIMATE.place_bid ?? 300_000n);
        if (dryRun) {
          return {
            tool: 'place_bid', code: c, dryRun: true, txSent: false, signerRole: 'bot', signerAddress,
            staticCall: 'OK — bid would succeed',
            challenge: { number: index.toString(), position: challenge.position, deadline: formatTimestamp(challenge.deadline), active: challenge.active },
            wouldHappen: { size, postpone },
            feeQuote: quote,
            feeRegimeShift: quote.regimeShift,
          };
        }
        assertFeeRegime(quote);
        const receipt = await client.bid(signer, index, sizeBase, postpone);
        const fee = await feeFromReceipt(config, receipt);
        return {
          tool: 'place_bid', code: c, dryRun: false, txSent: true, signerRole: 'bot', signerAddress,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          status: receipt.status ?? null,
          challengeClosed: eventPresent(receipt, IFACE_HUB, 'ChallengeSucceeded'),
          fee,
        };
      },
    },

    guardian_pause: {
      description: 'Pause the instance via the GuardianTimelock (signer: DOGEFOREX_GUARDIAN_KEY). dryRun=true (default) runs staticCall only.',
      inputSchema: { code: sCode, dryRun: sDryRun },
      handler: async ({ code, dryRun }: { code: string; dryRun: boolean }) => guardianTool(config, 'guardian_pause', code, dryRun),
    },

    guardian_schedule_unpause: {
      description: 'Schedule an unpause after the timelock (signer: DOGEFOREX_GUARDIAN_KEY). dryRun=true (default) runs staticCall only.',
      inputSchema: { code: sCode, dryRun: sDryRun },
      handler: async ({ code, dryRun }: { code: string; dryRun: boolean }) => guardianTool(config, 'guardian_schedule_unpause', code, dryRun),
    },

    guardian_unpause: {
      description: 'Execute the scheduled unpause once the timelock elapsed (signer: DOGEFOREX_GUARDIAN_KEY). dryRun=true (default) runs staticCall only.',
      inputSchema: { code: sCode, dryRun: sDryRun },
      handler: async ({ code, dryRun }: { code: string; dryRun: boolean }) => guardianTool(config, 'guardian_unpause', code, dryRun),
    },

    open_position: {
      description:
        'Open a minting position (signer: DOGEFOREX_TREASURY_KEY). minCollateral/initialCollateral in collateral ' +
        'units; minAmount = minting maximum in K9XXX units; liqPrice in K9XXX per collateral unit. ' +
        'Defaults: feePPM=0, initPeriodSeconds=432000 (5d), challengePeriodSeconds=86400 (1d), ' +
        'reserveContributionPPM=100000 (10%). Returns the new position address (from PositionOpened). ' +
        'dryRun=true (default) runs staticCall only and reports the would-be position address.',
      inputSchema: {
        code: sCode,
        collateralToken: sAddress,
        minAmount: sAmount.describe('minting maximum (limit), human K9XXX units'),
        minCollateral: sAmount,
        initialCollateral: sAmount,
        liqPrice: sAmount.describe('liquidation price in K9XXX per collateral unit'),
        durationSeconds: sWhole.describe('position duration in seconds'),
        feePPM: sPPM.optional(),
        initPeriodSeconds: sWhole.optional(),
        challengePeriodSeconds: sWhole.optional(),
        reserveContributionPPM: sPPM.optional(),
        dryRun: sDryRun,
      },
      handler: async (args: {
        code: string;
        collateralToken: string;
        minAmount: string;
        minCollateral: string;
        initialCollateral: string;
        liqPrice: string;
        durationSeconds: string;
        feePPM?: string;
        initPeriodSeconds?: string;
        challengePeriodSeconds?: string;
        reserveContributionPPM?: string;
        dryRun: boolean;
      }) => {
        const signer = requireSigner(config, 'treasury', 'open_position');
        const signerAddress = await signer.getAddress();
        const { client, code: c, instance } = clientFor(config, args.code);
        const collateral = getAddress(args.collateralToken);
        const collateralDecimals = Number(await attachToken(collateral, config.provider).decimals());
        const params: OpenPositionParams = {
          collateral,
          minCollateral: parseUnits(args.minCollateral, collateralDecimals),
          initialCollateral: parseUnits(args.initialCollateral, collateralDecimals),
          mintingMaximum: parseStable(args.minAmount),
          initPeriodSeconds: BigInt(args.initPeriodSeconds ?? 432_000),
          durationSeconds: BigInt(args.durationSeconds),
          challengePeriodSeconds: BigInt(args.challengePeriodSeconds ?? 86_400),
          riskPremiumPPM: BigInt(args.feePPM ?? 0),
          liqPrice: parseUnits(args.liqPrice, 36 - collateralDecimals),
          reserveContributionPPM: BigInt(args.reserveContributionPPM ?? 100_000),
        };
        await client.assertAdmissionsOpen();
        const hubW = attachMintingHub(instance.mintingHub, signer);
        const expected = (await hubW.openPosition.staticCall(
          params.collateral, params.minCollateral, params.initialCollateral, params.mintingMaximum,
          params.initPeriodSeconds, params.durationSeconds, params.challengePeriodSeconds,
          params.riskPremiumPPM, params.liqPrice, params.reserveContributionPPM,
        )) as string;
        const quote = await quoteWriteTx(
          config,
          await hubW.openPosition.populateTransaction(
            params.collateral, params.minCollateral, params.initialCollateral, params.mintingMaximum,
            params.initPeriodSeconds, params.durationSeconds, params.challengePeriodSeconds,
            params.riskPremiumPPM, params.liqPrice, params.reserveContributionPPM,
          ),
          GAS_ESTIMATE.open_position ?? 1_000_000n,
        );
        if (args.dryRun) {
          return {
            tool: 'open_position', code: c, dryRun: true, txSent: false, signerRole: 'treasury', signerAddress,
            staticCall: 'OK — openPosition would succeed',
            wouldBePositionAddress: expected,
            params: {
              collateral, collateralDecimals,
              minCollateral: args.minCollateral, initialCollateral: args.initialCollateral,
              mintingMaximum: args.minAmount, liqPrice: args.liqPrice,
              initPeriodSeconds: params.initPeriodSeconds.toString(),
              durationSeconds: params.durationSeconds.toString(),
              challengePeriodSeconds: params.challengePeriodSeconds.toString(),
              riskPremiumPPM: params.riskPremiumPPM.toString(),
              reserveContributionPPM: params.reserveContributionPPM.toString(),
            },
            feeQuote: quote,
            feeRegimeShift: quote.regimeShift,
          };
        }
        assertFeeRegime(quote);
        const result = await client.openPosition(signer, params);
        const fee = await feeFromReceipt(config, result.receipt);
        return {
          tool: 'open_position', code: c, dryRun: false, txSent: true, signerRole: 'treasury', signerAddress,
          position: result.position,
          txHash: result.txHash,
          blockNumber: result.receipt.blockNumber,
          status: result.receipt.status ?? null,
          fee,
        };
      },
    },
  };

  return tools;
}

// ---------------------------------------------------------------------------
// guardian write triad
// ---------------------------------------------------------------------------

async function guardianTool(config: McpConfig, tool: 'guardian_pause' | 'guardian_schedule_unpause' | 'guardian_unpause', rawCode: string, dryRun: boolean) {
  const signer = requireSigner(config, 'guardian', tool);
  const signerAddress = await signer.getAddress();
  const { client, code, instance } = clientFor(config, rawCode);
  if (!instance.guardianTimelock) {
    throw new Error(`${tool}: instance ${code} has no GuardianTimelock`);
  }
  const gt = attachGuardianTimelock(instance.guardianTimelock, signer);
  const method = tool === 'guardian_pause' ? gt.pause : tool === 'guardian_schedule_unpause' ? gt.scheduleUnpause : gt.unpause;
  await method.staticCall();
  const quote = await quoteWriteTx(config, await method.populateTransaction(), GAS_ESTIMATE[tool] ?? 100_000n);
  const guardianState = async () => {
    const g = await client.guardianState();
    return {
      paused: g.paused,
      unpauseAvailableAt: g.unpauseAvailableAt != null ? formatTimestamp(g.unpauseAvailableAt) : null,
      admissionGatePaused: g.admissionGatePaused,
    };
  };
  if (dryRun) {
    return {
      tool, code, dryRun: true, txSent: false, signerRole: 'guardian', signerAddress,
      staticCall: 'OK — call would succeed',
      guardianState: await guardianState(),
      feeQuote: quote,
      feeRegimeShift: quote.regimeShift,
    };
  }
  assertFeeRegime(quote);
  const receipt =
    tool === 'guardian_pause'
      ? await client.guardianPause(signer)
      : tool === 'guardian_schedule_unpause'
        ? await client.guardianScheduleUnpause(signer)
        : await client.guardianUnpause(signer);
  const fee = await feeFromReceipt(config, receipt);
  return {
    tool, code, dryRun: false, txSent: true, signerRole: 'guardian', signerAddress,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    status: receipt.status ?? null,
    guardianState: await guardianState(),
    fee,
  };
}
