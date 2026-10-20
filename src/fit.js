const fs = require('fs');
const path = require('path');

const FEE = 0.00075;
const MIN_NET_RR = 1.15;
const MIN_N = 24;

function suggestTp(stopPct) {
  const stop = stopPct / 100;
  const need = MIN_NET_RR * (stop + FEE + FEE) + FEE + FEE;
  return Math.ceil(need * 1000) / 10;
}

function rrOk(stopPct, tpPct) {
  const stop = stopPct / 100;
  const tp = tpPct / 100;
  const gain = tp - FEE - FEE;
  const loss = stop + FEE + FEE;
  return gain > 0 && loss > 0 && gain / loss >= MIN_NET_RR - 1e-9;
}

function specFromRecipe(recipe) {
  const ops = [...(recipe?.entry?.all || []), ...(recipe?.entry?.any || [])];
  const engulf = ops.find((op) => op.op === 'engulf');
  if (engulf) return { kind: 'engulf', tfMin: clamp(Number(engulf.tfMin) || 15, 1, 240) };
  const cross = ops.find((op) => op.op === 'ema_cross');
  if (cross) return { kind: 'ema', tfMin: 1, fast: clamp(Number(cross.fast) || 9, 2, 200), slow: clamp(Number(cross.slow) || 21, 3, 400) };
  const above = ops.find((op) => op.op === 'ema_above');
  if (above) return { kind: 'above', tfMin: 1, period: clamp(Number(above.period) || 21, 2, 400) };
  const rise = ops.find((op) => op.op === 'rise');
  if (rise) return { kind: 'rise', tfMin: 1, lookback: clamp(Number(rise.windowMin) || 3, 1, 240), minPct: Number(rise.minPct) || 1 };
  const spike = ops.find((op) => op.op === 'spike');
  if (spike) return { kind: 'rise', tfMin: 1, lookback: 15, minPct: Number(spike.minRet15 || 0.03) * 100 };
  return null;
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function compact(rows, tfMin) {
  const ms = tfMin * 60000;
  const o = [];
  const h = [];
  const l = [];
  const c = [];
  let bucket = null;
  let cur = null;
  for (let i = 0; i < rows.length; i++) {
    const k = rows[i];
    const t = Math.floor(Number(k[0]) / ms) * ms;
    const ko = +k[1];
    const kh = +k[2];
    const kl = +k[3];
    const kc = +k[4];
    if (!(kc > 0)) continue;
    if (cur == null || t !== bucket) {
      if (cur) {
        o.push(cur.o); h.push(cur.h); l.push(cur.l); c.push(cur.c);
      }
      bucket = t;
      cur = { o: ko, h: kh, l: kl, c: kc };
    } else {
      if (kh > cur.h) cur.h = kh;
      if (kl < cur.l) cur.l = kl;
      cur.c = kc;
    }
  }
  if (cur) {
    o.push(cur.o); h.push(cur.h); l.push(cur.l); c.push(cur.c);
  }
  return { o, h, l, c };
}

function emaAt(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function findEntries(bars, spec) {
  const { o, h, l, c } = bars;
  const idx = [];
  if (spec.kind === 'engulf') {
    for (let i = 1; i < c.length - 2; i++) {
      const bear = c[i - 1] < o[i - 1];
      const bull = c[i] > o[i];
      const engulfs = o[i] <= Math.min(o[i - 1], c[i - 1]) && c[i] >= Math.max(o[i - 1], c[i - 1]);
      if (bear && bull && engulfs) idx.push(i);
    }
  } else if (spec.kind === 'ema') {
    const fast = emaAt(c, spec.fast);
    const slow = emaAt(c, spec.slow);
    for (let i = 1; i < c.length - 2; i++) {
      if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null) continue;
      if (fast[i - 1] <= slow[i - 1] && fast[i] > slow[i]) idx.push(i);
    }
  } else if (spec.kind === 'above') {
    const line = emaAt(c, spec.period);
    for (let i = 1; i < c.length - 2; i++) {
      if (line[i] == null || line[i - 1] == null) continue;
      if (c[i - 1] <= line[i - 1] && c[i] > line[i]) idx.push(i);
    }
  } else if (spec.kind === 'rise') {
    const back = spec.lookback;
    const min = spec.minPct / 100;
    for (let i = back; i < c.length - 2; i++) {
      const base = c[i - back];
      if (base > 0 && (c[i] - base) / base >= min - 1e-9) idx.push(i);
    }
  }
  if (idx.length > 3000) {
    const stride = Math.ceil(idx.length / 3000);
    return idx.filter((_, i) => i % stride === 0);
  }
  return idx;
}

function combosOf({ fitStop, fitHold, stopPct, tpPct, maxHoldMin, tfMin }) {
  const stops = fitStop ? [0.8, 1, 1.2, 1.6, 2, 2.5, 3.2, 4] : [Number(stopPct) || 1.2];
  const holds = fitHold ? [15, 30, 60, 120, 240, 480, 720] : [clamp(Number(maxHoldMin) || 60, 5, 1440)];
  const out = [];
  for (const stop of stops) {
    const tps = fitStop
      ? [...new Set([suggestTp(stop), Math.round(stop * 1.8 * 10) / 10, Math.round(stop * 2.5 * 10) / 10, Math.round(stop * 3.2 * 10) / 10])]
      : [Number(tpPct) || suggestTp(stop)];
    for (const tp of tps) {
      if (!rrOk(stop, tp)) continue;
      for (const hold of holds) {
        out.push({ stopPct: stop, tpPct: tp, maxHoldMin: hold, holdBars: Math.max(1, Math.round(hold / tfMin)) });
      }
    }
  }
  return out;
}

function scoreCombo(bars, entries, combo, stat) {
  const { h, l, c } = bars;
  const stopMul = 1 - combo.stopPct / 100;
  const tpMul = 1 + combo.tpPct / 100;
  for (let e = 0; e < entries.length; e++) {
    const i = entries[e];
    const last = i + combo.holdBars;
    if (last >= c.length) continue;
    const entry = c[i];
    if (!(entry > 0)) continue;
    const stopPx = entry * stopMul;
    const tpPx = entry * tpMul;
    let exitPx = c[last];
    let kind = 'time';
    for (let j = i + 1; j <= last; j++) {
      if (l[j] <= stopPx) { exitPx = stopPx; kind = 'sl'; break; }
      if (h[j] >= tpPx) { exitPx = tpPx; kind = 'tp'; break; }
    }
    stat.n += 1;
    stat.sum += ((exitPx - entry) / entry - FEE - FEE) * 100;
  }
}

function fitBars(list, spec, opts) {
  const grid = combosOf({ ...opts, tfMin: spec.tfMin });
  if (!grid.length) return { ok: false, reason: 'grid' };
  const stats = grid.map(() => ({ n: 0, sum: 0 }));
  const used = [];
  for (const item of list) {
    const entries = findEntries(item.bars, spec);
    if (!entries.length) continue;
    used.push(item.symbol);
    for (let k = 0; k < grid.length; k++) scoreCombo(item.bars, entries, grid[k], stats[k]);
  }
  let best = null;
  for (let k = 0; k < grid.length; k++) {
    const stat = stats[k];
    if (stat.n < MIN_N) continue;
    const avg = stat.sum / stat.n;
    if (!best || avg > best.avgPct) {
      best = { ...grid[k], n: stat.n, avgPct: avg };
    }
  }
  if (!best) return { ok: false, reason: 'few', symbols: used, tfMin: spec.tfMin };
  return {
    ok: true,
    stopPct: best.stopPct,
    tpPct: best.tpPct,
    maxHoldMin: best.maxHoldMin,
    n: best.n,
    avgPct: Number(best.avgPct.toFixed(3)),
    symbols: used,
    tfMin: spec.tfMin,
  };
}

function fitFiles(files, spec, opts) {
  const list = [];
  for (const file of files) {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bars = compact(rows, spec.tfMin);
    list.push({ symbol: path.basename(file).replace(/_1m\.json$/, ''), bars });
  }
  return fitBars(list, spec, opts);
}

module.exports = { specFromRecipe, fitBars, fitFiles, compact, suggestTp };
