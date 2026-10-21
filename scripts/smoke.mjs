const base = process.env.API || 'http://127.0.0.1:7171';

async function j(path, opts = {}) {
  const res = await fetch(base + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${opts.method || 'GET'} ${path} -> ${res.status} ${data.message || data.error || ''}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const health = await j('/v1/health');
  assert(health.ok, 'health');
  const presets = await j('/v1/presets?locale=pt-BR');
  assert(presets.presets.length === 6, 'presets');

  const stamp = Date.now();
  const email = `smoke${stamp}@tradeai.local`;
  const phone = `+55119${String(stamp).slice(-8)}`;
  const reg = await j('/v1/auth/register', {
    method: 'POST',
    body: { email, password: 'senha-forte', phone, name: 'Smoke', locale: 'pt-BR' },
  });
  assert(reg.verification.emailCode && reg.verification.phoneCode, 'códigos na resposta');
  console.log('otp', reg.verification.emailCode, reg.verification.phoneCode);

  const early = await j('/v1/auth/login', { method: 'POST', body: { email, password: 'senha-forte' } });
  let token = early.accessToken;
  let denied = false;
  try {
    await j('/v1/desk/state', { token });
  } catch (err) {
    denied = err.status === 403;
  }
  assert(denied, 'desk bloqueado antes da verificação');

  const afterEmail = await j('/v1/auth/verify-email', { method: 'POST', token, body: { code: reg.verification.emailCode } });
  assert(afterEmail.user.emailVerified && !afterEmail.user.phoneVerified, 'só e-mail');
  assert(afterEmail.user.desk === 'trial', 'trial após e-mail');
  const afterPhone = await j('/v1/auth/verify-phone', { method: 'POST', token, body: { code: reg.verification.phoneCode } });
  assert(afterPhone.user.desk === 'trial', 'trial');

  const list = await j('/v1/strategies', { token });
  assert(list.strategies.length === 6, `6 presets, veio ${list.strategies.length}`);
  const state = await j('/v1/desk/state', { token });
  assert(state.strategies.length === 6, 'desk');
  assert(state.mare && state.mare.label, 'maré');

  const created = await j('/v1/strategies/prompt', {
    method: 'POST',
    token,
    body: { prompt: 'Quero uma caixa de 4 horas com dois toques no piso e um no teto, stop 1,6% e alvo 2,2%.' },
  });
  let job;
  for (let i = 0; i < 40; i++) {
    job = await j(`/v1/jobs/${created.jobId}`, { token });
    if (['done', 'failed', 'needs_user'].includes(job.job.status)) break;
    await sleep(250);
  }
  assert(job.job.status === 'done', `job ${job.job.status} ${job.job.error || ''}`);
  const detail = await j(`/v1/strategies/${job.job.strategy_id}`, { token });
  assert(detail.strategy.type === 'recipe', 'recipe');
  assert(detail.messages.length >= 2, 'thread');

  const vague = await j('/v1/strategies/prompt', {
    method: 'POST',
    token,
    body: { prompt: 'compra o fundo da caixa de 4h com stop 2% e alvo 2%' },
  });
  let asked;
  for (let i = 0; i < 40; i++) {
    asked = await j(`/v1/jobs/${vague.jobId}`, { token });
    if (asked.job.status !== 'queued' && asked.job.status !== 'running') break;
    await sleep(250);
  }
  assert(asked.job.status === 'needs_user', `esperava pergunta, veio ${asked.job.status}`);
  const follow = await j('/v1/strategies/prompt', {
    method: 'POST',
    token,
    body: { prompt: 'sim, pode', threadId: vague.threadId },
  });
  let done;
  for (let i = 0; i < 40; i++) {
    done = await j(`/v1/jobs/${follow.jobId}`, { token });
    if (done.job.status === 'done' || done.job.status === 'failed') break;
    await sleep(250);
  }
  assert(done.job.status === 'done', done.job.error || done.job.status);

  const id0 = list.strategies[0].id;
  await j(`/v1/strategies/${id0}/pause`, { method: 'POST', token });
  await j(`/v1/strategies/${id0}/resume`, { method: 'POST', token });
  await j(`/v1/strategies/${id0}/reset`, { method: 'POST', token });
  await j(`/v1/strategies/${job.job.strategy_id}`, { method: 'DELETE', token });
  await j('/v1/strategies/restore-presets', { method: 'POST', token });

  const manifest = await j('/v1/lab/manifest', { token });
  assert(manifest.symbols > 10, 'manifest');
  const symbols = await j('/v1/lab/symbols', { token });
  assert(symbols.symbols.some((s) => s.symbol === 'BTCUSDT'), 'btc');
  const bars = await j('/v1/lab/klines/BTCUSDT?interval=1h&limit=48', { token });
  assert(bars.bars.length === 48, `barras ${bars.bars.length}`);
  const arts = await j('/v1/lab/artifacts', { token });
  assert(arts.artifacts.length > 5, 'artifacts');
  const labJob = await j('/v1/lab/query', { method: 'POST', token, body: { prompt: 'variação de BTCUSDT nos 18 meses' } });
  let labDone;
  for (let i = 0; i < 40; i++) {
    labDone = await j(`/v1/jobs/${labJob.jobId}`, { token });
    if (labDone.job.status === 'done' || labDone.job.status === 'failed') break;
    await sleep(200);
  }
  assert(labDone.job.status === 'done', 'lab job');
  assert(labDone.job.output.payload.symbol.symbol === 'BTCUSDT', 'lab symbol');

  const me = await j('/v1/me', { token });
  const patched = await j('/v1/me', {
    method: 'PATCH',
    token,
    body: { name: 'Smoke 2', marePrefs: { enabled: true, windowMs: 300000, majority: 0.6, noisePct: 0.05 } },
  });
  assert(patched.user.name === 'Smoke 2', 'patch');
  assert(me.user.email === email, 'me');

  const refused = await j('/v1/strategies/prompt', {
    method: 'POST',
    token,
    body: { prompt: 'abre um short alavancado em futuros de BTC' },
  });
  let no;
  for (let i = 0; i < 30; i++) {
    no = await j(`/v1/jobs/${refused.jobId}`, { token });
    if (no.job.status !== 'queued' && no.job.status !== 'running') break;
    await sleep(200);
  }
  assert(no.job.status === 'needs_user', 'recusa short');

  console.log('smoke ok', email);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
