#!/usr/bin/env node
import { basename } from 'node:path';
import { Command, Option } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig, mergeDefaults, saveConfig, upsertToken, getEnv, resolveToken } from './config.js';
import { createPackFromSource, createPackFromPrompt } from './creator.js';
import { discoverPacks, publishPack } from './registry.js';
import { checkCompatibility, integratePack } from './integrator.js';
import { createAgent } from './agent.js';
const program = new Command();
program
    .name('plgn')
    .description('PLGN hybrid feature pack CLI (language agnostic)')
    .version('0.1.0');
function handleError(err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`✖ ${message}`));
    process.exitCode = 1;
}
program
    .command('config')
    .description('Update PLGN defaults and tokens')
    .addOption(new Option('--provider <provider>', 'select provider').choices(['openrouter', 'xai', 'anthropic', 'custom']))
    .option('--model <model>', 'set default model')
    .option('--temperature <value>', 'set default temperature', (value) => parseFloat(value))
    .option('--language <language>', 'set default language or auto-detect')
    .addOption(new Option('--security-scanner <scanner>').choices(['snyk', 'trivy', 'custom', 'none']))
    .option('--token <token>', 'persist API token for active provider')
    .option('--clear-token', 'remove token for active provider')
    .option('--show', 'print current configuration')
    .action(async (flags) => {
    try {
        const config = await loadConfig();
        if (flags.show) {
            console.log(JSON.stringify(config, null, 2));
            return;
        }
        const overrides = {};
        if (flags.provider)
            overrides.provider = flags.provider;
        if (flags.model)
            overrides.model = flags.model;
        if (typeof flags.temperature === 'number' && !Number.isNaN(flags.temperature)) {
            overrides.temperature = flags.temperature;
        }
        if (flags.language)
            overrides.language = flags.language;
        if (flags.securityScanner)
            overrides.securityScanner = flags.securityScanner;
        let updated = mergeDefaults(config, overrides);
        const provider = overrides.provider ?? config.defaults.provider;
        if (flags.token) {
            updated = upsertToken(updated, provider, flags.token);
        }
        if (flags.clearToken) {
            updated = upsertToken(updated, provider, undefined);
        }
        await saveConfig(updated);
        console.log(chalk.green('✓ Configuration updated'));
    }
    catch (error) {
        handleError(error);
    }
});
program
    .command('create [input]')
    .description('Create a PLGN pack from code path, prompt, or infer from current directory')
    .option('--name <name>', 'pack name to use in manifest')
    .option('--lang <language>', 'hint for language extraction')
    .option('--agentic', 'enable agentic mode for extraction (default for prompts)')
    .option('--out-dir <path>', 'where to output the new pack', 'packs')
    .option('--verbose', 'enable verbose agent logs')
    .option('--timeout <ms>', 'overall timeout in milliseconds', (value) => parseInt(value))
    .option('--examples <policy>', 'extra examples policy (none|auto|csv)', 'none')
    .action(async (input, flags) => {
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
    const withTimeout = async (p) => {
        if (!timeoutMs)
            return p;
        return await Promise.race([
            p,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs))
        ]);
    };
    try {
        const config = await loadConfig();
        const env = getEnv();
        const agent = createAgent({
            config,
            token: resolveToken(config, config.defaults.provider),
            cacheDir: env.cacheDir
        });
        let request;
        let isPrompt = false;
        let sourcePath;
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
                examples: flags.examples
            };
        }
        else if (input.startsWith('./') || input.startsWith('/') || input.includes('/')) {
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
                examples: flags.examples
            };
        }
        else {
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
                examples: flags.examples
            };
        }
        if (request.verbose) {
            spinner.stop();
            console.log(chalk.cyan(`• Starting pack creation ${isPrompt ? 'from prompt' : 'from path'}...`));
        }
        else {
            spinner.text = `Extracting ${isPrompt ? 'from prompt' : 'feature'}...`;
        }
        let result;
        if (request.prompt) {
            result = await withTimeout(createPackFromPrompt({
                agent,
                request,
                outputDir: flags.outDir,
                name: flags.name
            }));
        }
        else {
            result = await withTimeout(createPackFromSource({
                agent,
                request,
                outputDir: flags.outDir,
                name: flags.name
            }));
        }
        if (request.verbose) {
            console.log(chalk.green(`✓ Pack created at ${result.path}`));
        }
        else {
            spinner.succeed(`Pack created at ${result.path}`);
        }
    }
    catch (error) {
        if (!aborted && spinner) {
            spinner.fail('Failed to create pack');
        }
        handleError(error);
    }
    finally {
        process.removeListener('SIGINT', onSigint);
        if (spinner && !aborted)
            spinner.stop();
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
        const options = {
            registry: flags.registry,
            query: flags.query,
            language: flags.lang
        };
        const spinner = ora('Querying registry...').start();
        const results = await discoverPacks(options, config.defaults);
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
    }
    catch (error) {
        handleError(error);
    }
});
program
    .command('check <packRef>')
    .description('Analyze pack compatibility with current project')
    .option('--lang <language>', 'target language override')
    .action(async (packRef, flags) => {
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
    }
    catch (error) {
        handleError(error);
    }
});
program
    .command('add <packRef>')
    .description('Integrate a pack into the current project')
    .option('--instructions <text>', 'custom integration instructions')
    .option('--dry-run', 'preview without writing changes')
    .option('--agentic', 'force agentic integration path')
    .option('--lang <language>', 'target language override')
    .action(async (packRef, flags) => {
    try {
        const config = await loadConfig();
        const env = getEnv();
        const agent = createAgent({
            config,
            token: resolveToken(config, config.defaults.provider),
            cacheDir: env.cacheDir
        });
        const spinner = ora('Integrating pack...').start();
        const result = await integratePack({
            agent,
            packRef,
            instructions: flags.instructions,
            dryRun: Boolean(flags.dryRun),
            agentic: Boolean(flags.agentic),
            targetLanguage: flags.lang ?? config.defaults.language
        });
        spinner.stop();
        console.log(chalk.green(`Integration prepared with confidence ${(result.changeSet.confidence * 100).toFixed(1)}%`));
        if (result.changeSet.items.length) {
            console.log(chalk.cyan('ChangeSet:'));
            for (const item of result.changeSet.items) {
                console.log(`  [${item.action}] ${item.path} (${item.language})`);
            }
        }
        if (result.vulnerabilities?.findings.length) {
            console.log(chalk.yellow('Security findings:'));
            for (const finding of result.vulnerabilities.findings) {
                console.log(`  ${finding.id} (${finding.severity}) - ${finding.title}`);
            }
        }
    }
    catch (error) {
        handleError(error);
    }
});
program
    .command('publish <path>')
    .description('Publish a pack to the registry')
    .option('--registry <url>', 'target registry endpoint')
    .action(async (path, flags) => {
    try {
        const config = await loadConfig();
        const spinner = ora('Publishing pack...').start();
        await publishPack({
            packDir: path,
            registry: flags.registry,
            defaults: config.defaults
        });
        spinner.succeed('Pack published');
    }
    catch (error) {
        handleError(error);
    }
});
program
    .hook('preAction', () => {
    process.env.PLGN_ENV = 'cli';
});
program
    .configureHelp({
    sortSubcommands: true,
    subcommandTerm: (cmd) => cmd.name() + (cmd.usage() ? ` ${cmd.usage()}` : '')
});
program.parseAsync(process.argv).catch(handleError);
//# sourceMappingURL=index.js.map