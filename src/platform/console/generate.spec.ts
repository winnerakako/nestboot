import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateAction,
  generateEvent,
  generateFeature,
  generateMigration,
  generateWorkflow,
  toKebab,
  toPascal,
} from './generate.js';

const FEATURE = 'fixture';

/**
 * Generated into a temp directory, never into src/features.
 *
 * Writing a fixture into the real tree makes it visible to the architecture
 * specs, which scan src/ — and since test files run in parallel, that produced a
 * failure in a completely unrelated spec depending on timing.
 */
let FEATURES: string;

describe('the generators', () => {
  beforeEach(() => {
    FEATURES = mkdtempSync(join(tmpdir(), 'nestboot-generators-'));
  });

  afterEach(() => {
    rmSync(FEATURES, { recursive: true, force: true });
  });

  describe('naming', () => {
    it('derives the path from the name, so nothing has to be grepped for', () => {
      expect(toKebab('ApplyForLoan')).toBe('apply-for-loan');
      expect(toKebab('HTTPServer')).toBe('http-server');
      expect(toPascal('apply-for-loan')).toBe('ApplyForLoan');
      expect(toPascal('apply_for_loan')).toBe('ApplyForLoan');
    });
  });

  describe('a feature', () => {
    it('creates the shape every feature shares', () => {
      generateFeature(FEATURE, FEATURES);
      const base = join(FEATURES, FEATURE);

      for (const folder of [
        'contracts/events',
        'actions',
        'dtos',
        'entities',
        'policies',
        'workflows',
        'jobs',
        'listeners',
        'http',
        'database/migrations',
        'tests',
      ]) {
        expect(existsSync(join(base, folder)), `expected ${folder}/`).toBe(true);
      }

      expect(existsSync(join(base, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(base, `${FEATURE}.module.ts`))).toBe(true);
    });

    it('never overwrites work that is already there', () => {
      generateFeature(FEATURE, FEATURES);
      const claudeMd = join(FEATURES, FEATURE, 'CLAUDE.md');
      const edited = '# edited by a human\n';
      writeFileSync(claudeMd, edited);

      const second = generateFeature(FEATURE, FEATURES);

      expect(readFileSync(claudeMd, 'utf8')).toBe(edited);
      expect(second.every((file) => file.status === 'exists')).toBe(true);
    });
  });

  describe('an action', () => {
    it('emits the action, its DTO and a test, at derivable paths', () => {
      generateFeature(FEATURE, FEATURES);
      const files = generateAction(FEATURE, 'CreateInvoice', { featuresRoot: FEATURES });
      const paths = files.map((file) => file.path.replace(`${FEATURES}/`, ''));

      // `CreateInvoice` -> these three, always. That is what makes a path
      // derivable rather than searchable.
      expect(paths).toEqual([
        `${FEATURE}/actions/create-invoice.action.ts`,
        `${FEATURE}/dtos/create-invoice.dto.ts`,
        `${FEATURE}/tests/create-invoice.action.spec.ts`,
      ]);
    });

    it('adds the HTTP adapter only when asked', () => {
      generateFeature(FEATURE, FEATURES);
      const withHttp = generateAction(FEATURE, 'CreateInvoice', {
        http: true,
        featuresRoot: FEATURES,
      });
      expect(withHttp.map((f) => f.path).some((p) => p.includes('/http/'))).toBe(true);
    });

    it('writes a test that fails on purpose', () => {
      generateFeature(FEATURE, FEATURES);
      generateAction(FEATURE, 'CreateInvoice', { featuresRoot: FEATURES });

      const spec = readFileSync(
        join(FEATURES, FEATURE, 'tests', 'create-invoice.action.spec.ts'),
        'utf8',
      );
      // Making it pass is the loop; a generator that emits a passing test
      // teaches nothing and gets deleted.
      expect(spec).toContain('fails on purpose');
      expect(spec).toContain('CreateInvoiceAction');
    });

    it('refuses to scaffold into a feature that does not exist', () => {
      expect(() =>
        generateAction('no-such-feature', 'Whatever', { featuresRoot: FEATURES }),
      ).toThrow(/pnpm boot:feature/);
    });
  });

  describe('a migration', () => {
    it('is named with the timestamp that gives it its place in the order', () => {
      generateFeature(FEATURE, FEATURES);
      const [file] = generateMigration(
        FEATURE,
        'create invoices',
        new Date('2026-09-16T12:34:56Z'),
        FEATURES,
      );

      expect(file?.path).toContain('20260916123456_create_invoices.sql');
    });

    it('produces a file the migration rules accept', async () => {
      generateFeature(FEATURE, FEATURES);
      const [file] = generateMigration(
        FEATURE,
        'create invoices',
        new Date('2026-09-16T12:34:56Z'),
        FEATURES,
      );
      const sql = readFileSync(file!.path, 'utf8');

      const { isValidMigrationFilename } = await import('../db/migrator.js');
      expect(isValidMigrationFilename(file!.path)).toBe(true);
      // Forward-only: the stub must not suggest a rollback section.
      expect(sql).not.toMatch(/^\s*--+\s*(down|rollback)\b/im);
    });
  });

  describe('background work', () => {
    it('emits a workflow carrying the ops metadata the rulebook requires', () => {
      generateFeature(FEATURE, FEATURES);
      const [file] = generateWorkflow(FEATURE, 'ChargeInvoice', FEATURES);
      const source = readFileSync(file!.path, 'utf8');

      expect(source).toContain('defineWorkflow');
      expect(source).toContain('group:');
      expect(source).toContain('description:');
    });

    it('puts an event in contracts/, where subscribers may legally import it', () => {
      generateFeature(FEATURE, FEATURES);
      const [file] = generateEvent(FEATURE, 'InvoicePaid', FEATURES);

      expect(file?.path).toContain('/contracts/events/invoice-paid.event.ts');
    });
  });
});
