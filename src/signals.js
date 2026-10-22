const { SKIP_TRADE } = require('./market');
const { netRR, MIN_NET_RR, TAKER, MAKER } = require('./shared');
const { evalExtra } = require('./ops');
const { scanScript } = require('./script');
const { scanJs } = require('./sandbox');

function klinesOf(row, minutes, now) {
  if (!row) return [];
  const from = now - minutes * 60 * 1000;
  return row.klines.filter((k) => k.t >= from);
}

function rangeOf(bars) {
  let hi = -Infinity;
  let lo = Infinity;
  for (const k of bars) {
    if (k.h > hi) hi = k.h;
    if (k.l < lo) lo = k.l;
  }
  return { hi, lo };
}

function posInRange(price, bars) {
  const { hi, lo } = rangeOf(bars);
  if (!(hi > lo)) return null;
  return { pos: (price - lo) / (hi - lo), hi, lo, rangePct: ((hi - lo) / lo) * 100 };
}

function closed(bars) {
  return bars.filter((k) => k.closed !== false);
}

function greens(bars, n, minBodyPct) {
  const done = closed(bars);
  if (done.length < n) return false;
  const last = done.slice(-n);
  return last.every((k) => {
    const body = ((k.c - k.o) / k.o) * 100;
    return k.c > k.o && body >= minBodyPct;
  });
}

function countTouches(bars, level, pct, sepMin, side) {
  const band = level * (pct / 100);
  let n = 0;
  let lastT = -1e15;
  const gap = sepMin * 60 * 1000;
  for (const k of bars) {
    const px = side === 'lo' ? k.l : k.h;
    const hit = side === 'lo' ? px <= level + band : px >= level - band;
    if (hit && k.t - lastT >= gap) {
      n += 1;
      lastT = k.t;
    }
  }
  return n;
}

function swingCount(bars, minSwingPct) {
  if (bars.length < 3) return 0;
  let dir = 0;
  let pivot = bars[0].c;
  let n = 0;
  for (const k of bars) {
    const up = ((k.h - pivot) / pivot) * 100;
    const dn = ((pivot - k.l) / pivot) * 100;
    if (dir >= 0 && dn >= minSwingPct) {
      n += 1;
      dir = -1;
      pivot = k.l;
    } else if (dir <= 0 && up >= minSwingPct) {
      n += 1;
      dir = 1;
      pivot = k.h;
    } else if (dir >= 0 && k.h > pivot) pivot = k.h;
    else if (dir <= 0 && k.l < pivot) pivot = k.l;
  }
  return n;
}

function efficiency(bars) {
  if (bars.length < 3) return null;
  let path = 0;
  for (let i = 1; i < bars.length; i++) path += Math.abs(bars[i].c - bars[i - 1].c);
  if (!(path > 0)) return null;
  return Math.abs(bars[bars.length - 1].c - bars[0].c) / path;
}

function ageOfLow(bars, now) {
  let lo = Infinity;
  let t = 0;
  for (const k of bars) {
    if (k.l < lo) {
      lo = k.l;
      t = k.t;
    }
  }
  return (now - t) / 60000;
}

function retOver(row, minutes, now) {
  const bars = klinesOf(row, minutes, now);
  if (!bars.length || !(row.price > 0)) return null;
  const first = bars[0].o || bars[0].c;
  if (!(first > 0)) return null;
  return (row.price - first) / first;
}

function volX(row, minutes, now) {
  const bars = klinesOf(row, Math.max(minutes * 4, 60), now);
  if (bars.length < 10) return null;
  const recent = bars.slice(-minutes);
  const prev = bars.slice(0, -minutes);
  if (!recent.length || !prev.length) return null;
  const avg = prev.reduce((s, k) => s + k.v, 0) / prev.length;
  const nowV = recent.reduce((s, k) => s + k.v, 0) / recent.length;
  if (!(avg > 0)) return null;
  return nowV / avg;
}

function atr5(row) {
  const bars = row.klines;
  if (bars.length < 30) return null;
  const fives = [];
  for (let i = 0; i + 5 <= bars.length; i += 5) {
    const slice = bars.slice(i, i + 5);
    fives.push({
      h: Math.max(...slice.map((k) => k.h)),
      l: Math.min(...slice.map((k) => k.l)),
      c: slice[slice.length - 1].c,
    });
  }
  if (fives.length < 15) return null;
  const trs = [];
  for (let i = 1; i < fives.length; i++) {
    const prev = fives[i - 1].c;
    const tr = Math.max(fives[i].h - fives[i].l, Math.abs(fives[i].h - prev), Math.abs(fives[i].l - prev));
    trs.push(tr);
  }
  const last = trs.slice(-14);
  return last.reduce((s, n) => s + n, 0) / last.length;
}

function emaSeries(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function emaLast(values, period) {
  const series = emaSeries(values, period);
  return series ? series[series.length - 1] : null;
}

function emaCross(values, fastN, slowN) {
  const fast = emaSeries(values, fastN);
  const slow = emaSeries(values, slowN);
  if (!fast || !slow || fast.length < 2 || slow.length < 2) return null;
  const f1 = fast[fast.length - 1];
  const f0 = fast[fast.length - 2];
  const s1 = slow[slow.length - 1];
  const s0 = slow[slow.length - 2];
  return { up: f0 <= s0 && f1 > s1, down: f0 >= s0 && f1 < s1 };
}

function check(pass, detail) {
  return { pass: !!pass, detail };
}

function evalOp(op, ctx) {
  const { row, hub, now, mare, rank } = ctx;
  const bars = klinesOf(row, op.lookbackMin || op.windowMin || 60, now);
  if (op.op === 'range_pos') {
    const r = posInRange(row.price, bars);
    if (!r) return check(false, 'faixa ainda curta');
    const ok = r.pos <= (op.maxPos ?? 0.2) && r.pos >= (op.minPos ?? 0);
    return check(ok, `posição na faixa ${(r.pos * 100).toFixed(0)}%`);
  }
  if (op.op === 'touches') {
    const r = posInRange(row.price, bars);
    if (!r) return check(false, 'sem faixa');
    const loN = countTouches(bars, r.lo, op.touchPct ?? 0.55, op.sepMin ?? 12, 'lo');
    const hiN = countTouches(bars, r.hi, op.touchPct ?? 0.55, op.sepMin ?? 12, 'hi');
    const ok = loN >= (op.minLo ?? 2) && hiN >= (op.minHi ?? 1);
    return check(ok, `toques piso ${loN}/${op.minLo ?? 2} teto ${hiN}/${op.minHi ?? 1}`);
  }
  if (op.op === 'swings') {
    const r = posInRange(row.price, bars);
    const swings = swingCount(bars, op.minSwingPct ?? 1.6);
    if (!r) return check(false, 'sem faixa');
    const ok = swings >= (op.minSwings ?? 6)
      && r.rangePct >= (op.minRangePct ?? 0)
      && r.rangePct <= (op.maxRangePct ?? 100)
      && r.pos <= (op.maxPos ?? 1);
    return check(ok, `${swings} viradas · faixa ${r.rangePct.toFixed(1)}%`);
  }
  if (op.op === 'dump') {
    const { hi } = rangeOf(bars.length ? bars : klinesOf(row, op.windowMin || 30, now));
    if (!(hi > 0)) return check(false, 'sem pico');
    const dump = ((hi - row.price) / hi) * 100;
    const left = dump;
    const ok = dump >= (op.minDumpPct ?? 10) && left >= (op.minLeftPct ?? 0);
    return check(ok, `queda ${dump.toFixed(1)}% do pico`);
  }
  if (op.op === 'rebound_green') {
    const ok = greens(row.klines, op.n || 1, op.minBodyPct ?? 0.05);
    return check(ok, ok ? `${op.n || 1} verde(s)` : 'sem vela verde fechada');
  }
  if (op.op === 'rs_lead') {
    const ok = rank && rank.excess >= (op.minExcess24 ?? 0) && rank.place <= (op.rankN ?? 3);
    return check(ok, rank ? `rank ${rank.place} excesso ${rank.excess.toFixed(2)}%` : 'sem rank');
  }
  if (op.op === 'spike') {
    const ret = retOver(row, 15, now);
    const vx = volX(row, 15, now);
    const ok = ret != null && ret >= (op.minRet15 ?? 0.03) && ret <= (op.maxRet15 ?? 0.1) && (vx == null || vx >= (op.minVolX ?? 1));
    return check(ok, ret == null ? 'sem 15 min' : `15 min ${(ret * 100).toFixed(2)}% vol ${vx ? vx.toFixed(1) : '?'}×`);
  }
  if (op.op === 'ema_cross' || op.op === 'ema_above') {
    const closes = (row.klines || []).filter((k) => k.closed !== false).map((k) => k.c).filter((n) => n > 0);
    if (op.op === 'ema_above') {
      const period = Math.max(2, Number(op.period) || 21);
      const line = emaLast(closes, period);
      const ok = line != null && row.price > line;
      return check(ok, line == null ? 'EMA ainda curta' : `preço ${ok ? 'acima' : 'abaixo'} da EMA ${period}`);
    }
    const fastN = Math.max(2, Number(op.fast) || 9);
    const slowN = Math.max(fastN + 1, Number(op.slow) || 21);
    const crossed = emaCross(closes, fastN, slowN);
    if (!crossed) return check(false, 'EMA ainda curta');
    const wantUp = (op.dir || 'up') !== 'down';
    const ok = wantUp ? crossed.up : crossed.down;
    return check(ok, ok ? `EMA ${fastN} cruzou EMA ${slowN}` : `EMA ${fastN}/${slowN} sem cruzamento`);
  }
  if (op.op === 'engulf') {
    const tfMin = Math.max(1, Number(op.tfMin) || 15);
    const candles = bucketCandles(row.klines, tfMin, now);
    const prev = candles[candles.length - 2];
    const last = candles[candles.length - 1];
    const bull = engulfBull(prev, last);
    const wantBull = (op.dir || 'bull') !== 'bear';
    const ok = wantBull ? bull : engulfBear(prev, last);
    return check(ok, ok ? `engulfing ${wantBull ? 'bullish' : 'bearish'} ${tfMin} min` : `sem engulfing de ${tfMin} min`);
  }
  if (op.op === 'rise') {
    const minutes = Math.max(1, Number(op.windowMin) || 3);
    const ret = retOver(row, minutes, now);
    let min = Number(op.minPct ?? op.minRisePct ?? 1);
    if (min > 0 && min < 0.2) min *= 100;
    const max = op.maxPct == null ? null : Number(op.maxPct);
    const ok = ret != null && ret * 100 >= min - 1e-9 && (max == null || ret * 100 <= max + 1e-9);
    return check(ok, ret == null ? `sem ${minutes} min` : `${minutes} min ${(ret * 100).toFixed(2)}%`);
  }
  if (op.op === 'mare_laggard') {
    const hi = row.high7d || row.dayHigh;
    if (!(hi > 0)) return check(false, 'máxima de 7d ainda carregando');
    const dd = (hi - row.price) / hi;
    return check(dd >= (op.minDd ?? 0.12), `drawdown ${(dd * 100).toFixed(1)}%`);
  }
  if (op.op === 'er') {
    const er = efficiency(bars);
    const ok = er != null && er >= (op.min ?? 0) && er <= (op.max ?? 1);
    return check(ok, er == null ? 'sem ER' : `ER ${er.toFixed(2)}`);
  }
  if (op.op === 'age_extreme') {
    const age = ageOfLow(bars, now);
    const ok = age >= (op.minAge ?? 0) && age <= (op.maxAge ?? 1e9);
    return check(ok, `fundo há ${age.toFixed(0)} min`);
  }
  if (op.op === 'btc_dump') {
    const btc = hub.btc();
    const ret = btc ? retOver(btc, op.windowMin || 5, now) : null;
    const drop = ret == null ? 0 : Math.max(0, -ret * 100);
    return check(ret == null || drop <= (op.maxDropPct ?? 6), `BTC ${drop.toFixed(2)}% na janela`);
  }
  if (op.op === 'obi') {
    const age = hub.obiAge(row.symbol, op.min ?? 0);
    const ok = row.obi != null && row.obi >= (op.min ?? 0) && (op.max == null || row.obi <= op.max) && age >= (op.persistSec ?? 0);
    return check(ok, row.obi == null ? 'livro ainda não chegou' : `OBI ${row.obi.toFixed(0)}% há ${age.toFixed(1)}s`);
  }
  if (op.op === 'tape') {
    const tape = hub.tapeFrac(row.symbol);
    const ok = tape.frac != null && tape.frac >= (op.min ?? 0) && (op.max == null || tape.frac <= op.max) && tape.prints >= (op.minPrints ?? 1);
    return check(ok, tape.frac == null ? 'tape vazio' : `taker ${(tape.frac * 100).toFixed(0)}% (${tape.prints})`);
  }
  if (op.op === 'mare') {
    return check(mareAllows(op.mode || 'any', mare), `maré ${mare.label}`);
  }
  if (op.op === 'vol_x') {
    const vx = volX(row, 5, now);
    return check(vx != null && vx >= (op.min ?? 1), vx == null ? 'sem volume' : `vol ${vx.toFixed(2)}×`);
  }
  const extra = evalExtra(op, ctx);
  if (extra) return extra;
  return check(false, `primitivo ${op.op} não existe`);
}

function mareAllows(mode, mare) {
  if (!mode || mode === 'any') return true;
  if (mode === 'good') return mare.label === 'BOA';
  if (mode === 'not_bad') return mare.label !== 'RUIM';
  if (mode === 'neutral') return mare.label === 'NEUTRA';
  if (mode === 'bad') return mare.label === 'RUIM';
  return true;
}

function ranks(hub) {
  const btc = hub.btc();
  const btcPct = btc ? btc.pct24 : 0;
  const rows = hub.tradeSymbols
    .map((symbol) => hub.getSymbol(symbol))
    .filter((row) => row && !SKIP_TRADE.has(row.symbol));
  const ordered = rows
    .map((row) => ({ symbol: row.symbol, excess: row.pct24 - btcPct }))
    .sort((a, b) => b.excess - a.excess);
  const map = new Map();
  ordered.forEach((row, i) => map.set(row.symbol, { ...row, place: i + 1 }));
  return map;
}

function levelsFromPct(price, stopPct, tpPct, side) {
  if (side === 'short') {
    return {
      stop: price * (1 + stopPct / 100),
      tp: price * (1 - tpPct / 100),
    };
  }
  return {
    stop: price * (1 - stopPct / 100),
    tp: price * (1 + tpPct / 100),
  };
}

function acceptLevels(price, stop, tp, side) {
  const stopPct = side === 'short' ? ((stop - price) / price) * 100 : ((price - stop) / price) * 100;
  const tpPct = side === 'short' ? ((price - tp) / price) * 100 : ((tp - price) / price) * 100;
  const rr = netRR({ stopPct, tpPct, feeIn: TAKER, feeOutTp: MAKER, feeOutSl: TAKER });
  return { stop, tp, stopPct, tpPct, rr };
}

function bucketCandles(klines, tfMin, now) {
  const ms = tfMin * 60000;
  const buckets = [];
  for (const k of klines || []) {
    if (k.closed === false || !(k.c > 0)) continue;
    const t = Math.floor(Number(k.t) / ms) * ms;
    const last = buckets[buckets.length - 1];
    if (!last || last.t !== t) buckets.push({ t, o: k.o, h: k.h, l: k.l, c: k.c });
    else {
      if (k.h > last.h) last.h = k.h;
      if (k.l < last.l) last.l = k.l;
      last.c = k.c;
    }
  }
  if (buckets.length && now) {
    const cur = Math.floor(now / ms) * ms;
    if (buckets[buckets.length - 1].t === cur) buckets.pop();
  }
  return buckets;
}

function engulfBull(a, b) {
  if (!a || !b) return false;
  return a.c < a.o && b.c > b.o && b.o <= Math.min(a.o, a.c) && b.c >= Math.max(a.o, a.c);
}

function engulfBear(a, b) {
  if (!a || !b) return false;
  return a.c > a.o && b.c < b.o && b.o >= Math.max(a.o, a.c) && b.c <= Math.min(a.o, a.c);
}

function decorateWant(recipe, want) {
  const plan = recipe.plan || {};
  want.side = plan.side || 'long';
  want.trail = plan.trail || null;
  want.pyramid = plan.pyramid || null;
  want.noTarget = !!plan.noTarget;
  want.until = plan.until || null;
  want.fraction = plan.fraction || 1;
  want.lock = plan.lock || null;
  want.noStop = !!plan.noStop;
  want.quoteFrac = plan.quoteFrac || want.quoteFrac || 0;
  want.rule = plan.kind || null;
  return want;
}

function scanRecipe(strategy, hub, mare, now, memory) {
  const recipe = strategy.recipe;
  const plan = recipe.plan || {};
  if (recipe.code && plan.kind === 'js') {
    const mareMode = strategy.mare_mode || strategy.mareMode || 'any';
    if (!mareAllows(mareMode, mare)) {
      return { want: null, scan: [{ symbol: '—', passed: 0, total: 1, checks: [{ op: 'mare', pass: false, detail: `maré ${mare.label} bloqueia ${mareMode}` }] }] };
    }
    const hit = scanJs(strategy, hub, now, memory);
    const filters = recipe.filters || [];
    if (!hit.want || !filters.length) return hit;
    const row = hub.getSymbol(hit.want.symbol);
    if (!row) return { ...hit, want: null };
    const checks = filters.map((op) => evalOp(op, { row, hub, now, mare }));
    if (checks.every((item) => item.pass)) return hit;
    return {
      ...hit,
      want: null,
      scan: [...(hit.scan || []), { symbol: hit.want.symbol, passed: 0, total: checks.length, checks }],
    };
  }
  if (recipe.script && plan.kind === 'script') return scanScript(recipe, hub, now, memory || {});
  if (plan.kind === 'grid' || plan.kind === 'dca' || plan.kind === 'accum') {
    return {
      want: null,
      scan: [{
        symbol: '—',
        passed: 1,
        total: 1,
        checks: [{
          op: plan.kind,
          pass: true,
          detail: plan.kind === 'grid' ? 'grid acompanha o preço' : plan.kind === 'accum' ? 'compras na queda, uma por candle' : 'compra no relógio',
        }],
      }],
    };
  }
  const mareMode = strategy.mare_mode || strategy.mareMode || 'any';
  if (!mareAllows(mareMode, mare)) {
    return { want: null, scan: [{ symbol: '—', passed: 0, total: 1, checks: [{ op: 'mare', pass: false, detail: `maré ${mare.label} bloqueia ${mareMode}` }] }] };
  }
  const rankMap = ranks(hub);
  const scans = [];
  let best = null;
  const symbols = plan.onlySymbol ? [plan.onlySymbol] : hub.tradeSymbols;
  for (const symbol of symbols) {
    const row = hub.getSymbol(symbol);
    if (!row || !(row.price > 0)) continue;
    if (!plan.onlySymbol && (row.klines || []).length < 20) continue;
    const ctx = { row, hub, now, mare, rank: rankMap.get(symbol), memory };
    const all = (recipe.entry.all || []).map((op) => ({ op: op.op, ...evalOp(op, ctx) }));
    const any = (recipe.entry.any || []).map((op) => ({ op: op.op, ...evalOp(op, ctx) }));
    const filters = (recipe.filters || []).map((op) => ({ op: op.op, ...evalOp(op, ctx) }));
    const allOk = all.every((c) => c.pass);
    const anyOk = any.length === 0 || any.some((c) => c.pass);
    const filOk = filters.every((c) => c.pass);
    const passed = all.filter((c) => c.pass).length + any.filter((c) => c.pass).length + filters.filter((c) => c.pass).length;
    const total = all.length + any.length + filters.length;
    const item = { symbol, passed, total, checks: [...all, ...any, ...filters] };
    scans.push(item);
    if (allOk && anyOk && filOk) {
      const side = plan.side || 'long';
      const hinted = [...all, ...any, ...filters].find((c) => c.levels);
      const relaxed = !!(plan.trail || plan.noTarget || plan.exact || plan.noStop);
      let stop = hinted?.levels?.stop;
      let tp = hinted?.levels?.tp;
      if (!(stop > 0)) {
        const lv = levelsFromPct(row.price, recipe.exit.stopPct, relaxed ? recipe.exit.stopPct : recipe.exit.tpPct, side);
        stop = plan.noStop ? 0 : lv.stop;
        tp = plan.noTarget || plan.noStop ? null : lv.tp;
      }
      if (plan.noTarget) tp = null;
      const stopOk = plan.noStop || (side === 'short' ? stop > row.price : stop > 0 && stop < row.price);
      const tpOk = plan.noTarget || plan.noStop || tp == null || (side === 'short' ? tp < row.price : tp > row.price);
      let rrOk = relaxed;
      if (!rrOk) {
        const acc = acceptLevels(row.price, stop, tp, side);
        rrOk = acc.rr.ok && acc.rr.netRR >= MIN_NET_RR - 1e-9;
        if (!rrOk) item.checks.push({ op: 'rr', pass: false, detail: acc.rr.reason || 'R:R' });
      }
      if (stopOk && tpOk && rrOk) {
        best = decorateWant(recipe, {
          symbol,
          entry: row.price,
          stop,
          tp,
          maxHoldMin: recipe.exit.maxHoldMin,
          timeExit: recipe.exit.timeExit !== false,
          noRepeatMin: recipe.pacing?.noRepeatMin ?? 360,
          stopCooldownMin: recipe.pacing?.stopCooldownMin ?? 60,
          reason: item.checks.map((c) => c.detail).join(' · '),
          quoteFrac: plan.quoteFrac || 0,
          frozen: hinted?.frozen || null,
        });
        break;
      }
      if (!stopOk || !tpOk) item.checks.push({ op: 'stop', pass: false, detail: 'stop ou alvo do lado errado' });
    }
  }
  scans.sort((a, b) => b.passed / Math.max(1, b.total) - a.passed / Math.max(1, a.total));
  return { want: best, scan: scans.slice(0, 6) };
}

function bookOk(hub, row, min, persist) {
  const age = hub.obiAge(row.symbol, min);
  return row.obi != null && row.obi >= min && age >= persist;
}

function scanPreset(strategy, hub, mare, now) {
  const p = strategy.params || {};
  const mareMode = strategy.mare_mode || strategy.mareMode || 'any';
  if (!mareAllows(mareMode, mare)) {
    return { want: null, scan: [{ symbol: '—', passed: 0, total: 1, checks: [{ op: 'mare', pass: false, detail: `maré ${mare.label} bloqueia ${mareMode}` }] }] };
  }
  const rankMap = ranks(hub);
  const scans = [];
  let best = null;
  for (const symbol of hub.tradeSymbols) {
    const row = hub.getSymbol(symbol);
    if (!row || !(row.price > 0)) continue;
    const checks = [];
    let stop = null;
    let tp = null;
    let maxHoldMin = p.maxHoldMin;
    let noRepeatMin = p.noRepeatMin ?? 360;
    let stopCooldownMin = p.stopCooldownMin ?? 60;
    let armPct = 0;

    if (strategy.type === 'oscila' && p.setup === 'toques') {
      const bars = klinesOf(row, p.lookbackMin, now);
      const r = posInRange(row.price, bars);
      const loN = r ? countTouches(bars, r.lo, p.touchPct, p.sepMin, 'lo') : 0;
      const hiN = r ? countTouches(bars, r.hi, p.touchPct, p.sepMin, 'hi') : 0;
      checks.push(check(r && r.rangePct >= p.minRangePct && r.rangePct <= p.maxRangePct, r ? `faixa ${r.rangePct.toFixed(1)}%` : 'sem faixa'));
      checks.push(check(r && r.pos <= p.maxPos && r.pos >= p.minPos, r ? `pos ${(r.pos * 100).toFixed(0)}%` : 'pos'));
      checks.push(check(loN >= p.minLo && hiN >= p.minHi, `toques ${loN}/${p.minLo} e ${hiN}/${p.minHi}`));
      checks.push(check(greens(row.klines, p.greenN, p.minBodyPct), 'vela verde'));
      checks.push(check(bookOk(hub, row, p.obiMin, p.obiPersist), row.obi == null ? 'livro aguardando' : `OBI ${row.obi.toFixed(0)}%`));
    } else if (strategy.type === 'oscila') {
      const bars = klinesOf(row, p.lookbackMin, now);
      const r = posInRange(row.price, bars);
      const swings = swingCount(bars, p.minSwingPct);
      const age = bars.length ? ageOfLow(bars, now) : 0;
      checks.push(check(swings >= p.minSwings, `${swings} viradas`));
      checks.push(check(r && r.rangePct >= p.minRangePct && r.rangePct <= p.maxRangePct, r ? `faixa ${r.rangePct.toFixed(1)}%` : 'faixa'));
      checks.push(check(r && r.pos <= p.maxPos, r ? `pos ${(r.pos * 100).toFixed(0)}%` : 'pos'));
      checks.push(check(age >= p.minAge && age <= p.maxAge, `fundo há ${age.toFixed(0)} min`));
      checks.push(check(greens(row.klines, p.greenN, p.minBodyPct), `${p.greenN} verdes`));
      checks.push(check(bookOk(hub, row, p.obiMin, p.obiPersist), row.obi == null ? 'livro aguardando' : `OBI ${row.obi.toFixed(0)}%`));
    } else if (strategy.type === 'rs_lead') {
      const rank = rankMap.get(symbol);
      const atr = atr5(row);
      checks.push(check(rank && rank.place <= p.rankN && rank.excess >= p.minExcess24, rank ? `#${rank.place} excesso ${rank.excess.toFixed(2)}%` : 'fora do rank'));
      checks.push(check(bookOk(hub, row, p.obiMin, p.obiPersist), row.obi == null ? 'livro aguardando' : `OBI ${row.obi.toFixed(0)}%`));
      if (atr && row.price) {
        stop = row.price - atr * p.atrMult;
        const risk = row.price - stop;
        tp = row.price + risk * p.rMult;
        const stopPct = (risk / row.price) * 100;
        const acc = acceptLevels(row.price, stop, tp);
        checks.push(check(stopPct <= p.maxStopPct && stop > 0, `stop ${stopPct.toFixed(2)}%`));
        checks.push(check(acc.rr.ok && acc.rr.netRR >= MIN_NET_RR, acc.rr.ok ? `R:R ${acc.rr.netRR.toFixed(2)}` : 'R:R'));
      } else {
        checks.push(check(false, 'ATR 5m ainda curto'));
      }
    } else if (strategy.type === 'dump_rebound') {
      const bars = klinesOf(row, p.windowMin, now);
      const { hi } = rangeOf(bars);
      const dump = hi > 0 ? ((hi - row.price) / hi) * 100 : 0;
      const btc = hub.btc();
      const btcRet = btc ? retOver(btc, p.windowMin, now) : 0;
      const tape = hub.tapeFrac(symbol);
      checks.push(check(dump >= p.minDumpPct && dump >= p.minLeftPct, `queda ${dump.toFixed(1)}%`));
      checks.push(check(btcRet == null || -btcRet * 100 <= p.maxBtcDumpPct, 'BTC na janela'));
      checks.push(check(bookOk(hub, row, p.obiMin, p.obiPersist), row.obi == null ? 'livro aguardando' : `OBI ${row.obi.toFixed(0)}%`));
      checks.push(check(tape.frac != null && tape.frac >= p.tapeMin, tape.frac == null ? 'tape vazio' : `taker ${(tape.frac * 100).toFixed(0)}%`));
      checks.push(check(greens(row.klines, p.greenN, p.minBodyPct), 'verde'));
    } else if (strategy.type === 'mare_fundo') {
      const hi = row.high7d || 0;
      const dd = hi > 0 ? (hi - row.price) / hi : 0;
      checks.push(check(hi > 0, hi > 0 ? '7d ok' : 'máxima de 7d carregando'));
      checks.push(check(dd >= p.minDd, `drawdown ${(dd * 100).toFixed(1)}%`));
      checks.push(check(bookOk(hub, row, p.obiMin, p.obiPersist), row.obi == null ? 'livro aguardando' : `OBI ${row.obi.toFixed(0)}%`));
    } else if (strategy.type === 'anomalia') {
      const ret = retOver(row, 15, now);
      const btc = hub.btc();
      const btcRet = btc ? retOver(btc, 15, now) : 0;
      const excess = ret != null && btcRet != null ? ret - btcRet : null;
      const vx = volX(row, 15, now);
      const tape = hub.tapeFrac(symbol);
      checks.push(check(ret != null && ret >= p.minRet15 && ret <= p.maxRet15, ret == null ? 'sem 15 min' : `15m ${(ret * 100).toFixed(2)}%`));
      checks.push(check(vx != null && vx >= p.minVolX, vx == null ? 'volume' : `vol ${vx.toFixed(1)}×`));
      checks.push(check(excess != null && excess >= p.minBtcExcess, excess == null ? 'vs BTC' : `excesso ${(excess * 100).toFixed(2)} pp`));
      checks.push(check(bookOk(hub, row, p.obiMin, p.obiPersist), row.obi == null ? 'livro aguardando' : `OBI ${row.obi.toFixed(0)}%`));
      checks.push(check(tape.frac != null && tape.frac >= p.tapeMin && tape.frac <= p.tapeMax, tape.frac == null ? 'tape' : `taker ${(tape.frac * 100).toFixed(0)}%`));
      armPct = p.armPct || 0;
    } else {
      checks.push(check(false, 'tipo sem avaliador'));
    }

    const passed = checks.filter((c) => c.pass).length;
    scans.push({ symbol, passed, total: checks.length, checks });
    if (passed === checks.length && checks.length) {
      if (stop == null) {
        const lv = levelsFromPct(row.price, p.stopPct, p.tpPct);
        stop = lv.stop;
        tp = lv.tp;
      }
      const candidate = {
        symbol,
        entry: row.price,
        stop,
        tp,
        maxHoldMin,
        noRepeatMin,
        stopCooldownMin,
        armPct,
        reason: checks.map((c) => c.detail).join(' · '),
      };
      if (!best) best = candidate;
      else if (strategy.type === 'rs_lead') {
        const place = rankMap.get(symbol);
        const have = rankMap.get(best.symbol);
        if (place && have && place.place < have.place) best = candidate;
      }
      if (strategy.type !== 'mare_fundo' && strategy.type !== 'rs_lead') break;
    }
  }
  if (strategy.type === 'mare_fundo' && scans.length) {
    scans.sort((a, b) => {
      const da = hub.getSymbol(a.symbol);
      const db = hub.getSymbol(b.symbol);
      const dda = da && da.high7d ? (da.high7d - da.price) / da.high7d : 0;
      const ddb = db && db.high7d ? (db.high7d - db.price) / db.high7d : 0;
      return ddb - dda;
    });
    const top = scans[0];
    if (!(top && top.passed === top.total)) best = null;
    else if (best && best.symbol !== top.symbol) {
      const row = hub.getSymbol(top.symbol);
      const lv = levelsFromPct(row.price, p.stopPct, p.tpPct);
      best = {
        symbol: top.symbol,
        entry: row.price,
        stop: lv.stop,
        tp: lv.tp,
        maxHoldMin: p.maxHoldMin,
        noRepeatMin: p.noRepeatMin,
        stopCooldownMin: p.stopCooldownMin,
        armPct: 0,
        reason: 'mais caída do universo com livro',
      };
    }
  } else {
    scans.sort((a, b) => b.passed / Math.max(1, b.total) - a.passed / Math.max(1, a.total));
  }
  return { want: best, scan: scans.slice(0, 6) };
}

function evaluateStrategy(strategy, hub, mare, memory) {
  const now = Date.now();
  if (strategy.type === 'recipe' && strategy.recipe) return scanRecipe(strategy, hub, mare, now, memory);
  return scanPreset(strategy, hub, mare, now);
}

module.exports = { evaluateStrategy, mareAllows };
