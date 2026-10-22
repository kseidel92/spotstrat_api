const { validateRecipe, netRR, MIN_NET_RR, OPS } = require('./shared');
const { CATALOG, fromModel, RESPONSE_SCHEMA, systemPrompt } = require('./llmSchema');
const { refusesSwap } = require('./interpret');
const { recipeFromModel } = require('./script');
const { buildJsRecipe } = require('./sandbox');

const REFUSAL = /futuros|future|perp|short|vendido|alavanc|leverage|grid|funding|liquida[cç][aã]o|op[cç][aã]o|margin/i;

function numbersFrom(text) {
  const found = [];
  const re = /(\d+(?:[.,]\d+)?)\s*%/g;
  let m;
  while ((m = re.exec(text))) found.push(Number(m[1].replace(',', '.')));
  return found;
}

function pairStops(text) {
  const stop = text.match(/stop(?:\s+loss)?\s*(?:de|em|a|=|:)?\s*(\d+(?:[.,]\d+)?)\s*%/i);
  const tp = text.match(/(?:alvo|take profit|tp|target)\s*(?:de|em|a|=|:)?\s*(\d+(?:[.,]\d+)?)\s*%/i);
  return {
    stopPct: stop ? Number(stop[1].replace(',', '.')) : null,
    tpPct: tp ? Number(tp[1].replace(',', '.')) : null,
  };
}

function suggestTp(stopPct) {
  const stop = stopPct / 100;
  const fee = 0.00075;
  const need = MIN_NET_RR * (stop + fee + fee) + fee + fee;
  return Math.ceil(need * 1000) / 10;
}

function baseRecipe(kind) {
  if (kind === 'touches') {
    return {
      name: 'Caixa de toques',
      all: [{ op: 'touches', lookbackMin: 240, minLo: 2, minHi: 1, touchPct: 0.55, sepMin: 12 }, { op: 'range_pos', lookbackMin: 240, maxPos: 0.22, minPos: 0.02 }],
      filters: [{ op: 'rebound_green', n: 1, minBodyPct: 0.06 }, { op: 'obi', min: 62, persistSec: 1.2 }, { op: 'mare', mode: 'any' }],
      stopPct: 1.6, tpPct: 2.2, maxHoldMin: 40, noRepeatMin: 360,
      thesis: 'Compra o fundo de uma caixa que já tem dois pisos e um teto.',
    };
  }
  if (kind === 'swings') {
    return {
      name: 'Serra larga',
      all: [{ op: 'swings', lookbackMin: 120, minSwings: 6, minSwingPct: 1.6, minRangePct: 8, maxRangePct: 16, maxPos: 0.22 }],
      filters: [{ op: 'rebound_green', n: 2, minBodyPct: 0.08 }, { op: 'obi', min: 62, persistSec: 1.2 }, { op: 'mare', mode: 'any' }],
      stopPct: 4, tpPct: 6, maxHoldMin: 720, noRepeatMin: 480,
      thesis: 'Serra já desenhada, compra no fundo da faixa com stop largo.',
    };
  }
  if (kind === 'dump') {
    return {
      name: 'Queda e rebote',
      all: [{ op: 'dump', windowMin: 30, minDumpPct: 10, minLeftPct: 3 }],
      filters: [{ op: 'rebound_green', n: 1, minBodyPct: 0.05 }, { op: 'obi', min: 62, persistSec: 1.2 }, { op: 'tape', min: 0.58, max: 0.9, minPrints: 4 }, { op: 'btc_dump', windowMin: 30, maxDropPct: 6 }],
      stopPct: 1.3, tpPct: 2.5, maxHoldMin: 40, noRepeatMin: 600,
      thesis: 'Depois de uma queda forte, compra o rebote com livro e tape.',
    };
  }
  if (kind === 'lead') {
    return {
      name: 'Liderança do dia',
      all: [{ op: 'rs_lead', rankN: 3, minExcess24: 0.4 }],
      filters: [{ op: 'obi', min: 58, persistSec: 0.8 }, { op: 'mare', mode: 'any' }],
      stopPct: 2.8, tpPct: 6.5, maxHoldMin: 90, noRepeatMin: 180,
      thesis: 'Compra uma das forças de 24 horas contra o BTC, com stop percentual que fecha o R:R.',
    };
  }
  if (kind === 'spike') {
    return {
      name: 'Spike curto',
      all: [{ op: 'spike', minRet15: 0.03, maxRet15: 0.1, minVolX: 2 }],
      filters: [{ op: 'obi', min: 62, persistSec: 1.2 }, { op: 'tape', min: 0.55, max: 0.7, minPrints: 4 }, { op: 'mare', mode: 'any' }],
      stopPct: 1.8, tpPct: 3.2, maxHoldMin: 90, noRepeatMin: 120,
      thesis: 'Spike de 15 minutos com livro ainda comprador. O stop é mais curto que o da anomalia antiga para o R:R líquido passar de 1,15.',
    };
  }
  if (kind === 'laggard') {
    return {
      name: 'Fundo relativo',
      all: [{ op: 'mare_laggard', minDd: 0.12 }],
      filters: [{ op: 'mare', mode: 'good' }, { op: 'obi', min: 62, persistSec: 1.2 }],
      stopPct: 2.2, tpPct: 4.2, maxHoldMin: 180, noRepeatMin: 180,
      thesis: 'Na maré boa, compra a que mais caiu contra a máxima recente, com alvo que paga a taxa.',
    };
  }
  return {
    name: 'Fundo de faixa',
    all: [{ op: 'range_pos', lookbackMin: 240, maxPos: 0.2, minPos: 0.02 }, { op: 'age_extreme', minAge: 2, maxAge: 30 }],
    filters: [{ op: 'rebound_green', n: 1, minBodyPct: 0.06 }, { op: 'obi', min: 60, persistSec: 1 }, { op: 'mare', mode: 'any' }],
    stopPct: 1.6, tpPct: 2.4, maxHoldMin: 60, noRepeatMin: 240,
    thesis: 'Compra quando o preço está na parte baixa da faixa recente e uma vela verde fecha.',
  };
}

function detectKind(text) {
  const t = text.toLowerCase();
  if (/toque|caixa|piso/.test(t)) return 'touches';
  if (/serra|zigzag|oscil/.test(t)) return 'swings';
  if (/queda|dump|rebote|despenc/.test(t)) return 'dump';
  if (/lider|força|forca|rank/.test(t)) return 'lead';
  if (/spike|anomalia|explos/.test(t)) return 'spike';
  if (/maré|mare|caíd|caid|atrasad|fund[oa]/.test(t)) return 'laggard';
  if (/faixa|range|fundo/.test(t)) return 'range';
  return null;
}

function materialize(base, locale) {
  const explanation = {
    thesis: base.thesis,
    entry: base.all.map((op) => op.op).join(', '),
    exit: `stop ${base.stopPct}% · alvo ${base.tpPct}% · ${base.maxHoldMin} min`,
    filters: base.filters.map((op) => op.op).join(', '),
    risks: 'Paper Spot LONG. Taxa 0,075%. Halt de 8% no dia de Brasília. Lote de 1% do equity pela distância do stop, teto 95% da caixa. Histórico de 18 meses não tem livro nem tape.',
    paramsPlain: `stop ${base.stopPct}% / alvo ${base.tpPct}% / ${base.maxHoldMin} min`,
  };
  return {
    name: base.name,
    explanation: { [locale || 'pt-BR']: explanation, en: explanation },
    entry: { all: base.all, any: [] },
    filters: base.filters,
    exit: { stopPct: base.stopPct, tpPct: base.tpPct, maxHoldMin: base.maxHoldMin },
    pacing: { noRepeatMin: base.noRepeatMin, stopCooldownMin: 60 },
  };
}

function confirmingText(text) {
  return /^(sim|pode|ok|isso|confirmo|pode usar|fecha|manda)\b/i.test(String(text || '').trim());
}

function looksInternal(text) {
  return /stopPct|tpPct|maxHoldMin|entrada sem gatilho|primitivo|obrigat|R:R líquido/i.test(String(text || ''));
}

function readName(text) {
  const m = String(text || '').match(/chamad[oa]\s+["“']?([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9 _-]{1,40}?)(?:\s*,|\s+onde|\s+que|\s+com|\s+para|$)/i);
  if (!m) return '';
  const clean = m[1].trim();
  if (clean.length < 3) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function readEma(text) {
  const t = String(text || '');
  if (!/\bema\b/i.test(t)) return null;
  const nums = [];
  const pair = t.match(/\bema\s*(\d+)\s*\/\s*(\d+)/i);
  if (pair) nums.push(Number(pair[1]), Number(pair[2]));
  for (const m of t.matchAll(/\bema\s*(\d+)/gi)) nums.push(Number(m[1]));
  const distinct = [];
  for (const n of nums) if (n > 0 && !distinct.includes(n)) distinct.push(n);
  if (distinct.length === 1 && /acima da ema|pre[cç]o acima da/i.test(t) && !/cruz/i.test(t)) {
    return { kind: 'above', period: distinct[0] };
  }
  if (distinct.length < 2) return null;
  let fast = distinct[0];
  let slow = distinct[1];
  if (slow < fast) [fast, slow] = [slow, fast];
  if (slow === fast) return null;
  return { kind: 'cross', fast, slow, dir: /para baixo|death/i.test(t) ? 'down' : 'up' };
}

function detailedSpec(text) {
  const t = String(text || '');
  return t.length > 180 && /compro|compra/i.test(t) && /vendo|saio|stop|sa[ií]da/i.test(t);
}

function readEngulf(text) {
  const t = String(text || '');
  if (!/engulf|engolfo|engolfe|engol/i.test(t)) return null;
  const bear = /bearish|baixa|de baixa|para baixo/i.test(t);
  let tfMin = 15;
  const minutes = t.match(/(\d+)\s*(?:minutos|minuto|min)\b/i);
  const hours = t.match(/(\d+)\s*(?:horas|hora|h)\b/i);
  if (minutes) tfMin = Number(minutes[1]);
  else if (hours) tfMin = Number(hours[1]) * 60;
  if (!(tfMin >= 1 && tfMin <= 240)) tfMin = 15;
  return { dir: bear ? 'bear' : 'bull', tfMin };
}

function readRise(text) {
  const t = String(text || '').toLowerCase();
  if (!/subir|suba|subiu|sobe|sobem|alta|explod|pump|dispar|estour/.test(t)) return null;
  const pct = t.match(/(\d+(?:[.,]\d+)?)\s*%/);
  const win = t.match(/(\d+)\s*(?:minutos|minuto|min)\b/);
  if (!pct || !win) return null;
  const minPct = Number(pct[1].replace(',', '.'));
  const windowMin = Number(win[1]);
  if (!(minPct > 0) || !(windowMin >= 1 && windowMin <= 240)) return null;
  return { op: 'rise', windowMin, minPct };
}

function knownOps(list) {
  return (Array.isArray(list) ? list : []).filter((op) => op && OPS.has(op.op));
}

function unaskedEma(text, recipe) {
  const ops = [
    ...(recipe.entry?.all || []),
    ...(recipe.entry?.any || []),
  ].map((op) => op.op);
  if (!ops.length || ops.some((op) => op !== 'ema_cross' && op !== 'ema_above')) return false;
  return !/ema|m[eé]dia m[oó]vel/i.test(text);
}

function settle(data, { messages, locale, current, mode }) {
  const users = (messages || []).filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  const lastText = (last && last.content) || '';
  const blob = users.map((m) => m.content).join('\n');
  if (!data) {
    if (lastText.trim().length < 8 && !confirmingText(lastText)) {
      return { ask: 'Descreve o gatilho em uma frase: o movimento, a janela, e se quiser o stop e o alvo.' };
    }
    return { ask: 'Não achei o gatilho. Diz o movimento e a janela, por exemplo: sobe 1% em 3 minutos.' };
  }
  if (refusesSwap(lastText)) return { ask: 'Não crio uma estratégia diferente da que você descreveu.' };
  if (data.code || data.ask || (Array.isArray(data.questions) && data.questions.length)) return buildJsRecipe(data, blob, locale, { alarm: mode === 'alarm' });
  return recipeFromModel(data, blob, locale);
}

function mockComplete({ messages, locale, current }) {
  return settle(null, { messages, locale, current });
}

function recipeToBase(recipe) {
  return {
    name: recipe.name,
    thesis: (recipe.explanation && (recipe.explanation['pt-BR'] || recipe.explanation.en) || {}).thesis || recipe.name,
    all: JSON.parse(JSON.stringify(recipe.entry.all || [])),
    filters: JSON.parse(JSON.stringify(recipe.filters || [])),
    stopPct: recipe.exit.stopPct,
    tpPct: recipe.exit.tpPct,
    maxHoldMin: recipe.exit.maxHoldMin,
    noRepeatMin: (recipe.pacing && recipe.pacing.noRepeatMin) || 360,
  };
}

function secret(name) {
  return String(process.env[name] || '').trim().replace(/^['"]|['"]$/g, '');
}

async function callOpenAI({ messages, locale, extra }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt(locale) + (extra ? `\n${extra}` : '') },
        ...messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'recipe_or_ask', strict: true, schema: RESPONSE_SCHEMA },
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error?.message || `OpenAI HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const content = body.choices?.[0]?.message?.content;
  return JSON.parse(content);
}

async function callAnthropic({ messages, locale, extra }) {
  const history = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  if (extra) {
    const last = history[history.length - 1];
    if (last && last.role === 'user') last.content = `${last.content}\n\n${extra}`;
    else history.push({ role: 'user', content: extra });
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': secret('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
      max_tokens: 8000,
      cache_control: { type: 'ephemeral', ttl: '1h' },
      system: [
        {
          type: 'text',
          text: `${systemPrompt(locale)}\nResponda só o JSON do schema, sem markdown.`,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: history,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Anthropic HTTP ${res.status}`);
  const usage = body.usage || {};
  if (usage.cache_creation_input_tokens || usage.cache_read_input_tokens) {
    console.log(`[llm] cache criado ${usage.cache_creation_input_tokens || 0} lido ${usage.cache_read_input_tokens || 0}`);
  }
  const text = (body.content || []).map((c) => c.text || '').join('');
  try {
    return parseModelJson(text);
  } catch (err) {
    const error = new Error(`${err.message} (${body.stop_reason || 'sem motivo'}, ${text.length} caracteres)`);
    throw error;
  }
}

function parseModelJson(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* tenta a função */ }
  }
  const code = extractStrategy(raw);
  if (!code) throw new Error('A resposta não fechou um JSON');
  return { ask: '', questions: [], defaults: [], name: 'Estratégia', thesis: 'Regra do pedido.', entryText: '', exitText: '', risks: '', code };
}

function extractStrategy(text) {
  const at = text.search(/function\s+strategy\s*\(/);
  if (at < 0) return '';
  const open = text.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(at, i + 1);
    }
  }
  return '';
}

function vagueAsk(result) {
  return result && result.ask && /Não achei o gatilho|Descreve o gatilho/.test(result.ask);
}

const ALARM_NOTE = [
  'Este pedido é um alarme. A pessoa já marcou som, e-mail ou os dois. Isso não é trabalho do código.',
  'O desk toca o som e manda o e-mail quando strategy devolve { action: "alert", stop, target }.',
  'hold só quando a condição ainda não aconteceu. Se a condição for verdadeira e o código devolver hold, ninguém ouve o aviso.',
  'Não escreva no thesis, no risks nem no código que o aviso não sai, que não há rede ou que a estratégia não notifica.',
  'alert não abre ordem. A ordem continua com a pessoa.',
].join('\n');

async function completeRecipe({ messages, locale, current, labContext, mode }) {
  const local = settle(null, { messages, locale, current, mode });
  const openai = secret('OPENAI_API_KEY');
  const anthropic = secret('ANTHROPIC_API_KEY');
  const provider = openai ? 'openai' : anthropic ? 'anthropic' : '';
  if (!provider || !vagueAsk(local)) return { ...local, provider: provider ? 'local' : 'mock' };
  const extra = [
    current ? `Receita atual (mude só o que o usuário pediu): ${JSON.stringify(current)}` : '',
    labContext ? `Histórico antigo de preço, só vela. O ao vivo tem ctx.trades e ctx.book: ${labContext}` : '',
    'Escreva function strategy(ctx) com os números do pedido. Use ctx.trades e ctx.book quando a regra falar de fluxo, tape, aggTrades ou livro. Se faltar número, crie com um padrão em defaults. Não recuse.',
    mode === 'alarm' ? ALARM_NOTE : '',
  ].filter(Boolean).join('\n');
  let data = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const note = attempt ? `${extra}\nA resposta anterior não fechou um JSON válido. Responda só o JSON.` : extra;
      data = provider === 'openai'
        ? await callOpenAI({ messages, locale, extra: note })
        : await callAnthropic({ messages, locale, extra: note });
      break;
    } catch (err) {
      console.error('[llm]', err.message);
      if (provider === 'openai' && err.status === 429 && anthropic) {
        try {
          data = await callAnthropic({ messages, locale, extra });
          break;
        } catch { /* tenta de novo no laço */ }
      }
      if (attempt === 1) data = null;
    }
  }
  let settled = settle(data, { messages, locale, current, mode });
  for (let fix = 0; fix < 2 && settled.retry; fix++) {
    try {
      const note = `${extra}\n${settled.ask}`;
      const again = provider === 'openai'
        ? await callOpenAI({ messages, locale, extra: note })
        : await callAnthropic({ messages, locale, extra: note });
      const second = settle(again, { messages, locale, current, mode });
      if (second.recipe || (second.ask && !vagueAsk(second))) settled = second;
    } catch (err) {
      console.error('[llm]', err.message);
      break;
    }
  }
  if (settled.recipe) return { ...settled, provider };
  if (settled.ask && !vagueAsk(settled)) return { ...settled, provider };
  return {
    ask: 'Não fechei o código. Reenvia o gatilho que eu escrevo de novo.',
    questions: ['Qual é o gatilho de entrada, com a porcentagem e o tempo?'],
    provider,
  };
}

function labSystemPrompt(locale, labContext) {
  const lang = /^pt/i.test(locale || '') ? 'português do Brasil'
    : /^es/i.test(locale || '') ? 'español'
      : /^fr/i.test(locale || '') ? 'français'
        : /^de/i.test(locale || '') ? 'Deutsch'
          : /^ja/i.test(locale || '') ? '日本語'
            : 'English';
  return [
    `Você é o assistente do Laboratório SpotStrat: conversa sobre ideias de estratégia spot LONG (paper), Binance, simulador ao vivo.`,
    `Responda em ${lang}, tom claro e direto (pode usar títulos curtos e listas).`,
    'Não crie código function strategy(ctx) aqui. Se pedirem para rodar no simulador, oriente a usar a aba Estratégias → Montar em passos.',
    'Não invente números de backtest que não estejam no contexto. Diferencie o arquivo de 18 meses (só vela 1m) do ao vivo (livro e tape).',
    'Para pedidos de prós/contras e aprimoramento: seja específico (falsos rompimentos, taxa, halt diário, maré, liquidez, multi-timeframe).',
    labContext ? `Contexto do laboratório:\n${labContext}` : '',
  ].filter(Boolean).join('\n\n');
}

async function callOpenAIText({ system, messages }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.35,
      max_tokens: 2500,
      messages: [
        { role: 'system', content: system },
        ...messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      ],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error?.message || `OpenAI HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return String(body.choices?.[0]?.message?.content || '').trim();
}

async function callAnthropicText({ system, messages }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': secret('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
      max_tokens: 2500,
      system,
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Anthropic HTTP ${res.status}`);
  return (body.content || []).map((c) => c.text || '').join('').trim();
}

async function completeLabChat({ messages, locale, labContext }) {
  const system = labSystemPrompt(locale, labContext);
  const trimmed = messages.slice(-16);
  const openai = secret('OPENAI_API_KEY');
  const anthropic = secret('ANTHROPIC_API_KEY');
  if (anthropic) {
    try {
      return { reply: await callAnthropicText({ system, messages: trimmed }), provider: 'anthropic' };
    } catch (err) {
      console.error('[lab-llm]', err.message);
      if (!openai) throw err;
    }
  }
  if (openai) {
    return { reply: await callOpenAIText({ system, messages: trimmed }), provider: 'openai' };
  }
  return { reply: '', provider: 'none' };
}

const GUIDE_SPEC = {
  touches: { entryType: 'pattern', sources: ['candles'] },
  swings: { entryType: 'momentum', sources: ['candles'] },
  dump: { entryType: 'momentum', sources: ['candles', 'trades', 'book'] },
  lead: { entryType: 'momentum', sources: ['candles', 'book'] },
  spike: { entryType: 'momentum', sources: ['candles', 'trades', 'book'] },
  laggard: { entryType: 'momentum', sources: ['candles'] },
  range: { entryType: 'breakout', sources: ['candles'] },
  pattern: { entryType: 'pattern', sources: ['candles'], stopPct: 0.8, tpPct: 1.2, name: 'Engolfo no fundo' },
  cross: { entryType: 'cross', sources: ['candles', 'ema'], stopPct: 0.8, tpPct: 1.6, name: 'Cruzamento de médias' },
  breakout: { entryType: 'breakout', sources: ['candles'], stopPct: 1.2, tpPct: 2.2, name: 'Rompimento de faixa' },
  momentum: { entryType: 'momentum', sources: ['candles', 'trades'], stopPct: 1, tpPct: 1.8, name: 'Impulso curto' },
};

function guideKindOf(guide) {
  const text = String(guide?.entry || '');
  const known = detectKind(text);
  if (known) return known;
  const t = text.toLowerCase();
  if (/engulf|engolfo|engolfe|padrão de vela|padrao de vela/.test(t)) return 'pattern';
  if (/\bema\b|cruzamento|cruzar|cruza/.test(t)) return 'cross';
  if (/romp|breakout|máxima das|maxima das/.test(t)) return 'breakout';
  if (/sobe|subir|impulso|momentum/.test(t)) return 'momentum';
  const type = String(guide?.entryType || '');
  if (GUIDE_SPEC[type]) return type;
  return 'touches';
}

function suggestGuide(guide, step) {
  const kind = guideKindOf(guide || {});
  const spec = GUIDE_SPEC[kind] || GUIDE_SPEC.touches;
  const catalogued = !['pattern', 'cross', 'breakout', 'momentum'].includes(kind);
  const base = catalogued ? baseRecipe(kind) : null;
  const allowed = ['entry', 'entryType', 'sources', 'list', 'exit', 'review'];
  return {
    step: allowed.includes(step) ? step : 'entry',
    kind,
    entryType: spec.entryType,
    sources: spec.sources,
    list: 'no',
    exitKind: 'numbers',
    stop: String(spec.stopPct ?? base.stopPct),
    target: String(spec.tpPct ?? base.tpPct),
    name: spec.name || base.name,
  };
}

module.exports = {
  completeRecipe, completeLabChat, mockComplete, settle, parseModelJson, CATALOG, detectKind, baseRecipe, suggestGuide,
};
