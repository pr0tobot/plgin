import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fsExtra from 'fs-extra';
const { pathExists, readJson, writeJson, ensureDir } = fsExtra;
import { z } from 'zod';
import type { PackManifest, ValidationResult, VulnReport, ComplianceReport } from './types.js';

const execAsync = promisify(exec);

const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(1),
  source_credits: z.object({
    original: z.string(),
    opt_out_training: z.boolean()
  }),
  requirements: z.object({
    languages: z.array(z.string()).min(1),
    frameworks: z.array(z.string()),
    minVersion: z.record(z.string()).optional()
  }),
  provides: z.record(z.unknown()),
  examples: z.object({
    entries: z.array(z.any()).optional()
  }).passthrough(),
  ai_adaptation: z.object({
    strategy: z.enum(['agentic-hybrid', 'code-first', 'semantic-only']),
    agent_model: z.string(),
    preserve: z.array(z.string()),
    adaptable: z.array(z.string()),
    min_confidence: z.number().min(0).max(1)
  }),
  security: z.object({
    scanner: z.string(),
    findings: z.number(),
    critical: z.number()
  }).optional()
});

export async function validatePackStructure(packDir: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const manifestPath = join(packDir, 'manifest.json');
  if (!(await pathExists(manifestPath))) {
    errors.push('Missing manifest.json');
    return { valid: false, errors, warnings };
  }

  try {
    const manifest = await readJson(manifestPath);
    const result = manifestSchema.safeParse(manifest);

    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`manifest.json: ${issue.path.join('.')}: ${issue.message}`);
      }
    }
  } catch (error: any) {
    errors.push(`Failed to parse manifest.json: ${error.message}`);
    return { valid: false, errors, warnings };
  }

  const requiredDirs = ['source', 'patterns'];
  for (const dir of requiredDirs) {
    if (!(await pathExists(join(packDir, dir)))) {
      errors.push(`Missing required directory: ${dir}/`);
    }
  }

  const recommendedDirs = ['agents', 'tests'];
  for (const dir of recommendedDirs) {
    if (!(await pathExists(join(packDir, dir)))) {
      warnings.push(`Recommended directory missing: ${dir}/`);
    }
  }

  if (!(await pathExists(join(packDir, 'README.md')))) {
    warnings.push('Missing README.md');
  }

  const sourceDir = join(packDir, 'source');
  if (await pathExists(sourceDir)) {
    const sourceFiles = await listFilesRecursive(sourceDir);
    if (sourceFiles.length === 0) {
      errors.push('source/ directory is empty');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export async function runSecurityScan(packDir: string, scanner: string = 'none'): Promise<VulnReport> {
  if (scanner === 'none') {
    return {
      scanner: 'none',
      findings: []
    };
  }

  const findings: any[] = [];

  try {
    const sourceDir = join(packDir, 'source');
    const files = await listFilesRecursive(sourceDir);

    for (const file of files) {
      const content = await readFile(file, 'utf8');

      if (content.includes('eval(')) {
        findings.push({
          id: 'EVAL_USAGE',
          title: 'Use of eval() detected',
          severity: 'high',
          description: 'eval() can execute arbitrary code',
          file: basename(file),
          remediation: 'Avoid eval(); use safer alternatives'
        });
      }

      if (content.match(/password\s*=\s*['"][^'"]+['"]/i)) {
        findings.push({
          id: 'HARDCODED_PASSWORD',
          title: 'Hardcoded password detected',
          severity: 'critical',
          description: 'Password found in source code',
          file: basename(file),
          remediation: 'Use environment variables or secure vaults'
        });
      }
    }
  } catch (error: any) {
    findings.push({
      id: 'SCAN_ERROR',
      title: 'Security scan failed',
      severity: 'low',
      description: error.message
    });
  }

  return {
    scanner,
    findings
  };
}

export async function generateComplianceReport(packDir: string): Promise<ComplianceReport> {
  const manifest = await readJson(join(packDir, 'manifest.json')) as PackManifest;
  const validation = await validatePackStructure(packDir);
  const security = await runSecurityScan(packDir, manifest.security?.scanner || 'none');

  let testsRun = false;
  let testResults;

  const packageJsonPath = join(packDir, 'package.json');
  if (await pathExists(packageJsonPath)) {
    try {
      const { stdout, stderr } = await execAsync('npm test', { cwd: packDir, timeout: 60000 });
      testsRun = true;
      testResults = {
        passed: stdout.includes('pass') ? 1 : 0,
        failed: stderr ? 1 : 0,
        output: stdout + stderr
      };
    } catch (error: any) {
      testsRun = true;
      testResults = {
        passed: 0,
        failed: 1,
        output: error.message
      };
    }
  }

  const report: ComplianceReport = {
    packName: manifest.name,
    version: manifest.version,
    timestamp: new Date().toISOString(),
    validation,
    security,
    testsRun,
    testResults
  };

  const logsDir = join(packDir, 'logs');
  await ensureDir(logsDir);
  await writeJson(
    join(logsDir, `publish-${Date.now()}.json`),
    report,
    { spaces: 2 }
  );

  return report;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}
