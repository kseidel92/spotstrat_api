const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { validateRecipe } = require('./shared');
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
    time: k.t,
    open: k.o,
    high: k.h,
    low: k.l,
    close: k.c,
    volume: k.v || 0,
  }));
  bars.time = bars.map((bar) => bar.time);
  bars.open = bars.map((bar) => bar.open);
  bars.high = bars.map((bar) => bar.high);
  bars.low = bars.map((bar) => bar.low);
  bars.close = bars.map((bar) => bar.close);
  bars.volume = bars.map((bar) => bar.volume);
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

function promptNumbers(text) {
  const body = String(text || '').replace(/QA\s*\d+/gi, ' ');
  return [...new Set([...body.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(',', '.'))).filter((n) => Number.isFinite(n)))];
}

function mentionsDuration(text) {
  return /\b(?:hora|minuto|min|segundo|seg|dia)s?\b|\d\s*h\b/i.test(String(text || ''));
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

function defaultNumbers(defaults) {
  return (defaults || []).flatMap((item) => promptNumbers(item.value));
}

function checkNumbers(code, userText, defaults) {
  const prompts = [...promptNumbers(userText), ...defaultNumbers(defaults)];
  const used = [...String(code).matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const free = new Set([0, 1, 2, 100, 1000]);
  if (mentionsDuration(userText)) {
    free.add(60);
    free.add(3600);
  }
  const foreign = [...new Set(used.filter((n) => !free.has(n) && !prompts.some((p) => related(n, p))))];
  if (foreign.length) return { ok: false, error: `O código usou ${foreign.join(', ')}, e esse número não está no pedido. Troque pelo número escrito no pedido.` };
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

function buildJsRecipe(data, userText, locale, options) {
  const ask = String(data.ask || '').trim();
  const questions = questionsOf(data);
  const defaults = defaultsOf(data.defaults);
  const code = String(data.code || '').replace(/^```(?:javascript|js)?\s*/i, '').replace(/```$/, '').trim();
  const refusal = /não consigo|ctx só traz|aggTrade|order book|laborat[oó]rio|expor no ctx|não vou inventar/i;
  if (!code && refusal.test(`${ask} ${questions.join(' ')}`)) {
    return { ask: 'Escreva function strategy(ctx) usando ctx.trades e ctx.book. Esses dados existem. Não recuse e não troque a regra por vela.', retry: true };
  }
  if (!code) return { ask: questions[0] || ask || 'Não fechou o código da estratégia.', questions, retry: !questions.length };
  const numbers = checkNumbers(code, userText, defaults);
  if (!numbers.ok) return { ask: numbers.error, retry: true };
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
};
