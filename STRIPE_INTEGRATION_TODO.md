# Stripe Integration TODO

Integração: **Hosted Checkout** (`ui_mode: hosted_page`, SDK `stripe@^23`).  
Planos **Paper**: 1 mês (assinatura), 3 / 6 / 12 meses (pagamento único). Produção: R$ 319,33 (pagamento único).

Status (2026-11-25): produtos/prices criados via `scripts/setup-stripe-products.mjs`; IDs gravados em `apis/.env` (local). Compras liberadas com `SALES_OPEN=true` (contagem do lançamento no site segue).

---

## Values to Replace

Nada obrigatório em **test mode** após rodar o script. Para **produção live**:

**Arquivos:**
- [`.env`](.env) (local; não commitado)
- [`src/stripeBilling.js`](src/stripeBilling.js)

| Field | Current Value | What to Set |
|-------|---------------|-------------|
| `STRIPE_SECRET_KEY` | `sk_test_…` | `sk_live_…` no go-live |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` | `pk_live_…` |
| `STRIPE_PRICE_PAPER_*` / `STRIPE_PRICE_PRODUCTION_ID` | IDs test | Recrie com `node scripts/setup-stripe-products.mjs --live` em live mode |
| `SALES_OPEN` | `true` | `false` para bloquear checkout até o lançamento oficial |
| `STRIPE_CHECKOUT_MODE` | (vazio = auto) | Não force `subscription` — cada Price define o mode |

`success_url` / `cancel_url`: derivados de `STRIPE_CHECKOUT_ORIGIN` ou `WEB_ORIGIN` em [`src/stripeBilling.js`](src/stripeBilling.js).

---

## Configured Parameters

Checkout Studio em [`src/stripeBilling.js`](src/stripeBilling.js) (`createEmbeddedCheckout`):

| Parameter | Value |
|-----------|-------|
| `ui_mode` | `hosted_page` |
| `billing_address_collection` | `auto` |
| `phone_number_collection` | `{ enabled: false }` |
| `automatic_tax` | `{ enabled: false }` |
| `allow_promotion_codes` | `false` |
| `payment_method_collection` | `always` (somente se `mode: subscription`) |
| `submit_type` | `auto` |
| `integration_identifier` | `hosted_web_0001` |
| `origin_context` | `web` |

---

## Preços SpotStrat (BRL)

| Plano | Valor cobrado | Stripe env |
|-------|----------------|------------|
| 1 mês (recorrente) | R$ 93,33/mês | `STRIPE_PRICE_PAPER_1M` |
| 3 meses | R$ 252,00 | `STRIPE_PRICE_PAPER_3M` |
| 6 meses | R$ 459,18 | `STRIPE_PRICE_PAPER_6M` |
| 12 meses | R$ 806,40 | `STRIPE_PRICE_PAPER_12M` |
| Produção | R$ 319,33 | `STRIPE_PRICE_PRODUCTION_ID` |

Recriar / idempotente:

```bash
cd apis && node scripts/setup-stripe-products.mjs
```

---

## Setup and next steps

### 1. Variáveis (`apis/.env`)

| Variável | Descrição |
|----------|-----------|
| `STRIPE_SECRET_KEY` | Secret key |
| `STRIPE_PUBLISHABLE_KEY` | Publishable (opcional no redirect hosted; útil no `/v1/config`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret do endpoint |
| `STRIPE_PRICE_PAPER_1M` … `STRIPE_PRICE_PAPER_12M` | Prices por prazo |
| `STRIPE_PRICE_PRODUCTION_ID` | Price produção |
| `STRIPE_ALLOW_SIMULATE` | `false` |
| `SALES_OPEN` | `true` libera checkout antes do `LAUNCH_AT` |
| `WEB_ORIGIN` / `STRIPE_CHECKOUT_ORIGIN` | Domínio do front nas URLs de retorno |

Sem prefixo `VITE_` na API.

### 2. Webhook

Eventos: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`, `customer.subscription.deleted`, `invoice.paid`, `charge.refunded`, `charge.dispute.created`.

```bash
cd apis && node scripts/sync-stripe-webhook.mjs https://<tunnel>/v1/billing/webhook
```

Ou `go-online.sh` (faz sync automaticamente com túnel ativo).

### 3. Reiniciar API

```bash
cd apis && ./scripts/go-online.sh --watch
```

### 4. Front

O front lê `salesOpen` em `GET /v1/config` — precisa da API com `SALES_OPEN=true` (opcional no Vercel: `VITE_SALES_OPEN=true`).

### 5. Fluxo

1. Usuário escolhe prazo → `POST /v1/billing/checkout`
2. API usa o Price do prazo, cria Session hosted, devolve `url`
3. Redirect Stripe → `success_url` → `GET /v1/billing/session/:id` + webhook
4. `purchases` / `users.plan_status` atualizados; backoffice → Pagamentos

### 6. Teste

Cartão: `4242 4242 4242 4242`. Modo test no Dashboard.

### Resources

- https://docs.stripe.com/checkout/quickstart  
- https://docs.stripe.com/mcp  
- https://support.stripe.com