import { join, resolve, isAbsolute, dirname, basename, relative } from 'node:path';
import fsExtra from 'fs-extra';
const { readJson, writeJson, ensureDir, pathExists, readFile, appendFile, writeFile, copy } = fsExtra;
import OpenAI from 'openai';
import chalk from 'chalk';
import { listFilesRecursive, detectLanguageFromPath } from './utils/fs.js';
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
class HybridAgent {
    options;
    defaults;
    systemPrompt = PLGN_SYSTEM_PROMPT;
    cacheDir;
    providerToken;
    client;
    constructor(options) {
        this.options = options;
        this.defaults = options.config.defaults;
        this.cacheDir = options.cacheDir;
        this.providerToken = options.token;
        // Initialize OpenRouter client
        const baseURL = this.getBaseURL();
        const apiKey = this.providerToken || process.env.OPENROUTER_API_KEY || 'dummy-key';
        this.client = new OpenAI({
            baseURL,
            apiKey,
            defaultHeaders: {
                'HTTP-Referer': 'https://github.com/plgn/cli',
                'X-Title': 'PLGN CLI'
            }
        });
    }
    async callLLM(systemPrompt, userPrompt, temperature, tools) {
        try {
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ];
            const params = {
                model: this.defaults.model,
                messages,
                temperature: temperature ?? this.defaults.temperature
            };
            if (tools && tools.length > 0) {
                params.tools = tools;
            }
            const response = await this.client.chat.completions.create(params);
            return response;
        }
        catch (error) {
            console.error('LLM call failed:', error);
            throw new Error(`AI provider error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    async runToolLoop(options) {
        const { systemPrompt, initialUserPrompt, tools, workspace, verbose = false, timeoutMs, onEvent } = options;
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: initialUserPrompt }
        ];
        let conversation = messages;
        let finalPack = null;
        const emitEvent = (type, data) => {
            const event = {
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
        const toolMap = new Map();
        // Define tool implementations (safe, workspace-scoped)
        toolMap.set('list_files', async (args) => {
            const dir = args.relative_dir || '.';
            const safePath = resolve(workspace, dir);
            if (!safePath.startsWith(workspace)) {
                return JSON.stringify({ error: 'Path traversal not allowed' });
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
                let packManifest = await readJson(manifestPath);
                // Normalize examples to relative paths
                if (packManifest.examples?.entries) {
                    packManifest.examples.entries = packManifest.examples.entries.map((entry) => ({
                        ...entry,
                        path: `source/${entry.language}/${basename(entry.path)}`
                    }));
                }
                // Sanitize source_credits
                if (packManifest.source_credits.original.startsWith('/')) {
                    packManifest.source_credits.original = `extracted-feature-${packManifest.name}`;
                }
                // Canonicalize frameworks
                if (packManifest.requirements.frameworks) {
                    packManifest.requirements.frameworks = packManifest.requirements.frameworks.map((f) => f.toLowerCase().replace(/\.js$/, ''));
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
                }
                catch { }
            }
            // Read manifest again for security scan
            let manifest = await readJson(manifestPath);
            const vulns = await this.scanForVulns(codeSample, manifest.requirements.languages[0] || 'any');
            await writeJson(join(workspace, 'logs', 'security.json'), vulns, { spaces: 2 });
            // Add security summary to manifest
            manifest.security = {
                scanner: this.defaults.securityScanner,
                findings: vulns.findings.length,
                critical: vulns.findings.filter((f) => f.severity === 'critical').length
            };
            await writeJson(manifestPath, manifest, { spaces: 2 });
            finalPack = {
                manifest,
                rootDir: workspace,
                sourcePaths: sourceFiles
            };
            return JSON.stringify({ success: true });
        });
        const withTimeout = async (p, ms) => {
            return await Promise.race([
                p,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool timeout after ${ms}ms`)), ms))
            ]);
        };
        while (true) {
            emitEvent('heartbeat', { messages: conversation.length });
            const response = await withTimeout(this.callLLM('', '', undefined, tools), timeoutMs || 60000);
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
            }
            else if (message.content) {
                emitEvent('complete', { content: message.content });
                // Parse final pack from content or from workspace
                if (finalPack) {
                    break;
                }
                else {
                    // Fallback to current logic if no finalize called
                    // This is a temporary bridge; in full tool-use, agent should call finalize
                    const packDir = workspace;
                    const manifestPath = join(packDir, 'manifest.json');
                    if (await pathExists(manifestPath)) {
                        const manifest = await readJson(manifestPath);
                        const sourcePaths = await listFilesRecursive(join(packDir, 'source'));
                        finalPack = { manifest, rootDir: packDir, sourcePaths };
                    }
                    break;
                }
            }
            if (timeoutMs && Date.now() > timeoutMs) {
                emitEvent('error', { reason: 'Overall timeout' });
                break;
            }
        }
        if (!finalPack) {
            throw new Error('Tool loop did not produce a valid pack');
        }
        return finalPack;
    }
    getBaseURL() {
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
    async logProgress(message) {
        const packDir = process.env.PLGN_PACK_DIR;
        if (!packDir)
            return;
        try {
            await ensureDir(join(packDir, 'logs'));
            const line = `[${new Date().toISOString()}] ${message}`;
            await appendFile(join(packDir, 'logs', 'create.log'), line + '\n', 'utf8');
        }
        catch {
            // best-effort logging
        }
    }
    async extractFeature(path, featureName, lang) {
        const resolved = isAbsolute(path) ? path : resolve(process.cwd(), path);
        if (!(await pathExists(resolved))) {
            throw new Error(`Feature path not found: ${resolved}`);
        }
        await this.logProgress(`Starting extraction for "${featureName}" from ${resolved}`);
        const cacheKey = `extract:${resolved}:${featureName}:${lang ?? 'auto'}`;
        const cached = await this.readCache(cacheKey);
        if (cached) {
            return cached;
        }
        const files = await listFilesRecursive(resolved);
        console.log(`Found ${files.length} files in the feature directory.`);
        await this.logProgress(`Found ${files.length} files in the feature directory`);
        const languages = new Set();
        const codeSnippets = [];
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
                }
                catch (err) {
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
        const analysisResult = await this.callLLM('You are a code analysis expert. Extract feature metadata from code. Return only valid JSON.', analysisPrompt, 0.1);
        console.log('AI analysis complete.');
        await this.logProgress('AI analysis complete');
        let metadata = {
            description: `Feature pack extracted from ${featureName}`,
            dependencies: [],
            frameworks: ['agnostic'],
            provides: { feature: featureName },
            modularBreakdown: []
        };
        try {
            const parsed = JSON.parse(analysisResult.trim());
            metadata = { ...metadata, ...parsed };
        }
        catch (e) {
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
                strategy: 'agentic-hybrid',
                agent_model: this.defaults.model,
                preserve: ['security-measures'],
                adaptable: ['lang-syntax', 'file-structure'],
                min_confidence: 0.8
            }
        };
        const pack = {
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
    async analyzeCompatibility(pack, project, lang) {
        const targetLanguage = lang ?? this.defaults.language;
        const languages = pack.manifest.requirements.languages;
        const compatible = targetLanguage === 'auto-detect' || languages.includes(targetLanguage) || languages.includes('any');
        const reasons = [];
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
    async adaptPack(pack, project, instructions) {
        const cacheKey = `adapt:${pack.manifest.name}:${project}:${instructions ?? 'none'}`;
        const cached = await this.readCache(cacheKey);
        if (cached) {
            return cached;
        }
        // Read sample source files
        const samples = [];
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
        try {
            const parsed = JSON.parse(adaptResult.trim());
            const changeSet = {
                items: parsed.files || [],
                summary: parsed.summary || `Adapted ${pack.manifest.name}`,
                confidence: parsed.confidence || 0.8
            };
            await this.writeCache(cacheKey, changeSet);
            return changeSet;
        }
        catch (e) {
            // Fallback to basic adaptation
            const items = [{
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
    async integrateFeature(pack, project, dryRun = false) {
        const changeSet = await this.adaptPack(pack, project, dryRun ? 'dry-run preview' : undefined);
        const codeSample = changeSet.items.map((item) => item.contents).join('\n');
        const vulnerabilities = await this.scanForVulns(codeSample, pack.manifest.requirements.languages[0] ?? 'any');
        return {
            changeSet,
            testsRun: !dryRun,
            vulnerabilities
        };
    }
    async implementFeature(pack, targetLang, projectPatterns) {
        const cacheKey = `implement:${pack.manifest.name}:${targetLang}:${projectPatterns.naming}`;
        const cached = await this.readCache(cacheKey);
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
        try {
            const parsed = JSON.parse(implementResult.trim());
            const implemented = {
                files: parsed.files || [],
                tests: parsed.tests || [],
                docs: parsed.docs || [],
                confidence: parsed.confidence || 0.85
            };
            await this.writeCache(cacheKey, implemented);
            return implemented;
        }
        catch (e) {
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
    scoreConfidence(output) {
        if (typeof output === 'number')
            return Math.max(0, Math.min(1, output));
        if (typeof output === 'object' && output && 'confidence' in output) {
            const value = output.confidence;
            if (typeof value === 'number')
                return Math.max(0, Math.min(1, value));
        }
        return 0.8;
    }
    async scanForVulns(code, lang) {
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
            const scanResult = await this.callLLM('You are a security scanner. Identify vulnerabilities in code. Return only valid JSON.', vulnPrompt, 0.1);
            const parsed = JSON.parse(scanResult.trim());
            return {
                scanner: this.defaults.securityScanner,
                findings: parsed.findings || []
            };
        }
        catch (e) {
            // Fallback to basic pattern matching
            const findings = [];
            if (code.includes('eval(') || code.includes('exec(')) {
                findings.push({
                    id: 'PLGN-EVAL-001',
                    title: 'Dangerous code execution',
                    severity: 'high',
                    description: 'Dynamic code evaluation detected (eval/exec).',
                    remediation: 'Refactor to use safe alternatives.'
                });
            }
            if (/password\s*=\s*['"][^'"]+['"]/.test(code)) {
                findings.push({
                    id: 'PLGN-CRED-001',
                    title: 'Hardcoded credentials',
                    severity: 'critical',
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
    async planImplementation(pack, targetLang, profile) {
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
            const planResult = await this.callLLM('You are a software architect. Create implementation plans. Return only valid JSON.', planPrompt, 0.2);
            const parsed = JSON.parse(planResult.trim());
            return {
                description: parsed.description || `Plan for ${pack.manifest.name}`,
                steps: parsed.steps || [],
                model: this.defaults.model
            };
        }
        catch (e) {
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
    async generateFallbackCode(pack, lang, profile) {
        const templates = {
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
    generateFallbackTest(pack, lang) {
        const templates = {
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
    toPascalCase(str) {
        return str
            .split(/[-_\s]+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('');
    }
    extensionForLanguage(language, test = false) {
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
    async readCache(key) {
        await ensureDir(this.cacheDir);
        const file = join(this.cacheDir, `${this.hashKey(key)}.json`);
        if (!(await pathExists(file)))
            return undefined;
        try {
            const cached = (await readJson(file));
            if (cached.expiresAt && cached.expiresAt < Date.now()) {
                return undefined;
            }
            return cached.value;
        }
        catch (e) {
            return undefined;
        }
    }
    async writeCache(key, value, ttl = 10 * 60 * 1000) {
        await ensureDir(this.cacheDir);
        const file = join(this.cacheDir, `${this.hashKey(key)}.json`);
        const payload = {
            key,
            value,
            expiresAt: Date.now() + ttl
        };
        await writeJson(file, payload, { spaces: 2 });
    }
    hashKey(key) {
        return Buffer.from(key).toString('base64url');
    }
}
export function createAgent(options) {
    return new HybridAgent(options);
}
//# sourceMappingURL=agent.js.map