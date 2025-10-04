import fsExtra from 'fs-extra';
const { readdir, readFile, writeFile, stat, mkdirp } = fsExtra;
import { join, extname, dirname } from 'node:path';

const LANGUAGE_MAP: Record<string, string> = {
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

export async function listFilesRecursive(root: string): Promise<string[]> {
  const entries = await readdir(root);
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry);
    const stats = await stat(fullPath);
    if (stats.isDirectory()) {
      const nested = await listFilesRecursive(fullPath);
      results.push(...nested);
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

export function detectLanguageFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  return LANGUAGE_MAP[ext] ?? 'unknown';
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

export async function writeText(path: string, contents: string): Promise<void> {
  await mkdirp(dirname(path));
  await writeFile(path, contents, 'utf8');
}

export function dedupe<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
