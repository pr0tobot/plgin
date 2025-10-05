import { join, resolve } from 'node:path';
import fsExtra from 'fs-extra';
const { pathExists, readJson, ensureDir, remove, writeFile } = fsExtra;
import {
  detectLanguageFromPath,
  listFilesRecursive
} from './utils/fs.js';
import { buildChangeSetPreview } from './utils/diff.js';
import { fetchRegistryFromProxy, resolveGitHubToken } from './registry.js';
import { getRegistryEndpoint } from './defaults.js';
import { extract } from 'tar';
import type {
  CompatibilityOptions,
  CompatibilityReport,
  IntegratePackParams,
  Pack,
  ChangeSet,
  IntegrationResult,
  ProjectProfile,
  PackManifest,
  FileDiff,
  ToolDefinition,
  RegistryEntry
} from './types.js';

export async function checkCompatibility(options: CompatibilityOptions): Promise<CompatibilityReport> {
  const pack = await loadPack(options.packRef);
  return computeCompatibility(pack, options.targetLanguage);
}

function resolveActiveCacheDir(): string {
  if (process.env.PLGIN_ACTIVE_CACHE_DIR) {
    return process.env.PLGIN_ACTIVE_CACHE_DIR;
  }
  return join(process.cwd(), '.plgin', 'cache');
}

const INTEGRATION_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_project_files',
      description: 'List files within the target project to understand existing structure.',
      parameters: {
        type: 'object',
        properties: {
          relative_dir: {
            type: 'string',
            description: 'Project-relative directory to inspect.'
          },
          max_results: {
            type: 'number',
            description: 'Optional cap on returned file paths.'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_project_file',
      description: 'Read an existing project file for context.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to the project root.'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_pack_files',
      description: 'List files bundled within the pack source directory.',
      parameters: {
        type: 'object',
        properties: {
          relative_dir: {
            type: 'string',
            description: 'Pack-relative directory (defaults to source/).'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_pack_file',
      description: 'Read a file from the pack to reuse or adapt during integration.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path relative to the pack root.'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'detect_language',
      description: 'Infer the likely language for a file path to tag changes.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path to inspect.'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_change',
      description: 'Propose a file create/update for the project change set.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Project-relative path to write.'
          },
          contents: {
            type: 'string',
            description: 'UTF-8 file contents to store.'
          },
          language: {
            type: 'string',
            description: 'Language hint for the change entry.'
          },
          action: {
            type: 'string',
            enum: ['create', 'update'],
            description: 'Optional explicit action; defaults based on file existence.'
          }
        },
        required: ['path', 'contents']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_change',
      description: 'Mark a project file for deletion within the change set.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Project-relative path to delete.'
          },
          language: {
            type: 'string',
            description: 'Language hint for tagging the deletion.'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'log_progress',
      description: 'Write an integration progress update to logs.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Human-readable status message.'
          }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finalize_changes',
      description: 'Finalize the change set and report completion.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Concise summary of the integration work.'
          },
          confidence: {
            type: 'number',
            description: 'Confidence score between 0 and 1.'
          }
        },
        required: []
      }
    }
  }
];

export async function integratePack(params: IntegratePackParams): Promise<IntegrationResult> {
  const verboseLog = params.verbose
    ? (message: string) => console.log(`[plgin:apply] ${message}`)
    : undefined;

  verboseLog?.(`Loading pack from ${params.packRef}`);
  const pack = await loadPack(params.packRef);
  const targetLanguage = params.targetLanguage === 'auto-detect'
    ? inferPrimaryLanguage(pack)
    : params.targetLanguage;
  const profile = await deriveProjectProfile(targetLanguage);
  verboseLog?.(`Target language resolved to ${targetLanguage}`);

  let semanticHints = Array.isArray(params.semanticHints) ? [...params.semanticHints] : [];
  if ((params.fast || semanticHints.length === 0) && params.semanticProvider?.isEnabled()) {
    try {
      const hits = await params.semanticProvider.searchPacks(pack.manifest.name, targetLanguage);
      const normalizedName = pack.manifest.name.toLowerCase();
      const limit = params.fast ? 3 : 2;
      const mapped = hits
        .filter((hit) => hit.packName.toLowerCase() === normalizedName || !normalizedName)
        .slice(0, limit)
        .map((hit) => {
          const tagSummary = hit.tags?.length ? ` [${hit.tags.slice(0, 3).join(', ')}]` : '';
          return `${hit.packName}@${hit.version}: ${hit.summary}${tagSummary}`;
        });
      for (const hint of mapped) {
        if (!semanticHints.includes(hint)) {
          semanticHints.push(hint);
        }
      }
      semanticHints = semanticHints.slice(0, limit);
    } catch (error) {
      verboseLog?.(`Semantic hint lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (semanticHints.length) {
    verboseLog?.(`Using ${semanticHints.length} semantic hint(s) to guide integration.`);
  }

  const requiresAgentic = params.agentic || !hasLanguageExample(pack, targetLanguage);
  verboseLog?.(`Integration mode: ${requiresAgentic ? 'agentic (implementFeature)' : 'direct adaptation via adaptPack'}`);

  if (requiresAgentic) {
    verboseLog?.('Invoking integration tool loop to synthesize change set');
    const integrationPrompt = buildIntegrationPrompt({
      pack,
      profile,
      targetLanguage,
      projectRoot: process.cwd(),
      extraInstructions: params.instructions,
      semanticHints,
      fastMode: Boolean(params.fast)
    });
    const changeSet = await params.agent.integrateWithTools({
      systemPrompt: params.agent.systemPrompt,
      initialUserPrompt: integrationPrompt,
      tools: INTEGRATION_TOOLS,
      pack,
      projectRoot: process.cwd(),
      verbose: params.verbose,
      maxIterations: params.fast ? 5 : undefined
    });
    const minConfidence = typeof pack.manifest.ai_adaptation?.min_confidence === 'number'
      ? pack.manifest.ai_adaptation.min_confidence
      : 0;
    const normalizedConfidence = Math.max(
      params.agent.scoreConfidence(changeSet.confidence),
      minConfidence
    );
    const normalizedChangeSet: ChangeSet = {
      ...changeSet,
      confidence: normalizedConfidence
    };
    verboseLog?.(`Change set contains ${normalizedChangeSet.items.length} item(s)`);
    const vulnerabilities = await params.agent.scanForVulns(
      normalizedChangeSet.items.map((item) => item.contents).join('\n'),
      targetLanguage
    );
    verboseLog?.('Building preview artifacts for agentic implementation');
    const preview = await preparePreview(normalizedChangeSet, `agentic-${pack.manifest.name}`, verboseLog);
    return {
      changeSet: normalizedChangeSet,
      testsRun: !params.dryRun,
      vulnerabilities,
      diffs: preview.diffs,
      previewDir: preview.previewDir
    };
  }

  verboseLog?.('Invoking agent.adaptPack to tailor existing implementation');
  const adapted = await params.agent.adaptPack(
    pack,
    process.cwd(),
    params.instructions
  );
  verboseLog?.(`Change set contains ${adapted.items.length} item(s)`);
  const vulnerabilities = await params.agent.scanForVulns(
    adapted.items.map((item) => item.contents).join('\n'),
    targetLanguage
  );
  verboseLog?.('Building preview artifacts for adapted implementation');
  const preview = await preparePreview(adapted, `adapted-${pack.manifest.name}`, verboseLog);
  return {
    changeSet: adapted,
    testsRun: !params.dryRun,
    vulnerabilities,
    diffs: preview.diffs,
    previewDir: preview.previewDir
  };
}

function buildIntegrationPrompt(options: {
  pack: Pack;
  profile: ProjectProfile;
  targetLanguage: string;
  projectRoot: string;
  extraInstructions?: string;
  semanticHints?: string[];
  fastMode?: boolean;
}): string {
  const { pack, profile, targetLanguage, projectRoot, extraInstructions, semanticHints = [], fastMode } = options;
  const manifest = pack.manifest;
  const projectSummary = [
    `Target language: ${targetLanguage}`,
    `Naming convention: ${profile.naming}`,
    `Frameworks: ${profile.frameworks.join(', ') || 'agnostic'}`,
    `Structure: ${profile.structure}`
  ].join('\n');
  const manifestSummary = JSON.stringify({
    name: manifest.name,
    description: manifest.description,
    provides: manifest.provides,
    requirements: manifest.requirements,
    examples: manifest.examples?.entries ?? manifest.examples ?? {}
  }, null, 2);

  const instructions = [
    `Integrate the PLGN pack "${manifest.name}" into the project at ${projectRoot}.`,
    'Use the provided tools to inspect both the project and the pack source files.',
    'When proposing updates, call write_change with the full desired file contents.',
    'For deletions, call delete_change so the CLI can apply them deterministically.',
    'Prefer adapting pack source files under source/ to match project conventions.',
    'Ensure tests and supporting assets are created or updated as needed.',
    'Always end by calling finalize_changes with a concise summary and confidence between 0 and 1.',
    `Project profile:\n${projectSummary}`,
    `Pack manifest summary:\n${manifestSummary}`
  ];

  if (fastMode) {
    instructions.unshift('Fast mode is enabled: focus on high-impact changes, avoid redundant analysis, and finalise once the core integration is ready.');
  }

  if (extraInstructions?.trim()) {
    instructions.push(`Additional user instructions: ${extraInstructions.trim()}`);
  }

  if (semanticHints.length) {
    instructions.push(`Semantic hints from registry:\n${semanticHints.map((hint) => `- ${hint}`).join('\n')}`);
  }

  return instructions.join('\n\n');
}

async function preparePreview(
  changeSet: ChangeSet,
  label: string,
  logger?: (message: string) => void
): Promise<{ diffs: FileDiff[]; previewDir?: string }> {
  if (!changeSet.items.length) {
    logger?.('No preview generated because the change set is empty');
    return { diffs: [], previewDir: undefined };
  }

  const { diffs, previewDir } = await buildChangeSetPreview(changeSet, {
    projectRoot: process.cwd(),
    cacheDir: resolveActiveCacheDir(),
    previewLabel: label,
    logger
  });

  return { diffs, previewDir };
}

async function loadPack(ref: string): Promise<Pack> {
  let packDir: string | undefined;

  // First, try local paths
  const candidatePaths = [
    ref,
    resolve(process.cwd(), ref),
    resolve(process.cwd(), 'packs', ref)
  ];
  for (const candidate of candidatePaths) {
    const resolvedCandidate = resolve(candidate);
    if (await pathExists(resolvedCandidate)) {
      packDir = resolvedCandidate;
      break;
    }
  }

  // If not local, try registry
  if (!packDir) {
    packDir = await downloadPackFromRegistry(ref);
  }

  const manifestPath = join(packDir, 'manifest.json');
  if (!(await pathExists(manifestPath))) {
    throw new Error(`manifest.json missing in pack ${packDir}`);
  }
  const manifest = (await readJson(manifestPath)) as PackManifest;
  const sourceDir = join(packDir, 'source');
  const sourcePaths = (await pathExists(sourceDir)) ? await listFilesRecursive(sourceDir) : [];
  return {
    manifest,
    rootDir: packDir,
    sourcePaths
  };
}

async function downloadPackFromRegistry(ref: string): Promise<string> {
  const proxyUrl = getRegistryEndpoint();
  const entries: RegistryEntry[] = await fetchRegistryFromProxy(proxyUrl);

  let targetEntry: RegistryEntry | undefined;
  const [name, version] = ref.split('@');

  if (version) {
    // Exact version match
    targetEntry = entries.find(e => e.name === name && e.version === version);
  } else {
    // Find latest version for the name
    const nameEntries = entries.filter(e => e.name === name);
    if (nameEntries.length === 0) {
      throw new Error(`Pack not found in registry: ${name}`);
    }
    // Simple version sort (assumes semver, takes highest numeric)
    targetEntry = nameEntries.reduce((latest, current) =>
      compareVersions(latest.version, current.version) > 0 ? latest : current
    );
  }

  if (!targetEntry) {
    throw new Error(`Pack version not found in registry: ${ref}`);
  }

  const token = resolveGitHubToken();
  const headers: Record<string, string> = { 'User-Agent': 'plgin-cli/2.0.5' };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const response = await fetch(targetEntry.downloadUrl, { headers });
  if (!response.ok) {
    throw new Error(`Failed to download pack: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const tempDir = join(process.env.TMPDIR || '/tmp', `plgin-${targetEntry.name}-${Date.now()}`);
  await ensureDir(tempDir);

  const tempTarPath = join(tempDir, `${targetEntry.name}.tgz`);
  await writeFile(tempTarPath, buffer);

  try {
    await extract({
      file: tempTarPath,
      cwd: tempDir
    });
    await remove(tempTarPath); // Clean up temp tar file
  } catch (error) {
    await remove(tempDir);
    throw new Error(`Failed to extract pack: ${error instanceof Error ? error.message : String(error)}`);
  }

  return tempDir;
}

function compareVersions(v1: string, v2: string): number {
  // Simple semver compare: split by . and compare numerically
  const parts1 = v1.split('.').map(p => parseInt(p, 10));
  const parts2 = v2.split('.').map(p => parseInt(p, 10));
  const len = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

function computeCompatibility(pack: Pack, targetLanguage: string): CompatibilityReport {
  const languages = pack.manifest.requirements.languages ?? ['any'];
  const compatible = targetLanguage === 'auto-detect' || languages.includes(targetLanguage) || languages.includes('any');
  const reasons: string[] = [];
  if (!compatible) {
    reasons.push(`${pack.manifest.name} lacks support for ${targetLanguage}.`);
  }
  return {
    compatible,
    reasons,
    recommendedLanguage: languages[0] ?? 'any'
  };
}

function inferPrimaryLanguage(pack: Pack): string {
  if (pack.manifest.requirements.languages?.length) {
    return pack.manifest.requirements.languages[0];
  }
  if (pack.sourcePaths.length) {
    return detectLanguageFromPath(pack.sourcePaths[0]);
  }
  return 'any';
}

async function deriveProjectProfile(language: string): Promise<ProjectProfile> {
  const naming = language === 'python' ? 'snake_case' : 'camelCase';
  const structure = language === 'java' ? 'mvc' : 'modular';
  const frameworks = language === 'javascript' ? ['react'] : ['agnostic'];
  return {
    language,
    naming,
    structure,
    frameworks
  };
}

function hasLanguageExample(pack: Pack, language: string): boolean {
  if (!pack.manifest.examples) return false;
  if (Array.isArray(pack.manifest.examples)) {
    return pack.manifest.examples.some((example) => example.language === language);
  }
  const entries = (pack.manifest.examples as Record<string, unknown>).entries;
  if (Array.isArray(entries)) {
    return entries.some((entry) => (entry as { language?: string }).language === language);
  }
  return false;
}
