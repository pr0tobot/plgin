import fsExtra from 'fs-extra';
const { readdir, readFile, writeFile, stat, mkdirp } = fsExtra;
import { join, extname, dirname } from 'node:path';
const LANGUAGE_MAP = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.java': 'java',
    '.kt': 'kotlin',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust'
};
export async function listFilesRecursive(root) {
    const entries = await readdir(root);
    const results = [];
    for (const entry of entries) {
        const fullPath = join(root, entry);
        const stats = await stat(fullPath);
        if (stats.isDirectory()) {
            const nested = await listFilesRecursive(fullPath);
            results.push(...nested);
        }
        else {
            results.push(fullPath);
        }
    }
    return results;
}
export function detectLanguageFromPath(path) {
    const ext = extname(path).toLowerCase();
    return LANGUAGE_MAP[ext] ?? 'unknown';
}
export async function readText(path) {
    return readFile(path, 'utf8');
}
export async function writeText(path, contents) {
    await mkdirp(dirname(path));
    await writeFile(path, contents, 'utf8');
}
export function dedupe(values) {
    return Array.from(new Set(values));
}
//# sourceMappingURL=fs.js.map