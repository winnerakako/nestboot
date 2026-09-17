import 'reflect-metadata';

/**
 * Runs once per test file, before anything in it.
 *
 * The environment is set here rather than in each spec so that a test never
 * accidentally exercises a *different* configuration than the one the app
 * validates — `loadEnv()` is the same function in both.
 */
process.env.NODE_ENV = 'test';
process.env.APP_SECRET ??= 'test-secret-that-is-long-enough-to-pass-validation';
process.env.APP_NAME ??= 'nestboot-test';
process.env.GIT_SHA ??= 'test';
process.env.LOG_LEVEL ??= 'error';
process.env.ROLE ??= 'all';

// Placeholders so `loadEnv()` succeeds in specs that never touch a database.
// A spec that needs a real one calls `useTestDatabases()`, which overwrites these.
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.OPS_DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
