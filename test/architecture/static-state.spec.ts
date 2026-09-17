import { describe, expect, it } from 'vitest';
import { ruleFailure, sourceFiles, stripNonCode } from './support.js';

/**
 * A long-lived process shares module scope across every request.
 *
 * A module-level `let` that a request writes is read by the *next* request, on
 * a different user's behalf. The symptom shows up somewhere unrelated, hours
 * later, and does not reproduce locally where one request runs at a time. This
 * is the single most expensive bug class in a framework like this one, so it is
 * a rule rather than a code-review habit.
 */

/**
 * Module-level state that is written once at import time and only read
 * afterwards. Each entry says why it is safe.
 */
const ALLOWLIST: Array<{ file: string; reason: string }> = [
  {
    file: 'src/platform/dbos/define.ts',
    reason: 'the declared-schedule list, appended at import time and read at boot',
  },
  {
    file: 'src/platform/health/health.service.ts',
    reason: 'BOOTED_AT, a const stamped once at import',
  },
  {
    file: 'src/platform/housekeeping/housekeeping.workflows.ts',
    reason:
      'the database handles the schedules run against, bound once at boot. The schedules are ' +
      'declared at import time (that is how DBOS registers them), so they cannot take them ' +
      'through constructor injection.',
  },
];

describe('no mutable module-level state', () => {
  const files = sourceFiles('src').filter(
    (file) => !ALLOWLIST.some((entry) => file.path === entry.file),
  );

  it('declares no top-level `let` or `var`', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const lines = stripNonCode(file.content).split('\n');
      lines.forEach((line, index) => {
        // Column zero only: an indented `let` is inside a function or class,
        // where it is per-call state and perfectly fine.
        if (/^(let|var)\s+\w/.test(line)) {
          offenders.push(`${file.path}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      ruleFailure(
        'Module-level mutable state leaks across requests in a long-lived process.',
        offenders,
        'move it inside the function, make it an injectable provider (Nest gives you one ' +
          'instance with a lifecycle), or — if it is a cache — use cache.remember(), which is ' +
          'the interface that exists precisely so nobody reaches for a module-level Map. ' +
          'If it really is write-once-at-import, add it to ALLOWLIST in this spec with a reason.',
      ),
    ).toEqual([]);
  });

  it('exports no mutable binding', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const lines = stripNonCode(file.content).split('\n');
      lines.forEach((line, index) => {
        if (/^export\s+(let|var)\s+\w/.test(line)) {
          offenders.push(`${file.path}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      ruleFailure(
        'An exported `let` can be reassigned by any importer, from anywhere.',
        offenders,
        'export a const, or a function that returns the value.',
      ),
    ).toEqual([]);
  });

  it('keeps the allowlist honest', () => {
    // An allowlist entry for a file that no longer exists hides the next
    // violation that lands in a file with the same name.
    const paths = new Set(sourceFiles('src').map((f) => f.path));
    const stale = ALLOWLIST.filter((entry) => !paths.has(entry.file)).map((e) => e.file);

    expect(
      stale,
      ruleFailure(
        'The static-state allowlist names files that no longer exist.',
        stale,
        'delete the entry from ALLOWLIST in this spec.',
      ),
    ).toEqual([]);
  });
});
