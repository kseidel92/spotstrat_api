const { pool } = require('./db');
const { completeRecipe } = require('./llm');
const { id, emptySnap, walletOf, netRR, MIN_NET_RR, validateRecipe, alarmSoundKind } = require('./shared');
const { writeStrategyFile } = require('./sandbox');
const lab = require('./lab');
const bus = require('./bus');

let desk = null;
let running = 0;

function attach(deskApi) {
  desk = deskApi;
}

async function takeJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT * FROM jobs
      WHERE status = 'queued'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    if (!rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    await client.query(`UPDATE jobs SET status = 'running', updated_at = now() WHERE id = $1`, [rows[0].id]);
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function finish(job, patch) {
  await pool.query(
    `UPDATE jobs SET status = $2, output = $3::jsonb, error = $4, strategy_id = COALESCE($5, strategy_id), updated_at = now() WHERE id = $1`,
    [job.id, patch.status, JSON.stringify(patch.output || null), patch.error || null, patch.strategyId || null],
  );
  await settlePrompt(job, patch);
  bus.emit('push', {
    userId: job.user_id,
    msg: { type: 'job', job: { id: job.id, status: patch.status, error: patch.error || null, strategyId: patch.strategyId || job.strategy_id } },
  });
}

function promptOutcome(job, patch) {
  const input = job.input || {};
  if (patch.status === 'needs_user') return { status: 'needs_user', created: false };
  if (patch.status === 'failed') return { status: 'failed', created: false };
  if (patch.output?.mode === 'alarm') return { status: 'alarm', created: false };
  if (patch.status === 'done' && patch.createdStrategy) return { status: 'created', created: true };
  if (patch.status === 'done' && (input.strategyId || job.kind === 'prompt_edit')) return { status: 'updated', created: false };
  if (patch.status === 'done' && job.kind === 'lab') return { status: 'done', created: false };
  if (patch.status === 'done') return { status: 'created', created: true };
  return { status: patch.status || 'failed', created: false };
}

async function settlePrompt(job, patch) {
  const outcome = promptOutcome(job, patch);
  const detail = patch.detail || patch.error || patch.output?.ask || null;
  const name = patch.strategyName || patch.output?.name || null;
  try {
    await pool.query(
      `UPDATE prompts
       SET status = $2,
           created_strategy = $3,
           strategy_id = COALESCE($4, strategy_id),
           strategy_name = COALESCE($5, strategy_name),
           strategy_ids = COALESCE($6::jsonb, strategy_ids),
           detail = $7,
           finished_at = now()
       WHERE job_id = $1`,
      [
        job.id,
        outcome.status,
        outcome.created,
        patch.strategyId || null,
        name,
        patch.strategyIds ? JSON.stringify(patch.strategyIds) : null,
        detail,
      ],
    );
  } catch (err) {
    console.error('[worker] prompt log', err.message);
  }
}

async function say(threadId, content, recipe) {
  await pool.query(
    'INSERT INTO messages (thread_id, role, content, recipe_snapshot) VALUES ($1, $2, $3, $4::jsonb)',
    [threadId, 'assistant', content, recipe ? JSON.stringify(recipe) : null],
  );
}

function suggestTp(stopPct) {
  const stop = Number(stopPct) / 100;
  const fee = 0.00075;
  const need = MIN_NET_RR * (stop + fee + fee) + fee + fee;
  return Math.ceil(need * 1000) / 10;
}

function paintExit(recipe, note, locale) {
  const loc = locale || 'pt-BR';
  const block = (recipe.explanation && (recipe.explanation[loc] || recipe.explanation.en || recipe.explanation['pt-BR'])) || {};
  const time = recipe.exit.timeExit === false
    ? 'Sem saída por tempo.'
    : `Vende a mercado se passarem ${recipe.exit.maxHoldMin} min.`;
  block.exit = `Stop ${recipe.exit.stopPct}% · alvo ${recipe.exit.tpPct}%. ${time}${note ? ` ${note}` : ''}`;
  block.paramsPlain = `stop ${recipe.exit.stopPct}% / alvo ${recipe.exit.tpPct}% / ${recipe.exit.maxHoldMin} min`;
  recipe.explanation = { ...(recipe.explanation || {}), [loc]: block, en: { ...block } };
}

async function shapeRecipe(job, recipe) {
  const options = (job.input || {}).options;
  const locale = (job.input || {}).locale || 'pt-BR';
  if (recipe.plan) return { recipe };
  if (!options) return { recipe };
  if (options.exit === 'manual') {
    const stop = Number(options.stopPct);
    const tp = Number(options.tpPct);
    if (!(stop > 0) || !(tp > 0) || stop > 25) {
      return { ask: 'Informa o stop e o alvo em porcentagem.' };
    }
    const rr = netRR({ stopPct: stop, tpPct: tp });
    if (!rr.ok || rr.netRR < MIN_NET_RR) {
      return { ask: `Com stop ${stop}% e alvo ${tp}% o retorno depois da taxa fica abaixo de ${MIN_NET_RR}. Posso usar alvo ${suggestTp(stop > 0 ? stop : 1.2)}%?` };
    }
    recipe.exit.stopPct = stop;
    recipe.exit.tpPct = tp;
  }
  if (options.timeExit && options.time === 'manual') {
    const hold = Number(options.maxHoldMin);
    if (!(hold >= 5 && hold <= 1440)) return { ask: 'O tempo para vender a mercado fica entre 5 e 1440 minutos.' };
    recipe.exit.maxHoldMin = hold;
    recipe.exit.timeExit = true;
  } else if (options.timeExit && options.time === 'history') {
    recipe.exit.timeExit = true;
  } else if (options.timeExit === false) {
    recipe.exit.timeExit = false;
  }
  let note = '';
  const fitStop = options.exit === 'history';
  const fitHold = !!(options.timeExit && options.time === 'history');
  if (fitStop || fitHold) {
    const fit = await lab.fitExits({
      recipe,
      fitStop,
      fitHold,
      stopPct: recipe.exit.stopPct,
      tpPct: recipe.exit.tpPct,
      maxHoldMin: recipe.exit.maxHoldMin,
    });
    if (fit.ok) {
      if (fitStop) {
        recipe.exit.stopPct = fit.stopPct;
        recipe.exit.tpPct = fit.tpPct;
      }
      if (fitHold) recipe.exit.maxHoldMin = fit.maxHoldMin;
      note = `Busca em ${fit.n} ocorrências nas velas de ${fit.tfMin} min (${fit.symbols.join(', ')}). Média líquida ${fit.avgPct}% nesse recorte. O arquivo de 18 meses não tem livro nem tape.`;
    } else if (fit.reason === 'candle-only') {
      note = 'Esse gatilho não fecha só com vela. O arquivo de 18 meses não tem livro, tape nem maré, então stop e alvo ficaram os que passam a taxa. A variação de fluxo você mede no simulador ao vivo.';
    } else if (fitStop) {
      note = 'Não houve ocorrências suficientes desse gatilho nas velas de 18 meses. Ficou o stop e o alvo que passam a taxa. O arquivo não tem livro nem tape.';
    } else {
      note = 'Não houve ocorrências suficientes para escolher o tempo nas velas de 18 meses.';
    }
  }
  paintExit(recipe, note, locale);
  const check = validateRecipe(recipe);
  if (!check.ok) return { ask: 'Não fechei a receita. Diz o gatilho em uma frase, com a janela em minutos.' };
  return { recipe, note };
}

function variantRecipes(recipe, picked = 'any') {
  const baseFilters = recipe.filters || [];
  const add = (filters) => {
    const copy = JSON.parse(JSON.stringify(recipe));
    copy.filters = baseFilters.filter((op) => !filters.some((f) => f.op === op.op)).concat(filters);
    return copy;
  };
  const list = [{ recipe, mareMode: picked }];
  if (picked !== 'good') {
    list.push({ recipe: { ...JSON.parse(JSON.stringify(recipe)), name: `${recipe.name} · maré boa`.slice(0, 80) }, mareMode: 'good' });
  }
  if (picked !== 'not_bad') {
    list.push({ recipe: { ...JSON.parse(JSON.stringify(recipe)), name: `${recipe.name} · maré não ruim`.slice(0, 80) }, mareMode: 'not_bad' });
  }
  return list.concat([
    { recipe: Object.assign(add([{ op: 'obi', min: 58, persistSec: 1 }]), { name: `${recipe.name} · livro`.slice(0, 80) }), mareMode: picked },
    { recipe: Object.assign(add([{ op: 'tape', min: 0.55, minPrints: 2 }]), { name: `${recipe.name} · tape`.slice(0, 80) }), mareMode: picked },
    { recipe: Object.assign(add([{ op: 'obi', min: 58, persistSec: 1 }, { op: 'tape', min: 0.55, minPrints: 2 }]), { name: `${recipe.name} · livro e tape`.slice(0, 80) }), mareMode: picked },
  ]);
}

async function saveRecipe(job, recipe, extra = {}) {
  const input = job.input || {};
  const mareMode = extra.mareMode || (input.strategyId && !extra.forceNew ? null : 'any');
  let strategyId = extra.forceNew ? null : (input.strategyId || null);
  if (strategyId) {
    await pool.query(
      `UPDATE strategies
       SET name = $1, type = 'recipe', recipe = $2::jsonb, explanation = $3::jsonb,
           description = $4, mare_mode = COALESCE($5, mare_mode)
       WHERE id = $6 AND user_id = $7`,
      [
        recipe.name,
        JSON.stringify(recipe),
        JSON.stringify(recipe.explanation),
        recipe.explanation?.['pt-BR']?.thesis || recipe.explanation?.en?.thesis || recipe.name,
        mareMode,
        strategyId,
        job.user_id,
      ],
    );
  } else {
    strategyId = id('s');
    await pool.query(
      `INSERT INTO strategies (id, user_id, name, type, recipe, mare_mode, description, explanation, source, paused)
       VALUES ($1,$2,$3,'recipe',$4::jsonb,$5,$6,$7::jsonb,'prompt', false)`,
      [
        strategyId,
        job.user_id,
        recipe.name,
        JSON.stringify(recipe),
        mareMode,
        recipe.explanation?.['pt-BR']?.thesis || recipe.name,
        JSON.stringify(recipe.explanation),
      ],
    );
    const wallet = walletOf((job.input || {}).options?.wallet) || undefined;
    await pool.query('INSERT INTO positions (strategy_id, snapshot) VALUES ($1, $2::jsonb)', [strategyId, JSON.stringify(emptySnap(Date.now(), wallet))]);
    if (job.thread_id) {
      await pool.query('UPDATE threads SET strategy_id = $1 WHERE id = $2 AND strategy_id IS NULL', [strategyId, job.thread_id]);
    }
  }
  const locale = input.locale || 'pt-BR';
  const text = recipe.explanation?.[locale] || recipe.explanation?.en || recipe.explanation?.['pt-BR'];
  const summary = text
    ? `${recipe.name}. ${text.thesis} ${text.exit}`
    : recipe.name;
  await say(job.thread_id, summary, recipe);
  if (recipe.code && recipe.plan?.kind === 'js') writeStrategyFile(strategyId, recipe.code);
  return strategyId;
}

async function runJob(job) {
  const input = job.input || {};
  await pool.query(`UPDATE prompts SET status = 'running' WHERE job_id = $1 AND status = 'queued'`, [job.id]);
  if (job.kind === 'lab') {
    const result = await lab.answerQuery({
      prompt: input.prompt,
      userId: job.user_id,
      history: input.history,
      locale: input.locale,
    });
    const payload = result.artifact.payload || result.artifact;
    await finish(job, {
      status: 'done',
      output: {
        artifactId: result.artifact.id,
        cached: result.cached,
        payload,
        reply: payload.reply,
      },
    });
    return;
  }
  const { rows: messages } = await pool.query(
    'SELECT role, content FROM messages WHERE thread_id = $1 ORDER BY created_at',
    [job.thread_id],
  );
  let current = null;
  if (input.strategyId) {
    const found = await pool.query('SELECT recipe FROM strategies WHERE id = $1 AND user_id = $2', [input.strategyId, job.user_id]);
    current = found.rows[0]?.recipe || null;
  }
  const labContext = lab.contextForPrompt(messages.map((m) => m.content).join('\n'));
  const result = await completeRecipe({
    messages,
    locale: input.locale || 'pt-BR',
    current,
    labContext,
    mode: input.mode === 'alarm' ? 'alarm' : 'trade',
  });
  if (result.ask || (result.questions && result.questions.length)) {
    const questions = (result.questions && result.questions.length) ? result.questions : [result.ask];
    const ask = questions[0];
    await say(job.thread_id, ask, null);
    await finish(job, { status: 'needs_user', output: { ask, questions, provider: result.provider }, detail: ask });
    return;
  }
  const shaped = await shapeRecipe(job, result.recipe);
  if (shaped.ask) {
    await say(job.thread_id, shaped.ask, null);
    await finish(job, { status: 'needs_user', output: { ask: shaped.ask, provider: result.provider }, detail: shaped.ask });
    return;
  }
  const recipe = shaped.recipe;
  if (input.mode === 'alarm' && !input.strategyId) {
    const alarmId = await saveAlarm(job, recipe);
    await finish(job, {
      status: 'done',
      output: { provider: result.provider, name: recipe.name, mode: 'alarm', alarmId },
      strategyName: recipe.name,
      detail: alarmId,
    });
    if (desk) await desk.reloadUser(job.user_id);
    return;
  }
  const makeVariants = !!(input.options && input.options.variants) && !input.strategyId;
  const chosen = ['any', 'good', 'not_bad'].includes(input.options?.mareMode) ? input.options.mareMode : null;
  const list = makeVariants ? variantRecipes(recipe, chosen || 'any') : [{ recipe, mareMode: chosen }];
  const strategyIds = [];
  for (let i = 0; i < list.length; i++) {
    strategyIds.push(await saveRecipe(job, list[i].recipe, { mareMode: list[i].mareMode, forceNew: i > 0 }));
  }
  await finish(job, {
    status: 'done',
    output: { provider: result.provider, name: recipe.name, variants: list.length, defaults: recipe.defaults || [] },
    strategyId: strategyIds[0] || null,
    strategyIds,
    strategyName: recipe.name,
    createdStrategy: !input.strategyId,
  });
  if (desk) await desk.reloadUser(job.user_id);
}

function channelsOf(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const volume = Number(src.volume);
  const channels = {
    sound: src.sound !== false,
    email: !!src.email,
    soundKind: alarmSoundKind(src.soundKind),
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0.05, volume)) : 0.85,
  };
  if (!channels.sound && !channels.email) channels.sound = true;
  return channels;
}

async function saveAlarm(job, recipe) {
  const alarmId = id('a');
  const locale = (job.input || {}).locale || 'pt-BR';
  const text = recipe.explanation?.[locale] || recipe.explanation?.en || recipe.explanation?.['pt-BR'];
  const channels = channelsOf((job.input || {}).options?.channels);
  await pool.query(
    `INSERT INTO alarms (id, user_id, name, recipe, explanation, status, channels)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'armed',$6::jsonb)`,
    [alarmId, job.user_id, recipe.name, JSON.stringify(recipe), JSON.stringify(recipe.explanation), JSON.stringify(channels)],
  );
  const summary = text
    ? `Alarme ${recipe.name}. ${text.thesis} Quando disparar, o aviso sai no som e no e-mail marcados. A ordem continua sua.`
    : `Alarme ${recipe.name}.`;
  await say(job.thread_id, summary, recipe);
  return alarmId;
}

async function loop() {
  if (running >= 2) return;
  const job = await takeJob();
  if (!job) return;
  running += 1;
  try {
    await runJob(job);
  } catch (err) {
    console.error('[worker]', err.message);
    const human = 'Não fechei a receita agora. Manda o gatilho de novo em uma frase.';
    if (job.kind === 'lab') {
      const sorry = 'Não consegui responder agora. Tenta de novo em instantes.';
      await finish(job, { status: 'failed', error: sorry, output: { reply: sorry }, detail: err.message });
    } else if (job.thread_id) {
      await say(job.thread_id, human, null).catch(() => {});
      await finish(job, { status: 'needs_user', output: { ask: human }, detail: human });
    } else {
      await finish(job, { status: 'failed', error: human, detail: err.message });
    }
  } finally {
    running -= 1;
  }
}

function start(deskApi) {
  attach(deskApi);
  setInterval(() => {
    loop().catch((err) => console.error('[worker] loop', err));
  }, 400);
  console.log('[worker] fila de prompts ligada');
}

module.exports = { start };
