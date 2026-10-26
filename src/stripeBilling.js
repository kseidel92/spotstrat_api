const Stripe = require('stripe');
const { pool } = require('./db');
const { publicUser } = require('./shared');

function stripeClient() {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return null;
  return new Stripe(key);
}

function stripeConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY || '').trim()
    && !!(process.env.STRIPE_PRICE_ID || '').trim();
}

function publishableKey() {
  return (process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
}

function priceForPlan(tier, months) {
  const map = {
    paper: {
      1: process.env.STRIPE_PRICE_PAPER_1M,
      3: process.env.STRIPE_PRICE_PAPER_3M,
      6: process.env.STRIPE_PRICE_PAPER_6M,
      12: process.env.STRIPE_PRICE_PAPER_12M,
    },
    pro: {
      1: process.env.STRIPE_PRICE_PRO_1M,
      3: process.env.STRIPE_PRICE_PRO_3M,
      6: process.env.STRIPE_PRICE_PRO_6M,
      12: process.env.STRIPE_PRICE_PRO_12M,
    },
  };
  const specific = (map[tier] || {})[Number(months)];
  if (specific && String(specific).trim()) return String(specific).trim();
  return (process.env.STRIPE_PRICE_ID || '').trim();
}

function priceForProduction() {
  return (process.env.STRIPE_PRICE_PRODUCTION_ID || process.env.STRIPE_PRICE_ID || '').trim();
}

function stripeLocale(locale) {
  const map = {
    'pt-BR': 'pt-BR',
    en: 'en',
    es: 'es',
    'es-MX': 'es-419',
    fr: 'fr',
    de: 'de',
    ja: 'ja',
  };
  return map[locale] || 'auto';
}

function webOrigin() {
  const raw = (process.env.WEB_ORIGIN || 'http://127.0.0.1:7172').split(',')[0].trim();
  return raw.replace(/\/$/, '') || 'http://127.0.0.1:7172';
}

async function ensureCustomer(stripe, user) {
  if (user.stripe_customer_id) {
    try {
      await stripe.customers.retrieve(user.stripe_customer_id);
      return user.stripe_customer_id;
    } catch (_) {
      /* recreate */
    }
  }
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name || undefined,
    metadata: { userId: user.id },
  });
  await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customer.id, user.id]);
  return customer.id;
}

async function upsertCheckoutRow(session, extra = {}) {
  const meta = session.metadata || {};
  await pool.query(
    `INSERT INTO stripe_checkouts (
       id, user_id, kind, status, payment_status, amount_total, currency,
       price_id, customer_id, payment_intent_id, metadata, raw, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb, now()
     )
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       payment_status = EXCLUDED.payment_status,
       amount_total = COALESCE(EXCLUDED.amount_total, stripe_checkouts.amount_total),
       currency = COALESCE(EXCLUDED.currency, stripe_checkouts.currency),
       price_id = COALESCE(EXCLUDED.price_id, stripe_checkouts.price_id),
       customer_id = COALESCE(EXCLUDED.customer_id, stripe_checkouts.customer_id),
       payment_intent_id = COALESCE(EXCLUDED.payment_intent_id, stripe_checkouts.payment_intent_id),
       metadata = COALESCE(EXCLUDED.metadata, stripe_checkouts.metadata),
       raw = EXCLUDED.raw,
       updated_at = now()`,
    [
      session.id,
      meta.userId || extra.userId || null,
      meta.kind || extra.kind || 'plan',
      session.status || null,
      session.payment_status || null,
      session.amount_total ?? null,
      session.currency || null,
      meta.priceId || extra.priceId || null,
      typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
      JSON.stringify({ ...meta, ...extra.metadata }),
      JSON.stringify(session),
    ],
  );
}

async function recordStripeEvent(event) {
  const { rows } = await pool.query(
    `INSERT INTO stripe_events (id, type, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [event.id, event.type, JSON.stringify(event)],
  );
  return !!rows[0];
}

async function markEventProcessed(eventId, error = null) {
  await pool.query(
    `UPDATE stripe_events
     SET processed_at = now(), process_error = $2
     WHERE id = $1`,
    [eventId, error],
  );
}

async function fulfillPlan(session, desk) {
  const meta = session.metadata || {};
  const userId = meta.userId || session.client_reference_id;
  if (!userId) throw new Error('checkout sem userId');
  if (session.payment_status && session.payment_status !== 'paid') {
    throw new Error(`payment_status=${session.payment_status}`);
  }
  const tier = meta.tier === 'pro' ? 'pro' : 'paper';
  const months = Math.max(1, Number(meta.months) || 1);
  const amountTotal = Number(session.amount_total || 0);
  const currency = String(session.currency || 'brl').toUpperCase();
  const amountBrl = currency === 'BRL'
    ? amountTotal / 100
    : amountTotal / 100; // gravamos o valor cobrado; currency na purchase

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT fulfilled_at FROM stripe_checkouts WHERE id = $1 FOR UPDATE`,
      [session.id],
    );
    if (locked.rows[0]?.fulfilled_at) {
      await client.query('COMMIT');
      return { already: true };
    }
    const { rows: purchases } = await client.query(
      `INSERT INTO purchases (
         user_id, tier, months, amount_brl, currency, status,
         stripe_session_id, stripe_payment_intent_id, stripe_customer_id, provider
       )
       SELECT $1,$2,$3,$4,$5,'paid',$6,$7,$8,'stripe'
       WHERE NOT EXISTS (
         SELECT 1 FROM purchases WHERE stripe_session_id = $6
       )
       RETURNING id`,
      [
        userId,
        tier,
        months,
        amountBrl,
        currency,
        session.id,
        typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
        typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
      ],
    );
    const { rows: users } = await client.query(
      `UPDATE users
       SET plan_tier = $2,
           plan_status = 'active',
           cancel_requested_at = NULL,
           refund_status = 'none',
           stripe_customer_id = COALESCE($4, stripe_customer_id),
           trial_started_at = COALESCE(trial_started_at, now()),
           trial_ends_at = GREATEST(COALESCE(trial_ends_at, now()), now()) + ($3 || ' months')::interval
       WHERE id = $1
       RETURNING *`,
      [
        userId,
        tier,
        String(months),
        typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
      ],
    );
    await client.query(
      `UPDATE stripe_checkouts
       SET fulfilled_at = now(), status = $2, payment_status = $3, updated_at = now()
       WHERE id = $1`,
      [session.id, session.status || 'complete', session.payment_status || 'paid'],
    );
    await client.query('COMMIT');
    if (desk && users[0]) await desk.reloadUser(users[0].id);
    return { user: users[0] ? publicUser(users[0]) : null, purchaseId: purchases[0]?.id || null };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function fulfillProduction(session, desk) {
  const meta = session.metadata || {};
  const userId = meta.userId || session.client_reference_id;
  const strategyId = meta.strategyId;
  if (!userId || !strategyId) throw new Error('checkout de produção incompleto');
  if (session.payment_status && session.payment_status !== 'paid') {
    throw new Error(`payment_status=${session.payment_status}`);
  }
  const { addBusinessDays } = require('./plans');
  const amountTotal = Number(session.amount_total || 0);
  const currency = String(session.currency || 'brl').toUpperCase();
  const amountBrl = amountTotal / 100;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT fulfilled_at FROM stripe_checkouts WHERE id = $1 FOR UPDATE`,
      [session.id],
    );
    if (locked.rows[0]?.fulfilled_at) {
      await client.query('COMMIT');
      return { already: true };
    }
    const { rows: strategies } = await client.query(
      'SELECT id, name, description, recipe, params FROM strategies WHERE id = $1 AND user_id = $2',
      [strategyId, userId],
    );
    if (!strategies[0]) throw new Error('estratégia não encontrada');
    const { rows: users } = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = users[0];
    if (!user) throw new Error('usuário não encontrado');
    const readyBy = addBusinessDays(new Date(), 3);
    const recipe = strategies[0].recipe || strategies[0].params || {};
    await client.query(
      `INSERT INTO production_orders (
         user_id, user_email, user_name, locale, strategy_id, strategy_name, thesis, recipe,
         amount_brl, currency, local_amount, fx_rate, status, ready_by, stripe_session_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,'paid',$13,$14)
       ON CONFLICT (user_id, strategy_id) DO UPDATE SET
         status = 'paid',
         amount_brl = EXCLUDED.amount_brl,
         currency = EXCLUDED.currency,
         local_amount = EXCLUDED.local_amount,
         stripe_session_id = EXCLUDED.stripe_session_id,
         paid_at = now(),
         ready_by = EXCLUDED.ready_by`,
      [
        userId,
        user.email,
        user.name,
        meta.locale || user.locale || 'pt-BR',
        strategyId,
        strategies[0].name,
        strategies[0].description || null,
        JSON.stringify(recipe),
        amountBrl,
        currency,
        amountBrl,
        1,
        readyBy.toISOString(),
        session.id,
      ],
    );
    await client.query(
      `UPDATE stripe_checkouts
       SET fulfilled_at = now(), status = $2, payment_status = $3, updated_at = now()
       WHERE id = $1`,
      [session.id, session.status || 'complete', session.payment_status || 'paid'],
    );
    await client.query('COMMIT');
    if (desk) await desk.reloadUser(userId);
    try {
      const { notifyOwner } = require('./mail');
      await notifyOwner(
        `TradeAI produção · ${user.email} · ${strategies[0].name}`,
        [
          `Usuário: ${user.name || ''} <${user.email}>`,
          `Id: ${user.id}`,
          `Estratégia: ${strategies[0].name} (${strategyId})`,
          `Stripe session: ${session.id}`,
          `Valor: ${amountBrl} ${currency}`,
          `Pronto em média até: ${readyBy.toISOString()}`,
        ].join('\n'),
      );
    } catch (mailErr) {
      console.warn('[stripe production mail]', mailErr.message);
    }
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function fulfillSession(session, desk) {
  await upsertCheckoutRow(session);
  const kind = session.metadata?.kind || 'plan';
  if (kind === 'production') return fulfillProduction(session, desk);
  return fulfillPlan(session, desk);
}

async function createEmbeddedCheckout({
  user, kind = 'plan', tier = 'paper', months = 1, strategyId = null, locale = 'pt-BR',
}) {
  const stripe = stripeClient();
  if (!stripe) {
    const err = new Error('Stripe não configurado');
    err.code = 'stripe_off';
    throw err;
  }
  const priceId = kind === 'production' ? priceForProduction() : priceForPlan(tier, months);
  if (!priceId) {
    const err = new Error('Price ID da Stripe não configurado');
    err.code = 'stripe_off';
    throw err;
  }
  const customerId = await ensureCustomer(stripe, user);
  const origin = webOrigin();
  const lng = locale || user.locale || 'pt-BR';
  const successPath = kind === 'production' && strategyId
    ? `/${lng}/app/strategies/${strategyId}/producao?paid=1&session_id={CHECKOUT_SESSION_ID}`
    : `/${lng}/app/checkout/return?session_id={CHECKOUT_SESSION_ID}`;
  const cancelPath = kind === 'production' && strategyId
    ? `/${lng}/app/strategies/${strategyId}/producao`
    : `/${lng}/app/checkout?tier=${tier}&months=${months}`;

  // Checkout Studio (hosted_page). SDK stripe@^23 → ui_mode hosted_page.
  // payment_method_collection só entra em mode=subscription (regra Stripe).
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    ui_mode: 'hosted_page',
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: false },
    automatic_tax: { enabled: false },
    allow_promotion_codes: false,
    submit_type: 'auto',
    integration_identifier: 'hosted_web_0001',
    origin_context: 'web',
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}${successPath}`,
    cancel_url: `${origin}${cancelPath}`,
    locale: stripeLocale(lng),
    metadata: {
      userId: user.id,
      kind,
      tier: String(tier || 'paper'),
      months: String(months || 1),
      strategyId: strategyId || '',
      locale: lng,
      priceId,
    },
    payment_intent_data: {
      metadata: {
        userId: user.id,
        kind,
        tier: String(tier || 'paper'),
        months: String(months || 1),
        strategyId: strategyId || '',
      },
    },
  });

  await upsertCheckoutRow(session, {
    userId: user.id,
    kind,
    priceId,
    metadata: { tier, months, strategyId },
  });

  return {
    sessionId: session.id,
    url: session.url,
    publishableKey: publishableKey(),
  };
}

async function retrieveAndFulfill(sessionId, desk) {
  const stripe = stripeClient();
  if (!stripe) {
    const err = new Error('Stripe não configurado');
    err.code = 'stripe_off';
    throw err;
  }
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status === 'paid' || session.status === 'complete') {
    await fulfillSession(session, desk);
  } else {
    await upsertCheckoutRow(session);
  }
  return session;
}

async function handleWebhook(rawBody, signature, desk) {
  const stripe = stripeClient();
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!stripe || !secret) {
    const err = new Error('Stripe webhook off');
    err.code = 'stripe_off';
    throw err;
  }
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  const inserted = await recordStripeEvent(event);
  if (!inserted) {
    return { ok: true, duplicate: true };
  }
  try {
    const obj = event.data.object;
    if (
      event.type === 'checkout.session.completed'
      || event.type === 'checkout.session.async_payment_succeeded'
    ) {
      await fulfillSession(obj, desk);
    } else if (event.type === 'checkout.session.expired') {
      await upsertCheckoutRow(obj);
    } else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      await pool.query(
        `UPDATE purchases SET status = $2
         WHERE stripe_payment_intent_id = $1 OR stripe_session_id = $3`,
        [
          obj.payment_intent || null,
          event.type === 'charge.dispute.created' ? 'disputed' : 'refunded',
          obj.metadata?.checkout_session_id || null,
        ],
      );
    }
    await markEventProcessed(event.id, null);
    return { ok: true, type: event.type };
  } catch (err) {
    await markEventProcessed(event.id, err.message);
    throw err;
  }
}

module.exports = {
  stripeClient,
  stripeConfigured,
  publishableKey,
  createEmbeddedCheckout,
  retrieveAndFulfill,
  handleWebhook,
  fulfillSession,
  priceForPlan,
  priceForProduction,
};
