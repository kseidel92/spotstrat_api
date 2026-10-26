#!/usr/bin/env node
/**
 * Garante um webhook Stripe apontando para ${TUNNEL}/v1/billing/webhook.
 * Uso: node scripts/sync-stripe-webhook.mjs <tunnelHttpsUrl>
 * Saída JSON: { ok, id, url, secret?, created?, updated? }
 */
import { createRequire } from 'module';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const Stripe = require('stripe');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');

function loadEnv() {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = val;
  }
}

function upsertEnv(key, value) {
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  writeFileSync(envPath, `${next.join('\n').replace(/\n+$/, '')}\n`);
}

loadEnv();

const tunnel = String(process.argv[2] || '').trim().replace(/\/$/, '');
if (!tunnel.startsWith('https://')) {
  console.error(JSON.stringify({ ok: false, error: 'tunnel_url_required' }));
  process.exit(2);
}

const key = (process.env.STRIPE_SECRET_KEY || '').trim();
if (!key) {
  console.error(JSON.stringify({ ok: false, error: 'stripe_key_missing' }));
  process.exit(3);
}

const target = `${tunnel}/v1/billing/webhook`;
const EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.expired',
  'customer.subscription.deleted',
  'customer.subscription.updated',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
];

const stripe = new Stripe(key);

const list = await stripe.webhookEndpoints.list({ limit: 100 });
const mine = list.data.filter((w) => (
  (w.description || '').includes('SpotStrat')
  || (w.url || '').includes('/v1/billing/webhook')
));

// Prefer endpoint already on trycloudflare / current tunnel host; else SpotStrat-named; else any billing webhook
let primary = mine.find((w) => (w.url || '').includes('trycloudflare.com'))
  || mine.find((w) => (w.description || '').includes('SpotStrat tunnel'))
  || mine.find((w) => (w.description || '').includes('SpotStrat'))
  || mine[0];

let result;
if (!primary) {
  const created = await stripe.webhookEndpoints.create({
    url: target,
    enabled_events: EVENTS,
    description: 'SpotStrat tunnel billing',
  });
  if (created.secret) upsertEnv('STRIPE_WEBHOOK_SECRET', created.secret);
  result = {
    ok: true, created: true, id: created.id, url: created.url, secret: !!created.secret,
  };
} else if (primary.url === target) {
  result = { ok: true, created: false, updated: false, id: primary.id, url: primary.url };
} else {
  const updated = await stripe.webhookEndpoints.update(primary.id, {
    url: target,
    disabled: false,
  });
  result = { ok: true, created: false, updated: true, id: updated.id, url: updated.url };
}

// Fallback estável via cloud proxy (HOME_API_URL). Não substitui o primary do túnel.
const cloudUrl = (process.env.STRIPE_CLOUD_WEBHOOK_URL || 'https://spotstratcloud.vercel.app/v1/billing/webhook').trim();
if (cloudUrl && !list.data.some((w) => w.url === cloudUrl)) {
  try {
    await stripe.webhookEndpoints.create({
      url: cloudUrl,
      enabled_events: EVENTS,
      description: 'SpotStrat cloud fallback billing',
    });
    result.cloudFallback = 'created';
  } catch (err) {
    result.cloudFallback = err.message;
  }
}

console.log(JSON.stringify(result));
