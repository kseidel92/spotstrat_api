function check(pass, detail, extra) {
  return { pass: !!pass, detail, ...(extra || {}) };
}

function closedOf(list) {
  return (list || []).filter((k) => k && k.closed !== false && k.c > 0);
}

function bucket1m(klines, tfMin) {
  const ms = tfMin * 60000;
  const buckets = [];
  for (const k of closedOf(klines)) {
    const t = Math.floor(Number(k.t) / ms) * ms;
    const last = buckets[buckets.length - 1];
    if (!last || last.t !== t) buckets.push({ t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v || 0, closed: true });
    else {
      if (k.h > last.h) last.h = k.h;
      if (k.l < last.l) last.l = k.l;
      last.c = k.c;
      last.v += k.v || 0;
    }
  }
  return buckets;
}

function bars(row, tfMin) {
  if (!row) return [];
  const tf = Number(tfMin) || 1;
  if (tf <= 1) return closedOf(row.klines);
  const stored = row.htf && (row.htf[tf] || row.htf[String(tf)]);
  if (stored && stored.length) return closedOf(stored);
  return bucket1m(row.klines, tf);
}

function emaAligned(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period || period < 1) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsiAligned(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function bollAt(values, index, period, mult) {
  if (index < period - 1) return null;
  let sum = 0;
  for (let j = index - period + 1; j <= index; j++) sum += values[j];
  const mean = sum / period;
  let v = 0;
  for (let j = index - period + 1; j <= index; j++) v += (values[j] - mean) ** 2;
  const sd = Math.sqrt(v / period);
  return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd };
}

function atrValue(candles, period) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevC = candles[i - 1].c;
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prevC), Math.abs(cur.l - prevC)));
  }
  if (trs.length < period) return null;
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

function sampleStats(vals) {
  const n = vals.length;
  if (!n) return { mean: 0, sd: 0 };
  const mean = vals.reduce((s, v) => s + v, 0) / n;
  if (n < 2) return { mean, sd: 0 };
  const v = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return { mean, sd: Math.sqrt(v) };
}

function spreadSeries(ethBars, btcBars) {
  const btc = new Map(btcBars.map((k) => [k.t, k.c]));
  const out = [];
  for (const k of ethBars) {
    const c = btc.get(k.t);
    if (c > 0 && k.c > 0) out.push({ t: k.t, z: k.c / c });
  }
  return out;
}

function zNow(row, hub, period) {
  const eth = bars(row, 60);
  const btcRow = hub && hub.getSymbol ? hub.getSymbol('BTCUSDT') : null;
  const btc = bars(btcRow, 60);
  if (!eth.length || !btc.length) return null;
  const series = spreadSeries(eth, btc);
  if (series.length < period) return null;
  const window = series.slice(-period).map((p) => p.z);
  const { mean, sd } = sampleStats(window);
  if (!(sd > 0)) return null;
  const last = window[window.length - 1];
  return { z: (last - mean) / sd, mean, sd, last };
}

function evalDonchian(op, row) {
  const candles = bars(row, op.tfMin || 60);
  const n = Number(op.lookback) || 20;
  if (candles.length < n + 1) return check(false, 'histórico de 1h ainda curto');
  const last = candles[candles.length - 1];
  const prev = candles.slice(-(n + 1), -1);
  if (prev.length < n) return check(false, 'histórico de 1h ainda curto');
  const hi = Math.max(...prev.map((k) => k.h));
  const avgV = prev.reduce((s, k) => s + (k.v || 0), 0) / prev.length;
  const broke = last.c > hi;
  const volOk = avgV > 0 && last.v >= avgV * (Number(op.volX) || 1.5);
  const ok = broke && volOk;
  const stop = row.price * (1 - (Number(op.stopPct) || 3) / 100);
  return check(ok, ok ? 'fechou acima da máxima das 20 e o volume confirmou' : 'sem rompimento de fechamento com volume', ok ? { levels: { stop, tp: null } } : null);
}

function evalBbRsi(op, row) {
  const candles = bars(row, op.tfMin || 15);
  if (candles.length < 21) return check(false, 'histórico de 15m ainda curto');
  const closes = candles.map((k) => k.c);
  const i = closes.length - 1;
  const band = bollAt(closes, i, 20, 2);
  const rsi = rsiAligned(closes, 14);
  const last = candles[i];
  const ok = !!(band && last.c < band.lower && rsi[i] != null && rsi[i] < (Number(op.rsiLow) || 30));
  const stop = row.price * (1 - (Number(op.stopPct) || 2) / 100);
  return check(ok, ok ? 'fechou abaixo da banda inferior com RSI abaixo de 30' : 'banda e RSI ainda não fecharam juntos', ok ? { levels: { stop, tp: null } } : null);
}

function evalEmaTrend(op, row) {
  const candles = bars(row, op.tfMin || 60);
  const slowN = Number(op.slow) || 200;
  if (candles.length < slowN + 2) return check(false, 'EMA 200 espera o histórico de 1h');
  const closes = candles.map((k) => k.c);
  const fast = emaAligned(closes, Number(op.fast) || 9);
  const mid = emaAligned(closes, Number(op.mid) || 21);
  const slow = emaAligned(closes, slowN);
  const i = closes.length - 1;
  const cross = fast[i] != null && mid[i] != null && fast[i - 1] != null && mid[i - 1] != null
    && fast[i - 1] <= mid[i - 1] && fast[i] > mid[i];
  const above = slow[i] != null && closes[i] > slow[i];
  const ok = cross && above;
  const stop = row.price * (1 - (Number(op.stopPct) || 4) / 100);
  return check(ok, ok ? 'EMA 9 cruzou a 21 para cima com o preço acima da EMA 200' : 'cruzamento de 1h com filtro de 200 ainda não fechou', ok ? { levels: { stop, tp: null } } : null);
}

function evalAtr(op, row) {
  const candles = bars(row, op.tfMin || 5);
  if (candles.length < 16) return check(false, 'histórico de 5m curto para o ATR');
  const prev = candles[candles.length - 1];
  const atr = atrValue(candles, Number(op.period) || 14);
  if (!(atr > 0) || !(prev.c > 0)) return check(false, 'ATR indisponível');
  const atrPct = (atr / prev.c) * 100;
  const broke = row.price > prev.h;
  const hot = atrPct > (Number(op.minAtrPct) || 0.5);
  const ok = broke && hot;
  const entry = row.price;
  const stop = entry - atr * (Number(op.slMult) || 1);
  const tp = entry + atr * (Number(op.tpMult) || 1.5);
  return check(ok, ok ? `rompeu a máxima anterior com ATR ${atrPct.toFixed(2)}%` : 'sem rompimento ou ATR baixo', ok ? { levels: { stop, tp }, frozen: { atr } } : null);
}

function evalZ(op, ctx) {
  const { row, hub } = ctx;
  if (op.symbol && row.symbol !== op.symbol) return check(false, 'só o ETH');
  const z = zNow(row, hub, Number(op.period) || 50);
  if (!z) return check(false, 'spread ETH/BTC sem histórico');
  const ok = z.z <= (Number(op.entryZ) || -2);
  return check(ok, ok ? `spread ${z.z.toFixed(2)} desvios abaixo da média` : `spread em ${z.z.toFixed(2)} desvios`);
}

function evalRsiMomo(op, row) {
  const candles = bars(row, op.tfMin || 15);
  const back = Number(op.lookback) || 3;
  if (candles.length < 20 + back) return check(false, 'histórico de 15m curto');
  const closes = candles.map((k) => k.c);
  const rsi = rsiAligned(closes, 14);
  const i = closes.length - 1;
  const level = Number(op.level) || 50;
  const cross = rsi[i] != null && rsi[i - 1] != null && rsi[i - 1] <= level && rsi[i] > level;
  const up = closes[i] > closes[i - back];
  const ok = cross && up;
  const stop = row.price * (1 - (Number(op.stopPct) || 1.5) / 100);
  const tp = row.price * (1 + (Number(op.tpPct) || 2) / 100);
  return check(ok, ok ? 'RSI cruzou 50 para cima e o preço está acima de 3 candles' : 'sem cruzamento com variação positiva', ok ? { levels: { stop, tp } } : null);
}

function evalPanic(op, row) {
  const candles = bars(row, op.tfMin || 60);
  if (candles.length < 22) return check(false, 'histórico de 1h curto');
  const last = candles[candles.length - 1];
  const prev = candles.slice(-21, -1);
  const body = last.o > 0 ? (last.o - last.c) / last.o : 0;
  const down = last.c < last.o && body >= (Number(op.bodyPct) || 4) / 100;
  const avgV = prev.reduce((s, k) => s + (k.v || 0), 0) / prev.length;
  const vol = avgV > 0 && last.v >= avgV * (Number(op.volX) || 2);
  const closes = candles.map((k) => k.c);
  const rsi = rsiAligned(closes, 14);
  const rsiOk = rsi[rsi.length - 1] != null && rsi[rsi.length - 1] < (Number(op.rsiMax) || 25);
  const ok = down && vol && rsiOk;
  const stop = row.price * (1 - (Number(op.stopPct) || 3) / 100);
  return check(ok, ok ? 'candle de pânico no fechamento' : 'sem candle de corpo, volume e RSI juntos', ok ? { levels: { stop, tp: null } } : null);
}

function evalChandelier(op, row) {
  const candles = bars(row, op.tfMin || 240);
  const period = Number(op.ema) || 50;
  const look = Number(op.emaLookback) || 5;
  if (candles.length < period + look + 15) return check(false, 'histórico de 4h curto');
  const closes = candles.map((k) => k.c);
  const ema = emaAligned(closes, period);
  const i = closes.length - 1;
  const last = candles[i];
  const rising = ema[i] != null && ema[i - look] != null && ema[i] > ema[i - look];
  const above = last.c > ema[i];
  const atr = atrValue(candles, Number(op.atr) || 14);
  if (!(atr > 0)) return check(false, 'ATR de 4h indisponível');
  const high = Math.max(last.h, row.price);
  const stop = high - atr * (Number(op.atrMult) || 3);
  const ok = above && rising && stop < row.price;
  return check(ok, ok ? 'fechou acima da EMA 50 que está subindo' : 'filtro de tendência de 4h não fechou', ok ? { levels: { stop, tp: null }, frozen: { atr } } : null);
}

function evalRetest(op, ctx) {
  const { row } = ctx;
  const candles = bars(row, op.tfMin || 60);
  const memory = ctx.memory || {};
  if (!memory.retest) memory.retest = {};
  const window = Number(op.window) || 30;
  const wait = Number(op.retestBars) || 5;
  const state = memory.retest[row.symbol];
  if (state && state.phase === 'broke') {
    const after = candles.filter((k) => k.t > state.breakT);
    if (after.length > wait) {
      delete memory.retest[row.symbol];
      memory.touched = true;
      return check(false, 'retest expirou em 5 candles');
    }
    const candle = after[after.length - 1];
    if (!candle) return check(false, 'rompimento, esperando o retest');
    if (candle.l <= state.high && candle.c > state.high) {
      const amp = state.high - state.low;
      const levels = { stop: state.low, tp: state.high + amp };
      delete memory.retest[row.symbol];
      memory.touched = true;
      if (!(levels.stop < row.price && levels.tp > row.price)) return check(false, 'retest válido, mas o preço já passou do alvo ou do stop');
      return check(true, 'retest fechou acima da máxima do range', { levels, frozen: { high: state.high, low: state.low, amp } });
    }
    if (candle.l <= state.high && candle.c <= state.high) {
      delete memory.retest[row.symbol];
      memory.touched = true;
      return check(false, 'retest tocou e fechou abaixo, sem entrada');
    }
    return check(false, 'rompimento, esperando o retest');
  }
  if (candles.length < window + 1) return check(false, 'histórico de 1h curto para o range');
  const range = candles.slice(-(window + 1), -1);
  const last = candles[candles.length - 1];
  const hi = Math.max(...range.map((k) => k.h));
  const lo = Math.min(...range.map((k) => k.l));
  const denom = range[range.length - 1].c;
  const ampPct = denom > 0 ? ((hi - lo) / denom) * 100 : 100;
  if (ampPct > (Number(op.maxAmpPct) || 3)) return check(false, `range de ${ampPct.toFixed(1)}%`);
  if (last.c > hi) {
    memory.retest[row.symbol] = { phase: 'broke', high: hi, low: lo, breakT: last.t };
    memory.touched = true;
    return check(false, 'rompimento no fechamento, esperando o retest');
  }
  return check(false, 'range apertado, sem rompimento');
}

function evalSpec(op, ctx) {
  if (!op || !ctx?.row) return null;
  if (op.op === 'donchian') return evalDonchian(op, ctx.row);
  if (op.op === 'bb_rsi') return evalBbRsi(op, ctx.row);
  if (op.op === 'ema_trend') return evalEmaTrend(op, ctx.row);
  if (op.op === 'atr_break') return evalAtr(op, ctx.row);
  if (op.op === 'zspread') return evalZ(op, ctx);
  if (op.op === 'rsi_momo') return evalRsiMomo(op, ctx.row);
  if (op.op === 'panic') return evalPanic(op, ctx.row);
  if (op.op === 'chandelier') return evalChandelier(op, ctx.row);
  if (op.op === 'retest') return evalRetest(op, ctx);
  if (op.op === 'accum') return check(true, 'compras na queda forte, uma por candle');
  return null;
}

function candleClosedAfter(k, openedAt, tfMin) {
  return k.t + tfMin * 60000 > openedAt;
}

function applyExit(recipe, row, hub, position, price, now) {
  const plan = recipe?.plan;
  if (!plan || !position || !(price > 0)) return null;
  const opened = new Date(position.openedAt).getTime();
  if (plan.kind === 'donchian') {
    const candles = bars(row, plan.tfMin || 60);
    const prev = candles.slice(-(Number(plan.exitLookback) || 10));
    if (prev.length) {
      const lo = Math.min(...prev.map((k) => k.l));
      if (price <= lo) return 'sl';
    }
    if (price <= position.entry * (1 - (plan.stopPct || 3) / 100)) return 'sl';
    return null;
  }
  if (plan.kind === 'bb_rsi') {
    if (price <= position.entry * (1 - (plan.stopPct || 2) / 100)) return 'sl';
    const candles = bars(row, plan.tfMin || 15).filter((k) => candleClosedAfter(k, opened, plan.tfMin || 15));
    const last = candles[candles.length - 1];
    if (!last) return null;
    const all = bars(row, plan.tfMin || 15);
    const closes = all.map((k) => k.c);
    const band = bollAt(closes, closes.length - 1, 20, 2);
    const rsi = rsiAligned(closes, 14);
    const i = closes.length - 1;
    if (all[i] && all[i].t === last.t && band && (last.c > band.upper || (rsi[i] != null && rsi[i] > (plan.rsiHigh || 70)))) return price >= position.entry ? 'tp' : 'sl';
    return null;
  }
  if (plan.kind === 'ema_trend') {
    if (price <= position.entry * (1 - (plan.stopPct || 4) / 100)) return 'sl';
    const candles = bars(row, plan.tfMin || 60);
    if (candles.length < 3) return null;
    const last = candles[candles.length - 1];
    if (!candleClosedAfter(last, opened, plan.tfMin || 60)) return null;
    const closes = candles.map((k) => k.c);
    const fast = emaAligned(closes, plan.fast || 9);
    const mid = emaAligned(closes, plan.mid || 21);
    const i = closes.length - 1;
    if (fast[i] != null && mid[i] != null && fast[i - 1] != null && mid[i - 1] != null && fast[i - 1] >= mid[i - 1] && fast[i] < mid[i]) {
      return price >= position.entry ? 'tp' : 'sl';
    }
    return null;
  }
  if (plan.kind === 'zspread') {
    if (now - opened >= (plan.timeoutMin || 1440) * 60000) return 'time';
    const z = zNow(row, hub, plan.period || 50);
    if (!z) return null;
    if (z.z >= (plan.meanZ ?? 0)) return price >= position.entry ? 'tp' : 'sl';
    if (z.z <= (plan.stopZ ?? -4)) return 'sl';
    return null;
  }
  if (plan.kind === 'rsi_momo') {
    const candles = bars(row, plan.tfMin || 15);
    const last = candles[candles.length - 1];
    if (!last || !candleClosedAfter(last, opened, plan.tfMin || 15)) return null;
    const closes = candles.map((k) => k.c);
    const rsi = rsiAligned(closes, 14);
    const i = closes.length - 1;
    const level = plan.level || 50;
    if (rsi[i] != null && rsi[i - 1] != null && rsi[i - 1] >= level && rsi[i] < level) return price >= position.entry ? 'tp' : 'sl';
    return null;
  }
  if (plan.kind === 'panic') {
    if (price <= position.entry * (1 - (plan.stopPct || 3) / 100)) return 'sl';
    const tf = plan.tfMin || 60;
    const candles = bars(row, tf).filter((k) => candleClosedAfter(k, opened, tf));
    if (candles.length >= (plan.holdBars || 12)) return 'time';
    if (candles.some((k) => k.c > k.o)) return price >= position.entry ? 'tp' : 'sl';
    return null;
  }
  if (plan.kind === 'chandelier') {
    const candles = bars(row, plan.tfMin || 240);
    const atr = atrValue(candles, plan.atr || 14) || position.frozen?.atr;
    if (atr > 0) {
      let high = Math.max(position.entry, position.high || position.entry, price);
      for (const k of candles) {
        if (k.t + (plan.tfMin || 240) * 60000 >= opened && k.h > high) high = k.h;
      }
      position.high = high;
      const raw = high - atr * (plan.atrMult || 3);
      if (raw < price && raw > (position.stop || 0)) position.stop = raw;
    }
    if (position.stop > 0 && price <= position.stop) return 'sl';
    return null;
  }
  return null;
}

module.exports = { evalSpec, applyExit, bars };
