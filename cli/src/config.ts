import fsExtra from 'fs-extra';
const { readJson, writeJson, ensureDir } = fsExtra;
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { ConfigFile, PLGNDefaults, Provider } from './types.js';

const CONFIG_FILENAME = 'config.json';
const CONFIG_DIR = join(homedir(), '.plgn');
const CONFIG_PATH = join(CONFIG_DIR, CONFIG_FILENAME);
const CACHE_DIR = join(CONFIG_DIR, 'cache');

const defaultsSchema = z.object({
  provider: z.enum(['openrouter', 'xai', 'anthropic', 'custom']) as z.ZodType<Provider>,
  model: z.string(),
  temperature: z.number().min(0).max(1),
  language: z.string(),
  securityScanner: z.enum(['snyk', 'trivy', 'custom', 'none'])
});

const configSchema = z.object({
  defaults: defaultsSchema,
  providerOptions: z.record(z.string(), z.unknown()).default({}),
  tokens: z.record(z.string(), z.string().optional()).default({})
});

const DEFAULT_CONFIG: ConfigFile = {
  defaults: {
    provider: 'openrouter',
    model: 'z-ai/glm-4.6',
    temperature: 0.3,
    language: 'auto-detect',
    securityScanner: 'snyk'
  },
  providerOptions: {},
  tokens: {
    openrouter: process.env.PLGN_API_KEY,
    xai: process.env.PLGN_XAI_KEY
  }
};

export const getEnv = () => ({
  cwd: process.cwd(),
  configPath: CONFIG_PATH,
  cacheDir: CACHE_DIR
});

export async function loadConfig(): Promise<ConfigFile> {
  if (!existsSync(CONFIG_PATH)) {
    await saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  const raw = await readJson(CONFIG_PATH).catch(() => ({}));
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Failed to parse PLGN config: ${parsed.error.message}`);
  }
  return parsed.data;
}

export async function saveConfig(config: ConfigFile): Promise<void> {
  await ensureDir(dirname(CONFIG_PATH));
  await writeJson(CONFIG_PATH, config, { spaces: 2 });
}

export function mergeDefaults(current: ConfigFile, overrides: Partial<PLGNDefaults>): ConfigFile {
  const merged: ConfigFile = {
    ...current,
    defaults: {
      ...current.defaults,
      ...overrides
    }
  };
  return merged;
}

export function resolveToken(config: ConfigFile, provider: Provider): string | undefined {
  const envKey = `PLGN_${provider.toUpperCase()}_API_KEY`;
  return process.env[envKey] ?? config.tokens[provider];
}

export function upsertToken(config: ConfigFile, provider: Provider, token: string | undefined): ConfigFile {
  return {
    ...config,
    tokens: {
      ...config.tokens,
      [provider]: token
    }
  };
}

export { CONFIG_PATH as CONFIG_FILE_PATH, CONFIG_DIR, CACHE_DIR };
