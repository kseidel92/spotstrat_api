const crypto = require('crypto');

const INITIAL = Number(process.env.PAPER_INITIAL_BALANCE || 1000);
const TAKER = 0.00075;
const MAKER = 0.00075;
const MIN_NET_RR = 1.15;
const TRIAL_HOURS = Number(process.env.TRIAL_HOURS || 24);
const TRIAL_PROMPT_LIMIT = Number(process.env.TRIAL_PROMPT_LIMIT || 10);
const LOCALES = ['pt-BR', 'en', 'es', 'es-MX', 'fr', 'de', 'ja'];

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function brtDay(ts = Date.now()) {
  return new Date(ts - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function walletOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  if (rounded < 100 || rounded > 999000) return null;
  return rounded;
}

function emptySnap(now = Date.now(), initial = INITIAL) {
  const start = walletOf(initial) || INITIAL;
  return {
    equity: start,
    cash: start,
    initial: start,
    dayKey: brtDay(now),
    dayStartEquity: start,
    halted: false,
    position: null,
    cooldowns: {},
    stopCooldowns: {},
    watch: {},
    events: [],
    startedAt: new Date(now).toISOString(),
  };
}

function netRR({ stopPct, tpPct, feeIn = TAKER, feeOutTp = MAKER, feeOutSl = TAKER }) {
  const stop = Number(stopPct) / 100;
  const tp = Number(tpPct) / 100;
  if (!(stop > 0) || !(tp > 0)) return { ok: false, reason: 'stop/alvo inválidos' };
  const lossNet = stop + feeIn + feeOutSl;
  const gainNet = tp - feeIn - feeOutTp;
  if (!(gainNet > 0)) return { ok: false, reason: 'alvo não cobre a taxa', gainNet, lossNet };
  const rr = gainNet / lossNet;
  return { ok: true, stopPct: stop, tpPct: tp, gainNet, lossNet, netRR: rr };
}

function sizeQuote({ equity, cash, entry, stopLoss, side }) {
  const px = Number(entry);
  const sl = Number(stopLoss);
  const stopDist = side === 'short' ? (sl - px) / px : (px - sl) / px;
  if (!(px > 0) || !(sl > 0) || !(stopDist > 0)) return { ok: false, reason: 'stop/entrada inválidos' };
  const eq = Number(equity);
  const bag = Number(cash);
  if (!(eq > 0) || !(bag > 0)) return { ok: false, reason: 'sem caixa' };
  const riskBudget = eq * 0.01;
  const riskQuote = riskBudget / stopDist;
  const cap = bag * 0.95;
  const quote = Math.min(riskQuote, cap, bag * 0.94);
  if (!(quote >= 10)) return { ok: false, reason: 'lote abaixo de 10 USDT' };
  return { ok: true, quote, stopDist };
}

const OPS = new Set([
  'range_pos', 'swings', 'touches', 'dump', 'rebound_green', 'rs_lead', 'spike', 'rise', 'ema_cross', 'ema_above', 'engulf',
  'mare_laggard', 'er', 'age_extreme', 'btc_dump', 'obi', 'tape', 'mare', 'vol_x',
  'queue', 'session', 'reclaim', 'fib', 'bb_squeeze', 'rsi_div', 'vwap_reclaim', 'funding_neg',
  'spread_snap', 'absorption', 'second_leg', 'listing', 'leader_lag', 'triple_low', 'hammer', 'opening_range',
  'grid', 'dca',
  'donchian', 'bb_rsi', 'accum', 'ema_trend', 'atr_break', 'zspread', 'rsi_momo', 'panic', 'chandelier', 'retest',
  'script',
]);

function validateRecipe(recipe) {
  const errors = [];
  if (!recipe || typeof recipe !== 'object') return { ok: false, errors: ['receita vazia'] };
  if (recipe.eval || recipe.js) errors.push('código executável não é aceito');
  if (recipe.code && recipe.plan?.kind !== 'js') errors.push('código executável não é aceito');
  const entry = recipe.entry || {};
  const all = Array.isArray(entry.all) ? entry.all : [];
  const any = Array.isArray(entry.any) ? entry.any : [];
  const filters = Array.isArray(recipe.filters) ? recipe.filters : [];
  if (!all.length && !any.length) errors.push('entrada sem gatilho');
  for (const op of [...all, ...any, ...filters]) {
    if (!op || !OPS.has(op.op)) errors.push(`primitivo fora do catálogo: ${op && op.op}`);
  }
  const exit = recipe.exit || {};
  const plan = recipe.plan || {};
  const relaxed = plan.kind === 'grid' || plan.kind === 'dca' || plan.kind === 'accum' || plan.trail || plan.noTarget || plan.exact;
  const stopPct = Number(exit.stopPct);
  const tpPct = Number(exit.tpPct);
  if (!(stopPct > 0)) errors.push('stopPct é obrigatório');
  if (!relaxed && !(tpPct > 0)) errors.push('tpPct é obrigatório');
  if (stopPct > 25) errors.push('stop acima de 25%');
  if (!relaxed) {
    const rr = netRR({ stopPct, tpPct });
    if (!rr.ok) errors.push(rr.reason);
    else if (rr.netRR < MIN_NET_RR - 1e-9) errors.push(`R:R líquido ${rr.netRR.toFixed(2)} < ${MIN_NET_RR}`);
  }
  const hold = Number(exit.maxHoldMin);
  if (!(hold >= 5 && hold <= 24 * 60)) errors.push('maxHoldMin entre 5 e 1440');
  if (!recipe.name || String(recipe.name).length < 3) errors.push('nome curto');
  const exp = recipe.explanation || {};
  const flat = exp.thesis ? exp : (exp['pt-BR'] || exp.en || Object.values(exp)[0] || {});
  if (!flat || !flat.thesis) errors.push('explicação obrigatória');
  const rr = relaxed ? null : netRR({ stopPct, tpPct });
  return { ok: errors.length === 0, errors, rr };
}

function publicUser(row) {
  const now = Date.now();
  const accessEnds = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : null;
  const google = !!row.google_sub;
  const verified = !!row.email_verified_at;
  const open = !!(accessEnds && accessEnds > now);
  let desk = 'locked';
  if (!verified) desk = 'unverified';
  else if (open && row.plan_status === 'active' && row.plan_tier === 'pro') desk = 'pro';
  else if (open && row.plan_status === 'active' && row.plan_tier === 'paper') desk = 'paper';
  else if (open) desk = 'trial';
  else desk = 'expired';
  const daysLeft = open ? Math.max(1, Math.ceil((accessEnds - now) / 86400000)) : 0;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone_e164,
    locale: row.locale,
    emailVerified: !!row.email_verified_at,
    phoneVerified: !!row.phone_verified_at,
    trialStartedAt: row.trial_started_at,
    trialEndsAt: row.trial_ends_at,
    accessEndsAt: row.trial_ends_at,
    planStatus: row.plan_status,
    planTier: row.plan_tier || null,
    cancelRequestedAt: row.cancel_requested_at || null,
    refundStatus: row.refund_status || 'none',
    daysLeft,
    expiring: open && daysLeft <= 5,
    desk,
    marePrefs: row.mare_prefs,
    hasGoogle: google,
    hasPassword: !!row.password_hash,
  };
}

function deskAllowed(user) {
  return user.desk === 'trial' || user.desk === 'paper' || user.desk === 'pro';
}

module.exports = {
  INITIAL,
  TAKER,
  MAKER,
  MIN_NET_RR,
  TRIAL_HOURS,
  TRIAL_PROMPT_LIMIT,
  LOCALES,
  OPS,
  id,
  sha256,
  brtDay,
  emptySnap,
  walletOf,
  netRR,
  sizeQuote,
  validateRecipe,
  publicUser,
  deskAllowed,
};
