import { join, resolve } from 'node:path';
import fsExtra from 'fs-extra';
const { pathExists, readJson } = fsExtra;
import {
  detectLanguageFromPath,
  listFilesRecursive
} from './utils/fs.js';
import type {
  CompatibilityOptions,
  CompatibilityReport,
  IntegratePackParams,
  Pack,
  ChangeSet,
  ChangeSetItem,
  IntegrationResult,
  ProjectProfile,
  PackManifest
} from './types.js';

export async function checkCompatibility(options: CompatibilityOptions): Promise<CompatibilityReport> {
  const pack = await loadPack(options.packRef);
  return computeCompatibility(pack, options.targetLanguage);
}

export async function integratePack(params: IntegratePackParams): Promise<IntegrationResult> {
  const pack = await loadPack(params.packRef);
  const targetLanguage = params.targetLanguage === 'auto-detect'
    ? inferPrimaryLanguage(pack)
    : params.targetLanguage;
  const profile = await deriveProjectProfile(targetLanguage);

  const requiresAgentic = params.agentic || !hasLanguageExample(pack, targetLanguage);

  if (requiresAgentic) {
    const implemented = await params.agent.implementFeature(pack, targetLanguage, profile);
    const allItems: ChangeSetItem[] = [
      ...implemented.files,
      ...(implemented.tests ?? []),
      ...(implemented.docs ?? [])
    ];
    const baseConfidence = params.agent.scoreConfidence(implemented.confidence);
    const minConfidence = typeof pack.manifest.ai_adaptation?.min_confidence === 'number'
      ? pack.manifest.ai_adaptation.min_confidence
      : 0;
    const changeSet: ChangeSet = {
      items: allItems,
      summary: `Agentic implementation for ${pack.manifest.name}`,
      confidence: Math.max(baseConfidence, minConfidence)
    };
    const vulnerabilities = await params.agent.scanForVulns(
      allItems.map((item) => item.contents).join('\n'),
      targetLanguage
    );
    return {
      changeSet,
      testsRun: !params.dryRun,
      vulnerabilities
    };
  }

  const adapted = await params.agent.adaptPack(
    pack,
    process.cwd(),
    params.instructions
  );
  const vulnerabilities = await params.agent.scanForVulns(
    adapted.items.map((item) => item.contents).join('\n'),
    targetLanguage
  );
  return {
    changeSet: adapted,
    testsRun: !params.dryRun,
    vulnerabilities
  };
}

async function loadPack(ref: string): Promise<Pack> {
  const candidatePaths = [
    ref,
    resolve(process.cwd(), ref),
    resolve(process.cwd(), 'packs', ref)
  ];
  let packDir: string | undefined;
  for (const candidate of candidatePaths) {
    if (await pathExists(candidate)) {
      packDir = candidate;
      break;
    }
  }
  if (!packDir) {
    throw new Error(`Pack not found for reference: ${ref}`);
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
