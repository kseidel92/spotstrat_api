const { validateRecipe } = require('./shared');

function hoursOf(text, fallback) {
  const m = String(text).match(/(\d+)\s*(?:horas|hora|h)\b/i);
  return m ? Number(m[1]) * 60 : fallback;
}

function titleFrom(text, fallback) {
  const m = String(text).match(/chamad[oa]\s+([^.!\n]{3,70})/i);
  const name = m ? m[1].trim() : fallback;
  return name.slice(0, 80);
}

function block(thesis, entry, exit, filters) {
  return {
    thesis,
    entry,
    exit,
    filters: filters || 'Sem filtro extra.',
    risks: 'Paper. Taxa 0,075%. Halt de 8% no dia de Brasília. A regra abaixo é a que foi pedida, sem trocar por outra.',
    paramsPlain: exit,
  };
}

function pack({ name, thesis, entry, exitText, filtersText, all, filters, exit, plan, pacing }) {
  const text = block(thesis, entry, exitText, filtersText);
  const recipe = {
    name,
    explanation: { 'pt-BR': text, en: text },
    entry: { all, any: [] },
    filters: filters || [],
    exit,
    pacing: pacing || { noRepeatMin: 30, stopCooldownMin: plan?.lock?.banMin || 60 },
    plan,
  };
  const check = validateRecipe(recipe);
  if (!check.ok) return null;
  return recipe;
}

function baseExit(stopPct, tpPct, maxHoldMin, timeExit = true) {
  return { stopPct, tpPct, maxHoldMin, timeExit };
}

function specs(raw, t) {
  if (/chandelier|m[aá]xima desde a entrada/.test(t) && /atr/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Chandelier'),
      thesis: 'No 4h, compra quando o candle fecha acima da EMA 50 e a EMA 50 está maior do que 5 candles atrás. Sem alvo. O stop é a máxima desde a entrada menos 3 ATR e só aperta.',
      entry: 'Fechamento acima da EMA 50 com a média subindo de forma estrita.',
      exitText: 'Stop chandelier, máxima desde a entrada menos 3 ATR. Sem alvo e sem prazo.',
      all: [{ op: 'chandelier', tfMin: 240, ema: 50, emaLookback: 5, atr: 14, atrMult: 3 }],
      exit: baseExit(3, 3, 1440, false),
      plan: { kind: 'chandelier', exact: true, noTarget: true, tfMin: 240, ema: 50, emaLookback: 5, atr: 14, atrMult: 3 },
    });
  }
  if (/m[aá]xima dos [uú]ltimos 20|m[aá]xima dos 20/.test(t) && /volume/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Donchian 20'),
      thesis: 'No 1h, compra se o candle fechar acima da máxima das 20 velas anteriores e o volume dessa vela for pelo menos 1,5 vez a média dessas 20. Sai na mínima das 10 velas anteriores ou a -3% da entrada, o que vier primeiro.',
      entry: 'Fechamento acima da máxima das 20 velas fechadas, com volume.',
      exitText: 'Mínima das 10 velas de 1h anteriores, ou -3% da entrada.',
      all: [{ op: 'donchian', tfMin: 60, lookback: 20, volX: 1.5, stopPct: 3 }],
      exit: baseExit(3, 3, 1440, false),
      plan: { kind: 'donchian', exact: true, noTarget: true, tfMin: 60, lookback: 20, volX: 1.5, exitLookback: 10, stopPct: 3 },
    });
  }
  if (/bollinger/.test(t) && /rsi/.test(t) && /inferior|abaixo de 30/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Bollinger e RSI'),
      thesis: 'No 15m, compra só quando o mesmo candle fecha abaixo da banda inferior de Bollinger 20/2 e o RSI 14 desse candle está abaixo de 30. Sai no fechamento acima da banda superior, ou com RSI acima de 70, ou a -2% da entrada.',
      entry: 'Fechamento abaixo da banda inferior e RSI abaixo de 30, os dois juntos.',
      exitText: 'Fechamento acima da banda superior, RSI acima de 70, ou -2%.',
      all: [{ op: 'bb_rsi', tfMin: 15, rsiLow: 30, stopPct: 2 }],
      exit: baseExit(2, 2, 1440, false),
      plan: { kind: 'bb_rsi', exact: true, noTarget: true, tfMin: 15, rsiLow: 30, rsiHigh: 70, stopPct: 2 },
    });
  }
  if (/pre[cç]o m[eé]dio/.test(t) && /24 horas|24h/.test(t) && /2\s*%/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Compras na queda'),
      thesis: 'Só arma se o preço caiu 5% ou mais em 24 horas. A cada -2% abaixo da referência compra 10% do capital reservado, no máximo 5 vezes, uma compra por candle de 1 hora. A primeira referência é o preço de 24 horas atrás; depois passa a ser o último fill. Vende tudo a +4% do preço médio ou 48 horas depois da primeira compra.',
      entry: 'Queda de 5% em 24h e degraus de 2% a partir da referência.',
      exitText: 'Tudo a +4% do preço médio, ou 48 horas da primeira compra.',
      all: [{ op: 'accum', drop24: 5, stepPct: 2, maxBuys: 5, sliceFrac: 0.1, tpPct: 4, timeoutMin: 2880 }],
      exit: baseExit(4, 4, 1440, false),
      plan: { kind: 'accum', exact: true, drop24: 5, stepPct: 2, maxBuys: 5, sliceFrac: 0.1, tpPct: 4, timeoutMin: 2880 },
    });
  }
  if (/ema\s*200/.test(t) && /ema\s*9/.test(t) && /ema\s*21/.test(t)) {
    return pack({
      name: titleFrom(raw, 'EMA 9 21 200'),
      thesis: 'No 1h fechado, compra quando a EMA 9 cruza acima da EMA 21 e o preço está acima da EMA 200. Se faltarem 200 candles, não entra. Sai no cruzamento de volta da EMA 9 abaixo da EMA 21, ou a -4% do preço de entrada.',
      entry: 'Cruzamento de alta da EMA 9 com a 21, com o preço acima da EMA 200.',
      exitText: 'EMA 9 cruza abaixo da EMA 21, ou -4% da entrada.',
      all: [{ op: 'ema_trend', tfMin: 60, fast: 9, mid: 21, slow: 200, stopPct: 4 }],
      exit: baseExit(4, 4, 1440, false),
      plan: { kind: 'ema_trend', exact: true, noTarget: true, tfMin: 60, fast: 9, mid: 21, slow: 200, stopPct: 4 },
    });
  }
  if (/atr/.test(t) && /candle anterior/.test(t)) {
    return pack({
      name: titleFrom(raw, 'ATR scalp'),
      thesis: 'No 5m, compra se o preço romper a máxima do candle anterior e o ATR 14 desse candle anterior passar de 0,5% do preço. O alvo fica a 1,5 ATR e o stop a 1 ATR, travados na entrada.',
      entry: 'Rompimento da máxima anterior com ATR acima de 0,5%.',
      exitText: 'Alvo na entrada mais 1,5 ATR. Stop na entrada menos 1 ATR.',
      all: [{ op: 'atr_break', tfMin: 5, period: 14, minAtrPct: 0.5, tpMult: 1.5, slMult: 1 }],
      exit: baseExit(1, 1.5, 240, false),
      plan: { kind: 'atr_break', exact: true, tfMin: 5, period: 14, minAtrPct: 0.5, tpMult: 1.5, slMult: 1 },
    });
  }
  if (/desvio/.test(t) && /eth/.test(t) && /btc/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Spread ETH BTC'),
      thesis: 'Só o ETH. O spread é o preço do ETH dividido pelo BTC, na janela de 50 horas incluindo a hora atual, com desvio amostral. Compra quando o spread está 2 desvios abaixo da média. Sai na volta à média, se cair mais 2 desvios, ou em 24 horas.',
      entry: 'ETH com o spread ETH/BTC a -2 desvios da média de 50.',
      exitText: 'Volta à média, -4 desvios, ou 24 horas. Sem stop de preço.',
      all: [{ op: 'zspread', symbol: 'ETHUSDT', period: 50, entryZ: -2 }],
      exit: baseExit(4, 4, 1440, false),
      plan: {
        kind: 'zspread', exact: true, noTarget: true, noStop: true, onlySymbol: 'ETHUSDT', quoteFrac: 0.1,
        tfMin: 60, period: 50, entryZ: -2, stopZ: -4, meanZ: 0, timeoutMin: 1440,
      },
    });
  }
  if (/rsi/.test(t) && /acima de 50|cruzar acima de 50/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Momentum RSI'),
      thesis: 'No 15m fechado, compra quando o RSI 14 cruza acima de 50 e o fechamento está acima do fechamento de 3 candles atrás. Sai no cruzamento do RSI abaixo de 50, a +2% ou a -1,5%.',
      entry: 'RSI cruza 50 para cima e o preço de agora está acima do de 3 candles.',
      exitText: 'RSI cruza abaixo de 50, +2% ou -1,5%.',
      all: [{ op: 'rsi_momo', tfMin: 15, level: 50, lookback: 3, tpPct: 2, stopPct: 1.5 }],
      exit: baseExit(1.5, 2, 240, false),
      pacing: { noRepeatMin: 15, stopCooldownMin: 15 },
      plan: { kind: 'rsi_momo', exact: true, tfMin: 15, level: 50, lookback: 3, tpPct: 2, stopPct: 1.5 },
    });
  }
  if (/p[aâ]nico|panicada/.test(t) || (/corpo/.test(t) && /rsi/.test(t) && /volume/.test(t))) {
    return pack({
      name: titleFrom(raw, 'Panicada'),
      thesis: 'No 1h, compra no fechamento de um candle cujo corpo caiu 4% ou mais, com volume pelo menos 2 vezes a média das 20 velas anteriores, e RSI 14 abaixo de 25. Sai no primeiro candle seguinte que fecha positivo, a -3%, ou depois de 12 candles.',
      entry: 'Corpo de queda de 4%, volume 2 vezes a média anterior e RSI abaixo de 25.',
      exitText: 'Primeiro candle positivo, -3%, ou 12 candles de 1h.',
      all: [{ op: 'panic', tfMin: 60, bodyPct: 4, volX: 2, rsiMax: 25, stopPct: 3 }],
      exit: baseExit(3, 3, 720, false),
      plan: { kind: 'panic', exact: true, noTarget: true, tfMin: 60, bodyPct: 4, volX: 2, rsiMax: 25, stopPct: 3, holdBars: 12 },
    });
  }
  if (/retest/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Retest do range'),
      thesis: 'No 1h, um range de 30 candles com amplitude até 3% fica congelado. Compra só se um candle fechar acima da máxima e, nos 5 candles seguintes, o preço tocar essa máxima e fechar acima dela. Alvo é a máxima mais a amplitude. Stop na mínima do range. Toque com fechamento abaixo cancela.',
      entry: 'Rompimento no fechamento e retest que fecha de novo acima da máxima.',
      exitText: 'Alvo na máxima do range mais a amplitude. Stop na mínima do range.',
      all: [{ op: 'retest', tfMin: 60, window: 30, maxAmpPct: 3, retestBars: 5 }],
      exit: baseExit(3, 3, 1440, false),
      plan: { kind: 'retest', exact: true, tfMin: 60, window: 30, maxAmpPct: 3, retestBars: 5 },
    });
  }
  return null;
}

function interpret(text) {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  if (raw.trim().length < 8) return null;
  const spec = specs(raw, t);
  if (spec) return spec;

  if (/fila/.test(t) && /verde/.test(t) && /cair|queda|caiu/.test(t)) {
    const drop = (t.match(/cair[^\d%]{0,20}(\d+(?:[.,]\d+)?)\s*%|(\d+(?:[.,]\d+)?)\s*%/) || [])[1] || (t.match(/(\d+(?:[.,]\d+)?)\s*%/) || [])[1];
    const dropPct = drop ? Number(String(drop).replace(',', '.')) : 10;
    return pack({
      name: titleFrom(raw, 'Fila depois da queda'),
      thesis: `Moeda que já subiu bastante e caiu ${dropPct}% ou mais entra numa fila por 3 horas. Só compra se, dentro dessa fila, fechar 2 candles verdes.`,
      entry: `Alta prévia de pelo menos 8% e queda de ${dropPct}% a partir do pico. Fila de 3 horas. Entrada com 2 candles verdes.`,
      exitText: 'Stop 2% · alvo 4% · até 180 min.',
      all: [{ op: 'queue', pumpPct: 8, pumpWindowMin: 180, dropPct, holdMin: hoursOf(raw, 180), greenN: 2, minBodyPct: 0.02 }],
      exit: baseExit(2, 4, 180),
      plan: { kind: 'queue' },
    });
  }

  if (/9h|09h|9 h/.test(t) && /11h|11 h/.test(t) && /m[ií]nima/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Horário de Brasília'),
      thesis: 'Só compra entre 9h e 11h de Brasília, e apenas se o candle furar a mínima dos últimos 30 minutos e fechar de volta acima dela.',
      entry: 'Janela 9h–11h Brasília. Retomada da mínima de 30 minutos.',
      exitText: 'Stop 1,5% · alvo 2,6% · até 120 min.',
      all: [{ op: 'session', startHour: 9, endHour: 11 }, { op: 'reclaim', windowMin: 30 }],
      exit: baseExit(1.5, 2.6, 120),
      plan: { kind: 'session' },
    });
  }

  if (/pir[aâ]mid|metade da m[aã]o|outra metade/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Pirâmide'),
      thesis: 'Entra com metade. Se andar 1% a favor sem tocar o stop, compra a outra metade e leva o stop das duas para o preço da primeira entrada.',
      entry: 'Entrada inicial pela retomada de uma queda recente. A segunda metade entra com +1%.',
      exitText: 'Stop inicial 1,5%. Com +1%, o stop vai para a primeira entrada. Alvo 3%.',
      all: [{ op: 'dump', windowMin: 60, minDumpPct: 2, minLeftPct: 1 }, { op: 'rebound_green', n: 1, minBodyPct: 0.04 }],
      exit: baseExit(1.5, 3, 240),
      plan: { kind: 'pyramid', pyramid: { triggerPct: 1 }, fraction: 0.5 },
    });
  }

  if (/trailing|stop m[oó]vel|sem alvo|seguir o pre[cç]o/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Stop móvel'),
      thesis: 'Sem alvo fixo. Stop inicial de 1,5%. Depois que o trade andar 2% a favor, o stop passa a seguir 1,5% abaixo do topo. Encerra no fim do dia de Brasília.',
      entry: 'Compra numa alta de 1% em 15 minutos para armar o movimento.',
      exitText: 'Stop móvel 1,5% depois de +2%. Sem alvo fixo. Sai no fim do dia.',
      all: [{ op: 'rise', windowMin: 15, minPct: 1 }],
      exit: { stopPct: 1.5, tpPct: 0, maxHoldMin: 1440, timeExit: false },
      plan: { kind: 'trail', trail: { armPct: 2, distPct: 1.5 }, noTarget: true, until: 'brt-close' },
    });
  }

  if (/fibonacci|38[,.]2|61[,.]8/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Fibonacci do dia'),
      thesis: 'Só a moeda que mais subiu em 24 horas. Compra no retrocesso de 38,2% do impulso do dia. Se perder 61,8% antes da entrada, cancela.',
      entry: 'Líder de 24h no nível de 38,2%. Abaixo de 61,8% o sinal morre.',
      exitText: 'Stop 1,8% · alvo 3,2% · até 240 min.',
      all: [{ op: 'fib', level: 38.2, cancel: 61.8, bandPct: 0.35 }],
      exit: baseExit(1.8, 3.2, 240),
      plan: { kind: 'fib' },
    });
  }

  if (/bollinger|squeeze/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Bollinger estreita'),
      thesis: 'Bandas de Bollinger de 20 períodos no gráfico de 5 minutos ficam estreitas por 30 minutos. Compra o rompimento da banda de cima com volume de pelo menos 3 vezes a média.',
      entry: 'Squeeze de 30 minutos e fechamento acima da banda superior com volume 3×.',
      exitText: 'Stop 1,6% · alvo 2,8% · até 180 min.',
      all: [{ op: 'bb_squeeze', period: 20, tfMin: 5, narrowMin: 30, maxWidth: 0.02, volX: 3 }],
      exit: baseExit(1.6, 2.8, 180),
      plan: { kind: 'bb' },
    });
  }

  if (/rsi/.test(t) && /diverg|fundo mais baixo|fundo mais alto/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Divergência de RSI'),
      thesis: 'No gráfico de 15 minutos, compra quando o preço faz um fundo mais baixo e o RSI 14 faz um fundo mais alto.',
      entry: 'Divergência de alta do RSI 14 em 15 minutos.',
      exitText: 'Stop 1,8% · alvo 3,2% · até 240 min.',
      all: [{ op: 'rsi_div', period: 14, tfMin: 15 }],
      exit: baseExit(1.8, 3.2, 240),
      plan: { kind: 'rsi' },
    });
  }

  if (/vwap/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Retomada do VWAP'),
      thesis: 'A moeda fica pelo menos 2 horas abaixo do VWAP do dia. Compra quando uma vela de 5 minutos fecha acima do VWAP.',
      entry: 'Duas horas abaixo do VWAP e fechamento de 5 minutos acima.',
      exitText: 'Stop 1,4% · alvo 2,4% · até 180 min.',
      all: [{ op: 'vwap_reclaim', belowMin: 120, tfMin: 5 }],
      exit: baseExit(1.4, 2.4, 180),
      plan: { kind: 'vwap' },
    });
  }

  if (/funding/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Funding negativo'),
      thesis: 'Compra o spot quando as últimas 3 cobranças de funding do perpétuo estão negativas e o preço do spot está subindo.',
      entry: 'Três fundings negativos e alta do spot.',
      exitText: 'Stop 1,8% · alvo 3,2% · até 240 min. Continua sendo compra no spot.',
      all: [{ op: 'funding_neg', n: 3 }, { op: 'rise', windowMin: 30, minPct: 0.3 }],
      exit: baseExit(1.8, 3.2, 240),
      plan: { kind: 'funding', side: 'long' },
    });
  }

  if (/descoberto|venda a descoberto|\bshort\b|vender a descoberto/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Venda simulada'),
      thesis: 'Venda simulada, só no paper, quando a moeda sobe 15% em 1 hora. Não envia ordem real para a Binance.',
      entry: 'Alta de 15% em 60 minutos. Posição vendida no simulador.',
      exitText: 'Stop 2% acima · alvo 4% abaixo · até 180 min.',
      all: [{ op: 'rise', windowMin: 60, minPct: 15 }],
      exit: baseExit(2, 4, 180),
      plan: { kind: 'short', side: 'short' },
    });
  }

  if (/\bgrid\b/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Grid'),
      thesis: 'Grid de 8 níveis dentro de uma caixa de 8%. Compra a cada queda de 1% e vende essa parcela a cada alta de 1%. Paper, sem ordem real.',
      entry: 'Níveis de 1% em torno do preço em que o grid arma.',
      exitText: 'Cada parcela vende 1% acima da compra. Caixa de 8%.',
      all: [{ op: 'grid', levels: 8, stepPct: 1, boxPct: 8 }],
      exit: baseExit(1, 1.8, 1440, false),
      plan: { kind: 'grid', grid: { levels: 8, stepPct: 1, boxPct: 8 } },
    });
  }

  if (/spread/.test(t) && /parede|livro/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Spread e parede'),
      thesis: 'Compra quando o spread passa de 0,4% e, em até 20 segundos, volta para menos de 0,08% com a parede de venda menor do que estava.',
      entry: 'Spread abre acima de 0,4% e fecha abaixo de 0,08% em 20 segundos, com a oferta puxada.',
      exitText: 'Stop 1,2% · alvo 2,2% · até 60 min.',
      all: [{ op: 'spread_snap', highPct: 0.4, lowPct: 0.08, withinSec: 20 }],
      exit: baseExit(1.2, 2.2, 60),
      plan: { kind: 'spread' },
    });
  }

  if (/absor/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Absorção'),
      thesis: 'O número de negócios fica o dobro da média de 10 minutos e o preço anda menos de 0,15%. Compra se o candle seguinte fechar verde.',
      entry: 'Negócios em excesso, preço parado, candle seguinte verde.',
      exitText: 'Stop 1,2% · alvo 2,2% · até 90 min.',
      all: [{ op: 'absorption', windowMin: 10, tradeX: 2, maxMovePct: 0.15 }],
      filters: [{ op: 'rebound_green', n: 1, minBodyPct: 0.01 }],
      exit: baseExit(1.2, 2.2, 90),
      plan: { kind: 'absorption' },
    });
  }

  if (/segunda perna|segundo recuo/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Segunda perna'),
      thesis: 'Ignora o primeiro recuo de uma alta. Só compra no segundo recuo, e só se ele for menor que o primeiro.',
      entry: 'Dois recuos numa alta. O segundo é mais raso e o preço volta a subir.',
      exitText: 'Stop 1,6% · alvo 2,8% · até 180 min.',
      all: [{ op: 'second_leg', lookbackMin: 180, minSwingPct: 0.8 }],
      exit: baseExit(1.6, 2.8, 180),
      plan: { kind: 'second' },
    });
  }

  if (/listad/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Listagem nova'),
      thesis: 'Moeda listada na Binance há menos de 6 horas. Compra o primeiro fechamento de 15 minutos acima da máxima da primeira hora de negociação.',
      entry: 'Idade da listagem abaixo de 6 horas e fechamento de 15 minutos acima da primeira hora.',
      exitText: 'Stop 2,5% · alvo 4,5% · até 180 min.',
      all: [{ op: 'listing', maxHours: 6, tfMin: 15 }],
      exit: baseExit(2.5, 4.5, 180),
      plan: { kind: 'listing' },
    });
  }

  if (/correla|segue o eth|seguir o eth/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Atraso contra o ETH'),
      thesis: 'Compra quando o ETH sobe mais de 1% em 20 minutos e esta moeda ainda subiu menos de 0,3% na mesma janela.',
      entry: 'ETH +1% em 20 minutos e a moeda abaixo de +0,3%.',
      exitText: 'Stop 1,4% · alvo 2,4% · até 90 min.',
      all: [{ op: 'leader_lag', leader: 'ETHUSDT', windowMin: 20, leaderPct: 1, maxSelfPct: 0.3 }],
      exit: baseExit(1.4, 2.4, 90),
      plan: { kind: 'lag' },
    });
  }

  if (/triplo fundo|tr[eê]s fundos/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Triplo fundo'),
      thesis: 'Três fundos quase no mesmo preço, diferença menor que 0,4%, nas últimas 6 horas. O volume do terceiro é menor que o do primeiro. Compra no rompimento da máxima entre eles.',
      entry: 'Três fundos dentro de 0,4%, volume decrescente, preço acima da máxima do intervalo.',
      exitText: 'Stop 1,6% · alvo 2,8% · até 240 min.',
      all: [{ op: 'triple_low', lookbackMin: 360, maxGapPct: 0.4 }],
      exit: baseExit(1.6, 2.8, 240),
      plan: { kind: 'triple' },
    });
  }

  if (/\bdca\b|a cada\s+\d+\s+horas compra/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Compra periódica'),
      thesis: 'A cada 4 horas compra uma parcela, sem olhar o gráfico. Vende o pacote inteiro quando ele estiver 5% positivo.',
      entry: 'Relógio de 4 horas. Sem gatilho de candle.',
      exitText: 'Vende o pacote a +5%. Stop de emergência em 8%.',
      all: [{ op: 'dca', everyMin: 240, tpPct: 5 }],
      exit: { stopPct: 8, tpPct: 5, maxHoldMin: 1440, timeExit: false },
      plan: { kind: 'dca', dca: { everyMin: 240, tpPct: 5 } },
    });
  }

  if (/dois stops|2 stops|martelo/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Martelo com castigo'),
      thesis: 'Compra um martelo de 5 minutos na mínima do dia. Se a mesma moeda tomar dois stops seguidos, fica proibida por 12 horas.',
      entry: 'Martelo de 5 minutos encostado na mínima do dia, se a moeda não estiver de castigo.',
      exitText: 'Stop 1,4% · alvo 2,4%. Dois stops seguidos bloqueiam a moeda por 12 horas.',
      all: [{ op: 'hammer', tfMin: 5 }],
      exit: baseExit(1.4, 2.4, 180),
      plan: { kind: 'hammer', lock: { stops: 2, banMin: 720 } },
    });
  }

  if (/londres|5h de bras[ií]lia|primeiros 15 minutos/.test(t)) {
    return pack({
      name: titleFrom(raw, 'Abertura de Londres'),
      thesis: 'Às 5h de Brasília marca a máxima e a mínima dos primeiros 15 minutos. Compra se um candle fechar acima dessa máxima. Se não romper em 45 minutos, cancela até o dia seguinte.',
      entry: 'Faixa das 5h00 às 5h15. Rompimento até 5h45. Depois disso o sinal morre.',
      exitText: 'Stop 1,4% · alvo 2,4% · até 120 min.',
      all: [{ op: 'opening_range', hour: 5, minute: 0, rangeMin: 15, validMin: 45 }],
      exit: baseExit(1.4, 2.4, 120),
      plan: { kind: 'orb' },
    });
  }

  return null;
}

function refusesSwap(text) {
  return /n[aã]o troca|n[aã]o crio|n[aã]o cria|sem mudar|exatamente a regra|n[aã]o substitui/i.test(String(text || ''));
}

module.exports = { interpret, refusesSwap, titleFrom };
