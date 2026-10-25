const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Sem isso, "terminating connection due to administrator command" (57P01)
// vira Unhandled 'error' no BoundPool e derruba o processo inteiro.
pool.on('error', (err) => {
  console.error('[db] conexão ociosa caiu:', err.code || '', err.message);
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text,
  google_sub text UNIQUE,
  name text,
  phone_e164 text UNIQUE,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  stripe_customer_id text,
  plan_status text NOT NULL DEFAULT 'none',
  locale text NOT NULL DEFAULT 'pt-BR',
  mare_prefs jsonb NOT NULL DEFAULT '{"enabled":true,"windowMs":300000,"majority":0.55,"noisePct":0.05}'::jsonb,
  prompt_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_user_idx ON otp_challenges (user_id, channel, created_at DESC);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategies (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL,
  recipe jsonb,
  mare_mode text NOT NULL DEFAULT 'any',
  params jsonb,
  description text,
  explanation jsonb,
  source text NOT NULL DEFAULT 'user',
  status text NOT NULL DEFAULT 'active',
  paused boolean NOT NULL DEFAULT false,
  preset_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategies_user_idx ON strategies (user_id);

CREATE TABLE IF NOT EXISTS threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS threads_user_idx ON threads (user_id, strategy_id);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  recipe_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_id text NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  side text NOT NULL DEFAULT 'LONG',
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  entry numeric,
  exit numeric,
  qty numeric,
  quote numeric,
  pnl_usdt numeric,
  fees numeric,
  exit_type text,
  result text,
  raw jsonb
);
CREATE INDEX IF NOT EXISTS trades_strategy_idx ON trades (strategy_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS alarms (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  recipe jsonb NOT NULL,
  explanation jsonb,
  status text NOT NULL DEFAULT 'armed',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alarms_user_idx ON alarms (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS alarm_hits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alarm_id text NOT NULL REFERENCES alarms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  price numeric NOT NULL,
  stop numeric NOT NULL,
  tp numeric NOT NULL,
  stop_pct numeric NOT NULL,
  tp_pct numeric NOT NULL,
  reason text,
  seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alarm_hits_user_idx ON alarm_hits (user_id, created_at DESC);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'alarm_hits' AND column_name = 'cleared_at'
  ) THEN
    ALTER TABLE alarm_hits ADD COLUMN cleared_at timestamptz;
    ALTER TABLE alarm_hits ADD COLUMN email_sent_at timestamptz;
    UPDATE alarm_hits SET cleared_at = created_at WHERE cleared_at IS NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS alarm_hits_open_idx ON alarm_hits (alarm_id, symbol) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS alarm_hits_email_day_idx ON alarm_hits (user_id, email_sent_at);
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS channels jsonb NOT NULL DEFAULT '{"sound":true,"email":false,"sms":false}'::jsonb;
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS memory jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_tier text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS refund_status text NOT NULL DEFAULT 'none';

CREATE TABLE IF NOT EXISTS cancellation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  email text NOT NULL,
  name text,
  plan_tier text,
  access_ends_at timestamptz,
  days_left int NOT NULL DEFAULT 0,
  purchase_id uuid,
  paid_brl numeric,
  months int,
  refund_brl numeric,
  currency text NOT NULL DEFAULT 'BRL',
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cancellation_requests_status_idx ON cancellation_requests (status, requested_at DESC);

CREATE TABLE IF NOT EXISTS purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier text NOT NULL,
  months int NOT NULL,
  amount_brl numeric NOT NULL,
  currency text NOT NULL DEFAULT 'BRL',
  status text NOT NULL DEFAULT 'paid',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchases_user_idx ON purchases (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS production_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_id text,
  strategy_name text NOT NULL,
  thesis text,
  status text NOT NULL DEFAULT 'queued',
  requested_at timestamptz NOT NULL DEFAULT now(),
  ready_by timestamptz,
  bonus_days_applied int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS production_user_idx ON production_requests (user_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS production_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_email text NOT NULL,
  user_name text,
  locale text,
  strategy_id text,
  strategy_name text NOT NULL,
  thesis text,
  recipe jsonb,
  amount_brl numeric NOT NULL,
  currency text NOT NULL,
  local_amount numeric NOT NULL,
  fx_rate numeric NOT NULL,
  status text NOT NULL DEFAULT 'paid',
  paid_at timestamptz NOT NULL DEFAULT now(),
  ready_by timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS production_orders_one_idx ON production_orders (user_id, strategy_id);

CREATE TABLE IF NOT EXISTS positions (
  strategy_id text PRIMARY KEY REFERENCES strategies(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  input jsonb,
  output jsonb,
  error text,
  strategy_id text,
  thread_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status, created_at);

CREATE TABLE IF NOT EXISTS prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_email text NOT NULL,
  job_id uuid,
  thread_id uuid,
  prompt text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  created_strategy boolean NOT NULL DEFAULT false,
  strategy_id text,
  strategy_name text,
  strategy_ids jsonb,
  detail text,
  http_status int,
  error_stage text,
  error_raw text,
  provider text,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS prompts_user_idx ON prompts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prompts_created_idx ON prompts (created_at DESC);
CREATE INDEX IF NOT EXISTS prompts_status_idx ON prompts (status, created_at DESC);
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS http_status int;
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS error_stage text;
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS error_raw text;
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS duration_ms int;

CREATE TABLE IF NOT EXISTS outbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  channel text NOT NULL DEFAULT 'email',
  to_addr text,
  subject text,
  body text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  meta jsonb,
  sent boolean NOT NULL DEFAULT false,
  provider_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbound_messages_created_idx ON outbound_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS outbound_messages_kind_idx ON outbound_messages (kind, created_at DESC);

CREATE TABLE IF NOT EXISTS research_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hash text UNIQUE NOT NULL,
  kind text NOT NULL,
  params jsonb,
  path text,
  payload jsonb,
  n_hits int NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_help_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_email text NOT NULL,
  user_name text,
  strategy_id text,
  strategy_name text,
  message text NOT NULL,
  locale text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategy_help_user_idx ON strategy_help_reports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS strategy_help_status_idx ON strategy_help_reports (status, created_at DESC);
`;

async function migrate() {
  await pool.query(SCHEMA);
}

async function waitForDb() {
  let last;
  for (let i = 0; i < 40; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw last;
}

module.exports = { pool, migrate, waitForDb };
