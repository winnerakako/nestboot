import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The generators.
 *
 * These exist because the reader and writer of this code is mostly an AI, and
 * an AI follows a pattern it can see far more reliably than a rule it was told
 * once. Hand-written boilerplate drifts by the fifth copy; a stub cannot.
 *
 * Change the stub in `stubs/`, never the generated files.
 */

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const STUBS = join(ROOT, 'stubs');

/** Where generated features land. Overridable so tests do not write into src/. */
export const DEFAULT_FEATURES_ROOT = join(ROOT, 'src', 'features');

export function toKebab(value: string): string {
  return (
    value
      // An acronym followed by a word: HTTPServer -> HTTP-Server. This rule must
      // come first, or the next one turns it into httpserver.
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[\s_]+/g, '-')
      .toLowerCase()
  );
}

export function toPascal(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

interface Replacements {
  [token: string]: string;
}

function render(stub: string, replacements: Replacements): string {
  let content = readFileSync(join(STUBS, stub), 'utf8');
  for (const [token, value] of Object.entries(replacements)) {
    content = content.replaceAll(token, value);
  }
  return content;
}

function write(path: string, content: string): 'created' | 'exists' {
  if (existsSync(path)) return 'exists';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return 'created';
}

export interface GeneratedFile {
  path: string;
  status: 'created' | 'exists';
}

/**
 * A whole feature: the folders, the CLAUDE.md, and the module.
 *
 * Every feature has the same shape, which is what makes paths *derivable*
 * rather than searchable — `ApplyForLoan` is always
 * `features/loans/actions/apply-for-loan.action.ts`, and nobody has to grep.
 */
export function generateFeature(
  rawName: string,
  featuresRoot: string = DEFAULT_FEATURES_ROOT,
): GeneratedFile[] {
  const kebab = toKebab(rawName);
  const pascal = toPascal(rawName);
  const base = join(featuresRoot, kebab);
  const files: GeneratedFile[] = [];

  for (const folder of [
    'contracts/events',
    'actions',
    'dtos',
    'entities',
    'policies',
    'workflows',
    'jobs',
    'schedules',
    'listeners',
    'http',
    'database/migrations',
    'tests',
  ]) {
    mkdirSync(join(base, folder), { recursive: true });
  }

  files.push({
    path: join(base, 'CLAUDE.md'),
    status: write(join(base, 'CLAUDE.md'), render('feature-claude.stub.md', { __NAME__: pascal })),
  });

  const moduleFile = join(base, `${kebab}.module.ts`);
  files.push({
    path: moduleFile,
    status: write(
      moduleFile,
      `import { Module } from '@nestjs/common';

/**
 * ${pascal}.
 *
 * Exports ONLY what lives under contracts/. Another feature that needs
 * something from here imports the contract, never the action or the entity.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
  exports: [],
})
export class ${pascal}Module {}
`,
    ),
  });

  return files;
}

/** An action, its DTO, a failing test, and optionally the HTTP adapter. */
export function generateAction(
  feature: string,
  rawName: string,
  options: { http?: boolean; featuresRoot?: string } = {},
): GeneratedFile[] {
  const featureKebab = toKebab(feature);
  const base = featureBase(feature, options.featuresRoot);

  const pascal = toPascal(rawName);
  const kebab = toKebab(rawName);
  const tokens: Replacements = {
    __NAME__: pascal,
    __KEBAB__: kebab,
    __FEATURE__: featureKebab,
  };

  const files: GeneratedFile[] = [
    {
      path: join(base, 'actions', `${kebab}.action.ts`),
      status: write(join(base, 'actions', `${kebab}.action.ts`), render('action.stub.ts', tokens)),
    },
    {
      path: join(base, 'dtos', `${kebab}.dto.ts`),
      status: write(join(base, 'dtos', `${kebab}.dto.ts`), render('dto.stub.ts', tokens)),
    },
    {
      // Generated failing on purpose: making it pass is the loop.
      path: join(base, 'tests', `${kebab}.action.spec.ts`),
      status: write(
        join(base, 'tests', `${kebab}.action.spec.ts`),
        render('action.spec.stub.ts', tokens),
      ),
    },
  ];

  if (options.http) {
    files.push({
      path: join(base, 'http', `${kebab}.controller.ts`),
      status: write(
        join(base, 'http', `${kebab}.controller.ts`),
        render('controller.stub.ts', tokens),
      ),
    });
  }

  return files;
}

export function generateWorkflow(
  feature: string,
  rawName: string,
  featuresRoot?: string,
): GeneratedFile[] {
  return generateSimple(
    feature,
    rawName,
    'workflows',
    'workflow',
    'workflow.stub.ts',
    featuresRoot,
  );
}

export function generateJob(
  feature: string,
  rawName: string,
  featuresRoot?: string,
): GeneratedFile[] {
  return generateSimple(feature, rawName, 'jobs', 'job', 'job.stub.ts', featuresRoot);
}

export function generateEvent(
  feature: string,
  rawName: string,
  featuresRoot?: string,
): GeneratedFile[] {
  const base = featureBase(feature, featuresRoot);
  const kebab = toKebab(rawName);
  const path = join(base, 'contracts', 'events', `${kebab}.event.ts`);
  return [
    {
      path,
      status: write(path, render('event.stub.ts', { __NAME__: toPascal(rawName) })),
    },
  ];
}

export function generateListener(
  feature: string,
  rawName: string,
  event: string,
  featuresRoot?: string,
): GeneratedFile[] {
  const base = featureBase(feature, featuresRoot);
  const kebab = toKebab(rawName);
  const [eventFeature, eventName] = event.includes('/')
    ? (event.split('/') as [string, string])
    : ([feature, event] as [string, string]);

  const path = join(base, 'listeners', `${kebab}.listener.ts`);
  return [
    {
      path,
      status: write(
        path,
        render('listener.stub.ts', {
          __NAME__: toPascal(rawName),
          __EVENT__: toPascal(eventName),
          __EVENT_FEATURE__: toKebab(eventFeature),
          __EVENT_KEBAB__: toKebab(eventName),
        }),
      ),
    },
  ];
}

/**
 * A migration, named with the timestamp that gives it its position in the
 * global order across platform and every feature.
 */
export function generateMigration(
  feature: string,
  rawName: string,
  now: Date,
  featuresRoot?: string,
): GeneratedFile[] {
  const base = featureBase(feature, featuresRoot);
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const kebab = toKebab(rawName).replaceAll('-', '_');
  const path = join(base, 'database', 'migrations', `${stamp}_${kebab}.sql`);

  return [
    {
      path,
      status: write(path, render('migration.stub.sql', { __DESCRIPTION__: rawName })),
    },
  ];
}

function featureBase(feature: string, featuresRoot: string = DEFAULT_FEATURES_ROOT): string {
  const base = join(featuresRoot, toKebab(feature));
  if (!existsSync(base)) {
    throw new Error(
      `No feature "${toKebab(feature)}".\n` +
        `FIX: create it first with \`pnpm boot:feature ${toKebab(feature)}\`.`,
    );
  }
  return base;
}

function generateSimple(
  feature: string,
  rawName: string,
  folder: string,
  suffix: string,
  stub: string,
  featuresRoot?: string,
): GeneratedFile[] {
  const base = featureBase(feature, featuresRoot);
  const kebab = toKebab(rawName);
  const path = join(base, folder, `${kebab}.${suffix}.ts`);

  return [
    {
      path,
      status: write(path, render(stub, { __NAME__: toPascal(rawName), __KEBAB__: kebab })),
    },
  ];
}
