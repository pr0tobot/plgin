export declare function listFilesRecursive(root: string): Promise<string[]>;
export declare function detectLanguageFromPath(path: string): string;
export declare function readText(path: string): Promise<string>;
export declare function writeText(path: string, contents: string): Promise<void>;
export declare function dedupe<T>(values: T[]): T[];
