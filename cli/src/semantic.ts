import { join, relative } from 'node:path';
import fsExtra from 'fs-extra';
const { ensureDir, pathExists, readJson, writeJson, readFile } = fsExtra;
import type { ConfigFile, PackManifest, SemanticConfig, SemanticSearchHit } from './types.js';

interface SemanticMapping {
  packs: Record<string, Record<string, { contextId: string; updatedAt: string }>>;
}

export interface SemanticIndexPackOptions {
  manifest: PackManifest;
  packDir: string;
  sourcePaths: string[];
}

const DEFAULT_MAPPING: SemanticMapping = { packs: {} };
const MAX_CONTENT_LENGTH = 9000;
const MAX_SNIPPETS = 3;
const MAX_SNIPPET_LENGTH = 600;

export class SemanticService {
  private readonly semantic: SemanticConfig;
  private readonly cacheDir: string;
  private readonly mappingPath: string;
  private mappingCache: SemanticMapping | null = null;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(private readonly config: ConfigFile, cacheDir: string) {
    this.semantic = config.semantic;
    this.cacheDir = cacheDir;
    this.mappingPath = join(cacheDir, 'semantic', 'contexts.json');
    this.baseUrl = (process.env.NIA_API_URL ?? 'https://apigcp.trynia.ai/').replace(/\/$/, '') + '/';
    this.apiKey = process.env.NIA_API_KEY;
  }

  isEnabled(): boolean {
    if (!this.semantic || this.semantic.provider === 'disabled') {
      return false;
    }
    return Boolean(this.apiKey);
  }

  async indexPack(options: SemanticIndexPackOptions): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    try {
      const payload = await this.buildContextPayload(options);
      if (!payload) {
        return;
      }

      const mapping = await this.loadMapping();
      const packKey = this.ensurePackEntry(mapping, options.manifest.name);
      const existing = packKey[options.manifest.version];

      if (existing?.contextId) {
        await this.updateContext(existing.contextId, payload);
        packKey[options.manifest.version] = {
          contextId: existing.contextId,
          updatedAt: new Date().toISOString()
        };
      } else {
        const created = await this.createContext(payload);
        if (created?.id) {
          packKey[options.manifest.version] = {
            contextId: created.id,
            updatedAt: new Date().toISOString()
          };
        }
      }

      await this.saveMapping(mapping);
    } catch (error) {
      console.warn('[plgin:semantic] Failed to index pack with Nia MCP:', error instanceof Error ? error.message : error);
    }
  }

  async searchPacks(query: string, language?: string): Promise<SemanticSearchHit[]> {
    if (!this.isEnabled()) {
      return [];
    }

    if (!query.trim()) {
      return [];
    }

    const params = new URLSearchParams();
    params.set('q', query);
    params.set('limit', String(this.semantic.searchLimit ?? 20));

    const tags = new Set(this.semantic.tags ?? ['plgin-pack']);
    tags.add('plgin-pack');
    if (language && language !== 'any') {
      tags.add(`language:${language.toLowerCase()}`);
    }
    if (tags.size) {
      params.set('tags', Array.from(tags).join(','));
    }

    try {
      const data = await this.request(`v2/contexts/search?${params.toString()}`, {
        method: 'GET'
      });
      const contexts = Array.isArray(data?.contexts) ? data.contexts : [];

      const results: SemanticSearchHit[] = [];
      for (const ctx of contexts) {
        if (!ctx) continue;
        const metadata = ctx.metadata ?? {};
        const tagsList: string[] = Array.isArray(ctx.tags) ? ctx.tags : [];
        const packName = this.resolvePackName(metadata, tagsList);
        const version = this.resolveVersion(metadata, tagsList);
        if (!packName || !version) {
          continue;
        }
        results.push({
          contextId: ctx.id,
          packName,
          version,
          summary: typeof ctx.summary === 'string' && ctx.summary.trim().length > 0
            ? ctx.summary.trim()
            : this.createFallbackSummary(ctx.content),
          tags: tagsList,
          metadata: typeof metadata === 'object' ? metadata : undefined
        });
      }
      return results;
    } catch (error) {
      console.warn('[plgin:semantic] Failed to query Nia contexts:', error instanceof Error ? error.message : error);
      return [];
    }
  }

  private ensurePackEntry(mapping: SemanticMapping, packName: string): Record<string, { contextId: string; updatedAt: string }> {
    if (!mapping.packs[packName]) {
      mapping.packs[packName] = {};
    }
    return mapping.packs[packName];
  }

  private async loadMapping(): Promise<SemanticMapping> {
    if (this.mappingCache) {
      return this.mappingCache;
    }
    try {
      if (await pathExists(this.mappingPath)) {
        const data = await readJson(this.mappingPath) as SemanticMapping;
        this.mappingCache = data;
        return data;
      }
    } catch (error) {
      console.warn('[plgin:semantic] Failed to read semantic cache:', error instanceof Error ? error.message : error);
    }
    this.mappingCache = { ...DEFAULT_MAPPING };
    return this.mappingCache;
  }

  private async saveMapping(mapping: SemanticMapping): Promise<void> {
    try {
      await ensureDir(join(this.cacheDir, 'semantic'));
      await writeJson(this.mappingPath, mapping, { spaces: 2 });
      this.mappingCache = mapping;
    } catch (error) {
      console.warn('[plgin:semantic] Failed to persist semantic cache:', error instanceof Error ? error.message : error);
    }
  }

  private async createContext(payload: Record<string, unknown>): Promise<any> {
    return this.request('v2/contexts', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  private async updateContext(contextId: string, payload: Record<string, unknown>): Promise<any> {
    return this.request(`v2/contexts/${contextId}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    if (!this.apiKey) {
      throw new Error('NIA_API_KEY not configured');
    }
    const url = new URL(path.startsWith('/') ? path.slice(1) : path, this.baseUrl).toString();
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.apiKey}`);
    }
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(url, {
      ...init,
      headers
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Nia request failed (${response.status}): ${text}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  private async buildContextPayload(options: SemanticIndexPackOptions): Promise<Record<string, unknown> | null> {
    const { manifest, packDir, sourcePaths } = options;
    if (!manifest?.name || !manifest?.version) {
      return null;
    }

    const languages = manifest.requirements?.languages ?? ['any'];
    const frameworks = manifest.requirements?.frameworks ?? [];
    const providesKeys = Object.keys(manifest.provides ?? {});
    const tags = new Set<string>(this.semantic.tags ?? ['plgin-pack']);
    tags.add('plgin-pack');
    tags.add(`pack:${manifest.name}`);
    tags.add(`version:${manifest.version}`);
    for (const language of languages) {
      tags.add(`language:${language.toLowerCase()}`);
    }
    for (const framework of frameworks) {
      tags.add(`framework:${framework.toLowerCase()}`);
    }
    if (manifest.ai_adaptation?.strategy) {
      tags.add(`strategy:${manifest.ai_adaptation.strategy}`);
    }

    const summary = manifest.description?.slice(0, 250) ?? `${manifest.name} feature pack`;
    const contentParts: string[] = [
      `Pack: ${manifest.name} @ ${manifest.version}`,
      `Description: ${manifest.description}`,
      `Languages: ${languages.join(', ') || 'any'}`,
      `Frameworks: ${frameworks.join(', ') || 'agnostic'}`,
      `Provides: ${providesKeys.join(', ') || 'unspecified'}`,
      `AI Strategy: ${manifest.ai_adaptation?.strategy ?? 'unknown'} (min confidence ${manifest.ai_adaptation?.min_confidence ?? 'n/a'})`
    ];

    if (manifest.examples && Object.keys(manifest.examples).length > 0) {
      contentParts.push(`Examples: ${JSON.stringify(manifest.examples).slice(0, 500)}`);
    }

    const snippets = await this.collectSourceSnippets(packDir, sourcePaths);
    if (snippets.length) {
      contentParts.push('Source Snippets:\n' + snippets.join('\n\n'));
    }

    const content = contentParts.join('\n\n').slice(0, MAX_CONTENT_LENGTH);

    return {
      title: `${manifest.name}@${manifest.version}`,
      summary,
      content,
      tags: Array.from(tags),
      agent_source: this.semantic.agentSource ?? 'plgin-cli',
      metadata: {
        packName: manifest.name,
        version: manifest.version,
        languages,
        frameworks,
        providesKeys,
        requirements: manifest.requirements,
        strategy: manifest.ai_adaptation?.strategy
      }
    };
  }

  private async collectSourceSnippets(packDir: string, sourcePaths: string[]): Promise<string[]> {
    if (!sourcePaths.length) {
      const sourceRoot = join(packDir, 'source');
      if (!(await pathExists(sourceRoot))) {
        return [];
      }
      try {
        const entries = await fsExtra.readdir(sourceRoot);
        if (!entries.length) {
          return [];
        }
      } catch {
        return [];
      }
    }

    const snippets: string[] = [];
    const sortedPaths = [...new Set(sourcePaths)].sort();
    for (const filePath of sortedPaths.slice(0, MAX_SNIPPETS)) {
      try {
        const contents = await readFile(filePath, 'utf8');
        const trimmed = contents.trim();
        if (!trimmed) continue;
        const rel = relative(packDir, filePath);
        snippets.push(`File: ${rel}\n${trimmed.slice(0, MAX_SNIPPET_LENGTH)}`);
      } catch {
        continue;
      }
    }
    return snippets;
  }

  private resolvePackName(metadata: any, tags: string[]): string | undefined {
    if (metadata && typeof metadata.packName === 'string') {
      return metadata.packName;
    }
    const tag = tags.find((value) => typeof value === 'string' && value.startsWith('pack:'));
    if (tag) {
      return tag.split(':').slice(1).join(':');
    }
    return undefined;
  }

  private resolveVersion(metadata: any, tags: string[]): string | undefined {
    if (metadata && typeof metadata.version === 'string') {
      return metadata.version;
    }
    const tag = tags.find((value) => typeof value === 'string' && value.startsWith('version:'));
    if (tag) {
      return tag.split(':').slice(1).join(':');
    }
    return undefined;
  }

  private createFallbackSummary(content: any): string {
    if (typeof content === 'string' && content.trim().length > 0) {
      return content.trim().slice(0, 180);
    }
    return 'Semantic result from Nia MCP';
  }
}

export function createSemanticService(config: ConfigFile, cacheDir: string): SemanticService {
  return new SemanticService(config, cacheDir);
}
