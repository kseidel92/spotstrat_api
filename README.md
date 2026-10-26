# SpotStrat API

Motor SpotStrat: Postgres, desk paper, worker de prompts (IA), hub Binance ao vivo. **Roda na sua máquina** — a nuvem só repassa tráfego via [spotstrat_cloud](https://github.com/kseidel92/spotstrat_cloud).

## Requisitos

- Node 20+
- Postgres (Docker: `tradeai-postgres:5432` ou ajuste `DATABASE_URL`)
- Pasta de laboratório 18 meses em `LAB_ROOT` (velas históricas)

## Setup

```bash
cp .env.example .env
npm install
npm start
```

`npm start` (= `keep-online` / `go-online --watch`) sobe **Postgres + API + túnel** e **fica de olho**:

- religa a API se cair
- recria o túnel se a URL morrer
- se a URL do túnel mudar: atualiza `cloud/vercel.json` + `front/vercel.json`, faz push, deploy Vercel prod e aponta o **webhook Stripe** para `${túnel}/v1/billing/webhook`

Logs: `run/api.log`, `run/keep.log`.

- Um processo só (debug): `npm run start:once`
- API em `http://127.0.0.1:7171`

## Expor para a Vercel (túnel)

Com `npm start` o `HOME_API_URL`, o `VITE_WS_ORIGIN` e o webhook Stripe acompanham a URL do túnel automaticamente.

Manual:

```bash
cloudflared tunnel --url http://127.0.0.1:7171
```

## Variáveis importantes

| Variável | Uso |
|----------|-----|
| `WEB_ORIGIN` | Origens do front, separadas por vírgula (`https://spotstrat.com,https://www.spotstrat.com`) |
| `ALLOW_VERCEL_PREVIEWS` | `true` para aceitar `*.vercel.app` em dev |
| `COOKIE_DOMAIN` | Ex.: `.spotstrat.com` quando o front usa o mesmo site via proxy |
| `LAB_ROOT` | Caminho absoluto para os dados de backtest |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Geração de estratégias |

WebSocket ao vivo: `ws://127.0.0.1:7171/v1/stream` (no site público use o mesmo host do túnel com `wss://`).
