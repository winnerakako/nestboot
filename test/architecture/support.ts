import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');

export interface SourceFile {
  /** Path relative to the repository root, which is what a failure message shows. */
  path: string;
  absolutePath: string;
  content: string;
}

export function sourceFiles(
  directory = 'src',
  options: { includeSpecs?: boolean } = {},
): SourceFile[] {
  const files: SourceFile[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const absolutePath = join(dir, entry);
      if (statSync(absolutePath).isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!absolutePath.endsWith('.ts') || absolutePath.endsWith('.d.ts')) continue;
      if (!options.includeSpecs && absolutePath.endsWith('.spec.ts')) continue;

      files.push({
        path: relative(ROOT, absolutePath),
        absolutePath,
        content: readFileSync(absolutePath, 'utf8'),
      });
    }
  }

  walk(join(ROOT, directory));
  return files;
}

/**
 * Format a rule failure the way every spec in here does: the offending places,
 * then what to do about them.
 *
 * The reader of this output is usually an AI that has never read the blueprint,
 * so a message that only says what is wrong causes a plausible wrong fix. Every
 * message states the rule, the reason, and the move.
 */
export function ruleFailure(rule: string, offenders: string[], fix: string): string {
  return [`${rule}`, '', ...offenders.map((o) => `  - ${o}`), '', `FIX: ${fix}`].join('\n');
}

/** Strip comments and string literals before scanning for code patterns. */
export function stripNonCode(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}
