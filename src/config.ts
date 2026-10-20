import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JsonRpcProvider, Wallet } from 'ethers';
import {
  CURRENCY_CODES,
  parseRegistry,
  type CurrencyCode,
  type Registry,
} from '@dogeforex/sdk';

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

export interface McpConfig {
  rpcUrl: string;
  registryPath: string;
  registry: Registry;
  provider: JsonRpcProvider;
  /** Resolved per role; null when the role's env var is not set. */
  signers: Record<Role, Wallet | null>;
}

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Build server config from environment variables only.
 * - DOGEOS_RPC_URL (default: public Chikyu RPC)
 * - DOGEOS_REGISTRY_PATH (default: ../dogeforex-protocol/deployments/k9usd.chikyu.json, cwd-relative)
 * - DOGEFOREX_{DEPLOYER,TREASURY,GUARDIAN,BOT}_KEY (optional 0x-prefixed hex keys)
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const rpcUrl = env.DOGEOS_RPC_URL ?? DEFAULT_RPC_URL;
  const registryPath = resolve(env.DOGEOS_REGISTRY_PATH ?? DEFAULT_REGISTRY_PATH);
  if (!existsSync(registryPath)) {
    throw new Error(`DOGEOS_REGISTRY_PATH: registry file not found: ${registryPath} — set DOGEOS_REGISTRY_PATH to a dogeforex.registry/v2 JSON file`);
  }
  const registry = parseRegistry(readFileSync(registryPath, 'utf8'));
  const provider = new JsonRpcProvider(rpcUrl, registry.chainId, { staticNetwork: true });

  const signers = {} as Record<Role, Wallet | null>;
  for (const role of Object.keys(ROLE_ENV) as Role[]) {
    const varName = ROLE_ENV[role];
    const raw = env[varName];
    if (raw == null || raw === '') {
      signers[role] = null;
      continue;
    }
    if (!KEY_RE.test(raw)) {
      throw new Error(`${varName}: invalid private key format — expected 0x-prefixed 64-char hex (key value is never logged)`);
    }
    signers[role] = new Wallet(raw, provider);
  }

  return { rpcUrl, registryPath, registry, provider, signers };
}

/** Resolve a signer or throw a clean error naming the missing env var (never the key). */
export function requireSigner(config: McpConfig, role: Role, tool: string): Wallet {
  const signer = config.signers[role];
  if (!signer) {
    throw new Error(`${tool}: missing signer env var ${ROLE_ENV[role]} — export it (0x-prefixed hex key) and retry`);
  }
  return signer;
}

/** Validate a currency code argument against the registry. */
export function requireCode(registry: Registry, raw: string): CurrencyCode {
  const code = raw.toUpperCase() as CurrencyCode;
  if (!CURRENCY_CODES.includes(code) || !registry.instances[code]) {
    throw new Error(`unknown instance code "${raw}" — have: ${registry.codes.join(', ')}`);
  }
  return code;
}
