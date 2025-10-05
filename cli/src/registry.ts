import fsExtra from 'fs-extra';
const { readJson, writeJson, ensureDir, pathExists, readFile } = fsExtra;
import { join, basename } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { create as createTarball } from 'tar';
import { pipeline } from 'node:stream/promises';
import { GitHubClient } from './github.js';
import { validatePackStructure, generateComplianceReport } from './lifecycle.js';
import type {
  RegistryPackSummary,
  RegistryEntry,
  PublishPackParams,
  PackManifest,
  PLGNDefaults,
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

export async function discoverPacks(options: DiscoveryOptions, defaults: PLGNDefaults): Promise<RegistryPackSummary[]> {
  const token = resolveGitHubToken();
  const org = resolveGitHubOrg();

  if (token && org) {
    try {
      return await discoverFromGitHub(options, defaults, token, org);
    } catch (error: any) {
      console.warn(`GitHub discovery failed (${error.message}), falling back to local registry`);
    }
  }

  return await discoverFromLocal(options, defaults);
}

async function discoverFromGitHub(
  options: DiscoveryOptions,
  defaults: PLGNDefaults,
  token: string,
  org: string
): Promise<RegistryPackSummary[]> {
  const client = new GitHubClient({ token, org });
  const cacheDir = process.env.PLGN_ACTIVE_CACHE_DIR || join(process.cwd(), '.plgn', 'cache');
  const cacheFile = join(cacheDir, `registry-${Date.now()}.json`);

  const entries = await client.getRegistryIndex();

  await ensureDir(cacheDir);
  await writeJson(cacheFile, { timestamp: Date.now(), entries }, { spaces: 2 });

  return entries
    .filter((pack) => !options.language || pack.languages.includes(options.language) || pack.languages.includes('any'))
    .filter((pack) => !options.query || pack.name.includes(options.query) || pack.description.includes(options.query))
    .map((pack) => ({
      name: pack.name,
      version: pack.version,
      languages: pack.languages,
      description: pack.description,
      compatibilityScore: pack.languages.includes(defaults.language) ? 0.9 : 0.7
    }));
}

async function discoverFromLocal(options: DiscoveryOptions, defaults: PLGNDefaults): Promise<RegistryPackSummary[]> {
  const local = await queryLocalRegistry();
  return local
    .filter((pack) => !options.language || pack.languages.includes(options.language) || pack.languages.includes('any'))
    .map((pack) => ({
      ...pack,
      compatibilityScore: pack.languages.includes(defaults.language) ? 0.9 : 0.7
    }));
}

export async function publishPack(params: PublishPackParams): Promise<PublishResult> {
  const token = resolveGitHubToken();
  const org = resolveGitHubOrg();

  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable not set. Cannot publish to GitHub registry.');
  }

  console.log(`Publishing to GitHub org: ${org}`);

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
  const checksum = GitHubClient.computeChecksum(tarballBuffer);

  const client = new GitHubClient({ token, org });
  await client.ensureRegistryRepo();

  const releaseUrl = await client.createRelease(manifest.name, manifest.version, '', checksum);

  const filename = `${manifest.name}-${manifest.version}.tgz`;
  const downloadUrl = await client.uploadReleaseAsset(releaseUrl, tarballBuffer, filename);

  const entries = await client.getRegistryIndex();
  const existingIndex = entries.findIndex((e) => e.name === manifest.name && e.version === manifest.version);

  const newEntry: RegistryEntry = {
    name: manifest.name,
    version: manifest.version,
    languages: manifest.requirements.languages,
    description: manifest.description,
    downloadUrl,
    checksum,
    publishedAt: new Date().toISOString(),
    author: process.env.GIT_AUTHOR_NAME || 'unknown'
  };

  if (existingIndex >= 0) {
    entries[existingIndex] = newEntry;
  } else {
    entries.push(newEntry);
  }

  await client.updateRegistryIndex(entries, `Publish ${manifest.name}@${manifest.version}`);

  await persistLocalRegistry(entries.map((e) => ({
    name: e.name,
    version: e.version,
    languages: e.languages,
    description: e.description,
    compatibilityScore: 0.8
  })));

  return {
    url: releaseUrl,
    version: manifest.version,
    checksum
  };
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
