import type { PathLike } from 'node:fs';
export type Provider = 'openrouter' | 'xai' | 'anthropic' | 'custom';
export interface PLGNDefaults {
    provider: Provider;
    model: string;
    temperature: number;
    language: string;
    securityScanner: 'snyk' | 'trivy' | 'custom' | 'none';
}
export interface PackManifest {
    name: string;
    version: string;
    description: string;
    source_credits: {
        original: string;
        opt_out_training: boolean;
    };
    requirements: {
        languages: string[];
        frameworks: string[];
        minVersion?: Record<string, string>;
    };
    provides: Record<string, unknown>;
    examples: {
        entries?: any[];
        [key: string]: unknown;
    };
    ai_adaptation: {
        strategy: 'agentic-hybrid' | 'code-first' | 'semantic-only';
        agent_model: string;
        preserve: string[];
        adaptable: string[];
        min_confidence: number;
    };
    security?: {
        scanner: string;
        findings: number;
        critical: number;
    };
}
export interface Pack {
    manifest: PackManifest;
    rootDir: string;
    sourcePaths: string[];
}
export interface ChangeSetItem {
    path: string;
    contents: string;
    language: string;
    action: 'create' | 'update' | 'delete';
}
export interface ChangeSet {
    items: ChangeSetItem[];
    summary: string;
    confidence: number;
}
export interface IntegrationResult {
    changeSet: ChangeSet;
    testsRun: boolean;
    vulnerabilities?: VulnReport;
}
export interface VulnReport {
    scanner: string;
    findings: VulnFinding[];
}
export interface VulnFinding {
    id: string;
    title: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    file?: string;
    remediation?: string;
}
export interface ProjectProfile {
    language: string;
    frameworks: string[];
    naming: string;
    structure: string;
    packageManager?: string;
}
export interface AgentTaskContext {
    pack: Pack;
    targetProject: string;
    instructions?: string;
    profile?: ProjectProfile;
    dryRun?: boolean;
}
export interface ConfigFile {
    defaults: PLGNDefaults;
    providerOptions: Record<string, unknown>;
    tokens: Record<string, string | undefined>;
}
export interface FeatureExtractionRequest {
    path?: PathLike;
    featureName: string;
    language?: string;
    agentic?: boolean;
    prompt?: string;
    verbose?: boolean;
    timeoutMs?: number;
    /**
     * Extra examples policy:
     * - 'none' to skip
     * - 'auto' to let the agent decide
     * - CSV list like 'typescript,python'
     */
    examples?: string;
}
export interface ImplementedCode {
    files: ChangeSetItem[];
    tests?: ChangeSetItem[];
    docs?: ChangeSetItem[];
    confidence: number;
}
export interface CompatibilityReport {
    compatible: boolean;
    reasons: string[];
    recommendedLanguage?: string;
    diagnostics?: Record<string, unknown>;
}
export interface DiscoveryOptions {
    registry?: string;
    query?: string;
    language?: string;
}
export interface RegistryPackSummary {
    name: string;
    version: string;
    languages: string[];
    description: string;
    compatibilityScore?: number;
}
export interface CLIEnvironment {
    cwd: string;
    configPath: string;
    cacheDir: string;
}
export interface CreatePackParams {
    agent: PLGNAgent;
    request: FeatureExtractionRequest;
    outputDir: string;
    name?: string;
}
export interface CreatePackResult {
    path: string;
    manifest: PackManifest;
}
export interface PublishPackParams {
    packDir: string;
    registry?: string;
    defaults: PLGNDefaults;
}
export interface IntegratePackParams {
    agent: PLGNAgent;
    packRef: string;
    instructions?: string;
    dryRun: boolean;
    agentic: boolean;
    targetLanguage: string;
}
export interface CompatibilityOptions {
    packRef: string;
    targetLanguage: string;
}
export interface CreateAgentOptions {
    config: ConfigFile;
    token?: string;
    cacheDir: string;
}
export interface CachedAgentResult<T> {
    key: string;
    value: T;
    expiresAt: number;
}
export interface PackImplementationPlan {
    description: string;
    steps: string[];
    model: string;
}
export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
export interface ToolResult {
    tool_call_id: string;
    role: 'tool';
    content: string;
}
export interface AgentEvent {
    type: 'start' | 'tool_call' | 'tool_result' | 'progress' | 'heartbeat' | 'complete' | 'error';
    data: any;
    timestamp: number;
}
export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, any>;
            required: string[];
        };
    };
}
export interface RunToolLoopOptions {
    systemPrompt: string;
    initialUserPrompt: string;
    tools: ToolDefinition[];
    workspace: string;
    verbose?: boolean;
    timeoutMs?: number;
    onEvent?: (event: AgentEvent) => void;
}
export interface PLGNAgent {
    readonly defaults: PLGNDefaults;
    readonly systemPrompt: string;
    extractFeature(path: string, featureName: string, lang?: string): Promise<Pack>;
    runToolLoop(options: RunToolLoopOptions): Promise<Pack>;
    analyzeCompatibility(pack: Pack, project: string, lang?: string): Promise<CompatibilityReport>;
    adaptPack(pack: Pack, project: string, instructions?: string): Promise<ChangeSet>;
    integrateFeature(pack: Pack, project: string, dryRun?: boolean): Promise<IntegrationResult>;
    implementFeature(pack: Pack, targetLang: string, projectPatterns: ProjectProfile): Promise<ImplementedCode>;
    scoreConfidence(output: unknown): number;
    scanForVulns(code: string, lang: string): Promise<VulnReport>;
    planImplementation(pack: Pack, targetLang: string, profile: ProjectProfile): Promise<PackImplementationPlan>;
}
