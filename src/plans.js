const MONTHLY = { paper: 93.33 };
const PRODUCTION_BRL = 633.3;
const FX = { BRL: 1, USD: 0.19723, EUR: 0.1756, MXN: 3.65, JPY: 31.175 };
const LOCALE_CCY = { 'pt-BR': 'BRL', en: 'USD', es: 'EUR', 'es-MX': 'MXN', fr: 'EUR', de: 'EUR', ja: 'JPY' };
const TERMS = [
  { months: 1, off: 0 },
  { months: 3, off: 0.1 },
  { months: 6, off: 0.18 },
  { months: 12, off: 0.28 },
];

function quotePlan(tier, months) {
  const term = TERMS.find((item) => item.months === Number(months));
  const base = MONTHLY[tier];
  if (!term || !base) return null;
  const monthly = Math.round(base * (1 - term.off) * 100) / 100;
  const total = Math.round(monthly * term.months * 100) / 100;
  return {
    tier,
    months: term.months,
    off: term.off,
    monthly,
    total,
    currency: 'BRL',
    label: term.months === 12 ? '1 ano' : `${term.months} ${term.months === 1 ? 'mês' : 'meses'}`,
  };
}

function productionQuote(locale) {
  const currency = LOCALE_CCY[locale] || 'USD';
  const rate = FX[currency];
  const localAmount = currency === 'JPY'
    ? Math.round(PRODUCTION_BRL * rate)
    : Math.round(PRODUCTION_BRL * rate * 100) / 100;
  return {
    amountBrl: PRODUCTION_BRL,
    currency,
    localAmount,
    fxRate: rate,
    locale: LOCALE_CCY[locale] ? locale : 'en',
  };
}

function catalog() {
  return {
    currency: 'BRL',
    tiers: ['paper'],
    production: productionQuote('pt-BR'),
    terms: TERMS.map((term) => ({
      months: term.months,
      off: term.off,
      paper: quotePlan('paper', term.months),
    })),
  };
}

function addBusinessDays(start, days) {
  const date = new Date(start);
  let left = days;
  while (left > 0) {
    date.setDate(date.getDate() + 1);
    const weekday = date.getDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return date;
}

async function applyWaitBonus(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, requested_at, bonus_days_applied
     FROM production_requests
     WHERE user_id = $1 AND status = 'queued'
     ORDER BY requested_at DESC
     LIMIT 1`,
    [userId],
  );
  const request = rows[0];
  if (!request) return 0;
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(request.requested_at).getTime()) / 86400000));
  const owed = elapsed * 2;
  const delta = owed - Number(request.bonus_days_applied || 0);
  if (delta <= 0) return 0;
  await pool.query(
    `UPDATE users
     SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, now()), now()) + ($2 || ' days')::interval
     WHERE id = $1`,
    [userId, String(delta)],
  );
  await pool.query(
    'UPDATE production_requests SET bonus_days_applied = bonus_days_applied + $2 WHERE id = $1',
    [request.id, delta],
  );
  return delta;
}

async function settleAccount(pool, row) {
  let changed = false;
  const ended = row.trial_ends_at && new Date(row.trial_ends_at).getTime() <= Date.now();
  if (ended && (row.plan_status === 'trialing' || row.plan_status === 'active')) {
    await pool.query(`UPDATE users SET plan_status = 'expired' WHERE id = $1 AND trial_ends_at <= now()`, [row.id]);
    changed = true;
  }
  if (row.plan_tier === 'pro' && !ended) {
    const added = await applyWaitBonus(pool, row.id);
    if (added) changed = true;
  }
  if (!changed) return { row, changed: false };
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [row.id]);
  return { row: rows[0], changed: true };
}

function remainingRefund({ paidBrl, months, purchasedAt, accessEndsAt, now = Date.now() }) {
  const ends = accessEndsAt ? new Date(accessEndsAt).getTime() : 0;
  const daysLeft = ends > now ? Math.max(1, Math.ceil((ends - now) / 86400000)) : 0;
  const paid = Number(paidBrl);
  const termDays = Math.max(1, Math.round((Number(months) || 0) * 30));
  if (!(paid > 0) || daysLeft <= 0) return { daysLeft, refundBrl: 0 };
  const start = purchasedAt ? new Date(purchasedAt).getTime() : NaN;
  const span = Number.isFinite(start) && ends > start ? Math.max(1, Math.ceil((ends - start) / 86400000)) : termDays;
  const denom = Math.max(1, Math.min(span, termDays));
  const covered = Math.min(daysLeft, denom);
  const refundBrl = Math.round(Math.min(paid, (paid * covered) / denom) * 100) / 100;
  return { daysLeft, refundBrl };
}

module.exports = { quotePlan, catalog, productionQuote, addBusinessDays, applyWaitBonus, settleAccount, remainingRefund, MONTHLY, TERMS, PRODUCTION_BRL };
