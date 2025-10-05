import fsExtra from 'fs-extra';
const { readJson, writeJson, ensureDir, pathExists, readFile } = fsExtra;
import { join } from 'node:path';
import { create as createTarball } from 'tar';
import { GitHubClient } from './github.js';
import { validatePackStructure, generateComplianceReport } from './lifecycle.js';
import { createSemanticService } from './semantic.js';
import { getEnv } from './config.js';
import { listFilesRecursive } from './utils/fs.js';
import { getRegistryEndpoint } from './defaults.js';
import type {
  RegistryPackSummary,
  RegistryEntry,
  PublishPackParams,
  PackManifest,
  ConfigFile,
  DiscoveryOptions,
  PublishResult
} from './types.js';

const LOCAL_REGISTRY_PATH = join(process.cwd(), '.plgn', 'registry.json');

function resolveGitHubToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

function resolveGitHubOrg(): string {
  return process.env.GITHUB_ORG || 'PR0TO-IDE';
}

export async function discoverPacks(options: DiscoveryOptions, config: ConfigFile): Promise<RegistryPackSummary[]> {
  const token = resolveGitHubToken();
  const org = resolveGitHubOrg();
  const env = getEnv();
  const semantic = createSemanticService(config, env.cacheDir);

  if (token && org) {
    try {
      return await discoverFromGitHub(options, config, semantic, token, org);
    } catch (error: any) {
      console.warn(`GitHub discovery failed (${error.message}), falling back to local registry`);
    }
  }

  return await discoverFromLocal(options, config, semantic);
}

async function discoverFromGitHub(
  options: DiscoveryOptions,
  config: ConfigFile,
  semantic: ReturnType<typeof createSemanticService>,
  token: string,
  org: string
): Promise<RegistryPackSummary[]> {
  const cacheDir = process.env.PLGN_ACTIVE_CACHE_DIR || join(process.cwd(), '.plgn', 'cache');
  const cacheFile = join(cacheDir, `registry-${Date.now()}.json`);

  const proxyUrl = getRegistryEndpoint();
  const entries = await fetchRegistryFromProxy(proxyUrl);

  await ensureDir(cacheDir);
  await writeJson(cacheFile, { timestamp: Date.now(), entries }, { spaces: 2 });

  const filtered = filterByLanguage(entries, options.language);
  const prioritized = await prioritizeEntries(filtered, options.query, options.language, semantic);
  return prioritized.map((entry) => toSummary(entry, config));
}

async function fetchRegistryFromProxy(proxyUrl: string): Promise<RegistryEntry[]> {
  const response = await fetch(`${proxyUrl}/registry/index`, {
    headers: {
      'User-Agent': 'plgn-cli/1.9.1'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch registry from proxy: ${response.statusText}`);
  }

  const data = await response.json() as { entries: RegistryEntry[]; cached_at: string };
  return data.entries;
}

async function discoverFromLocal(
  options: DiscoveryOptions,
  config: ConfigFile,
  semantic: ReturnType<typeof createSemanticService>
): Promise<RegistryPackSummary[]> {
  const local = await queryLocalRegistry();
  const filtered = filterByLanguage(local as unknown as RegistryEntry[], options.language);
  const prioritized = await prioritizeEntries(filtered, options.query, options.language, semantic);
  return prioritized.map((entry) => toSummary(entry, config));
}

export async function publishPack(params: PublishPackParams): Promise<PublishResult> {
  console.log('Publishing pack to registry via proxy...');

  const validation = await validatePackStructure(params.packDir);
  if (!validation.valid) {
    throw new Error(`Pack validation failed:\n${validation.errors.join('\n')}`);
  }

  if (validation.warnings.length > 0) {
    console.warn('Validation warnings:');
    for (const warning of validation.warnings) {
      console.warn(`  - ${warning}`);
    }
  }

  await generateComplianceReport(params.packDir);

  const manifestPath = join(params.packDir, 'manifest.json');
  const manifest = (await readJson(manifestPath)) as PackManifest;

  const tarballBuffer = await createPackTarball(params.packDir, manifest.name, manifest.version);

  const proxyUrl = getRegistryEndpoint();
  const author = process.env.GIT_AUTHOR_NAME || 'community';

  const response = await fetch(`${proxyUrl}/registry/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'plgn-cli/1.9.1'
    },
    body: JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      languages: manifest.requirements.languages,
      description: manifest.description,
      tarball_base64: tarballBuffer.toString('base64'),
      author
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(`Publish failed: ${errorData.detail || response.statusText}`);
  }

  const result = await response.json() as {
    status: string;
    url: string;
    version: string;
    checksum: string;
    downloadUrl: string;
  };

  const proxyReadUrl = getRegistryEndpoint();
  const registryResponse = await fetch(`${proxyReadUrl}/registry/index`, {
    headers: {
      'User-Agent': 'plgn-cli/1.9.1'
    }
  });

  if (registryResponse.ok) {
    const registryData = await registryResponse.json() as { entries: RegistryEntry[] };
    const localSummaries = registryData.entries.map((e) => ({
      name: e.name,
      version: e.version,
      languages: e.languages,
      description: e.description,
      compatibilityScore: 0.8
    }));
    await persistLocalRegistry(localSummaries);
  }

  await maybeIndexPackSemantics(params, manifest);

  return {
    url: result.url,
    version: result.version,
    checksum: result.checksum
  };
}

async function maybeIndexPackSemantics(params: PublishPackParams, manifest: PackManifest): Promise<void> {
  const semantic = createSemanticService(params.config, params.cacheDir);
  if (!semantic.isEnabled()) {
    return;
  }

  let sourcePaths: string[] = [];
  const sourceRoot = join(params.packDir, 'source');
  if (await pathExists(sourceRoot)) {
    try {
      sourcePaths = await listFilesRecursive(sourceRoot);
    } catch (error) {
      console.warn('[plgn:semantic] Failed to enumerate pack source files:', error instanceof Error ? error.message : error);
    }
  }

  await semantic.indexPack({
    manifest,
    packDir: params.packDir,
    sourcePaths
  });
}

async function createPackTarball(packDir: string, name: string, version: string): Promise<Buffer> {
  const tarballPath = `/tmp/${name}-${version}.tgz`;

  await createTarball(
    {
      gzip: true,
      file: tarballPath,
      cwd: packDir
    },
    ['.']
  );

  const buffer = await readFile(tarballPath);
  return buffer;
}

async function queryLocalRegistry(): Promise<RegistryPackSummary[]> {
  try {
    const existing = (await readJson(LOCAL_REGISTRY_PATH)) as RegistryPackSummary[];
    return existing;
  } catch (error) {
    return [];
  }
}

async function persistLocalRegistry(entries: RegistryPackSummary[]): Promise<void> {
  await ensureDir(join(process.cwd(), '.plgn'));
  await writeJson(LOCAL_REGISTRY_PATH, entries, { spaces: 2 });
}

function filterByLanguage<T extends { languages: string[] }>(entries: T[], language?: string): T[] {
  if (!language) {
    return entries;
  }
  return entries.filter((entry) => entry.languages.includes(language) || entry.languages.includes('any'));
}

function applyLexicalFilter(entries: RegistryEntry[], query?: string): RegistryEntry[] {
  if (!query) {
    return entries;
  }
  const needle = query.toLowerCase();
  return entries.filter((entry) =>
    entry.name.toLowerCase().includes(needle)
    || entry.description.toLowerCase().includes(needle)
  );
}

async function prioritizeEntries(
  entries: RegistryEntry[],
  query: string | undefined,
  language: string | undefined,
  semantic: ReturnType<typeof createSemanticService>
): Promise<RegistryEntry[]> {
  if (!query) {
    return entries;
  }

  const lexical = applyLexicalFilter(entries, query);

  if (!semantic.isEnabled()) {
    return lexical.length ? lexical : entries;
  }

  const hits = await semantic.searchPacks(query, language);
  if (!hits.length) {
    return lexical.length ? lexical : entries;
  }

  const entryMap = new Map<string, RegistryEntry>();
  for (const entry of entries) {
    entryMap.set(packKey(entry.name, entry.version), entry);
  }

  const ranked: RegistryEntry[] = [];
  const seen = new Set<string>();

  const appendEntry = (entry: RegistryEntry | undefined) => {
    if (!entry) return;
    const key = packKey(entry.name, entry.version);
    if (seen.has(key)) return;
    seen.add(key);
    ranked.push(entry);
  };

  for (const hit of hits) {
    const entry = entryMap.get(packKey(hit.packName, hit.version));
    appendEntry(entry);
  }

  for (const entry of lexical) {
    appendEntry(entry);
  }

  for (const entry of entries) {
    appendEntry(entry);
  }

  return ranked;
}

function toSummary(entry: RegistryEntry, config: ConfigFile): RegistryPackSummary {
  const preferredLanguage = config.defaults.language;
  return {
    name: entry.name,
    version: entry.version,
    languages: entry.languages,
    description: entry.description,
    compatibilityScore: entry.languages.includes(preferredLanguage) ? 0.9 : 0.7
  };
}

function packKey(name: string, version: string): string {
  return `${name.toLowerCase()}@${version}`;
}
