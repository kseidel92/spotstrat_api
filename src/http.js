const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');
const { PRESETS, publicPreset, localizedExplanation } = require('./presets');
const {
  id, sha256, emptySnap, walletOf, publicUser, deskAllowed, TRIAL_HOURS, LOCALES,
} = require('./shared');
const lab = require('./lab');
const { quotePlan, catalog, productionQuote, settleAccount, remainingRefund } = require('./plans');
const { notifyOwner } = require('./mail');

const hits = new Map();

function allow(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  hits.set(key, arr);
  return true;
}

function otpEnabled() {
  return process.env.RETURN_OTP_IN_RESPONSE !== 'false';
}

function signAccess(user) {
  return jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
}

async function issueRefresh(res, userId, remember = true) {
  const token = crypto.randomBytes(32).toString('hex');
  const days = remember ? 30 : 1;
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [userId, sha256(token), String(days)],
  );
  const cookie = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    path: '/v1/auth',
  };
  const domain = (process.env.COOKIE_DOMAIN || '').trim();
  if (domain) cookie.domain = domain;
  if (remember) cookie.maxAge = 30 * 24 * 3600 * 1000;
  res.cookie('refresh', token, cookie);
}

async function issueCode(userId, channel) {
  const code = String(crypto.randomInt(100000, 1000000));
  await pool.query(
    `UPDATE otp_challenges SET consumed_at = now() WHERE user_id = $1 AND channel = $2 AND consumed_at IS NULL`,
    [userId, channel],
  );
  await pool.query(
    `INSERT INTO otp_challenges (user_id, channel, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [userId, channel, sha256(code)],
  );
  console.log(`[otp] ${channel} ${userId} ${code}`);
  return code;
}

function expose(code) {
  return otpEnabled() ? code : undefined;
}

async function seedPresets(client, userId) {
  for (const preset of PRESETS) {
    const sid = id('s');
    await client.query(
      `INSERT INTO strategies (id, user_id, name, type, mare_mode, params, description, explanation, source, preset_key)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,'preset',$9)`,
      [
        sid, userId, preset.name, preset.type, preset.mareMode,
        JSON.stringify(preset.params), preset.description, JSON.stringify(preset.explanation), preset.presetKey,
      ],
    );
    await client.query(
      'INSERT INTO positions (strategy_id, snapshot) VALUES ($1, $2::jsonb)',
      [sid, JSON.stringify(emptySnap())],
    );
  }
}

async function loadUser(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'unauthorized', message: 'Sessão ausente.' });
  try {
    req.auth = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    return next();
  } catch (_) {
    return res.status(401).json({ error: 'unauthorized', message: 'Sessão expirada.' });
  }
}

async function openTrial(userId) {
  const hours = TRIAL_HOURS;
  const { rows } = await pool.query(
    `UPDATE users
     SET trial_started_at = now(),
         trial_ends_at = now() + ($2 || ' hours')::interval,
         plan_status = 'trialing'
     WHERE id = $1 AND trial_started_at IS NULL
     RETURNING *`,
    [userId, String(hours)],
  );
  return rows[0];
}

async function maybeStripeCustomer(user) {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key || user.stripe_customer_id) return;
  try {
    const body = new URLSearchParams({ email: user.email, 'metadata[userId]': user.id });
    if (user.name) body.set('name', user.name);
    const res = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body,
    });
    const data = await res.json();
    if (res.ok && data.id) {
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [data.id, user.id]);
    } else {
      console.warn('[stripe]', data.error?.message || res.status);
    }
  } catch (err) {
    console.warn('[stripe]', err.message);
  }
}

function createHttp(desk) {
  async function freshUser(row) {
    const settled = await settleAccount(pool, row);
    if (settled.changed) await desk.reloadUser(settled.row.id);
    return settled.row;
  }

  async function currentUser(req, res, next) {
    const row = await loadUser(req.auth.sub);
    if (!row) return res.status(401).json({ error: 'unauthorized', message: 'Conta não encontrada.' });
    const live = await freshUser(row);
    req.user = live;
    req.profile = publicUser(live);
    return next();
  }

  function requireDesk(req, res, next) {
    if (req.profile.desk === 'unverified') {
      return res.status(403).json({ error: 'unverified', message: 'Confirme o e-mail para entrar no desk.' });
    }
    if (!deskAllowed(req.profile)) {
      return res.status(402).json({
        error: 'trial_expired',
        message: 'O acesso terminou. Escolha paper ou pro para continuar.',
      });
    }
    return next();
  }

  const app = express();
  const webOrigins = (process.env.WEB_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
      if (webOrigins.includes(origin)) return cb(null, true);
      if (process.env.ALLOW_VERCEL_PREVIEWS === 'true' && /^https:\/\/[^/]+\.vercel\.app$/.test(origin)) {
        return cb(null, true);
      }
      return cb(null, false);
    },
    credentials: true,
  }));
  app.post('/v1/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!secret) return res.status(503).json({ error: 'stripe_off' });
    const header = req.headers['stripe-signature'] || '';
    const t = (header.match(/t=(\d+)/) || [])[1];
    const v1 = (header.match(/v1=([a-f0-9]+)/) || [])[1];
    const expect = crypto.createHmac('sha256', secret).update(`${t}.${req.body.toString('utf8')}`).digest('hex');
    if (!t || !v1 || v1.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expect))) {
      return res.status(400).json({ error: 'bad_signature' });
    }
    const event = JSON.parse(req.body.toString('utf8'));
    const type = event.type;
    const obj = event.data?.object || {};
    if (type === 'checkout.session.completed' || type === 'invoice.paid') {
      const userId = obj.metadata?.userId || obj.client_reference_id;
      if (userId) await pool.query(`UPDATE users SET plan_status = 'active' WHERE id = $1`, [userId]);
    }
    if (type === 'customer.subscription.deleted') {
      const customer = obj.customer;
      if (customer) await pool.query(`UPDATE users SET plan_status = 'expired' WHERE stripe_customer_id = $1`, [customer]);
    }
    return res.json({ received: true });
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/v1/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'tradeai' });
  });

  app.get('/v1/presets', (req, res) => {
    const locale = LOCALES.includes(req.query.locale) ? req.query.locale : 'pt-BR';
    res.json({ presets: PRESETS.map((p) => publicPreset(p, locale)) });
  });

  app.post('/v1/auth/register', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const phoneRaw = String(req.body.phone || '').trim();
    const name = String(req.body.name || '').trim().slice(0, 80);
    const locale = LOCALES.includes(req.body.locale) ? req.body.locale : 'pt-BR';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_body', message: 'E-mail inválido.' });
    if (password.length < 8) return res.status(400).json({ error: 'invalid_body', message: 'A senha precisa de 8 caracteres.' });
    if (req.body.passwordConfirm != null && String(req.body.passwordConfirm) !== password) {
      return res.status(400).json({ error: 'password_mismatch', message: 'As senhas não conferem.' });
    }
    if (phoneRaw && !/^\+[1-9]\d{7,14}$/.test(phoneRaw)) return res.status(400).json({ error: 'invalid_body', message: 'Celular em formato internacional, por exemplo +5511999998888.' });
    const phone = phoneRaw || null;
    const passwordHash = await bcrypt.hash(password, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO users (email, password_hash, name, phone_e164, locale)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [email, passwordHash, name || null, phone, locale],
      );
      await seedPresets(client, inserted.rows[0].id);
      await client.query('COMMIT');
      const user = inserted.rows[0];
      const emailCode = await issueCode(user.id, 'email');
      const phoneCode = phone ? await issueCode(user.id, 'sms') : null;
      await desk.reloadUser(user.id);
      return res.status(201).json({
        user: publicUser(user),
        verification: {
          emailCode: expose(emailCode),
          ...(phoneCode ? { phoneCode: expose(phoneCode) } : {}),
          expiresInSec: 600,
          note: 'Nesta instalação o código volta na resposta da API. E-mail e SMS não são enviados.',
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505' && /email/.test(err.detail || '')) return res.status(409).json({ error: 'email_taken', message: 'Este e-mail já tem conta.' });
      if (err.code === '23505') return res.status(409).json({ error: 'phone_taken', message: 'Este celular já está em uso.' });
      throw err;
    } finally {
      client.release();
    }
  });

  app.post('/v1/auth/login', async (req, res) => {
    if (!allow(`login:${req.ip}`, 5, 60_000)) return res.status(429).json({ error: 'rate_limited', message: 'Muitas tentativas. Espere um minuto.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'bad_credentials', message: 'E-mail ou senha não conferem.' });
    }
    const live = await freshUser(user);
    await issueRefresh(res, live.id, req.body.remember !== false);
    return res.json({ accessToken: signAccess(live), user: publicUser(live) });
  });

  app.post('/v1/auth/google', async (req, res) => {
    const aud = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const idToken = String(req.body.idToken || '');
    if (!aud) return res.status(503).json({ error: 'google_off', message: 'Falta o GOOGLE_CLIENT_ID no .env.' });
    if (!idToken) return res.status(400).json({ error: 'invalid_body', message: 'Entre pelo botão do Google.' });
    let info;
    try {
      info = await fetch('https://oauth2.googleapis.com/tokeninfo', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken }),
      });
    } catch {
      return res.status(502).json({ error: 'upstream_fail', message: 'Não consegui confirmar o login do Google.' });
    }
    const data = await info.json().catch(() => ({}));
    const verified = data.email_verified === true || data.email_verified === 'true';
    if (!info.ok || !verified || data.aud !== aud || !data.sub) {
      return res.status(401).json({ error: 'bad_credentials', message: 'Token do Google recusado.' });
    }
    const email = String(data.email || '').toLowerCase();
    const name = String(data.name || '').trim();
    const sub = String(data.sub);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_body', message: 'E-mail inválido.' });
    const googleSub = sub;
    let { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user = rows[0];
    let created = false;
    if (!user) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query(
          `INSERT INTO users (email, google_sub, name, locale, email_verified_at)
           VALUES ($1,$2,$3,$4, now()) RETURNING *`,
          [email, googleSub, name || null, 'pt-BR'],
        );
        await seedPresets(client, inserted.rows[0].id);
        await client.query('COMMIT');
        user = inserted.rows[0];
        created = true;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      await pool.query(
        `UPDATE users
         SET google_sub = $1,
             name = COALESCE(NULLIF($2, ''), name),
             email_verified_at = COALESCE(email_verified_at, now())
         WHERE id = $3`,
        [sub, name || '', user.id],
      );
    }
    if (!user.trial_started_at) await openTrial(user.id);
    user = await freshUser(await loadUser(user.id));
    await desk.reloadUser(user.id);
    await issueRefresh(res, user.id, req.body.remember !== false);
    return res.json({
      accessToken: signAccess(user),
      user: publicUser(user),
      created,
      google: true,
    });
  });

  app.post('/v1/auth/refresh', async (req, res) => {
    const token = req.cookies.refresh || req.body.refreshToken;
    if (!token) return res.status(401).json({ error: 'unauthorized', message: 'Sem refresh.' });
    const { rows } = await pool.query(
      `SELECT * FROM refresh_tokens WHERE token_hash = $1 AND expires_at > now()`,
      [sha256(token)],
    );
    if (!rows[0]) return res.status(401).json({ error: 'unauthorized', message: 'Refresh inválido.' });
    const user = await freshUser(await loadUser(rows[0].user_id));
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    await pool.query('DELETE FROM refresh_tokens WHERE id = $1', [rows[0].id]);
    await issueRefresh(res, user.id, req.body.remember !== false);
    return res.json({ accessToken: signAccess(user), user: publicUser(user) });
  });

  app.post('/v1/auth/logout', async (req, res) => {
    const token = req.cookies.refresh;
    if (token) await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [sha256(token)]);
    res.clearCookie('refresh', { path: '/v1/auth' });
    return res.json({ ok: true });
  });

  app.post('/v1/auth/verify-email', auth, currentUser, async (req, res) => {
    const code = String(req.body.code || '').trim();
    const ok = await consumeCode(req.user.id, 'email', code);
    if (!ok) return res.status(400).json({ error: 'bad_code', message: 'Código de e-mail inválido ou vencido.' });
    await pool.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [req.user.id]);
    const fresh = await loadUser(req.user.id);
    if (fresh.email_verified_at) {
      await openTrial(fresh.id);
      await maybeStripeCustomer(fresh);
    }
    const user = await loadUser(req.user.id);
    await desk.reloadUser(user.id);
    return res.json({ user: publicUser(user) });
  });

  app.post('/v1/auth/verify-phone', auth, currentUser, async (req, res) => {
    const code = String(req.body.code || '').trim();
    const ok = await consumeCode(req.user.id, 'sms', code);
    if (!ok) return res.status(400).json({ error: 'bad_code', message: 'Código do celular inválido ou vencido.' });
    await pool.query('UPDATE users SET phone_verified_at = COALESCE(phone_verified_at, now()) WHERE id = $1', [req.user.id]);
    const fresh = await loadUser(req.user.id);
    if (fresh.email_verified_at && fresh.phone_verified_at) {
      await openTrial(fresh.id);
      await maybeStripeCustomer(fresh);
    }
    const user = await loadUser(req.user.id);
    await desk.reloadUser(user.id);
    return res.json({ user: publicUser(user) });
  });

  app.post('/v1/auth/phone', auth, currentUser, async (req, res) => {
    const phone = String(req.body.phone || '').trim();
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: 'invalid_body', message: 'Celular em formato +5511999998888.' });
    try {
      await pool.query('UPDATE users SET phone_e164 = $1, phone_verified_at = NULL WHERE id = $2', [phone, req.user.id]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'phone_taken', message: 'Este celular já está em uso.' });
      throw err;
    }
    const code = await issueCode(req.user.id, 'sms');
    return res.json({
      user: publicUser(await loadUser(req.user.id)),
      verification: { phoneCode: expose(code) },
    });
  });

  app.post('/v1/auth/resend', auth, currentUser, async (req, res) => {
    const channel = req.body.channel === 'sms' ? 'sms' : 'email';
    if (!allow(`resend:${req.user.id}:${channel}`, 1, 60_000)) {
      return res.status(429).json({ error: 'rate_limited', message: 'Espere um minuto para pedir outro código.' });
    }
    if (!allow(`resendh:${req.user.id}:${channel}`, 5, 3600_000)) {
      return res.status(429).json({ error: 'rate_limited', message: 'Limite de reenvios desta hora.' });
    }
    if (channel === 'sms' && !req.user.phone_e164) return res.status(400).json({ error: 'invalid_body', message: 'Cadastre o celular antes.' });
    const code = await issueCode(req.user.id, channel);
    return res.json({
      ok: true,
      channel,
      code: expose(code),
      note: 'Código devolvido na resposta, sem envio externo.',
    });
  });

  app.get('/v1/me', auth, currentUser, (req, res) => res.json({ user: req.profile }));

  app.patch('/v1/me', auth, currentUser, async (req, res) => {
    const name = req.body.name != null ? String(req.body.name).slice(0, 80) : req.user.name;
    const locale = LOCALES.includes(req.body.locale) ? req.body.locale : req.user.locale;
    let mare = req.user.mare_prefs || {};
    if (req.body.marePrefs && typeof req.body.marePrefs === 'object') {
      const src = req.body.marePrefs;
      mare = {
        enabled: src.enabled !== false,
        windowMs: clamp(Number(src.windowMs) || 300000, 60_000, 3600_000),
        majority: clamp(Number(src.majority) || 0.55, 0.5, 0.9),
        noisePct: clamp(Number(src.noisePct) || 0.05, 0.01, 0.5),
      };
    }
    await pool.query('UPDATE users SET name = $1, locale = $2, mare_prefs = $3::jsonb WHERE id = $4', [name, locale, JSON.stringify(mare), req.user.id]);
    await desk.reloadUser(req.user.id);
    return res.json({ user: publicUser(await loadUser(req.user.id)) });
  });

  app.delete('/v1/me', auth, currentUser, async (req, res) => {
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    await desk.reloadUser(req.user.id);
    res.clearCookie('refresh', { path: '/v1/auth' });
    return res.json({ ok: true });
  });

  app.get('/v1/config', (_req, res) => {
    res.json({ googleClientId: (process.env.GOOGLE_CLIENT_ID || '').trim() });
  });

  app.get('/v1/billing/plans', (_req, res) => {
    res.json(catalog());
  });

  app.get('/v1/billing/status', auth, currentUser, (req, res) => {
    res.json({
      planStatus: req.profile.planStatus,
      planTier: req.profile.planTier,
      desk: req.profile.desk,
      trialEndsAt: req.profile.trialEndsAt,
      daysLeft: req.profile.daysLeft,
      expiring: req.profile.expiring,
      simulated: true,
    });
  });

  async function simulateCheckout(req, res) {
    if (req.profile.desk === 'unverified') {
      return res.status(403).json({ error: 'unverified', message: 'Confirme a conta antes de pagar.' });
    }
    const quote = quotePlan(String(req.body.tier || ''), Number(req.body.months));
    if (!quote) return res.status(400).json({ error: 'invalid_body', message: 'Escolha paper ou pro, por 1, 3, 6 ou 12 meses.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO purchases (user_id, tier, months, amount_brl, currency, status)
         VALUES ($1,$2,$3,$4,'BRL','paid')`,
        [req.user.id, quote.tier, quote.months, quote.total],
      );
      const { rows } = await client.query(
        `UPDATE users
         SET plan_tier = $2,
             plan_status = 'active',
             cancel_requested_at = NULL,
             refund_status = 'none',
             trial_started_at = COALESCE(trial_started_at, now()),
             trial_ends_at = GREATEST(COALESCE(trial_ends_at, now()), now()) + ($3 || ' months')::interval
         WHERE id = $1
         RETURNING *`,
        [req.user.id, quote.tier, String(quote.months)],
      );
      await client.query('COMMIT');
      await desk.reloadUser(req.user.id);
      return res.json({ purchase: quote, user: publicUser(rows[0]), simulated: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  app.post('/v1/billing/simulate', auth, currentUser, simulateCheckout);
  app.post('/v1/billing/checkout', auth, currentUser, simulateCheckout);

  app.post('/v1/billing/cancel', auth, currentUser, async (req, res) => {
    const row = await loadUser(req.user.id);
    if (row.refund_status === 'pending') {
      return res.json({ already: true, user: publicUser(row) });
    }
    const ends = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : 0;
    if (row.plan_status !== 'active' || !(ends > Date.now())) {
      return res.status(400).json({ error: 'nothing_to_cancel', message: 'Não há período pago em aberto para cancelar.' });
    }
    const { rows: buys } = await pool.query(
      `SELECT id, amount_brl, months, created_at
       FROM purchases
       WHERE user_id = $1 AND status = 'paid'
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.user.id],
    );
    const buy = buys[0];
    const quote = remainingRefund({
      paidBrl: buy?.amount_brl,
      months: buy?.months,
      purchasedAt: buy?.created_at,
      accessEndsAt: row.trial_ends_at,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: updated } = await client.query(
        `UPDATE users
         SET cancel_requested_at = now(),
             refund_status = 'pending',
             plan_status = 'expired',
             trial_ends_at = now()
         WHERE id = $1 AND refund_status IS DISTINCT FROM 'pending'
         RETURNING *`,
        [req.user.id],
      );
      if (!updated[0]) {
        await client.query('ROLLBACK');
        const fresh = await loadUser(req.user.id);
        return res.json({ already: true, user: publicUser(fresh) });
      }
      await client.query(
        `INSERT INTO cancellation_requests
          (user_id, email, name, plan_tier, access_ends_at, days_left, purchase_id, paid_brl, months, refund_brl, currency, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'BRL','pending')`,
        [
          row.id,
          row.email,
          row.name,
          row.plan_tier,
          row.trial_ends_at,
          quote.daysLeft,
          buy?.id || null,
          buy ? Number(buy.amount_brl) : null,
          buy?.months || null,
          quote.refundBrl,
        ],
      );
      await client.query('COMMIT');
      await desk.reloadUser(req.user.id);
      return res.json({ user: publicUser(updated[0]), already: false });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  function orderView(row) {
    if (!row) return null;
    return {
      id: row.id,
      strategyId: row.strategy_id,
      strategyName: row.strategy_name,
      amountBrl: Number(row.amount_brl),
      currency: row.currency,
      localAmount: Number(row.local_amount),
      status: row.status,
      paidAt: row.paid_at,
      readyBy: row.ready_by,
    };
  }

  function quoteLocale(req) {
    const asked = String(req.query.locale || req.body?.locale || req.profile.locale || 'pt-BR');
    return ['pt-BR', 'en', 'es', 'es-MX', 'fr', 'de', 'ja'].includes(asked) ? asked : 'en';
  }

  app.get('/v1/strategies/:id/production', auth, currentUser, requireDesk, async (req, res) => {
    const { rows: strategies } = await pool.query(
      'SELECT id, name FROM strategies WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!strategies[0]) return res.status(404).json({ error: 'not_found', message: 'Estratégia não encontrada.' });
    const { rows } = await pool.query(
      'SELECT * FROM production_orders WHERE user_id = $1 AND strategy_id = $2',
      [req.user.id, req.params.id],
    );
    return res.json({
      strategy: { id: strategies[0].id, name: strategies[0].name },
      quote: productionQuote(quoteLocale(req)),
      order: orderView(rows[0]),
    });
  });

  app.post('/v1/strategies/:id/production', auth, currentUser, requireDesk, async (req, res) => {
    const { rows: strategies } = await pool.query(
      'SELECT id, name, description, params FROM strategies WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!strategies[0]) return res.status(404).json({ error: 'not_found', message: 'Estratégia não encontrada.' });
    const { rows: existing } = await pool.query(
      'SELECT * FROM production_orders WHERE user_id = $1 AND strategy_id = $2',
      [req.user.id, req.params.id],
    );
    if (existing[0]) return res.json({ order: orderView(existing[0]), already: true });
    const quote = productionQuote(quoteLocale(req));
    const readyBy = new Date(Date.now() + 3 * 86400000);
    const { rows } = await pool.query(
      `INSERT INTO production_orders
        (user_id, user_email, user_name, locale, strategy_id, strategy_name, thesis, recipe,
         amount_brl, currency, local_amount, fx_rate, status, ready_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,'paid',$13)
       RETURNING *`,
      [
        req.user.id, req.user.email, req.user.name || null, quote.locale,
        strategies[0].id, strategies[0].name, strategies[0].description || '',
        JSON.stringify(strategies[0].params || {}),
        quote.amountBrl, quote.currency, quote.localAmount, quote.fxRate, readyBy,
      ],
    );
    await notifyOwner(
      `TradeAI produção · ${req.user.email} · ${strategies[0].name}`,
      [
        `Usuário: ${req.user.name || ''} <${req.user.email}>`,
        `Id: ${req.user.id}`,
        `Estratégia: ${strategies[0].name} (${strategies[0].id})`,
        `Descrição: ${strategies[0].description || ''}`,
        `Valor: ${quote.localAmount} ${quote.currency} (R$ ${quote.amountBrl})`,
        `Pedido: ${rows[0].id}`,
        `Pronto em média até: ${readyBy.toISOString()}`,
      ].join('\n'),
    );
    return res.json({ order: orderView(rows[0]), quote });
  });

  app.get('/v1/strategies', auth, currentUser, requireDesk, async (req, res) => {
    const state = await desk.stateFor(req.user.id);
    res.json({ strategies: state.strategies, mare: state.mare, connection: state.connection });
  });

  app.get('/v1/strategies/:id', auth, currentUser, requireDesk, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM strategies WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found', message: 'Estratégia não encontrada.' });
    const trades = await pool.query(
      `SELECT id, symbol, side, opened_at, closed_at, entry, exit, qty, quote, pnl_usdt, fees, exit_type, result, raw
       FROM trades WHERE strategy_id = $1 AND user_id = $2 ORDER BY opened_at DESC LIMIT 200`,
      [req.params.id, req.user.id],
    );
    const thread = await pool.query(
      'SELECT id FROM threads WHERE user_id = $1 AND strategy_id = $2 ORDER BY created_at DESC LIMIT 1',
      [req.user.id, req.params.id],
    );
    let messages = [];
    if (thread.rows[0]) {
      const bag = await pool.query('SELECT id, role, content, created_at FROM messages WHERE thread_id = $1 ORDER BY created_at', [thread.rows[0].id]);
      messages = bag.rows;
    }
    const locale = req.profile.locale;
    res.json({
      strategy: {
        ...rows[0],
        explanation: localizedExplanation(rows[0].explanation, locale),
        explanationAll: rows[0].explanation,
      },
      trades: trades.rows,
      threadId: thread.rows[0]?.id || null,
      messages,
    });
  });

  app.post('/v1/strategies/prompt', auth, currentUser, requireDesk, async (req, res) => {
    const prompt = String(req.body.prompt || '').trim();
    const job = await enqueuePrompt(req, { prompt, threadId: req.body.threadId || null, strategyId: null });
    if (job.error) return res.status(job.status).json(job.error);
    return res.status(202).json(job);
  });

  app.post('/v1/alarms/:id/channels', auth, currentUser, requireDesk, async (req, res) => {
    const channels = cleanChannels(req.body || {});
    const updated = await pool.query(
      `UPDATE alarms SET channels = $3::jsonb WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user.id, JSON.stringify(channels)],
    );
    if (!updated.rows[0]) return res.status(404).json({ error: 'not_found', message: 'Alarme não encontrado.' });
    await desk.reloadUser(req.user.id);
    res.json({ ok: true, channels });
  });

  app.post('/v1/alarms/:id/pause', auth, currentUser, requireDesk, async (req, res) => {
    await pool.query(`UPDATE alarms SET status = 'paused' WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    await desk.reloadUser(req.user.id);
    res.json({ ok: true });
  });

  app.post('/v1/alarms/:id/arm', auth, currentUser, requireDesk, async (req, res) => {
    await pool.query(`UPDATE alarms SET status = 'armed' WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    await desk.reloadUser(req.user.id);
    res.json({ ok: true });
  });

  app.delete('/v1/alarms/:id', auth, currentUser, requireDesk, async (req, res) => {
    await pool.query('DELETE FROM alarms WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    await desk.reloadUser(req.user.id);
    res.json({ ok: true });
  });

  app.post('/v1/alarms/hits/:id/seen', auth, currentUser, requireDesk, async (req, res) => {
    await pool.query('UPDATE alarm_hits SET seen_at = now() WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    await desk.reloadUser(req.user.id);
    res.json({ ok: true });
  });

  app.post('/v1/strategies/:id/prompt', auth, currentUser, requireDesk, async (req, res) => {
    const prompt = String(req.body.prompt || '').trim();
    const found = await pool.query('SELECT id FROM strategies WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!found.rows[0]) {
      if (prompt) await savePrompt(req, { prompt, mode: 'edit', status: 'rejected', detail: 'Estratégia não encontrada.', strategyId: req.params.id });
      return res.status(404).json({ error: 'not_found', message: 'Estratégia não encontrada.' });
    }
    const job = await enqueuePrompt(req, { prompt, threadId: req.body.threadId || null, strategyId: req.params.id });
    if (job.error) return res.status(job.status).json(job.error);
    return res.status(202).json(job);
  });

  app.patch('/v1/strategies/:id', auth, currentUser, requireDesk, async (req, res) => {
    const name = req.body.name != null ? String(req.body.name).slice(0, 80) : null;
    const mareMode = ['any', 'not_bad', 'good', 'neutral'].includes(req.body.mareMode) ? req.body.mareMode : null;
    const paused = typeof req.body.paused === 'boolean' ? req.body.paused : null;
    const { rows } = await pool.query(
      `UPDATE strategies SET
         name = COALESCE($3, name),
         mare_mode = COALESCE($4, mare_mode),
         paused = COALESCE($5, paused)
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.id, name, mareMode, paused],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    await desk.reloadUser(req.user.id);
    return res.json({ strategy: rows[0] });
  });

  app.post('/v1/strategies/:id/pause', auth, currentUser, requireDesk, async (req, res) => {
    await pool.query('UPDATE strategies SET paused = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    await desk.reloadUser(req.user.id);
    res.json({ ok: true });
  });

  app.post('/v1/strategies/:id/resume', auth, currentUser, requireDesk, async (req, res) => {
    await pool.query('UPDATE strategies SET paused = false WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    await desk.reloadUser(req.user.id);
    res.json({ ok: true });
  });

  app.delete('/v1/strategies/:id', auth, currentUser, requireDesk, async (req, res) => {
    const { rowCount } = await pool.query('DELETE FROM strategies WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    await desk.reloadUser(req.user.id);
    res.json({ ok: true });
  });

  app.post('/v1/strategies/:id/reset', auth, currentUser, requireDesk, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT p.snapshot FROM strategies s LEFT JOIN positions p ON p.strategy_id = s.id WHERE s.id = $1 AND s.user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    await pool.query('DELETE FROM trades WHERE strategy_id = $1', [req.params.id]);
    const start = rows[0].snapshot?.initial;
    await pool.query('UPDATE positions SET snapshot = $2::jsonb, updated_at = now() WHERE strategy_id = $1', [req.params.id, JSON.stringify(emptySnap(Date.now(), start))]);
    await desk.reloadUser(req.user.id);
    res.json({ ok: true });
  });

  app.post('/v1/strategies/restore-presets', auth, currentUser, requireDesk, async (req, res) => {
    for (const preset of PRESETS) {
      const { rows } = await pool.query(
        'SELECT id FROM strategies WHERE user_id = $1 AND preset_key = $2',
        [req.user.id, preset.presetKey],
      );
      if (!rows[0]) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const sid = id('s');
          await client.query(
            `INSERT INTO strategies (id, user_id, name, type, mare_mode, params, description, explanation, source, preset_key)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,'preset',$9)`,
            [sid, req.user.id, preset.name, preset.type, preset.mareMode, JSON.stringify(preset.params), preset.description, JSON.stringify(preset.explanation), preset.presetKey],
          );
          await client.query('INSERT INTO positions (strategy_id, snapshot) VALUES ($1,$2::jsonb)', [sid, JSON.stringify(emptySnap())]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      } else {
        await pool.query(
          `UPDATE strategies SET name=$1, type=$2, mare_mode=$3, params=$4::jsonb, description=$5, explanation=$6::jsonb, source='preset'
           WHERE id=$7 AND user_id=$8`,
          [preset.name, preset.type, preset.mareMode, JSON.stringify(preset.params), preset.description, JSON.stringify(preset.explanation), rows[0].id, req.user.id],
        );
      }
    }
    await desk.reloadUser(req.user.id);
    res.json({ ok: true });
  });

  app.get('/v1/jobs', auth, currentUser, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, kind, status, error, strategy_id, created_at, updated_at FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id],
    );
    res.json({ jobs: rows });
  });

  app.get('/v1/jobs/:id', auth, currentUser, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ job: rows[0] });
  });

  app.get('/v1/desk/state', auth, currentUser, requireDesk, async (req, res) => {
    res.json(await desk.stateFor(req.user.id));
  });

  app.get('/v1/desk/mare', auth, currentUser, requireDesk, async (req, res) => {
    const state = await desk.stateFor(req.user.id);
    res.json({ mare: state.mare, connection: state.connection });
  });

  app.get('/v1/lab/manifest', auth, currentUser, requireDesk, (_req, res) => {
    res.json(lab.manifestPublic());
  });

  app.get('/v1/lab/symbols', auth, currentUser, requireDesk, (_req, res) => {
    res.json({ symbols: lab.symbols() });
  });

  app.get('/v1/lab/klines/:symbol', auth, currentUser, requireDesk, async (req, res) => {
    const interval = ['1m', '5m', '1h'].includes(req.query.interval) ? req.query.interval : '1h';
    const limit = Number(req.query.limit || (interval === '1m' ? 500 : 800));
    if (interval === '1m' && limit > 4320) return res.status(400).json({ error: 'invalid_body', message: '1 minuto só até 3 dias.' });
    try {
      const data = await lab.klines({ symbol: req.params.symbol.toUpperCase(), interval, limit });
      res.json({ symbol: req.params.symbol.toUpperCase(), interval, total: data.total, bars: data.bars });
    } catch (err) {
      res.status(err.status || 500).json({ error: 'lab', message: err.message });
    }
  });

  app.get('/v1/lab/artifacts', auth, currentUser, requireDesk, (_req, res) => {
    res.json({
      artifacts: lab.artifacts().map(({ id: name, name: title, summary, bytes, generatedAt, top }) => ({
        id: name, name: title, summary, bytes, generatedAt, top,
      })),
    });
  });

  app.get('/v1/lab/artifacts/:id', auth, currentUser, requireDesk, (req, res) => {
    const found = lab.artifactByName(req.params.id);
    if (!found) return res.status(404).json({ error: 'not_found' });
    res.json({ artifact: found });
  });

  app.post('/v1/lab/query', auth, currentUser, requireDesk, async (req, res) => {
    const prompt = String(req.body.prompt || '').trim();
    if (!allow(`lab:${req.user.id}`, 20, 3600_000)) {
      if (prompt) await savePrompt(req, { prompt, mode: 'lab', status: 'rejected', detail: 'Muitas perguntas ao laboratório nesta hora.' });
      return res.status(429).json({ error: 'rate_limited', message: 'Muitas perguntas ao laboratório nesta hora.' });
    }
    if (prompt.length < 2) {
      if (prompt) await savePrompt(req, { prompt, mode: 'lab', status: 'rejected', detail: 'Escreve o pedido.' });
      return res.status(400).json({ error: 'invalid_body', message: 'Escreve o pedido.' });
    }
    const history = Array.isArray(req.body.history)
      ? req.body.history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()).slice(-14)
      : [];
    const { rows } = await pool.query(
      `INSERT INTO jobs (user_id, kind, status, input) VALUES ($1, 'lab', 'queued', $2::jsonb) RETURNING id, status`,
      [req.user.id, JSON.stringify({ prompt, history, locale: req.profile?.locale || req.user?.locale || 'pt-BR' })],
    );
    await savePrompt(req, { prompt, mode: 'lab', status: 'queued', jobId: rows[0].id });
    res.status(202).json({ jobId: rows[0].id, status: rows[0].status });
  });

  app.use((err, _req, res, _next) => {
    console.error('[api]', err);
    res.status(500).json({ error: 'server', message: 'Erro interno.' });
  });

  return app;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

async function consumeCode(userId, channel, code) {
  if (!/^\d{6}$/.test(code)) return false;
  const { rows } = await pool.query(
    `SELECT id, code_hash FROM otp_challenges
     WHERE user_id = $1 AND channel = $2 AND consumed_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [userId, channel],
  );
  if (!rows[0]) return false;
  const a = Buffer.from(rows[0].code_hash);
  const b = Buffer.from(sha256(code));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  await pool.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [rows[0].id]);
  return true;
}

function cleanChannels(raw) {
  const src = raw.channels && typeof raw.channels === 'object' ? raw.channels : raw;
  return {
    sound: src.sound !== false,
    email: !!src.email,
    sms: !!src.sms,
  };
}

function cleanOptions(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const exit = raw.exit === 'manual' ? 'manual' : 'history';
  const time = raw.time === 'manual' ? 'manual' : 'history';
  return {
    exit,
    stopPct: raw.stopPct == null ? null : Number(raw.stopPct),
    tpPct: raw.tpPct == null ? null : Number(raw.tpPct),
    timeExit: !!raw.timeExit,
    time,
    maxHoldMin: raw.maxHoldMin == null ? null : Number(raw.maxHoldMin),
    variants: !!raw.variants,
    mareMode: ['any', 'good', 'not_bad'].includes(raw.mareMode) ? raw.mareMode : 'any',
    channels: cleanChannels(raw.channels || {}),
    wallet: raw.wallet == null || raw.wallet === '' ? 1000 : walletOf(raw.wallet),
  };
}

function promptMode(req, strategyId, prompt) {
  if (strategyId) return 'edit';
  if (req.body.mode === 'alarm' || /\b(me\s+avis\w*|alarme|alerta)\b/i.test(prompt)) return 'alarm';
  return 'create';
}

async function savePrompt(req, { prompt, mode, status, detail, jobId, threadId, strategyId }) {
  await pool.query(
    `INSERT INTO prompts (user_id, user_email, job_id, thread_id, prompt, mode, status, strategy_id, detail, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $7 = 'queued' THEN NULL ELSE now() END)`,
    [req.user.id, req.user.email, jobId || null, threadId || null, prompt, mode, status, strategyId || null, detail || null],
  );
}

async function enqueuePrompt(req, { prompt, threadId, strategyId }) {
  const mode = promptMode(req, strategyId, prompt);
  if (prompt.length < 2) {
    if (prompt) await savePrompt(req, { prompt, mode, status: 'rejected', detail: 'Escreve o pedido.', threadId, strategyId });
    return { status: 400, error: { error: 'invalid_body', message: 'Escreve o pedido.' } };
  }
  if (!allow(`prompt-h:${req.user.id}`, 60, 3600_000)) {
    await savePrompt(req, { prompt, mode, status: 'rejected', detail: 'Muitos prompts em pouco tempo.', threadId, strategyId });
    return { status: 429, error: { error: 'rate_limited', message: 'Muitos prompts em pouco tempo. Tenta de novo mais tarde.' } };
  }
  if (!strategyId && req.body.mode !== 'alarm' && req.body.options && walletOf(req.body.options.wallet) == null && req.body.options.wallet != null && req.body.options.wallet !== '') {
    await savePrompt(req, { prompt, mode, status: 'rejected', detail: 'Carteira fora do intervalo.', strategyId });
    return { status: 400, error: { error: 'invalid_body', message: 'A carteira fica entre 100 e 999.000 dólares.' } };
  }
  let thread = threadId;
  if (thread) {
    const own = await pool.query('SELECT id, strategy_id FROM threads WHERE id = $1 AND user_id = $2', [thread, req.user.id]);
    if (!own.rows[0]) {
      await savePrompt(req, { prompt, mode, status: 'rejected', detail: 'Conversa não encontrada.', threadId, strategyId });
      return { status: 404, error: { error: 'not_found', message: 'Conversa não encontrada.' } };
    }
  } else if (strategyId) {
    const existing = await pool.query(
      'SELECT id FROM threads WHERE user_id = $1 AND strategy_id = $2 ORDER BY created_at DESC LIMIT 1',
      [req.user.id, strategyId],
    );
    if (existing.rows[0]) thread = existing.rows[0].id;
  }
  if (!thread) {
    const created = await pool.query(
      'INSERT INTO threads (user_id, strategy_id) VALUES ($1, $2) RETURNING id',
      [req.user.id, strategyId],
    );
    thread = created.rows[0].id;
  }
  await pool.query('INSERT INTO messages (thread_id, role, content) VALUES ($1, $2, $3)', [thread, 'user', prompt]);
  const job = await pool.query(
    `INSERT INTO jobs (user_id, kind, status, input, thread_id, strategy_id)
     VALUES ($1, $2, 'queued', $3::jsonb, $4, $5) RETURNING id, status`,
    [
      req.user.id,
      strategyId ? 'prompt_edit' : 'prompt_create',
      JSON.stringify({
        prompt,
        locale: req.profile.locale || 'pt-BR',
        strategyId,
        mode: strategyId ? 'trade' : (req.body.mode === 'alarm' || /\b(me\s+avis\w*|alarme|alerta)\b/i.test(prompt) ? 'alarm' : 'trade'),
        options: cleanOptions(req.body.options),
      }),
      thread,
      strategyId,
    ],
  );
  await savePrompt(req, {
    prompt,
    mode,
    status: 'queued',
    jobId: job.rows[0].id,
    threadId: thread,
    strategyId,
  });
  return { jobId: job.rows[0].id, status: job.rows[0].status, threadId: thread };
}

module.exports = { createHttp };
