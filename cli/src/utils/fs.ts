import fsExtra from 'fs-extra';
const { readdir, readFile, writeFile, stat, mkdirp } = fsExtra;
import { join, extname, dirname } from 'node:path';

const DEFAULT_IGNORES = new Set(['node_modules', '.git', '.plgn', 'dist', 'build', '.next', '.turbo']);

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
  const stats = await stat(root);

  if (!stats.isDirectory()) {
    return stats.isFile() ? [root] : [];
  }

  const entries = await readdir(root);
  const results: string[] = [];
  for (const entry of entries) {
    if (DEFAULT_IGNORES.has(entry)) {
      continue;
    }
    const fullPath = join(root, entry);
    const entryStats = await stat(fullPath);
    if (entryStats.isDirectory()) {
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
