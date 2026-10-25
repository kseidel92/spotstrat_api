const { pool } = require('./db');

function clientIp(req) {
  const raw = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return String(raw).replace(/^::ffff:/, '');
}

function isLocalhost(req) {
  // Só o socket remoto — não confiar em X-Forwarded-For (túnel público).
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function requireLocalAdmin(req, res, next) {
  if (!isLocalhost(req)) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Backoffice só aceita acesso de localhost.',
    });
  }
  const expected = (process.env.BACKOFFICE_TOKEN || '').trim();
  if (expected) {
    const got = String(req.headers['x-backoffice-token'] || '').trim();
    if (got !== expected) {
      return res.status(401).json({ error: 'unauthorized', message: 'Token do backoffice inválido.' });
    }
  }
  return next();
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function mountAdmin(app) {
  app.use('/v1/admin', requireLocalAdmin);

  app.get('/v1/admin/health', (_req, res) => {
    res.json({ ok: true, scope: 'backoffice', localOnly: true });
  });

  app.get('/v1/admin/overview', async (_req, res) => {
    const [users, prompts, jobs, purchases, production, help, outbound, cancels] = await Promise.all([
      pool.query(`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE email_verified_at IS NOT NULL)::int AS verified,
          count(*) FILTER (WHERE plan_status = 'active')::int AS active_plan,
          count(*) FILTER (WHERE trial_ends_at > now())::int AS on_trial,
          count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_7d
        FROM users
      `),
      pool.query(`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE status IN ('created','updated','done','alarm'))::int AS ok,
          count(*) FILTER (WHERE status IN ('failed','rejected'))::int AS bad,
          count(*) FILTER (WHERE status = 'needs_user')::int AS needs_user,
          count(*) FILTER (WHERE status IN ('queued','running'))::int AS pending,
          count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h
        FROM prompts
      `),
      pool.query(`
        SELECT
          count(*) FILTER (WHERE status = 'failed')::int AS failed,
          count(*) FILTER (WHERE status = 'queued')::int AS queued,
          count(*) FILTER (WHERE status = 'running')::int AS running
        FROM jobs
      `),
      pool.query(`
        SELECT count(*)::int AS total,
               coalesce(sum(amount_brl), 0)::float AS revenue_brl,
               count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS last_30d
        FROM purchases WHERE status = 'paid'
      `),
      pool.query(`
        SELECT count(*)::int AS total,
               coalesce(sum(amount_brl), 0)::float AS revenue_brl
        FROM production_orders WHERE status = 'paid'
      `),
      pool.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status = 'open')::int AS open
        FROM strategy_help_reports
      `),
      pool.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE sent)::int AS sent,
               count(*) FILTER (WHERE NOT sent)::int AS failed
        FROM outbound_messages
        WHERE created_at > now() - interval '7 days'
      `),
      pool.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status = 'pending')::int AS pending
        FROM cancellation_requests
      `),
    ]);
    res.json({
      users: users.rows[0],
      prompts: prompts.rows[0],
      jobs: jobs.rows[0],
      purchases: purchases.rows[0],
      production: production.rows[0],
      help: help.rows[0],
      outbound7d: outbound.rows[0],
      cancellations: cancels.rows[0],
    });
  });

  app.get('/v1/admin/prompts', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 100000);
    const status = String(req.query.status || '').trim();
    const q = String(req.query.q || '').trim();
    const onlyBad = req.query.bad === '1' || req.query.bad === 'true';
    const params = [];
    const where = [];
    if (status) {
      params.push(status);
      where.push(`p.status = $${params.length}`);
    } else if (onlyBad) {
      where.push(`p.status IN ('failed','rejected') OR coalesce(p.http_status, 200) >= 400 OR p.error_raw IS NOT NULL`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(p.prompt ILIKE $${params.length} OR p.user_email ILIKE $${params.length} OR coalesce(p.detail,'') ILIKE $${params.length} OR coalesce(p.error_raw,'') ILIKE $${params.length})`);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT p.id, p.user_id, p.user_email, p.job_id, p.thread_id, p.prompt, p.mode, p.status,
              p.created_strategy, p.strategy_id, p.strategy_name, p.detail,
              p.http_status, p.error_stage, p.error_raw, p.provider, p.duration_ms,
              p.created_at, p.finished_at,
              j.status AS job_status, j.error AS job_error, j.kind AS job_kind
       FROM prompts p
       LEFT JOIN jobs j ON j.id = p.job_id
       ${filter}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const countParams = params.slice(0, -2);
    const { rows: totalRows } = await pool.query(
      `SELECT count(*)::int AS n FROM prompts p ${filter}`,
      countParams,
    );
    res.json({ prompts: rows, total: totalRows[0]?.n || 0, limit, offset });
  });

  app.get('/v1/admin/prompts/:id', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT p.*, j.status AS job_status, j.error AS job_error, j.kind AS job_kind,
              j.input AS job_input, j.output AS job_output, j.created_at AS job_created_at,
              j.updated_at AS job_updated_at
       FROM prompts p
       LEFT JOIN jobs j ON j.id = p.job_id
       WHERE p.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ prompt: rows[0] });
  });

  app.get('/v1/admin/users', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 100000);
    const q = String(req.query.q || '').trim();
    const params = [];
    let filter = '';
    if (q) {
      params.push(`%${q}%`);
      filter = `WHERE email ILIKE $1 OR coalesce(name,'') ILIKE $1 OR coalesce(phone_e164,'') ILIKE $1`;
    }
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT id, email, name, phone_e164, locale, plan_status, plan_tier,
              email_verified_at, trial_ends_at, prompt_count, created_at,
              cancel_requested_at, refund_status
       FROM users
       ${filter}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ users: rows });
  });

  app.get('/v1/admin/purchases', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const { rows } = await pool.query(
      `SELECT p.*, u.email, u.name
       FROM purchases p
       JOIN users u ON u.id = p.user_id
       ORDER BY p.created_at DESC
       LIMIT $1`,
      [limit],
    );
    res.json({ purchases: rows });
  });

  app.get('/v1/admin/stripe-checkouts', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const { rows } = await pool.query(
      `SELECT c.*, u.email, u.name
       FROM stripe_checkouts c
       LEFT JOIN users u ON u.id = c.user_id
       ORDER BY c.created_at DESC
       LIMIT $1`,
      [limit],
    );
    res.json({ checkouts: rows });
  });

  app.get('/v1/admin/stripe-events', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const { rows } = await pool.query(
      `SELECT id, type, process_error, processed_at, created_at,
              payload->'data'->'object'->>'id' AS object_id,
              payload->'data'->'object'->>'payment_status' AS payment_status
       FROM stripe_events
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    res.json({ events: rows });
  });

  app.get('/v1/admin/production-orders', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const { rows } = await pool.query(
      `SELECT * FROM production_orders ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    res.json({ orders: rows });
  });

  app.get('/v1/admin/cancellations', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const { rows } = await pool.query(
      `SELECT * FROM cancellation_requests ORDER BY requested_at DESC LIMIT $1`,
      [limit],
    );
    res.json({ cancellations: rows });
  });

  app.get('/v1/admin/help', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const status = String(req.query.status || '').trim();
    const params = [];
    let filter = '';
    if (status) {
      params.push(status);
      filter = `WHERE status = $1`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM strategy_help_reports ${filter} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    res.json({ reports: rows });
  });

  app.get('/v1/admin/outbound', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const kind = String(req.query.kind || '').trim();
    const params = [];
    let filter = '';
    if (kind) {
      params.push(kind);
      filter = `WHERE kind = $1`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM outbound_messages ${filter} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    res.json({ messages: rows });
  });

  app.get('/v1/admin/jobs', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const status = String(req.query.status || '').trim();
    const params = [];
    let filter = '';
    if (status) {
      params.push(status);
      filter = `WHERE j.status = $1`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT j.id, j.user_id, u.email AS user_email, j.kind, j.status, j.error,
              j.strategy_id, j.thread_id, j.created_at, j.updated_at,
              left(coalesce(j.input->>'prompt',''), 240) AS prompt_preview
       FROM jobs j
       JOIN users u ON u.id = j.user_id
       ${filter}
       ORDER BY j.created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json({ jobs: rows });
  });

  app.get('/v1/admin/messages', async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const { rows } = await pool.query(
      `SELECT m.id, m.thread_id, m.role, left(m.content, 500) AS content, m.created_at,
              t.user_id, u.email AS user_email, t.strategy_id
       FROM messages m
       JOIN threads t ON t.id = m.thread_id
       JOIN users u ON u.id = t.user_id
       ORDER BY m.created_at DESC
       LIMIT $1`,
      [limit],
    );
    res.json({ messages: rows });
  });
}

module.exports = { mountAdmin, requireLocalAdmin, isLocalhost };
