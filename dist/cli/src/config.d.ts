import type { ConfigFile, PLGNDefaults, Provider } from './types.js';
declare const CONFIG_DIR: string;
declare const CONFIG_PATH: string;
declare const CACHE_DIR: string;
export declare const getEnv: () => {
    cwd: string;
    configPath: string;
    cacheDir: string;
};
export declare function loadConfig(): Promise<ConfigFile>;
export declare function saveConfig(config: ConfigFile): Promise<void>;
export declare function mergeDefaults(current: ConfigFile, overrides: Partial<PLGNDefaults>): ConfigFile;
export declare function resolveToken(config: ConfigFile, provider: Provider): string | undefined;
export declare function upsertToken(config: ConfigFile, provider: Provider, token: string | undefined): ConfigFile;
export { CONFIG_PATH as CONFIG_FILE_PATH, CONFIG_DIR, CACHE_DIR };
