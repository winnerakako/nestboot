import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ruleFailure } from './support.js';

/**
 * Two rules about the console's forms, both learned the hard way.
 *
 * Every mutation in /ops cancels a workflow, retries a dead letter, or changes
 * a rate-limit policy. A form that cannot submit a valid CSRF token is a button
 * that is permanently broken, and — because Handlebars renders a missing value
 * as empty string rather than failing — it breaks silently.
 */
const ROOT = resolve(import.meta.dirname, '..', '..');
const TEMPLATES = join(ROOT, 'src', 'platform', 'ops', 'view', 'templates');

interface Template {
  path: string;
  lines: string[];
}

function templates(): Template[] {
  const found: Template[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.hbs')) {
        found.push({ path: relative(ROOT, path), lines: readFileSync(path, 'utf8').split('\n') });
      }
    }
  };
  walk(TEMPLATES);
  return found;
}

/** How many `{{#each}}` / `{{#with}}` blocks enclose this line. */
function depthAt(lines: string[], index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    const line = lines[i] ?? '';
    for (const _ of line.matchAll(/\{\{#(each|with)\b/g)) depth++;
    for (const _ of line.matchAll(/\{\{\/(each|with)\}\}/g)) depth--;
  }
  return Math.max(0, depth);
}

describe('the console’s forms', () => {
  const all = templates();

  it('finds the templates', () => {
    expect(all.length).toBeGreaterThan(5);
  });

  it('gives every POST form a CSRF token', () => {
    const offenders: string[] = [];

    for (const template of all) {
      const source = template.lines.join('\n');
      // Opening tags can span lines, so match the whole form element.
      const forms = source.matchAll(/<form[^>]*method="post"[\s\S]*?<\/form>/gi);
      for (const form of forms) {
        if (!form[0].includes('name="_csrf"')) {
          offenders.push(`${template.path}: a POST form with no _csrf input`);
        }
      }
    }

    expect(
      offenders,
      ruleFailure(
        'A form in /ops posts without a CSRF token.',
        offenders,
        'add <input type="hidden" name="_csrf" value="{{csrf}}"> inside the form, and make ' +
          'sure the controller puts `csrf: this.csrf.issue(reply)` in the render context. ' +
          'OpsGuard rejects every unsafe request without one, so the button simply will not work.',
      ),
    ).toEqual([]);
  });

  it('reaches the root context for the token from inside every block', () => {
    const offenders: string[] = [];

    for (const template of all) {
      template.lines.forEach((line, index) => {
        if (!line.includes('name="_csrf"')) return;

        const expected = depthAt(template.lines, index);
        const actual =
          (/value="\{\{((?:\.\.\/)*)csrf\}\}"/.exec(line)?.[1] ?? '').split('../').length - 1;

        if (actual !== expected) {
          offenders.push(
            `${template.path}:${index + 1} uses ${'../'.repeat(actual)}csrf ` +
              `inside ${expected} block(s); it needs ${'../'.repeat(expected)}csrf`,
          );
        }
      });
    }

    expect(
      offenders,
      ruleFailure(
        'A CSRF token does not resolve to the root context.',
        offenders,
        'Handlebars does NOT walk up the context chain for a bare identifier: inside ' +
          '{{#each}}, `{{csrf}}` looks for `csrf` on the ITEM, finds nothing, and renders an ' +
          'empty string. The form then submits a blank token and the button is permanently ' +
          'broken — with no error anywhere. Add one `../` per enclosing block.',
      ),
    ).toEqual([]);
  });
});
