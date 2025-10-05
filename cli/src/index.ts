#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import dotenv from 'dotenv';
import fsExtra from 'fs-extra';
import { Command, Option } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  loadConfig,
  mergeDefaults,
  saveConfig,
  upsertToken,
  getEnv,
  resolveToken
} from './config.js';
import type {
  FeatureExtractionRequest,
  CreatePackResult,
  DiscoveryOptions,
  Provider
} from './types.js';
import { createPackFromSource, createPackFromPrompt } from './creator.js';
import { discoverPacks, publishPack } from './registry.js';
import { checkCompatibility, integratePack } from './integrator.js';
import { applyChangeSet } from './utils/diff.js';
import { createAgent } from './agent.js';
import { createSemanticService } from './semantic.js';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));
const cliRoot = resolve(moduleDir, '..');
const repoRoot = resolve(cliRoot, '..');

const ENV_SEARCH_ORDER = [
  resolve(process.cwd(), '.env.local'),
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '.plgin', '.env.local'),
  resolve(process.cwd(), '.plgin', '.env'),
  resolve(cliRoot, '.env.local'),
  resolve(cliRoot, '.env'),
  resolve(repoRoot, '.env.local'),
  resolve(repoRoot, '.env')
];

const { ensureDirSync } = fsExtra;

function loadEnvironment(): void {
  try {
    ensureDirSync(resolve(process.cwd(), '.plgin'));
  } catch {
    // best-effort workspace scaffolding
  }
  const loaded = new Set<string>();
  for (const candidate of ENV_SEARCH_ORDER) {
    if (loaded.has(candidate)) {
      continue;
    }
    if (!existsSync(candidate)) {
      continue;
    }
    dotenv.config({ path: candidate, override: false });
    loaded.add(candidate);
  }
}

loadEnvironment();

const program = new Command();
program
  .name('plgin')
  .description('Semantic feature extraction and integration across any programming language')
  .version('2.0.0');

function handleError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`✖ ${message}`));
  process.exitCode = 1;
}


async function promptYesNo(message: string, defaultValue = false): Promise<boolean> {
  const yesInputs = new Set(['y', 'yes']);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (!defaultValue) {
      console.log(chalk.yellow('Non-interactive environment detected; leaving changes unapplied.'));
    }
    return defaultValue;
  }
  const suffix = defaultValue ? ' (Y/n) ' : ' (y/N) ';
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${message}${suffix}`)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return yesInputs.has(answer);
  } finally {
    rl.close();
  }
}

program
  .command('config')
  .description('Update plgin defaults and tokens')
  .addOption(new Option('--provider <provider>', 'select provider').choices(['openrouter', 'xai', 'anthropic', 'custom']))
  .option('--model <model>', 'set default model')
  .option('--temperature <value>', 'set default temperature', (value) => parseFloat(value))
  .option('--language <language>', 'set default language or auto-detect')
  .addOption(new Option('--security-scanner <scanner>').choices(['snyk', 'trivy', 'custom', 'none']))
  .option('--token <token>', 'persist API token for active provider')
  .option('--clear-token', 'remove token for active provider')
  .option('--auto-apply', 'enable automatic apply after successful integration')
  .option('--no-auto-apply', 'disable automatic apply after integration')
  .option('--registry-url <url>', 'set registry URL')
  .option('--registry-org <org>', 'set GitHub org for registry')
  .option('--github-token <token>', 'set GitHub token for registry')
  .option('--show', 'print current configuration')
  .action(async (flags) => {
    try {
      const config = await loadConfig();
      if (flags.show) {
        console.log(JSON.stringify(config, null, 2));
        return;
      }

      const overrides: Partial<typeof config.defaults> = {};
      if (flags.provider) overrides.provider = flags.provider;
      if (flags.model) overrides.model = flags.model;
      if (typeof flags.temperature === 'number' && !Number.isNaN(flags.temperature)) {
        overrides.temperature = flags.temperature;
      }
      if (flags.language) overrides.language = flags.language;
      if (flags.securityScanner) overrides.securityScanner = flags.securityScanner;

      let updated = mergeDefaults(config, overrides);
      let preferences = updated.preferences ?? { autoApplyChanges: false };
      if (flags.autoApply) {
        preferences = { ...preferences, autoApplyChanges: true };
      }
      if (flags.noAutoApply) {
        preferences = { ...preferences, autoApplyChanges: false };
      }

      let registry = updated.registry ?? {};
      if (flags.registryUrl) {
        registry = { ...registry, url: flags.registryUrl };
      }
      if (flags.registryOrg) {
        registry = { ...registry, org: flags.registryOrg };
      }
      if (flags.githubToken) {
        registry = { ...registry, token: flags.githubToken };
      }

      const provider = overrides.provider ?? config.defaults.provider;
      if (flags.token) {
        updated = upsertToken(updated, provider as Provider, flags.token);
      }
      if (flags.clearToken) {
        updated = upsertToken(updated, provider as Provider, undefined);
      }

      updated = {
        ...updated,
        preferences,
        registry
      };

      await saveConfig(updated);
      console.log(chalk.green('✓ Configuration updated'));
    } catch (error) {
      handleError(error);
    }
  });

program
  .command('create [input]')
  .description('Create a plgin pack from code path, prompt, or infer from current directory')
  .option('--name <name>', 'pack name to use in manifest')
  .option('--lang <language>', 'hint for language extraction')
  .option('--agentic', 'enable agentic mode for extraction (default for prompts)')
  .option('--out-dir <path>', 'where to output the new pack', 'packs')
  .option('--verbose', 'enable verbose agent logs')
  .option('--timeout <ms>', 'overall timeout in milliseconds', (value) => parseInt(value))
  .option('--detailed', 'use comprehensive analysis (slower, more thorough)')
  .option('--examples <policy>', 'extra examples policy (none|auto|csv)', 'none')
  .action(async (input: string | undefined, flags) => {
    let spinner = ora('Extracting feature...').start();
    let aborted = false;
    const onSigint = () => {
      aborted = true;
      spinner.fail('Aborted by user. Partial results may be in the output directory.');
      process.removeListener('SIGINT', onSigint);
      process.exitCode = 130; // POSIX SIGINT code
    };
    process.on('SIGINT', onSigint);

    // Helper: apply overall timeout if provided
    const timeoutMs = (typeof flags.timeout === 'number' && !Number.isNaN(flags.timeout)) ? flags.timeout : undefined;
    const withTimeout = async <T,>(p: Promise<T>): Promise<T> => {
      if (!timeoutMs) return p;
      return await Promise.race<T>([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
        )
      ]);
    };

    try {
      const config = await loadConfig();
      const env = getEnv();
      const semantic = createSemanticService(config, env.cacheDir);
      const agent = createAgent({
        config,
        token: resolveToken(config, config.defaults.provider),
        cacheDir: env.cacheDir
      });

      let request: FeatureExtractionRequest;
      let isPrompt = false;
      let sourcePath: string | undefined;

      // Fast mode is now the default, detailed flag disables it
      const fastMode = !Boolean(flags.detailed);

      if (!input) {
        // Infer from current directory
        sourcePath = process.cwd();
        const featureName = flags.name ?? basename(sourcePath);
        request = {
          path: sourcePath,
          featureName,
          language: flags.lang,
          agentic: Boolean(flags.agentic),
          verbose: Boolean(flags.verbose),
          timeoutMs,
          examples: flags.examples,
          fast: fastMode
        };
      } else if (input.startsWith('./') || input.startsWith('/') || input.includes('/')) {
        // Treat as path
        sourcePath = input;
        const featureName = flags.name ?? basename(input);
        request = {
          path: sourcePath,
          featureName,
          language: flags.lang,
          agentic: Boolean(flags.agentic),
          verbose: Boolean(flags.verbose),
          timeoutMs,
          examples: flags.examples,
          fast: fastMode
        };
      } else {
        // Treat as prompt
        isPrompt = true;
        const featureName = flags.name ?? 'agentic-feature';
        request = {
          prompt: input,
          featureName,
          language: flags.lang,
          agentic: true, // Default for prompts
          verbose: Boolean(flags.verbose),
          timeoutMs,
          examples: flags.examples,
          fast: fastMode
        };
      }

      let semanticHints: string[] = [];
      if (semantic.isEnabled() && request.fast) {
        try {
          const languageHint = request.language ?? config.defaults.language;
          const hits = await semantic.searchPacks(request.featureName, languageHint);
          semanticHints = hits.slice(0, 3).map((hit) => `${hit.packName}@${hit.version}: ${hit.summary}`);
        } catch (error) {
          console.warn(chalk.yellow(`Warning: semantic hint lookup failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      }

      if (request.verbose) {
        spinner.stop();
        console.log(chalk.cyan(`• Starting pack creation ${isPrompt ? 'from prompt' : 'from path'}...`));
      } else {
        spinner.text = `Extracting ${isPrompt ? 'from prompt' : 'feature'}...`;
      }

      let result: CreatePackResult;
      if (request.prompt) {
        result = await withTimeout(createPackFromPrompt({
          agent,
          request,
          outputDir: flags.outDir,
          name: flags.name,
          semanticHints
        }));
      } else {
        result = await withTimeout(createPackFromSource({
          agent,
          request,
          outputDir: flags.outDir,
          name: flags.name,
          semanticHints
        }));
      }

      if (request.verbose) {
        console.log(chalk.green(`✓ Pack created at ${result.path}`));
      } else {
        spinner.succeed(`Pack created at ${result.path}`);
      }
    } catch (error) {
      if (!aborted && spinner) {
        spinner.fail('Failed to create pack');
      }
      handleError(error);
    } finally {
      process.removeListener('SIGINT', onSigint);
      if (spinner && !aborted) spinner.stop();
    }
  });

program
  .command('discover')
  .description('Discover compatible packs for the current project')
  .option('--registry <url>', 'registry endpoint')
  .option('--query <query>', 'search query')
  .option('--lang <language>', 'target language filter')
  .action(async (flags) => {
    try {
      const config = await loadConfig();
      const options: DiscoveryOptions = {
        registry: flags.registry,
        query: flags.query,
        language: flags.lang
      };
      const spinner = ora('Querying registry...').start();
      const results = await discoverPacks(options, config);
      spinner.stop();
      if (!results.length) {
        console.log(chalk.yellow('No packs matched.'));
        return;
      }
      for (const pack of results) {
        console.log(`${chalk.cyan(pack.name)}@${pack.version} - ${pack.description}`);
        if (pack.languages?.length) {
          console.log(`  languages: ${pack.languages.join(', ')}`);
        }
        if (pack.compatibilityScore) {
          console.log(`  compatibility: ${Math.round(pack.compatibilityScore * 100)}%`);
        }
      }
    } catch (error) {
      handleError(error);
    }
  });

program
  .command('check <packRef>')
  .description('Analyze pack compatibility with current project')
  .option('--lang <language>', 'target language override')
  .action(async (packRef: string, flags) => {
    try {
      const config = await loadConfig();
      const spinner = ora('Analyzing compatibility...').start();
      const report = await checkCompatibility({
        packRef,
        targetLanguage: flags.lang ?? config.defaults.language
      });
      spinner.stop();
      console.log(`${chalk.cyan(packRef)} compatibility: ${report.compatible ? chalk.green('yes') : chalk.red('no')}`);
      if (report.recommendedLanguage) {
        console.log(`  recommended language: ${report.recommendedLanguage}`);
      }
      if (report.reasons.length) {
        console.log('  reasons:');
        for (const reason of report.reasons) {
          console.log(`    • ${reason}`);
        }
      }
    } catch (error) {
      handleError(error);
    }
  });

program
  .command('apply <packRef>')
  .description('Apply a pack into the current project')
  .alias('add')
  .option('--instructions <text>', 'custom integration instructions')
  .option('--dry-run', 'preview without writing changes')
  .option('--agentic', 'force agentic integration path')
  .option('--lang <language>', 'target language override')
  .option('--verbose', 'enable verbose integration logs')
  .option('--detailed', 'use comprehensive analysis (slower, more thorough)')
  .action(async (packRef: string, flags) => {
    try {
      const config = await loadConfig();
      const env = getEnv();
      const semantic = createSemanticService(config, env.cacheDir);
      const verbose = Boolean(flags.verbose);
      const verboseLog = verbose
        ? (message: string) => console.log(chalk.gray(`[plgn:apply] ${message}`))
        : undefined;
      const agent = createAgent({
        config,
        token: resolveToken(config, config.defaults.provider),
        cacheDir: env.cacheDir
      });
      const spinner = ora('Integrating pack...').start();
      // Fast mode is now the default, detailed flag disables it
      const fastMode = !Boolean(flags.detailed);
      const result = await integratePack({
        agent,
        packRef,
        instructions: flags.instructions,
        dryRun: Boolean(flags.dryRun),
        agentic: Boolean(flags.agentic),
        targetLanguage: flags.lang ?? config.defaults.language,
        verbose,
        semanticProvider: semantic,
        fast: fastMode
      });
      spinner.stop();
      console.log(chalk.green(`Integration prepared with confidence ${(result.changeSet.confidence * 100).toFixed(1)}%`));
      if (result.changeSet.items.length) {
        console.log(chalk.cyan('ChangeSet:'));
        for (const item of result.changeSet.items) {
          console.log(`  [${item.action}] ${item.path} (${item.language})`);
        }
      } else {
        console.log(chalk.gray('No file changes were proposed.'));
      }
      if (result.diffs.length) {
        console.log(chalk.cyan('\nPreview diff summary:'));
        for (const diff of result.diffs) {
          const delta = chalk.gray(`(+${diff.stats.additions}/-${diff.stats.deletions})`);
          console.log(`  ${diff.action.padEnd(6)} ${diff.path} ${delta}`);
        }
        if (result.previewDir) {
          console.log(chalk.gray(`\nPreview artifacts are available under ${result.previewDir}`));
        }
      } else if (result.previewDir) {
        console.log(chalk.gray(`Preview artifacts are available under ${result.previewDir}`));
      }
      if (result.vulnerabilities?.findings.length) {
        console.log(chalk.yellow('Security findings:'));
        for (const finding of result.vulnerabilities.findings) {
          console.log(`  ${finding.id} (${finding.severity}) - ${finding.title}`);
        }
      }
      const autoApplyPreference = config.preferences?.autoApplyChanges ?? false;

      if (flags.dryRun) {
        console.log(chalk.gray('Dry run requested: no files were modified.'));
        if (autoApplyPreference) {
          console.log(chalk.gray('Auto-apply preference ignored in dry-run mode.'));
        }
        return;
      }
      if (!result.changeSet.items.length) {
        if (result.previewDir) {
          console.log(chalk.gray(`Preview artifacts remain at ${result.previewDir}`));
        }
        return;
      }
      if (autoApplyPreference) {
        console.log(chalk.gray('Auto-apply preference enabled; applying change set.'));
        const summary = await applyChangeSet(result.changeSet, {
          projectRoot: process.cwd(),
          logger: verboseLog
        });
        console.log(chalk.green(`Applied ${summary.applied.length} file(s).`));
        if (summary.skipped.length) {
          console.log(chalk.yellow('Skipped files:'));
          for (const skip of summary.skipped) {
            console.log(`  ${skip.path} - ${skip.reason}`);
          }
        }
        if (result.previewDir) {
          console.log(chalk.gray(`Preview artifacts remain at ${result.previewDir}`));
        }
        return;
      }

      const applyNow = await promptYesNo('Apply these changes now?');
      if (applyNow) {
        const summary = await applyChangeSet(result.changeSet, {
          projectRoot: process.cwd(),
          logger: verboseLog
        });
        console.log(chalk.green(`Applied ${summary.applied.length} file(s).`));
        if (summary.skipped.length) {
          console.log(chalk.yellow('Skipped files:'));
          for (const skip of summary.skipped) {
            console.log(`  ${skip.path} - ${skip.reason}`);
          }
        }
        if (result.previewDir) {
          console.log(chalk.gray(`Preview artifacts remain at ${result.previewDir}`));
        }
      } else {
        console.log(chalk.gray('Changes left unapplied. Review the preview above and re-run when ready.'));
        if (result.previewDir) {
          console.log(chalk.gray(`Preview artifacts remain at ${result.previewDir}`));
        }
      }
    } catch (error) {
      handleError(error);
    }
  });

program
  .command('publish <path>')
  .description('Publish a pack to the registry')
  .option('--registry <url>', 'target registry endpoint')
  .action(async (path: string, flags) => {
    try {
      const config = await loadConfig();
      const env = getEnv();
      const spinner = ora('Publishing pack...').start();
      await publishPack({
        packDir: path,
        registry: flags.registry,
        config,
        cacheDir: env.cacheDir
      });
      spinner.succeed('Pack published');
    } catch (error) {
      handleError(error);
    }
  });

program
  .command('status')
  .description('Show plgin workspace status')
  .action(async () => {
    try {
      const env = getEnv();
      const config = await loadConfig();

      console.log(chalk.cyan('plgin Status'));
      console.log(`Cache dir: ${env.cacheDir}`);
      console.log(`Config: ${env.configPath}`);
      console.log(`Provider: ${config.defaults.provider}`);
      console.log(`Model: ${config.defaults.model}`);

      if (config.registry.org) {
        console.log(`Registry org: ${config.registry.org}`);
      }

      const { readdir, stat } = fsExtra;
      const previewsDir = join(env.cacheDir, '..', 'previews');
      if (await fsExtra.pathExists(previewsDir)) {
        const previews = await readdir(previewsDir);
        console.log(`\nPreviews: ${previews.length} directories`);
      }

      if (await fsExtra.pathExists(env.cacheDir)) {
        const cacheFiles = await readdir(env.cacheDir);
        let totalSize = 0;
        for (const file of cacheFiles) {
          const stats = await stat(join(env.cacheDir, file));
          totalSize += stats.size;
        }
        console.log(`Cache: ${cacheFiles.length} files (${(totalSize / 1024).toFixed(2)} KB)`);
      }
    } catch (error) {
      handleError(error);
    }
  });

program
  .command('clean')
  .description('Clean plgin cache and preview directories')
  .option('--cache', 'clean cache only')
  .option('--previews', 'clean previews only')
  .action(async (flags) => {
    try {
      const env = getEnv();
      const { remove, pathExists } = fsExtra;

      if (!flags.cache && !flags.previews) {
        if (await pathExists(env.cacheDir)) {
          await remove(env.cacheDir);
          console.log(chalk.green(`✓ Cleared cache: ${env.cacheDir}`));
        }

        const previewsDir = join(env.cacheDir, '..', 'previews');
        if (await pathExists(previewsDir)) {
          await remove(previewsDir);
          console.log(chalk.green(`✓ Cleared previews: ${previewsDir}`));
        }
      } else {
        if (flags.cache && await pathExists(env.cacheDir)) {
          await remove(env.cacheDir);
          console.log(chalk.green(`✓ Cleared cache: ${env.cacheDir}`));
        }

        if (flags.previews) {
          const previewsDir = join(env.cacheDir, '..', 'previews');
          if (await pathExists(previewsDir)) {
            await remove(previewsDir);
            console.log(chalk.green(`✓ Cleared previews: ${previewsDir}`));
          }
        }
      }
    } catch (error) {
      handleError(error);
    }
  });

program
  .hook('preAction', () => {
    process.env.PLGIN_ENV = 'cli';
  });

program
  .configureHelp({
    sortSubcommands: true,
    subcommandTerm: (cmd) => cmd.name() + (cmd.usage() ? ` ${cmd.usage()}` : '')
  });

program.parseAsync(process.argv).catch(handleError);
