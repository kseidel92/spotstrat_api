#!/usr/bin/env node
/**
 * Cria (ou reutiliza) produtos/prices SpotStrat na Stripe e grava IDs no apis/.env
 * Uso: node scripts/setup-stripe-products.mjs [--live]
 */
import { createRequire } from 'module';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const Stripe = require('stripe');
const { quotePlan, PRODUCTION_BRL } = require('../src/plans.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');
const liveMode = process.argv.includes('--live');

function loadEnv() {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] == null || process.env[m[1]] === '') process.env[m[1]] = val;
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

function brlCents(amount) {
  return Math.round(Number(amount) * 100);
}

loadEnv();

const key = (process.env.STRIPE_SECRET_KEY || '').trim();
if (!key) {
  console.error(JSON.stringify({ ok: false, error: 'STRIPE_SECRET_KEY missing' }));
  process.exit(1);
}
if (liveMode && !key.startsWith('sk_live_')) {
  console.error(JSON.stringify({ ok: false, error: 'Use sk_live_ key with --live' }));
  process.exit(1);
}

const stripe = new Stripe(key);

const PLAN_DEFS = [
  {
    env: 'STRIPE_PRICE_PAPER_1M',
    nickname: 'SpotStrat Paper · 1 mês',
    quote: quotePlan('paper', 1),
    recurring: { interval: 'month', interval_count: 1 },
  },
  {
    env: 'STRIPE_PRICE_PAPER_3M',
    nickname: 'SpotStrat Paper · 3 meses',
    quote: quotePlan('paper', 3),
    oneTime: true,
  },
  {
    env: 'STRIPE_PRICE_PAPER_6M',
    nickname: 'SpotStrat Paper · 6 meses',
    quote: quotePlan('paper', 6),
    oneTime: true,
  },
  {
    env: 'STRIPE_PRICE_PAPER_12M',
    nickname: 'SpotStrat Paper · 12 meses (anual)',
    quote: quotePlan('paper', 12),
    oneTime: true,
  },
];

const PRODUCTION_DEF = {
  env: 'STRIPE_PRICE_PRODUCTION_ID',
  nickname: 'SpotStrat · Estratégia em produção',
  amountBrl: PRODUCTION_BRL,
};

async function findOrCreateProduct(name, key_meta) {
  const search = await stripe.products.search({
    query: `active:'true' AND metadata['spotstrat_key']:'${key_meta}'`,
    limit: 1,
  });
  if (search.data[0]) return search.data[0];
  return stripe.products.create({
    name,
    metadata: { spotstrat_key: key_meta, tier: 'paper' },
  });
}

async function findPriceForProduct(productId, unitAmount, recurring) {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  return prices.data.find((p) => {
    if (p.unit_amount !== unitAmount || (p.currency || '').toLowerCase() !== 'brl') return false;
    if (recurring) {
      return p.recurring
        && p.recurring.interval === recurring.interval
        && Number(p.recurring.interval_count || 1) === Number(recurring.interval_count || 1);
    }
    return !p.recurring;
  });
}

async function ensurePrice(product, def) {
  const months = def.quote.months;
  const unitAmount = brlCents(def.quote.total);
  const recurring = def.recurring || null;
  let price = await findPriceForProduct(product.id, unitAmount, recurring);
  if (!price) {
    const payload = {
      product: product.id,
      currency: 'brl',
      unit_amount: unitAmount,
      nickname: def.nickname,
      metadata: {
        tier: 'paper',
        access_months: String(months),
        spotstrat: 'plan',
      },
    };
    if (recurring) {
      payload.recurring = recurring;
    }
    price = await stripe.prices.create(payload);
  }
  upsertEnv(def.env, price.id);
  return price.id;
}

async function ensureProductionPrice(product) {
  const unitAmount = brlCents(PRODUCTION_DEF.amountBrl);
  let price = await findPriceForProduct(product.id, unitAmount, null);
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      currency: 'brl',
      unit_amount: unitAmount,
      nickname: PRODUCTION_DEF.nickname,
      metadata: { spotstrat: 'production' },
    });
  }
  upsertEnv(PRODUCTION_DEF.env, price.id);
  return price.id;
}

const paperProduct = await findOrCreateProduct('SpotStrat Paper', 'paper');
const productionProduct = await findOrCreateProduct('SpotStrat Produção', 'production');

const priceIds = {};
for (const def of PLAN_DEFS) {
  priceIds[def.env] = await ensurePrice(paperProduct, def);
}
priceIds.STRIPE_PRICE_PRODUCTION_ID = await ensureProductionPrice(productionProduct);

upsertEnv('STRIPE_PRICE_ID', priceIds.STRIPE_PRICE_PAPER_1M);
upsertEnv('STRIPE_ALLOW_SIMULATE', 'false');
upsertEnv('SALES_OPEN', 'true');

const modeLine = readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('STRIPE_CHECKOUT_MODE='));
if (modeLine && modeLine.replace('STRIPE_CHECKOUT_MODE=', '').trim()) {
  upsertEnv('STRIPE_CHECKOUT_MODE', '');
}

console.log(JSON.stringify({
  ok: true,
  paperProduct: paperProduct.id,
  productionProduct: productionProduct.id,
  prices: priceIds,
  amountsBrl: {
    '1m_monthly': quotePlan('paper', 1).monthly,
    '3m_total': quotePlan('paper', 3).total,
    '6m_total': quotePlan('paper', 6).total,
    '12m_total': quotePlan('paper', 12).total,
    production: PRODUCTION_BRL,
  },
  salesOpen: true,
}, null, 2));