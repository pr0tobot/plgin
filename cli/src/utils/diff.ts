import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import fsExtra from 'fs-extra';
const { ensureDir, pathExists, readFile, writeFile, remove } = fsExtra;
import { createTwoFilesPatch, parsePatch } from 'diff';
import type { ChangeSet, FileDiff } from '../types.js';

interface BuildPreviewOptions {
  projectRoot: string;
  cacheDir: string;
  previewLabel?: string;
  previewDir?: string;
  logger?: (message: string) => void;
}

/**
 * Materialize a preview workspace for a ChangeSet by generating unified diffs and
 * writing candidate file contents to a temporary directory.
 *
 * Returns both the diff metadata and the preview directory path so callers can
 * surface the results in UX (e.g., CLI prompts, editors, tests).
 */
export async function buildChangeSetPreview(
  changeSet: ChangeSet,
  options: BuildPreviewOptions
): Promise<{ diffs: FileDiff[]; previewDir: string }> {
  const basePreviewDir = options.previewDir
    ? resolve(options.previewDir)
    : resolve(options.cacheDir, '..', 'previews');

  const previewDir = options.previewDir
    ? resolve(options.previewDir)
    : resolve(basePreviewDir, options.previewLabel ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);

  await ensureDir(previewDir);

  const diffs: FileDiff[] = [];

  for (const item of changeSet.items) {
    const targetPath = resolve(options.projectRoot, item.path);
    const originalExists = await pathExists(targetPath);
    const originalContents = originalExists ? await readFile(targetPath, 'utf8') : '';
    const proposedContents = item.action === 'delete' ? '' : item.contents ?? '';

    if (item.action !== 'delete' && originalContents === proposedContents) {
      options.logger?.(`Skipping ${item.path} (no changes detected)`);
      // Skip no-op updates to keep previews focused on real changes.
      continue;
    }

    options.logger?.(`Generating diff for ${item.path}`);
    const patch = createTwoFilesPatch(
      item.path,
      item.path,
      originalContents,
      proposedContents,
      '',
      '',
      { context: 3 }
    );

    let additions = 0;
    let deletions = 0;

    for (const filePatch of parsePatch(patch)) {
      for (const hunk of filePatch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            additions += 1;
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            deletions += 1;
          }
        }
      }
    }

    let previewPath: string | undefined;
    if (item.action !== 'delete') {
      previewPath = resolve(previewDir, item.path);
      await ensureDir(dirname(previewPath));
      await writeFile(previewPath, proposedContents, 'utf8');
      options.logger?.(`Wrote preview file ${previewPath}`);
    }

    diffs.push({
      path: item.path,
      action: item.action,
      language: item.language,
      patch,
      stats: {
        additions,
        deletions
      },
      previewPath
    });
  }

  await writeFile(join(previewDir, 'change-set.json'), JSON.stringify(changeSet, null, 2), 'utf8');
  await writeFile(join(previewDir, 'diff-summary.json'), JSON.stringify(diffs, null, 2), 'utf8');
  options.logger?.(`Preview artifacts stored in ${previewDir}`);

  return { diffs, previewDir };
}

interface ApplyChangeSetOptions {
  projectRoot: string;
  logger?: (message: string) => void;
}

interface ApplyChangeSetResult {
  applied: string[];
  skipped: { path: string; reason: string }[];
}

/**
 * Apply a ChangeSet by materializing the proposed file contents directly in the
 * user's workspace. This mirrors preview generation so we avoid external tooling.
 */
export async function applyChangeSet(
  changeSet: ChangeSet,
  options: ApplyChangeSetOptions
): Promise<ApplyChangeSetResult> {
  const applied: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const projectRoot = resolve(options.projectRoot);

  for (const item of changeSet.items) {
    const targetPath = resolve(projectRoot, item.path);
    if (!targetPath.startsWith(projectRoot)) {
      options.logger?.(`Skipping ${item.path} (outside project root)`);
      skipped.push({ path: item.path, reason: 'Refused to write outside project root' });
      continue;
    }

    try {
      if (item.action === 'delete') {
        if (await pathExists(targetPath)) {
          await remove(targetPath);
          options.logger?.(`Deleted ${item.path}`);
          applied.push(item.path);
        } else {
          options.logger?.(`Skipping ${item.path} (already absent)`);
          skipped.push({ path: item.path, reason: 'File already absent' });
        }
        continue;
      }

      await ensureDir(dirname(targetPath));
      await writeFile(targetPath, item.contents ?? '', 'utf8');
      options.logger?.(`Wrote ${item.path}`);
      applied.push(item.path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      options.logger?.(`Failed to write ${item.path}: ${reason}`);
      skipped.push({ path: item.path, reason });
    }
  }

  return { applied, skipped };
}
