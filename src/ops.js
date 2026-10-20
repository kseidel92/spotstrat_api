const { evalSpec } = require('./faithful');

function check(pass, detail) {
  return { pass: !!pass, detail };
}

function brt(now) {
  const d = new Date(now - 3 * 3600 * 1000);
  return {
    day: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    abs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()),
  };
}

function brtStamp(now, hour, minute) {
  const d = new Date(now - 3 * 3600 * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute) + 3 * 3600 * 1000;
}

function closed(bars) {
  return (bars || []).filter((k) => k.closed !== false && k.c > 0);
}

function barsSince(row, from, now) {
  return closed(row.klines).filter((k) => k.t >= from && k.t <= now);
}

function bucket(klines, tfMin, now) {
  const ms = tfMin * 60000;
  const buckets = [];
  for (const k of closed(klines)) {
    const t = Math.floor(Number(k.t) / ms) * ms;
    const last = buckets[buckets.length - 1];
    if (!last || last.t !== t) buckets.push({ t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v || k.q || 0 });
    else {
      if (k.h > last.h) last.h = k.h;
      if (k.l < last.l) last.l = k.l;
      last.c = k.c;
      last.v += k.v || k.q || 0;
    }
  }
  if (buckets.length && now) {
    const cur = Math.floor(now / ms) * ms;
    if (buckets[buckets.length - 1].t === cur) buckets.pop();
  }
  return buckets;
}

function greens(bars, n, minBodyPct) {
  const done = closed(bars);
  if (done.length < n) return false;
  return done.slice(-n).every((k) => k.c > k.o && ((k.c - k.o) / k.o) * 100 >= minBodyPct);
}

function ret(row, minutes, now) {
  const from = now - minutes * 60000;
  const bars = barsSince(row, from, now);
  const first = bars[0];
  if (!first || !(row.price > 0) || !(first.o > 0)) return null;
  return (row.price - first.o) / first.o;
}

function rsi(values, period) {
  if (!values || values.length <= period) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const out = new Array(period).fill(null);
  out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(0, d)) / period;
    loss = (loss * (period - 1) + Math.max(0, -d)) / period;
    out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  }
  return out;
}

function mem(ctx) {
  const memory = ctx.memory && typeof ctx.memory === 'object' ? ctx.memory : {};
  if (!memory.watch) memory.watch = {};
  if (!memory.loss) memory.loss = {};
  if (!memory.orb) memory.orb = {};
  ctx.memory = memory;
  return memory;
}

function evalExtra(op, ctx) {
  const { row, hub, now } = ctx;
  if (!row || !(row.price > 0)) return check(false, 'sem preço');
  if (op.op === 'queue') return evalQueue(op, ctx);
  if (op.op === 'session') return evalSession(op, now);
  if (op.op === 'reclaim') return evalReclaim(op, row, now);
  if (op.op === 'fib') return evalFib(op, ctx);
  if (op.op === 'bb_squeeze') return evalBb(op, row, now);
  if (op.op === 'rsi_div') return evalRsi(op, row, now);
  if (op.op === 'vwap_reclaim') return evalVwap(op, row, now);
  if (op.op === 'funding_neg') return evalFunding(op, row, hub);
  if (op.op === 'spread_snap') return evalSpread(op, row, now);
  if (op.op === 'absorption') return evalAbsorption(op, row, now);
  if (op.op === 'second_leg') return evalSecond(op, row, now);
  if (op.op === 'listing') return evalListing(op, row, hub, now);
  if (op.op === 'leader_lag') return evalLag(op, row, hub, now);
  if (op.op === 'triple_low') return evalTriple(op, row, now);
  if (op.op === 'hammer') return evalHammer(op, ctx);
  if (op.op === 'opening_range') return evalOrb(op, ctx);
  if (op.op === 'grid') return check(true, `grid ${op.levels || 8} níveis de ${op.stepPct || 1}%`);
  if (op.op === 'dca') return check(true, `compra a cada ${op.everyMin || 240} min`);
  const spec = evalSpec(op, ctx);
  if (spec) return spec;
  return null;
}

function evalQueue(op, ctx) {
  const { row, now } = ctx;
  const memory = mem(ctx);
  const holdMin = Number(op.holdMin) || 180;
  const dropPct = Number(op.dropPct) || 10;
  const pumpPct = Number(op.pumpPct) || 8;
  const pumpWindow = Number(op.pumpWindowMin) || 180;
  const greenN = Number(op.greenN) || 2;
  const key = row.symbol;
  const slot = memory.watch[key];
  if (slot && slot.until <= now) delete memory.watch[key];
  const live = memory.watch[key];
  const windowBars = barsSince(row, now - pumpWindow * 60000, now);
  let hi = -Infinity;
  let lo = Infinity;
  for (const k of windowBars) {
    if (k.h > hi) hi = k.h;
    if (k.l < lo) lo = k.l;
  }
  const pumped = hi > 0 && lo > 0 && ((hi - lo) / lo) * 100 >= pumpPct;
  const dropped = hi > 0 && ((hi - row.price) / hi) * 100 >= dropPct;
  if (!live && pumped && dropped) {
    memory.watch[key] = { until: now + holdMin * 60000, at: now };
  }
  const armed = memory.watch[key] && memory.watch[key].until > now;
  if (!armed) return check(false, pumped && dropped ? 'entrou na fila' : `fora da fila · queda ${hi > 0 ? (((hi - row.price) / hi) * 100).toFixed(1) : '?'}%`);
  const ok = greens(row.klines, greenN, Number(op.minBodyPct) || 0.02);
  const left = Math.max(0, Math.round((memory.watch[key].until - now) / 60000));
  return check(ok, ok ? `${greenN} verdes dentro da fila` : `na fila por mais ${left} min`);
}

function evalSession(op, now) {
  const clock = brt(now);
  const start = Number(op.startHour);
  const end = Number(op.endHour);
  const ok = clock.hour >= start && clock.hour < end;
  return check(ok, ok ? `dentro de ${start}h–${end}h Brasília` : `fora de ${start}h–${end}h Brasília`);
}

function evalReclaim(op, row, now) {
  const minutes = Number(op.windowMin) || 30;
  const done = closed(row.klines).filter((k) => k.t <= now);
  if (done.length < minutes + 1) return check(false, 'histórico curto para a mínima');
  const last = done[done.length - 1];
  const prev = done.slice(-(minutes + 1), -1);
  let lo = Infinity;
  for (const k of prev) if (k.l < lo) lo = k.l;
  const pierced = last.l < lo && last.c > lo;
  return check(pierced, pierced ? 'furou a mínima e fechou de volta' : 'sem retomada da mínima');
}

function evalFib(op, ctx) {
  const { row, hub, now } = ctx;
  const ranked = (hub.tradeSymbols || [])
    .map((symbol) => hub.getSymbol(symbol))
    .filter((item) => item && item.price > 0)
    .sort((a, b) => (b.pct24 || 0) - (a.pct24 || 0));
  const leader = ranked[0];
  if (!leader || leader.symbol !== row.symbol) return check(false, 'não é a que mais subiu em 24h');
  const hi = row.dayHigh;
  const lo = row.dayLow;
  if (!(hi > lo)) return check(false, 'sem máxima e mínima do dia');
  const range = hi - lo;
  const buy = hi - range * ((Number(op.level) || 38.2) / 100);
  const cancel = hi - range * ((Number(op.cancel) || 61.8) / 100);
  if (row.price <= cancel) return check(false, 'perdeu 61,8% e o sinal cancela');
  const band = buy * ((Number(op.bandPct) || 0.35) / 100);
  const ok = Math.abs(row.price - buy) <= band;
  return check(ok, ok ? 'no retrocesso de 38,2%' : `38,2% em ${buy.toFixed(4)}`);
}

function evalBb(op, row, now) {
  const tf = Number(op.tfMin) || 5;
  const period = Number(op.period) || 20;
  const candles = bucket(row.klines, tf, now);
  if (candles.length < period + 6) return check(false, 'Bollinger ainda curta');
  function band(slice) {
    const closes = slice.map((k) => k.c);
    const mid = closes.reduce((s, n) => s + n, 0) / closes.length;
    const variance = closes.reduce((s, n) => s + (n - mid) ** 2, 0) / closes.length;
    const sd = Math.sqrt(variance);
    return { mid, upper: mid + 2 * sd, lower: mid - 2 * sd, width: mid > 0 ? (4 * sd) / mid : 99 };
  }
  const narrowFor = Number(op.narrowMin) || 30;
  const narrowBars = Math.max(1, Math.round(narrowFor / tf));
  const maxWidth = Number(op.maxWidth) || 0.02;
  let narrow = true;
  for (let i = candles.length - 1 - narrowBars; i < candles.length - 1; i++) {
    if (i < period) {
      narrow = false;
      break;
    }
    if (band(candles.slice(i - period + 1, i + 1)).width > maxWidth) narrow = false;
  }
  const last = candles[candles.length - 1];
  const nowBand = band(candles.slice(-period));
  const prev = candles.slice(-1 - period, -1);
  const avg = prev.reduce((s, k) => s + (k.v || 0), 0) / Math.max(1, prev.length);
  const volOk = avg > 0 && (last.v || 0) >= avg * (Number(op.volX) || 3);
  const broke = last.c > nowBand.upper;
  const ok = narrow && broke && volOk;
  return check(ok, ok ? 'rompimento da Bollinger depois do squeeze' : 'sem squeeze com rompimento');
}

function evalRsi(op, row, now) {
  const tf = Number(op.tfMin) || 15;
  const period = Number(op.period) || 14;
  const candles = bucket(row.klines, tf, now);
  const closes = candles.map((k) => k.c);
  const series = rsi(closes, period);
  if (series.length < period + 5) return check(false, 'RSI ainda curto');
  const lows = [];
  for (let i = 2; i < candles.length - 1; i++) {
    if (candles[i].l <= candles[i - 1].l && candles[i].l <= candles[i + 1].l) {
      lows.push({ i, price: candles[i].l, rsi: series[i] });
    }
  }
  if (lows.length < 2) return check(false, 'sem dois fundos no RSI');
  const a = lows[lows.length - 2];
  const b = lows[lows.length - 1];
  const recent = candles.length - 1 - b.i <= 3;
  const ok = recent && b.price < a.price && b.rsi != null && a.rsi != null && b.rsi > a.rsi;
  return check(ok, ok ? 'divergência de alta no RSI' : 'sem divergência de RSI');
}

function evalVwap(op, row, now) {
  const clock = brt(now);
  const midnight = brtStamp(now, 0, 0);
  const bars = barsSince(row, midnight, now);
  if (bars.length < 30) return check(false, 'VWAP do dia ainda curto');
  let pv = 0;
  let vol = 0;
  const trail = [];
  for (const k of bars) {
    const typical = (k.h + k.l + k.c) / 3;
    const q = k.v || k.q || 0;
    pv += typical * q;
    vol += q;
    trail.push({ t: k.t, c: k.c, vwap: vol > 0 ? pv / vol : typical });
  }
  const vwap = trail[trail.length - 1].vwap;
  const belowMin = Number(op.belowMin) || 120;
  const tf = Number(op.tfMin) || 5;
  const end = trail[trail.length - 1].t;
  const prior = trail.filter((p) => p.t < end - tf * 60000 && p.t >= end - (belowMin + tf) * 60000);
  const wasBelow = prior.length >= belowMin * 0.8 && prior.every((p) => p.c < p.vwap);
  const candles = bucket(row.klines, tf, now);
  const last = candles[candles.length - 1];
  const reclaimed = last && last.c > vwap;
  const ok = wasBelow && reclaimed;
  return check(ok, ok ? 'fechou acima do VWAP depois de 2 horas abaixo' : 'sem retomada do VWAP');
}

function evalFunding(op, row, hub) {
  const rates = hub.fundingRates ? hub.fundingRates(row.symbol) : null;
  const n = Number(op.n) || 3;
  if (!rates || rates.length < n) return check(false, 'funding do perpétuo ainda não chegou');
  const last = rates.slice(-n);
  const ok = last.every((rate) => rate < 0);
  return check(ok, ok ? `${n} fundings negativos` : 'funding não está negativo');
}

function evalSpread(op, row, now) {
  const samples = (row.spreadSamples || []).filter((s) => s.t >= now - (Number(op.withinSec) || 20) * 1000);
  if (samples.length < 2) return check(false, 'spread ainda sem histórico');
  const high = Number(op.highPct) || 0.4;
  const low = Number(op.lowPct) || 0.08;
  const wide = samples.filter((s) => s.spreadPct >= high);
  const current = samples[samples.length - 1];
  const pulled = wide.length && current.spreadPct <= low && wide.some((s) => current.askQty < s.askQty);
  return check(pulled, pulled ? 'spread fechou e a parede de venda saiu' : 'sem estalo de spread');
}

function evalAbsorption(op, row, now) {
  const samples = row.tradeSamples || [];
  const window = (Number(op.windowMin) || 10) * 60000;
  const nowN = samples.length ? samples[samples.length - 1].n : null;
  const mid = [...samples].reverse().find((s) => s.t <= now - window);
  const prev = [...samples].reverse().find((s) => s.t <= now - window * 2);
  if (nowN == null || !mid || !prev) return check(false, 'contagem de negócios ainda curta');
  const recent = nowN - mid.n;
  const before = mid.n - prev.n;
  const busy = before > 0 && recent >= before * (Number(op.tradeX) || 2);
  const change = ret(row, Number(op.windowMin) || 10, now);
  const quiet = change != null && Math.abs(change) * 100 <= (Number(op.maxMovePct) || 0.15);
  const ok = busy && quiet;
  return check(ok, ok ? 'muitos negócios e preço parado' : 'sem absorção');
}

function swings(bars, minPct) {
  if (bars.length < 3) return [];
  const points = [];
  let dir = 0;
  let pivot = bars[0].c;
  let pivotT = bars[0].t;
  for (const k of bars) {
    const up = ((k.h - pivot) / pivot) * 100;
    const dn = ((pivot - k.l) / pivot) * 100;
    if (dir >= 0 && dn >= minPct) {
      points.push({ dir: 1, px: pivot, t: pivotT });
      dir = -1;
      pivot = k.l;
      pivotT = k.t;
    } else if (dir <= 0 && up >= minPct) {
      points.push({ dir: -1, px: pivot, t: pivotT });
      dir = 1;
      pivot = k.h;
      pivotT = k.t;
    } else if (dir >= 0 && k.h > pivot) {
      pivot = k.h;
      pivotT = k.t;
    } else if (dir <= 0 && k.l < pivot) {
      pivot = k.l;
      pivotT = k.t;
    }
  }
  return points;
}

function evalSecond(op, row, now) {
  const bars = barsSince(row, now - (Number(op.lookbackMin) || 180) * 60000, now);
  const points = swings(bars, Number(op.minSwingPct) || 0.8);
  const downs = points.filter((p) => p.dir === -1);
  if (downs.length < 2) return check(false, 'ainda não houve dois recuos');
  const first = downs[downs.length - 2];
  const second = downs[downs.length - 1];
  const prevHigh = points.filter((p) => p.dir === 1 && p.t < first.t).pop();
  const midHigh = points.filter((p) => p.dir === 1 && p.t > first.t && p.t < second.t).pop();
  if (!prevHigh || !midHigh) return check(false, 'os recuos não estão numa alta');
  const d1 = (prevHigh.px - first.px) / prevHigh.px;
  const d2 = (midHigh.px - second.px) / midHigh.px;
  const smaller = d2 > 0 && d2 < d1 && second.px > first.px;
  const turning = bars.length > 2 && bars[bars.length - 1].c > bars[bars.length - 2].c;
  const ok = smaller && turning;
  return check(ok, ok ? 'segundo recuo menor que o primeiro' : 'o segundo recuo não é menor');
}

function evalListing(op, row, hub, now) {
  const at = hub.listedAt ? hub.listedAt(row.symbol) : null;
  if (!at) return check(false, 'sem data de listagem');
  const ageH = (now - at) / 3600000;
  if (!(ageH >= 0 && ageH < (Number(op.maxHours) || 6))) return check(false, `listada há ${ageH.toFixed(1)} h`);
  const first = barsSince(row, at, at + 60 * 60000);
  if (first.length < 20) return check(false, 'primeira hora ainda incompleta');
  const hi = Math.max(...first.map((k) => k.h));
  const candles = bucket(row.klines, Number(op.tfMin) || 15, now);
  const last = candles.filter((k) => k.t >= at + 60 * 60000).pop();
  const ok = last && last.c > hi;
  return check(ok, ok ? 'fechou acima da máxima da primeira hora' : 'ainda não rompeu a primeira hora');
}

function evalLag(op, row, hub, now) {
  const leader = hub.getSymbol(op.leader || 'ETHUSDT');
  if (!leader) return check(false, 'ETH sem preço');
  const minutes = Number(op.windowMin) || 20;
  const lead = ret(leader, minutes, now);
  const self = ret(row, minutes, now);
  if (lead == null || self == null) return check(false, 'janela curta contra o ETH');
  const ok = lead * 100 >= (Number(op.leaderPct) || 1) && self * 100 < (Number(op.maxSelfPct) || 0.3);
  return check(ok, `ETH ${(lead * 100).toFixed(2)}% · moeda ${(self * 100).toFixed(2)}%`);
}

function evalTriple(op, row, now) {
  const bars = barsSince(row, now - (Number(op.lookbackMin) || 360) * 60000, now);
  if (bars.length < 40) return check(false, 'janela curta para três fundos');
  const lows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].l <= bars[i - 1].l && bars[i].l <= bars[i - 2].l && bars[i].l <= bars[i + 1].l && bars[i].l <= bars[i + 2].l) {
      const prev = lows[lows.length - 1];
      if (!prev || bars[i].t - prev.t >= 15 * 60000) lows.push(bars[i]);
    }
  }
  if (lows.length < 3) return check(false, 'não há três fundos separados');
  const trio = lows.slice(-3);
  const base = Math.min(...trio.map((k) => k.l));
  const gap = (Math.max(...trio.map((k) => k.l)) - base) / base * 100;
  const closeEnough = gap <= (Number(op.maxGapPct) || 0.4);
  const lighter = (trio[2].v || trio[2].q || 0) < (trio[0].v || trio[0].q || 0);
  let hi = -Infinity;
  for (const k of bars) {
    if (k.t >= trio[0].t && k.t <= trio[2].t && k.h > hi) hi = k.h;
  }
  const broke = row.price > hi;
  const ok = closeEnough && lighter && broke;
  return check(ok, ok ? 'rompeu o triplo fundo' : 'triplo fundo ainda não confirmou');
}

function evalHammer(op, ctx) {
  const { row, now } = ctx;
  const memory = mem(ctx);
  const ban = memory.loss?.[row.symbol];
  if (ban && ban.banUntil > now) {
    const left = Math.round((ban.banUntil - now) / 60000);
    return check(false, `moeda proibida por mais ${left} min`);
  }
  const candles = bucket(row.klines, Number(op.tfMin) || 5, now);
  const last = candles[candles.length - 1];
  if (!last) return check(false, 'sem candle de 5 min');
  const range = last.h - last.l;
  if (!(range > 0)) return check(false, 'candle sem faixa');
  const body = Math.abs(last.c - last.o);
  const lower = Math.min(last.o, last.c) - last.l;
  const upper = last.h - Math.max(last.o, last.c);
  const hammer = lower >= body * 2 && upper <= body && (last.c - last.l) / range >= 0.6;
  const dayLo = row.dayLow || last.l;
  const atLow = last.l <= dayLo * 1.003;
  const ok = hammer && atLow;
  return check(ok, ok ? 'martelo na mínima do dia' : 'sem martelo na mínima');
}

function evalOrb(op, ctx) {
  const { row, now } = ctx;
  const memory = mem(ctx);
  const hour = Number(op.hour);
  const start = brtStamp(now, hour, Number(op.minute) || 0);
  const rangeMin = Number(op.rangeMin) || 15;
  const validMin = Number(op.validMin) || 45;
  const clock = brt(now);
  if (now < start) return check(false, 'a sessão ainda não abriu');
  if (now > start + validMin * 60000) return check(false, 'os 45 minutos passaram sem rompimento');
  const range = barsSince(row, start, start + rangeMin * 60000 - 1);
  if (now < start + rangeMin * 60000 || range.length < Math.min(10, rangeMin)) return check(false, 'marcando a máxima e a mínima');
  const hi = Math.max(...range.map((k) => k.h));
  const after = barsSince(row, start + rangeMin * 60000, now);
  const broke = after.some((k) => k.c > hi);
  if (broke) memory.orb[row.symbol] = clock.day;
  return check(broke, broke ? 'fechou acima da máxima da abertura' : 'ainda dentro da abertura');
}

module.exports = { evalExtra, brt, brtStamp };
