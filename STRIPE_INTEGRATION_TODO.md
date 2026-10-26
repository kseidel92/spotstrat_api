# Stripe Integration TODO

Fonte única do que falta para o checkout ir ao ar. Integração: **Hosted Checkout** (`ui_mode: hosted_page`).

Cenário detectado: **A** — já existia `stripe.checkout.sessions.create` em [`src/stripeBilling.js`](src/stripeBilling.js).

---

## Values to Replace

Os placeholders abaixo precisam dos valores reais do Dashboard antes do teste.

**Arquivos:**
- [`src/stripeBilling.js`](src/stripeBilling.js) (lê `STRIPE_PRICE_ID` / prices opcionais do env)
- [`.env`](.env) (local; não commitado)
- [`.env.example`](.env.example)

| Field | Current Value | What to Set |
|-------|---------------|-------------|
| `mode` | `payment` | Já correto para cobrança única (produto de R$ 1,00). Só mude para `subscription` se o Price for recorrente. |
| `success_url` / `cancel_url` | Gerados de `WEB_ORIGIN` + rotas do app | Confirme `WEB_ORIGIN` no `.env` (ex.: `https://spotstrat.com,https://www.spotstrat.com`). |
| `line_items[].price` | `process.env.STRIPE_PRICE_ID` (vazio hoje) | Price ID do produto de **R$ 1,00** → [Dashboard → Prices](https://dashboard.stripe.com/test/prices) |

---

## Configured Parameters

Parâmetros do Checkout Studio já aplicados em [`src/stripeBilling.js`](src/stripeBilling.js):

| Parameter | Value |
|-----------|-------|
| `ui_mode` | `hosted_page` (SDK `stripe@^23`) |
| `billing_address_collection` | `auto` |
| `phone_number_collection` | `{ enabled: false }` |
| `automatic_tax` | `{ enabled: false }` |
| `allow_promotion_codes` | `false` |
| `submit_type` | `auto` |
| `integration_identifier` | `hosted_web_0001` |
| `origin_context` | `web` |

`payment_method_collection` **não** foi incluído: só se aplica com `mode: subscription` (regra Stripe / prompt).

Mantidos para anti-golpe / fulfillment: `customer`, `client_reference_id`, `metadata`, `payment_intent_data`, `locale`.

---

## Setup and next steps

### 1. Variáveis no `apis/.env` (obrigatórias — hoje estão vazias)

Cole no Dashboard e preencha:

| Variável | Onde pegar |
|----------|------------|
| `STRIPE_SECRET_KEY` | [API keys](https://dashboard.stripe.com/test/apikeys) → Secret (`sk_test_…`) |
| `STRIPE_PUBLISHABLE_KEY` | Mesma tela → Publishable (`pk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | [Webhooks](https://dashboard.stripe.com/test/workbench/webhooks) → Signing secret (`whsec_…`) |
| `STRIPE_PRICE_ID` | [Prices](https://dashboard.stripe.com/test/prices) → Price do produto de **R$ 1,00** (`price_…`) |

Opcionais (senão usam `STRIPE_PRICE_ID`):
`STRIPE_PRICE_PAPER_1M`, `STRIPE_PRICE_PAPER_3M`, …, `STRIPE_PRICE_PRODUCTION_ID`

Já deve existir:
- `WEB_ORIGIN` com o domínio do front
- `STRIPE_ALLOW_SIMULATE=false`

**Não** use prefixo `VITE_` nestas keys — são só no servidor (`apis`).

### 2. Webhook

Crie endpoint (modo teste) com eventos:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.expired`
- `charge.refunded`
- `charge.dispute.created`

URL (preferir túnel direto para assinatura raw):

```text
https://<seu-tunnel>.trycloudflare.com/v1/billing/webhook
```

Alternativa via cloud (corpo raw preservado):

```text
https://spotstratcloud.vercel.app/v1/billing/webhook
```

Copie o `whsec_…` para `STRIPE_WEBHOOK_SECRET`.

### 3. Reiniciar a API

Depois de salvar o `.env`:

```bash
cd apis && ./scripts/go-online.sh --no-push
# ou reinicie o processo node src/index.js
```

### 4. Fluxo

1. Usuário clica em pagar no front.
2. API cria Checkout Session (hosted) e devolve `url`.
3. Browser redireciona para a página da Stripe.
4. Sucesso → `success_url` → app confirma via `GET /v1/billing/session/:id` + webhook grava `stripe_events` / `stripe_checkouts` / `purchases`.
5. Backoffice → Pagamentos mostra o rastreio.

### 5. Teste

Cartão teste: `4242 4242 4242 4242`, validade futura, CVC qualquer, CEP qualquer.

Use **Test mode** no Dashboard.

### 6. Depois do teste

- Trocar keys `sk_test` / `pk_test` por live quando for produção.
- Criar Prices reais por plano (paper/pro/meses) se quiser valores distintos do R$ 1,00.
- Conferir no backoffice: checkouts, eventos webhook, compras creditadas.

### Resources

- https://docs.stripe.com/checkout/quickstart
- https://docs.stripe.com/mcp
- https://support.stripe.com
