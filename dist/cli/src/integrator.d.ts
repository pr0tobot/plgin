import type { CompatibilityOptions, CompatibilityReport, IntegratePackParams, IntegrationResult } from './types.js';
export declare function checkCompatibility(options: CompatibilityOptions): Promise<CompatibilityReport>;
export declare function integratePack(params: IntegratePackParams): Promise<IntegrationResult>;
