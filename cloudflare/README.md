# Cloudflare Tunnel → API na porta 7171

Encaminha **HTTPS público** até `http://127.0.0.1:7171` sem abrir porta no roteador (funciona com CGNAT).

## 1. Instalar o cliente

```bash
cd ~/projects/spotstrat_api
chmod +x cloudflare/*.sh
./cloudflare/install-cloudflared.sh
```

## 2. Teste rápido (Vercel hoje)

Com a API rodando (`npm start` → porta **7171**):

```bash
./cloudflare/run-quick.sh
```

O script grava a URL em `cloudflare/tunnel-url.txt`. Na **Vercel** (projeto **spotstrat_cloud**):

| Variável | Valor |
|----------|--------|
| `HOME_API_URL` | conteúdo de `tunnel-url.txt` (sem `/` no final) |

No **spotstrat_front**:

| Variável | Valor |
|----------|--------|
| `VITE_WS_ORIGIN` | mesma URL, trocando `https` por `wss` |

Teste: `https://SEU-CLOUD.vercel.app/api/health` → `"ok": true`.

**Nota:** URL `trycloudflare.com` **muda** se reiniciar o túnel. Para URL fixa, use o passo 3.

Parar: `./cloudflare/stop-tunnel.sh`

## 3. Produção fixa (`api.spotstrat.com`)

1. Crie conta em [Cloudflare](https://dash.cloudflare.com).
2. Adicione o domínio **spotstrat.com** (nameservers na Cloudflare; o site na Vercel continua possível — veja doc Vercel + Cloudflare DNS).
3. [Zero Trust](https://one.dash.cloudflare.com) → **Networks** → **Tunnels** → **Create a tunnel**.
4. Nome: `spotstrat-api`. Copie o **token** do instalador.
5. Em **Public Hostname**: `api.spotstrat.com` → Type HTTP → URL `http://127.0.0.1:7171`.
6. No notebook (systemd ou tmux):

```bash
export CLOUDFLARE_TUNNEL_TOKEN='cole-o-token-aqui'
./cloudflare/run-token.sh
```

7. Vercel: `HOME_API_URL=https://api.spotstrat.com`  
   Front: `VITE_WS_ORIGIN=wss://api.spotstrat.com`

8. API `.env`: inclua `https://api.spotstrat.com` em `WEB_ORIGIN` se chamar a API direto pelo túnel.

Modelo de config manual: `config.yml.example`.

## Ordem ao ligar o notebook

**Recomendado (um comando):**

```bash
cd ~/projects/spotstrat_api   # ou tradeai/apis
npm run online               # Postgres + API + túnel + push Vercel se a URL mudou
npm run online:front         # idem + Vite :7172
npm run online:watch         # fica religando API/túnel se cair (~20s)
```

Manual:

1. Postgres (Docker)
2. `npm start` (API **7171**)
3. `./cloudflare/run-quick.sh` **ou** `./cloudflare/run-token.sh`
4. Vercel cloud já apontando para a URL correta
