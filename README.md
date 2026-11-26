# Pulse Risk

**A risk desk for tokenized stocks, perpetuals and options on BNB Chain, with an agent that watches your margin and
checks every price before it acts.**

Pulse Risk shows one portfolio across your BNB wallet, your perps account and your options account. An agent keeps
margin healthy and places hedges inside limits you set. It can never withdraw your money, and in its default mode it does
nothing until you press Approve.

---

## Start here

| | |
|---|---|
| **See the idea** | [Pitch deck](pitch-deck/) |
| **Why the prices can be trusted** | [CMC-X-Atlas](CMC-X-Atlas/) |
| **How trading and the agent work** | [bnb-hackathon](bnb-hackathon/) |

---

## What is in each folder

| Folder | What it covers | Read this for |
|---|---|---|
| **[CMC-X-Atlas](CMC-X-Atlas/)** | The **price-integrity and risk-pricing layer**: four independent price sources (Atlas oracle, CoinMarketCap DEX data, the stock's perp, the app's own price), a verdict per token, a risk-priced collateral haircut, and the rules that stop the agent from acting on a bad price | The use case, the thresholds, the haircut math and where it is enforced. [README](CMC-X-Atlas/README.md) · [Demo script](CMC-X-Atlas/docs/DEMO.md) |
| **[bnb-hackathon](bnb-hackathon/)** | **Perps on Aster, options on Derive and the agent**: the trading tickets, leverage, funding from your BNB wallet, margin rules, hedges, the two modes, the limits and the chat | How each venue works and how the agent decides and acts. [README](bnb-hackathon/README.md) · [Agent guide](bnb-hackathon/docs/AGENT.md) · [Build guide](bnb-hackathon/docs/AGENT_BUILD.md) · [Aster notes](bnb-hackathon/docs/endpoints/aster.md) |

Each folder is a complete, runnable copy of the application. The two READMEs tell the same project from two angles:
one around price integrity, the other around trading and the agent.

---

## How the pieces fit

```mermaid
flowchart LR
    U["You<br/>browser + MetaMask"] --> APP["Web app<br/>Perps · Options · Risk page"]
    AG["Agent<br/>checks every 30 s"] <--> APP

    APP --> AS["Aster perps"]
    APP --> DE["Derive options"]
    AG -->|"hedges, margin top-ups"| AS
    AG -->|"hedges, margin top-ups"| DE

    PI["Price integrity<br/>Atlas · CoinMarketCap · perp anchor"] --> APP
    PI --> AG
```

The agent acts only through the app, only inside your limits, and only on prices that pass the integrity check.

---

## Key facts

- **Perps:** Aster on BNB Chain, USDT margin, leverage per order, funded from your BNB wallet with no bridge.
- **Options:** Derive, with orders signed by a limited session key.
- **Agent:** margin top-ups, releases and hedges. Modes: **Ask me first** (default) and **Autonomous**.
- **Limits in code:** kill switch, per-trade and per-day caps, leverage cap, daily loss cap, off-BNB cap, autonomy expiry.
- **Safety:** the Aster agent key cannot withdraw; every order carries an idempotency key; keys are encrypted at rest.

---

## Run it

Requires Node 22.5 or newer and MetaMask on BNB Chain. Pick either folder, then:

```bash
cd bnb-hackathon                    # or CMC-X-Atlas
npm install
cp .env.example .env.local          # fill the secrets
cd agent && npm install && cp .env.example .env && cd ..
npm run dev:all                     # app (3100) + chat (3200) + agent loop
```

Open http://localhost:3100. Setup details, settings and tests are in each folder's README.

---

## Pitch deck

The deck lives in **[pitch-deck/](pitch-deck/)**.
