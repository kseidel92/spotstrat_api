const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { validateRecipe, promptNumbers, brtDay, localeFamily } = require('./shared');
const { bars } = require('./faithful');

const DIR = path.join(__dirname, '../data/strategies');
const MARK = '\n// --- strategy ---\n';
const HEADER = [
  '// TradeAI. A API lê este arquivo e executa strategy(ctx) numa caixa fechada.',
  '// Não há cliente da Binance, nem rede, nem acesso ao sistema.',
  '// ctx.candles entrega só velas já fechadas. A última vela é o sinal.',
].join('\n');

const FORBIDDEN = /\b(require|import|process|global|globalThis|Function|eval|fetch|XMLHttpRequest|WebSocket|module|exports|__proto__|constructor|child_process|fs|while\s*\(\s*true|for\s*\(\s*;\s*;)\b/;

function finite(values) {
  return (values || []).filter((v) => v != null && Number.isFinite(v));
}

function asSeries(values) {
  const series = Array.from(values || []);
  series.valueOf = function valueOf() {
    for (let i = this.length - 1; i >= 0; i--) {
      if (this[i] != null && Number.isFinite(this[i])) return this[i];
    }
    return NaN;
  };
  series[Symbol.toPrimitive] = function toPrimitive(hint) {
    const n = this.valueOf();
    return hint === 'string' ? String(n) : n;
  };
  return series;
}

function series(values, period, calc) {
  const out = new Array(values.length).fill(null);
  if (!(period > 0)) return out;
  for (let i = period - 1; i < values.length; i++) {
    out[i] = calc(values, i);
  }
  return out;
}

function sma(values, period) {
  return asSeries(series(values, period, (src, i) => {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (src[j] == null || !Number.isFinite(src[j])) return null;
      sum += src[j];
    }
    return sum / period;
  }));
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!(period > 0) || values.length < period) return asSeries(out);
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) {
    if (!Number.isFinite(values[i])) return asSeries(out);
    sum += values[i];
  }
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    if (!Number.isFinite(values[i])) { prev = null; out[i] = null; continue; }
    prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return asSeries(out);
}

function rsi(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return asSeries(out);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (!Number.isFinite(d)) return asSeries(out);
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (!Number.isFinite(d)) { out[i] = null; continue; }
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return asSeries(out);
}

function atr(candles, period) {
  const high = candles.high || [];
  const low = candles.low || [];
  const close = candles.close || [];
  const out = new Array(close.length).fill(null);
  if (close.length <= period) return asSeries(out);
  const trs = [null];
  for (let i = 1; i < close.length; i++) {
    trs.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < close.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return asSeries(out);
}

function bb(values, period, mult) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  const m = Number(mult);
  for (let i = period - 1; i < values.length; i++) {
    if (mid[i] == null) continue;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = mid[i] + m * sd;
    lower[i] = mid[i] - m * sd;
  }
  return { mid: asSeries(mid), upper: asSeries(upper), lower: asSeries(lower) };
}

function macd(values, fast, slow, signal) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const macdLine = values.map((_, i) => (fastEma[i] == null || slowEma[i] == null ? null : fastEma[i] - slowEma[i]));
  const filled = macdLine.map((v) => (v == null ? 0 : v));
  const signalLine = ema(filled, signal).map((v, i) => (macdLine[i] == null ? null : v));
  const hist = macdLine.map((v, i) => (v == null || signalLine[i] == null ? null : v - signalLine[i]));
  return { macd: asSeries(macdLine), signal: asSeries(signalLine), hist: asSeries(hist) };
}

function stoch(candles, period, smooth) {
  const close = candles.close || [];
  const high = candles.high || [];
  const low = candles.low || [];
  const kRaw = close.map((c, i) => {
    if (i < period - 1 || c == null) return null;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j] < ll) ll = low[j];
    }
    if (!(hh > ll)) return 0;
    return ((c - ll) / (hh - ll)) * 100;
  });
  const d = sma(kRaw.map((v) => (v == null ? 0 : v)), smooth).map((v, i) => (kRaw[i] == null ? null : v));
  return { k: asSeries(kRaw), d: asSeries(d) };
}

function vwap(candles) {
  const out = new Array((candles.close || []).length).fill(null);
  let pv = 0;
  let vol = 0;
  let day = '';
  for (let i = 0; i < out.length; i++) {
    const stamp = new Date(candles.time[i] || 0).toISOString().slice(0, 10);
    if (stamp !== day) { day = stamp; pv = 0; vol = 0; }
    const typical = (candles.high[i] + candles.low[i] + candles.close[i]) / 3;
    const q = candles.volume[i] || 0;
    pv += typical * q;
    vol += q;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return asSeries(out);
}

function tail(values, n) {
  const list = finite(values).slice(-n);
  if (list.length < n) return null;
  return list;
}

function highest(values, n) {
  const list = tail(values, n);
  return list ? Math.max(...list) : null;
}

function lowest(values, n) {
  const list = tail(values, n);
  return list ? Math.min(...list) : null;
}

function at(values, index) {
  if (!values || !values.length) return null;
  const i = index < 0 ? values.length + index : index;
  const v = values[i];
  return v == null || !Number.isFinite(v) ? null : v;
}

function crossedUp(a, b) {
  const a0 = at(a, -1);
  const a1 = at(a, -2);
  const b0 = at(b, -1);
  const b1 = at(b, -2);
  if ([a0, a1, b0, b1].some((v) => v == null)) return false;
  return a1 <= b1 && a0 > b0;
}

function crossedDown(a, b) {
  const a0 = at(a, -1);
  const a1 = at(a, -2);
  const b0 = at(b, -1);
  const b1 = at(b, -2);
  if ([a0, a1, b0, b1].some((v) => v == null)) return false;
  return a1 >= b1 && a0 < b0;
}

const TF = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240 };

function copyBook(book) {
  if (!book) return { time: 0, bids: [], asks: [] };
  const side = (levels) => (levels || []).map((level) => ({ price: level.price, qty: level.qty }));
  return { time: book.t || 0, bids: side(book.bids), asks: side(book.asks) };
}

function packCandles(list) {
  const bars = list.map((k) => ({
    time: k.t != null ? k.t : k.time,
    open: k.o != null ? k.o : k.open,
    high: k.h != null ? k.h : k.high,
    low: k.l != null ? k.l : k.low,
    close: k.c != null ? k.c : k.close,
    volume: (k.v != null ? k.v : k.volume) || 0,
  }));
  bars.time = bars.map((bar) => bar.time);
  bars.open = bars.map((bar) => bar.open);
  bars.high = bars.map((bar) => bar.high);
  bars.low = bars.map((bar) => bar.low);
  bars.close = bars.map((bar) => bar.close);
  bars.volume = bars.map((bar) => bar.volume);
  bars.slice = function slice(start, end) {
    return packCandles(Array.prototype.slice.call(this, start, end));
  };
  return bars;
}

function makeCtx(row, now, position, memory) {
  const cache = new Map();
  return {
    symbol: row.symbol,
    price: row.price,
    now,
    pct24: row.pct24,
    open24: row.open24h || null,
    hourBrt() {
      return new Date(now - 3 * 3600 * 1000).getUTCHours();
    },
    dayBrt(time) {
      return brtDay(time == null ? now : time);
    },
    memory: memory && typeof memory === 'object' ? memory : {},
    position: position ? {
      side: position.side || 'long',
      entry: position.entry,
      qty: position.qty,
      openedAt: position.openedAt,
      highSince: position.high || position.entry,
      lowSince: position.low || position.entry,
      minutesHeld: (now - new Date(position.openedAt).getTime()) / 60000,
    } : null,
    trades(ms) {
      const windowMs = Number(ms) > 0 ? Number(ms) : 60000;
      const cutoff = now - windowMs;
      return (row.prints || []).filter((trade) => trade.t >= cutoff).map((trade) => ({
        time: trade.t,
        price: trade.price,
        qty: trade.qty,
        buyerMaker: !!trade.buyerMaker,
      }));
    },
    book() {
      return copyBook(row.book);
    },
    bookSnaps(ms) {
      const windowMs = Number(ms) > 0 ? Number(ms) : 60000;
      const cutoff = now - windowMs;
      return (row.bookSnaps || []).filter((snap) => snap.t >= cutoff).map(copyBook);
    },
    priceAgo(ms) {
      const windowMs = Number(ms);
      if (!(windowMs > 0)) return null;
      const target = now - windowMs;
      const list = row.prices || [];
      let past = null;
      for (const point of list) {
        if (point.t <= target) past = point;
        else break;
      }
      if (past) return past.p;
      const candles = bars(row, 1);
      let close = null;
      for (const candle of candles) {
        if (candle.t <= target) close = candle.c;
        else break;
      }
      return close > 0 ? close : null;
    },
    candles(tf) {
      const key = String(tf || '1m');
      if (cache.has(key)) return cache.get(key);
      const minutes = TF[key];
      if (!minutes) throw new Error(`tempo desconhecido: ${key}`);
      const packed = packCandles(bars(row, minutes));
      cache.set(key, packed);
      return packed;
    },
    sma, ema, rsi, atr, bb, macd, stoch, vwap, highest, lowest, at, crossedUp, crossedDown,
  };
}

function guard(code) {
  const text = String(code || '');
  if (text.length < 20) return 'O código da estratégia veio vazio.';
  if (text.length > 20000) return 'O código passou de 20000 caracteres.';
  if (!/function\s+strategy\s*\(/.test(text)) return 'O código precisa definir function strategy(ctx).';
  if (FORBIDDEN.test(text)) return 'O código tentou sair da estratégia. Só vale a conta dentro de strategy(ctx).';
  return '';
}

const scriptCache = new Map();

function runCode(code, ctx) {
  const problem = guard(code);
  if (problem) throw new Error(problem);
  let script = scriptCache.get(code);
  if (!script) {
    script = new vm.Script(`"use strict";\n${code}\nstrategy(ctx);`, { filename: 'strategy.js' });
    scriptCache.set(code, script);
  }
  const sandbox = { ctx, Math, Number, Boolean, isFinite, isNaN };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const result = script.runInContext(context, { timeout: 100 });
  if (!result || typeof result !== 'object') throw new Error('strategy(ctx) precisa devolver um objeto');
  const action = String(result.action || '');
  if (!['buy', 'sell', 'hold', 'short', 'close', 'alert'].includes(action)) throw new Error(`ação inválida: ${action || 'vazia'}`);
  return {
    action: action === 'close' ? 'sell' : action,
    stop: Number(result.stop) || 0,
    target: Number(result.target) || 0,
    fraction: Number(result.fraction) || 0,
  };
}

function fixtureRow(count, tfMin) {
  const klines = [];
  const htf = { 15: [], 60: [], 240: [] };
  for (let i = 0; i < count; i++) {
    const c = 100 + Math.sin(i / 6) * 2 + i * 0.05;
    const bar = { t: i * tfMin * 60000, o: c - 0.2, h: c + 0.8, l: c - 0.8, c, v: 100 + (i % 7) * 10, closed: true };
    if (tfMin === 1) klines.push(bar);
    else htf[tfMin].push(bar);
  }
  if (tfMin !== 1) {
    for (let i = 0; i < 240; i++) {
      const c = 100 + i * 0.01;
      klines.push({ t: i * 60000, o: c, h: c + 0.1, l: c - 0.1, c, v: 10, closed: true });
    }
  }
  const now = 120 * 3600000;
  const bids = Array.from({ length: 10 }, (_, i) => ({ price: 100 - i * 0.1, qty: 3 }));
  const asks = Array.from({ length: 10 }, (_, i) => ({ price: 100.1 + i * 0.1, qty: 1 }));
  return {
    symbol: 'TESTUSDT',
    price: 110,
    pct24: 1,
    open24h: 100,
    klines,
    htf,
    prints: [
      { t: now - 20000, price: 100, qty: 4, buyerMaker: true },
      { t: now - 10000, price: 100.05, qty: 1, buyerMaker: false },
    ],
    book: { t: now, bids, asks },
    bookSnaps: [{ t: now - 5000, bids, asks }],
    prices: [{ t: now - 60000, p: 100 }, { t: now, p: 110 }],
  };
}

function validateCode(code) {
  const problem = guard(code);
  if (problem) return { ok: false, error: problem };
  const cases = [
    { row: fixtureRow(120, 60), position: null },
    { row: fixtureRow(80, 15), position: null },
    { row: fixtureRow(30, 1), position: null },
    {
      row: fixtureRow(120, 60),
      position: { side: 'long', entry: 100, qty: 1, openedAt: new Date(0).toISOString(), high: 112, low: 99 },
    },
  ];
  for (const item of cases) {
    try {
      runCode(code, makeCtx(item.row, 120 * 3600000, item.position));
    } catch (err) {
      const message = err.message || String(err);
      return { ok: false, error: message.includes('Script execution timed out') ? 'A estratégia entrou em loop.' : message };
    }
  }
  return { ok: true };
}

function mentionsDuration(text) {
  const body = String(text || '');
  return /\b(?:horas?|minutos?|mins?|segundos?|segs?|dias?|hours?|minutes?|seconds?|secs?|days?|heures?|secondes?|jours?|stunden?|minuten|sekunden|tage?|días?)\b|\d\s*h\b|分|時間|秒/i.test(body);
}

function related(scriptNum, promptNum) {
  const opts = [
    promptNum,
    promptNum + 1,
    promptNum / 100,
    promptNum * 60,
    promptNum * 3600,
    promptNum * 1000,
    promptNum * 60000,
    promptNum * 3600000,
    promptNum * 86400000,
    1 - promptNum / 100,
    1 + promptNum / 100,
  ];
  return opts.some((v) => Math.abs(v - scriptNum) < 1e-6);
}

function defaultNumbers(defaults, locale) {
  return (defaults || []).flatMap((item) => promptNumbers(item.value, locale));
}

function foreignNumberAsk(foreign, locale) {
  const list = foreign.join(', ');
  const family = localeFamily(locale);
  if (family === 'en') return `The number ${list} is not in the request. Rewrite the condition with the quantity the person wrote. A minimum of bars may be that quantity plus one. Do not raise the quantity and do not invent another number.`;
  if (family === 'es') return `El número ${list} no está en el pedido. Reescribe la condición con la cantidad que la persona escribió. Un mínimo de velas puede ser esa cantidad más uno. No aumentes la cantidad y no inventes otro número.`;
  if (family === 'fr') return `Le nombre ${list} n'est pas dans la demande. Réécris la condition avec la quantité écrite. Un minimum de bougies peut être cette quantité plus un. N'augmente pas la quantité et n'invente pas un autre nombre.`;
  if (family === 'de') return `Die Zahl ${list} steht nicht in der Anfrage. Schreibe die Bedingung mit der genannten Menge. Ein Minimum an Kerzen darf diese Menge plus eins sein. Erhöhe die Menge nicht und erfinde keine andere Zahl.`;
  if (family === 'ja') return `数値 ${list} は依頼にありません。書かれた数量で条件を書き直してください。足切りの本数はその数量に1を足した数までです。数量を増やさず、別の数値を作らないでください。`;
  return `O número ${list} não está no pedido. Reescreva a condição com a quantidade que a pessoa escreveu. Um mínimo de velas pode ser essa quantidade mais um. Não aumente a quantidade da condição e não invente outro número.`;
}

function missingNumberAsk(label, locale) {
  const family = localeFamily(locale);
  if (family === 'en') return `The request does not define ${label}. What is the number?`;
  if (family === 'es') return `El pedido no define ${label}. ¿Cuál es el número?`;
  if (family === 'fr') return `La demande ne définit pas ${label}. Quel est le nombre ?`;
  if (family === 'de') return `Die Anfrage nennt ${label} nicht. Wie lautet die Zahl?`;
  if (family === 'ja') return `依頼に${label}がありません。数値はいくつですか？`;
  return `O pedido não define ${label}. Qual é o número?`;
}

function lengthGuards(code) {
  return [...String(code).matchAll(/\.length\s*(?:<|>|<=|>=)\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
}

function impliedExitDefaults(userText) {
  const stop = namedExitPct(userText, 'stop');
  const target = namedExitPct(userText, 'target');
  const out = [];
  if (stop == null && target != null) out.push(DEFAULT_STOP_PCT);
  if (target == null && stop != null) out.push(DEFAULT_TARGET_PCT);
  if (stop == null && target == null && /\bstop\b/i.test(exitSection(userText)) && /\b(?:alvo|target)\b/i.test(exitSection(userText))) {
    out.push(DEFAULT_STOP_PCT, DEFAULT_TARGET_PCT);
  }
  return out;
}

/** Números padrão do produto quando o pedido é qualitativo (média de volume, local, volatilidade). */
function impliedEntryDefaults(userText) {
  const body = String(userText || '');
  const out = [];
  const volChunk = (body.match(/volume[\s\S]{0,100}/i) || [''])[0];
  if (/volume.{0,80}(?:acima da m[eé]dia|maior que a m[eé]dia|acima da media)/i.test(body)
    && !/m[eé]dia(?:\s+(?:de|das?|dos?))?\s+\d+/i.test(volChunk)) {
    const bars = body.match(/(?:pelo menos|faixa de|(?:[uú]ltimas?))\s+(\d+)\s+(?:candles?|velas?)/i);
    out.push(bars ? Number(bars[1]) : 20);
  }
  if (/(?:m[ií]nima|m[aá]xima) local/i.test(body)
    && !/(?:m[ií]nima|m[aá]xima) local[^\n\d]{0,40}\d+/i.test(body)) {
    out.push(20);
  }
  if (/(?:volatilidade|contra[cç][aã]o de volatilidade)/i.test(body)
    && !/\bATR\s*\(\s*\d+/i.test(body)
    && !/(?:limite|threshold)[^\n\d]{0,20}\d+(?:[.,]\d+)?/i.test(body)) {
    out.push(14, 20);
  }
  return out;
}

function checkNumbers(code, userText, defaults, locale) {
  const prompts = [
    ...promptNumbers(userText, locale),
    ...defaultNumbers(defaults, locale),
    ...impliedExitDefaults(userText),
    ...impliedEntryDefaults(userText),
  ];
  const guards = new Set(lengthGuards(code));
  const used = [...String(code).matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const free = new Set([0, 1, 2, 100, 1000]);
  if (mentionsDuration(userText)) {
    free.add(60);
    free.add(3600);
  }
  const foreign = [...new Set(used.filter((n) => {
    if (free.has(n) || prompts.some((p) => related(n, p))) return false;
    return !(guards.has(n) && prompts.some((p) => n >= p && n <= p + 2));
  }))];
  if (foreign.length) {
    return {
      ok: false,
      error: foreignNumberAsk(foreign, locale),
    };
  }
  return { ok: true };
}

function questionsOf(data) {
  const raw = Array.isArray(data.questions) ? data.questions : [];
  const list = raw.map((item) => String(item || '').trim()).filter((item) => item.length > 2);
  const ask = String(data.ask || '').trim();
  if (!list.length && ask) return [ask];
  return list.slice(0, 6);
}

function defaultsOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    label: String(item?.label || item?.name || '').slice(0, 80),
    value: String(item?.value ?? '').slice(0, 40),
  })).filter((item) => item.label && item.value).slice(0, 8);
}

const NOTIFY_REFUSAL = /n[aã]o envi\w*|n[aã]o toc\w*|sem acesso|n[aã]o tem acesso|n[aã]o notifica|rede nem|n[aã]o consigo|s[oó] registra|devolve hold|ctx\.memory/i;

function cleanAlarmText(text, fallback) {
  const parts = String(text || '').split(/(?<=[.!?])\s+/).filter((part) => part.trim() && !NOTIFY_REFUSAL.test(part));
  const joined = parts.join(' ').trim();
  return joined || fallback;
}

function signalsAlarm(code) {
  return /action\s*:\s*["'](?:alert|buy|short)["']/.test(String(code || ''));
}

function codeHasNumber(code, n) {
  return promptNumbers(code, 'en').some((value) => Math.abs(value - n) < 1e-6);
}

function sourceLine(text) {
  const match = String(text || '').match(/^Fontes(?:\s+dispon[ií]veis[^:]*):\s*(.+)$/im)
    || String(text || '').match(/^Fontes:\s*(.+)$/im);
  return match ? match[1] : '';
}

/** Texto da regra sem a linha Fontes e sem avisos de laboratório que citam livro/tape como ausentes. */
function ruleProse(text) {
  let body = String(text || '');
  body = body.replace(/^Fontes(?:\s+dispon[ií]veis[^:]*):.*$/gim, '');
  body = body.replace(/^Fontes:.*$/gim, '');
  body = body.replace(/[^.!\n]*(?:arquivo de 18 meses|esse arquivo [eé] s[oó] de velas)[^.!\n]*(?:livro|tape)[^.!\n]*[.!]?/gi, '');
  body = body.replace(/[^.!\n]*\bn[aã]o tem livro[^.!\n]*[.!]?/gi, '');
  body = body.replace(/[^.!\n]*\bsem livro[^.!\n]*[.!]?/gi, '');
  return body;
}

function describesBook(prose) {
  return /(?:\blivro\b|faixas do livro|primeiras(?:\s+\w+)?\s+faixas|desequil[ií]brio(?:\s+(?:comprador|vendedor|do\s+livro))?|ctx\.book|\bbids?\b|\basks?\b)/i.test(prose);
}

function describesTrades(prose) {
  return /(?:trades?\s+agressiv|agress[aã]o(?:\s+compradora)?|aggTrades?|\btape\b|saldo (?:de )?trades|neg[oó]cios agressivos|fluxo(?:\s+de)?\s+agress|saldo comprador de trades)/i.test(prose);
}

function describesAverages(prose) {
  const cleaned = String(prose || '').replace(/pre[cç]o m[eé]dio/gi, '');
  return /(?:\bvwap\b|\brsi\b|\bsma\b|\bema\b|m[eé]dia(?:\s+m[oó]vel)?(?:\s+de\s+\d+)?|m[eé]dia das|acima da m[eé]dia|abaixo da m[eé]dia)/i.test(cleaned);
}

function returnAsk(code, userText) {
  if (!/voltar at[eé]\s+\d/i.test(String(userText || ''))) return '';
  const src = String(code || '');
  const names = [...src.matchAll(/(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*Math\.abs\s*\(/g)].map((m) => m[1]);
  const compares = (op) => {
    const direct = new RegExp(`Math\\.abs\\s*\\([\\s\\S]{0,180}\\)\\s*(?:\\/\\s*[\\w.]+)?\\s*${op}`).test(src);
    const named = names.some((name) => new RegExp(`\\b${name}\\b\\s*${op}`).test(src));
    return direct || named;
  };
  if (compares('>') && compares('<=')) return '';
  return 'Voltar até a porcentagem pedida só conta depois que o preço esteve mais longe que essa porcentagem. Grave essa saída em ctx.memory. Use Math.abs(preço - nível) / nível, maior que a porcentagem para a saída e menor ou igual para a volta. A vela que gravou o nível não é a volta. A compra continua na confirmação posterior que o pedido descreveu.';
}

function regionAsk(code, userText) {
  const body = String(userText || '');
  const touch = body.match(/pelo menos\s+(\d+|dois|duas|tr[eê]s|quatro|cinco)\s+vezes/i);
  const bars = body.match(/[uú]ltimas\s+(\d+)\s+velas/i);
  if (!touch || !bars) return '';
  const words = { dois: 2, duas: 2, tres: 3, três: 3, quatro: 4, cinco: 5 };
  const times = /^\d+$/.test(touch[1]) ? Number(touch[1]) : words[touch[1].toLowerCase()];
  const window = Number(bars[1]);
  if (!(times > 0) || !(window > 0)) return '';
  const src = String(code || '');
  const mentionsWindow = new RegExp(`\\b${window}\\b`).test(src) || new RegExp(`\\b${window + 1}\\b`).test(src);
  const mentionsTimes = new RegExp(`\\b${times}\\b`).test(src);
  const excludesSignal = /slice\(\s*0\s*,\s*-1\s*\)/.test(src) || new RegExp(`slice\\(\\s*-${window + 1}\\s*,\\s*-1\\s*\\)`).test(src);
  const countsSignal = new RegExp(`slice\\(\\s*-${window}\\s*\\)`).test(src) && !excludesSignal;
  if (mentionsWindow && mentionsTimes && !countsSignal) return '';
  return `O suporte já está definido: região testada pelo menos ${times} vezes nas últimas ${window} velas anteriores ao candle do sinal. O nível é a ${times}ª mínima mais baixa dessas velas anteriores. O candle do sinal está na região quando a mínima dele alcança esse nível. Use ${times} e ${window}. Não conte o próprio sinal entre os testes e não invente distância em porcentagem.`;
}

function originCandleAsk(code, userText) {
  const body = String(userText || '');
  if (!/registrar|grave|grava/i.test(body)) return '';
  const src = String(code || '');
  const wipesAll = /Object\.keys\s*\(/.test(src) && /delete\s+/.test(src);
  const keeps = /!==?\s*['"](?:used|done|seen|origins|originTimes)['"]/.test(src) || /\.(?:used|done|seen|origins|originTimes)\s*=/.test(src);
  if (!wipesAll || keeps) return '';
  return 'Não apague o time da vela que originou o nível. Guarde esse time numa lista ctx.memory.done que sobrevive ao prazo, ao cancelamento e à compra. A mesma vela não grava de novo.';
}

function bookCoverageAsk(code, userText) {
  const prose = ruleProse(userText);
  if (!describesBook(prose)) return '';
  if (/ctx\.book\s*\(/.test(String(code || ''))) return '';
  return 'O pedido descreve uma condição de livro. Leia ctx.book() e aplique essa condição, com os números que já estão no pedido. Não troque stop, alvo nem o gatilho.';
}

function tradesCoverageAsk(code, userText) {
  const prose = ruleProse(userText);
  if (!describesTrades(prose)) return '';
  if (/ctx\.trades\s*\(/.test(String(code || ''))) return '';
  return 'O pedido descreve trades agressivos. Leia ctx.trades na janela que o texto deu e aplique essa comparação. Não troque stop, alvo nem o gatilho.';
}

function averagesCoverageAsk(code, userText) {
  const prose = ruleProse(userText);
  if (!describesAverages(prose)) return '';
  if (/ctx\.(sma|ema|vwap|rsi)\s*\(/.test(String(code || ''))) return '';
  return 'O pedido cita média, VWAP ou RSI. Use ctx.sma, ctx.ema, ctx.vwap ou ctx.rsi com os períodos escritos. Não troque stop, alvo nem o gatilho.';
}

function reversalAsk(code, userText) {
  if (!/revers[aã]o bullish|candle de revers[aã]o|vela de revers[aã]o|pin bar bullish/i.test(String(userText || ''))) return '';
  const src = String(code || '');
  const lowerVsBody = /Math\.min\s*\(\s*[\w.]+\.(?:open|close)\s*,\s*[\w.]+\.(?:open|close)\s*\)\s*-\s*[\w.]+\.low/.test(src)
    || /[\w.]+\.low[\s\S]{0,120}(?:body|Math\.abs\s*\(\s*[\w.]+\.close\s*-\s*[\w.]+\.open)/.test(src)
    || /(?:body|Math\.abs\s*\(\s*[\w.]+\.close\s*-\s*[\w.]+\.open)[\s\S]{0,120}[\w.]+\.low/.test(src);
  const upperBound = /Math\.max\s*\(\s*[\w.]+\.(?:open|close)\s*,\s*[\w.]+\.(?:open|close)\s*\)/.test(src)
    || /[\w.]+\.high[\s\S]{0,80}(?:body|Math\.abs)/.test(src)
    || /(?:body|Math\.abs)[\s\S]{0,80}[\w.]+\.high/.test(src);
  if (lowerVsBody && upperBound) return '';
  return 'Candle de reversão bullish não é qualquer vela verde. Sem outro padrão no pedido, o pavio inferior tem pelo menos o tamanho do corpo, o pavio superior é menor que o corpo, e o fechamento fica acima da abertura. Corpo = Math.abs(close - open). Pavio inferior = Math.min(open, close) - low. Pavio superior = high - Math.max(open, close).';
}

function persistAggressionAsk(code, userText) {
  const body = String(userText || '');
  const entry = body.split(/\nSa[ií]da:/i)[0];
  const match = entry.match(/por pelo menos\s+(\d+)\s+segundos?/i)
    || entry.match(/(?:agress[aã]o|saldo comprador|press[aã]o compradora).{0,80}?\bpor\s+(\d+)\s+segundos?/i);
  if (!match) return '';
  const sec = Number(match[1]);
  if (!(sec > 0)) return '';
  const src = String(code || '');
  if (!/ctx\.trades\s*\(/.test(src)) {
    return `A agressão por pelo menos ${sec} segundos usa ctx.trades. Grave em ctx.memory o instante em que o saldo líquido ficou comprador e só registre quando essa condição durar ${sec} * 1000 milissegundos. Exemplo: if (liquido > 0) { if (m.since == null) m.since = ctx.now; } else delete m.since; if (m.since != null && ctx.now - m.since >= ${sec} * 1000) { /* registra */ }`;
  }
  const tracksStart = /(?:memory|m)\.\w+/i.test(src)
    || /(?:memory|m)\[['\"][^'\"]+['\"]\]/i.test(src);
  const checksDuration = /ctx\.now\s*-/.test(src) && (
    new RegExp(`${sec}\\s*\\*\\s*1000`).test(src)
    || new RegExp(`\\b${sec * 1000}\\b`).test(src)
  );
  const clearsOnFail = /delete\s+/.test(src);
  if (tracksStart && checksDuration && clearsOnFail) return '';
  return `Agressão por pelo menos ${sec} segundos exige persistência. Grave em ctx.memory o instante em que o saldo líquido ficou comprador. Só registre o preço médio quando ctx.now - m.since >= ${sec} * 1000 (ou >= ${sec * 1000}). Se o saldo deixar de ser comprador, delete esse instante. Uma leitura única de ctx.trades(${sec} * 1000) com saldo positivo não prova ${sec} segundos.`;
}

function chosenExitAsk(code, options) {
  if (!options || options.guided) return '';
  const stop = Number(options.stopPct);
  const target = Number(options.tpPct);
  if (options.exit === 'manual' && stop > 0 && target > 0 && (!codeHasNumber(code, stop) || !codeHasNumber(code, target))) {
    return `O stop é ${stop}% e o alvo é ${target}% a partir da entrada. Escreva esses percentuais no buy.`;
  }
  const hold = Number(options.maxHoldMin);
  if (options.timeExit && options.time === 'manual' && hold > 0 && !codeHasNumber(code, hold)) {
    return `Feche a posição quando ctx.position.minutesHeld chegar a ${hold}.`;
  }
  return '';
}

const DEFAULT_STOP_PCT = 0.8;
const DEFAULT_TARGET_PCT = 1.2;

function exitSection(text) {
  const body = String(text || '');
  const match = body.match(/\nSa[ií]da:\s*([\s\S]*)$/i);
  return match ? match[1] : body;
}

function namedExitPct(text, kind) {
  const section = exitSection(text);
  if (kind === 'stop') {
    // Não atravessar "alvo": "vender no stop, no alvo de 1,8%" não conta o 1,8% como stop.
    const match = section.match(/\bstop\b(?:\s*(?:de|em|em\s+)?|\s+)(\d+(?:[.,]\d+)?)\s*%/i)
      || section.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:de\s+)?(?:abaixo[^\n%]{0,20})?\bstop\b/i);
    return match ? Number(String(match[1]).replace(',', '.')) : null;
  }
  const match = section.match(/\b(?:alvo|target|tp)\b(?:\s*(?:de|em)?|\s+)(\d+(?:[.,]\d+)?)\s*%/i)
    || section.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:de\s+)?\b(?:alvo|target|tp)\b/i)
    || section.match(/\bno alvo de\s+(\d+(?:[.,]\d+)?)\s*%/i);
  return match ? Number(String(match[1]).replace(',', '.')) : null;
}

/** Quando a saída cita stop/alvo sem % e o outro lado já tem número, completa com o padrão do produto. */
function partialExitDefaultAsk(question, userText) {
  const stop = namedExitPct(userText, 'stop');
  const target = namedExitPct(userText, 'target');
  const q = String(question || '');
  const asksStop = /\bstop\b/i.test(q);
  const asksTarget = /\b(?:alvo|target|retorno)\b/i.test(q);
  if (asksStop && stop == null && target != null) {
    return `O alvo ${target}% já está no pedido. O stop sem porcentagem usa o padrão ${DEFAULT_STOP_PCT}%. Escreva o código com stop ${DEFAULT_STOP_PCT}% e alvo ${target}%. Declare no thesis que o stop veio do padrão porque o pedido não deu esse número.`;
  }
  if (asksTarget && target == null && stop != null) {
    return `O stop ${stop}% já está no pedido. O alvo sem porcentagem usa o padrão ${DEFAULT_TARGET_PCT}%. Escreva o código com stop ${stop}% e alvo ${DEFAULT_TARGET_PCT}%. Declare no thesis que o alvo veio do padrão porque o pedido não deu esse número.`;
  }
  if (stop == null && target == null && /\bstop\b/i.test(exitSection(userText)) && /\b(?:alvo|target)\b/i.test(exitSection(userText))) {
    return `Stop e alvo sem porcentagem usam o padrão ${DEFAULT_STOP_PCT}% e ${DEFAULT_TARGET_PCT}%. Escreva o código com esses percentuais e declare no thesis.`;
  }
  return '';
}

function buildJsRecipe(data, userText, locale, options) {
  const ask = String(data.ask || '').trim();
  const questions = questionsOf(data);
  const defaults = defaultsOf(data.defaults);
  const code = String(data.code || '').replace(/^```(?:javascript|js)?\s*/i, '').replace(/```$/, '').trim();
  const refusal = /não consigo|ctx só traz|aggTrade|order book|laborat[oó]rio|expor no ctx|não vou inventar/i;
  if (!code && refusal.test(`${ask} ${questions.join(' ')}`)) {
    return { ask: 'Escreva function strategy(ctx) usando ctx.trades e ctx.book. Esses dados existem. Não recuse e não troque a regra por vela.', retry: true };
  }
  if (!code) {
    const question = questions[0] || ask || '';
    if (/dist[aâ]ncia/i.test(question) && /pelo menos\s+\S+\s+vezes/i.test(userText)) {
      const partial = partialExitDefaultAsk('stop', userText);
      if (partial) {
        return { ask: `O pedido já definiu o que é próximo e o suporte. Não peça distância. ${partial}`, retry: true };
      }
      return { ask: 'O pedido já definiu o que é próximo e o suporte. Não peça distância. Se o stop e o alvo em porcentagem não estiverem escritos, use o padrão 0,8% e 1,2%.', retry: true };
    }
    const partial = partialExitDefaultAsk(question, userText);
    if (partial && /\b(?:stop|alvo|target|retorno)\b/i.test(question)) {
      return { ask: partial, retry: true };
    }
    if (/m[eé]dia de volume|per[ií]odo.*volume|volume.*m[eé]dia|quantas velas.*volume/i.test(question) && /volume.{0,80}m[eé]dia|m[eé]dia.{0,40}volume/i.test(userText)) {
      const bars = userText.match(/(?:pelo menos|faixa de|(?:[uú]ltimas?))\s+(\d+)\s+(?:candles?|velas?)/i);
      const n = bars ? bars[1] : '20';
      return { ask: `Não pergunte o período da média de volume. Use exatamente ${n} velas na média de volume. Declare no thesis. Escreva o código.`, retry: true };
    }
    if (/(?:m[ií]nima|m[aá]xima) local|quantas velas/i.test(question) && /(?:m[ií]nima|m[aá]xima) local/i.test(userText)) {
      return { ask: 'Não pergunte quantas velas formam a mínima/máxima local. Use 20 velas do timeframe do sinal e declare no thesis. Escreva o código.', retry: true };
    }
    if (/limite.*volatilidade|volatilidade.*limite|valor limite/i.test(question) && /volatilidade|contra[cç][aã]o/i.test(userText)) {
      return { ask: 'Não pergunte o limite absoluto. Use ATR(14) abaixo da média do ATR das 20 velas anteriores no timeframe do sinal (5m se o texto citar 5m). Declare no thesis. Escreva o código.', retry: true };
    }
    return { ask: question || 'Não fechou o código da estratégia.', questions, retry: !questions.length };
  }
  if (defaults.length) {
    const missing = missingNumberAsk(defaults[0].label, locale);
    return { ask: missing, questions: [missing], retry: false };
  }
  const numbers = checkNumbers(code, userText, defaults, locale);
  if (!numbers.ok) return { ask: numbers.error, retry: true };
  const chosen = chosenExitAsk(code, options);
  if (chosen) return { ask: chosen, retry: true };
  const book = bookCoverageAsk(code, userText);
  if (book) return { ask: book, retry: true };
  const trades = tradesCoverageAsk(code, userText);
  if (trades) return { ask: trades, retry: true };
  const averages = averagesCoverageAsk(code, userText);
  if (averages) return { ask: averages, retry: true };
  const reversal = reversalAsk(code, userText);
  if (reversal) return { ask: reversal, retry: true };
  const persistAgg = persistAggressionAsk(code, userText);
  if (persistAgg) return { ask: persistAgg, retry: true };
  const returned = returnAsk(code, userText);
  if (returned) return { ask: returned, retry: true };
  const origin = originCandleAsk(code, userText);
  if (origin) return { ask: origin, retry: true };
  const region = regionAsk(code, userText);
  if (region) return { ask: region, retry: true };
  if (/pin bar bullish/i.test(userText) && !/close\s*>\s*[\w.]*open/.test(code)) {
    return { ask: 'O pin bar bullish fecha acima da abertura. Mantenha o pavio inferior e o suporte já definidos.', retry: true };
  }
  if (/fechar abaixo/i.test(userText) && /\.time\s*>\s*ctx\.position\.openedAt/.test(code)) {
    return { ask: 'A vela que fecha abaixo conta pelo instante de fechamento: time da vela mais a duração. A abertura pode ser anterior à entrada. Mantenha o resto.', retry: true };
  }
  const alarm = !!(options && options.alarm);
  if (alarm && !signalsAlarm(code)) {
    return {
      ask: 'Quando a condição for verdadeira, devolva { action: "alert", stop, target }. hold só quando ainda não aconteceu. O som e o e-mail o desk envia. Não escreva que o código não notifica.',
      retry: true,
    };
  }
  if (alarm) {
    const fallback = 'Quando a condição acontece, o aviso sai no som e no e-mail marcados. A ordem continua sua.';
    data.thesis = cleanAlarmText(data.thesis, fallback);
    data.entryText = cleanAlarmText(data.entryText, data.thesis);
    data.exitText = cleanAlarmText(data.exitText, 'A ordem continua sua.');
    data.risks = cleanAlarmText(data.risks, 'Paper. O aviso não abre ordem.');
  }
  const ran = validateCode(code);
  if (!ran.ok) return { ask: `O código quebrou na validação: ${ran.error}`, retry: true };
  const text = {
    thesis: String(data.thesis || 'Regra escrita pela IA e validada nos candles.'),
    entry: String(data.entryText || ''),
    exit: String(data.exitText || ''),
    filters: defaults.length
      ? `Completei: ${defaults.map((item) => `${item.label} ${item.value}`).join('; ')}. Dá para ajustar na conversa.`
      : 'A regra está no código da estratégia.',
    risks: `${String(data.risks || '')} Paper. O código rodou em candles de teste sem quebrar.`.trim(),
    paramsPlain: 'strategy(ctx)',
  };
  const name = String(data.name || 'Estratégia').slice(0, 80);
  const recipe = {
    name,
    explanation: { [locale || 'pt-BR']: text, en: text },
    entry: { all: [{ op: 'script' }], any: [] },
    filters: [],
    exit: { stopPct: 1, tpPct: 1, maxHoldMin: 1440, timeExit: false },
    pacing: { noRepeatMin: 15, stopCooldownMin: 30 },
    plan: { kind: 'js', exact: true },
    defaults,
    code,
  };
  const check = validateRecipe(recipe);
  if (!check.ok) return { ask: 'Não fechei a estratégia.', retry: true };
  return { recipe };
}

function writeStrategyFile(strategyId, code) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${strategyId}.js`), `${HEADER}${MARK}${code.trim()}\n`);
}

function readStrategyCode(strategyId, fallback) {
  if (!strategyId) return fallback;
  const file = path.join(DIR, `${strategyId}.js`);
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, 'utf8');
  const cut = text.split(MARK);
  return (cut[1] || fallback || '').trim();
}

function symbolMemory(snap, symbol) {
  if (!snap) return {};
  if (!snap.jsMemory || typeof snap.jsMemory !== 'object') snap.jsMemory = {};
  const current = snap.jsMemory[symbol];
  return current && typeof current === 'object' ? JSON.parse(JSON.stringify(current)) : {};
}

function keepMemory(snap, symbol, beforeJson, after) {
  if (!snap) return;
  const next = JSON.stringify(after || {});
  if (next === beforeJson || next.length > 4000) return;
  if (!snap.jsMemory) snap.jsMemory = {};
  snap.jsMemory[symbol] = JSON.parse(next);
  snap.touched = true;
}

function scanJs(strategy, hub, now, snap) {
  const code = readStrategyCode(strategy.id, strategy.recipe.code);
  const alarm = !!strategy.alarm;
  const scans = [];
  const hits = [];
  let best = null;
  for (const symbol of hub.tradeSymbols || []) {
    const row = hub.getSymbol(symbol);
    if (!row || !(row.price > 0)) continue;
    const memory = symbolMemory(snap, symbol);
    const beforeJson = JSON.stringify(memory);
    let result = null;
    try {
      const ctx = makeCtx(row, now, null, memory);
      result = runCode(code, ctx);
      keepMemory(snap, symbol, beforeJson, ctx.memory);
    } catch (err) {
      scans.push({ symbol, passed: 0, total: 1, checks: [{ op: 'js', pass: false, detail: err.message }] });
      continue;
    }
    const action = result.action;
    const ok = action === 'buy' || action === 'short' || (alarm && action === 'alert');
    scans.push({ symbol, passed: ok ? 1 : 0, total: 1, checks: [{ op: 'js', pass: ok, detail: ok ? action : 'sem entrada' }] });
    if (!ok) continue;
    if (!alarm && best) continue;
    const side = action === 'short' ? 'short' : 'long';
    const stopOk = !(result.stop > 0) || (side === 'short' ? result.stop > row.price : result.stop < row.price);
    const targetOk = !(result.target > 0) || (side === 'short' ? result.target < row.price : result.target > row.price);
    if (!alarm && (!stopOk || !targetOk)) continue;
    const hit = {
      symbol,
      entry: row.price,
      stop: result.stop > 0 ? result.stop : 0,
      tp: result.target > 0 ? result.target : null,
      side,
      noStop: !(result.stop > 0),
      noTarget: !(result.target > 0),
      quoteFrac: result.fraction > 0 && result.fraction <= 1 ? result.fraction : (result.stop > 0 ? 0 : 0.1),
      timeExit: false,
      maxHoldMin: 1440,
      noRepeatMin: 15,
      stopCooldownMin: 30,
      rule: 'js',
      reason: alarm ? 'condição do alarme' : 'código da estratégia',
    };
    if (alarm) hits.push(hit);
    else {
      best = hit;
      break;
    }
  }
  if (alarm) return { want: hits[0] || null, wants: hits, scan: scans.slice(0, 6) };
  return { want: best, scan: scans.slice(0, 6) };
}

function decideJs(strategy, row, position, price, now, snap) {
  const code = readStrategyCode(strategy.id, strategy.recipe.code);
  const memory = symbolMemory(snap, position.symbol);
  const beforeJson = JSON.stringify(memory);
  try {
    const ctx = makeCtx({ ...row, price }, now, position, memory);
    const result = runCode(code, ctx);
    keepMemory(snap, position.symbol, beforeJson, ctx.memory);
    if (result.action === 'sell') {
      const short = position.side === 'short';
      const win = short ? price <= position.entry : price >= position.entry;
      return { exit: win ? 'tp' : 'sl' };
    }
    return { exit: null };
  } catch (err) {
    return { exit: null, error: err.message };
  }
}

module.exports = {
  sma, ema, rsi, atr, bb, macd, stoch, vwap, highest, lowest, crossedUp,
  validateCode, checkNumbers, buildJsRecipe, writeStrategyFile, scanJs, decideJs, runCode, makeCtx,
  returnAsk, regionAsk, bookCoverageAsk, tradesCoverageAsk, averagesCoverageAsk, reversalAsk, persistAggressionAsk,
};
