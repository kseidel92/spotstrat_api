const WebSocket = require('ws');

const REST = process.env.BINANCE_REST || 'https://data-api.binance.vision';
const WS_URL = process.env.BINANCE_WS || 'wss://data-stream.binance.vision/stream';

const STABLES = new Set(['USDC', 'FDUSD', 'TUSD', 'DAI', 'USDE', 'BUSD', 'USD1', 'PYUSD', 'USDP', 'EUR', 'AEUR', 'TRY', 'BRL']);
const SKIP_TRADE = new Set(['BTCUSDT', 'ETHUSDT', 'NEARUSDT']);
const JUNK_RE = /(UP|DOWN|BEAR|BULL)$|^[0-9]+|[0-9]+[LS]$/;
const TOKENIZED_RE = /^[A-Z]{4,}B$/;

function baseOf(symbol) {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
}

function isJunk(symbol) {
  if (!symbol.endsWith('USDT')) return true;
  const base = baseOf(symbol);
  if (!/^[A-Z]{2,12}$/.test(base)) return true;
  if (JUNK_RE.test(base)) return true;
  if (STABLES.has(base)) return true;
  if (process.env.ALLOW_TOKENIZED_STOCKS !== 'true' && TOKENIZED_RE.test(base)) return true;
  return false;
}

function createHub() {
  const symbols = new Map();
  const history = new Map();
  let tradeSymbols = [];
  const listed = new Map();
  const funding = new Map();
  let breadthSymbols = [];
  let ws = null;
  let status = 'connecting';
  let lastMsg = 0;
  let timer = null;
  let connecting = false;
  let lastHtf = 0;

  function ensure(symbol) {
    let row = symbols.get(symbol);
    if (!row) {
      row = {
        symbol,
        price: 0,
        open24h: 0,
        pct24: 0,
        quoteVolume: 0,
        klines: [],
        htf: {},
        obi: null,
        obiSamples: [],
        tape: [],
        prints: [],
        book: null,
        bookSnaps: [],
        dayHigh: 0,
        dayLow: 0,
      };
      symbols.set(symbol, row);
    }
    return row;
  }

  function pushPrice(symbol, price, now) {
    if (!(price > 0)) return;
    const row = ensure(symbol);
    row.price = price;
    let list = history.get(symbol);
    if (!list) {
      list = [];
      history.set(symbol, list);
    }
    row.prices = list;
    const last = list[list.length - 1];
    if (last && now - last.t < 1500) {
      last.p = price;
      last.t = now;
    } else {
      list.push({ t: now, p: price });
    }
    const cutoff = now - 60 * 60 * 1000;
    while (list.length && list[0].t < cutoff) list.shift();
  }

  function onKline(symbol, k) {
    const row = ensure(symbol);
    const bar = {
      t: Number(k.t),
      o: Number(k.o),
      h: Number(k.h),
      l: Number(k.l),
      c: Number(k.c),
      v: Number(k.v),
      q: Number(k.q),
      tb: Number(k.Q ?? k.tb ?? 0),
      closed: k.x === true || k.x === 'true',
    };
    if (!(bar.c > 0)) return;
    row.price = bar.c;
    pushPrice(symbol, bar.c, Date.now());
    const prev = row._kcursor;
    if (prev && prev.t === bar.t) {
      const dQ = bar.q - prev.q;
      const dTb = bar.tb - prev.tb;
      if (dQ > 0) row.tape.push({ t: Date.now(), quote: dQ, buy: Math.max(0, dTb) });
    }
    row._kcursor = { t: bar.t, q: bar.q, tb: bar.tb };
    const cutoff = Date.now() - 20_000;
    row.tape = row.tape.filter((x) => x.t >= cutoff);
    const arr = row.klines;
    const idx = arr.findIndex((b) => b.t === bar.t);
    if (idx >= 0) arr[idx] = bar;
    else {
      arr.push(bar);
      arr.sort((a, b) => a.t - b.t);
      while (arr.length > 1000) arr.shift();
    }
  }

  function onDepth(symbol, data) {
    const bids = data.bids || data.b || [];
    const asks = data.asks || data.a || [];
    let bid = 0;
    let ask = 0;
    for (const [p, q] of bids) bid += Number(p) * Number(q);
    for (const [p, q] of asks) ask += Number(p) * Number(q);
    if (!(bid + ask > 0)) return;
    const row = ensure(symbol);
    const obi = (100 * bid) / (bid + ask);
    row.obi = obi;
    const now = Date.now();
    row.obiSamples.push({ t: now, v: obi });
    const cutoff = now - 15_000;
    row.obiSamples = row.obiSamples.filter((s) => s.t >= cutoff);
    const bestBid = Number((bids[0] || [])[0] || 0);
    const bestAsk = Number((asks[0] || [])[0] || 0);
    const askQty = Number((asks[0] || [])[1] || 0);
    const levels = (side) => side.slice(0, 10).map((level) => ({
      price: Number(level[0]),
      qty: Number(level[1]),
    })).filter((level) => level.price > 0 && level.qty > 0);
    const book = { t: now, bids: levels(bids), asks: levels(asks) };
    row.book = book;
    if (!row.bookSnaps) row.bookSnaps = [];
    if (!row._bookSnapAt || now - row._bookSnapAt >= 5000) {
      row._bookSnapAt = now;
      row.bookSnaps.push(book);
      const snapCutoff = now - 180000;
      if (row.bookSnaps.length > 40) row.bookSnaps = row.bookSnaps.filter((snap) => snap.t >= snapCutoff);
    }
    if (bestBid > 0 && bestAsk >= bestBid) {
      if (!row.spreadSamples) row.spreadSamples = [];
      row.spreadSamples.push({ t: now, spreadPct: ((bestAsk - bestBid) / bestBid) * 100, askQty });
      row.spreadSamples = row.spreadSamples.filter((s) => s.t >= now - 60_000);
    }
  }

  function obiAge(symbol, min) {
    const row = symbols.get(symbol);
    if (!row || row.obi == null) return 0;
    const samples = row.obiSamples;
    if (!samples.length) return 0;
    let since = null;
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].v + 1e-9 < min) break;
      since = samples[i].t;
    }
    if (since == null) return 0;
    return (Date.now() - since) / 1000;
  }

  function tapeFrac(symbol, windowMs = 15000) {
    const row = symbols.get(symbol);
    if (!row) return { frac: null, prints: 0 };
    const cutoff = Date.now() - windowMs;
    let quote = 0;
    let buy = 0;
    let prints = 0;
    for (const t of row.tape) {
      if (t.t < cutoff) continue;
      quote += t.quote;
      buy += t.buy;
      prints += 1;
    }
    if (!(quote > 0)) {
      const k = row.klines[row.klines.length - 1];
      if (k && k.q > 0) return { frac: k.tb / k.q, prints: 1 };
      return { frac: null, prints: 0 };
    }
    return { frac: buy / quote, prints };
  }

  function applyTicker(row) {
    const symbol = row.symbol;
    if (isJunk(symbol)) return;
    const price = Number(row.lastPrice || row.c || 0);
    const open = Number(row.openPrice || row.o || 0);
    const vol = Number(row.quoteVolume || row.q || 0);
    const rec = ensure(symbol);
    rec.price = price;
    rec.open24h = open;
    rec.quoteVolume = vol;
    rec.trades = Number(row.count || row.n || 0);
    if (!rec.tradeSamples) rec.tradeSamples = [];
    rec.tradeSamples.push({ t: Date.now(), n: rec.trades });
    rec.tradeSamples = rec.tradeSamples.filter((s) => s.t >= Date.now() - 30 * 60 * 1000);
    rec.pct24 = open > 0 ? ((price - open) / open) * 100 : Number(row.priceChangePercent || 0);
    rec.dayHigh = Number(row.highPrice || row.h || rec.dayHigh || 0);
    rec.dayLow = Number(row.lowPrice || row.l || rec.dayLow || 0);
    pushPrice(symbol, price, Date.now());
  }

  async function refreshTickers() {
    const res = await fetch(`${REST}/api/v3/ticker/24hr`);
    if (!res.ok) throw new Error(`ticker ${res.status}`);
    const rows = await res.json();
    for (const row of rows) applyTicker(row);
    const ranked = [...symbols.values()]
      .filter((s) => !isJunk(s.symbol) && s.quoteVolume >= 5_000_000 && s.trades >= 8_000)
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
    breadthSymbols = ranked.slice(0, 60).map((s) => s.symbol).filter((s) => s !== 'BTCUSDT' && s !== 'ETHUSDT');
    const nextTrade = ranked
      .map((s) => s.symbol)
      .filter((s) => !SKIP_TRADE.has(s))
      .slice(0, 60);
    const nextKey = [...nextTrade].sort().join();
    const prevKey = [...tradeSymbols].sort().join();
    const changed = nextKey !== prevKey;
    tradeSymbols = nextTrade;
    return changed;
  }

  async function bootstrapKlines(list) {
    const queue = [...list];
    async function one() {
      const symbol = queue.shift();
      if (!symbol) return;
      try {
        const res = await fetch(`${REST}/api/v3/klines?symbol=${symbol}&interval=1m&limit=1000`);
        if (res.ok) {
          const rows = await res.json();
          const rec = ensure(symbol);
          rec.klines = rows.map((k) => ({
            t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7], tb: +k[10], closed: true,
          }));
          const last = rec.klines[rec.klines.length - 1];
          if (last) rec.price = last.c;
        }
      } catch (err) {
        console.warn('[hub] kline', symbol, err.message);
      }
      await one();
    }
    await Promise.all([one(), one(), one(), one()]);
  }

  async function bootstrapDaily(list) {
    for (const symbol of list) {
      try {
        const res = await fetch(`${REST}/api/v3/klines?symbol=${symbol}&interval=1d&limit=8`);
        if (!res.ok) continue;
        const rows = await res.json();
        const rec = ensure(symbol);
        rec.high7d = Math.max(...rows.map((k) => +k[2]));
      } catch (_) { /* próximo ciclo */ }
    }
  }

  function onAggTrade(symbol, data) {
    const price = Number(data.p);
    const qty = Number(data.q);
    if (!(price > 0) || !(qty > 0)) return;
    const row = ensure(symbol);
    const now = Number(data.T) || Date.now();
    if (!Array.isArray(row.prints)) row.prints = [];
    row.prints.push({ t: now, price, qty, buyerMaker: data.m === true });
    if (row.prints.length > 2500 || row.prints.length % 80 === 0) {
      const cutoff = Date.now() - 180000;
      row.prints = row.prints.filter((trade) => trade.t >= cutoff);
      if (row.prints.length > 2500) row.prints = row.prints.slice(-2500);
    }
    pushPrice(symbol, price, now);
  }

  function streamList() {
    const set = new Set([...tradeSymbols, 'BTCUSDT', 'ETHUSDT']);
    const parts = [];
    for (const symbol of set) {
      const s = symbol.toLowerCase();
      parts.push(`${s}@kline_1m`);
      parts.push(`${s}@depth20@1000ms`);
      parts.push(`${s}@aggTrade`);
    }
    return parts;
  }

  function connectWs() {
    if (ws) {
      try { ws.close(); } catch (_) { /* ignore */ }
    }
    const streams = streamList();
    if (!streams.length) return;
    connecting = true;
    const url = `${WS_URL}?streams=${streams.join('/')}`;
    const socket = new WebSocket(url);
    ws = socket;
    socket.on('open', () => {
      status = 'live';
      connecting = false;
      lastMsg = Date.now();
      console.log(`[hub] websocket ao vivo · ${tradeSymbols.length} pares`);
    });
    socket.on('message', (buf) => {
      lastMsg = Date.now();
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch (_) { return; }
      const data = msg.data || msg;
      const stream = msg.stream || '';
      try {
      if (data.e === 'kline' && data.k) onKline(data.s, data.k);
      else if (data.e === 'aggTrade') onAggTrade(data.s || (stream.split('@')[0] || '').toUpperCase(), data);
      else if (stream.includes('@depth') || data.bids || data.b) {
        const symbol = (stream.split('@')[0] || '').toUpperCase();
        if (symbol) onDepth(symbol, data);
      }
      } catch (err) {
        console.warn('[hub] msg', err.message);
      }
    });
    socket.on('close', () => {
      status = 'connecting';
      connecting = false;
      setTimeout(() => { if (ws === socket) connectWs(); }, 3000);
    });
    socket.on('error', (err) => {
      status = 'degraded';
      console.warn('[hub] ws', err.message);
    });
  }

  function mareFor(prefs = {}) {
    const windowMs = Number(prefs.windowMs || 300000);
    const majority = Number(prefs.majority || 0.55);
    const noise = Number(prefs.noisePct || 0.05);
    const now = Date.now();
    let up = 0;
    let down = 0;
    let flat = 0;
    for (const symbol of breadthSymbols) {
      const list = history.get(symbol);
      if (!list || !list.length) continue;
      const current = list[list.length - 1];
      const target = now - windowMs;
      let past = list[0];
      for (const point of list) {
        if (point.t <= target) past = point;
        else break;
      }
      if (!(past.p > 0) || now - past.t < Math.min(windowMs, 8000) && list.length < 2) {
        const row = symbols.get(symbol);
        if (!(row && row.open24h > 0)) continue;
        past = { p: row.open24h };
      }
      const ch = ((current.p - past.p) / past.p) * 100;
      if (ch > noise) up += 1;
      else if (ch < -noise) down += 1;
      else flat += 1;
    }
    const total = up + down + flat;
    let label = 'NEUTRA';
    if (total >= 6) {
      if (up / total >= majority) label = 'BOA';
      else if (down / total >= majority) label = 'RUIM';
    }
    return {
      label,
      upCount: up,
      downCount: down,
      flatCount: flat,
      total,
      upPct: total ? Number(((100 * up) / total).toFixed(1)) : 0,
      windowMin: Math.round(windowMs / 60000),
      majority,
      updatedAt: now,
    };
  }

  async function loadListings() {
    try {
      const res = await fetch(`${REST}/api/v3/exchangeInfo`);
      if (!res.ok) return;
      const data = await res.json();
      for (const item of data.symbols || []) {
        if (item.onboardDate) listed.set(item.symbol, Number(item.onboardDate));
      }
    } catch (err) {
      console.warn('[hub] listagem', err.message);
    }
  }

  async function refreshFunding(list) {
    for (const symbol of list) {
      try {
        const res = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=3`);
        if (!res.ok) continue;
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length) funding.set(symbol, rows.map((r) => Number(r.fundingRate)));
      } catch (_) { /* par sem perpétuo */ }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  async function pullHtf(symbol, interval, tfMin, limit) {
    const res = await fetch(`${REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!res.ok) return;
    const rows = await res.json();
    const now = Date.now();
    const ms = tfMin * 60000;
    const rec = ensure(symbol);
    if (!rec.htf) rec.htf = {};
    rec.htf[tfMin] = rows.map((k) => ({
      t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closed: k[0] + ms <= now,
    })).filter((k) => k.closed && k.c > 0);
  }

  async function bootstrapHtf(list) {
    const queue = [];
    for (const symbol of list) {
      queue.push({ symbol, interval: '15m', tfMin: 15, limit: 200 });
      queue.push({ symbol, interval: '1h', tfMin: 60, limit: 250 });
      queue.push({ symbol, interval: '4h', tfMin: 240, limit: 120 });
    }
    async function one() {
      const job = queue.shift();
      if (!job) return;
      try {
        await pullHtf(job.symbol, job.interval, job.tfMin, job.limit);
      } catch (err) {
        console.warn('[hub] htf', job.symbol, job.interval, err.message);
      }
      await one();
    }
    await Promise.all([one(), one(), one(), one()]);
    console.log(`[hub] htf ${list.length} pares`);
  }

  async function boot() {
    try {
      await refreshTickers();
      const warm = [...new Set([...tradeSymbols, 'BTCUSDT', 'ETHUSDT'])];
      await bootstrapKlines(warm);
      lastHtf = Date.now();
      bootstrapHtf(warm).catch((err) => console.warn('[hub] htf', err.message));
      bootstrapDaily(warm).catch(() => {});
      loadListings().catch(() => {});
      refreshFunding(warm).catch(() => {});
      connectWs();
      status = 'live';
    } catch (err) {
      status = 'degraded';
      console.warn('[hub] boot', err.message);
      setTimeout(boot, 15000);
    }
  }

  function start() {
    boot();
    timer = setInterval(() => {
      refreshTickers().then((changed) => {
        if (changed) connectWs();
      }).catch((err) => {
        status = 'degraded';
        console.warn('[hub] ticker', err.message);
      });
      if (status === 'live' && Date.now() - lastMsg > 20000) status = 'degraded';
      if (Date.now() - lastHtf > 10 * 60 * 1000 && tradeSymbols.length) {
        lastHtf = Date.now();
        const warm = [...new Set([...tradeSymbols, 'BTCUSDT', 'ETHUSDT'])];
        bootstrapHtf(warm).catch(() => {});
      }
    }, 30000);
  }

  function stop() {
    clearInterval(timer);
    if (ws) ws.close();
  }

  return {
    start,
    stop,
    mareFor,
    obiAge,
    tapeFrac,
    get status() { return status; },
    get tradeSymbols() { return tradeSymbols; },
    getSymbol: (symbol) => symbols.get(symbol),
    prices() {
      return tradeSymbols.map((symbol) => {
        const row = symbols.get(symbol);
        return row ? { symbol, price: row.price, pct24: Number(row.pct24.toFixed(2)) } : null;
      }).filter(Boolean);
    },
    btc() { return symbols.get('BTCUSDT'); },
    listedAt: (symbol) => listed.get(symbol) || null,
    fundingRates: (symbol) => funding.get(symbol) || null,
  };
}

module.exports = { createHub, isJunk, SKIP_TRADE };
