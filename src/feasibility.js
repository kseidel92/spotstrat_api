/**
 * Membros de ctx que makeCtx realmente entrega.
 * O teste de viabilidade compara esta lista com Object.keys(makeCtx(...)).
 */
const CTX_MEMBERS = [
  'symbol', 'price', 'now', 'pct24', 'open24',
  'hourBrt', 'dayBrt', 'memory', 'position',
  'trades', 'book', 'bookSnaps', 'priceAgo', 'candles',
  'sma', 'ema', 'rsi', 'atr', 'bb', 'macd', 'stoch', 'vwap',
  'highest', 'lowest', 'at', 'crossedUp', 'crossedDown',
];

const CTX_MEMBER_SET = new Set(CTX_MEMBERS);

const CTX_LABELS = {
  symbol: 'par',
  price: 'preço',
  now: 'instante',
  pct24: 'variação de 24h',
  open24: 'abertura de 24h',
  hourBrt: 'hora de Brasília',
  dayBrt: 'dia de Brasília',
  memory: 'memória da regra',
  position: 'posição',
  trades: 'negócios',
  book: 'livro',
  bookSnaps: 'fotos do livro',
  priceAgo: 'preço anterior',
  candles: 'velas',
  sma: 'média móvel',
  ema: 'média móvel',
  rsi: 'RSI',
  atr: 'ATR',
  bb: 'Bandas de Bollinger',
  macd: 'MACD',
  stoch: 'estocástico',
  vwap: 'VWAP',
  highest: 'máxima',
  lowest: 'mínima',
  at: 'valor',
  crossedUp: 'cruzamento para cima',
  crossedDown: 'cruzamento para baixo',
};

const LIQUIDATION_MSG = {
  pt: 'Não dá para criar essa estratégia: o simulador não mede liquidações de futuros nem funding como gatilho. Descreva o gatilho com preço, volume, velas, médias, livro ou tape do par que você está operando.',
  en: 'We cannot create this strategy: the simulator does not measure futures liquidations or funding as a trigger. Describe the trigger using price, volume, candles, averages, book or tape for your pair.',
};

const UNKNOWN_CTX_MSG = {
  pt: 'Não dá para criar essa estratégia: o simulador não mede esse dado como gatilho. Descreva o gatilho com preço, volume, velas, médias, livro ou tape do par que você está operando.',
  en: 'We cannot create this strategy: the simulator does not measure that data as a trigger. Describe the trigger using price, volume, candles, averages, book or tape for your pair.',
};

const DEAD_CODE_MSG = {
  pt: 'Não dá para criar essa estratégia: o pedido usa sinais que o simulador não mede (ex.: lua, spread exato ou dados fora do par). Reformule com velas, volume, médias, livro ou tape.',
  en: 'We cannot create this strategy: the request uses signals the simulator cannot measure. Rephrase using candles, volume, averages, book or tape.',
};

function isPt(locale) {
  return /^pt/i.test(locale || '');
}

function pickMsg(body, locale) {
  return isPt(locale) ? body.pt : body.en;
}

/** Liquidação de futuros ou funding como gatilho — o ctx da estratégia não tem esses dados. */
function asksUnmeasuredMarket(text) {
  const t = String(text || '');
  if (/liquida[cç][aã]o|liquida[cç][oõ]es|\bliquidations?\b/i.test(t)) return true;
  if (/\bfunding(\s+rate)?\b|\btaxa\s+de\s+funding\b/i.test(t)) return true;
  return false;
}

/**
 * Pedidos que o simulador não consegue medir (sem dados no ctx).
 * Retorna { failed: true, error } ou null.
 */
function infeasiblePrompt(text, locale = 'pt-BR') {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  const msg = (body) => pickMsg(body, locale);
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

  if (asksUnmeasuredMarket(raw)) {
    return { failed: true, error: msg(LIQUIDATION_MSG) };
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

function stripJsNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = '';
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (!quote && c === '/' && next === '/') {
      out += '  ';
      i += 2;
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (!quote && c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (!quote && (c === '"' || c === "'" || c === '`')) {
      quote = c;
      out += ' ';
      i += 1;
      continue;
    }
    if (quote) {
      if (c === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if (c === quote) quote = '';
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function noteMember(found, name) {
  if (name && !CTX_MEMBER_SET.has(name)) found.add(name);
}

/** ctx["nome"] / ctx[expr] no código vivo (comentário e string comum não contam). */
function collectBracketMembers(code, found) {
  const src = String(code || '');
  let i = 0;
  const n = src.length;
  let quote = '';
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (!quote && c === '/' && next === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (!quote && c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (!quote && (c === '"' || c === "'" || c === '`')) {
      quote = c;
      i += 1;
      continue;
    }
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = '';
      i += 1;
      continue;
    }
    if (src.startsWith('ctx', i) && (i === 0 || !/[\w$]/.test(src[i - 1]))) {
      let j = i + 3;
      while (src[j] === ' ' || src[j] === '\t' || src[j] === '\n') j += 1;
      if (src[j] === '?' && src[j + 1] === '.') {
        j += 2;
        while (src[j] === ' ' || src[j] === '\t' || src[j] === '\n') j += 1;
      }
      if (src[j] === '[') {
        j += 1;
        while (src[j] === ' ' || src[j] === '\t' || src[j] === '\n') j += 1;
        const q = src[j];
        if (q === '"' || q === "'" || q === '`') {
          j += 1;
          const start = j;
          while (j < n && src[j] !== q) {
            if (src[j] === '\\') j += 2;
            else j += 1;
          }
          noteMember(found, src.slice(start, j));
          i = j + 1;
          continue;
        }
        found.add('*computed*');
        i = j;
        continue;
      }
    }
    i += 1;
  }
}

/** Identificadores ctx.<nome> (e ctx["nome"] / desestruturação) fora da allowlist. */
function unknownCtxMembers(code) {
  const found = new Set();
  collectBracketMembers(code, found);
  const src = stripJsNoise(String(code || ''));
  const dot = /(?<![\w$])ctx\s*\??\s*\.\s*([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = dot.exec(src))) noteMember(found, match[1]);
  const destructure = /\{([^{}]+)\}\s*=\s*ctx\b(?!\s*(?:\?\.|\.|\[|\())/g;
  while ((match = destructure.exec(src))) {
    for (const part of match[1].split(',')) {
      const raw = part.trim();
      if (!raw || raw.startsWith('...')) continue;
      const name = raw.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) noteMember(found, name);
    }
  }
  return [...found];
}

function memberLooksUnmeasured(name) {
  return /liquidat|funding/i.test(name);
}

/** Tira ctx.* da explicação mostrada ao trader. */
function scrubCtxJargon(text) {
  let out = String(text || '');
  out = out.replace(/\bctx\s*\??\s*\.\s*([A-Za-z_$][\w$]*)/g, (_, name) => CTX_LABELS[name] || 'dado de mercado');
  out = out.replace(/\bstrategy\s*\(\s*ctx\s*\)/g, 'a regra');
  out = out.replace(/\bctx\b/g, 'mercado');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/** Código que nunca compra/vende por condições literalmente impossíveis. */
function nonExecutableJs(code, thesis = '') {
  const c = String(code || '');
  const th = String(thesis || '');
  if (!c.includes('function strategy')) return null;

  const unknown = unknownCtxMembers(c);
  if (unknown.length) {
    return unknown.some(memberLooksUnmeasured) ? 'liquidation' : 'unknown_ctx';
  }

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

/** Recusa de código que não pode ser persistido. null se o JS é executável. */
function executableFailure(code, thesis = '', locale = 'pt-BR') {
  const reason = nonExecutableJs(code, thesis);
  if (!reason) return null;
  const body = reason === 'liquidation'
    ? LIQUIDATION_MSG
    : reason === 'unknown_ctx'
      ? UNKNOWN_CTX_MSG
      : DEAD_CODE_MSG;
  return { failed: true, error: pickMsg(body, locale) };
}

module.exports = {
  CTX_MEMBERS,
  infeasiblePrompt,
  nonExecutableJs,
  unknownCtxMembers,
  scrubCtxJargon,
  executableFailure,
  userRejectedFixedExit,
  exitIsIndicatorOnly,
};
