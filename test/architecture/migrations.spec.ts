import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverMigrations, isValidMigrationFilename } from '../../src/platform/db/migrator.js';
import { ruleFailure } from './support.js';

const migrations = discoverMigrations();

describe('migration rules', () => {
  it('has migrations to check', () => {
    // A rulebook that silently checks nothing passes forever. Fail loudly if
    // discovery breaks rather than reporting green on an empty list.
    expect(migrations.length).toBeGreaterThan(0);
  });

  it('names every migration so its position is defined', () => {
    const offenders = migrations
      .filter((m) => !isValidMigrationFilename(m.path))
      .map((m) => m.path);

    expect(
      offenders,
      ruleFailure(
        'Every migration is named <YYYYMMDDHHMMSS>_<snake_case>.sql.',
        offenders,
        'rename it. The timestamp is what orders migrations across platform and every ' +
          'feature, so a file without one has no defined position in the sequence.',
      ),
    ).toEqual([]);
  });

  it('has no rollbacks', () => {
    const offenders = migrations
      .filter(
        (m) => /^\s*--+\s*(down|rollback)\b/im.test(m.sql) || /\bfunction\s+down\b/i.test(m.sql),
      )
      .map((m) => m.path);

    expect(
      offenders,
      ruleFailure(
        'Migrations are forward-only. There is no down().',
        offenders,
        'delete the rollback. A down() written today is a guess run during the worst ten ' +
          'minutes of the quarter; the real fix is a second forward migration written with ' +
          'knowledge of what actually broke, or a restore from backup.',
      ),
    ).toEqual([]);
  });

  it('creates indexes concurrently, or declares itself non-transactional', () => {
    const offenders = migrations
      .filter((m) => {
        const createsIndex = /CREATE\s+(UNIQUE\s+)?INDEX/i.test(m.sql);
        if (!createsIndex) return false;
        const concurrent = /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(m.sql);
        // Building an index inside the same migration that creates the table is
        // safe and fast: nothing can be reading a table that did not exist.
        const createsItsOwnTables = /CREATE\s+(UNLOGGED\s+)?TABLE/i.test(m.sql);
        return !concurrent && !createsItsOwnTables && m.transactional;
      })
      .map((m) => m.path);

    expect(
      offenders,
      ruleFailure(
        'An index on an existing table is built CONCURRENTLY.',
        offenders,
        'use CREATE INDEX CONCURRENTLY and put `-- nontransactional` at the top of the file ' +
          '(CONCURRENTLY cannot run inside a transaction). A plain CREATE INDEX takes a ' +
          'write lock for the whole build, which on a large table is an outage.',
      ),
    ).toEqual([]);
  });

  it('never adds a NOT NULL column with a volatile default', () => {
    const offenders = migrations
      .filter((m) =>
        /ADD\s+COLUMN[\s\S]{0,200}?NOT\s+NULL[\s\S]{0,80}?DEFAULT\s+(now\(\)|gen_random_uuid\(\)|random\(\)|clock_timestamp\(\))/i.test(
          m.sql,
        ),
      )
      .map((m) => m.path);

    expect(
      offenders,
      ruleFailure(
        'ADD COLUMN NOT NULL with a volatile default rewrites the whole table.',
        offenders,
        'expand, backfill, contract: add the column nullable, backfill it in batches from a ' +
          'workflow, then set NOT NULL. A constant default is fine (Postgres stores it in the ' +
          'catalogue); a volatile one must be computed per row, which rewrites and locks.',
      ),
    ).toEqual([]);
  });

  it('gives each migration a unique tracked key across every feature', () => {
    const keys = migrations.map((m) => m.key);
    const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);

    expect(
      duplicates,
      ruleFailure(
        'Two migrations share a tracking key.',
        duplicates,
        'rename one. The key is <source>/<filename>, so this means one feature has two ' +
          'identically named migrations — the second would be recorded as already applied.',
      ),
    ).toEqual([]);
  });

  it('keeps feature migrations out of the telemetry database', () => {
    const offenders = migrations
      .filter((m) => m.source !== 'platform' && m.target !== 'app')
      .map((m) => m.path);

    expect(
      offenders,
      ruleFailure(
        'A feature only ever migrates the app database.',
        offenders,
        'move it to src/platform/db/migrations/app/. The ops database belongs to the ' +
          'platform; a feature that writes telemetry does it through the platform’s writers, ' +
          'so that turning telemetry off stays one switch.',
      ),
    ).toEqual([]);
  });

  it('keeps every migration filename lowercase, which is what the ordering assumes', () => {
    const offenders = migrations
      .map((m) => basename(m.path))
      .filter((name) => name !== name.toLowerCase());

    expect(offenders).toEqual([]);
  });
});
