import {
  returnAsk,
  regionAsk,
  bookCoverageAsk,
  tradesCoverageAsk,
  averagesCoverageAsk,
  reversalAsk,
  persistAggressionAsk,
  buildJsRecipe,
} from '../src/sandbox.js';
import { suggestGuide } from '../src/llm.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const brief03 = `Brief.\nEntrada: No 15m, comprar no rompimento do fechamento acima da máxima das últimas 12 velas, com volume da vela maior que a média das 20 anteriores.\nFontes disponíveis no ctx (só entram na compra ou saída se Entrada ou Saída descreverem a condição): velas fechadas; livro com até 10 níveis em ctx.book().\nLista: não grava preço. A compra acontece no próprio gatilho.\nSaída: Stop 0.8% e alvo 1.2% a partir da entrada.`;
const codeNoBook = `function strategy(ctx) { const c = ctx.candles("15m"); if (c.length < 21) return { action: "hold" }; const sig = c[c.length-1]; const prevHigh = ctx.highest(c.map(v=>v.high).slice(0,-1), 12); const volAvg = ctx.sma(c.map(v=>v.volume).slice(-21,-1), 20); if (sig.close > prevHigh && sig.volume > volAvg) return { action: "buy", stop: ctx.price * 0.992, target: ctx.price * 1.012 }; return { action: "hold" }; }`;
assert(!bookCoverageAsk(codeNoBook, brief03), '03: livro só em Fontes não obriga filtro de livro');
assert(averagesCoverageAsk('function strategy(ctx){return {action:"hold"}}', brief03), '03: volume vs média exige ctx.sma/ema/vwap/rsi');

const briefBook = `Entrada: No 1m, comprar quando o fechamento romper a máxima das 10 velas e o volume agregado de compra nas primeiras cinco faixas do livro for pelo menos 1,3 vez o de venda.\nSaída: Stop 0,7%.`;
assert(bookCoverageAsk('function strategy(ctx){return {action:"hold"}}', briefBook), 'pedido com condição de livro exige ctx.book');
assert(!bookCoverageAsk('function strategy(ctx){ const b=ctx.book(); return {action:"hold"}; }', briefBook), 'com ctx.book não pede de novo');

const histNote = `No 15m, comprar no rompimento.\nA pessoa pediu stop e alvo medidos nas velas de 18 meses. Esse arquivo é só de velas, sem livro e sem tape.`;
assert(!bookCoverageAsk('function strategy(ctx){return {action:"hold"}}', histNote), 'aviso de histórico sem livro não conta como condição de livro');

const brief04 = 'Entrada: quando o preço fechar acima de 62.000, registrar esse nível. Voltar até 0,2% do nível e fechar acima em 1m.';
const codeRetestBad = `function strategy(ctx) { const L = 62000; const RET = 0.2 / 100; if (Math.abs(ctx.price - L) / L <= RET) return { action: "buy", stop: 1, target: 2 }; return { action: "hold" }; }`;
assert(returnAsk(codeRetestBad, brief04), '04 deve exigir saída antes da volta');

const brief05 = 'No 15m, detectar pin bar bullish cujo pavio inferior tenha pelo menos duas vezes o tamanho do corpo, próximo ao suporte local. Considerar suporte local como uma região testada pelo menos duas vezes nas últimas 48 velas de 15m.\nSaída: Sair no stop, no alvo de 1,5% ou se uma vela de 5m fechar abaixo do suporte; encerrar em qualquer caso após 30 minutos.';
const askDist = buildJsRecipe({ ask: 'Qual é a distância máxima, em porcentagem, entre a mínima do pin bar e o suporte?', questions: [], code: '', defaults: [] }, brief05, 'pt-BR', {});
assert(askDist.retry && /n[aã]o pe[cç]a dist[aâ]ncia/i.test(askDist.ask), '05 não pode pedir distância');
assert(/0[,.]8/.test(askDist.ask), '05 com alvo e sem stop usa padrão 0,8% em vez de perguntar stop');

const brief02 = 'Entrada: cruzamento 9/21 com fluxo.\nSaída: Vender no stop, no alvo de 1,8% ou se o saldo de trades agressivos ficar vendedor por 45 segundos; encerrar também após 20 minutos.';
const askStop = buildJsRecipe({ ask: 'Qual é o stop, em porcentagem abaixo do preço de entrada?', questions: ['Qual é o stop, em porcentagem abaixo do preço de entrada?'], code: '', defaults: [] }, brief02, 'pt-BR', {});
assert(askStop.retry && /0[,.]8/.test(askStop.ask) && /1[,.]8/.test(askStop.ask), '02 completa stop padrão quando só o alvo veio no texto');

const code05 = `function strategy(ctx) {
  const c = ctx.candles("15m");
  if (!c || c.length < 49) return { action: "hold" };
  if (ctx.position) {
    if (ctx.position.minutesHeld >= 30) return { action: "sell" };
    return { action: "hold" };
  }
  const sig = c[c.length - 1];
  const body = Math.abs(sig.close - sig.open);
  const lower = Math.min(sig.open, sig.close) - sig.low;
  const upper = sig.high - Math.max(sig.open, sig.close);
  const prior = c.slice(-49, -1);
  const lows = prior.map(v => v.low).sort((a, b) => a - b);
  const level = lows[1];
  const pin = sig.close > sig.open && lower >= 2 * body && upper < body && sig.low <= level;
  if (!pin) return { action: "hold" };
  const entry = ctx.price;
  return { action: "buy", stop: entry * (1 - 0.8 / 100), target: entry * (1 + 1.5 / 100) };
}`;
const settled05 = buildJsRecipe({ code: code05, ask: '', questions: [], defaults: [], name: 'T05', thesis: 'stop padrão', entryText: 'pin', exitText: '1.5', risks: '' }, brief05, 'pt-BR', { guided: true });
assert(settled05.recipe, '05 aceita stop padrão 0,8% no checkNumbers');

const brief11 = 'No 15m, quando surgir um candle de reversão bullish após uma queda de pelo menos quatro candles, registrar a máxima desse candle.';
const codeGreenOnly = `function strategy(ctx) { const c = ctx.candles("15m"); const sig = c[c.length-1]; const bullish = sig.close > sig.open; if (bullish) { ctx.memory.price = sig.high; } return { action: "hold" }; }`;
assert(reversalAsk(codeGreenOnly, brief11), '11 rejeita vela verde sem pavio');

const brief22 = `Entrada: No 1m, detectar agressão compradora líquida por pelo menos 10 segundos e registrar o preço médio desse intervalo.\nSaída: Stop de 0,6%; alvo de 1,0%; fechar se a pressão vendedora persistir por 20 segundos ou após 12 minutos.`;
const codeSnap = `function strategy(ctx) { const t = ctx.trades(10 * 1000); let net = 0; for (const x of t) net += x.buyerMaker ? -x.qty : x.qty; if (net > 0) { ctx.memory.price = ctx.price; ctx.memory.at = ctx.now; } return { action: "hold" }; }`;
assert(persistAggressionAsk(codeSnap, brief22), '22 rejeita snapshot de 10s');
const codePersist = `function strategy(ctx) { const m = ctx.memory; const t = ctx.trades(10 * 1000); let net = 0; for (const x of t) net += x.buyerMaker ? -x.qty : x.qty; if (net > 0) { if (m.buySince === undefined) m.buySince = ctx.now; } else delete m.buySince; if (m.buySince !== undefined && ctx.now - m.buySince >= 10 * 1000) { m.price = ctx.price; } return { action: "hold" }; }`;
assert(!persistAggressionAsk(codePersist, brief22), '22 aceita persistência real');
assert(!averagesCoverageAsk(codePersist, brief22), '22: preço médio não exige ctx.sma');

const brief06 = `Fontes disponíveis no ctx (só entram na compra ou saída se Entrada ou Saída descreverem a condição): velas fechadas; as médias que o texto citar; livro; aggTrades.\nEntrada: No 1m, comprar quando o preço cruzar acima da VWAP.`;
assert(averagesCoverageAsk('function strategy(ctx){return {action:"hold"}}', brief06), '06 exige VWAP quando a entrada cita VWAP');
assert(!tradesCoverageAsk('function strategy(ctx){return {action:"hold"}}', brief06), '06: trades só em Fontes não obriga filtro');
assert(!bookCoverageAsk('function strategy(ctx){return {action:"hold"}}', brief06), '06: livro só em Fontes não obriga filtro');

const brief16 = `Fontes: velas fechadas; aggTrades.\nEntrada: No 1m, comprar se um candle bullish fechar com corpo maior que 70% de sua amplitude e volume superior ao dobro da média das últimas 20 velas.\nSaída: Stop de 0,5%; alvo de 0,7%.`;
assert(!tradesCoverageAsk('function strategy(ctx){ const c=ctx.candles("1m"); return {action:"hold"}; }', brief16), '16: trades só em Fontes não obriga filtro');
assert(averagesCoverageAsk('function strategy(ctx){ const c=ctx.candles("1m"); return {action:"hold"}; }', brief16), '16: média de volume exige ctx.sma');

const g04 = suggestGuide({ entry: 'No 5m, quando o preço fechar acima de 62.000, registrar esse nível como referência.' }, 'list');
assert(g04.list === 'yes', 'guia deve propor gravação no caso 04');
const g15 = suggestGuide({ entry: 'No 5m, em tendência de alta com média de 20 acima da média de 50, esperar recuo do preço até a média de 20 e candle bullish de retomada.', sources: ['candles', 'ema'] }, 'list');
assert(g15.list === 'no', 'caso 15 sem registrar nível fica sem lista');
assert(g15.sources.includes('ema'), 'caso 15 mantém médias nas fontes');

const gRegion = regionAsk('function strategy(ctx){ const c=ctx.candles("15m"); return {action:"hold"}; }', brief05);
assert(gRegion, '05 exige região por testes nas 48 velas');

console.log('check-recipe-asks: ok');
