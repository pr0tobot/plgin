import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import fsExtra from 'fs-extra';
const { ensureDir, pathExists, copy, writeJson } = fsExtra;
import {
  dedupe,
  detectLanguageFromPath,
  writeText
} from './utils/fs.js';
import type {
  CreatePackParams,
  CreatePackResult,
  Pack,
  PackManifest,
  PackImplementationPlan
} from './types.js';


export async function createPackFromSource(params: CreatePackParams): Promise<CreatePackResult> {
  if (!params.request.path) {
    throw new Error('Source path is required for non-agentic extraction.');
  }
  const sourcePath = normalizePath(String(params.request.path));
  if (!(await pathExists(sourcePath))) {
    throw new Error(`Source path not found: ${sourcePath}`);
  }

  // Early materialization: create workspace and initial manifest/logs so partial results persist on abort.
  const normalizedName = sanitizeName(params.name ?? params.request.featureName);
  const baseDir = resolve(process.cwd(), params.outputDir, normalizedName);
  await ensureDir(baseDir);
  await ensureDir(join(baseDir, 'logs'));
  await ensureDir(join(baseDir, 'source'));
  // Expose workspace path for agent logs
  process.env.PLGN_PACK_DIR = baseDir;

  const initialManifest: PackManifest = {
    name: normalizedName,
    version: '0.1.0',
    description: `Creating pack for ${params.request.featureName}...`,
    source_credits: {
      original: sourcePath,
      opt_out_training: false
    },
    requirements: {
      languages: [params.request.language ?? 'any'],
      frameworks: ['agnostic'],
      minVersion: {}
    },
    provides: {
      feature: params.request.featureName
    },
    examples: {},
    ai_adaptation: {
      strategy: 'agentic-hybrid',
      agent_model: params.agent.defaults.model,
      preserve: ['security-measures'],
      adaptable: ['lang-syntax', 'file-structure'],
      min_confidence: 0.8
    }
  };

  await writeJson(join(baseDir, 'manifest.json'), initialManifest, { spaces: 2 });
  await writeText(join(baseDir, 'logs', 'create.log'), `[${new Date().toISOString()}] Pack creation started\n`);

  const pack = await params.agent.extractFeature(
    sourcePath,
    params.request.featureName,
    params.request.language
  );
  return materializePack(pack, {
    nameOverride: params.name,
    outputDir: params.outputDir
  });
}

export async function createPackFromPrompt(params: CreatePackParams): Promise<CreatePackResult> {
  const language = params.request.language ?? params.agent.defaults.language ?? 'any';
  const normalizedLanguage = language === 'auto-detect' ? 'any' : language;
  const featureName = params.request.featureName;
  const manifest: PackManifest = {
    name: params.name ?? featureName,
    version: '0.1.0',
    description: params.request.prompt
      ? `Agentic pack generated from prompt: ${params.request.prompt}`
      : `Agentic pack for ${featureName}`,
    source_credits: {
      original: 'agentic-generation',
      opt_out_training: false
    },
    requirements: {
      languages: [normalizedLanguage],
      frameworks: ['agnostic'],
      minVersion: {}
    },
    provides: {
      feature: featureName
    },
    examples: {},
    ai_adaptation: {
      strategy: 'agentic-hybrid',
      agent_model: params.agent.defaults.model,
      preserve: ['security-measures'],
      adaptable: ['lang-syntax', 'file-structure'],
      min_confidence: 0.8
    }
  };

  const provisionalPack: Pack = {
    manifest,
    rootDir: process.cwd(),
    sourcePaths: []
  };

  const profile = {
    language: normalizedLanguage,
    frameworks: ['agnostic'],
    naming: normalizedLanguage === 'python' ? 'snake_case' : 'camelCase',
    structure: 'modular'
  };

  const plan: PackImplementationPlan = await params.agent.planImplementation(
    provisionalPack,
    normalizedLanguage,
    profile
  );

  const implemented = await params.agent.implementFeature(
    provisionalPack,
    normalizedLanguage,
    profile
  );

  const packWithImplementation: Pack = {
    ...provisionalPack,
    sourcePaths: implemented.files.map((file) => join(process.cwd(), file.path)),
    manifest: {
      ...manifest,
      requirements: {
        ...manifest.requirements,
        languages: [normalizedLanguage]
      },
      provides: {
        ...manifest.provides,
        plan
      },
      examples: {
        entries: implemented.files.map((file) => ({
          path: file.path,
          language: file.language
        }))
      }
    }
  };

  return materializePack(packWithImplementation, {
    nameOverride: params.name,
    outputDir: params.outputDir,
    implemented
  });
}

async function materializePack(pack: Pack, options: {
  nameOverride?: string;
  outputDir: string;
  implemented?: {
    files: { path: string; contents: string; language: string; action: string }[];
    tests?: { path: string; contents: string; language: string; action: string }[];
    docs?: { path: string; contents: string; language: string; action: string }[];
  };
}): Promise<CreatePackResult> {
  const normalizedName = sanitizeName(options.nameOverride ?? pack.manifest.name);
  const baseDir = resolve(process.cwd(), options.outputDir, normalizedName);
  await ensureDir(baseDir);

  const manifest: PackManifest = {
    ...pack.manifest,
    name: normalizedName
  };

  await writeJson(join(baseDir, 'manifest.json'), manifest, { spaces: 2 });

  const languages = dedupe(
    pack.sourcePaths.map((file) => detectLanguageFromPath(file)).filter(Boolean)
  );
  if (!languages.length && manifest.requirements.languages?.length) {
    languages.push(...manifest.requirements.languages);
  }

  await ensureDir(join(baseDir, 'source'));
  // Expose workspace path for agent logs
  process.env.PLGN_PACK_DIR = baseDir;
  for (const file of pack.sourcePaths) {
    const language = detectLanguageFromPath(file) || 'misc';
    const relativePath = relative(pack.rootDir, file);
    const destination = join(baseDir, 'source', language, relativePath || basename(file));
    await ensureDir(dirname(destination));
    if (await pathExists(file)) {
      await copy(file, destination);
    } else {
      const implemented = options.implemented?.files?.find((item) =>
        resolve(process.cwd(), item.path) === file
      );
      const contents = implemented?.contents ?? `Placeholder for ${file}`;
      await writeText(destination, contents);
    }
  }

  await ensureDir(join(baseDir, 'patterns'));
  await writeJson(join(baseDir, 'patterns', 'structure.json'), {
    file_hierarchy: 'modular',
    naming: languages.includes('python') ? 'snake_case' : 'camelCase'
  }, { spaces: 2 });
  await writeJson(join(baseDir, 'patterns', 'conventions.json'), {
    error_handling: languages.includes('python') ? 'exceptions' : 'try-catch',
    async: languages.includes('javascript') ? 'promises' : 'sync'
  }, { spaces: 2 });
  await writeJson(join(baseDir, 'patterns', 'dependencies.json'), {
    required: []
  }, { spaces: 2 });
  await writeJson(join(baseDir, 'patterns', 'embeddings.json'), {
    model: manifest.ai_adaptation.agent_model,
    status: 'pending'
  }, { spaces: 2 });

  await ensureDir(join(baseDir, 'agents'));
  await writeText(join(baseDir, 'agents', 'core-agent.md'), `# PLGN Core Agent\n\n${manifest.description}`);
  await writeJson(join(baseDir, 'agents', 'variations.json'), {
    default: {
      language: manifest.requirements.languages[0] ?? 'any',
      prompt: 'Use project conventions when adapting.'
    }
  }, { spaces: 2 });
  await writeText(join(baseDir, 'agents', 'test-generator.md'), '# Test generation prompt\nEnsure coverage for golden paths and edge cases.');
  await writeText(join(baseDir, 'agents', 'vuln-checker.md'), '# Vulnerability scan prompt\nUse SAST heuristics to flag risky calls.');

  await ensureDir(join(baseDir, 'tests'));
  const primaryLanguage = manifest.requirements.languages[0] ?? 'any';
  if (primaryLanguage === 'python') {
    await writeText(join(baseDir, 'tests', 'unit.test.py'), 'def test_placeholder():\n    assert True\n');
  } else if (primaryLanguage === 'javascript' || primaryLanguage === 'typescript') {
    await writeText(join(baseDir, 'tests', 'integration.test.js'), 'describe("placeholder", () => {\n  it("works", () => expect(true).toBe(true));\n});\n');
  } else {
    await writeText(join(baseDir, 'tests', 'smoke.test.txt'), 'placeholder test');
  }

  if (options.implemented) {
    await ensureDir(join(baseDir, 'generated'));
    await materializeChangeSet(join(baseDir, 'generated'), options.implemented.files);
    if (options.implemented.tests) {
      await materializeChangeSet(join(baseDir, 'generated'), options.implemented.tests);
    }
    if (options.implemented.docs) {
      await materializeChangeSet(join(baseDir, 'generated'), options.implemented.docs);
    }
  }

  return {
    path: baseDir,
    manifest
  };
}

async function materializeChangeSet(baseDir: string, items: { path: string; contents: string }[]): Promise<void> {
  for (const item of items) {
    const target = join(baseDir, item.path);
    await ensureDir(dirname(target));
    await writeText(target, item.contents);
  }
}

function sanitizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'plgn-pack';
}

function normalizePath(path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(process.cwd(), path);
}
