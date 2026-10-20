const { pool } = require('./db');
const { evaluateStrategy } = require('./signals');
const { emptySnap, brtDay, sizeQuote, TAKER, MAKER, INITIAL } = require('./shared');
const { applyExit } = require('./faithful');
const { decideScript, markFill } = require('./script');
const { decideJs } = require('./sandbox');
const bus = require('./bus');

function num(v) {
  return v == null ? null : Number(v);
}

function createDesk(hub) {
  const runners = new Map();
  const users = new Map();
  let alarmRuns = [];
  const alarmCooldown = new Map();
  let timer = null;
  let lastScan = 0;
  let alarmScanAt = 0;

  async function loadAll() {
    const { rows: userRows } = await pool.query('SELECT id, mare_prefs, plan_status, plan_tier, trial_ends_at, email_verified_at, phone_verified_at, google_sub FROM users');
    users.clear();
    for (const row of userRows) {
      users.set(row.id, {
        marePrefs: row.mare_prefs || {},
        planStatus: row.plan_status,
        trialEndsAt: row.trial_ends_at,
        verified: !!(row.google_sub && row.email_verified_at) || !!(row.email_verified_at && row.phone_verified_at),
      });
    }
    const { rows } = await pool.query(`
      SELECT s.*, p.snapshot
      FROM strategies s
      LEFT JOIN positions p ON p.strategy_id = s.id
    `);
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.id);
      const prev = runners.get(row.id);
      const snap = row.snapshot || prev?.snap || emptySnap();
      runners.set(row.id, {
        userId: row.user_id,
        strategy: row,
        snap,
        dirty: false,
      });
    }
    for (const id of runners.keys()) {
      if (!seen.has(id)) runners.delete(id);
    }
    await loadAlarms();
  }

  async function loadAlarms(userId) {
    const q = userId
      ? await pool.query('SELECT * FROM alarms WHERE user_id = $1', [userId])
      : await pool.query('SELECT * FROM alarms');
    if (!userId) alarmRuns = q.rows;
    else alarmRuns = alarmRuns.filter((row) => row.user_id !== userId).concat(q.rows);
  }

  async function reloadUser(userId) {
    const { rows: userRows } = await pool.query('SELECT id, mare_prefs, plan_status, plan_tier, trial_ends_at, email_verified_at, phone_verified_at, google_sub FROM users WHERE id=$1', [userId]);
    if (!userRows[0]) {
      users.delete(userId);
      for (const [id, run] of runners) if (run.userId === userId) runners.delete(id);
      return;
    }
    const row = userRows[0];
    users.set(row.id, {
      marePrefs: row.mare_prefs || {},
      planStatus: row.plan_status,
      trialEndsAt: row.trial_ends_at,
      verified: !!(row.google_sub && row.email_verified_at) || !!(row.email_verified_at && row.phone_verified_at),
    });
    const { rows } = await pool.query(`
      SELECT s.*, p.snapshot
      FROM strategies s LEFT JOIN positions p ON p.strategy_id = s.id
      WHERE s.user_id = $1
    `, [userId]);
    const ids = new Set(rows.map((r) => r.id));
    for (const [id, run] of runners) {
      if (run.userId === userId && !ids.has(id)) runners.delete(id);
    }
    for (const s of rows) {
      const prev = runners.get(s.id);
      const keep = prev?.dirty ? prev.snap : null;
      runners.set(s.id, {
        userId,
        strategy: s,
        snap: keep || s.snapshot || prev?.snap || emptySnap(),
        dirty: !!keep,
      });
    }
    await loadAlarms(userId);
    pushState(userId);
  }

  function userActive(userId) {
    const u = users.get(userId);
    if (!u || !u.verified || !u.trialEndsAt) return false;
    return new Date(u.trialEndsAt).getTime() > Date.now();
  }

  function markDay(snap, now) {
    const day = brtDay(now);
    if (snap.dayKey !== day) {
      snap.dayKey = day;
      snap.dayStartEquity = snap.cash + positionValue(snap, null);
      snap.halted = false;
      snap.dirty = true;
    }
  }

  function positionValue(snap, price) {
    const p = snap.position;
    if (!p) return 0;
    const px = price || p.entry;
    return p.qty * px * (1 - TAKER);
  }

  function equityOf(snap, price) {
    return snap.cash + (snap.position ? positionValue(snap, price || snap.position.entry) : 0);
  }

  function rollHalt(snap, price) {
    const eq = equityOf(snap, price);
    snap.equity = eq;
    if (snap.dayStartEquity > 0 && (eq - snap.dayStartEquity) / snap.dayStartEquity <= -0.08) snap.halted = true;
  }

  async function persist(run) {
    await pool.query(
      'INSERT INTO positions (strategy_id, snapshot, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (strategy_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = now()',
      [run.strategy.id, JSON.stringify(run.snap)],
    );
    run.dirty = false;
  }

  async function openTrade(run, want) {
    const snap = run.snap;
    const price = want.entry;
    rollHalt(snap, price);
    let quote;
    if (want.quoteFrac) {
      quote = Math.min(snap.cash * 0.95, snap.equity * want.quoteFrac);
    } else {
      const sized = sizeQuote({ equity: snap.equity, cash: snap.cash, entry: price, stopLoss: want.stop, side: want.side });
      if (!sized.ok) return;
      quote = sized.quote * (want.fraction || 1);
    }
    if (!(quote >= 10)) return;
    const feeIn = quote * TAKER;
    const qty = quote / price;
    const cashBefore = snap.cash;
    if (want.side === 'short') snap.cash += quote - feeIn;
    else snap.cash -= quote + feeIn;
    snap.position = {
      symbol: want.symbol,
      side: want.side || 'long',
      entry: price,
      firstEntry: price,
      qty,
      quote,
      feeIn,
      stop: want.stop,
      tp: want.tp,
      openedAt: new Date().toISOString(),
      cashBefore,
      high: price,
      low: price,
      armPct: want.armPct || 0,
      trail: want.trail || null,
      pyramid: want.pyramid || null,
      noTarget: !!want.noTarget,
      until: want.until || null,
      added: false,
      maxHoldMin: want.maxHoldMin,
      timeExit: want.timeExit !== false,
      reason: want.reason,
      rule: want.rule || null,
      frozen: want.frozen || null,
      noStop: !!want.noStop,
      adds: 1,
    };
    if (run.strategy.recipe?.script && run.strategy.recipe.plan?.kind === 'script') {
      markFill(run.strategy.recipe.script, snap, hub.getSymbol(want.symbol) || { symbol: want.symbol, price, klines: [] }, hub, Date.now(), price);
    }
    snap.cooldowns[want.symbol] = Date.now() + want.noRepeatMin * 60 * 1000;
    snap.events.push({ symbol: want.symbol, t: Date.now(), kind: 'entry' });
    snap.events = snap.events.filter((e) => Date.now() - e.t < 24 * 3600 * 1000);
    rollHalt(snap, price);
    run.dirty = true;
    await pool.query(
      `INSERT INTO trades (user_id, strategy_id, symbol, side, opened_at, entry, qty, quote, fees, raw)
       VALUES ($1,$2,$3,$4, now(), $5,$6,$7,$8,$9::jsonb)`,
      [run.userId, run.strategy.id, want.symbol, want.side === 'short' ? 'SHORT' : 'LONG', price, qty, quote, feeIn, JSON.stringify({ reason: want.reason, stop: want.stop, tp: want.tp, side: want.side || 'long' })],
    );
    await persist(run);
    bus.emit('push', {
      userId: run.userId,
      msg: { type: 'position', strategyId: run.strategy.id, position: publicPosition(snap), equity: snap.equity },
    });
    console.log(`[desk] compra ${want.symbol} ${run.strategy.name} quote ${quote.toFixed(2)}`);
  }

  async function closeTrade(run, price, exitType, feeRate) {
    const snap = run.snap;
    const p = snap.position;
    if (!p) return;
    const proceeds = p.qty * price * (1 - feeRate);
    const feeOut = p.qty * price * feeRate;
    snap.cash += proceeds;
    const pnl = snap.cash - p.cashBefore;
    const result = pnl > 0.005 ? 'win' : pnl < -0.005 ? 'loss' : 'flat';
    if (exitType === 'sl' && p.symbol) {
      const mins = run.strategy.params?.stopCooldownMin ?? run.strategy.recipe?.pacing?.stopCooldownMin ?? 60;
      if (mins > 0) snap.stopCooldowns[p.symbol] = Date.now() + mins * 60 * 1000;
    }
    const lock = run.strategy.recipe?.plan?.lock;
    if (lock && p.symbol) {
      if (!snap.loss) snap.loss = {};
      const streak = snap.loss[p.symbol] || { n: 0, banUntil: 0 };
      if (result === 'loss' && exitType === 'sl') {
        streak.n += 1;
        if (streak.n >= lock.stops) {
          streak.banUntil = Date.now() + lock.banMin * 60 * 1000;
          streak.n = 0;
        }
      } else if (result === 'win') streak.n = 0;
      snap.loss[p.symbol] = streak;
    }
    snap.position = null;
    snap.equity = snap.cash;
    rollHalt(snap, null);
    run.dirty = true;
    await pool.query(
      `UPDATE trades SET closed_at = now(), exit = $1, pnl_usdt = $2, fees = COALESCE(fees,0) + $3, exit_type = $4, result = $5
       WHERE id = (
         SELECT id FROM trades WHERE strategy_id = $6 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1
       )`,
      [price, pnl, feeOut, exitType, result, run.strategy.id],
    );
    await persist(run);
    bus.emit('push', {
      userId: run.userId,
      msg: {
        type: 'trade',
        strategyId: run.strategy.id,
        trade: { symbol: p.symbol, exit: price, pnl, exitType, result },
        position: null,
        equity: snap.equity,
      },
    });
    console.log(`[desk] saída ${p.symbol} ${exitType} pnl ${pnl.toFixed(2)}`);
  }

  async function addScript(run) {
    const p = run.snap.position;
    const script = run.strategy.recipe.script;
    const price = hub.getSymbol(p.symbol)?.price || p.entry;
    const quote = Math.min(run.snap.cash * 0.95, run.snap.equity * (script.buyFrac || 0.1));
    const fee = quote * TAKER;
    if (!(quote >= 10) || run.snap.cash < quote + fee) return;
    run.snap.cash -= quote + fee;
    p.qty += quote / price;
    p.quote += quote;
    p.feeIn = (p.feeIn || 0) + fee;
    p.adds = (p.adds || 1) + 1;
    markFill(script, run.snap, hub.getSymbol(p.symbol), hub, Date.now(), price);
    run.dirty = true;
    await pool.query(
      `INSERT INTO trades (user_id, strategy_id, symbol, side, opened_at, entry, qty, quote, fees, raw)
       VALUES ($1,$2,$3,'LONG', now(), $4,$5,$6,$7,$8::jsonb)`,
      [run.userId, run.strategy.id, p.symbol, price, quote / price, quote, fee, JSON.stringify({ add: p.adds })],
    );
    await persist(run);
  }

  async function addPyramid(run) {
    const p = run.snap.position;
    if (!p || p.added) return;
    const price = hub.getSymbol(p.symbol)?.price || p.entry;
    const quote = p.quote;
    const fee = quote * TAKER;
    if (run.snap.cash < quote + fee) return;
    run.snap.cash -= quote + fee;
    p.qty += quote / price;
    p.quote += quote;
    p.feeIn += fee;
    p.stop = p.firstEntry || p.entry;
    p.added = true;
    run.dirty = true;
    await persist(run);
  }

  function manage(run) {
    const p = run.snap.position;
    if (!p) return;
    const row = hub.getSymbol(p.symbol);
    const price = row?.price || p.entry;
    const short = p.side === 'short';
    if (price > (p.high || 0)) p.high = price;
    if (price < (p.low || price)) p.low = price;
    if (run.strategy.recipe?.code && run.strategy.recipe.plan?.kind === 'js') {
      const decision = decideJs(run.strategy, row || { symbol: p.symbol, price, klines: [], htf: {} }, p, price, Date.now(), run.snap);
      if (decision.exit) return closeTrade(run, price, decision.exit, decision.exit === 'tp' ? MAKER : TAKER);
      const sideShort = p.side === 'short';
      if (!p.noStop && p.stop > 0 && (sideShort ? price >= p.stop : price <= p.stop)) return closeTrade(run, price, 'sl', TAKER);
      if (!p.noTarget && p.tp && (sideShort ? price <= p.tp : price >= p.tp)) return closeTrade(run, price, 'tp', MAKER);
      rollHalt(run.snap, price);
      return null;
    }
    if (run.strategy.recipe?.script && run.strategy.recipe.plan?.kind === 'script') {
      const decision = decideScript(run.strategy.recipe.script, {
        row: row || { symbol: p.symbol, price, klines: [], htf: {} },
        hub,
        now: Date.now(),
        memory: run.snap,
        position: p,
        price,
      });
      run.dirty = true;
      if (decision.exit) return closeTrade(run, price, decision.exit, decision.exit === 'tp' ? MAKER : TAKER);
      if (decision.add) return addScript(run);
      rollHalt(run.snap, price);
      return null;
    }
    const why = applyExit(run.strategy.recipe, row, hub, p, price, Date.now());
    if (why) return closeTrade(run, price, why, why === 'tp' ? MAKER : TAKER);
    if (!short && p.trail && p.high >= p.entry * (1 + p.trail.armPct / 100)) {
      const trailed = p.high * (1 - p.trail.distPct / 100);
      if (trailed > p.stop) p.stop = trailed;
    }
    if (short && p.trail && p.low <= p.entry * (1 - p.trail.armPct / 100)) {
      const trailed = p.low * (1 + p.trail.distPct / 100);
      if (trailed < p.stop) p.stop = trailed;
    }
    if (!short && p.armPct && p.high >= p.entry * (1 + p.armPct)) {
      const be = p.entry * (1 + TAKER + TAKER);
      if (p.stop < be) p.stop = be;
    }
    if (!short && p.pyramid && !p.added && price >= p.entry * (1 + p.pyramid.triggerPct / 100)) {
      return addPyramid(run);
    }
    const opened = new Date(p.openedAt).getTime();
    if (p.until === 'brt-close' && brtDay(Date.now()) !== brtDay(opened)) return closeTrade(run, price, 'time', TAKER);
    if (!p.noTarget && p.tp && (short ? price <= p.tp : price >= p.tp)) return closeTrade(run, price, 'tp', MAKER);
    if (!p.noStop && (short ? price >= p.stop : price <= p.stop)) return closeTrade(run, price, 'sl', TAKER);
    if (p.timeExit !== false && p.maxHoldMin && Date.now() - opened >= p.maxHoldMin * 60 * 1000) return closeTrade(run, price, 'time', TAKER);
    rollHalt(run.snap, price);
    return null;
  }

  function cooled(snap, symbol) {
    const now = Date.now();
    if ((snap.cooldowns[symbol] || 0) > now) return true;
    if ((snap.stopCooldowns[symbol] || 0) > now) return true;
    return false;
  }

  function gridSymbol(run) {
    if (run.snap.grid?.symbol && hub.getSymbol(run.snap.grid.symbol)?.price) return run.snap.grid.symbol;
    const ranked = hub.tradeSymbols
      .map((symbol) => hub.getSymbol(symbol))
      .filter((row) => row && row.price > 0)
      .sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0));
    return ranked[0]?.symbol || null;
  }

  async function bookGridFill(run, symbol, side, price, quote) {
    const fee = quote * TAKER;
    const qty = quote / price;
    if (side === 'buy') {
      if (run.snap.cash < quote + fee) return null;
      run.snap.cash -= quote + fee;
    } else {
      run.snap.cash += quote - fee;
    }
    await pool.query(
      `INSERT INTO trades (user_id, strategy_id, symbol, side, opened_at, closed_at, entry, exit, qty, quote, fees, pnl_usdt, exit_type, result, raw)
       VALUES ($1,$2,$3,$4, now(), CASE WHEN $4 = 'SELL' THEN now() ELSE NULL END, $5, CASE WHEN $4 = 'SELL' THEN $5 ELSE NULL END, $6,$7,$8,0,$9,'flat',$10::jsonb)`,
      [run.userId, run.strategy.id, symbol, side === 'buy' ? 'LONG' : 'SELL', price, qty, quote, fee, side === 'buy' ? 'grid-buy' : 'grid-sell', JSON.stringify({ grid: true })],
    );
    return { price, qty, quote, fee };
  }

  async function manageGrid(run) {
    const plan = run.strategy.recipe.plan.grid;
    const symbol = gridSymbol(run);
    const row = symbol && hub.getSymbol(symbol);
    if (!row || !(row.price > 0) || run.strategy.paused || run.snap.halted || !userActive(run.userId)) return;
    if (!run.snap.grid) run.snap.grid = { symbol, anchor: row.price, lots: [] };
    const grid = run.snap.grid;
    grid.symbol = symbol;
    const step = plan.stepPct / 100;
    const box = plan.boxPct / 100;
    const slice = Math.max(10, (run.snap.equity * 0.08) / plan.levels);
    const buys = grid.lots.filter((lot) => !lot.closed);
    if (buys.length < plan.levels && row.price <= grid.anchor * (1 - step * (buys.length + 1)) && row.price >= grid.anchor * (1 - box)) {
      const fill = await bookGridFill(run, symbol, 'buy', row.price, slice);
      if (fill) grid.lots.push({ ...fill, closed: false });
    }
    for (const lot of grid.lots) {
      if (lot.closed) continue;
      if (row.price >= lot.price * (1 + step)) {
        const proceeds = lot.qty * row.price;
        const fee = proceeds * TAKER;
        run.snap.cash += proceeds - fee;
        const pnl = (row.price - lot.price) * lot.qty - lot.fee - fee;
        lot.closed = true;
        await pool.query(
          `UPDATE trades SET closed_at = now(), exit = $1, pnl_usdt = $2, fees = COALESCE(fees,0) + $3, exit_type = 'grid-sell', result = $4
           WHERE id = (
             SELECT id FROM trades WHERE strategy_id = $5 AND symbol = $6 AND closed_at IS NULL ORDER BY opened_at ASC LIMIT 1
           )`,
          [row.price, pnl, fee, pnl > 0 ? 'win' : 'loss', run.strategy.id, symbol],
        );
      }
    }
    run.snap.equity = run.snap.cash;
    run.dirty = true;
  }

  async function manageDca(run) {
    const plan = run.strategy.recipe.plan.dca;
    const symbol = gridSymbol(run);
    const row = symbol && hub.getSymbol(symbol);
    if (!row || !(row.price > 0) || run.strategy.paused || run.snap.halted || !userActive(run.userId)) return;
    const basket = run.snap.dca || { symbol, qty: 0, quote: 0, fee: 0, lastAt: 0 };
    basket.symbol = symbol;
    const every = plan.everyMin * 60 * 1000;
    const slice = Math.max(10, run.snap.equity * 0.05);
    if (Date.now() - basket.lastAt >= every && run.snap.cash >= slice * 1.01) {
      const fee = slice * TAKER;
      const qty = slice / row.price;
      run.snap.cash -= slice + fee;
      basket.qty += qty;
      basket.quote += slice;
      basket.fee += fee;
      basket.lastAt = Date.now();
      await pool.query(
        `INSERT INTO trades (user_id, strategy_id, symbol, side, opened_at, entry, qty, quote, fees, raw)
         VALUES ($1,$2,$3,'LONG', now(), $4,$5,$6,$7,$8::jsonb)`,
        [run.userId, run.strategy.id, symbol, row.price, qty, slice, fee, JSON.stringify({ dca: true })],
      );
    }
    const avg = basket.qty > 0 ? basket.quote / basket.qty : 0;
    if (basket.qty > 0 && row.price >= avg * (1 + plan.tpPct / 100)) {
      const proceeds = basket.qty * row.price;
      const fee = proceeds * TAKER;
      run.snap.cash += proceeds - fee;
      const pnl = proceeds - fee - basket.quote - basket.fee;
      await pool.query(
        `UPDATE trades SET closed_at = now(), exit = $1, pnl_usdt = pnl_usdt, exit_type = 'dca-sell', result = $2
         WHERE strategy_id = $3 AND closed_at IS NULL`,
        [row.price, pnl > 0 ? 'win' : 'loss', run.strategy.id],
      );
      basket.qty = 0;
      basket.quote = 0;
      basket.fee = 0;
    }
    if (basket.qty > 0) {
      const stop = avg * (1 - run.strategy.recipe.exit.stopPct / 100);
      if (row.price <= stop) {
        const proceeds = basket.qty * row.price * (1 - TAKER);
        run.snap.cash += proceeds;
        basket.qty = 0;
        basket.quote = 0;
        basket.fee = 0;
        await pool.query(
          `UPDATE trades SET closed_at = now(), exit = $1, exit_type = 'sl', result = 'loss' WHERE strategy_id = $2 AND closed_at IS NULL`,
          [row.price, run.strategy.id],
        );
      }
    }
    run.snap.dca = basket;
    run.snap.equity = run.snap.cash + basket.qty * row.price;
    run.dirty = true;
  }

  async function closeAccum(run, book, price, exitType) {
    if (!(book.qty > 0)) return;
    const proceeds = book.qty * price * (1 - TAKER);
    const fee = book.qty * price * TAKER;
    run.snap.cash += proceeds;
    const pnl = proceeds - book.quote - book.fee;
    await pool.query(
      `UPDATE trades SET closed_at = now(), exit = $1,
         pnl_usdt = (qty * $1) - quote - fees,
         fees = fees + (qty * $1 * $2),
         exit_type = $3,
         result = CASE WHEN (qty * $1) > quote THEN 'win' ELSE 'loss' END
       WHERE strategy_id = $4 AND closed_at IS NULL`,
      [price, TAKER, exitType, run.strategy.id],
    );
    book.qty = 0;
    book.quote = 0;
    book.fee = 0;
    book.fills = 0;
    book.ref = null;
    book.firstAt = 0;
    book.armed = false;
    book.reserved = 0;
    book.lastCandle = 0;
    run.snap.accum = book;
    run.snap.equity = run.snap.cash;
    run.dirty = true;
    console.log(`[desk] accum saída ${book.symbol} ${exitType} pnl ${pnl.toFixed(2)}`);
  }

  async function manageAccum(run) {
    const plan = run.strategy.recipe.plan;
    const symbol = gridSymbol(run);
    const row = symbol && hub.getSymbol(symbol);
    if (!row || !(row.price > 0) || run.strategy.paused || !userActive(run.userId)) return;
    const book = run.snap.accum || { symbol, qty: 0, quote: 0, fee: 0, fills: 0, ref: null, firstAt: 0, armed: false, reserved: 0, lastCandle: 0 };
    book.symbol = symbol;
    const ref0 = row.open24h > 0 ? row.open24h : 0;
    if (!book.armed && !(book.qty > 0)) {
      if (row.pct24 <= -plan.drop24 && ref0 > 0) {
        book.armed = true;
        book.reserved = run.snap.equity;
        book.ref = ref0;
      }
    }
    if (book.qty > 0 && book.firstAt && Date.now() - book.firstAt >= plan.timeoutMin * 60000) {
      await closeAccum(run, book, row.price, 'time');
      return;
    }
    const avg = book.qty > 0 ? book.quote / book.qty : 0;
    if (book.qty > 0 && row.price >= avg * (1 + plan.tpPct / 100)) {
      await closeAccum(run, book, row.price, 'tp');
      return;
    }
    const candle = Math.floor(Date.now() / 3600000) * 3600000;
    const buys = book.fills || 0;
    if (!run.snap.halted && book.armed && buys < plan.maxBuys && book.ref > 0 && book.lastCandle !== candle && row.price <= book.ref * (1 - plan.stepPct / 100)) {
      const slice = (book.reserved || run.snap.equity) * plan.sliceFrac;
      const fee = slice * TAKER;
      if (slice >= 10 && run.snap.cash >= slice + fee) {
        const qty = slice / row.price;
        run.snap.cash -= slice + fee;
        book.qty += qty;
        book.quote += slice;
        book.fee += fee;
        book.fills = buys + 1;
        book.ref = row.price;
        book.lastCandle = candle;
        if (!book.firstAt) book.firstAt = Date.now();
        await pool.query(
          `INSERT INTO trades (user_id, strategy_id, symbol, side, opened_at, entry, qty, quote, fees, raw)
           VALUES ($1,$2,$3,'LONG', now(), $4,$5,$6,$7,$8::jsonb)`,
          [run.userId, run.strategy.id, symbol, row.price, qty, slice, fee, JSON.stringify({ accum: book.fills, ref: book.ref })],
        );
      }
    }
    run.snap.accum = book;
    run.snap.equity = run.snap.cash + (book.qty || 0) * row.price;
    run.dirty = true;
  }

  async function tick() {
    const now = Date.now();
    const focused = bus.focused ? bus.focused() : new Set();
    for (const run of runners.values()) {
      try {
        if (!userActive(run.userId)) continue;
        markDay(run.snap, now);
        const plan = run.strategy.recipe?.plan;
        if (plan?.kind === 'grid') {
          await manageGrid(run);
          continue;
        }
        if (plan?.kind === 'dca') {
          await manageDca(run);
          continue;
        }
        if (plan?.kind === 'accum') {
          await manageAccum(run);
          continue;
        }
        if (!run.closing) {
          const pending = manage(run);
          if (pending) {
            run.closing = true;
            try { await pending; } finally { run.closing = false; }
          }
        }
        const price = run.snap.position ? hub.getSymbol(run.snap.position.symbol)?.price : null;
        rollHalt(run.snap, price);
        if (run.snap.position || run.strategy.paused || run.snap.halted) {
          if (focused.has(run.strategy.id) && now - lastScan > 2000) {
            const user = users.get(run.userId);
            const mare = hub.mareFor({});
            const evaluated = evaluateStrategy(run.strategy, hub, mare);
            bus.emit('push', { userId: run.userId, msg: { type: 'scan', strategyId: run.strategy.id, rows: evaluated.scan, blocked: run.strategy.paused ? 'paused' : run.snap.halted ? 'halt' : 'in_position' } });
          }
          continue;
        }
        const mare = hub.mareFor({});
        if (!run.snap.watch) run.snap.watch = {};
        if (!run.snap.loss) run.snap.loss = {};
        const evaluated = evaluateStrategy(run.strategy, hub, mare, run.snap);
        if (Object.keys(run.snap.watch).length || Object.keys(run.snap.loss).length || run.snap.touched) run.dirty = true;
        if (run.snap.touched) run.snap.touched = false;
        if (focused.has(run.strategy.id)) {
          bus.emit('push', { userId: run.userId, msg: { type: 'scan', strategyId: run.strategy.id, rows: evaluated.scan } });
        }
        if (evaluated.want && !cooled(run.snap, evaluated.want.symbol)) {
          await openTrade(run, evaluated.want);
        }
      } catch (err) {
        console.error('[desk] runner', run.strategy.id, err.message);
        run.strategy.paused = true;
      }
    }
    if (now - lastScan > 2000) lastScan = now;
    if (now - alarmScanAt > 2000) {
      alarmScanAt = now;
      await scanAlarms();
    }
    if (now % 15000 < 1200) {
      for (const run of runners.values()) {
        if (run.dirty) persist(run).catch(() => {});
      }
    }
  }

  async function scanAlarms() {
    for (const alarm of alarmRuns) {
      if (alarm.status !== 'armed') continue;
      if (!userActive(alarm.user_id)) continue;
      try {
        const mare = hub.mareFor({});
        const evaluated = evaluateStrategy({ type: 'recipe', recipe: alarm.recipe, mare_mode: 'any' }, hub, mare);
        if (!evaluated.want) continue;
        const key = `${alarm.id}:${evaluated.want.symbol}`;
        if ((alarmCooldown.get(key) || 0) > Date.now()) continue;
        const recent = await pool.query(
          `SELECT 1 FROM alarm_hits
           WHERE alarm_id = $1 AND symbol = $2 AND created_at > now() - interval '30 minutes'
           LIMIT 1`,
          [alarm.id, evaluated.want.symbol],
        );
        if (recent.rows[0]) {
          alarmCooldown.set(key, Date.now() + 30 * 60 * 1000);
          continue;
        }
        const want = evaluated.want;
        const stopPct = ((want.entry - want.stop) / want.entry) * 100;
        const tpPct = ((want.tp - want.entry) / want.entry) * 100;
        const inserted = await pool.query(
          `INSERT INTO alarm_hits (alarm_id, user_id, symbol, price, stop, tp, stop_pct, tp_pct, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, symbol, price, stop, tp, stop_pct, tp_pct, reason, created_at`,
          [alarm.id, alarm.user_id, want.symbol, want.entry, want.stop, want.tp, stopPct, tpPct, want.reason || alarm.name],
        );
        alarmCooldown.set(key, Date.now() + 30 * 60 * 1000);
        const row = inserted.rows[0];
        const deliveries = await deliverAlarm(
          alarm,
          `${alarm.name} em ${want.symbol}. Preço ${Number(want.entry).toFixed(4)}. Stop ${Number(want.stop).toFixed(4)}. Alvo ${Number(want.tp).toFixed(4)}. A ordem continua sua.`,
        );
        bus.emit('push', {
          userId: alarm.user_id,
          msg: {
            type: 'alarm',
            hit: {
              id: row.id,
              alarmId: alarm.id,
              name: alarm.name,
              symbol: row.symbol,
              price: Number(row.price),
              stop: Number(row.stop),
              tp: Number(row.tp),
              stopPct: Number(row.stop_pct),
              tpPct: Number(row.tp_pct),
              reason: row.reason,
              createdAt: row.created_at,
              seen: false,
              channels: alarm.channels || { sound: true, email: false, sms: false },
              deliveries,
            },
          },
        });
        console.log(`[alarm] ${alarm.name} ${want.symbol} stop ${stopPct.toFixed(2)}% alvo ${tpPct.toFixed(2)}%`);
      } catch (err) {
        console.error('[alarm]', alarm.id, err.message);
      }
    }
  }

  function publicPosition(snap) {
    if (!snap.position) return null;
    const p = snap.position;
    const px = hub.getSymbol(p.symbol)?.price || p.entry;
    const upnl = p.side === 'short'
      ? (p.entry - px) * p.qty - p.feeIn
      : px * p.qty * (1 - TAKER) - p.quote - p.feeIn;
    return {
      symbol: p.symbol,
      entry: p.entry,
      qty: p.qty,
      stop: p.stop,
      tp: p.tp,
      openedAt: p.openedAt,
      last: px,
      upnl,
    };
  }

  async function stateFor(userId) {
    const list = [];
    for (const run of runners.values()) {
      if (run.userId !== userId) continue;
      const px = run.snap.position ? hub.getSymbol(run.snap.position.symbol)?.price : null;
      rollHalt(run.snap, px);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE result = 'win')::int AS wins,
                COALESCE(sum(pnl_usdt),0)::float AS pnl
         FROM trades WHERE strategy_id = $1 AND closed_at IS NOT NULL`,
        [run.strategy.id],
      );
      const kpi = rows[0];
      list.push({
        id: run.strategy.id,
        name: run.strategy.name,
        type: run.strategy.type,
        source: run.strategy.source,
        presetKey: run.strategy.preset_key,
        mareMode: run.strategy.mare_mode,
        paused: run.strategy.paused,
        description: run.strategy.description,
        equity: Number(equityOf(run.snap, px).toFixed(2)),
        cash: Number(run.snap.cash.toFixed(2)),
        pnl: Number((equityOf(run.snap, px) - (Number(run.snap.initial) || INITIAL)).toFixed(2)),
        closedPnl: Number(kpi.pnl.toFixed(2)),
        nTrades: kpi.n,
        winRate: kpi.n ? kpi.wins / kpi.n : 0,
        halted: run.snap.halted,
        position: publicPosition(run.snap),
        startedAt: run.snap.startedAt,
      });
    }
    const user = users.get(userId);
    const alarmRows = alarmRuns.filter((row) => row.user_id === userId);
    const hits = await pool.query(
      `SELECT h.id, h.alarm_id, h.symbol, h.price, h.stop, h.tp, h.stop_pct, h.tp_pct, h.reason, h.seen_at, h.created_at, a.name, a.channels
       FROM alarm_hits h JOIN alarms a ON a.id = h.alarm_id
       WHERE h.user_id = $1 ORDER BY h.created_at DESC LIMIT 12`,
      [userId],
    );
    return {
      connection: hub.status,
      mare: hub.mareFor({}),
      prices: hub.prices(),
      strategies: list,
      alarms: alarmRows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        thesis: (row.explanation?.['pt-BR'] || row.explanation?.en || {}).thesis || row.name,
        stopPct: row.recipe?.exit?.stopPct,
        tpPct: row.recipe?.exit?.tpPct,
        channels: row.channels || { sound: true, email: false, sms: false },
      })),
      hits: hits.rows.map((row) => ({
        id: row.id,
        alarmId: row.alarm_id,
        name: row.name,
        symbol: row.symbol,
        price: Number(row.price),
        stop: Number(row.stop),
        tp: Number(row.tp),
        stopPct: Number(row.stop_pct),
        tpPct: Number(row.tp_pct),
        reason: row.reason,
        createdAt: row.created_at,
        seen: !!row.seen_at,
        channels: row.channels || { sound: true, email: false, sms: false },
      })),
      fees: 'VIP0 com BNB: maker 0,075% · taker 0,075%',
    };
  }

  function pushState(userId) {
    stateFor(userId).then((state) => {
      bus.emit('push', { userId, msg: { type: 'snapshot', ...state } });
    }).catch(() => {});
  }

  function start() {
    loadAll().then(() => console.log(`[desk] ${runners.size} estratégias reidratadas`)).catch((err) => console.error('[desk] load', err));
    timer = setInterval(() => { tick().catch((err) => console.error('[desk] tick', err)); }, 1000);
    setInterval(() => {
      for (const userId of users.keys()) {
        if (!bus.hasUser || !bus.hasUser(userId)) continue;
        const user = users.get(userId);
        bus.emit('push', { userId, msg: { type: 'prices', prices: hub.prices(), connection: hub.status } });
        bus.emit('push', { userId, msg: { type: 'mare', mare: hub.mareFor({}) } });
      }
    }, 1000);
  }

  function stop() {
    clearInterval(timer);
    return Promise.all([...runners.values()].filter((r) => r.dirty).map(persist));
  }

  async function deliverAlarm(alarm, text) {
    const channels = alarm.channels || { sound: true, email: false, sms: false };
    const user = await pool.query('SELECT email, phone_e164 FROM users WHERE id = $1', [alarm.user_id]);
    const email = user.rows[0]?.email || null;
    const phone = user.rows[0]?.phone_e164 || null;
    const deliveries = [];
    if (channels.sound !== false) deliveries.push({ channel: 'sound', status: 'device' });
    if (channels.email) deliveries.push(await pushNotice('email', email, text));
    if (channels.sms) deliveries.push(await pushNotice('sms', phone, text));
    return deliveries;
  }

  return { start, stop, reloadUser, stateFor, loadAll };
}

async function pushNotice(channel, to, text) {
  if (!to) return { channel, status: 'missing', to: null };
  const hook = process.env.NOTIFY_WEBHOOK;
  if (!hook) return { channel, status: 'desk', to };
  try {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, to, text }),
    });
    return { channel, status: res.ok ? 'sent' : 'desk', to };
  } catch (err) {
    console.error('[alarm] aviso', channel, err.message);
    return { channel, status: 'desk', to };
  }
}

module.exports = { createDesk };
