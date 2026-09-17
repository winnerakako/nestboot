import { describe, expect, it } from 'vitest';
import { ruleFailure, sourceFiles, stripNonCode } from './support.js';

/**
 * Raw SQL rows must not claim to contain `Date`.
 *
 * `drizzle-orm` installs its own `pg` type parsers and returns `timestamptz` as
 * a **string** on the raw `execute()` path — it parses timestamps per column in
 * the query builder instead. A row typed `{ ts: Date }` therefore compiles
 * perfectly and holds a string at runtime, and the failure is silent:
 *
 *   - `row.locked_until > new Date()` compares a string to an object and is
 *     always false. That disabled account lockout here.
 *   - `hit.windowStart.getTime()` throws, and the rate limiter's fail-open
 *     swallowed it — so the limiter was off and nothing said so.
 *
 * Both bugs were invisible to the compiler and to code review. This rule is how
 * they stay fixed: declare the column as `string`, and the compiler then forces
 * a conversion through `toDate()` at the mapper.
 */
describe('raw SQL rows are typed honestly', () => {
  it('never declares a Date in an execute<> row type', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles('src')) {
      const code = stripNonCode(file.content);

      // Row types passed to execute<…>, whether inline or a named interface
      // reached from one. Both forms are checked by looking at every `Raw*`
      // interface and every inline generic on execute.
      const inline = code.matchAll(/execute<\{([^}]*)\}>/g);
      for (const match of inline) {
        if (/:\s*Date\b/.test(match[1] ?? '')) {
          offenders.push(`${file.path}: inline execute<> row declares a Date`);
        }
      }

      const named = code.matchAll(/interface\s+(Raw\w+)\s*\{([\s\S]*?)\n\}/g);
      for (const match of named) {
        if (/:\s*Date\b/.test(match[2] ?? '')) {
          offenders.push(`${file.path}: ${match[1]} declares a Date`);
        }
      }
    }

    expect(
      offenders,
      ruleFailure(
        'A raw SQL row type declares a Date, but drizzle returns timestamptz as a string.',
        offenders,
        'declare the column as `string` (or `string | null`) and convert in the mapper with ' +
          'toDate()/toDateOrNull() from platform/db/raw.ts. The compiler then refuses to let ' +
          'the string reach a Date field — which is the whole point, because neither the ' +
          'compiler nor a reviewer can see this mistake when the type says Date.',
      ),
    ).toEqual([]);
  });
});
