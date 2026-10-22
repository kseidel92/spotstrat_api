const { OPS } = require('./shared');

const CATALOG = `
Gatilhos (entry.all = todos; entry.any = pelo menos um):
- range_pos: lookbackMin, minPos (0-1), maxPos (0-1). Preço na faixa da janela.
- swings: lookbackMin, minSwings, minSwingPct, minRangePct, maxRangePct, maxPos, minEr, maxEr. Serra/zigzag.
- touches: lookbackMin, minLo, minHi, touchPct, sepMin. Toques no piso e no teto.
- dump: windowMin, minDumpPct, minLeftPct. Queda a partir do pico da janela.
- rebound_green: n, minBodyPct. Últimas n velas 1m verdes já fechadas.
- rs_lead: rankN, minExcess24. Força 24h versus BTC.
- spike: minRet15, maxRet15, minVolX. Variação de 15 min e volume. Fração, 0.03 = 3%.
- rise: windowMin, minPct. Alta na janela. minPct é porcentagem, 1 = 1%. Ex.: "rise:windowMin=3,minPct=1".
- ema_cross: fast, slow, dir=up. Cruzamento da EMA curta acima da EMA longa nas velas de 1 minuto. Ex.: "ema_cross:fast=9,slow=21,dir=up".
- ema_above: period. Preço acima da EMA. Ex.: "ema_above:period=21".
- engulf: dir=bull, tfMin. Engulfing bullish no candle fechado de tfMin minutos. Ex.: "engulf:dir=bull,tfMin=15".
- mare_laggard: minDd. Mais caída versus a máxima de 7 dias.
- er: lookbackMin, min, max. Efficiency ratio.
- age_extreme: minAge, maxAge. Minutos desde o fundo da janela.
- btc_dump: windowMin, maxDropPct. BTC não caiu mais que isso.
Filtros (filters, todos obrigatórios):
- obi: min, max, persistSec. Livro comprador.
- tape: min, max, minPrints. Fração taker buy (0-1) na janela curta.
- mare: mode = any | not_bad | good | neutral.
- vol_x: min. Volume da vela versus a média.
- queue: pumpPct, pumpWindowMin, dropPct, holdMin, greenN. Moeda que subiu e caiu entra numa fila por holdMin; compra com N candles verdes dentro da fila.
- session: startHour, endHour. Só dentro do horário de Brasília.
- reclaim: windowMin. Candle fura a mínima da janela e fecha de volta acima.
- fib: level, cancel. Retrocesso de Fibonacci da líder de 24h. Cancela abaixo de cancel.
- bb_squeeze: period, tfMin, narrowMin, maxWidth, volX. Bollinger estreita e rompe a banda de cima.
- rsi_div: period, tfMin. Preço faz fundo mais baixo e o RSI faz fundo mais alto.
- vwap_reclaim: belowMin, tfMin. Fica abaixo do VWAP do dia e um candle fecha acima.
- funding_neg: n. Últimas n taxas de funding do perpétuo negativas. A compra é no spot.
- spread_snap: highPct, lowPct, withinSec. Spread abre e fecha, com a parede de venda menor.
- absorption: windowMin, tradeX, maxMovePct. Negócios disparam e o preço quase não anda.
- second_leg: lookbackMin, minSwingPct. Segundo recuo menor que o primeiro.
- listing: maxHours, tfMin. Listagem recente e fechamento acima da máxima da primeira hora.
- leader_lag: leader, windowMin, leaderPct, maxSelfPct. O líder sobe e esta moeda ainda não acompanhou.
- triple_low: lookbackMin, maxGapPct. Três fundos próximos e rompimento da máxima entre eles.
- hammer: tfMin. Martelo na mínima do dia.
- opening_range: hour, minute, rangeMin, validMin. Faixa da abertura e rompimento dentro do prazo.
- grid: levels, stepPct, boxPct. Compra a cada queda e vende a cada alta, dentro da caixa.
- dca: everyMin, tpPct. Compra no relógio e vende o pacote no alvo.
- donchian: lookback, volX, tfMin. Fechamento acima da máxima anterior com volume.
- bb_rsi: tfMin, rsiLow. Fechamento abaixo da banda inferior e RSI abaixo de 30, os dois juntos.
- accum: drop24, stepPct, maxBuys. Compras na queda, uma por candle, venda no preço médio.
- ema_trend: fast, mid, slow, tfMin. Cruzamento com o preço acima da média longa.
- atr_break: tfMin, tpMult, slMult. Rompimento da máxima anterior com alvo e stop em ATR travados.
- zspread: period, entryZ. Spread ETH/BTC em desvios. Só o ETH.
- rsi_momo: level, lookback, tfMin. RSI cruza o nível e o preço está acima de N candles.
- panic: bodyPct, volX, rsiMax. Candle de corpo, volume e RSI no fechamento.
- chandelier: ema, atrMult, tfMin. Stop na máxima desde a entrada menos ATR, só aperta.
- retest: window, maxAmpPct, retestBars. Rompimento de range e retest que fecha acima.
Saída: exit.stopPct, exit.tpPct, exit.maxHoldMin.
Short simulado, grid e funding negativo com compra no spot são permitidos quando o pedido for exatamente esse.
Nunca substitua o pedido por ema_cross se o usuário não falou em EMA. Se ele recusar a troca, devolva ask e deixe allOps vazio.
R:R líquido mínimo 1,15 depois da taxa 0,075% (taker na entrada e no stop, maker no alvo).
Se o pedido não cabe no catálogo, devolva ask explicando e não invente op.
`.trim();

function parseOp(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  const cut = text.indexOf(':');
  const name = (cut === -1 ? text : text.slice(0, cut)).trim();
  const rest = cut === -1 ? '' : text.slice(cut + 1);
  if (!OPS.has(name)) return { op: name };
  const args = { op: name };
  if (rest.trim()) {
    for (const part of rest.split(',')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!key) continue;
      const num = Number(value);
      args[key] = value !== '' && Number.isFinite(num) ? num : value;
    }
  }
  return args;
}

function fromModel(data, locale) {
  const all = (data.allOps || []).map(parseOp).filter(Boolean);
  const any = (data.anyOps || []).map(parseOp).filter(Boolean);
  const filters = (data.filterOps || []).map(parseOp).filter(Boolean);
  return {
    name: String(data.name || '').slice(0, 80),
    explanation: {
      [locale || 'pt-BR']: {
        thesis: data.thesis || '',
        entry: data.entryText || '',
        exit: data.exitText || '',
        filters: data.filtersText || '',
        risks: data.risks || '',
        paramsPlain: data.paramsPlain || '',
      },
    },
    entry: { all, any },
    filters,
    exit: {
      stopPct: Number(data.stopPct),
      tpPct: Number(data.tpPct),
      maxHoldMin: Number(data.maxHoldMin),
    },
    pacing: {
      noRepeatMin: Number(data.noRepeatMin) || 360,
      stopCooldownMin: Number(data.stopCooldownMin) || 60,
    },
  };
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ask: { type: 'string' },
    name: { type: 'string' },
    thesis: { type: 'string' },
    entryText: { type: 'string' },
    exitText: { type: 'string' },
    filtersText: { type: 'string' },
    risks: { type: 'string' },
    paramsPlain: { type: 'string' },
    allOps: { type: 'array', items: { type: 'string' } },
    anyOps: { type: 'array', items: { type: 'string' } },
    filterOps: { type: 'array', items: { type: 'string' } },
    stopPct: { type: 'number' },
    tpPct: { type: 'number' },
    maxHoldMin: { type: 'number' },
    noRepeatMin: { type: 'number' },
    stopCooldownMin: { type: 'number' },
  },
  required: [
    'ask', 'name', 'thesis', 'entryText', 'exitText', 'filtersText', 'risks', 'paramsPlain',
    'allOps', 'anyOps', 'filterOps', 'stopPct', 'tpPct', 'maxHoldMin', 'noRepeatMin', 'stopCooldownMin',
  ],
};

function systemPrompt(locale) {
  return [
    'Você escreve a estratégia de paper e sempre devolve o código. A resposta é um JSON. O campo code é function strategy(ctx).',
    'Não use require, import, process, fetch, rede nem arquivo. Não instancie a Binance. Os dados já estão no ctx.',
    'Crie a estratégia com os números do pedido. Se faltar um número, escolha um padrão e liste em defaults como { label, value }. defaults só recebe número que não estava no pedido. Não deixe de criar por causa de um número.',
    'Se o pedido começa com Brief, ele já está completo. Escreva o código numa passada. A seção Saída é a única saída. Não pergunte e não invente outro stop.',
    'questions fica vazio quase sempre. Use questions só quando o pedido não descreve gatilho nenhum. Aí code fica vazio e questions tem uma pergunta curta, uma de cada vez.',
    'Não peça para o usuário expor campo, ligar stream nem aprovar troca de regra. Livro e trades já existem.',
    'O exemplo usa 999. Nunca copie 999. Porcentagem: se a pessoa disse 5%, escreva 5 / 100.',
    'ctx.candles("1m" | "5m" | "15m" | "1h" | "4h") devolve as velas fechadas. candles.length é a quantidade. candles[i] é { time, open, high, low, close, volume }. candles.close é a série de fechamentos. A última vela é o sinal.',
    'ctx.price é o preço agora. ctx.priceAgo(ms) é o preço de ms milissegundos atrás, ou null. A variação numa janela de trades usa ctx.price e ctx.priceAgo, não uma vela de outro tempo. ctx.symbol, ctx.pct24, ctx.open24, ctx.now, ctx.hourBrt().',
    'Não preencha fraction. O tamanho da mão já é calculado pelo stop. fraction só se a pessoa pediu a fração do caixa.',
    'ctx.trades(ms) são os aggTrades dos últimos ms milissegundos: { time, price, qty, buyerMaker }. buyerMaker true é venda agressiva, isBuyerMaker true. qty é a quantidade da moeda. Janela de 60 segundos = ctx.trades(60 * 1000).',
    'ctx.book() é o livro agora, até 10 níveis de cada lado: { time, bids: [{ price, qty }], asks: [{ price, qty }] }. ctx.bookSnaps(ms) são fotos desse livro a cada 5 segundos.',
    'ctx.position é null ou { side, entry, qty, openedAt, highSince, lowSince, minutesHeld }.',
    'ctx.memory é um objeto vazio que fica gravado por moeda entre as chamadas. Use para lista, preço marcado e validade. Exemplo com 999: if (!ctx.memory.at) { ctx.memory.price = ctx.price; ctx.memory.at = ctx.now; return { action: "hold" }; }',
    'Horas viram minutos vezes 60. Dois horas de validade: ctx.now + 2 * 60 * 60 * 1000. Três minutos: 3 * 60 * 1000.',
    'Contas de vela, todas incluem a última vela: ctx.sma, ctx.ema, ctx.rsi, ctx.atr, ctx.bb, ctx.macd, ctx.stoch, ctx.vwap. A série, usada como número, vale o último ponto.',
    'ctx.highest(valores, n) e ctx.lowest(valores, n) olham os últimos n pontos do array passado. Para excluir a vela do sinal, use slice(0, -1). ctx.at(valores, -1) é o último número. ctx.crossedUp(a, b) e ctx.crossedDown(a, b) comparam os dois últimos pontos.',
    'Devolva { action: "buy" | "sell" | "hold" | "short" | "alert", stop, target, fraction }. stop e target são preços. Sem posição, buy abre comprado e short abre vendido no paper. alert não abre ordem: o desk toca o som e manda o e-mail. Com posição, sell fecha. Histórico curto ou livro vazio: devolva hold. Não deixe a função quebrar.',
    'Pedido de alarme, aviso, e-mail ou som: quando a condição for verdadeira devolva action "alert". Não recuse e não escreva que o código não notifica. hold só se a condição ainda não aconteceu.',
    'Exemplo de forma, com 999 no lugar dos números reais:',
    'function strategy(ctx) { const trades = ctx.trades(999 * 1000); const book = ctx.book(); if (!trades.length || !book.bids.length) return { action: "hold" }; return { action: "hold" }; }',
    `Escreva name, thesis, entryText, exitText e risks no locale ${locale}.`,
    'JSON com as chaves ask, questions, defaults, name, thesis, entryText, exitText, risks, code. ask e questions vazios quando o código estiver pronto.',
  ].join('\n');
}

module.exports = { CATALOG, parseOp, fromModel, RESPONSE_SCHEMA, systemPrompt };
