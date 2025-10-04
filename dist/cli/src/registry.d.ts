import type { RegistryPackSummary, PublishPackParams, PLGNDefaults, DiscoveryOptions } from './types.js';
export declare function discoverPacks(options: DiscoveryOptions, defaults: PLGNDefaults): Promise<RegistryPackSummary[]>;
export declare function publishPack(params: PublishPackParams): Promise<void>;
