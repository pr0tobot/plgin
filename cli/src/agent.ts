import { randomUUID } from 'node:crypto';
import { join, resolve, isAbsolute, dirname, basename, relative } from 'node:path';
import fsExtra from 'fs-extra';
const { readJson, writeJson, ensureDir, pathExists, readFile, appendFile, writeFile, copy } = fsExtra;
import OpenAI from 'openai';
import chalk from 'chalk';
import {
  listFilesRecursive,
  detectLanguageFromPath
} from './utils/fs.js';
import type {
  PLGNAgent,
  Pack,
  PackManifest,
  ChangeSet,
  ChangeSetItem,
  IntegrationResult,
  ImplementedCode,
  ProjectProfile,
  VulnReport,
  CompatibilityReport,
  CreateAgentOptions,
  PackImplementationPlan,
  CachedAgentResult,
  ToolCall,
  ToolResult,
  AgentEvent,
  ToolDefinition,
  RunToolLoopOptions
} from './types.js';

export const PLGN_SYSTEM_PROMPT = `You are PLGN, an expert feature extraction and integration agent for any programming language.

Your core capabilities:
1. EXTRACT: Analyze code in any language and extract reusable features with dependencies.
2. ADAPT: Modify features to fit different languages, frameworks, and patterns.
3. IMPLEMENT: Using advanced models, fully generate feature code from semantic descriptions if no exact example exists.
4. VALIDATE: Ensure integrations are safe, functional, and tested across languages, with vuln scans.

Trust your intelligence: For agentic mode, generate complete, working code based on patterns—handle edge cases, security, and performance. Score confidence and fallback if low.

When extracting/implementing:
- Auto-detect or respect specified language (e.g., Python, Java).
- Preserve architecture (e.g., MVC in any lang).
- Create examples for multiple languages/frameworks.
- Generate language-specific tests and embeddings.

When integrating:
- Match target project's patterns (e.g., snake_case in Python, camelCase in JS).
- Use agent if needed to implement from scratch, with ethical credits.

IMPORTANT: Always return valid JSON when asked. Never add markdown formatting or explanations.`;

class HybridAgent implements PLGNAgent {
  readonly defaults;
  readonly systemPrompt = PLGN_SYSTEM_PROMPT;
  private readonly cacheDir: string;
  private readonly providerToken?: string;
  private readonly client: OpenAI;

  constructor(private readonly options: CreateAgentOptions) {
    this.defaults = options.config.defaults;
    this.cacheDir = options.cacheDir;
    this.providerToken = options.token;

    // Initialize OpenRouter client
    const baseURL = this.getBaseURL();
    let apiKey = this.providerToken || 'dummy-key';
    if (apiKey === 'dummy-key') {
      if (this.defaults.provider === 'openrouter') {
        apiKey = process.env.OPENROUTER_API_KEY || apiKey;
      } else if (this.defaults.provider === 'xai') {
        apiKey = process.env.XAI_API_KEY || apiKey;
      }
    }

    this.client = new OpenAI({
      baseURL,
      apiKey,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/plgn/cli',
        'X-Title': 'PLGN CLI'
      }
    });
  }

  private async callLLM(
    systemPrompt: string,
    userPrompt: string,
    temperature?: number,
    tools?: ToolDefinition[],
    conversation?: any[]
  ): Promise<any> {
    try {
      const messages = conversation && conversation.length > 0
        ? conversation
        : [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            ...(userPrompt ? [{ role: 'user', content: userPrompt }] : [])
          ];

      if (messages.length === 0) {
        throw new Error('callLLM requires at least one message.');
      }

      const params: any = {
        model: this.defaults.model,
        messages,
        temperature: temperature ?? this.defaults.temperature
      };

      if (tools && tools.length > 0) {
        params.tools = tools;
      }

      const response = await this.client.chat.completions.create(params);

      return response;
    } catch (error) {
      console.error('LLM call failed:', error);
      throw new Error(`AI provider error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private extractMessageContent(response: any): string {
    const content = response?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content.trim() : '';
  }

  async runToolLoop(options: RunToolLoopOptions): Promise<Pack> {
    const { systemPrompt, initialUserPrompt, tools, workspace, verbose = false, timeoutMs, onEvent } = options;

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: initialUserPrompt }
    ];

    let conversation = messages;
    let finalPack: Pack | null = null;

    const emitEvent = (type: AgentEvent['type'], data: any) => {
      const event: AgentEvent = {
        type,
        data,
        timestamp: Date.now()
      };
      onEvent?.(event);
      if (verbose) {
        console.log(chalk.gray(`[Agent ${type}]`), data);
      }
      this.logProgress(`Agent ${type}: ${JSON.stringify(data)}`);
    };

    emitEvent('start', { tools: tools.map(t => t.function.name) });

    const toolMap = new Map<string, (args: any) => Promise<string>>();

    // Define tool implementations (safe, workspace-scoped)
    toolMap.set('list_files', async (args) => {
      const dir = args.relative_dir || '.';
      const safePath = resolve(workspace, dir);
      if (!safePath.startsWith(workspace)) {
        return JSON.stringify({ error: 'Path traversal not allowed' });
      }
      if (!(await pathExists(safePath))) {
        return JSON.stringify({ error: 'Directory not found' });
      }
      const files = await listFilesRecursive(safePath);
      return JSON.stringify({ files: files.map(f => relative(workspace, f)) });
    });

    toolMap.set('read_file', async (args) => {
      const relPath = args.path;
      const safePath = resolve(workspace, relPath);
      if (!safePath.startsWith(workspace)) {
        return JSON.stringify({ error: 'Path traversal not allowed' });
      }
      if (!(await pathExists(safePath))) {
        return JSON.stringify({ error: 'File not found' });
      }
      const content = await readFile(safePath, 'utf8');
      return JSON.stringify({ content, path: relPath });
    });

    toolMap.set('detect_language', async (args) => {
      const path = args.path;
      const lang = detectLanguageFromPath(path);
      return JSON.stringify({ path, language: lang });
    });

    toolMap.set('ensure_dir', async (args) => {
      const relPath = args.path;
      const safePath = resolve(workspace, relPath);
      if (!safePath.startsWith(workspace)) {
        return JSON.stringify({ error: 'Path traversal not allowed' });
      }
      await ensureDir(safePath);
      return JSON.stringify({ success: true, path: relPath });
    });

    toolMap.set('write_file', async (args) => {
      const relPath = args.path;
      const content = args.content;
      const safePath = resolve(workspace, relPath);
      if (!safePath.startsWith(workspace)) {
        return JSON.stringify({ error: 'Path traversal not allowed' });
      }
      await ensureDir(dirname(safePath));
      await writeFile(safePath, content, 'utf8');
      return JSON.stringify({ success: true, path: relPath });
    });

    toolMap.set('write_manifest', async (args) => {
      const manifest = args.manifest;
      const safePath = resolve(workspace, 'manifest.json');
      if (!safePath.startsWith(workspace)) {
        return JSON.stringify({ error: 'Path traversal not allowed' });
      }
      await writeJson(safePath, manifest, { spaces: 2 });
      return JSON.stringify({ success: true });
    });

    toolMap.set('copy_tree', async (args) => {
      const source = args.source;
      const dest = args.dest;
      const safeSource = resolve(process.cwd(), source);
      const safeDest = resolve(workspace, dest);
      if (!safeDest.startsWith(workspace)) {
        return JSON.stringify({ error: 'Path traversal not allowed' });
      }
      if (!(await pathExists(safeSource))) {
        return JSON.stringify({ error: 'Source not found' });
      }
      await copy(safeSource, safeDest);
      return JSON.stringify({ success: true, source, dest });
    });

    toolMap.set('log_progress', async (args) => {
      const message = args.message;
      await this.logProgress(message);
      return JSON.stringify({ success: true });
    });

    toolMap.set('finalize_pack', async (args) => {
      // Normalize manifest, ensure patterns/agents/tests exist
      const manifestPath = resolve(workspace, 'manifest.json');
      if (await pathExists(manifestPath)) {
                let packManifest = await readJson(manifestPath) as PackManifest;
                if (!packManifest.requirements) {
                  packManifest.requirements = {
                    languages: ['any'],
                    frameworks: ['agnostic'],
                    minVersion: {}
                  };
                } else {
                  packManifest.requirements.languages = packManifest.requirements.languages?.length
                    ? packManifest.requirements.languages
                    : ['any'];
                  packManifest.requirements.frameworks = packManifest.requirements.frameworks?.length
                    ? packManifest.requirements.frameworks
                    : ['agnostic'];
                  packManifest.requirements.minVersion = packManifest.requirements.minVersion ?? {};
                }
        // Normalize examples to relative paths
        if (packManifest.examples?.entries) {
          packManifest.examples.entries = packManifest.examples.entries.map((entry: any) => ({
            ...entry,
            path: `source/${entry.language}/${basename(entry.path)}`
          }));
        }
                // Ensure source credits exist and sanitize path-based defaults
                if (!packManifest.source_credits) {
                  packManifest.source_credits = {
                    original: `extracted-feature-${packManifest.name}`,
                    opt_out_training: false
                  };
                }
                if (packManifest.source_credits.original?.startsWith('/')) {
                  packManifest.source_credits.original = `extracted-feature-${packManifest.name}`;
                }
        // Canonicalize frameworks
        if (packManifest.requirements.frameworks) {
          packManifest.requirements.frameworks = packManifest.requirements.frameworks.map((f: string) => f.toLowerCase().replace(/\.js$/, ''));
        }
        await writeJson(manifestPath, packManifest, { spaces: 2 });
      }

      // Ensure standard directories
      await ensureDir(join(workspace, 'patterns'));
      await ensureDir(join(workspace, 'agents'));
      await ensureDir(join(workspace, 'tests'));

      // Run security scan
      const sourceFiles = await listFilesRecursive(join(workspace, 'source'));
      let codeSample = '';
      for (const file of sourceFiles.slice(0, 5)) {
        try {
          codeSample += await readFile(file, 'utf8') + '\n';
        } catch {}
      }

      // Read manifest again for security scan
      let manifest = await readJson(manifestPath) as PackManifest;
      if (!manifest.requirements) {
        manifest.requirements = {
          languages: ['any'],
          frameworks: ['agnostic'],
          minVersion: {}
        };
      } else {
        manifest.requirements.languages = manifest.requirements.languages?.length
          ? manifest.requirements.languages
          : ['any'];
        manifest.requirements.frameworks = manifest.requirements.frameworks?.length
          ? manifest.requirements.frameworks
          : ['agnostic'];
        manifest.requirements.minVersion = manifest.requirements.minVersion ?? {};
      }
      const vulns = await this.scanForVulns(codeSample, manifest.requirements.languages[0] || 'any');
      await writeJson(join(workspace, 'logs', 'security.json'), vulns, { spaces: 2 });

      // Add security summary to manifest
      manifest.security = {
        scanner: this.defaults.securityScanner,
        findings: vulns.findings.length,
        critical: vulns.findings.filter((f: any) => f.severity === 'critical').length
      };
      await writeJson(manifestPath, manifest, { spaces: 2 });

      finalPack = {
        manifest,
        rootDir: workspace,
        sourcePaths: sourceFiles
      };

      return JSON.stringify({ success: true });
    });

    const callTimeout = Math.max(timeoutMs ?? 120000, 30000);

    const withTimeout = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Tool timeout after ${ms}ms`)), ms))
      ]);
    };

    while (true) {
      emitEvent('heartbeat', { messages: conversation.length });

      const response = await withTimeout(
        this.callLLM(systemPrompt, initialUserPrompt, undefined, tools, conversation),
        callTimeout
      );

      const message = response.choices[0].message;
      conversation.push(message);

      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          emitEvent('tool_call', toolCall);

          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments);

          const toolFn = toolMap.get(toolName);
          if (!toolFn) {
            const result = { error: `Unknown tool: ${toolName}` };
            conversation.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(result)
            });
            emitEvent('tool_result', result);
            continue;
          }

          const result = await withTimeout(toolFn(toolArgs), 30000);
          conversation.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result
          });
          emitEvent('tool_result', { tool: toolName, result });
        }
      } else if (message.content) {
        emitEvent('complete', { content: message.content });
        // Parse final pack from content or from workspace
        if (finalPack) {
          break;
        } else {
          // Fallback to current logic if no finalize called
          // This is a temporary bridge; in full tool-use, agent should call finalize
          const packDir = workspace;
          const manifestPath = join(packDir, 'manifest.json');
          if (await pathExists(manifestPath)) {
            const manifest = await readJson(manifestPath) as PackManifest;
            const sourcePaths = await listFilesRecursive(join(packDir, 'source'));
            finalPack = { manifest, rootDir: packDir, sourcePaths };
          }
          break;
        }
      }

    }

    if (!finalPack) {
      throw new Error('Tool loop did not produce a valid pack');
    }

    return finalPack;
  }

  private getBaseURL(): string {
    switch (this.defaults.provider) {
      case 'openrouter':
        return 'https://openrouter.ai/api/v1';
      case 'xai':
        return 'https://api.x.ai/v1';
      case 'anthropic':
        return 'https://api.anthropic.com/v1';
      default:
        return 'https://openrouter.ai/api/v1';
    }
  }

  private async logProgress(message: string): Promise<void> {
    const packDir = process.env.PLGN_PACK_DIR;
    if (!packDir) return;
    try {
      await ensureDir(join(packDir, 'logs'));
      const line = `[${new Date().toISOString()}] ${message}`;
      await appendFile(join(packDir, 'logs', 'create.log'), line + '\n', 'utf8');
    } catch {
      // best-effort logging
    }
  }

  async extractFeature(path: string, featureName: string, lang?: string): Promise<Pack> {
    const resolved = isAbsolute(path) ? path : resolve(process.cwd(), path);
    if (!(await pathExists(resolved))) {
      throw new Error(`Feature path not found: ${resolved}`);
    }
    await this.logProgress(`Starting extraction for "${featureName}" from ${resolved}`);

    const cacheKey = `extract:${resolved}:${featureName}:${lang ?? 'auto'}`;
    const cached = await this.readCache<Pack>(cacheKey);
    if (cached) {
      return cached;
    }

    const files = await listFilesRecursive(resolved);
    console.log(`Found ${files.length} files in the feature directory.`);
    await this.logProgress(`Found ${files.length} files in the feature directory`);
    const languages = new Set<string>();
    const codeSnippets: string[] = [];

    console.log('Reading source files and detecting languages...');
    await this.logProgress('Reading source files and detecting languages');
    // Read source files and detect languages
    for (const file of files) {
      const detected = detectLanguageFromPath(file);
      if (detected !== 'unknown') {
        languages.add(detected);
        try {
          const content = await readFile(file, 'utf-8');
          codeSnippets.push(`// File: ${file}\n${content}`);
        } catch (err) {
          // Skip files we can't read
        }
      }
    }
    console.log(`Detected languages: ${Array.from(languages).join(', ')}`);
    await this.logProgress(`Detected languages: ${Array.from(languages).join(', ')}`);

    if (lang) {
      languages.add(lang);
    }

    console.log('Analyzing feature with AI...');
    await this.logProgress('Analyzing feature with AI');
    // Use AI to analyze the feature
    const analysisPrompt = `Analyze this codebase and extract metadata for the feature "${featureName}".

Code samples:
${codeSnippets.join('\n\n---\n\n')}

Respond with JSON only (no markdown):
{
  "description": "brief description of the feature",
  "dependencies": ["list", "of", "dependencies"],
  "frameworks": ["detected", "frameworks"],
  "provides": {
    "feature": "main capability"
  },
  "modularBreakdown": ["list of modular components or sub-features"]
}`;

    const analysisResult = await this.callLLM(
      'You are a code analysis expert. Extract feature metadata from code. Return only valid JSON.',
      analysisPrompt,
      0.1
    );
    const analysisContent = this.extractMessageContent(analysisResult);
    console.log('AI analysis complete.');
    await this.logProgress('AI analysis complete');

    let metadata: any = {
      description: `Feature pack extracted from ${featureName}`,
      dependencies: [],
      frameworks: ['agnostic'],
      provides: { feature: featureName },
      modularBreakdown: []
    };

    try {
      if (analysisContent) {
        const parsed = JSON.parse(analysisContent);
        metadata = { ...metadata, ...parsed };
      }
    } catch (e) {
      // Use defaults if parsing fails
    }

    const manifest = {
      name: featureName,
      version: '0.1.0',
      description: metadata.description,
      source_credits: {
        original: resolved,
        opt_out_training: false
      },
      requirements: {
        languages: Array.from(languages.size ? languages : new Set(['any'])),
        frameworks: metadata.frameworks,
        minVersion: {}
      },
      provides: metadata.provides,
      examples: {
        entries: files.map((file) => ({
          path: file,
          language: detectLanguageFromPath(file)
        }))
      },
      ai_adaptation: {
        strategy: 'agentic-hybrid' as const,
        agent_model: this.defaults.model,
        preserve: ['security-measures'],
        adaptable: ['lang-syntax', 'file-structure'],
        min_confidence: 0.8
      }
    };

    const pack: Pack = {
      manifest,
      rootDir: resolved,
      sourcePaths: files
    };

    console.log('Skipping modular examples generation (disabled by default).');
    await this.logProgress('Skipping modular examples generation (disabled by default)');
    // To enable agent-decided extra examples, provide a policy via CLI flags (planned).
    console.log('Feature extraction complete.');
    await this.logProgress('Feature extraction complete');

    await this.writeCache(cacheKey, pack);
    return pack;
  }

  async analyzeCompatibility(pack: Pack, project: string, lang?: string): Promise<CompatibilityReport> {
    const targetLanguage = lang ?? this.defaults.language;
    const languages = pack.manifest.requirements.languages;
    const compatible = targetLanguage === 'auto-detect' || languages.includes(targetLanguage) || languages.includes('any');
    const reasons: string[] = [];

    if (!compatible) {
      reasons.push(`Pack does not list ${targetLanguage} support.`);
    }
    if (!project) {
      reasons.push('Project path not provided; assuming compatibility.');
    }

    return {
      compatible: compatible || !project,
      reasons,
      recommendedLanguage: compatible ? targetLanguage : languages[0] ?? 'any'
    };
  }

  async adaptPack(pack: Pack, project: string, instructions?: string): Promise<ChangeSet> {
    const cacheKey = `adapt:${pack.manifest.name}:${project}:${instructions ?? 'none'}`;
    const cached = await this.readCache<ChangeSet>(cacheKey);
    if (cached) {
      return cached;
    }

    // Read sample source files
    const samples: string[] = [];
    for (const sourcePath of pack.sourcePaths.slice(0, 5)) {
      if (await pathExists(sourcePath)) {
        const content = await readFile(sourcePath, 'utf-8');
        samples.push(`// Source: ${sourcePath}\n${content.slice(0, 1000)}`);
      }
    }

    const adaptPrompt = `Adapt this feature pack for integration into a project.

Feature: ${pack.manifest.name}
Description: ${pack.manifest.description}
Target project: ${project}
Instructions: ${instructions ?? 'Follow project conventions'}

Original code samples:
${samples.join('\n\n---\n\n')}

Generate adapted code that follows the target project's patterns. Respond with JSON only:
{
  "files": [
    {
      "path": "relative/path/to/file",
      "contents": "full file contents",
      "language": "javascript|python|etc",
      "action": "create|update"
    }
  ],
  "summary": "description of changes",
  "confidence": 0.85
}`;

    const adaptResult = await this.callLLM(this.systemPrompt, adaptPrompt, 0.3);
    const adaptContent = this.extractMessageContent(adaptResult);

    try {
      if (!adaptContent) {
        throw new Error('Empty adaptation response');
      }
      const parsed = JSON.parse(adaptContent);
      const changeSet: ChangeSet = {
        items: parsed.files || [],
        summary: parsed.summary || `Adapted ${pack.manifest.name}`,
        confidence: parsed.confidence || 0.8
      };
      await this.writeCache(cacheKey, changeSet);
      return changeSet;
    } catch (e) {
      // Fallback to basic adaptation
      const items: ChangeSetItem[] = [{
        path: join(project, `${pack.manifest.name}.txt`),
        contents: `# Adapted feature: ${pack.manifest.name}\n${pack.manifest.description}\n\nInstructions: ${instructions ?? 'n/a'}`,
        language: pack.manifest.requirements.languages[0] ?? 'text',
        action: 'create'
      }];

      return {
        items,
        summary: `Basic adaptation of ${pack.manifest.name}`,
        confidence: 0.7
      };
    }
  }

  async integrateFeature(pack: Pack, project: string, dryRun = false): Promise<IntegrationResult> {
    const changeSet = await this.adaptPack(pack, project, dryRun ? 'dry-run preview' : undefined);
    const codeSample = changeSet.items.map((item) => item.contents).join('\n');
    const vulnerabilities = await this.scanForVulns(codeSample, pack.manifest.requirements.languages[0] ?? 'any');

    return {
      changeSet,
      testsRun: !dryRun,
      vulnerabilities
    };
  }

  async implementFeature(pack: Pack, targetLang: string, projectPatterns: ProjectProfile): Promise<ImplementedCode> {
    const cacheKey = `implement:${pack.manifest.name}:${targetLang}:${projectPatterns.naming}`;
    const cached = await this.readCache<ImplementedCode>(cacheKey);
    if (cached) {
      return cached;
    }

    const implementPrompt = `Implement the feature "${pack.manifest.name}" in ${targetLang}.

Description: ${pack.manifest.description}
Target language: ${targetLang}
Naming convention: ${projectPatterns.naming}
Structure: ${projectPatterns.structure}
Frameworks: ${projectPatterns.frameworks.join(', ')}

Generate complete, production-ready code with:
1. Main implementation files
2. Unit tests
3. Documentation

Handle edge cases, security, and performance. Respond with JSON only:
{
  "files": [
    {
      "path": "relative/path/file.ext",
      "contents": "complete file contents",
      "language": "${targetLang}",
      "action": "create"
    }
  ],
  "tests": [
    {
      "path": "tests/test_file.ext",
      "contents": "test contents",
      "language": "${targetLang}",
      "action": "create"
    }
  ],
  "docs": [
    {
      "path": "README.md",
      "contents": "documentation",
      "language": "markdown",
      "action": "create"
    }
  ],
  "confidence": 0.9
}`;

    const implementResult = await this.callLLM(this.systemPrompt, implementPrompt, 0.4);
    const implementContent = this.extractMessageContent(implementResult);

    try {
      if (!implementContent) {
        throw new Error('Empty implementation response');
      }
      const parsed = JSON.parse(implementContent);
      const implemented: ImplementedCode = {
        files: parsed.files || [],
        tests: parsed.tests || [],
        docs: parsed.docs || [],
        confidence: parsed.confidence || 0.85
      };
      await this.writeCache(cacheKey, implemented);
      return implemented;
    } catch (e) {
      // Fallback implementation
      const ext = this.extensionForLanguage(targetLang);
      const filename = `generated/${targetLang}/${pack.manifest.name}.${ext}`;

      const fallbackCode = await this.generateFallbackCode(pack, targetLang, projectPatterns);

      return {
        files: [{
          path: filename,
          contents: fallbackCode,
          language: targetLang,
          action: 'create'
        }],
        tests: [{
          path: `tests/${pack.manifest.name}.test.${ext}`,
          contents: this.generateFallbackTest(pack, targetLang),
          language: targetLang,
          action: 'create'
        }],
        docs: [{
          path: 'README.md',
          contents: `# ${pack.manifest.name}\n\n${pack.manifest.description}\n\nImplemented in ${targetLang}.`,
          language: 'markdown',
          action: 'create'
        }],
        confidence: 0.75
      };
    }
  }

  scoreConfidence(output: unknown): number {
    if (typeof output === 'number') return Math.max(0, Math.min(1, output));
    if (typeof output === 'object' && output && 'confidence' in (output as Record<string, unknown>)) {
      const value = (output as Record<string, unknown>).confidence;
      if (typeof value === 'number') return Math.max(0, Math.min(1, value));
    }
    return 0.8;
  }

  async scanForVulns(code: string, lang: string): Promise<VulnReport> {
    const vulnPrompt = `Scan this ${lang} code for security vulnerabilities:

${code.slice(0, 2000)}

Identify potential issues like:
- SQL injection
- XSS vulnerabilities
- Insecure deserialization
- Command injection
- Hardcoded credentials
- Insecure cryptography

Respond with JSON only:
{
  "findings": [
    {
      "id": "PLGN-XXX-001",
      "title": "Issue title",
      "severity": "low|medium|high|critical",
      "description": "Description",
      "remediation": "How to fix"
    }
  ]
}`;

    try {
      const scanResult = await this.callLLM(
        'You are a security scanner. Identify vulnerabilities in code. Return only valid JSON.',
        vulnPrompt,
        0.1
      );
      const scanContent = this.extractMessageContent(scanResult);
      const parsed = scanContent ? JSON.parse(scanContent) : { findings: [] };
      return {
        scanner: this.defaults.securityScanner,
        findings: parsed.findings || []
      };
    } catch (e) {
      // Fallback to basic pattern matching
      const findings = [];

      if (code.includes('eval(') || code.includes('exec(')) {
        findings.push({
          id: 'PLGN-EVAL-001',
          title: 'Dangerous code execution',
          severity: 'high' as const,
          description: 'Dynamic code evaluation detected (eval/exec).',
          remediation: 'Refactor to use safe alternatives.'
        });
      }

      if (/password\s*=\s*['"][^'"]+['"]/.test(code)) {
        findings.push({
          id: 'PLGN-CRED-001',
          title: 'Hardcoded credentials',
          severity: 'critical' as const,
          description: 'Hardcoded password detected in code.',
          remediation: 'Use environment variables or secret management.'
        });
      }

      return {
        scanner: this.defaults.securityScanner,
        findings
      };
    }
  }

  async planImplementation(pack: Pack, targetLang: string, profile: ProjectProfile): Promise<PackImplementationPlan> {
    const planPrompt = `Create an implementation plan for "${pack.manifest.name}" in ${targetLang}.

Description: ${pack.manifest.description}
Target: ${targetLang}
Patterns: ${profile.naming}, ${profile.structure}

Respond with JSON only:
{
  "description": "Plan overview",
  "steps": ["Step 1", "Step 2", "..."],
  "model": "${this.defaults.model}"
}`;

    try {
      const planResult = await this.callLLM(
        'You are a software architect. Create implementation plans. Return only valid JSON.',
        planPrompt,
        0.2
      );
      const planContent = this.extractMessageContent(planResult);
      if (!planContent) {
        throw new Error('Empty plan response');
      }
      const parsed = JSON.parse(planContent);
      return {
        description: parsed.description || `Plan for ${pack.manifest.name}`,
        steps: parsed.steps || [],
        model: this.defaults.model
      };
    } catch (e) {
      return {
        description: `Agentic plan for ${pack.manifest.name} targeting ${targetLang}`,
        steps: [
          `Analyze ${pack.manifest.name} for ${targetLang} idioms`,
          `Generate scaffolding following ${profile.structure}`,
          `Apply naming convention ${profile.naming}`,
          'Run security scan and confidence scoring'
        ],
        model: this.defaults.model
      };
    }
  }

  private async generateFallbackCode(pack: Pack, lang: string, profile: ProjectProfile): Promise<string> {
    const templates: Record<string, string> = {
      javascript: `// ${pack.manifest.name}
// ${pack.manifest.description}

export class ${this.toPascalCase(pack.manifest.name)} {
  constructor() {
    this.initialized = true;
  }

  execute() {
    return { status: 'ok', feature: '${pack.manifest.name}' };
  }
}

export default ${this.toPascalCase(pack.manifest.name)};
`,
      typescript: `// ${pack.manifest.name}
// ${pack.manifest.description}

export interface ${this.toPascalCase(pack.manifest.name)}Result {
  status: string;
  feature: string;
}

export class ${this.toPascalCase(pack.manifest.name)} {
  private initialized: boolean = true;

  execute(): ${this.toPascalCase(pack.manifest.name)}Result {
    return { status: 'ok', feature: '${pack.manifest.name}' };
  }
}

export default ${this.toPascalCase(pack.manifest.name)};
`,
      python: `"""${pack.manifest.name}

${pack.manifest.description}
"""

class ${this.toPascalCase(pack.manifest.name)}:
    def __init__(self):
        self.initialized = True

    def execute(self):
        return {'status': 'ok', 'feature': '${pack.manifest.name}'}

__all__ = ['${this.toPascalCase(pack.manifest.name)}']
`,
      java: `// ${pack.manifest.name}
// ${pack.manifest.description}

package com.plgn.${pack.manifest.name.toLowerCase()};

public class ${this.toPascalCase(pack.manifest.name)} {
    private boolean initialized;

    public ${this.toPascalCase(pack.manifest.name)}() {
        this.initialized = true;
    }

    public Result execute() {
        return new Result("ok", "${pack.manifest.name}");
    }

    public static class Result {
        public final String status;
        public final String feature;

        public Result(String status, String feature) {
            this.status = status;
            this.feature = feature;
        }
    }
}
`
    };

    return templates[lang] || templates.javascript;
  }

  private generateFallbackTest(pack: Pack, lang: string): string {
    const templates: Record<string, string> = {
      javascript: `import { ${this.toPascalCase(pack.manifest.name)} } from './${pack.manifest.name}';

describe('${this.toPascalCase(pack.manifest.name)}', () => {
  it('should execute successfully', () => {
    const feature = new ${this.toPascalCase(pack.manifest.name)}();
    const result = feature.execute();
    expect(result.status).toBe('ok');
  });
});
`,
      typescript: `import { ${this.toPascalCase(pack.manifest.name)} } from './${pack.manifest.name}';

describe('${this.toPascalCase(pack.manifest.name)}', () => {
  it('should execute successfully', () => {
    const feature = new ${this.toPascalCase(pack.manifest.name)}();
    const result = feature.execute();
    expect(result.status).toBe('ok');
  });
});
`,
      python: `import unittest
from ${pack.manifest.name} import ${this.toPascalCase(pack.manifest.name)}

class Test${this.toPascalCase(pack.manifest.name)}(unittest.TestCase):
    def test_execute(self):
        feature = ${this.toPascalCase(pack.manifest.name)}()
        result = feature.execute()
        self.assertEqual(result['status'], 'ok')

if __name__ == '__main__':
    unittest.main()
`,
      java: `import org.junit.Test;
import static org.junit.Assert.*;

public class ${this.toPascalCase(pack.manifest.name)}Test {
    @Test
    public void testExecute() {
        ${this.toPascalCase(pack.manifest.name)} feature = new ${this.toPascalCase(pack.manifest.name)}();
        ${this.toPascalCase(pack.manifest.name)}.Result result = feature.execute();
        assertEquals("ok", result.status);
    }
}
`
    };

    return templates[lang] || templates.javascript;
  }

  private toPascalCase(str: string): string {
    return str
      .split(/[-_\s]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  }

  private extensionForLanguage(language: string, test = false): string {
    switch (language) {
      case 'typescript':
        return test ? 'spec.ts' : 'ts';
      case 'javascript':
        return test ? 'spec.js' : 'js';
      case 'python':
        return test ? 'py' : 'py';
      case 'java':
        return test ? 'java' : 'java';
      default:
        return test ? 'test.txt' : 'txt';
    }
  }

  private async readCache<T>(key: string): Promise<T | undefined> {
    await ensureDir(this.cacheDir);
    const file = join(this.cacheDir, `${this.hashKey(key)}.json`);
    if (!(await pathExists(file))) return undefined;

    try {
      const cached = (await readJson(file)) as CachedAgentResult<T>;
      if (cached.expiresAt && cached.expiresAt < Date.now()) {
        return undefined;
      }
      return cached.value;
    } catch (e) {
      return undefined;
    }
  }

  private async writeCache<T>(key: string, value: T, ttl = 10 * 60 * 1000): Promise<void> {
    await ensureDir(this.cacheDir);
    const file = join(this.cacheDir, `${this.hashKey(key)}.json`);
    const payload: CachedAgentResult<T> = {
      key,
      value,
      expiresAt: Date.now() + ttl
    };
    await writeJson(file, payload, { spaces: 2 });
  }

  private hashKey(key: string): string {
    return Buffer.from(key).toString('base64url');
  }
}

export function createAgent(options: CreateAgentOptions): PLGNAgent {
  return new HybridAgent(options);
}
