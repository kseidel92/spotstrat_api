const fs = require('fs');
const path = require('path');

async function notifyOwner(subject, text) {
  const dir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const to = (process.env.OWNER_EMAIL || '').trim();
  const record = { at: new Date().toISOString(), to: to || null, subject, text };
  fs.appendFileSync(path.join(dir, 'mail-outbox.log'), `${JSON.stringify(record)}\n`);
  const hook = (process.env.NOTIFY_WEBHOOK || '').trim();
  if (!hook) {
    console.log('[mail] pedido guardado', subject, to || 'defina OWNER_EMAIL e NOTIFY_WEBHOOK');
    return { sent: false, stored: true, to: to || null };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, subject, text }),
      signal: controller.signal,
    });
    console.log('[mail] webhook', res.status, subject);
    return { sent: res.ok, stored: true, to: to || null };
  } catch (err) {
    console.warn('[mail] webhook', err.message);
    return { sent: false, stored: true, to: to || null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { notifyOwner };
