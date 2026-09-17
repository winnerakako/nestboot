-- The telemetry schema: every append-only table the app writes, partitioned by
-- day from the very first migration.
--
-- Partitioning is here on day one because retention is the thing that cannot be
-- retrofitted. Deleting a day of logs from a billion-row table produces more WAL
-- than the writes it removes and leaves bloat that only VACUUM FULL reclaims;
-- dropping a partition is a catalogue update. Adding partitioning *later* means
-- rewriting the whole table while it is being written to.
--
-- Everything lives in an `ops` schema rather than `public`, so that a small
-- deployment that points OPS_DATABASE_URL at the *same* database as the app
-- still works, with no chance of a name collision.

CREATE SCHEMA IF NOT EXISTS ops;

-- ---------------------------------------------------------------------------
-- Partition helpers
-- ---------------------------------------------------------------------------

-- Create one day's partition for a partitioned table, if it does not exist.
-- Used by this migration to seed a window and by the housekeeping workflow to
-- keep running ahead of "now".
CREATE OR REPLACE FUNCTION ops.ensure_partition(p_table text, p_day date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_child text := format('%s_%s', p_table, to_char(p_day, 'YYYYMMDD'));
BEGIN
  IF to_regclass(format('ops.%I', v_child)) IS NOT NULL THEN
    RETURN v_child;
  END IF;

  EXECUTE format(
    'CREATE TABLE ops.%I PARTITION OF ops.%I FOR VALUES FROM (%L) TO (%L)',
    v_child, p_table, p_day::timestamptz, (p_day + 1)::timestamptz
  );
  RETURN v_child;
END;
$$;

-- Drop every partition of a table whose day is entirely before the cutoff.
-- Returns the names dropped so the housekeeping workflow can report them —
-- retention that runs silently is retention nobody notices has stopped.
CREATE OR REPLACE FUNCTION ops.drop_partitions_before(p_table text, p_cutoff date)
RETURNS SETOF text
LANGUAGE plpgsql
AS $$
DECLARE
  v_child text;
  v_day   date;
BEGIN
  FOR v_child IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'ops'
      AND p.relname = p_table
      AND c.relname ~ '_[0-9]{8}$'
  LOOP
    v_day := to_date(right(v_child, 8), 'YYYYMMDD');
    IF v_day < p_cutoff THEN
      EXECUTE format('DROP TABLE ops.%I', v_child);
      RETURN NEXT v_child;
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- logs
-- ---------------------------------------------------------------------------

CREATE TABLE ops.logs (
  id          uuid        NOT NULL,
  ts          timestamptz NOT NULL,
  level       smallint    NOT NULL,
  msg         text        NOT NULL,
  ctx         jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- The correlation chain. Every one of these is a link /ops renders.
  request_id  text,
  workflow_id text,
  job_id      text,
  step        text,
  trace_id    text,

  -- The dimensions the console slices by.
  route       text,
  method      text,
  status      smallint,
  feature     text,
  group_name  text,

  -- Intentional: the 'simple' dictionary, not 'english'. 'english' stems and
  -- drops stop-words, so searching a log line for "as" or an exact identifier
  -- silently matches nothing. Readers must use plainto_tsquery('simple', ...)
  -- to match — anything else will quietly return no rows.
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', msg || ' ' || coalesce(ctx::text, ''))
  ) STORED,

  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX logs_ts_idx          ON ops.logs (ts DESC);
CREATE INDEX logs_level_ts_idx    ON ops.logs (level, ts DESC);
CREATE INDEX logs_route_ts_idx    ON ops.logs (route, ts DESC) WHERE route IS NOT NULL;
CREATE INDEX logs_feature_ts_idx  ON ops.logs (feature, ts DESC) WHERE feature IS NOT NULL;
CREATE INDEX logs_group_ts_idx    ON ops.logs (group_name, ts DESC) WHERE group_name IS NOT NULL;
CREATE INDEX logs_request_ts_idx  ON ops.logs (request_id, ts DESC) WHERE request_id IS NOT NULL;
CREATE INDEX logs_workflow_ts_idx ON ops.logs (workflow_id, ts DESC) WHERE workflow_id IS NOT NULL;
CREATE INDEX logs_search_idx      ON ops.logs USING gin (search);

-- ---------------------------------------------------------------------------
-- requests
-- ---------------------------------------------------------------------------

CREATE TABLE ops.requests (
  id           uuid        NOT NULL,
  ts           timestamptz NOT NULL,
  -- The route *pattern* (`POST /loans/:id/approve`), never the concrete URL:
  -- grouping by URL produces one group per id and answers no question.
  route        text        NOT NULL,
  method       text        NOT NULL,
  status       smallint    NOT NULL,
  duration_ms  integer     NOT NULL,
  feature      text,

  request_id   text,
  trace_id     text,
  user_id      text,
  ip           inet,
  user_agent   text,
  bytes_out    integer,

  -- Intentional: rows are sampled, so volume is sum(1 / sample_rate) and NEVER
  -- count(*). A count of sampled rows understates traffic by exactly the
  -- sampling factor, and does it silently.
  sample_rate  real        NOT NULL DEFAULT 1,

  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', route || ' ' || coalesce(request_id, '') || ' ' || coalesce(user_id, ''))
  ) STORED,

  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX requests_ts_idx         ON ops.requests (ts DESC);
CREATE INDEX requests_route_ts_idx   ON ops.requests (route, ts DESC);
CREATE INDEX requests_status_ts_idx  ON ops.requests (status, ts DESC);
CREATE INDEX requests_feature_ts_idx ON ops.requests (feature, ts DESC) WHERE feature IS NOT NULL;
CREATE INDEX requests_slow_idx       ON ops.requests (duration_ms DESC, ts DESC);
CREATE INDEX requests_request_id_idx ON ops.requests (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX requests_search_idx     ON ops.requests USING gin (search);

-- ---------------------------------------------------------------------------
-- errors
-- ---------------------------------------------------------------------------

CREATE TABLE ops.errors (
  id           uuid        NOT NULL,
  ts           timestamptz NOT NULL,
  -- Same bug, same fingerprint: type plus the top application frames, with the
  -- message deliberately excluded so "no user 41" and "no user 42" group.
  fingerprint  text        NOT NULL,
  type         text        NOT NULL,
  message      text        NOT NULL,
  stack        text,
  status       smallint,

  route        text,
  feature      text,
  group_name   text,
  request_id   text,
  workflow_id  text,
  trace_id     text,
  user_id      text,

  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', type || ' ' || message || ' ' || coalesce(route, ''))
  ) STORED,

  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX errors_ts_idx           ON ops.errors (ts DESC);
CREATE INDEX errors_fingerprint_idx  ON ops.errors (fingerprint, ts DESC);
CREATE INDEX errors_route_ts_idx     ON ops.errors (route, ts DESC) WHERE route IS NOT NULL;
CREATE INDEX errors_feature_ts_idx   ON ops.errors (feature, ts DESC) WHERE feature IS NOT NULL;
CREATE INDEX errors_workflow_idx     ON ops.errors (workflow_id, ts DESC) WHERE workflow_id IS NOT NULL;
CREATE INDEX errors_search_idx       ON ops.errors USING gin (search);

-- Per-fingerprint state an operator sets: resolved, muted, first/last seen.
-- Not partitioned — it is small, it is mutable, and it must outlive the
-- occurrence partitions it summarises.
CREATE TABLE ops.error_groups (
  fingerprint   text        PRIMARY KEY,
  type          text        NOT NULL,
  message       text        NOT NULL,
  route         text,
  feature       text,
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  occurrences   bigint      NOT NULL DEFAULT 1,
  status        text        NOT NULL DEFAULT 'open',
  muted_until   timestamptz,
  resolved_at   timestamptz,
  resolved_by   text,
  note          text,
  CONSTRAINT error_groups_status_check CHECK (status IN ('open', 'resolved', 'muted'))
);

CREATE INDEX error_groups_last_seen_idx ON ops.error_groups (last_seen_at DESC);
CREATE INDEX error_groups_status_idx    ON ops.error_groups (status, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- security events
-- ---------------------------------------------------------------------------

CREATE TABLE ops.security_events (
  id          uuid        NOT NULL,
  ts          timestamptz NOT NULL,
  kind        text        NOT NULL,
  outcome     text        NOT NULL,
  subject_kind text,
  subject_id  text,
  ip          inet,
  user_agent  text,
  route       text,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  request_id  text,

  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX security_events_ts_idx      ON ops.security_events (ts DESC);
CREATE INDEX security_events_kind_ts_idx ON ops.security_events (kind, ts DESC);
CREATE INDEX security_events_ip_ts_idx   ON ops.security_events (ip, ts DESC) WHERE ip IS NOT NULL;
CREATE INDEX security_events_subject_idx ON ops.security_events (subject_kind, subject_id, ts DESC);

-- ---------------------------------------------------------------------------
-- rate-limit counters and cache
-- ---------------------------------------------------------------------------

-- Intentional: UNLOGGED. These are rebuilt-by-use, so paying WAL for them buys
-- nothing. The cost is that a crash (or, on some managed hosts, a compute
-- suspend) truncates them — which means one window of unlimited requests and an
-- empty cache, both of which the app must already tolerate.
CREATE UNLOGGED TABLE ops.rate_limit_counters (
  subject_kind text        NOT NULL,
  subject_id   text        NOT NULL,
  route_group  text        NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_kind, subject_id, route_group, window_start)
);

CREATE INDEX rate_limit_counters_window_idx ON ops.rate_limit_counters (window_start);

CREATE UNLOGGED TABLE ops.cache (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  hits       bigint      NOT NULL DEFAULT 0
);

CREATE INDEX cache_expires_at_idx ON ops.cache (expires_at);
-- Supports forgetPrefix('user:42:') without a sequential scan.
CREATE INDEX cache_key_prefix_idx ON ops.cache (key text_pattern_ops);

-- ---------------------------------------------------------------------------
-- Seed a partition window
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_table text;
  v_offset integer;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['logs', 'requests', 'errors', 'security_events'] LOOP
    -- Yesterday through a week out: enough that a failed housekeeping run has
    -- days of headroom before it becomes an incident.
    FOR v_offset IN -1..7 LOOP
      PERFORM ops.ensure_partition(v_table, (current_date + v_offset)::date);
    END LOOP;

    -- Intentional: a DEFAULT partition. Telemetry must never fail a write, and
    -- without this an out-of-window timestamp raises instead of landing
    -- somewhere. It should stay empty; rows in it mean housekeeping has stopped.
    EXECUTE format(
      'CREATE TABLE ops.%I PARTITION OF ops.%I DEFAULT',
      v_table || '_default', v_table
    );
  END LOOP;
END;
$$;
