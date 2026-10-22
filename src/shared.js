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

const ALARM_SOUND_KINDS = new Set(['bell', 'harsh', 'vintage', 'digital', 'gentle', 'burst', 'beep', 'distant']);
const ALARM_SOUND_LEGACY = { pulse: 'burst', chime: 'gentle', siren: 'harsh' };

const NUMBER_WORDS = {
  pt: [
    ['cem', 100], ['sessenta', 60], ['cinquenta', 50], ['quarenta', 40], ['trinta', 30], ['vinte', 20],
    ['quinze', 15], ['quatorze', 14], ['treze', 13], ['doze', 12], ['onze', 11], ['dez', 10],
    ['nove', 9], ['oito', 8], ['sete', 7], ['seis', 6], ['cinco', 5], ['quatro', 4],
    ['três', 3], ['tres', 3], ['duas', 2], ['dois', 2],
  ],
  en: [
    ['hundred', 100], ['sixty', 60], ['fifty', 50], ['forty', 40], ['thirty', 30], ['twenty', 20],
    ['fifteen', 15], ['twelve', 12], ['eleven', 11], ['ten', 10], ['nine', 9], ['eight', 8],
    ['seven', 7], ['six', 6], ['five', 5], ['four', 4], ['three', 3], ['two', 2],
  ],
  es: [
    ['cien', 100], ['sesenta', 60], ['cincuenta', 50], ['cuarenta', 40], ['treinta', 30], ['veinte', 20],
    ['quince', 15], ['catorce', 14], ['trece', 13], ['doce', 12], ['once', 11], ['diez', 10],
    ['nueve', 9], ['ocho', 8], ['siete', 7], ['seis', 6], ['cinco', 5], ['cuatro', 4], ['tres', 3], ['dos', 2],
  ],
  fr: [
    ['cent', 100], ['soixante', 60], ['cinquante', 50], ['quarante', 40], ['trente', 30], ['vingt', 20],
    ['quinze', 15], ['quatorze', 14], ['treize', 13], ['douze', 12], ['onze', 11], ['dix', 10],
    ['neuf', 9], ['huit', 8], ['sept', 7], ['six', 6], ['cinq', 5], ['quatre', 4], ['trois', 3], ['deux', 2],
  ],
  de: [
    ['hundert', 100], ['sechzig', 60], ['fünfzig', 50], ['fuenfzig', 50], ['vierzig', 40],
    ['dreißig', 30], ['dreissig', 30], ['zwanzig', 20], ['fünfzehn', 15], ['fuenfzehn', 15],
    ['zwölf', 12], ['zwoelf', 12], ['elf', 11], ['zehn', 10], ['neun', 9], ['acht', 8],
    ['sieben', 7], ['sechs', 6], ['fünf', 5], ['fuenf', 5], ['vier', 4], ['drei', 3], ['zwei', 2],
  ],
  ja: [
    ['九十', 90], ['八十', 80], ['七十', 70], ['六十', 60], ['五十', 50], ['四十', 40], ['三十', 30], ['二十', 20],
    ['十', 10], ['九', 9], ['八', 8], ['七', 7], ['六', 6], ['五', 5], ['四', 4], ['三', 3], ['二', 2],
  ],
};

function localeFamily(locale) {
  const loc = String(locale || 'pt-BR');
  if (/^pt/i.test(loc)) return 'pt';
  if (/^es/i.test(loc)) return 'es';
  if (/^fr/i.test(loc)) return 'fr';
  if (/^de/i.test(loc)) return 'de';
  if (/^ja/i.test(loc)) return 'ja';
  return 'en';
}

function decimalStyle(locale) {
  return /^(en|ja|es-MX)/i.test(String(locale || 'pt-BR')) ? 'dot' : 'comma';
}

function wordNumbers(text, locale) {
  const found = [];
  const lower = String(text || '').toLowerCase();
  const ja = localeFamily(locale) === 'ja';
  for (const [word, n] of NUMBER_WORDS[localeFamily(locale)] || []) {
    const re = ja
      ? new RegExp(`(?<![二三四五六七八九十])${word}(?:本|分|秒|回|個|(?![二三四五六七八九十]))`, 'u')
      : new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, 'u');
    if (re.test(lower)) found.push(n);
  }
  return found;
}

function promptNumbers(text, locale = 'pt-BR') {
  const collapsed = String(text || '')
    .replace(/QA\s*\d+/gi, ' ')
    .replace(/(\d)[\s\u00a0\u202f](?=\d{3}(?!\d))/g, '$1');
  const found = wordNumbers(collapsed, locale);
  const style = decimalStyle(locale);
  const re = style === 'dot'
    ? /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+/g
    : /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+|\d+\.\d+|\d+/g;
  for (const match of collapsed.matchAll(re)) {
    const raw = match[0];
    let n;
    if (style === 'dot' && /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) n = Number(raw.replace(/,/g, ''));
    else if (style === 'comma' && /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(raw)) n = Number(raw.replace(/\./g, '').replace(',', '.'));
    else if (raw.includes(',') && style === 'comma') n = Number(raw.replace(',', '.'));
    else n = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(n)) found.push(n);
  }
  return [...new Set(found)];
}

function alarmSoundKind(raw) {
  const id = ALARM_SOUND_LEGACY[raw] || raw;
  return ALARM_SOUND_KINDS.has(id) ? id : 'bell';
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
  alarmSoundKind,
  promptNumbers,
  localeFamily,
  decimalStyle,
};
