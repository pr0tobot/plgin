import fsExtra from 'fs-extra';
const { readJson, writeJson, ensureDir } = fsExtra;
import { join } from 'node:path';
import type {
  RegistryPackSummary,
  PublishPackParams,
  PackManifest,
  PLGNDefaults,
  DiscoveryOptions
} from './types.js';

const LOCAL_REGISTRY_PATH = join(process.cwd(), '.plgn', 'registry.json');

export async function discoverPacks(options: DiscoveryOptions, defaults: PLGNDefaults): Promise<RegistryPackSummary[]> {
  if (options.registry) {
    return queryLocalRegistry();
  }
  const local = await queryLocalRegistry();
  return local
    .filter((pack) => !options.language || pack.languages.includes(options.language) || pack.languages.includes('any'))
    .map((pack) => ({
      ...pack,
      compatibilityScore: pack.languages.includes(defaults.language) ? 0.9 : 0.7
    }));
}

export async function publishPack(params: PublishPackParams): Promise<void> {
  const manifestPath = join(params.packDir, 'manifest.json');
  const manifest = (await readJson(manifestPath)) as PackManifest;
  const registry = await queryLocalRegistry();
  const existingIndex = registry.findIndex((entry) => entry.name === manifest.name && entry.version === manifest.version);
  const summary: RegistryPackSummary = {
    name: manifest.name,
    version: manifest.version,
    languages: manifest.requirements.languages,
    description: manifest.description,
    compatibilityScore: 0.8
  };
  if (existingIndex >= 0) {
    registry[existingIndex] = summary;
  } else {
    registry.push(summary);
  }
  await persistLocalRegistry(registry);
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
