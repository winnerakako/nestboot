import { describe, expect, it } from 'vitest';
import * as exceptions from '../../src/platform/http/platform.exception.js';
import { PlatformException } from '../../src/platform/http/platform.exception.js';
import { knownProblemTypes } from '../../src/platform/http/problem.js';
import { ruleFailure, sourceFiles, stripNonCode } from './support.js';

describe('failure is always a registered problem type', () => {
  const concreteExceptions = Object.entries(exceptions).filter(
    ([, value]) =>
      typeof value === 'function' &&
      value !== PlatformException &&
      value.prototype instanceof PlatformException,
  ) as Array<[string, new (...args: never[]) => PlatformException]>;

  it('exports exception classes to check', () => {
    expect(concreteExceptions.length).toBeGreaterThan(5);
  });

  it('gives every exception a problem type from the registry', () => {
    const registered = new Set(knownProblemTypes().map((t) => t.slug));
    const offenders: string[] = [];

    for (const [name, Exception] of concreteExceptions) {
      // Constructed with junk arguments on purpose: we are inspecting the
      // declared problem type, which cannot depend on the arguments.
      const instance = new Exception('x' as never, 1 as never, {} as never);
      if (!instance.problem) {
        offenders.push(`${name} declares no problem type`);
      } else if (!registered.has(instance.problem.slug)) {
        offenders.push(`${name} uses unregistered type "${instance.problem.slug}"`);
      }
    }

    expect(
      offenders,
      ruleFailure(
        'Every PlatformException carries a problem type from the registry.',
        offenders,
        'register it with defineProblem(slug, title, status) in platform/http/problem.ts. ' +
          'The `type` URI is the one field a client is allowed to branch on, so a string ' +
          'invented at a throw site is an unversioned contract nobody knows they published.',
      ),
    ).toEqual([]);
  });

  it('gives each problem type a status matching its meaning', () => {
    const offenders = knownProblemTypes()
      .filter((t) => t.status < 400 || t.status > 599)
      .map((t) => `${t.slug} -> ${t.status}`);

    expect(offenders).toEqual([]);
  });

  it('never throws a bare Error from platform code outside the boundary', () => {
    // Boot-time and developer-error throws are legitimately bare: they are read
    // by a person reading a terminal, not serialised to a caller.
    const BOOT_TIME = [
      'src/platform/config/',
      'src/platform/db/migrator.ts',
      'src/platform/db/migrate.cli.ts',
      'src/platform/dbos/',
      'src/platform/http/problem.ts',
      'src/main.ts',
      'src/platform/testing/',
      // Refuses CORS_ORIGINS="*" at boot. Same category: a misconfiguration a
      // person reads in a terminal, not a failure serialised to a caller.
      'src/platform/security/headers.ts',
      // The generators. Their output goes to a terminal, by definition.
      'src/platform/console/',
      // Registration-time conflicts (two listeners sharing a name) and
      // boot-order mistakes. Both throw before any request exists.
      'src/platform/events/events.ts',
      'src/platform/housekeeping/housekeeping.workflows.ts',
    ];

    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      if (BOOT_TIME.some((prefix) => file.path.startsWith(prefix))) continue;

      stripNonCode(file.content)
        .split('\n')
        .forEach((line, index) => {
          if (/throw new (Error|TypeError|RangeError)\b/.test(line)) {
            offenders.push(`${file.path}:${index + 1}`);
          }
        });
    }

    expect(
      offenders,
      ruleFailure(
        'A bare Error reaching the filter becomes a 500 with its detail withheld.',
        offenders,
        'throw a PlatformException subclass so the failure renders as the problem document ' +
          'it actually is. If this genuinely is an unexpected condition, that is what ' +
          'InternalException says explicitly.',
      ),
    ).toEqual([]);
  });
});
