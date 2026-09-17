import { describe, expect, it } from 'vitest';
import { ruleFailure, sourceFiles, stripNonCode } from './support.js';

/**
 * The console is the keys to the kingdom: it cancels workflows, reads logs, and
 * (from phase 3) edits rate-limit policies. One controller that forgets its
 * guard publishes all of that.
 *
 * `OpsGuard` cannot be registered as an `APP_GUARD` to solve this, because Nest
 * applies an APP_GUARD globally no matter which module declares it — that would
 * put the console's IP allowlist in front of the whole application. So it is
 * per-controller, and this rule is what makes per-controller safe.
 */
describe('every /ops controller is guarded', () => {
  const controllers = sourceFiles('src/platform/ops').filter((file) =>
    file.path.endsWith('.controller.ts'),
  );

  it('finds the console controllers', () => {
    expect(controllers.length).toBeGreaterThanOrEqual(5);
  });

  it('carries @UseGuards(OpsGuard)', () => {
    const offenders = controllers
      .filter((file) => !file.content.includes('@UseGuards(OpsGuard)'))
      .map((file) => file.path);

    expect(
      offenders,
      ruleFailure(
        'A controller under src/platform/ops is missing its guard.',
        offenders,
        'add `@UseGuards(OpsGuard)` directly above its `@Controller(...)`. Do NOT register ' +
          'OpsGuard as an APP_GUARD to fix this — Nest applies APP_GUARD globally regardless ' +
          'of the declaring module, which would guard the entire app with the console rules.',
      ),
    ).toEqual([]);
  });

  it('registers no global guard from the console module', () => {
    // Comments are stripped: the modules deliberately *explain* why APP_GUARD is
    // wrong here, and a rule that trips on its own rationale teaches the reader
    // to delete the rationale.
    const offenders = sourceFiles('src/platform/ops')
      .filter((file) => stripNonCode(file.content).includes('APP_GUARD'))
      .map((file) => file.path);

    expect(
      offenders,
      ruleFailure(
        'The console must not register an APP_GUARD.',
        offenders,
        'use @UseGuards(OpsGuard) per controller. An APP_GUARD is global in Nest even when ' +
          'declared inside a feature module.',
      ),
    ).toEqual([]);
  });
});
