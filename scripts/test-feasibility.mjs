import { infeasiblePrompt, nonExecutableJs, unknownCtxMembers, CTX_MEMBERS, scrubCtxJargon } from '../src/feasibility.js';
import { interpret } from '../src/interpret.js';
import { makeCtx, buildJsRecipe } from '../src/sandbox.js';
import assert from 'assert';

assert(infeasiblePrompt('comprar quando a lua estiver cheia', 'pt-BR')?.failed);
assert(infeasiblePrompt('spread ETH/BTC igual a pi exato', 'pt-BR')?.failed);
assert(!infeasiblePrompt('comprar no rompimento 15m', 'pt-BR'));
assert(infeasiblePrompt('oi', 'pt-BR')?.failed);

const liqPrompt = 'Comprar BTC spot quando houver uma liquidação grande de shorts no Binance Futures e o funding estiver negativo.';
const liq = infeasiblePrompt(liqPrompt, 'pt-BR');
assert(liq?.failed, 'liquidação/funding deve falhar antes do LLM');
assert(/simulador/i.test(liq.error) && /liquida/i.test(liq.error) && /funding/i.test(liq.error), liq.error);
assert(!/ctx\./.test(liq.error), liq.error);
assert(infeasiblePrompt('Buy when funding rate is negative', 'en')?.failed);
assert(!infeasiblePrompt('comprar quando subir 1% em 5 minutos', 'pt-BR'));

const gridPrompt = 'Monte um grid de 12 pernas comprando e vendendo BTC a cada 0,4% entre 60000 e 70000.';
const grid = infeasiblePrompt(gridPrompt, 'pt-BR');
assert(grid?.failed, 'grid de várias pernas deve falhar');
assert(/uma posi[cç][aã]o/i.test(grid.error) && /n[aã]o suport/i.test(grid.error), grid.error);
assert(!infeasiblePrompt('comprar no rompimento das últimas 8 velas de 15m', 'pt-BR'));

const p = `No 1h, compra se o candle fechar acima da máxima das 20 velas anteriores e o volume for 1,5x a média`;
assert(interpret(p)?.plan?.kind === 'donchian', 'donchian matcher');

const dead = `function strategy(ctx) { const lua = false; if (!lua) return {action:"hold"}; }`;
assert(nonExecutableJs(dead) === 'lua');

const zombie = `function strategy(ctx) {
  const liq = ctx.liquidations;
  const funding = ctx.fundingRate;
  if (!ctx.price || liq == null || funding == null) return { action: "hold" };
  return { action: "hold" };
}`;
assert(nonExecutableJs(zombie) === 'liquidation');
assert(unknownCtxMembers(zombie).sort().join() === 'fundingRate,liquidations');

const bracket = 'function strategy(ctx) { const x = ctx["fundingRate"]; return { action: "hold" }; }';
assert(nonExecutableJs(bracket) === 'liquidation');

const optional = 'function strategy(ctx) { const x = ctx?.liquidations; return { action: "hold" }; }';
assert(nonExecutableJs(optional) === 'liquidation');

const unpacked = 'function strategy(ctx) { const { price, liquidations } = ctx; return { action: "hold" }; }';
assert(nonExecutableJs(unpacked) === 'liquidation');

const mentioned = 'function strategy(ctx) { const note = "ctx.liquidations"; // ctx.fundingRate\n return { action: "hold" }; }';
assert(nonExecutableJs(mentioned) == null, 'menção em string ou comentário não é acesso');

const bookUnpack = `function strategy(ctx) {
  const book = ctx.book();
  const { bids } = book;
  if (!bids || ctx.position) return { action: "hold" };
  return { action: "hold" };
}`;
assert(nonExecutableJs(bookUnpack) == null, unknownCtxMembers(bookUnpack).join());

const breakout = `function strategy(ctx) {
  const c = ctx.candles("15m");
  if (!c.length || ctx.position) return { action: "hold" };
  const level = ctx.highest(c.slice(0, -1).map((v) => v.high), 8);
  if (!(ctx.price > level)) return { action: "hold" };
  return { action: "buy", stop: ctx.price * (1 - 1 / 100), target: ctx.price * (1 + 2 / 100) };
}`;
assert(nonExecutableJs(breakout) == null);

const ctx = makeCtx({
  symbol: 'BTCUSDT', price: 1, pct24: 0, open24h: 1, prints: [], bookSnaps: [], prices: [],
}, 0, null, {});
const live = Object.keys(ctx).sort();
const listed = [...CTX_MEMBERS].sort();
assert.deepStrictEqual(live, listed, `allowlist divergiu de makeCtx: ${live} vs ${listed}`);

assert(!/ctx\./.test(scrubCtxJargon('Só dispara se ctx.liquidations e ctx.fundingRate existirem.')));
assert(/RSI/.test(scrubCtxJargon('quando ctx.rsi cruzar')));

const refused = buildJsRecipe({
  name: 'Zumbi',
  thesis: 'Compra se ctx.liquidations e ctx.fundingRate.',
  code: zombie,
}, liqPrompt, 'pt-BR', { autoFill: true });
assert(refused.failed && !refused.recipe, JSON.stringify(refused));
assert(!/ctx\./.test(refused.error));

const fakeGrid = buildJsRecipe({
  name: 'Grid 12 pernas',
  thesis: 'Grade de 12 pernas entre 60000 e 70000.',
  code: `function strategy(ctx) {
    if (ctx.position) return { action: "hold" };
    return { action: "buy", stop: ctx.price * 0.988, target: ctx.price * 1.018 };
  }`,
}, gridPrompt, 'pt-BR', { autoFill: true });
assert(fakeGrid.failed && !fakeGrid.recipe, JSON.stringify(fakeGrid));
assert(/uma posi/i.test(fakeGrid.error));

const kept = buildJsRecipe({
  name: 'Rompimento',
  thesis: 'Compra no rompimento quando ctx.price passa da máxima.',
  entryText: 'Fecha acima da máxima de 15m.',
  exitText: 'Stop 1% e alvo 2%.',
  code: breakout,
}, 'comprar no rompimento das últimas 8 velas de 15m. Stop 1% e alvo 2%.', 'pt-BR', { autoFill: true, exit: 'manual', stopPct: 1, tpPct: 2 });
assert(kept.recipe && !kept.failed, JSON.stringify(kept));
assert(!/ctx\./.test(JSON.stringify(kept.recipe.explanation)));
assert(/preço/.test(kept.recipe.explanation['pt-BR'].thesis));

console.log('test-feasibility: ok');
