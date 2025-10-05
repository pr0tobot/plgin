import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import fsExtra from 'fs-extra';
const { ensureDir, pathExists, copy, writeJson, readJson } = fsExtra;
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
  PackImplementationPlan,
  ToolDefinition
} from './types.js';


const AGENTIC_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files within a directory relative to the workspace.',
      parameters: {
        type: 'object',
        properties: {
          relative_dir: {
            type: 'string',
            description: 'Directory relative to the workspace to inspect.'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace to understand existing content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file inside the workspace.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'detect_language',
      description: 'Infer language from a file path to organize code correctly.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to analyze.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ensure_dir',
      description: 'Create a directory within the workspace if it does not exist.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to ensure inside the workspace.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Destination file path relative to the workspace.' },
          content: { type: 'string', description: 'UTF-8 file contents to write.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_manifest',
      description: 'Persist a complete manifest.json for the pack.',
      parameters: {
        type: 'object',
        properties: {
          manifest: {
            type: 'object',
            description: 'Full manifest object to write to manifest.json.'
          }
        },
        required: ['manifest']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'copy_tree',
      description: 'Copy a directory or file tree from the project into the workspace.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Path relative to the current working directory to copy from.'
          },
          dest: {
            type: 'string',
            description: 'Destination directory relative to the workspace.'
          }
        },
        required: ['source', 'dest']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'log_progress',
      description: 'Write a progress update to the pack logs.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Progress message to append to logs.' }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finalize_pack',
      description: 'Signal that the pack is ready. Triggers normalization and security scan.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  }
];


export async function createPackFromSource(params: CreatePackParams): Promise<CreatePackResult> {
  if (!params.request.path) {
    throw new Error('Source path is required for non-agentic extraction.');
  }
  const sourcePath = normalizePath(String(params.request.path));
  if (!(await pathExists(sourcePath))) {
    throw new Error(`Source path not found: ${sourcePath}`);
  }

  const semanticHints = params.semanticHints ?? [];
  const fastMode = Boolean(params.request.fast);

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

  if (params.request.agentic) {
    let agenticPrompt = [
      `Extract the feature "${params.request.featureName}" from the project path "${sourcePath}".`,
      `Use the available tools to inspect the code, copy relevant assets into the workspace (${baseDir}), and build a production-ready PLGN pack.`,
      'Requirements:',
      '1. Mirror all needed implementation files under source/<language>/ preserving structure (use copy_tree or write_file).',
      '2. Generate a rich manifest with description, dependencies, frameworks, provides.feature, and modularBreakdown derived from the code (use write_manifest).',
      '3. Populate patterns/*.json with real conventions and dependency insights (avoid placeholders).',
      '4. Populate agents/ prompts and variations with actionable guidance for adapting this feature.',
      '5. Create meaningful tests in tests/ that exercise the feature behaviour.',
      '6. Log major milestones with log_progress and call finalize_pack when the pack is complete.',
      'Note: list_files operates inside the workspace. Use copy_tree with project-relative paths (e.g., "src/data") to import code before inspecting it with read_file or detect_language.',
      `Set manifest.name to "${normalizedName}" and ensure ai_adaptation.agent_model reflects ${params.agent.defaults.model}.`,
      `Work from the source path: ${sourcePath}.`
    ].join('\n');

    if (semanticHints.length) {
      agenticPrompt += `\nSemantic hints:\n${semanticHints.map((hint) => `- ${hint}`).join('\n')}`;
    }

    const agenticPack = await params.agent.runToolLoop({
      systemPrompt: params.agent.systemPrompt,
      initialUserPrompt: agenticPrompt,
      tools: AGENTIC_TOOLS,
      workspace: baseDir,
      verbose: Boolean(params.request.verbose),
      timeoutMs: params.request.timeoutMs,
      maxIterations: fastMode ? 4 : undefined
    });

    const manifestPath = join(baseDir, 'manifest.json');
    let manifest: PackManifest = agenticPack.manifest;
    if (await pathExists(manifestPath)) {
      try {
        manifest = await readJson(manifestPath) as PackManifest;
      } catch {
        // fall back to agenticPack.manifest
      }
    }

    manifest.name = normalizedName;
    await writeJson(manifestPath, manifest, { spaces: 2 });

    return {
      path: baseDir,
      manifest
    };
  }

  const pack = await params.agent.extractFeature(
    sourcePath,
    params.request.featureName,
    params.request.language,
    {
      hints: semanticHints,
      fast: fastMode
    }
  );
  return materializePack(pack, {
    nameOverride: params.name,
    outputDir: params.outputDir
  });
}

export async function createPackFromPrompt(params: CreatePackParams): Promise<CreatePackResult> {
  const semanticHints = params.semanticHints ?? [];
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

  if (semanticHints.length) {
    manifest.description = `${manifest.description}\n\nSemantic hints:\n${semanticHints.map((hint) => `- ${hint}`).join('\n')}`;
  }

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

  const languages = dedupe(
    pack.sourcePaths.map((file) => detectLanguageFromPath(file)).filter(Boolean)
  );
  if (!languages.length && manifest.requirements.languages?.length) {
    languages.push(...manifest.requirements.languages);
  }

  await ensureDir(join(baseDir, 'source'));
  // Expose workspace path for agent logs
  process.env.PLGN_PACK_DIR = baseDir;
  const sourcePathMap = new Map<string, string>();
  for (const file of pack.sourcePaths) {
    const language = detectLanguageFromPath(file) || 'misc';
    const relativePath = relative(pack.rootDir, file);
    const destinationRelative = join('source', language, relativePath || basename(file));
    const destination = join(baseDir, destinationRelative);
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
    sourcePathMap.set(file, destinationRelative);
  }

  if (manifest.source_credits?.original?.startsWith('/')) {
    manifest.source_credits.original = `extracted-feature-${manifest.name}`;
  }

  if (manifest.examples?.entries) {
    manifest.examples.entries = manifest.examples.entries.map((entry: any) => {
      const mappedPath = sourcePathMap.get(entry.path);
      const language = entry.language ?? detectLanguageFromPath(entry.path) ?? 'unknown';
      return {
        ...entry,
        path: mappedPath ?? entry.path,
        language
      };
    });
  }

  await writeJson(join(baseDir, 'manifest.json'), manifest, { spaces: 2 });

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
