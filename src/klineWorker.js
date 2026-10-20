const { parentPort } = require('worker_threads');
const fs = require('fs');
const { fitFiles } = require('./fit');

const cache = new Map();

function aggregate(rows, ms) {
  const out = [];
  let cur = null;
  for (const k of rows) {
    const t = k[0];
    const bucket = Math.floor(t / ms) * ms;
    const o = +k[1];
    const h = +k[2];
    const l = +k[3];
    const c = +k[4];
    const v = +k[5];
    if (!cur || cur.time !== bucket / 1000) {
      if (cur) out.push(cur);
      cur = { time: bucket / 1000, open: o, high: h, low: l, close: c, volume: v };
    } else {
      if (h > cur.high) cur.high = h;
      if (l < cur.low) cur.low = l;
      cur.close = c;
      cur.volume += v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

parentPort.on('message', (msg) => {
  try {
    if (msg.type === 'fit') {
      const fit = fitFiles(msg.files, msg.spec, msg.opts || {});
      parentPort.postMessage({ id: msg.id, fit });
      return;
    }
    const { id, file, interval, limit } = msg;
    const ms = interval === '5m' ? 300000 : interval === '1m' ? 60000 : 3600000;
    const key = `${file}:${interval}`;
    let bars = cache.get(key);
    if (!bars) {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      bars = aggregate(rows, ms);
      cache.set(key, bars);
      if (cache.size > 4) cache.delete(cache.keys().next().value);
    }
    const sliced = limit ? bars.slice(-limit) : bars;
    parentPort.postMessage({ id, bars: sliced, total: bars.length });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, error: err.message });
  }
});
