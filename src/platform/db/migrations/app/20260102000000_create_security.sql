-- Operator identity, sessions, rate-limit policy and inbound webhook receipts.
--
-- These live in the *app* database, not the telemetry one, and the split is
-- deliberate: they are small, they are authoritative, and losing them is not
-- survivable the way losing a day of logs is. The ops database is the one that
-- runs UNLOGGED tables and `synchronous_commit=off`.

-- ---------------------------------------------------------------------------
-- Operator accounts
-- ---------------------------------------------------------------------------

CREATE TABLE ops_users (
  id             uuid        PRIMARY KEY,
  username       text        NOT NULL UNIQUE,
  -- argon2id. Never a fast hash: this is the credential for the console that
  -- can cancel workflows and read every log line.
  password_hash  text        NOT NULL,
  -- Base32 TOTP secret. Null until enrolled; `totp_confirmed_at` is what makes
  -- it required, so a half-finished enrolment cannot lock an operator out.
  totp_secret    text,
  totp_confirmed_at timestamptz,
  disabled_at    timestamptz,
  last_login_at  timestamptz,
  failed_attempts integer    NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

CREATE TABLE ops_sessions (
  -- SHA-256 of the cookie value, never the value itself: a database dump (or a
  -- backup, or a support query) must not hand over live sessions.
  token_hash   text        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES ops_users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           inet,
  user_agent   text
);

CREATE INDEX ops_sessions_user_idx    ON ops_sessions (user_id, created_at DESC);
CREATE INDEX ops_sessions_expires_idx ON ops_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Rate-limit policy
-- ---------------------------------------------------------------------------

-- Policy is data, not code: an operator raising a limit during an incident must
-- not need a deploy. Resolution is most-specific-wins —
-- subject_id > subject_kind > '*', and a named route group before '*'.
CREATE TABLE rate_limit_policies (
  id             uuid        PRIMARY KEY,
  route_group    text        NOT NULL DEFAULT '*',
  subject_kind   text        NOT NULL DEFAULT '*',
  -- A specific subject: one abusive IP, one customer on a bigger plan.
  subject_id     text,
  max_requests   integer     NOT NULL,
  window_seconds integer     NOT NULL,
  burst          integer,
  -- 'reject' enforces; 'log_only' is shadow mode — record what *would* have
  -- been blocked, so a new limit can be proven safe before it bites.
  action         text        NOT NULL DEFAULT 'reject',
  priority       integer     NOT NULL DEFAULT 0,
  enabled        boolean     NOT NULL DEFAULT true,
  note           text,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rate_limit_policies_action_check CHECK (action IN ('reject', 'log_only')),
  CONSTRAINT rate_limit_policies_window_check CHECK (window_seconds > 0),
  CONSTRAINT rate_limit_policies_max_check CHECK (max_requests >= 0),
  CONSTRAINT rate_limit_policies_kind_check
    CHECK (subject_kind IN ('*', 'ip', 'user', 'org', 'api_key'))
);

-- One policy per (group, kind, subject). A second row for the same triple would
-- make resolution depend on insertion order, which is not a rule anyone can read.
CREATE UNIQUE INDEX rate_limit_policies_unique_idx
  ON rate_limit_policies (route_group, subject_kind, coalesce(subject_id, ''));

CREATE INDEX rate_limit_policies_lookup_idx
  ON rate_limit_policies (route_group, subject_kind) WHERE enabled;

-- The shipped defaults. Tightening these is an UPDATE, not a deploy.
INSERT INTO rate_limit_policies (id, route_group, subject_kind, max_requests, window_seconds, priority, note)
VALUES
  ('01900000-0000-7000-8000-000000000001', 'api',      '*', 100, 60, 0, 'default: 100 requests per minute per subject'),
  -- Login and password reset: low enough to make credential stuffing useless.
  ('01900000-0000-7000-8000-000000000002', 'auth',     '*',  10, 60, 10, 'default: authentication endpoints'),
  ('01900000-0000-7000-8000-000000000003', 'ops',      '*',   5, 60, 10, 'default: operator console login'),
  -- Providers legitimately burst on retry storms; blocking them loses events.
  ('01900000-0000-7000-8000-000000000004', 'webhooks', '*', 1000, 60, 0, 'default: inbound webhooks'),
  ('01900000-0000-7000-8000-000000000005', '*',        '*', 300, 60, -10, 'default: everything else');

-- ---------------------------------------------------------------------------
-- Inbound webhooks
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_inbound (
  id            uuid        PRIMARY KEY,
  provider      text        NOT NULL,
  -- The provider's own id for this event. The unique index on it is what makes
  -- a provider's retry a no-op rather than a duplicate charge.
  external_id   text,
  event_type    text,
  signature_ok  boolean     NOT NULL,
  headers       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  payload       jsonb       NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  workflow_id   text,
  status        text        NOT NULL DEFAULT 'received',
  error         text,

  CONSTRAINT webhook_inbound_status_check
    CHECK (status IN ('received', 'processing', 'processed', 'failed', 'rejected'))
);

CREATE UNIQUE INDEX webhook_inbound_dedupe_idx
  ON webhook_inbound (provider, external_id) WHERE external_id IS NOT NULL;

CREATE INDEX webhook_inbound_received_idx ON webhook_inbound (received_at DESC);
CREATE INDEX webhook_inbound_status_idx   ON webhook_inbound (status, received_at DESC);
