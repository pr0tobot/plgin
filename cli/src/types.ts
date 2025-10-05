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

export interface FileDiff {
  path: string;
  action: ChangeSetItem['action'];
  language: string;
  patch: string;
  stats: {
    additions: number;
    deletions: number;
  };
  /**
   * Optional pointer to a temp file containing the proposed contents.
   * Useful for editor integrations or external diff tooling.
   */
  previewPath?: string;
}

export interface IntegrationResult {
  changeSet: ChangeSet;
  testsRun: boolean;
  vulnerabilities?: VulnReport;
  diffs: FileDiff[];
  /**
   * Directory where preview artifacts (temp files, metadata) are stored.
   * Consumers may clean up this directory after applying or discarding the change.
   */
  previewDir?: string;
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

export interface ConfigPreferences {
  autoApplyChanges: boolean;
}

export interface SemanticConfig {
  provider: 'nia-contexts' | 'disabled';
  agentSource?: string;
  tags?: string[];
  searchLimit?: number;
}

export interface SemanticSearchHit {
  contextId: string;
  packName: string;
  version: string;
  summary: string;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface SemanticProvider {
  isEnabled(): boolean;
  searchPacks(query: string, language?: string): Promise<SemanticSearchHit[]>;
}

export interface ConfigFile {
  defaults: PLGNDefaults;
  providerOptions: Record<string, unknown>;
  tokens: Record<string, string | undefined>;
  preferences: ConfigPreferences;
  registry: RegistryConfig;
  semantic: SemanticConfig;
}

export interface FeatureExtractionRequest {
  path?: PathLike;
  featureName: string;
  language?: string;
  agentic?: boolean;
  prompt?: string;
  verbose?: boolean;
  timeoutMs?: number;
  fast?: boolean;
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

export interface RegistryEntry {
  name: string;
  version: string;
  languages: string[];
  description: string;
  downloadUrl: string;
  checksum: string;
  publishedAt: string;
  author: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface PublishResult {
  url: string;
  version: string;
  checksum: string;
}

export interface ComplianceReport {
  packName: string;
  version: string;
  timestamp: string;
  validation: ValidationResult;
  security?: VulnReport;
  testsRun: boolean;
  testResults?: {
    passed: number;
    failed: number;
    output: string;
  };
}

export interface RegistryConfig {
  url?: string;
  org?: string;
  token?: string;
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
  semanticHints?: string[];
}

export interface CreatePackResult {
  path: string;
  manifest: PackManifest;
}


export interface PublishPackParams {
  packDir: string;
  registry?: string;
  config: ConfigFile;
  cacheDir: string;
}

export interface IntegratePackParams {
  agent: PLGNAgent;
  packRef: string;
  instructions?: string;
  dryRun: boolean;
  agentic: boolean;
  targetLanguage: string;
  verbose?: boolean;
  semanticHints?: string[];
  semanticProvider?: SemanticProvider;
  fast?: boolean;
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
  maxIterations?: number;
}

export interface IntegrationToolLoopOptions {
  systemPrompt: string;
  initialUserPrompt: string;
  tools: ToolDefinition[];
  pack: Pack;
  projectRoot: string;
  verbose?: boolean;
  timeoutMs?: number;
  onEvent?: (event: AgentEvent) => void;
  maxIterations?: number;
}

export interface PLGNAgent {
  readonly defaults: PLGNDefaults;
  readonly systemPrompt: string;
  extractFeature(path: string, featureName: string, lang?: string, options?: { hints?: string[]; fast?: boolean }): Promise<Pack>;
  runToolLoop(options: RunToolLoopOptions): Promise<Pack>;
  analyzeCompatibility(pack: Pack, project: string, lang?: string): Promise<CompatibilityReport>;
  adaptPack(pack: Pack, project: string, instructions?: string): Promise<ChangeSet>;
  integrateFeature(pack: Pack, project: string, dryRun?: boolean): Promise<IntegrationResult>;
  integrateWithTools(options: IntegrationToolLoopOptions): Promise<ChangeSet>;
  implementFeature(pack: Pack, targetLang: string, projectPatterns: ProjectProfile): Promise<ImplementedCode>;
  scoreConfidence(output: unknown): number;
  scanForVulns(code: string, lang: string): Promise<VulnReport>;
  planImplementation(pack: Pack, targetLang: string, profile: ProjectProfile): Promise<PackImplementationPlan>;
}
