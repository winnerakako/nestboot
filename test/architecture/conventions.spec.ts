import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ruleFailure, sourceFiles, stripNonCode } from './support.js';

/**
 * The conventions that make a path derivable.
 *
 * The point of all of this is that `CreateInvoice` is always
 * `features/invoicing/actions/create-invoice.action.ts` — so an AI that has
 * never seen this repo can construct the path instead of searching for it. A
 * convention followed 90% of the time provides none of that benefit, because
 * you have to check every time.
 */
const features = sourceFiles('src/features');

function kebab(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/** Suffix a folder's files must carry, and the export they must name. */
const FOLDERS: Array<{ folder: string; suffix: string; exported: RegExp; what: string }> = [
  {
    folder: 'actions',
    suffix: '.action.ts',
    exported: /export class (\w+)Action\b/,
    what: 'an Action class',
  },
  {
    folder: 'dtos',
    suffix: '.dto.ts',
    exported: /export const (\w+)Schema\b/,
    what: 'a zod Schema const',
  },
  {
    folder: 'policies',
    suffix: '.policy.ts',
    exported: /export (class|const) (\w+)Policy\b/,
    what: 'a Policy',
  },
];

describe('feature conventions', () => {
  it.each(FOLDERS)('names every file in $folder/ consistently', ({ folder, suffix }) => {
    const offenders = features
      .filter((file) => file.path.includes(`/${folder}/`))
      .filter((file) => !file.path.endsWith(suffix))
      .map((file) => file.path);

    expect(
      offenders,
      ruleFailure(
        `Every file in a feature's ${folder}/ ends with ${suffix}.`,
        offenders,
        `rename it. The suffix is what makes the path derivable from the name, and it is ` +
          `what the generators emit.`,
      ),
    ).toEqual([]);
  });

  it.each(FOLDERS)(
    'matches the filename to the export in $folder/',
    ({ folder, suffix, exported, what }) => {
      const offenders: string[] = [];

      for (const file of features.filter((f) => f.path.endsWith(suffix))) {
        const match = exported.exec(file.content);
        if (!match) {
          offenders.push(`${file.path} exports no ${what}`);
          continue;
        }
        const name = match[match.length - 1] ?? '';
        const expected = `${kebab(name)}${suffix}`;
        if (basename(file.path) !== expected) {
          offenders.push(`${file.path} exports ${name}, so it should be named ${expected}`);
        }
      }

      expect(
        offenders,
        ruleFailure(
          `In ${folder}/, the filename is the kebab-case of what it exports.`,
          offenders,
          'rename the file (or the export) so the two agree. `pnpm boot:action` gets this right.',
        ),
      ).toEqual([]);
    },
  );

  it('gives every action a DTO', () => {
    const dtos = new Set(
      features.filter((f) => f.path.endsWith('.dto.ts')).map((f) => basename(f.path, '.dto.ts')),
    );

    const offenders = features
      .filter((file) => file.path.endsWith('.action.ts'))
      .filter((file) => !dtos.has(basename(file.path, '.action.ts')))
      .map((file) => file.path);

    expect(
      offenders,
      ruleFailure(
        'Every action takes a typed DTO, and validation lives on that DTO.',
        offenders,
        'add dtos/<same-name>.dto.ts exporting a zod schema. Validation defined anywhere else ' +
          'is validation one of the two surfaces will not apply.',
      ),
    ).toEqual([]);
  });

  it('keeps domain events in contracts/, where subscribers may legally import them', () => {
    const offenders = features
      .filter((file) => file.path.endsWith('.event.ts'))
      .filter((file) => !file.path.includes('/contracts/events/'))
      .map((file) => file.path);

    expect(
      offenders,
      ruleFailure(
        'A DomainEvent lives in the emitting feature’s contracts/events/.',
        offenders,
        'move it. An event outside contracts/ cannot be imported by a subscriber without ' +
          'breaking the one boundary rule this template has.',
      ),
    ).toEqual([]);
  });

  it('gives every background declaration its operator metadata', () => {
    const offenders: string[] = [];

    for (const file of features) {
      const code = stripNonCode(file.content);
      for (const kind of ['defineWorkflow', 'defineJob', 'defineSchedule', 'onEvent']) {
        if (!code.includes(`${kind}(`)) continue;
        if (!code.includes('group:') || !code.includes('description:')) {
          offenders.push(`${file.path} calls ${kind}() without meta.group/description`);
        }
      }
    }

    expect(
      offenders,
      ruleFailure(
        'Every workflow, job, schedule and listener carries meta: { group, description }.',
        offenders,
        'add it. The group is what lets an operator ask about "payments" instead of a class ' +
          'name, and it is what /ops groups by — a dimension that is 80% populated is worse ' +
          'than none, because the tab then lies by omission.',
      ),
    ).toEqual([]);
  });

  it('gives every workflow a test', () => {
    const tested = features
      .filter((file) => file.path.includes('/tests/'))
      .map((file) => file.content)
      .join('\n');

    const offenders = features
      .filter((file) => file.path.endsWith('.workflow.ts'))
      .filter((file) => {
        const name = /defineWorkflow\(\{\s*name: '(\w+)'/.exec(file.content)?.[1];
        return name ? !tested.includes(name) : false;
      })
      .map((file) => file.path);

    expect(
      offenders,
      ruleFailure(
        'Every workflow has a test naming it.',
        offenders,
        'a workflow is multi-step, durable and resumable — the three properties least likely ' +
          'to be right by inspection and most expensive to get wrong in production.',
      ),
    ).toEqual([]);
  });
});
