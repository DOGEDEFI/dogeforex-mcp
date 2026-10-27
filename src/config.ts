import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { JsonRpcProvider, Wallet } from 'ethers';
import {
  CURRENCY_CODES,
  parseRegistry,
  type CurrencyCode,
  type Registry,
} from '@dogeforex/sdk';
import {
  detectProtocolRegistry,
  V2_CURRENCY_CODES,
  type V2CurrencyCode,
  type V2Registry,
} from '@dogeforex/sdk/v2';
import { loadProtocolRegistry } from '@dogeforex/sdk/v2/node';

export const DEFAULT_RPC_URL = 'https://rpc.testnet.dogeos.com';
export const DEFAULT_REGISTRY_PATH = '../dogeforex-protocol/deployments/k9usd.chikyu.json';

export type Role = 'deployer' | 'treasury' | 'guardian' | 'bot';

/** Env var holding the hex private key for each signer role. Never logged. */
export const ROLE_ENV: Record<Role, string> = {
  deployer: 'DOGEFOREX_DEPLOYER_KEY',
  treasury: 'DOGEFOREX_TREASURY_KEY',
  guardian: 'DOGEFOREX_GUARDIAN_KEY',
  bot: 'DOGEFOREX_BOT_KEY',
};

interface McpConfigBase {
  rpcUrl: string;
  registryPath: string;
  provider: JsonRpcProvider;
  network: string;
  chainId: number;
  signers: Record<Role, Wallet | null>;
}

export interface LegacyMcpConfig extends McpConfigBase {
  protocolGeneration: 'legacy';
  registry: Registry;
}

export interface V2McpConfig extends McpConfigBase {
  protocolGeneration: 'v2';
  registry: V2Registry;
}

export type McpConfig = LegacyMcpConfig | V2McpConfig;

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const REGISTRY_FORMS =
  'a legacy dogeforex.registry/v2 JSON file or a protocol V2 artifact, bare linkedData JSON, artifact array, or directory containing *_V2Registry.json';

function noSigners(): Record<Role, Wallet | null> {
  return { deployer: null, treasury: null, guardian: null, bot: null };
}

function v2Config(rpcUrl: string, registryPath: string, registry: V2Registry): V2McpConfig {
  return {
    protocolGeneration: 'v2',
    rpcUrl,
    registryPath,
    registry,
    network: registry.network,
    chainId: registry.chainId,
    provider: new JsonRpcProvider(rpcUrl, registry.chainId, { staticNetwork: true }),
    signers: noSigners(),
  };
}

/**
 * Build server config from environment variables only. The legacy default is
 * unchanged; explicitly supplied current V2 artifacts and directories use the
 * SDK's protocol-V2 loader. Signer envs are legacy-only and ignored for V2.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<McpConfig> {
  const rpcUrl = env.DOGEOS_RPC_URL ?? DEFAULT_RPC_URL;
  const registryPath = resolve(env.DOGEOS_REGISTRY_PATH ?? DEFAULT_REGISTRY_PATH);
  if (!existsSync(registryPath)) {
    throw new Error(`DOGEOS_REGISTRY_PATH: registry path not found: ${registryPath} — expected ${REGISTRY_FORMS}`);
  }

  if (statSync(registryPath).isDirectory()) {
    try {
      return v2Config(rpcUrl, registryPath, await loadProtocolRegistry(registryPath));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`DOGEOS_REGISTRY_PATH: could not load ${registryPath} as protocol V2 (${detail}) — expected ${REGISTRY_FORMS}`, { cause: error });
    }
  }

  const raw = readFileSync(registryPath, 'utf8');
  const generation = detectProtocolRegistry(raw);
  if (generation === 'v2') {
    return v2Config(rpcUrl, registryPath, await loadProtocolRegistry(registryPath));
  }
  if (generation !== 'legacy') {
    throw new Error(`DOGEOS_REGISTRY_PATH: unsupported registry ${registryPath} — expected ${REGISTRY_FORMS}; schema labels and chainId alone do not select protocol V2`);
  }

  const registry = parseRegistry(raw);
  const provider = new JsonRpcProvider(rpcUrl, registry.chainId, { staticNetwork: true });
  const signers = noSigners();
  for (const role of Object.keys(ROLE_ENV) as Role[]) {
    const varName = ROLE_ENV[role];
    const key = env[varName];
    if (key == null || key === '') continue;
    if (!KEY_RE.test(key)) {
      throw new Error(`${varName}: invalid private key format — expected 0x-prefixed 64-char hex (key value is never logged)`);
    }
    signers[role] = new Wallet(key, provider);
  }
  return {
    protocolGeneration: 'legacy',
    rpcUrl,
    registryPath,
    registry,
    network: registry.chainName,
    chainId: registry.chainId,
    provider,
    signers,
  };
}

/** Resolve a legacy signer or throw a clean error naming the missing env var. */
export function requireSigner(config: LegacyMcpConfig, role: Role, tool: string): Wallet {
  const signer = config.signers[role];
  if (!signer) {
    throw new Error(`${tool}: missing signer env var ${ROLE_ENV[role]} — export it (0x-prefixed hex key) and retry`);
  }
  return signer;
}

/** Validate a legacy currency code argument against the legacy registry. */
export function requireCode(registry: Registry, raw: string): CurrencyCode {
  const code = raw.toUpperCase() as CurrencyCode;
  if (!CURRENCY_CODES.includes(code) || !registry.instances[code]) {
    throw new Error(`unknown instance code "${raw}" — have: ${registry.codes.join(', ')}`);
  }
  return code;
}

export function requireV2Code(registry: V2Registry, raw: string): V2CurrencyCode {
  const code = raw.toUpperCase() as V2CurrencyCode;
  if (!V2_CURRENCY_CODES.includes(code) || !registry.instances[code]) {
    throw new Error(`unknown V2 instance code "${raw}" — have: ${registry.codes.join(', ')}`);
  }
  return code;
}
