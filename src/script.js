const { validateRecipe, promptNumbers } = require('./shared');
const { bars } = require('./faithful');

const FUNCS = new Set([
  'hhv', 'llv', 'sma', 'ema', 'stdev', 'rsi', 'atr', 'ref', 'change', 'change_pct', 'range_pct', 'drop_pct',
  'body_pct', 'green', 'crossed_up', 'crossed_down', 'between_hours', 'pct24', 'open24', 'day_high', 'day_low',
  'close_of', 'high_of', 'low_of', 'funding_neg', 'listed_hours', 'book_spread', 'obi', 'ask_qty',
  'zscore_pair', 'ratchet', 'hour_brt', 'leader', 'hours', 'minutes',
]);
const SERIES = new Set(['open', 'high', 'low', 'close', 'volume']);
const BUILTIN = new Set([
  'open', 'high', 'low', 'close', 'volume', 'price', 'entry', 'bars_held', 'minutes_held',
  'highest_since', 'lowest_since', 'avg_entry', 'adds', 'first_entry', 'now', 'new_bar',
]);

function tokenize(source) {
  const tokens = [];
  const s = String(source || '');
  if (s.length > 800) throw new Error('expressão longa demais');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\n' || c === '\t') { i += 1; continue; }
    if ('(),'.includes(c)) { tokens.push({ t: c }); i += 1; continue; }
    const two = s.slice(i, i + 2);
    if (['>=', '<=', '==', '!='].includes(two)) { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/><'.includes(c)) { tokens.push({ t: 'op', v: c }); i += 1; continue; }
    if (c === "'" || c === '"') {
      const q = c;
      i += 1;
      let str = '';
      while (i < s.length && s[i] !== q) str += s[i++];
      if (s[i] !== q) throw new Error('texto sem fechar');
      i += 1;
      tokens.push({ t: 'str', v: str });
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let n = '';
      while (i < s.length && /[0-9.]/.test(s[i])) n += s[i++];
      const v = Number(n);
      if (!Number.isFinite(v)) throw new Error(`número inválido ${n}`);
      tokens.push({ t: 'num', v });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let id = '';
      while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) id += s[i++];
      tokens.push({ t: 'id', v: id });
      continue;
    }
    throw new Error('símbolo inválido na expressão');
  }
  return tokens;
}

function parseExpr(source) {
  const tokens = tokenize(source);
  let i = 0;
  const peek = () => tokens[i];
  const eat = () => tokens[i++];
  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().t === 'id' && peek().v === 'or') { eat(); left = { type: 'or', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (peek() && peek().t === 'id' && peek().v === 'and') { eat(); left = { type: 'and', left, right: parseNot() }; }
    return left;
  }
  function parseNot() {
    if (peek() && peek().t === 'id' && peek().v === 'not') { eat(); return { type: 'not', value: parseNot() }; }
    return parseCmp();
  }
  function parseCmp() {
    let left = parseAdd();
    const op = peek();
    if (op && op.t === 'op' && ['>', '<', '>=', '<=', '==', '!='].includes(op.v)) {
      eat();
      left = { type: 'cmp', op: op.v, left, right: parseAdd() };
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = eat().v;
      left = { type: 'bin', op, left, right: parseMul() };
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = eat().v;
      left = { type: 'bin', op, left, right: parseUnary() };
    }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().t === 'op' && peek().v === '-') { eat(); return { type: 'neg', value: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const tok = eat();
    if (!tok) throw new Error('expressão incompleta');
    if (tok.t === 'num') return { type: 'num', v: tok.v };
    if (tok.t === 'str') return { type: 'str', v: tok.v };
    if (tok.t === '(') {
      const inner = parseOr();
      if (!peek() || peek().t !== ')') throw new Error('falta fechar parêntese');
      eat();
      return inner;
    }
    if (tok.t === 'id') {
      if (peek() && peek().t === '(') {
        eat();
        const args = [];
        if (!peek() || peek().t !== ')') {
          args.push(parseOr());
          while (peek() && peek().t === ',') { eat(); args.push(parseOr()); }
        }
        if (!peek() || peek().t !== ')') throw new Error(`falta fechar ${tok.v}`);
        eat();
        if (!FUNCS.has(tok.v)) throw new Error(`função desconhecida: ${tok.v}`);
        return { type: 'call', name: tok.v, args };
      }
      return { type: 'id', name: tok.v };
    }
    throw new Error('expressão incompleta');
  }
  const ast = parseOr();
  if (i < tokens.length) throw new Error('sobrou texto na expressão');
  return ast;
}

function walk(ast, visit) {
  if (!ast) return;
  visit(ast);
  if (ast.left) walk(ast.left, visit);
  if (ast.right) walk(ast.right, visit);
  if (ast.value) walk(ast.value, visit);
  if (ast.args) ast.args.forEach((arg) => walk(arg, visit));
}

function literalsOf(ast) {
  const nums = [];
  walk(ast, (node) => { if (node.type === 'num') nums.push(node.v); });
  return nums;
}

function declaredVars(script) {
  const names = new Set();
  for (const row of script.assign || []) if (row.name) names.add(row.name);
  for (const row of script.onFill || []) if (row.name) names.add(row.name);
  return names;
}

function checkIdents(ast, vars) {
  walk(ast, (node) => {
    if (node.type === 'id' && !BUILTIN.has(node.name) && !vars.has(node.name)) {
      throw new Error(`nome desconhecido: ${node.name}`);
    }
  });
}

function compileOne(source, vars) {
  if (!String(source || '').trim()) return { ast: null, literals: [] };
  const ast = parseExpr(source);
  checkIdents(ast, vars);
  return { ast, literals: literalsOf(ast) };
}

function compileScript(script) {
  try {
    const vars = declaredVars(script);
    const parts = [script.enter, script.add, script.exit, script.stop, script.target];
    for (const row of script.assign || []) parts.push(row.when, row.value);
    for (const row of script.onFill || []) parts.push(row.value);
    const compiled = {};
    const literals = [];
    const keys = ['enter', 'add', 'exit', 'stop', 'target'];
    keys.forEach((key) => {
      const one = compileOne(script[key], vars);
      compiled[key] = one.ast;
      literals.push(...one.literals);
    });
    compiled.assign = (script.assign || []).map((row) => {
      const when = compileOne(row.when, vars);
      const value = compileOne(row.value, vars);
      literals.push(...when.literals, ...value.literals);
      return { name: row.name, when: when.ast, value: value.ast };
    });
    compiled.onFill = (script.onFill || []).map((row) => {
      const value = compileOne(row.value, vars);
      literals.push(...value.literals);
      return { name: row.name, value: value.ast };
    });
    if (!compiled.enter && !(script.grid && script.grid.levels) && !(script.dca && script.dca.everyMin)) {
      return { ok: false, error: 'Falta a condição de entrada.' };
    }
    return { ok: true, compiled, literals };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function num(text) {
  return Number(String(text).replace(',', '.'));
}

function related(scriptNum, promptNum) {
  if (!Number.isFinite(scriptNum) || !Number.isFinite(promptNum)) return false;
  const opts = [promptNum, promptNum / 100, promptNum * 60, 1 - promptNum / 100, 1 + promptNum / 100];
  return opts.some((v) => Math.abs(v - scriptNum) < 1e-6);
}

function allowedLiteral(n, prompts) {
  if (n === 0 || n === 1 || n === 100) return true;
  return prompts.some((p) => related(n, p));
}

function checkFidelity(script, literals, userText, locale) {
  const prompts = promptNumbers(userText, locale);
  const used = [...literals];
  if (script.tfMin) used.push(script.tfMin);
  if (script.buyFrac && !script.sizeNote) used.push(script.buyFrac);
  if (script.maxAdds && script.maxAdds !== 1) used.push(script.maxAdds);
  if (script.grid) used.push(script.grid.levels, script.grid.stepPct, script.grid.boxPct);
  if (script.dca) used.push(script.dca.everyMin, script.dca.tpPct);
  const foreign = used.filter((n) => Number.isFinite(n) && n !== 0 && !allowedLiteral(n, prompts));
  if (foreign.length) {
    return { ok: false, error: `A expressão usou ${[...new Set(foreign)].join(', ')}, e esse número não está no pedido.` };
  }
  const missing = prompts.filter((p) => p !== 0 && p !== 1 && !used.some((n) => related(n, p) || Math.abs(n - p) < 1e-6));
  if (missing.length) {
    return { ok: false, error: `O pedido tem ${missing.join(', ')} e a regra não usou esse número.` };
  }
  return { ok: true };
}

function closedBars(row, tfMin) {
  return bars(row, tfMin);
}

function barAt(row, tfMin, shift) {
  const list = closedBars(row, tfMin);
  const idx = list.length - 1 - shift;
  return idx >= 0 ? list[idx] : null;
}

function valuesBefore(row, tfMin, shift, count, includeCurrent, pick) {
  const list = closedBars(row, tfMin);
  const end = list.length - 1 - shift;
  if (end < 0) return [];
  const last = includeCurrent ? end : end - 1;
  const first = last - count + 1;
  if (first < 0 || last < 0) return [];
  const out = [];
  for (let i = first; i <= last; i++) out.push(pick(list[i]));
  return out;
}

function pickOf(name) {
  if (name === 'open') return (k) => k.o;
  if (name === 'high') return (k) => k.h;
  if (name === 'low') return (k) => k.l;
  if (name === 'volume') return (k) => k.v || 0;
  return (k) => k.c;
}

function seriesName(ast) {
  if (ast && ast.type === 'id' && SERIES.has(ast.name)) return ast.name;
  return null;
}

function emaAt(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  for (let i = period; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return prev;
}

function rsiAt(values, period) {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function atrAt(candles, period) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1].c;
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev), Math.abs(cur.l - prev)));
  }
  if (trs.length < period) return null;
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

function meanStdev(vals) {
  if (vals.length < 2) return null;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const v = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / (vals.length - 1);
  return { mean, sd: Math.sqrt(v) };
}

function symbolOf(text) {
  const s = String(text || '').toUpperCase();
  if (!s) return '';
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

function brtHour(now) {
  return new Date(now - 3 * 3600 * 1000).getUTCHours();
}

function minuteBars(row, minutes, now) {
  const from = now - minutes * 60000;
  return (row.klines || []).filter((k) => k.closed !== false && k.t >= from && k.c > 0);
}

function evalAst(ast, env) {
  if (!ast) return null;
  if (ast.type === 'num') return ast.v;
  if (ast.type === 'str') return ast.v;
  if (ast.type === 'neg') {
    const v = evalAst(ast.value, env);
    return v == null ? null : -v;
  }
  if (ast.type === 'not') return !truth(evalAst(ast.value, env));
  if (ast.type === 'and') return truth(evalAst(ast.left, env)) && truth(evalAst(ast.right, env));
  if (ast.type === 'or') return truth(evalAst(ast.left, env)) || truth(evalAst(ast.right, env));
  if (ast.type === 'bin') {
    const a = evalAst(ast.left, env);
    const b = evalAst(ast.right, env);
    if (a == null || b == null) return null;
    if (ast.op === '+') return a + b;
    if (ast.op === '-') return a - b;
    if (ast.op === '*') return a * b;
    if (ast.op === '/' && b !== 0) return a / b;
    return null;
  }
  if (ast.type === 'cmp') {
    const a = evalAst(ast.left, env);
    const b = evalAst(ast.right, env);
    if (a == null || b == null) return false;
    if (ast.op === '>') return a > b;
    if (ast.op === '<') return a < b;
    if (ast.op === '>=') return a >= b;
    if (ast.op === '<=') return a <= b;
    if (ast.op === '==') return a === b;
    if (ast.op === '!=') return a !== b;
  }
  if (ast.type === 'id') return ident(ast.name, env);
  if (ast.type === 'call') return call(ast, env);
  return null;
}

function truth(v) {
  return v === true || (typeof v === 'number' && v !== 0);
}

function ident(name, env) {
  const { row, position, mem, now } = env;
  const bar = barAt(row, env.tfMin, env.shift);
  if (name === 'open') return bar ? bar.o : null;
  if (name === 'high') return bar ? bar.h : null;
  if (name === 'low') return bar ? bar.l : null;
  if (name === 'close') return bar ? bar.c : null;
  if (name === 'volume') return bar ? (bar.v || 0) : null;
  if (name === 'price') return row.price;
  if (name === 'now') return now;
  if (name === 'new_bar') return !!(bar && mem.barT !== bar.t);
  if (name === 'entry') return position ? position.entry : null;
  if (name === 'first_entry') return position ? (position.firstEntry || position.entry) : null;
  if (name === 'adds') return position ? (position.adds || 1) : 0;
  if (name === 'avg_entry') return position && position.qty > 0 ? position.quote / position.qty : (position ? position.entry : null);
  if (name === 'highest_since') return position ? Math.max(position.high || position.entry, row.price) : null;
  if (name === 'lowest_since') return position ? Math.min(position.low || position.entry, row.price) : null;
  if (name === 'minutes_held') {
    if (!position) return null;
    return (now - new Date(position.openedAt).getTime()) / 60000;
  }
  if (name === 'bars_held') {
    if (!position) return null;
    const opened = new Date(position.openedAt).getTime();
    return closedBars(row, env.tfMin).filter((k) => k.t + env.tfMin * 60000 > opened).length;
  }
  if (mem.vars && Object.prototype.hasOwnProperty.call(mem.vars, name)) return mem.vars[name];
  return 0;
}

function call(ast, env) {
  const name = ast.name;
  const args = ast.args;
  if (name === 'hours') return (evalAst(args[0], env) || 0) * 3600000;
  if (name === 'minutes') return (evalAst(args[0], env) || 0) * 60000;
  if (name === 'between_hours') {
    const hour = brtHour(env.now);
    const a = evalAst(args[0], env);
    const b = evalAst(args[1], env);
    return hour >= a && hour < b;
  }
  if (name === 'hour_brt') return brtHour(env.now);
  if (name === 'pct24') return env.row.pct24;
  if (name === 'open24') return env.row.open24h || null;
  if (name === 'day_high') return env.row.dayHigh || null;
  if (name === 'day_low') return env.row.dayLow || null;
  if (name === 'leader') {
    const mine = env.row.pct24;
    const symbols = env.hub && env.hub.tradeSymbols ? env.hub.tradeSymbols : [];
    return symbols.every((symbol) => {
      const other = env.hub.getSymbol(symbol);
      return !other || other.pct24 <= mine;
    });
  }
  if (name === 'funding_neg') {
    const rates = env.hub && env.hub.fundingRates ? env.hub.fundingRates(env.row.symbol) : null;
    const n = evalAst(args[0], env);
    if (!rates || rates.length < n) return false;
    return rates.slice(-n).every((r) => r < 0);
  }
  if (name === 'listed_hours') {
    const at = env.hub && env.hub.listedAt ? env.hub.listedAt(env.row.symbol) : null;
    if (!at) return null;
    return (env.now - at) / 3600000;
  }
  if (name === 'book_spread') {
    const samples = env.row.spreadSamples || [];
    return samples.length ? samples[samples.length - 1].spreadPct : null;
  }
  if (name === 'obi') return env.row.obi;
  if (name === 'ask_qty') {
    const samples = env.row.spreadSamples || [];
    return samples.length ? samples[samples.length - 1].askQty : null;
  }
  if (name === 'change_pct') {
    const minutes = evalAst(args[0], env);
    const window = minuteBars(env.row, minutes, env.now);
    if (!window.length || !(env.row.price > 0)) return null;
    const first = window[0].o || window[0].c;
    if (!(first > 0)) return null;
    return ((env.row.price - first) / first) * 100;
  }
  if (name === 'range_pct' || name === 'drop_pct') {
    const minutes = evalAst(args[0], env);
    const window = minuteBars(env.row, minutes, env.now);
    if (!window.length) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (const k of window) {
      if (k.h > hi) hi = k.h;
      if (k.l < lo) lo = k.l;
    }
    if (!(hi > 0) || !(lo > 0)) return null;
    if (name === 'range_pct') return ((hi - lo) / lo) * 100;
    return ((hi - env.row.price) / hi) * 100;
  }
  if (name === 'body_pct') {
    const bar = barAt(env.row, env.tfMin, env.shift);
    if (!bar || !(bar.o > 0)) return null;
    return ((bar.o - bar.c) / bar.o) * 100;
  }
  if (name === 'green') {
    const n = evalAst(args[0], env);
    const list = closedBars(env.row, env.tfMin);
    const end = list.length - 1 - env.shift;
    if (end - n + 1 < 0) return false;
    for (let i = end - n + 1; i <= end; i++) if (!(list[i].c > list[i].o)) return false;
    return true;
  }
  if (name === 'ratchet') {
    const v = evalAst(args[0], env);
    if (v == null || !env.position) return v;
    env.position.ratchet = env.position.ratchet == null ? v : Math.max(env.position.ratchet, v);
    return env.position.ratchet;
  }
  if (name === 'crossed_up' || name === 'crossed_down') {
    const prev = { ...env, shift: env.shift + 1 };
    const a0 = evalAst(args[0], env);
    const b0 = evalAst(args[1], env);
    const a1 = evalAst(args[0], prev);
    const b1 = evalAst(args[1], prev);
    if ([a0, b0, a1, b1].some((v) => v == null)) return false;
    return name === 'crossed_up' ? a1 <= b1 && a0 > b0 : a1 >= b1 && a0 < b0;
  }
  if (name === 'close_of' || name === 'high_of' || name === 'low_of') {
    const symbol = symbolOf(evalAst(args[0], env));
    const other = env.hub && env.hub.getSymbol ? env.hub.getSymbol(symbol) : null;
    if (!other) return null;
    const bar = barAt(other, env.tfMin, env.shift);
    if (!bar) return null;
    if (name === 'high_of') return bar.h;
    if (name === 'low_of') return bar.l;
    return bar.c;
  }
  if (name === 'zscore_pair') {
    const a = symbolOf(evalAst(args[0], env));
    const b = symbolOf(evalAst(args[1], env));
    const n = evalAst(args[2], env);
    const left = env.hub.getSymbol(a);
    const right = env.hub.getSymbol(b);
    if (!left || !right) return null;
    const lb = closedBars(left, env.tfMin);
    const rb = new Map(closedBars(right, env.tfMin).map((k) => [k.t, k.c]));
    const ratios = [];
    for (const k of lb) if (rb.get(k.t) > 0) ratios.push(k.c / rb.get(k.t));
    if (ratios.length < n) return null;
    const window = ratios.slice(-n);
    const stats = meanStdev(window);
    if (!stats || !(stats.sd > 0)) return null;
    return (window[window.length - 1] - stats.mean) / stats.sd;
  }
  const src = seriesName(args[0]);
  const n = evalAst(args[src ? 1 : 0], env);
  if (!(n > 0)) return null;
  if (name === 'hhv' || name === 'llv' || name === 'sma' || name === 'stdev' || name === 'ref') {
    if (!src) return null;
    if (name === 'ref') {
      const bar = barAt(env.row, env.tfMin, env.shift + n);
      return bar ? pickOf(src)(bar) : null;
    }
    const vals = valuesBefore(env.row, env.tfMin, env.shift, n, false, pickOf(src));
    if (vals.length < n) return null;
    if (name === 'hhv') return Math.max(...vals);
    if (name === 'llv') return Math.min(...vals);
    if (name === 'sma') return vals.reduce((s, v) => s + v, 0) / vals.length;
    const stats = meanStdev(vals);
    return stats ? stats.sd : null;
  }
  if (name === 'change') {
    if (!src) return null;
    const cur = barAt(env.row, env.tfMin, env.shift);
    const prev = barAt(env.row, env.tfMin, env.shift + n);
    if (!cur || !prev) return null;
    return pickOf(src)(cur) - pickOf(src)(prev);
  }
  if (name === 'ema' || name === 'rsi' || name === 'atr') {
    const list = closedBars(env.row, env.tfMin);
    const end = list.length - 1 - env.shift;
    if (end < 0) return null;
    if (name === 'atr') {
      const slice = list.slice(0, end);
      return atrAt(slice, n);
    }
    const closes = list.slice(0, end + 1).map((k) => k.c);
    if (name === 'rsi') return rsiAt(closes, n);
    return emaAt(closes, n);
  }
  return null;
}

function slot(memory, symbol) {
  if (!memory.scriptMem) memory.scriptMem = {};
  if (!memory.scriptMem[symbol]) memory.scriptMem[symbol] = { vars: {}, barT: 0 };
  return memory.scriptMem[symbol];
}

function runAssign(compiled, env) {
  for (const row of compiled.assign || []) {
    if (!row.when || truth(evalAst(row.when, env))) {
      const v = evalAst(row.value, env);
      if (v != null) env.mem.vars[row.name] = v;
    }
  }
}

function decide(script, compiled, base) {
  const mem = slot(base.memory, base.row.symbol);
  const env = {
    row: base.row,
    hub: base.hub,
    now: base.now,
    tfMin: script.tfMin || 1,
    shift: 0,
    mem,
    position: base.position || null,
  };
  runAssign(compiled, env);
  return { env, mem };
}

function priceLevel(ast, env) {
  if (!ast) return null;
  const v = evalAst(ast, env);
  return v > 0 ? v : null;
}

const compiledCache = new Map();

function compiledOf(script) {
  const key = JSON.stringify(script);
  if (!compiledCache.has(key)) {
    const got = compileScript(script);
    compiledCache.set(key, got.ok ? got.compiled : null);
  }
  return compiledCache.get(key);
}

function scanScript(recipe, hub, now, memory) {
  const script = recipe.script;
  const compiled = compiledOf(script);
  if (!compiled) return { want: null, scan: [] };
  const symbols = script.symbol ? [symbolOf(script.symbol)] : (hub.tradeSymbols || []);
  const scans = [];
  let best = null;
  for (const symbol of symbols) {
    const row = hub.getSymbol(symbol);
    if (!row || !(row.price > 0)) continue;
    const { env } = decide(script, compiled, { row, hub, now, memory, position: null });
    const ok = truth(evalAst(compiled.enter, env));
    const shadow = { entry: row.price, firstEntry: row.price, adds: 1, qty: 1, quote: row.price, high: row.price, low: row.price, openedAt: new Date(now).toISOString(), ratchet: null };
    const sized = { ...env, position: shadow };
    const stop = priceLevel(compiled.stop, sized);
    const tp = priceLevel(compiled.target, sized);
    scans.push({ symbol, passed: ok ? 1 : 0, total: 1, checks: [{ op: 'script', pass: ok, detail: ok ? 'condição verdadeira' : 'condição falsa' }] });
    if (!ok || best) continue;
    const side = script.side === 'short' ? 'short' : 'long';
    const stopOk = script.stop ? (side === 'short' ? stop > row.price : stop > 0 && stop < row.price) : true;
    const tpOk = !script.target || (side === 'short' ? tp < row.price : tp > row.price);
    if (!stopOk || !tpOk) continue;
    best = {
      symbol,
      entry: row.price,
      stop: stop || 0,
      tp: tp || null,
      side,
      noTarget: !script.target,
      noStop: !script.stop,
      quoteFrac: script.buyFrac || 0,
      timeExit: false,
      maxHoldMin: 1440,
      noRepeatMin: 30,
      stopCooldownMin: 60,
      rule: 'script',
      reason: 'regra do pedido',
    };
    break;
  }
  return { want: best, scan: scans.slice(0, 6) };
}

function decideScript(script, base) {
  const compiled = compiledOf(script);
  if (!compiled) return { exit: null, add: false };
  const { env, mem } = decide(script, compiled, base);
  const stop = priceLevel(compiled.stop, env);
  const target = priceLevel(compiled.target, env);
  const side = script.side === 'short' ? 'short' : 'long';
  let exit = null;
  if (truth(evalAst(compiled.exit, env))) exit = base.price >= (base.position.entry || base.price) ? 'tp' : 'sl';
  if (!exit && stop && (side === 'short' ? base.price >= stop : base.price <= stop)) exit = 'sl';
  if (!exit && target && (side === 'short' ? base.price <= target : base.price >= target)) exit = 'tp';
  const add = !exit && compiled.add && (base.position.adds || 1) < (script.maxAdds || 1) && truth(evalAst(compiled.add, env));
  return { exit, add, stop, mem };
}

function markFill(script, memory, row, hub, now, price) {
  const compiled = compiledOf(script);
  if (!compiled) return;
  const mem = slot(memory, row.symbol);
  const bar = barAt(row, script.tfMin || 1, 0);
  if (bar) mem.barT = bar.t;
  const env = { row, hub, now, tfMin: script.tfMin || 1, shift: 0, mem, position: { entry: price, quote: price, qty: 1, adds: 1, high: price, low: price, openedAt: new Date(now).toISOString() } };
  for (const rowFill of compiled.onFill || []) {
    const v = evalAst(rowFill.value, env);
    if (v != null) mem.vars[rowFill.name] = v;
  }
}

function normalizeScript(data) {
  const assign = Array.isArray(data.assign) ? data.assign.filter((row) => row && row.name && row.value).map((row) => ({
    when: String(row.when || ''),
    name: String(row.name),
    value: String(row.value),
  })) : [];
  const onFill = Array.isArray(data.onFill) ? data.onFill.filter((row) => row && row.name && row.value).map((row) => ({
    name: String(row.name),
    value: String(row.value),
  })) : [];
  const gridLevels = Number(data.gridLevels) || 0;
  const dcaEvery = Number(data.dcaEvery) || 0;
  const script = {
    tfMin: Number(data.tfMin) || 1,
    side: data.side === 'short' ? 'short' : 'long',
    symbol: data.symbol ? symbolOf(data.symbol) : '',
    enter: String(data.enter || ''),
    add: String(data.add || ''),
    exit: String(data.exit || ''),
    stop: String(data.stop || ''),
    target: String(data.target || ''),
    buyFrac: Number(data.buyFrac) || 0,
    maxAdds: Number(data.maxAdds) || 1,
    assign,
    onFill,
    grid: gridLevels > 0 ? { levels: gridLevels, stepPct: Number(data.gridStep) || 0, boxPct: Number(data.gridBox) || 0 } : null,
    dca: dcaEvery > 0 ? { everyMin: dcaEvery, tpPct: Number(data.dcaTp) || 0 } : null,
  };
  if (!script.stop && !(script.buyFrac > 0) && !script.grid && !script.dca) {
    script.buyFrac = 0.1;
    script.sizeNote = 'O pedido não fixou stop de preço nem o tamanho da compra. Cada compra usa 10% do caixa.';
  }
  return script;
}

function recipeFromModel(data, userText, locale) {
  if (!data || typeof data !== 'object') return { ask: 'Não fechei a regra.' };
  if (String(data.ask || '').trim() && !String(data.enter || '').trim() && !(Number(data.gridLevels) > 0) && !(Number(data.dcaEvery) > 0)) {
    return { ask: String(data.ask).trim() };
  }
  const script = normalizeScript(data);
  const compiled = compileScript(script);
  if (!compiled.ok) return { ask: compiled.error, retry: true };
  const fidelity = checkFidelity(script, compiled.literals, userText, locale);
  if (!fidelity.ok) return { ask: fidelity.error, retry: true };
  const text = {
    thesis: String(data.thesis || data.entryText || script.enter || 'Regra do pedido.'),
    entry: String(data.entryText || script.enter || ''),
    exit: String(data.exitText || script.exit || script.stop || ''),
    filters: 'Sem filtro além do que está na conta.',
    risks: `${String(data.risks || '')} Paper. A conta abaixo é a que vai rodar.`.trim(),
    paramsPlain: [script.enter, script.exit, script.stop, script.target].filter(Boolean).join(' · '),
  };
  if (script.sizeNote) text.thesis = `${text.thesis} ${script.sizeNote}`;
  const plan = {
    kind: script.grid ? 'grid' : script.dca ? 'dca' : 'script',
    exact: true,
    side: script.side,
    noTarget: !script.target,
    noStop: !script.stop,
    quoteFrac: script.buyFrac || 0,
  };
  if (script.grid) plan.grid = script.grid;
  if (script.dca) plan.dca = script.dca;
  const name = String(data.name || 'Regra do pedido').slice(0, 80);
  const recipe = {
    name,
    explanation: { [locale || 'pt-BR']: text, en: text },
    entry: { all: [{ op: 'script' }], any: [] },
    filters: [],
    exit: { stopPct: 1, tpPct: 1, maxHoldMin: 1440, timeExit: false },
    pacing: { noRepeatMin: 30, stopCooldownMin: 60 },
    plan,
    script,
  };
  const check = validateRecipe(recipe);
  if (!check.ok) return { ask: 'Não fechei a regra.', retry: true };
  return { recipe };
}

function simpleRiseRecipe(text, locale) {
  const raw = String(text || '');
  if (raw.length > 160) return null;
  const m = raw.match(/(?:sobe|suba|subiu|alta de)\s*(\d+(?:[.,]\d+)?)\s*%[^\d]{0,24}(\d+)\s*(?:minutos|minuto|min)\b/i);
  if (!m) return null;
  const pct = num(m[1]);
  const windowMin = Number(m[2]);
  const data = {
    ask: '',
    name: `Alta de ${pct}%`,
    thesis: `Compra quando o preço sobe ${pct}% em ${windowMin} minutos.`,
    entryText: `Variação de ${windowMin} minutos igual ou maior que ${pct}%.`,
    exitText: 'Sem stop nem alvo no pedido. A posição usa 10% do caixa até você definir a saída.',
    tfMin: 1,
    side: 'long',
    enter: `change_pct(${windowMin}) >= ${pct}`,
    buyFrac: 0,
  };
  const built = recipeFromModel(data, raw, locale);
  return built.recipe || null;
}

module.exports = {
  parseExpr, compileScript, checkFidelity, recipeFromModel, simpleRiseRecipe, scanScript, decideScript, markFill, normalizeScript,
};
