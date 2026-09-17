-- Two databases from the first commit.
--
-- `app` holds product tables and DBOS's system schema; `ops` holds logs,
-- requests, errors, security events, rate-limit counters and cache. They share
-- one server here and cost one environment variable to pull apart later —
-- which is the entire point, because pulling them apart at a hundred million
-- rows costs a weekend.
--
-- The `app` database is created by POSTGRES_DB; only `ops` needs creating.

CREATE DATABASE ops OWNER nestboot;

COMMENT ON DATABASE ops IS
  'Telemetry. Append-only, time-partitioned, retained by dropping partitions. '
  'Never joined to the app database.';
