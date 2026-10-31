import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type McpConfig, type V2McpConfig } from '../src/config.js';
import { cloneFixture, makeV2Artifact, makeV2LinkedData } from './v2-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const legacyPath = resolve(here, '../../dogeforex-protocol/deployments/k9usd.chikyu.json');
let directory: string;

function asV2(config: McpConfig): V2McpConfig {
  if (config.protocolGeneration !== 'v2') throw new Error('expected V2 config');
  return config;
}

function writeJson(name: string, value: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dogeforex-mcp-v2-config-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('V2 registry configuration (synthetic offline fixtures)', () => {
  it('loads an artifact, discriminates network/chain, and ignores every signer env', async () => {
    const path = writeJson('USD_V2Registry.json', makeV2Artifact());
    const config = asV2(await loadConfig({
      DOGEOS_REGISTRY_PATH: path,
      DOGEOS_RPC_URL: 'http://offline.invalid',
      DOGEFOREX_TREASURY_KEY: 'not-a-key',
      DOGEFOREX_GUARDIAN_KEY: 'also-not-a-key',
      DOGEFOREX_BOT_KEY: 'invalid',
      DOGEFOREX_DEPLOYER_KEY: 'invalid',
    }));
    expect(config.protocolGeneration).toBe('v2');
    expect(config.registry.codes).toEqual(['USD']);
    expect(config.network).toBe('synthetic-v2');
    expect(config.chainId).toBe(6_281_971);
    expect(Object.values(config.signers)).toEqual([null, null, null, null]);
  });

  it('loads bare linkedData without confusing the legacy schema label with protocol V2', async () => {
    const path = writeJson('bare.json', makeV2LinkedData());
    const config = asV2(await loadConfig({ DOGEOS_REGISTRY_PATH: path }));
    expect(config.registry.instances.USD?.protocolGeneration).toBe('v2');

    const legacy = await loadConfig({ DOGEOS_REGISTRY_PATH: legacyPath });
    expect(legacy.protocolGeneration).toBe('legacy');
    expect(legacy.registry.schema).toBe('dogeforex.registry/v2');
    expect(legacy.network).toBe(legacy.registry.chainName);
  });

  it('loads an artifact array and preserves a staged subset', async () => {
    const path = writeJson('staged.json', [makeV2Artifact(), makeV2Artifact({ code: 'EUR', variant: 1 })]);
    const config = asV2(await loadConfig({ DOGEOS_REGISTRY_PATH: path }));
    expect(config.registry.codes).toEqual(['USD', 'EUR']);
    expect(Object.keys(config.registry.instances)).toHaveLength(2);
  });

  it('loads only V2 artifacts from an explicit directory', async () => {
    writeJson('USD_V2Registry.json', makeV2Artifact());
    writeJson('EUR_V2Registry.json', makeV2Artifact({ code: 'EUR', variant: 1 }));
    writeJson('README.json', { chainId: 6_281_971 });
    const config = asV2(await loadConfig({ DOGEOS_REGISTRY_PATH: directory }));
    expect(new Set(config.registry.codes)).toEqual(new Set(['USD', 'EUR']));
  });

  it('rejects unknown content and empty directories with errors describing both registry forms', async () => {
    const unknown = writeJson('unknown.json', { schemaVersion: '3.0', chainId: 6_281_971 });
    await expect(loadConfig({ DOGEOS_REGISTRY_PATH: unknown })).rejects.toThrow(/legacy dogeforex\.registry\/v2.*protocol V2 artifact/);
    await expect(loadConfig({ DOGEOS_REGISTRY_PATH: unknown })).rejects.toThrow(/chainId alone do not select protocol V2/);

    const empty = join(directory, 'empty');
    mkdirSync(empty);
    await expect(loadConfig({ DOGEOS_REGISTRY_PATH: empty })).rejects.toThrow(/legacy dogeforex\.registry\/v2.*protocol V2 artifact/);
  });

  it('reports a missing path with all supported input forms', async () => {
    const missing = join(directory, 'missing.json');
    await expect(loadConfig({ DOGEOS_REGISTRY_PATH: missing })).rejects.toThrow(
      /registry path not found.*bare linkedData JSON, artifact array, or directory/,
    );
  });

  it('does not accept malformed V2 evidence merely because schemaVersion and chainId look plausible', async () => {
    const malformed = cloneFixture(makeV2LinkedData());
    delete malformed.network;
    const path = writeJson('malformed.json', malformed);
    await expect(loadConfig({ DOGEOS_REGISTRY_PATH: path })).rejects.toThrow(/network must be a non-empty string/);
  });

  it('loads the real Chikyu V2 directory with all 12 currencies and no signer configuration', async () => {
    const registryPath = resolve(here, '../../dogeforex-protocol/scripts/deployment/deployments/chikyuV2');
    const config = asV2(await loadConfig({
      DOGEOS_REGISTRY_PATH: registryPath,
      DOGEOS_RPC_URL: 'http://offline.invalid',
      DOGEFOREX_TREASURY_KEY: 'not-a-key',
      DOGEFOREX_GUARDIAN_KEY: 'not-a-key',
      DOGEFOREX_BOT_KEY: 'not-a-key',
      DOGEFOREX_DEPLOYER_KEY: 'not-a-key',
    }));
    expect(config.registry.codes).toEqual(['AUD', 'BDT', 'BRL', 'CHF', 'CNY', 'EUR', 'GBP', 'INR', 'JPY', 'NGN', 'PKR', 'USD']);
    expect(config.network).toBe('chikyuV2');
    expect(config.chainId).toBe(6_281_971);
    expect(Object.values(config.signers)).toEqual([null, null, null, null]);
  });
});
