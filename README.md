# Pulse Risk · BNB

Built for the BNB Bangkok hackathon. It's one portfolio for:

- **bStocks** (tokenized stocks and ETFs) on BNB Chain, held as collateral and traded on PancakeSwap V3;
- **Lighter** perps;
- **Derive** options.

An agent hedges the bStocks and moves margin from BNB to the perp/options venues when they run short.

## Run

```bash
npm install
cp .env.example .env.local     # fill SESSION_SECRET, KEYSTORE_SECRET, AGENT_API_TOKEN (openssl rand -hex 32)
npm run dev                    # http://localhost:3100
npm test                       # unit tests (planning math, signing codecs, keystore, Lighter WASM signer)
npm run build
```

Node ≥ 22.5 (uses the built-in `node:sqlite`). Data lives in `data/pulse-risk.db` (gitignored).

## Deploy (Docker, e.g. AWS Lightsail)

`docker-compose.yml` runs four containers: `app` (Next.js), `agent` (tick loop), `agent-chat` (chat API, always a dry run) and `caddy` (HTTPS on 80/443 with automatic Let's Encrypt). Only Caddy is exposed. SQLite data lives in the `app-data` and `agent-data` volumes.

```bash
bash deploy/lightsail-setup.sh                      # once per instance: Docker + 2 GB swap
cp .env.example .env                                # secrets + DOMAIN (+ NEXT_PUBLIC_* RPCs, baked in at build)
cp agent/.env.example agent/.env                    # AGENT_API_TOKEN must equal the app's
docker compose up -d --build
docker compose logs -f app agent                    # https://$DOMAIN/api/health → {"db":"ok","lighterSigner":"ok"}
```

**Without cloning the repo on the server:** `.github/workflows/docker.yml` pushes `ghcr.io/plusarx/pulsarx-app` and `pulsarx-agent` on every push to `main` (or run `deploy/push-images.sh`). On the server, put `deploy/docker-compose.yml`, `.env` and `agent.env` in one folder, `docker login ghcr.io` if the packages are private, then `docker compose pull && docker compose up -d`. To update, run the same two commands. To pin a build, set `TAG=sha-<short>` in `.env`.

HTTPS is required: in production the session cookie is `Secure`. If you have no domain, use `DOMAIN=<static-ip>.sslip.io`. Back up the volumes, because `app-data` holds the encrypted agent keys and losing `KEYSTORE_SECRET` makes them unreadable.

## What's where

| Page | What it does |
|---|---|
| `/` Portfolio | Live total across BSC wallet, bStocks, Lighter and Derive (polls about every 3–4 s, plus instant refresh on USDC/USDT transfers) |
| `/trade/spot/[symbol]` | bStock spot: chart, book and trades (Binance reference data), swap ticket (PancakeSwap V3, quoted across all fee tiers, exact approvals) |
| `/trade/perps` | Lighter perps: markets, chart, book, long/short ticket signed by the agent key, positions, open orders |
| `/trade/options` | Derive options chain (ETH, BTC, SOL, HYPE + RWA: NVDA, US500, US100, gold, oil), ticket signed by the session key |
| `/funding` | BNB → Lighter (Relay, direct to the account index), BNB ↔ Ethereum (Relay), Ethereum → Lighter / Derive direct deposits, testnet faucets |
| `/agents` | Register the Lighter API key and the Derive session key (MetaMask signs; the key is created and stored encrypted server-side) |
| `/automation` (Risk management) | KPI strip (health, utilization, liquidation distance), auto margin rebalancing (per-account rules with zone bars, ported from the original terminal), stress test, hedge legs, funding source + agent allowance, activity |
| `/collateral` | All 26 bStocks, holdings, haircut collateral value |
| `/docs` | Agent integration guide plus the endpoint references for Lighter, Derive, Relay and bStocks |

The **network toggle** (sidebar) switches Lighter and Derive between mainnet and testnet. bStocks only exist on BSC mainnet, and Relay has no testnet routes.

## Security notes
- Identity comes from a signed-in session cookie (wallet signature with a single-use nonce), never from request bodies.
- Agent keys are AES-256-GCM encrypted with `KEYSTORE_SECRET`. Each key is bound by AAD to its wallet, venue and network.
- Derive session keys never request `admin`, `set_session_key`, `transfer:all` or `transfer:different_owner_subaccount`. The scopes are re-read after registration and refused if they are wrong.
- Relay quotes are decoded and pinned (router, token, amount, depositor) before MetaMask sees them. ERC-20 approvals are for exact amounts.
- Order endpoints require an `Idempotency-Key`.

## Vendored
`vendor/lighter/lighter-signer.wasm` is built from `elliottech/lighter-go` **v1.0.13** (commit `e8687faa`) with `GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" ./wasm/` on Go 1.26.0. `wasm_exec.js` comes from the same Go toolchain. v1.0.13 is required: earlier versions reject market ids above 254.
