require('dotenv').config();
const http = require('http');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { waitForDb, migrate, pool } = require('./db');
const { createHub } = require('./market');
const { createDesk } = require('./desk');
const { createHttp } = require('./http');
const worker = require('./worker');
const lab = require('./lab');
const bus = require('./bus');

async function main() {
  await waitForDb();
  await migrate();
  lab.loadIndex();
  console.log(`[lab] ${lab.symbols().length} pares · ${lab.artifacts().length} varreduras`);
  const guest = await pool.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, ['kseidel.si@gmail.com']);
  const guestId = guest.rows[0]?.id || null;

  const hub = createHub();
  const desk = createDesk(hub);
  const app = createHttp(desk);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/v1/stream' });
  const clients = new Map();

  bus.focused = () => {
    const ids = new Set();
    for (const set of clients.values()) {
      for (const client of set) if (client.focus) ids.add(client.focus);
    }
    return ids;
  };
  bus.hasUser = (userId) => (clients.get(userId)?.size || 0) > 0;
  bus.on('push', ({ userId, msg }) => {
    const set = clients.get(userId);
    if (!set) return;
    const raw = JSON.stringify(msg);
    for (const client of set) {
      if (msg.type === 'scan' && client.focus && msg.strategyId !== client.focus) continue;
      if (client.ws.readyState === 1) client.ws.send(raw);
    }
  });

  wss.on('connection', (ws, req) => {
    let token = '';
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      token = url.searchParams.get('token') || '';
    } catch (_) { /* ignore */ }
    let payload = null;
    if (token) {
      try { payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET); } catch (_) { payload = null; }
    }
    // TRAVA DE AUTENTICAÇÃO COMENTADA — o websocket abre sem sessão.
    // if (!payload) { ws.close(4001, 'auth'); return; }
    const userId = payload?.sub || guestId;
    if (!userId) {
      ws.close(4001, 'auth');
      return;
    }
    const client = { ws, focus: null };
    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(client);
    desk.stateFor(userId).then((state) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'snapshot', ...state }));
    }).catch(() => {});
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch (_) { return; }
      if (msg.type === 'focus') client.focus = msg.strategyId || null;
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    });
    const beat = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
      else clearInterval(beat);
    }, 25000);
    ws.on('close', () => {
      clearInterval(beat);
      clients.get(userId)?.delete(client);
    });
  });

  const port = Number(process.env.PORT || 7171);
  server.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  worker.start(desk);
  hub.start();
  desk.start();
  console.log(`[api] http://127.0.0.1:${port}`);

  const shutdown = async () => {
    console.log('[api] encerrando');
    server.close();
    hub.stop();
    await desk.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
