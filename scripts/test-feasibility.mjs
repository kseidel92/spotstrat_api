import { infeasiblePrompt, nonExecutableJs, unknownCtxMembers, CTX_MEMBERS, scrubCtxJargon, exitIsIndicatorOnly, scrubAlarmExplanation, explanationCorrectionOk, prepareReaderCopy } from '../src/feasibility.js';
import { parseLocaleNumber } from '../src/shared.js';
import { interpret } from '../src/interpret.js';
import { makeCtx, buildJsRecipe, syncExitFromCode } from '../src/sandbox.js';
import { cleanOptions } from '../src/http.js';
import assert from 'assert';

assert(infeasiblePrompt('comprar quando a lua estiver cheia', 'pt-BR')?.failed);
assert(infeasiblePrompt('spread ETH/BTC igual a pi exato', 'pt-BR')?.failed);
assert(!infeasiblePrompt('comprar no rompimento 15m', 'pt-BR'));
assert(infeasiblePrompt('oi', 'pt-BR')?.failed);
const compraJa = infeasiblePrompt('compra ja', 'pt-BR');
assert(compraJa?.failed, 'compra ja não tem gatilho');
assert(compraJa.error === infeasiblePrompt('oi', 'pt-BR').error);
assert(!infeasiblePrompt('comprar quando subir 1% em 5m', 'pt-BR'));
assert(infeasiblePrompt('buy now', 'en')?.failed);
const scratchSafe = `Crie uma estratégia de compra spot para o simulador SpotStrat.
Perfil seguro: só comprar com confirmação de fluxo (livro e tape) e priorizar acerto sobre frequência.
Saída: Stop 0.6% e alvo 1% a partir da entrada.`;
assert(!infeasiblePrompt(scratchSafe, 'pt-BR'));

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

const safeText = `Crie uma estratégia de compra spot para o simulador SpotStrat.
Perfil seguro: só comprar com confirmação de fluxo (livro e tape) e priorizar acerto sobre frequência.
Só operar compra quando a maré do mercado estiver boa.
Saída: Stop 0.6% e alvo 1.0% a partir da entrada.`;
const safeCode = `function strategy(ctx) {
  const c = ctx.candles("5m");
  if (!c || c.length < 3) return { action: "hold" };
  if (ctx.position) {
    const entry = ctx.position.entry;
    if (ctx.price <= entry * (1 - 0.6 / 100) || ctx.price >= entry * (1 + 1.0 / 100)) return { action: "sell" };
    return { action: "hold" };
  }
  if (c[c.length - 1].close > c[c.length - 2].close) {
    return { action: "buy", stop: ctx.price * (1 - 0.6 / 100), target: ctx.price * (1 + 1.0 / 100) };
  }
  return { action: "hold" };
}`;
const safeBuilt = buildJsRecipe({
  name: 'QA safe',
  thesis: 'Compra com confirmação de fluxo.',
  code: safeCode,
}, safeText, 'pt-BR', { guided: true, autoFill: true, exit: 'manual', stopPct: 0.6, tpPct: 1, mareMode: 'good' });
assert(safeBuilt.recipe && !safeBuilt.failed, JSON.stringify(safeBuilt));
assert(/ctx\.book\s*\(/.test(safeBuilt.recipe.code));
assert(/ctx\.trades\s*\(/.test(safeBuilt.recipe.code));
assert(!/conversa/i.test(JSON.stringify(safeBuilt.recipe.explanation)));

const contradiction = 'QA20 Rompimento de 15m. Eu escrevi stop 0,5% e alvo 20%, mas na verdade quero sair só quando o RSI passar de 80, sem stop percentual.';
assert(exitIsIndicatorOnly(contradiction), 'contradição final pede saída só por RSI');
const contradictionOptions = cleanOptions({
  guided: false,
  exit: 'history',
  wallet: 1000,
  autoFill: true,
}, contradiction, 'pt-BR');
const guidedLocks = cleanOptions({ guided: true, stopPct: 1.2, tpPct: 1.8, wallet: 1000 }, '', 'pt-BR');
assert.strictEqual(guidedLocks.exit, 'manual');
assert.strictEqual(guidedLocks.stopPct, 1.2);
assert.strictEqual(guidedLocks.tpPct, 1.8);

assert.strictEqual(contradictionOptions.exit, 'indicator');
assert.strictEqual(contradictionOptions.stopPct, null);
assert.strictEqual(contradictionOptions.tpPct, null);
const contradictionBuilt = buildJsRecipe({
  name: 'Rompimento com saída RSI',
  thesis: 'Compra no rompimento. Stop 0,5% e alvo 20% conforme os números citados antes.',
  entryText: 'Compra quando a vela de 15m rompe a máxima anterior.',
  exitText: 'Vende quando o RSI passar de 80; não usa stop percentual.',
  risks: 'O alvo de 20% pode demorar.',
  code: `function strategy(ctx) {
    const c = ctx.candles("15m");
    if (c.length < 16) return { action: "hold" };
    const value = Number(ctx.rsi(c.close, 15));
    if (ctx.position) return value >= 80 ? { action: "sell" } : { action: "hold" };
    const last = c[c.length - 1];
    const prev = c[c.length - 2];
    if (last.close <= prev.high) return { action: "hold" };
    return { action: "buy", stop: ctx.price * (1 - 0.5 / 100), target: ctx.price * (1 + 20 / 100) };
  }`,
}, contradiction, 'pt-BR', contradictionOptions);
assert(contradictionBuilt.recipe && !contradictionBuilt.ask && !contradictionBuilt.failed, JSON.stringify(contradictionBuilt));
assert(/stop:\s*null/i.test(contradictionBuilt.recipe.code));
assert(/target:\s*null/i.test(contradictionBuilt.recipe.code));
assert.strictEqual(contradictionBuilt.recipe.exit.stopPct, null);
assert.strictEqual(contradictionBuilt.recipe.exit.tpPct, null);
assert(contradictionBuilt.recipe.plan.indicatorExit && contradictionBuilt.recipe.plan.noStop && contradictionBuilt.recipe.plan.noTarget);
assert(!/stop\s+0[,.]5\s*%|alvo\s+20\s*%/i.test(JSON.stringify(contradictionBuilt.recipe.explanation)));

const bookOnlyText = `Brief.
Entrada: Comprar quando o livro mostrar pressão compradora clara perto do preço, sem olhar médias.
Fontes: livro de ofertas.
Saída: Stop 1.1% e alvo 1.7% a partir da entrada.`;
const bookOnlyCode = `function strategy(ctx) {
  const book = ctx.book();
  if (!book || ctx.position) return { action: "hold" };
  const bid = (book.bids || []).reduce((s, l) => s + (l.qty || 0), 0);
  const ask = (book.asks || []).reduce((s, l) => s + (l.qty || 0), 0);
  if (!(bid > ask)) return { action: "hold" };
  return { action: "buy", stop: ctx.price * (1 - 1.1 / 100), target: ctx.price * (1 + 1.7 / 100) };
}`;
const bookOnly = buildJsRecipe({
  name: 'Só livro',
  thesis: 'Compra quando o livro está comprador.',
  code: bookOnlyCode,
}, bookOnlyText, 'pt-BR', { guided: true, autoFill: true, exit: 'manual', stopPct: 1.1, tpPct: 1.7 });
assert(bookOnly.recipe && !bookOnly.ask, JSON.stringify(bookOnly));
assert(/ctx\.book\s*\(/.test(bookOnly.recipe.code));
assert(!/ctx\.ema\s*\(|ctx\.sma\s*\(/.test(bookOnly.recipe.code));

const timed = syncExitFromCode({
  name: 'Tempo',
  code: `function strategy(ctx) {
    if (ctx.position && ctx.position.minutesHeld >= 30) return { action: "sell" };
    return { action: "buy", stop: ctx.price * (1 - 1 / 100), target: ctx.price * (1 + 2 / 100) };
  }`,
  exit: { stopPct: 1, tpPct: 2, maxHoldMin: 1440, timeExit: false },
  explanation: { 'pt-BR': { thesis: 'Rompimento.', exit: 'Stop 1% e alvo 2%.' } },
});
assert.strictEqual(timed.exit.timeExit, true);
assert.strictEqual(timed.exit.maxHoldMin, 30);
assert(/30/.test(timed.explanation['pt-BR'].exit));

const noTime = syncExitFromCode({
  code: `function strategy(ctx) { return { action: "buy", stop: ctx.price * (1 - 1 / 100), target: ctx.price * (1 + 2 / 100) }; }`,
  exit: { stopPct: 1, tpPct: 2, maxHoldMin: 1440, timeExit: false },
});
assert.strictEqual(noTime.exit.timeExit, false);
assert.strictEqual(noTime.exit.maxHoldMin, 1440);

assert.strictEqual(parseLocaleNumber('1,5', 'pt-BR'), 1.5);
assert.strictEqual(parseLocaleNumber('3', 'pt-BR'), 3);
assert.strictEqual(parseLocaleNumber('1.5', 'pt-BR'), 1.5);
assert.strictEqual(parseLocaleNumber('1.250', 'pt-BR'), 1250);
assert.strictEqual(parseLocaleNumber('1,5,6', 'pt-BR'), null);
assert.strictEqual(parseLocaleNumber('1.5', 'en'), 1.5);
assert.strictEqual(parseLocaleNumber('1,250', 'en'), 1250);

const alarmText = scrubAlarmExplanation({
  'pt-BR': { thesis: 'Avisa se o BTC subir 3%. Stop 1,2% e alvo 1,8% vieram da busca nas velas.', exit: 'Stop 1,2%.' },
});
assert(!/busca nas velas|stop\s+1/i.test(alarmText['pt-BR'].thesis));
assert(/3%/.test(alarmText['pt-BR'].thesis));
const spelled = 'Compra sobre o rompimento de 15m no BTC com RSI. Stop 1,5% e alvo 3%.';
const typo = 'Compra sobobre o rompimento de 15m no BTC com RSI. Stop 1,5% e alvo 3%.';
assert(explanationCorrectionOk(typo, spelled));
assert(explanationCorrectionOk(typo, 'Compra sobre o rompimento de 15m no BTC com RSI. Stop 1.5% e alvo 3%.'));
assert(!explanationCorrectionOk(typo, 'Compra sobre o rompimento de 15m no ETH com RSI. Stop 1,5% e alvo 3%.'));
assert(!explanationCorrectionOk(typo, 'Compra sobre o rompimento de 15m no BTC com RSI. Stop 2% e alvo 3%.'));
assert(!explanationCorrectionOk(typo, 'Compra sobre o rompimento.'));
assert(!explanationCorrectionOk(typo, 'function strategy(ctx) { return { action: "hold" }; }'));

const reader = prepareReaderCopy({
  code: 'function strategy(ctx) { return { action: "hold" }; }',
  exit: { stopPct: 1.5, tpPct: 3, timeExit: true, maxHoldMin: 30 },
  explanation: { 'pt-BR': { thesis: 'Compra quando ctx.rsi cruzar.', entry: '', exit: 'Sai no alvo.', filters: '', risks: '', paramsPlain: '' } },
});
assert(reader.code.startsWith('function strategy'));
assert(!/ctx\./.test(reader.explanation['pt-BR'].thesis));
assert(/RSI/.test(reader.explanation['pt-BR'].thesis));
assert(/1,5%/.test(reader.explanation['pt-BR'].exit));
assert(/30 minutos/.test(reader.explanation['pt-BR'].exit));
const alarmReader = prepareReaderCopy({
  code: reader.code,
  exit: { stopPct: 1.2, tpPct: 1.8, timeExit: false, maxHoldMin: 1440 },
  explanation: { 'pt-BR': { thesis: 'Avisa se subir 3%.', exit: '' } },
}, { alarm: true });
assert(!/1,2%/.test(alarmReader.explanation['pt-BR'].exit));

console.log('test-feasibility: ok');
