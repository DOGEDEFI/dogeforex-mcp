import {
  getAddress,
  Interface,
  JsonRpcProvider,
  Network,
  ZeroAddress,
  type InterfaceAbi,
  type Result,
} from 'ethers';
import {
  V2_BRIDGE_ABI,
  V2_EQUITY_ABI,
  V2_ERC20_ABI,
  V2_MINTING_HUB_ABI,
  V2_POSITION_ABI,
  V2_POSITION_ROLLER_ABI,
  V2_SAVINGS_ABI,
  V2_TOKEN_ABI,
  V2Client,
  grossMintForUsable,
  OPENING_FEE,
  quoteFeePPM,
  quoteUsableMint,
  parseV2Registry,
  type V2InstanceDescriptor,
} from '@dogeforex/sdk/v2';
import { fixtureAddress, makeV2Artifact } from './v2-fixtures.js';

type Handler = (args: Result, blockTag: string) => unknown[] | Promise<unknown[]>;

export class MockRpcRevert extends Error {
  readonly data: string;

  constructor(data: string) {
    super('execution reverted');
    this.data = data;
  }
}

export class OfflineRpcProvider extends JsonRpcProvider {
  readonly chain: number;
  blockNumber: number;
  blockTimestamp: bigint;
  readonly calls: Array<{ to: string; signature: string; blockTag: string }> = [];

  private readonly interfaces = new Map<string, Interface>();
  private readonly handlers = new Map<string, Handler>();
  private readonly bytecode = new Map<string, string>();

  constructor(chainId: number, blockTimestamp = 1_800_000_000n) {
    super('http://offline.invalid', Network.from(chainId), {
      staticNetwork: true,
      batchMaxCount: 1,
      cacheTimeout: -1,
    });
    this.chain = chainId;
    this.blockNumber = 123;
    this.blockTimestamp = blockTimestamp;
  }

  setCode(address: string, code = '0x6000'): void {
    this.bytecode.set(address.toLowerCase(), code);
  }

  on(address: string, abi: InterfaceAbi, signature: string, values: unknown[]): void {
    this.onCall(address, abi, signature, () => values);
  }

  onCall(address: string, abi: InterfaceAbi, signature: string, handler: Handler): void {
    const key = address.toLowerCase();
    const iface = this.interfaces.get(key) ?? new Interface(abi);
    this.interfaces.set(key, iface);
    const fragment = iface.getFunction(signature);
    if (!fragment) throw new Error(`mock: unknown function ${signature}`);
    this.handlers.set(`${key}:${fragment.selector}`, handler);
  }

  setBlock(timestamp: bigint): void {
    this.blockTimestamp = timestamp;
    this.blockNumber += 1;
  }

  override async send(method: string, params: unknown[]): Promise<unknown> {
    if (method === 'eth_chainId') return `0x${this.chain.toString(16)}`;
    if (method === 'eth_getBlockByNumber') return this.block();
    if (method === 'eth_getCode') {
      const [address] = params as [string, string];
      return this.bytecode.get(address.toLowerCase()) ?? '0x';
    }
    if (method === 'eth_call') {
      const [transaction, blockTag] = params as [{ to: string; data: string }, string];
      return this.handleCall(transaction.to, transaction.data, blockTag);
    }
    throw new Error(`offline mock: unexpected JSON-RPC method ${method}`);
  }

  private async handleCall(to: string, data: string, blockTag: string): Promise<string> {
    const key = to.toLowerCase();
    const iface = this.interfaces.get(key);
    if (!iface) throw new Error(`offline mock: no ABI registered for ${to}`);
    const fragment = iface.getFunction(data.slice(0, 10));
    if (!fragment) throw new Error(`offline mock: no function for selector ${data.slice(0, 10)}`);
    const handler = this.handlers.get(`${key}:${fragment.selector}`);
    if (!handler) throw new Error(`offline mock: no handler for ${fragment.format()} at ${to}`);
    const args = iface.decodeFunctionData(fragment, data);
    this.calls.push({ to: getAddress(to), signature: fragment.format(), blockTag });
    const values = await handler(args, blockTag);
    return iface.encodeFunctionResult(fragment, values);
  }

  private block(): Record<string, unknown> {
    const zeros32 = `0x${'00'.repeat(32)}`;
    return {
      number: `0x${this.blockNumber.toString(16)}`,
      hash: `0x${this.blockNumber.toString(16).padStart(64, '0')}`,
      parentHash: zeros32,
      timestamp: `0x${this.blockTimestamp.toString(16)}`,
      nonce: '0x0000000000000000',
      difficulty: '0x0',
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
      miner: ZeroAddress,
      extraData: '0x',
      baseFeePerGas: '0x0',
      receiptsRoot: zeros32,
      sha3Uncles: zeros32,
      stateRoot: zeros32,
      transactionsRoot: zeros32,
      logsBloom: `0x${'00'.repeat(256)}`,
      transactions: [],
    };
  }
}

export interface ProtocolMockState {
  currentRatePPM: bigint;
  nextRatePPM: bigint;
  nextChange: bigint;
  currentTicks: bigint;
  interestDelay: bigint;
  savingsSaved: bigint;
  savingsTicks: bigint;
  accruedInterest: bigint;
  tokenSupply: bigint;
  minterReserve: bigint;
  currentReserve: bigint;
  equityAmount: bigint;
  fullRepaymentCandidate: bigint;
  collateralDecimals: bigint;
  collateralBalance: bigint;
  collateralFunderBalance: bigint;
  collateralAllowance: bigint;
  owner: string;
  price: bigint;
  limit: bigint;
  minted: bigint;
  minimumCollateral: bigint;
  challengedAmount: bigint;
  challengePeriod: bigint;
  start: bigint;
  cooldown: bigint;
  expiration: bigint;
  closed: boolean;
  reserveContributionPPM: bigint;
  riskPremiumPPM: bigint;
  availableForMinting: bigint;
  availableForClones: bigint;
  expiredPurchasePrice: bigint;
  bridgeLimit: bigint;
  bridgeMinted: bigint;
  bridgeHorizon: bigint;
  bridgeCredit: bigint;
  sourceLocked: bigint;
  sourceBalance: bigint;
  sourceAllowance: bigint;
  localBalance: bigint;
  totalShares: bigint;
  sharePrice: bigint;
  shares: bigint;
  canRedeem: boolean;
  holdingDuration: bigint;
  ownVotes: bigint;
  helperVotes: bigint;
  totalVotes: bigint;
  challengeStart: bigint;
  challengeSize: bigint;
  challengeActive: boolean;
}

export function makeProtocolMock(chainId = 6_281_971): {
  provider: OfflineRpcProvider;
  client: V2Client;
  instance: V2InstanceDescriptor;
  state: ProtocolMockState;
  positionAddress: string;
  collateralAddress: string;
  caller: string;
  helper: string;
} {
  const instance = parseV2Registry(makeV2Artifact()).instances.USD;
  if (!instance) throw new Error('fixture USD missing');
  const provider = new OfflineRpcProvider(chainId);
  const now = provider.blockTimestamp;
  const positionAddress = fixtureAddress(700);
  const collateralAddress = fixtureAddress(500);
  const caller = fixtureAddress(600);
  const helper = fixtureAddress(601);
  const state: ProtocolMockState = {
    currentRatePPM: 20_000n,
    nextRatePPM: 20_000n,
    nextChange: now,
    currentTicks: 123_456n,
    interestDelay: 3n * 86_400n,
    savingsSaved: 500n * 10n ** 18n,
    savingsTicks: 123_000n,
    accruedInterest: 7n * 10n ** 18n,
    tokenSupply: 10_000n * 10n ** 18n,
    minterReserve: 200n * 10n ** 18n,
    currentReserve: 250n * 10n ** 18n,
    equityAmount: 50n * 10n ** 18n,
    fullRepaymentCandidate: 800n * 10n ** 18n,
    collateralDecimals: 6n,
    collateralBalance: 10_000n * 10n ** 6n,
    collateralFunderBalance: 10_000n * 10n ** 6n,
    collateralAllowance: 10_000n * 10n ** 6n,
    owner: caller,
    price: 2n * 10n ** 30n,
    limit: 100_000n * 10n ** 18n,
    minted: 1_000n * 10n ** 18n,
    minimumCollateral: 3_500n * 10n ** 6n,
    challengedAmount: 0n,
    challengePeriod: 86_400n,
    start: now - 1_000n,
    cooldown: now - 1n,
    expiration: now + 30n * 86_400n,
    closed: false,
    reserveContributionPPM: 200_000n,
    riskPremiumPPM: 5_000n,
    availableForMinting: 50_000n * 10n ** 18n,
    availableForClones: 20_000n * 10n ** 18n,
    expiredPurchasePrice: 20n * 10n ** 30n,
    bridgeLimit: 100_000n * 10n ** 18n,
    bridgeMinted: 40_000n * 10n ** 18n,
    bridgeHorizon: now + 1_000n,
    bridgeCredit: 40_000_000n,
    sourceLocked: 40_000_000_000n,
    sourceBalance: 5_000_000_000n,
    sourceAllowance: 5_000_000_000n,
    localBalance: 5_000n * 10n ** 18n,
    totalShares: 1_000n * 10n ** 18n,
    sharePrice: 3n * 10n ** 17n,
    shares: 100n * 10n ** 18n,
    canRedeem: true,
    holdingDuration: 100n * 86_400n,
    ownVotes: 0n,
    helperVotes: 0n,
    totalVotes: 0n,
    challengeStart: now - 10n,
    challengeSize: 100n * 10n ** 6n,
    challengeActive: false,
  };

  for (const address of [
    instance.source,
    instance.token,
    instance.equity,
    instance.positionFactory,
    instance.positionRoller,
    instance.savings,
    instance.mintingHub,
    instance.bridge,
    positionAddress,
    collateralAddress,
  ]) provider.setCode(address);

  const annualRate = () => state.currentRatePPM + state.riskPremiumPPM;
  const currentFee = () => quoteFeePPM(state.expiration, state.start, provider.blockTimestamp, annualRate());
  const adjustedReserve = (reservePPM: bigint): bigint => state.currentReserve < state.minterReserve
    ? (reservePPM * state.currentReserve) / state.minterReserve
    : reservePPM;
  const freedAmount = (amount: bigint, reservePPM: bigint): bigint =>
    (1_000_000n * amount) / (1_000_000n - adjustedReserve(reservePPM));
  const assignedReserve = (amount: bigint, reservePPM: bigint): bigint => {
    const theoretical = (reservePPM * amount) / 1_000_000n;
    return state.currentReserve < state.minterReserve
      ? (theoretical * state.currentReserve) / state.minterReserve
      : theoretical;
  };

  provider.on(instance.token, V2_TOKEN_ABI, 'name()', [instance.name]);
  provider.on(instance.token, V2_TOKEN_ABI, 'symbol()', [instance.symbol]);
  provider.on(instance.token, V2_TOKEN_ABI, 'decimals()', [18n]);
  provider.onCall(instance.token, V2_TOKEN_ABI, 'totalSupply()', () => [state.tokenSupply]);
  provider.onCall(instance.token, V2_TOKEN_ABI, 'minterReserve()', () => [state.minterReserve]);
  provider.onCall(instance.token, V2_TOKEN_ABI, 'equity()', () => [state.equityAmount]);
  provider.on(instance.token, V2_TOKEN_ABI, 'reserve()', [instance.equity]);
  provider.on(instance.token, V2_TOKEN_ABI, 'MIN_APPLICATION_PERIOD()', [instance.minApplicationPeriod]);
  provider.on(instance.token, V2_TOKEN_ABI, 'MIN_FEE()', [OPENING_FEE]);
  provider.onCall(instance.token, V2_TOKEN_ABI, 'balanceOf(address)', (args) => {
    const account = getAddress(args[0]);
    if (account === instance.equity) return [state.currentReserve];
    return [account === caller ? state.localBalance : 0n];
  });
  provider.onCall(instance.token, V2_TOKEN_ABI, 'allowance(address,address)', (args) => {
    return [getAddress(args[0]) === caller && getAddress(args[1]) === positionAddress ? 1n << 255n : 0n];
  });
  provider.onCall(instance.token, V2_TOKEN_ABI, 'getPositionParent(address)', (args) => {
    return [getAddress(args[0]) === positionAddress ? instance.mintingHub : ZeroAddress];
  });
  provider.onCall(instance.token, V2_TOKEN_ABI, 'positions(address)', (args) => {
    return [getAddress(args[0]) === positionAddress ? instance.mintingHub : ZeroAddress];
  });
  provider.on(instance.token, V2_TOKEN_ABI, 'minters(address)', [now - 100n]);
  provider.on(instance.token, V2_TOKEN_ABI, 'isMinter(address)', [true]);
  provider.onCall(instance.token, V2_TOKEN_ABI, 'calculateFreedAmount(uint256,uint32)', (args) => {
    return [freedAmount(BigInt(args[0]), BigInt(args[1]))];
  });
  provider.onCall(instance.token, V2_TOKEN_ABI, 'calculateAssignedReserve(uint256,uint32)', (args) => {
    return [assignedReserve(BigInt(args[0]), BigInt(args[1]))];
  });

  provider.on(instance.source, V2_ERC20_ABI, 'name()', ['Synthetic Source']);
  provider.on(instance.source, V2_ERC20_ABI, 'symbol()', ['sUSDC']);
  provider.on(instance.source, V2_ERC20_ABI, 'decimals()', [6n]);
  provider.on(instance.source, V2_ERC20_ABI, 'totalSupply()', [100_000_000_000n]);
  provider.onCall(instance.source, V2_ERC20_ABI, 'balanceOf(address)', (args) => {
    const account = getAddress(args[0]);
    return [account === instance.bridge ? state.sourceLocked : account === caller ? state.sourceBalance : 0n];
  });
  provider.onCall(instance.source, V2_ERC20_ABI, 'allowance(address,address)', (args) => {
    return [getAddress(args[0]) === caller && getAddress(args[1]) === instance.bridge ? state.sourceAllowance : 0n];
  });

  provider.on(instance.mintingHub, V2_MINTING_HUB_ABI, 'OPENING_FEE()', [OPENING_FEE]);
  provider.on(instance.mintingHub, V2_MINTING_HUB_ABI, 'CHALLENGER_REWARD()', [20_000n]);
  provider.on(instance.mintingHub, V2_MINTING_HUB_ABI, 'EXPIRED_PRICE_FACTOR()', [10n]);
  provider.on(instance.mintingHub, V2_MINTING_HUB_ABI, 'ofd()', [instance.token]);
  provider.on(instance.mintingHub, V2_MINTING_HUB_ABI, 'rate()', [instance.savings]);
  provider.on(instance.mintingHub, V2_MINTING_HUB_ABI, 'roller()', [instance.positionRoller]);
  provider.onCall(instance.mintingHub, V2_MINTING_HUB_ABI, 'expiredPurchasePrice(address)', () => [state.expiredPurchasePrice]);
  provider.onCall(instance.mintingHub, V2_MINTING_HUB_ABI, 'challenges(uint256)', () => [
    state.challengeActive ? helper : ZeroAddress,
    state.challengeActive ? state.challengeStart : 0n,
    state.challengeActive ? positionAddress : ZeroAddress,
    state.challengeActive ? state.challengeSize : 0n,
  ]);
  provider.onCall(instance.mintingHub, V2_MINTING_HUB_ABI, 'price(uint32)', () => [state.challengeActive ? state.price : 0n]);
  provider.on(instance.mintingHub, V2_MINTING_HUB_ABI, 'pendingReturns(address,address)', [0n]);

  provider.onCall(instance.positionRoller, V2_POSITION_ROLLER_ABI, 'findRepaymentAmount(address)', () => {
    return state.minted === 0n ? [0n] : [state.fullRepaymentCandidate];
  });

  provider.onCall(positionAddress, V2_POSITION_ABI, 'owner()', () => [state.owner]);
  provider.on(positionAddress, V2_POSITION_ABI, 'collateral()', [collateralAddress]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'price()', () => [state.price]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'limit()', () => [state.limit]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'minted()', () => [state.minted]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'minimumCollateral()', () => [state.minimumCollateral]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'challengedAmount()', () => [state.challengedAmount]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'challengeData()', () => [state.price, state.challengePeriod]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'challengePeriod()', () => [state.challengePeriod]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'start()', () => [state.start]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'cooldown()', () => [state.cooldown]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'expiration()', () => [state.expiration]);
  provider.on(positionAddress, V2_POSITION_ABI, 'original()', [positionAddress]);
  provider.on(positionAddress, V2_POSITION_ABI, 'hub()', [instance.mintingHub]);
  provider.on(positionAddress, V2_POSITION_ABI, 'ofd()', [instance.token]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'isClosed()', () => [state.closed]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'reserveContribution()', () => [state.reserveContributionPPM]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'riskPremiumPPM()', () => [state.riskPremiumPPM]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'annualInterestPPM()', () => [annualRate()]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'availableForMinting()', () => [state.availableForMinting]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'availableForClones()', () => [state.availableForClones]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'calculateCurrentFee()', () => [currentFee()]);
  provider.onCall(positionAddress, V2_POSITION_ABI, 'calculateFee(uint256)', (args) => {
    return [quoteFeePPM(BigInt(args[0]), state.start, provider.blockTimestamp, annualRate())];
  });
  provider.onCall(positionAddress, V2_POSITION_ABI, 'getUsableMint(uint256,bool)', (args) => {
    const fee = Boolean(args[1]) ? currentFee() : 0n;
    return [quoteUsableMint(BigInt(args[0]), state.reserveContributionPPM, fee).usableAmount];
  });
  provider.onCall(positionAddress, V2_POSITION_ABI, 'getMintAmount(uint256)', (args) => {
    return [grossMintForUsable(BigInt(args[0]), state.reserveContributionPPM, currentFee())];
  });

  provider.on(collateralAddress, V2_ERC20_ABI, 'name()', ['Synthetic Collateral']);
  provider.on(collateralAddress, V2_ERC20_ABI, 'symbol()', ['sCOL']);
  provider.onCall(collateralAddress, V2_ERC20_ABI, 'decimals()', () => [state.collateralDecimals]);
  provider.on(collateralAddress, V2_ERC20_ABI, 'totalSupply()', [1_000_000n * 10n ** 6n]);
  provider.onCall(collateralAddress, V2_ERC20_ABI, 'balanceOf(address)', (args) => {
    const account = getAddress(args[0]);
    return [account === positionAddress ? state.collateralBalance : account === caller ? state.collateralFunderBalance : 0n];
  });
  provider.onCall(collateralAddress, V2_ERC20_ABI, 'allowance(address,address)', (args) => {
    return [getAddress(args[0]) === caller && getAddress(args[1]) === instance.mintingHub ? state.collateralAllowance : 0n];
  });

  provider.on(instance.bridge, V2_BRIDGE_ABI, 'usd()', [instance.source]);
  provider.on(instance.bridge, V2_BRIDGE_ABI, 'ofd()', [instance.token]);
  provider.on(instance.bridge, V2_BRIDGE_ABI, 'decimalMultiplier()', [10n ** 12n]);
  provider.onCall(instance.bridge, V2_BRIDGE_ABI, 'limit()', () => [state.bridgeLimit]);
  provider.onCall(instance.bridge, V2_BRIDGE_ABI, 'minted()', () => [state.bridgeMinted]);
  provider.onCall(instance.bridge, V2_BRIDGE_ABI, 'horizon()', () => [state.bridgeHorizon]);
  provider.onCall(instance.bridge, V2_BRIDGE_ABI, 'credits(address)', () => [state.bridgeCredit]);
  provider.onCall(instance.bridge, V2_BRIDGE_ABI, 'balanceOf(address)', () => [state.bridgeCredit]);

  provider.on(instance.savings, V2_SAVINGS_ABI, 'ofd()', [instance.token]);
  provider.on(instance.savings, V2_SAVINGS_ABI, 'equity()', [instance.equity]);
  provider.onCall(instance.savings, V2_SAVINGS_ABI, 'currentRatePPM()', () => [state.currentRatePPM]);
  provider.onCall(instance.savings, V2_SAVINGS_ABI, 'nextRatePPM()', () => [state.nextRatePPM]);
  provider.onCall(instance.savings, V2_SAVINGS_ABI, 'nextChange()', () => [state.nextChange]);
  provider.onCall(instance.savings, V2_SAVINGS_ABI, 'currentTicks()', () => [state.currentTicks]);
  provider.onCall(instance.savings, V2_SAVINGS_ABI, 'INTEREST_DELAY()', () => [state.interestDelay]);
  provider.onCall(instance.savings, V2_SAVINGS_ABI, 'savings(address)', () => [state.savingsSaved, state.savingsTicks]);
  provider.onCall(instance.savings, V2_SAVINGS_ABI, 'accruedInterest(address,uint256)', () => [state.accruedInterest]);
  provider.onCall(instance.savings, V2_SAVINGS_ABI, 'accruedInterest(address)', () => [state.accruedInterest]);
  provider.onCall(instance.savings, V2_SAVINGS_ABI, 'ticks(uint256)', () => [state.currentTicks]);

  provider.on(instance.equity, V2_EQUITY_ABI, 'name()', [`${instance.name} Pool Share`]);
  provider.on(instance.equity, V2_EQUITY_ABI, 'symbol()', [`${instance.symbol}PS`]);
  provider.on(instance.equity, V2_EQUITY_ABI, 'decimals()', [18n]);
  provider.onCall(instance.equity, V2_EQUITY_ABI, 'totalSupply()', () => [state.totalShares]);
  provider.onCall(instance.equity, V2_EQUITY_ABI, 'price()', () => [state.sharePrice]);
  provider.on(instance.equity, V2_EQUITY_ABI, 'ofd()', [instance.token]);
  provider.on(instance.equity, V2_EQUITY_ABI, 'VALUATION_FACTOR()', [3n]);
  provider.on(instance.equity, V2_EQUITY_ABI, 'MIN_HOLDING_DURATION()', [90n * 86_400n << 20n]);
  provider.onCall(instance.equity, V2_EQUITY_ABI, 'balanceOf(address)', () => [state.shares]);
  provider.onCall(instance.equity, V2_EQUITY_ABI, 'canRedeem(address)', () => [state.canRedeem]);
  provider.onCall(instance.equity, V2_EQUITY_ABI, 'holdingDuration(address)', () => [state.holdingDuration]);
  provider.onCall(instance.equity, V2_EQUITY_ABI, 'votes(address)', (args) => {
    return [getAddress(args[0]) === caller ? state.ownVotes : getAddress(args[0]) === helper ? state.helperVotes : 0n];
  });
  provider.onCall(instance.equity, V2_EQUITY_ABI, 'totalVotes()', () => [state.totalVotes]);
  provider.onCall(instance.equity, V2_EQUITY_ABI, 'votesDelegated(address,address[])', (args) => {
    const helpers = args[1] as string[];
    const extra = helpers.includes(caller) || helpers.includes(helper) ? state.helperVotes : 0n;
    return [state.ownVotes + extra];
  });
  provider.onCall(instance.equity, V2_EQUITY_ABI, 'relativeVotes(address)', () => {
    if (state.totalVotes === 0n) throw new Error('division by zero');
    return [state.ownVotes * 10n ** 18n / state.totalVotes];
  });
  provider.on(instance.equity, V2_EQUITY_ABI, 'delegates(address)', [ZeroAddress]);
  provider.onCall(instance.equity, V2_EQUITY_ABI, 'calculateShares(uint256)', (args) => [BigInt(args[0]) * 10n]);
  provider.onCall(instance.equity, V2_EQUITY_ABI, 'calculateProceeds(uint256)', (args) => [BigInt(args[0]) * 2n]);
  const equityInterface = new Interface(V2_EQUITY_ABI);
  provider.onCall(instance.equity, V2_EQUITY_ABI, 'checkQualified(address,address[])', (args) => {
    const helpers = args[1] as string[];
    const delegated = state.ownVotes + (helpers.includes(caller) || helpers.includes(helper) ? state.helperVotes : 0n);
    if (delegated * 10_000n <= 200n * state.totalVotes) {
      throw new MockRpcRevert(equityInterface.encodeErrorResult('NotQualified'));
    }
    return [];
  });

  const client = new V2Client(instance, provider);
  return { provider, client, instance, state, positionAddress, collateralAddress, caller, helper };
}
