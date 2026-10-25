const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');
const { pool } = require('./db');

async function logOutbound({
  kind, channel = 'email', to, subject, body, userId = null, meta = null, sent = false, providerId = null, error = null,
}) {
  try {
    await pool.query(
      `INSERT INTO outbound_messages
         (kind, channel, to_addr, subject, body, user_id, meta, sent, provider_id, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
      [
        kind,
        channel,
        to || null,
        subject || null,
        body || null,
        userId,
        meta ? JSON.stringify(meta) : null,
        !!sent,
        providerId,
        error || null,
      ],
    );
  } catch (err) {
    console.warn('[mail] log', err.message);
  }
}

async function notifyOwner(subject, text) {
  const dir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const to = (process.env.OWNER_EMAIL || '').trim();
  const record = { at: new Date().toISOString(), to: to || null, subject, text };
  fs.appendFileSync(path.join(dir, 'mail-outbox.log'), `${JSON.stringify(record)}\n`);
  const hook = (process.env.NOTIFY_WEBHOOK || '').trim();
  if (!hook) {
    console.log('[mail] pedido guardado', subject, to || 'defina OWNER_EMAIL e NOTIFY_WEBHOOK');
    await logOutbound({
      kind: 'owner_notify', to, subject, body: text, sent: false, error: 'no_webhook', meta: { stored: true },
    });
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
    await logOutbound({
      kind: 'owner_notify', to, subject, body: text, sent: res.ok,
      error: res.ok ? null : `webhook_${res.status}`, meta: { stored: true },
    });
    return { sent: res.ok, stored: true, to: to || null };
  } catch (err) {
    console.warn('[mail] webhook', err.message);
    await logOutbound({
      kind: 'owner_notify', to, subject, body: text, sent: false, error: err.message, meta: { stored: true },
    });
    return { sent: false, stored: true, to: to || null };
  } finally {
    clearTimeout(timer);
  }
}

const VERIFY_COPY = {
  'pt-BR': {
    subject: 'Seu código da SpotStrat',
    text: (code) => `Seu código é ${code}. Ele vale por 10 minutos.\n\nSe você não pediu isso, ignore este e-mail.`,
  },
  en: {
    subject: 'Your SpotStrat code',
    text: (code) => `Your code is ${code}. It expires in 10 minutes.\n\nIf you did not ask for this, ignore this email.`,
  },
  es: {
    subject: 'Tu código de SpotStrat',
    text: (code) => `Tu código es ${code}. Vale por 10 minutos.\n\nSi no lo pediste, ignora este correo.`,
  },
  fr: {
    subject: 'Votre code SpotStrat',
    text: (code) => `Votre code est ${code}. Il est valable 10 minutes.\n\nSi vous n’avez rien demandé, ignorez cet e-mail.`,
  },
  de: {
    subject: 'Ihr SpotStrat-Code',
    text: (code) => `Ihr Code ist ${code}. Er gilt 10 Minuten.\n\nWenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail.`,
  },
  ja: {
    subject: 'SpotStratのコード',
    text: (code) => `コードは ${code} です。10分間有効です。\n\n心当たりがなければ、このメールは無視してください。`,
  },
};

function verifyCopy(locale) {
  if (locale === 'es-MX') return VERIFY_COPY.es;
  return VERIFY_COPY[locale] || VERIFY_COPY.en;
}

function resendClient() {
  const key = (process.env.RESEND_API_KEY || '').trim();
  if (!key) return null;
  return new Resend(key);
}

function fromAddress() {
  const email = (process.env.RESEND_SENDER_EMAIL || 'noreply@spotstrat.com').trim();
  const name = (process.env.RESEND_SENDER_NAME || 'SpotStrat').trim();
  return `${name} <${email}>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendMail({ to, subject, text, html, kind = 'email', userId = null }) {
  const resend = resendClient();
  if (!resend) {
    await logOutbound({
      kind, to, subject, body: text, userId, sent: false, error: 'resend_off',
    });
    return { sent: false, skipped: true };
  }
  const replyTo = (process.env.RESEND_REPLY_TO || 'support@spotstrat.com').trim();
  try {
    const { data, error } = await resend.emails.send({
      from: fromAddress(),
      to: [to],
      replyTo,
      subject,
      text,
      html,
    });
    if (error) {
      console.warn('[mail] resend', error.message || error.name || 'erro');
      await logOutbound({
        kind, to, subject, body: text, userId, sent: false,
        error: error.message || error.name || 'resend',
      });
      return { sent: false, error: 'resend' };
    }
    console.log('[mail] enviado', to, data?.id || '');
    await logOutbound({
      kind, to, subject, body: text, userId, sent: true, providerId: data?.id || null,
    });
    return { sent: true, id: data?.id || null };
  } catch (err) {
    console.warn('[mail] resend', err.message);
    await logOutbound({
      kind, to, subject, body: text, userId, sent: false, error: err.message,
    });
    return { sent: false, error: err.message };
  }
}

const RESET_COPY = {
  'pt-BR': {
    subject: 'Nova senha da SpotStrat',
    text: (code) => `Seu código para criar uma senha nova é ${code}. Ele vale por 10 minutos.\n\nSe você não pediu isso, ignore este e-mail.`,
  },
  en: {
    subject: 'New SpotStrat password',
    text: (code) => `Your code to set a new password is ${code}. It expires in 10 minutes.\n\nIf you did not ask for this, ignore this email.`,
  },
  es: {
    subject: 'Nueva contraseña de SpotStrat',
    text: (code) => `Tu código para crear una contraseña nueva es ${code}. Vale por 10 minutos.\n\nSi no lo pediste, ignora este correo.`,
  },
  fr: {
    subject: 'Nouveau mot de passe SpotStrat',
    text: (code) => `Votre code pour créer un nouveau mot de passe est ${code}. Il est valable 10 minutes.\n\nSi vous n’avez rien demandé, ignorez cet e-mail.`,
  },
  de: {
    subject: 'Neues SpotStrat-Passwort',
    text: (code) => `Ihr Code für ein neues Passwort ist ${code}. Er gilt 10 Minuten.\n\nWenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail.`,
  },
  ja: {
    subject: 'SpotStratの新しいパスワード',
    text: (code) => `新しいパスワード用のコードは ${code} です。10分間有効です。\n\n心当たりがなければ、このメールは無視してください。`,
  },
};

function codeHtml(text, code) {
  const safe = escapeHtml(text).replace(/\n/g, '<br>');
  return `<p style="font-family:sans-serif;font-size:16px;color:#0a0e1a">${safe}</p><p style="font-family:sans-serif;font-size:32px;letter-spacing:0.2em;color:#0a0e1a"><strong>${escapeHtml(code)}</strong></p>`;
}

async function sendVerifyCode({ to, code, locale, userId = null }) {
  const copy = verifyCopy(locale);
  const text = copy.text(code);
  return sendMail({ to, subject: copy.subject, text, html: codeHtml(text, code), kind: 'verify', userId });
}

async function sendResetCode({ to, code, locale, userId = null }) {
  const copy = locale === 'es-MX' ? RESET_COPY.es : (RESET_COPY[locale] || RESET_COPY.en);
  const text = copy.text(code);
  return sendMail({ to, subject: copy.subject, text, html: codeHtml(text, code), kind: 'reset', userId });
}

async function sendAlarm({ to, subject, text, userId = null }) {
  const safe = escapeHtml(text).replace(/\n/g, '<br>');
  return sendMail({
    to,
    subject: subject || 'Alarme SpotStrat',
    text,
    html: `<p style="font-family:sans-serif;font-size:16px;color:#0a0e1a">${safe}</p><p style="font-family:sans-serif;font-size:14px;color:#475569">A ordem continua sua. Responda este e-mail se precisar de ajuda.</p>`,
    kind: 'alarm',
    userId,
  });
}

module.exports = { notifyOwner, sendVerifyCode, sendResetCode, sendAlarm, logOutbound };
