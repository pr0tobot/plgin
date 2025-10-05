import fsExtra from 'fs-extra';
const { readJson, writeJson, ensureDir, ensureDirSync } = fsExtra;
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { ConfigFile, PLGNDefaults, Provider, SemanticConfig } from './types.js';

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

const preferencesSchema = z.object({
  autoApplyChanges: z.boolean().default(false)
});

const semanticSchema = z.object({
  provider: z.enum(['nia-contexts', 'disabled']).default('nia-contexts'),
  agentSource: z.string().min(1).default('plgn-cli'),
  tags: z.array(z.string()).default(['plgn-pack']),
  searchLimit: z.number().int().min(1).max(100).default(20)
}).default({
  provider: 'nia-contexts',
  agentSource: 'plgn-cli',
  tags: ['plgn-pack'],
  searchLimit: 20
});

const registrySchema = z.object({
  url: z.string().optional(),
  org: z.string().optional(),
  token: z.string().optional()
}).default({});

const configSchema = z.object({
  defaults: defaultsSchema,
  providerOptions: z.record(z.string(), z.unknown()).default({}),
  tokens: z.record(z.string(), z.string().optional()).default({}),
  preferences: preferencesSchema.default({ autoApplyChanges: false }),
  registry: registrySchema,
  semantic: semanticSchema
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
  tokens: {},
  preferences: {
    autoApplyChanges: false
  },
  registry: {},
  semantic: {
    provider: 'nia-contexts',
    agentSource: 'plgn-cli',
    tags: ['plgn-pack'],
    searchLimit: 20
  }
};

function resolveOverrideCacheDir(cwd: string): string | undefined {
  const override = process.env.PLGN_CACHE_DIR;
  if (!override) {
    return undefined;
  }
  const resolved = isAbsolute(override) ? override : join(cwd, override);
  try {
    ensureDirSync(resolved);
    return resolved;
  } catch {
    return undefined;
  }
}

function resolveCacheDir(cwd: string): string {
  const override = resolveOverrideCacheDir(cwd);
  if (override) {
    return override;
  }

  const workspaceRoot = join(cwd, '.plgn');
  const workspaceCacheDir = join(workspaceRoot, 'cache');
  const workspaceOptIn = process.env.PLGN_CACHE_STRATEGY === 'workspace'
    || process.env.PLGN_CACHE_STRATEGY === 'project'
    || existsSync(workspaceRoot);

  if (workspaceOptIn) {
    try {
      ensureDirSync(workspaceCacheDir);
      return workspaceCacheDir;
    } catch {
      // fall through to home cache
    }
  }

  try {
    ensureDirSync(CACHE_DIR);
    return CACHE_DIR;
  } catch {
    return workspaceCacheDir;
  }
}

export const getEnv = () => {
  const cwd = process.cwd();
  const cacheDir = resolveCacheDir(cwd);
  process.env.PLGN_ACTIVE_CACHE_DIR = cacheDir;
  return {
    cwd,
    configPath: CONFIG_PATH,
    cacheDir
  };
};

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
  const providerEnvKey = `${provider.toUpperCase()}_API_KEY`;
  return process.env[envKey] ?? process.env[providerEnvKey] ?? config.tokens[provider];
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
