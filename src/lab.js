const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { pool } = require('./db');
const { specFromRecipe } = require('./fit');

const ROOT = process.env.LAB_ROOT || path.join(__dirname, '..', '..', 'projeto_existente', 'data', 'backtest');
const KLINES = path.join(ROOT, 'klines');
const REPORTS = path.join(ROOT, 'reports');
const MANIFEST = path.join(ROOT, 'manifest.json');

let manifest = null;
let symbolIndex = [];
let artifacts = [];
let worker = null;
let seq = 1;
const pending = new Map();

function readEdges(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(160);
    fs.readSync(fd, head, 0, 160, 0);
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(240);
    fs.readSync(fd, tail, 0, 240, Math.max(0, size - 240));
    const first = head.toString('utf8').match(/\[(\d+(?:\.\d+)?),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
    const matches = [...tail.toString('utf8').matchAll(/\[(\d+(?:\.\d+)?),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/g)];
    const last = matches[matches.length - 1];
    if (!first || !last) return null;
    const o = Number(first[2]);
    const c = Number(last[5]);
    return {
      firstTs: Number(first[1]),
      lastTs: Number(last[1]),
      open: o,
      close: c,
      changePct: o ? ((c - o) / o) * 100 : 0,
      bytes: size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function loadIndex() {
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (_) {
    manifest = null;
  }
  if (!fs.existsSync(KLINES)) {
    symbolIndex = [];
    return;
  }
  symbolIndex = fs.readdirSync(KLINES)
    .filter((name) => name.endsWith('_1m.json'))
    .map((name) => {
      const symbol = name.replace(/_1m\.json$/, '');
      const edge = readEdges(path.join(KLINES, name));
      return {
        symbol,
        bars: manifest?.symbols?.includes(symbol) ? 777600 : null,
        interval: '1m',
        ...edge,
      };
    })
    .filter((row) => row.firstTs)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  artifacts = [];
  if (fs.existsSync(REPORTS)) {
    for (const name of fs.readdirSync(REPORTS)) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(REPORTS, name);
      const stat = fs.statSync(full);
      if (stat.size > 2_500_000) {
        artifacts.push({ id: name, name, bytes: stat.size, summary: 'relatório grande, aberto sob demanda' });
        continue;
      }
      try {
        const json = JSON.parse(fs.readFileSync(full, 'utf8'));
        const top = Array.isArray(json.top) ? json.top[0] : null;
        artifacts.push({
          id: name,
          name: name.replace(/\.json$/, ''),
          bytes: stat.size,
          generatedAt: json.generatedAt || null,
          summary: top
            ? `n=${top.n} WR ${top.wr}% PF ${top.pf} pnl ${top.pnl}`
            : (json.hits ? `${json.hits.length} recortes` : 'json'),
          top: top ? {
            n: top.n, wr: top.wr, pf: top.pf, pnl: top.pnl, maxDd: top.maxDd, folds: top.folds, spec: top.spec,
          } : null,
        });
      } catch (_) {
        artifacts.push({ id: name, name, summary: 'não foi possível ler' });
      }
    }
  }
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'klineWorker.js'));
  worker.on('message', (msg) => {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error));
    else waiter.resolve(msg);
  });
  worker.on('error', (err) => console.error('[lab] worker', err));
  return worker;
}

const FIT_PREFER = ['SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOGEUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT'];
const FIT_SKIP = new Set(['BTCUSDT', 'ETHUSDT', 'NEARUSDT']);

function fitFiles() {
  return FIT_PREFER
    .filter((symbol) => !FIT_SKIP.has(symbol))
    .map((symbol) => path.join(KLINES, `${symbol}_1m.json`))
    .filter((file) => {
      try { return fs.statSync(file).size > 15_000_000; } catch { return false; }
    })
    .slice(0, 3);
}

function fitExits({ recipe, fitStop, fitHold, stopPct, tpPct, maxHoldMin }) {
  const spec = specFromRecipe(recipe);
  const files = fitFiles();
  if (!spec || !files.length) return Promise.resolve({ ok: false, reason: spec ? 'no-file' : 'candle-only' });
  const id = seq++;
  ensureWorker().postMessage({
    id,
    type: 'fit',
    files,
    spec,
    opts: { fitStop: !!fitStop, fitHold: !!fitHold, stopPct, tpPct, maxHoldMin },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, reason: 'timeout' });
    }, 25000);
    pending.set(id, {
      resolve: (msg) => { clearTimeout(timer); resolve(msg.fit || { ok: false }); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
  });
}

function klines({ symbol, interval, limit }) {
  const file = path.join(KLINES, `${symbol}_1m.json`);
  if (!fs.existsSync(file)) return Promise.reject(Object.assign(new Error('par fora do arquivo'), { status: 404 }));
  if (interval === '1m' && Number(limit || 0) > 4320) {
    return Promise.reject(Object.assign(new Error('1 minuto só em janela de até 3 dias'), { status: 400 }));
  }
  const id = seq++;
  ensureWorker().postMessage({ id, file, interval: interval || '1h', limit: Math.min(Number(limit || 800), 20000) });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function manifestPublic() {
  return {
    start: manifest?.startIso || symbolIndex[0]?.firstTs || null,
    end: manifest?.endIso || null,
    interval: '1m',
    symbols: symbolIndex.length,
    days: manifest?.days || null,
    note: 'Velas de 1 minuto. Este arquivo não tem livro nem tape. Não valida Liderança, Queda, Anomalia nem Fundo da maré.',
  };
}

async function answerQuery({ prompt, userId }) {
  const text = String(prompt || '').trim();
  if (text.length < 3) {
    const err = new Error('pergunta curta');
    err.status = 400;
    throw err;
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    kind: 'prompt_stat',
    prompt: text.toLowerCase(),
    generation: manifest?.downloadedAt || 'local',
  })).digest('hex');
  const existing = await pool.query('SELECT * FROM research_artifacts WHERE hash = $1', [hash]);
  if (existing.rows[0]) {
    await pool.query('UPDATE research_artifacts SET n_hits = n_hits + 1 WHERE id = $1', [existing.rows[0].id]);
    return { cached: true, artifact: existing.rows[0] };
  }
  const symbol = (text.toUpperCase().match(/[A-Z]{2,12}USDT/) || [])[0];
  const row = symbol ? symbolIndex.find((s) => s.symbol === symbol) : null;
  const related = artifacts.filter((a) => {
    const blob = `${a.name} ${a.summary}`.toLowerCase();
    return /toque|oscila|queda|sweep/.test(text.toLowerCase()) && blob.includes(text.toLowerCase().split(/\s+/)[0]);
  }).slice(0, 5);
  const payload = {
    prompt: text,
    symbol: row || null,
    note: row
      ? 'Variação do primeiro ao último close do arquivo de 1 minuto. Não é um backtest de estratégia e não inclui livro.'
      : 'Não rodei varredura nova no processo do desk. Abaixo, o que já está salvo no laboratório.',
    artifacts: related.length ? related : artifacts.slice(0, 8).map(({ id, name, summary, top }) => ({ id, name, summary, top })),
  };
  const inserted = await pool.query(
    `INSERT INTO research_artifacts (hash, kind, params, payload, created_by)
     VALUES ($1, 'prompt_stat', $2::jsonb, $3::jsonb, $4) RETURNING *`,
    [hash, JSON.stringify({ prompt: text }), JSON.stringify(payload), userId],
  );
  return { cached: false, artifact: inserted.rows[0] };
}

function contextForPrompt(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (/^\s*brief\./.test(text)) return '';
  if (!/18|histor|vela|varred|sweep|estat|backtest|m[eê]s/.test(text)) return '';
  const bits = [manifestPublic()];
  const hit = artifacts.find((a) => text.includes('toque') ? /toque/i.test(a.name) : text.includes('oscil') ? /oscila/i.test(a.name) : false);
  if (hit) bits.push({ artifact: hit.name, summary: hit.summary, top: hit.top });
  const symbol = (String(prompt).toUpperCase().match(/[A-Z]{2,12}USDT/) || [])[0];
  const row = symbol && symbolIndex.find((s) => s.symbol === symbol);
  if (row) bits.push({ symbol: row.symbol, changePct: Number(row.changePct.toFixed(2)) });
  return JSON.stringify(bits).slice(0, 4000);
}

module.exports = {
  loadIndex,
  manifestPublic,
  symbols: () => symbolIndex,
  artifacts: () => artifacts,
  artifactByName: (name) => artifacts.find((a) => a.id === name || a.name === name) || null,
  klines,
  fitExits,
  answerQuery,
  contextForPrompt,
};
