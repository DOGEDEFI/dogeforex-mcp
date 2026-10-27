import { getAddress } from 'ethers';
import { V2_CURRENCY_CODES, type V2CurrencyCode } from '@dogeforex/sdk/v2';

export function fixtureAddress(value: number | bigint): string {
  return getAddress(`0x${BigInt(value).toString(16).padStart(40, '0')}`);
}

export function fixtureHash(value: number): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

export interface V2FixtureOptions {
  code?: V2CurrencyCode;
  variant?: number;
  network?: string;
  chainId?: string;
}

export function makeV2LinkedData(options: V2FixtureOptions = {}): Record<string, unknown> {
  const code = options.code ?? 'USD';
  const variant = options.variant ?? 0;
  const base = variant * 100;
  const addresses = {
    deployer: fixtureAddress(base + 1),
    source: fixtureAddress(base + 2),
    Token: fixtureAddress(base + 10),
    Equity: fixtureAddress(base + 11),
    PositionFactory: fixtureAddress(base + 12),
    PositionRoller: fixtureAddress(base + 13),
    Savings: fixtureAddress(base + 14),
    MintingHub: fixtureAddress(base + 15),
    Bridge: fixtureAddress(base + 16),
  };
  return {
    schemaVersion: '2.0',
    network: options.network ?? 'synthetic-v2',
    chainId: options.chainId ?? '6281971',
    code,
    sourceEvidence: {
      address: addresses.source,
      decimals: 6,
      onchainDecimals: '6',
      decimalMultiplier: '1000000000000',
      bytecodeValidated: true,
      note: 'synthetic offline fixture',
    },
    rateEvidence: { code, leadratePPM: '20000', reviewedAt: 'synthetic' },
    constructorArgs: {
      TestUSDC: [],
      Token: ['864000', 'Synthetic Dollar', `s${code}`],
      Equity: [addresses.Token, 'Synthetic Dollar', `s${code}`],
      PositionFactory: [],
      PositionRoller: [addresses.Token],
      Savings: [addresses.Token, '20000'],
      MintingHub: [addresses.Token, addresses.Savings, addresses.PositionRoller, addresses.PositionFactory],
      Bridge: [addresses.source, addresses.Token, '1000000000000000000000000'],
    },
    addresses,
    transactions: {
      deployments: {
        TestUSDC: fixtureHash(1),
        Token: fixtureHash(2),
        Equity: fixtureHash(2),
        PositionFactory: fixtureHash(3),
        PositionRoller: fixtureHash(4),
        Savings: fixtureHash(5),
        MintingHub: fixtureHash(6),
        Bridge: fixtureHash(7),
      },
      initialize: {
        Savings: fixtureHash(8),
        PositionFactory: fixtureHash(9),
        PositionRoller: fixtureHash(10),
        MintingHub: fixtureHash(11),
        Bridge: fixtureHash(12),
      },
      sourceFunding: fixtureHash(13),
      sourceApproval: fixtureHash(14),
      bridgeMint: fixtureHash(15),
      equityInvestment: fixtureHash(16),
    },
    postconditions: {
      complete: true,
      exactlyFiveGenesisMinters: true,
      initialLeadratePPM: '20000',
      localTokenSupply: '100000000000000000000',
    },
  };
}

export function makeV2Artifact(options: V2FixtureOptions = {}): Record<string, unknown> {
  const linkedData = makeV2LinkedData(options);
  const addresses = linkedData.addresses as Record<string, string>;
  return {
    address: addresses.Token,
    abi: [],
    transactionHash: fixtureHash(16),
    receipt: { blockNumber: 123, status: 1 },
    linkedData,
  };
}

export function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const SECOND_CODE: V2CurrencyCode = V2_CURRENCY_CODES[1];
