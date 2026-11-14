/**
 * Pedidos que o simulador não consegue medir (sem dados no ctx).
 * Retorna { failed: true, error } ou null.
 */
function infeasiblePrompt(text, locale = 'pt-BR') {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  const pt = /^pt/i.test(locale || '');
  const msg = (body) => (pt ? body.pt : body.en);
  const trimmed = raw.trim();
  if (trimmed.length > 0 && trimmed.length < 8) {
    return {
      failed: true,
      error: msg({
        pt: 'Descreve o gatilho em uma frase: o movimento, a janela, e se quiser o stop e o alvo.',
        en: 'Describe the trigger in one sentence: the move, the timeframe, and optionally stop and target.',
      }),
    };
  }

  if (/\blua\b/.test(t) && /(cheia|nova|minguante|quarto crescente)/.test(t)) {
    return {
      failed: true,
      error: msg({
        pt: 'Não dá para criar essa estratégia: o simulador não tem dados de fases da lua. Descreva o gatilho com preço, volume, velas, médias, livro ou tape do par que você está operando.',
        en: 'We cannot create this strategy: the simulator has no moon-phase data. Describe the trigger using price, volume, candles, averages, book or tape for your pair.',
      }),
    };
  }

  if (/\b(pi|π)\b/.test(t) && /(exatamente|igual a|==)/.test(t) && /(spread|cotação|preço|razão)/.test(t)) {
    return {
      failed: true,
      error: msg({
        pt: 'Não dá para criar essa estratégia: pedir um spread ou preço “exatamente π” não é mensurável no mercado. Use níveis, percentuais ou indicadores que o gráfico e o ctx fornecem.',
        en: 'We cannot create this strategy: an “exactly π” spread or price is not measurable in the market. Use levels, percentages or indicators available on the chart and in ctx.',
      }),
    };
  }

  if (/spread/.test(t) && /(eth\s*\/\s*btc|ethbtc)/.test(t) && /(exatamente|igual a)\s*(pi|π|\d+\.\d{5,})/.test(t)) {
    return {
      failed: true,
      error: msg({
        pt: 'Não dá para criar essa estratégia: o spread ETH/BTC exato não está no ctx de cada par. Para spread relativo use a receita “spread ETH/BTC em desvios” com uma moeda (ex.: ETH).',
        en: 'We cannot create this strategy: exact ETH/BTC spread is not in each pair’s ctx. For relative spread use the ETH/BTC z-spread recipe on one symbol (e.g. ETH).',
      }),
    };
  }

  if (/(horóscopo|astrol|signo|mapa astral)/.test(t)) {
    return {
      failed: true,
      error: msg({
        pt: 'Não dá para criar essa estratégia: o motor só usa dados de mercado (velas, livro, tape, médias). Descreva um gatilho de preço ou fluxo.',
        en: 'We cannot create this strategy: the engine only uses market data (candles, book, tape, averages). Describe a price or flow trigger.',
      }),
    };
  }

  return null;
}

/** Código que nunca compra/vende por condições literalmente impossíveis. */
function nonExecutableJs(code, thesis = '') {
  const c = String(code || '');
  const th = String(thesis || '');
  if (!c.includes('function strategy')) return null;

  if (/\blua\w*\s*=\s*false\b/i.test(c) || /\blua\s*cheia\s*=\s*false\b/i.test(c)) {
    return 'lua';
  }
  if (/\b(?:const|let)\s+\w*(?:spread|eth|btc)\w*\s*=\s*null\b/i.test(c) && /=+\s*null/.test(c)) {
    return 'null_signal';
  }
  if (/n[aã]o execut[aá]vel|n[aã]o (pode ser )?medida|n[aã]o est[aá] no contexto/i.test(th)) {
    return 'thesis';
  }
  if (/\bif\s*\(\s*false\s*\)/.test(c) && !/action:\s*["']buy["']/.test(c)) {
    return 'dead_branch';
  }
  return null;
}

function userRejectedFixedExit(text) {
  const t = String(text || '');
  return /na verdade|em vez disso|mas quero|só quero|apenas quero|somente.*(?:rsi|sair)|sair s[oó] quando/i.test(t)
    && /\bstop\b[^\n]{0,40}\d+(?:[.,]\d+)?\s*%/i.test(t);
}

/** Saída pedida só por indicador (ex. RSI) — não preencher OCO no buy. */
function exitIsIndicatorOnly(text) {
  const t = String(text || '');
  if (userRejectedFixedExit(t)) return /rsi|macd|stoch|indicador|banda/i.test(t);
  return /sair s[oó] quando|s[oó] quando.*(?:rsi|macd)|sa[ií]da.*(?:rsi|indicador)/i.test(t)
    && !/\bsa[ií]da\b[^\n]{0,60}\b(?:stop|alvo)\b[^\n]{0,20}\d+(?:[.,]\d+)?\s*%/i.test(t);
}

module.exports = { infeasiblePrompt, nonExecutableJs, userRejectedFixedExit, exitIsIndicatorOnly };
