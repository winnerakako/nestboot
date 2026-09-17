/**
 * The one boundary rule: features -> contracts -> platform.
 *
 * Every violation message names the rule AND the fix, because the reader of
 * this output is usually an AI that has never seen the blueprint.
 */
module.exports = {
  forbidden: [
    {
      name: 'platform-never-imports-features',
      severity: 'error',
      comment:
        'platform/ is the framework and must not know any feature exists. FIX: invert it — ' +
        'expose an extension point in platform/ (an interface + a registry) and have the ' +
        'feature register into it from its own module.',
      from: { path: '^src/platform' },
      to: { path: '^src/features' },
    },
    {
      name: 'platform-never-imports-contracts',
      severity: 'error',
      comment:
        'platform/ must not import src/contracts either — contracts are shared between ' +
        'features, not between platform and features. FIX: move the type into platform/.',
      from: { path: '^src/platform' },
      to: { path: '^src/contracts' },
    },
    {
      name: 'cross-feature-imports-must-use-contracts',
      severity: 'error',
      comment:
        'A feature may import another feature ONLY from its contracts/ folder. ' +
        'FIX: move the interface, DTO type or event you need into ' +
        'src/features/<other>/contracts/ and import that. If you need its action, you do not ' +
        'need its action — you need an event (see recipes) or a contract it implements.',
      from: { path: '^src/features/([^/]+)/' },
      to: {
        path: '^src/features/([^/]+)/',
        pathNot: [
          '^src/features/$1/', // same feature: anything goes
          '^src/features/[^/]+/contracts/', // other features: contracts only
        ],
      },
    },
    {
      name: 'controllers-never-touch-the-database',
      severity: 'error',
      comment:
        'Controllers are adapters: validate -> authorize -> call an action -> format. ' +
        'FIX: move the query into an action under actions/ and call it.',
      from: { path: '/http/.+\\.controller\\.ts$', pathNot: '^src/platform/ops/' },
      to: { path: '(/entities/|^src/platform/db/|@dbos-inc/dbos-sdk)' },
    },
    {
      name: 'actions-never-see-http',
      severity: 'error',
      comment:
        'An action must be runnable from a queue worker, so it cannot touch HTTP. ' +
        'FIX: take what you need as a field on the DTO — the actor travels on the DTO.',
      from: { path: '/actions/.+\\.action\\.ts$' },
      // Same anchoring trap as above: the fastify patterns must match a
      // resolved node_modules path, so only the src/ one may be anchored.
      to: {
        path: '(@nestjs[/+]platform-fastify|node_modules/(\\.pnpm/)?fastify@?|^src/platform/http/)',
      },
    },
    {
      name: 'features-never-import-the-dbos-vendor',
      severity: 'error',
      comment:
        'DBOS is wrapped in platform/dbos/ so it can be replaced. ' +
        'FIX: import { Workflow, Step, OpsMeta } from platform/dbos instead of @dbos-inc/dbos-sdk.',
      from: { path: '^src/features' },
      // NOT anchored, and tolerant of both layouts. An external dependency is
      // reported by its RESOLVED path, which under pnpm is
      // `node_modules/.pnpm/@dbos-inc+dbos-sdk@4.27.6/...` and under npm is
      // `node_modules/@dbos-inc/dbos-sdk/...`. An anchored `^@dbos-inc/...`
      // matches neither, so the rule silently never fires — which is worse than
      // having no rule, because it looks like coverage.
      to: { path: '@dbos-inc[/+]dbos-sdk' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A dependency cycle. FIX: extract the shared piece into a third module both can import.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'This file is imported by nothing. FIX: wire it up or delete it.',
      from: {
        orphan: true,
        pathNot: ['\\.d\\.ts$', '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$', '^src/main\\.ts$'],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['require', 'node'] },
    exclude: { path: '(\\.spec\\.ts$|^src/platform/testing/)' },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
