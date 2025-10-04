import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'fs-extra';
import { tmpdir } from 'node:os';
import { createAgent } from '../../cli/src/agent.js';
import { createPackFromSource, createPackFromPrompt } from '../../cli/src/creator.js';
import { integratePack, checkCompatibility } from '../../cli/src/integrator.js';
import { discoverPacks, publishPack } from '../../cli/src/registry.js';
import type { ConfigFile } from '../../cli/src/types.js';

const TEST_CONFIG: ConfigFile = {
  defaults: {
    provider: 'openrouter',
    model: 'z-ai/glm-4.6',
    temperature: 0.3,
    language: 'auto-detect',
    securityScanner: 'snyk'
  },
  providerOptions: {},
  tokens: {
    openrouter: process.env.OPENROUTER_API_KEY || process.env.PLGN_API_KEY
  }
};

describe('PLGN E2E Tests', () => {
  let tempDir: string;
  let cacheDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'plgn-test-'));
    cacheDir = join(tempDir, 'cache');
    await mkdir(cacheDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Agent', () => {
    it('should create an agent with proper configuration', () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      expect(agent).toBeDefined();
      expect(agent.defaults.provider).toBe('openrouter');
      expect(agent.defaults.model).toBe('z-ai/glm-4.6');
      expect(agent.systemPrompt).toContain('PLGN');
    });

    it('should extract feature from source code', async () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      const sourceDir = join(tempDir, 'sample-feature');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        join(sourceDir, 'index.ts'),
        `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export default greet;
`
      );

      const pack = await agent.extractFeature(sourceDir, 'greet-feature', 'typescript');

      expect(pack).toBeDefined();
      expect(pack.manifest.name).toBe('greet-feature');
      expect(pack.manifest.requirements.languages).toContain('typescript');
      expect(pack.sourcePaths.length).toBeGreaterThan(0);
    });

    it('should score confidence correctly', () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      expect(agent.scoreConfidence(0.9)).toBe(0.9);
      expect(agent.scoreConfidence({ confidence: 0.85 })).toBe(0.85);
      expect(agent.scoreConfidence('invalid')).toBe(0.8);
    });

    it('should scan for vulnerabilities', async () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      const vulnCode = `
const password = "hardcoded123";
eval(userInput);
`;

      const report = await agent.scanForVulns(vulnCode, 'javascript');

      expect(report).toBeDefined();
      expect(report.scanner).toBe('snyk');
      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.findings.some(f => f.severity === 'high' || f.severity === 'critical')).toBe(true);
    });
  });

  describe('Pack Creator', () => {
    it('should create pack from source', async () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      const sourceDir = join(tempDir, 'auth-feature');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        join(sourceDir, 'auth.js'),
        `export function authenticate(credentials) {
  return credentials.valid === true;
}
`
      );

      const result = await createPackFromSource({
        agent,
        request: {
          path: sourceDir,
          featureName: 'auth-pack',
          language: 'javascript'
        },
        outputDir: join(tempDir, 'packs'),
        name: 'auth-pack'
      });

      expect(result).toBeDefined();
      expect(result.manifest.name).toBe('auth-pack');
      expect(result.path).toContain('auth-pack');
    });

    it('should create pack from prompt (agentic)', async () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      const result = await createPackFromPrompt({
        agent,
        request: {
          featureName: 'rate-limiter',
          language: 'typescript',
          agentic: true,
          prompt: 'Create a rate limiter utility for API requests'
        },
        outputDir: join(tempDir, 'packs-agentic'),
        name: 'rate-limiter'
      });

      expect(result).toBeDefined();
      expect(result.manifest.name).toBe('rate-limiter');
      expect(result.manifest.description).toContain('rate limiter');
    });
  });

  describe('Pack Integrator', () => {
    it('should check compatibility', async () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      const sourceDir = join(tempDir, 'compat-feature');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'feature.py'), 'def hello(): return "hello"');

      const pack = await agent.extractFeature(sourceDir, 'python-feature', 'python');
      const packDir = join(tempDir, 'test-pack');
      await mkdir(packDir, { recursive: true });
      await writeFile(join(packDir, 'manifest.json'), JSON.stringify(pack.manifest, null, 2));

      const compat = await checkCompatibility({
        packRef: packDir,
        targetLanguage: 'python'
      });

      expect(compat.compatible).toBe(true);
      expect(compat.recommendedLanguage).toBe('python');
    });

    it('should integrate pack with adaptation', async () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      const sourceDir = join(tempDir, 'integrate-feature');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        join(sourceDir, 'util.ts'),
        'export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);'
      );

      const pack = await agent.extractFeature(sourceDir, 'text-utils', 'typescript');
      const packDir = join(tempDir, 'text-utils-pack');
      await mkdir(packDir, { recursive: true });
      await mkdir(join(packDir, 'source'), { recursive: true });
      await writeFile(join(packDir, 'manifest.json'), JSON.stringify(pack.manifest, null, 2));

      const result = await integratePack({
        agent,
        packRef: packDir,
        instructions: 'Add logging',
        dryRun: true,
        agentic: false,
        targetLanguage: 'typescript'
      });

      expect(result).toBeDefined();
      expect(result.changeSet).toBeDefined();
      expect(result.vulnerabilities).toBeDefined();
    });
  });

  describe('Registry', () => {
    it('should publish pack to local registry', async () => {
      const packDir = join(tempDir, 'registry-pack');
      await mkdir(packDir, { recursive: true });

      const manifest = {
        name: 'test-pack',
        version: '1.0.0',
        description: 'Test pack for registry',
        source_credits: { original: 'test', opt_out_training: false },
        requirements: {
          languages: ['javascript'],
          frameworks: ['agnostic'],
          minVersion: {}
        },
        provides: { feature: 'test' },
        examples: {},
        ai_adaptation: {
          strategy: 'agentic-hybrid' as const,
          agent_model: 'z-ai/glm-4.6',
          preserve: [],
          adaptable: [],
          min_confidence: 0.8
        }
      };

      await writeFile(join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      await publishPack({
        packDir,
        defaults: TEST_CONFIG.defaults
      });

      const packs = await discoverPacks({}, TEST_CONFIG.defaults);

      expect(packs.length).toBeGreaterThan(0);
      expect(packs.some(p => p.name === 'test-pack')).toBe(true);
    });

    it('should discover packs by language', async () => {
      const packDir = join(tempDir, 'python-pack');
      await mkdir(packDir, { recursive: true });

      const manifest = {
        name: 'python-utils',
        version: '1.0.0',
        description: 'Python utilities',
        source_credits: { original: 'test', opt_out_training: false },
        requirements: {
          languages: ['python'],
          frameworks: ['agnostic'],
          minVersion: {}
        },
        provides: { feature: 'utils' },
        examples: {},
        ai_adaptation: {
          strategy: 'agentic-hybrid' as const,
          agent_model: 'z-ai/glm-4.6',
          preserve: [],
          adaptable: [],
          min_confidence: 0.8
        }
      };

      await writeFile(join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      await publishPack({
        packDir,
        defaults: TEST_CONFIG.defaults
      });

      const pythonPacks = await discoverPacks(
        { language: 'python' },
        TEST_CONFIG.defaults
      );

      expect(pythonPacks.length).toBeGreaterThan(0);
      expect(pythonPacks.every(p => p.languages.includes('python') || p.languages.includes('any'))).toBe(true);
    });
  });

  describe('Multi-language Support', () => {
    it('should handle JavaScript to TypeScript adaptation', async () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      const sourceDir = join(tempDir, 'js-feature');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        join(sourceDir, 'module.js'),
        'module.exports = { add: (a, b) => a + b };'
      );

      const pack = await agent.extractFeature(sourceDir, 'math-utils', 'javascript');
      const implemented = await agent.implementFeature(pack, 'typescript', {
        language: 'typescript',
        frameworks: ['node'],
        naming: 'camelCase',
        structure: 'modular'
      });

      expect(implemented.files.length).toBeGreaterThan(0);
      expect(implemented.tests).toBeDefined();
      expect(implemented.confidence).toBeGreaterThan(0.7);
    });

    it('should handle Python feature implementation', async () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      const pack = {
        manifest: {
          name: 'data-validator',
          version: '1.0.0',
          description: 'Validates data structures',
          source_credits: { original: 'test', opt_out_training: false },
          requirements: {
            languages: ['any'],
            frameworks: ['agnostic'],
            minVersion: {}
          },
          provides: { feature: 'validation' },
          examples: {},
          ai_adaptation: {
            strategy: 'agentic-hybrid' as const,
            agent_model: 'z-ai/glm-4.6',
            preserve: ['security-measures'],
            adaptable: ['lang-syntax'],
            min_confidence: 0.8
          }
        },
        rootDir: tempDir,
        sourcePaths: []
      };

      const implemented = await agent.implementFeature(pack, 'python', {
        language: 'python',
        frameworks: ['agnostic'],
        naming: 'snake_case',
        structure: 'modular'
      });

      expect(implemented.files.length).toBeGreaterThan(0);
      const pythonFile = implemented.files[0];
      expect(pythonFile.contents).toContain('class');
      expect(pythonFile.language).toBe('python');
    });
  });

  describe('Security', () => {
    it('should detect eval usage', async () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      const badCode = 'eval(userInput); console.log("done");';
      const report = await agent.scanForVulns(badCode, 'javascript');

      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.findings.some(f => f.id.includes('EVAL'))).toBe(true);
    });

    it('should detect hardcoded credentials', async () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      const badCode = 'const password = "secret123"; authenticate(password);';
      const report = await agent.scanForVulns(badCode, 'javascript');

      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.findings.some(f => f.severity === 'critical')).toBe(true);
    });
  });

  describe('Caching', () => {
    it('should cache extraction results', async () => {
      const agent = createAgent({
        config: TEST_CONFIG,
        token: TEST_CONFIG.tokens.openrouter,
        cacheDir
      });

      const sourceDir = join(tempDir, 'cache-test');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'cached.ts'), 'export const x = 1;');

      const pack1 = await agent.extractFeature(sourceDir, 'cached-feature', 'typescript');
      const pack2 = await agent.extractFeature(sourceDir, 'cached-feature', 'typescript');

      expect(pack1.manifest.name).toBe(pack2.manifest.name);
      expect(pack1.sourcePaths).toEqual(pack2.sourcePaths);
    });
  });
});
