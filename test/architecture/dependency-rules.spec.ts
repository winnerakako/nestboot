import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../../.dependency-cruiser.cjs') as {
  forbidden: Array<{
    name: string;
    from: { path?: string; pathNot?: string };
    to: { path?: string; pathNot?: string[]; circular?: boolean };
    // `from.pathNot` is a single pattern here, not a list.
  }>;
};

/**
 * The boundary rules, tested against the paths dependency-cruiser really emits.
 *
 * A misconfigured rule is worse than a missing one: it reports zero violations
 * forever and reads as coverage. Two of these were dead exactly that way —
 * anchored as `^@dbos-inc/dbos-sdk`, which can never match, because an external
 * dependency is reported by its RESOLVED path:
 *
 *   node_modules/.pnpm/@dbos-inc+dbos-sdk@4.27.6/node_modules/@dbos-inc/dbos-sdk/dist/src/index.js
 *
 * Note pnpm's `+` in the store path. The rules ran clean for the whole build
 * while enforcing nothing.
 */

const rule = (name: string) => {
  const found = config.forbidden.find((entry) => entry.name === name);
  expect(found, `no rule named "${name}"`).toBeDefined();
  return found!;
};

const matches = (pattern: string | undefined, path: string) =>
  pattern !== undefined && new RegExp(pattern).test(path);

/** How the two package managers lay out an installed dependency on disk. */
const resolved = {
  pnpm: (pkg: string) =>
    `node_modules/.pnpm/${pkg.replace('/', '+')}@1.0.0/node_modules/${pkg}/dist/index.js`,
  npm: (pkg: string) => `node_modules/${pkg}/dist/index.js`,
};

describe('the dependency rules actually match what depcruise emits', () => {
  it('declares every rule the architecture depends on', () => {
    const names = config.forbidden.map((entry) => entry.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'platform-never-imports-features',
        'cross-feature-imports-must-use-contracts',
        'controllers-never-touch-the-database',
        'actions-never-see-http',
        'features-never-import-the-dbos-vendor',
        'no-circular',
      ]),
    );
  });

  describe('features-never-import-the-dbos-vendor', () => {
    const target = rule('features-never-import-the-dbos-vendor');

    it('matches the vendor under both pnpm and npm layouts', () => {
      // The exact string that went unmatched for the whole build.
      expect(matches(target.to.path, resolved.pnpm('@dbos-inc/dbos-sdk'))).toBe(true);
      expect(matches(target.to.path, resolved.npm('@dbos-inc/dbos-sdk'))).toBe(true);
    });

    it('applies to features and not to the wrapper that is allowed to import it', () => {
      expect(matches(target.from.path, 'src/features/loans/workflows/x.workflow.ts')).toBe(true);
      // platform/dbos is precisely where the vendor is supposed to live.
      expect(matches(target.from.path, 'src/platform/dbos/runtime.ts')).toBe(false);
    });

    it('does not match an unrelated package', () => {
      expect(matches(target.to.path, resolved.pnpm('drizzle-orm'))).toBe(false);
    });
  });

  describe('actions-never-see-http', () => {
    const target = rule('actions-never-see-http');

    it('matches fastify and the platform HTTP layer', () => {
      expect(matches(target.to.path, resolved.pnpm('@nestjs/platform-fastify'))).toBe(true);
      expect(matches(target.to.path, resolved.npm('fastify'))).toBe(true);
      expect(matches(target.to.path, 'src/platform/http/cursor.ts')).toBe(true);
    });

    it('applies to actions only', () => {
      expect(matches(target.from.path, 'src/features/loans/actions/apply.action.ts')).toBe(true);
      expect(matches(target.from.path, 'src/features/loans/http/apply.controller.ts')).toBe(false);
    });

    it('leaves a package that merely contains the word alone', () => {
      // `fastify-something` is not fastify; anchoring on the path segment keeps
      // the rule from flagging an unrelated dependency.
      expect(matches(target.to.path, 'src/features/loans/actions/fastify-helper.ts')).toBe(false);
    });
  });

  describe('platform-never-imports-features', () => {
    const target = rule('platform-never-imports-features');

    it('catches the inverted dependency in either direction of nesting', () => {
      expect(matches(target.from.path, 'src/platform/ops/logs/logs.controller.ts')).toBe(true);
      expect(matches(target.to.path, 'src/features/loans/actions/apply.action.ts')).toBe(true);
    });
  });

  describe('controllers-never-touch-the-database', () => {
    const target = rule('controllers-never-touch-the-database');

    it('matches entities, the db layer and the vendor', () => {
      expect(matches(target.to.path, 'src/features/loans/entities/loan.entity.ts')).toBe(true);
      expect(matches(target.to.path, 'src/platform/db/app-db.service.ts')).toBe(true);
      expect(matches(target.to.path, resolved.pnpm('@dbos-inc/dbos-sdk'))).toBe(true);
    });

    it('exempts the console, which is a read surface over those tables', () => {
      expect(matches(target.from.pathNot, 'src/platform/ops/logs/logs.controller.ts')).toBe(true);
    });
  });

  it('never anchors a rule on a bare package name', () => {
    // The mistake, stated as a rule: `^@scope/pkg` and `^pkg` can never match a
    // resolved path, which always begins with `node_modules/`.
    const offenders: string[] = [];

    for (const entry of config.forbidden) {
      for (const [side, path] of [
        ['from', entry.from.path],
        ['to', entry.to.path],
      ] as const) {
        if (!path) continue;
        for (const branch of path.replace(/^\(|\)$/g, '').split('|')) {
          if (/^\^(@|[a-z][\w-]*$)/.test(branch) && !branch.startsWith('^src/')) {
            offenders.push(`${entry.name}.${side}: "${branch}"`);
          }
        }
      }
    }

    expect(
      offenders,
      `These patterns anchor on a package name and can never match.\n` +
        offenders.map((o) => `  - ${o}`).join('\n') +
        `\n\nFIX: drop the ^ and match the resolved path, e.g. '@scope[/+]pkg' —\n` +
        `pnpm writes '@scope+pkg' in its store path, npm writes '@scope/pkg'.`,
    ).toEqual([]);
  });
});
