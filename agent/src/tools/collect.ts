import { ruleKey, type AccountHealth, type RuleState } from '../../../lib/risk-rules';
import type { AgentConfig } from '../../../lib/agent-config';
import { TRADEABLE } from '../../../lib/bstocks';
import type { BscFunds, Network, Snapshot } from '../types';
import * as app from './appApi';
import * as bsc from './bsc';
import * as derive from './derive';
import * as lighter from './lighter';
import * as pancake from './pancake';
import * as store from './store';
import * as metrics from './metrics';
import { collectHedgeData, realHedgeDeps, type HedgeDataDeps } from './hedgeData';
import { config } from '../config';
import { collectMarket, realSigma, tickerOf, type SigmaFn } from '../risk/market';
import { getChain, type OptionChain } from '../risk/options';

// Builds the Snapshot: every live reading the graph needs for one wallet. A failed read never throws; it adds a
// dataQuality flag, which makes the graph fail closed (report an error, move nothing).

export interface CollectDeps {
  getRuleStates(wallet: string, n: Network): Promise<Record<string, RuleState>>;
  getLighterCreds(wallet: string, n: Network): Promise<app.LighterCreds>;
  getDeriveCreds(wallet: string, n: Network): Promise<app.DeriveCreds>;
  lighterAccount(n: Network, index: number): Promise<lighter.LighterAccount | null>;
  deriveSubaccount(n: Network, wallet: string, c: app.DeriveCreds, id: number): Promise<derive.DeriveSubaccountView>;
  funds(wallet: string, symbols: string[]): Promise<{ funds: BscFunds; problems: string[] }>;
  moved24h(wallet: string, n: Network, ruleKey: string): bigint;
  /** Daily volatility of a Lighter market (fraction), or null when there is not enough history. */
  sigma?: SigmaFn;
  /** Hedge prices, positions and minimums (value-based sizing). Defaults to the real venues. */
  hedge?: HedgeDataDeps;
}

export const realDeps: CollectDeps = {
  getRuleStates: app.getRuleStates, getLighterCreds: app.getLighterCreds, getDeriveCreds: app.getDeriveCreds,
  lighterAccount: lighter.getAccount, deriveSubaccount: derive.getSubaccount,
  funds: (wallet, symbols) => bsc.getFunds(wallet, bsc.agentAddress(), symbols, pancake.priceOf),
  moved24h: store.moved24h,
  sigma: realSigma,
};

const safe = <T,>(f: () => T): T | undefined => { try { return f(); } catch { return undefined; } };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * `wide` (chat only): also read every listed bStock and both venues even when no rule or hedge leg names them, so
 * "what do I hold?" is answered from the real wallet. The tick loop leaves it off and reads only what its rules need.
 */
export async function collectSnapshot(wallet: string, network: Network, cfg: AgentConfig, deps: CollectDeps = realDeps, wide = false): Promise<Snapshot> {
  const dq: string[] = []; const health: Record<string, AccountHealth> = {}; const moved: Record<string, string> = {};
  let ruleState: Record<string, RuleState> = {}; let lighterPositions: Record<number, number> = {};
  let lighterMain: Snapshot['lighterMain'];
  const hedgeProblems: string[] = [];
  let unassessed: Record<string, string> | undefined;
  let funds: BscFunds = { usdcUsd: 0, usdtUsd: 0, bstocks: [], allowanceUsdcBase: '0' };

  try { ruleState = await deps.getRuleStates(wallet, network); } catch (e) { dq.push(`rule-state unreadable: ${msg(e)}`); }

  let lighterCreds: app.LighterCreds | null = null; let deriveCreds: app.DeriveCreds | null = null;
  const needLighter = wide || cfg.rebalance.rules.some((r) => r.venue === 'lighter') || (cfg.hedge.enabled && cfg.hedge.legs.length > 0);
  const needDerive = wide || cfg.rebalance.rules.some((r) => r.venue === 'derive') || (cfg.hedge.enabled && cfg.hedge.legs.some((l) => l.venue === 'derive'));
  const venueProblems: NonNullable<Snapshot['venueProblems']> = {};
  if (needLighter) { try { lighterCreds = await deps.getLighterCreds(wallet, network); } catch (e) { venueProblems.lighter = `no usable Lighter key (${msg(e)})`; } }
  if (needDerive) { try { deriveCreds = await deps.getDeriveCreds(wallet, network); } catch (e) { venueProblems.derive = `no usable Derive key (${msg(e)})`; } }

  if (lighterCreds) {
    try {
      const acct = await deps.lighterAccount(network, lighterCreds.accountIndex);
      lighterPositions = lighter.positionsOf(acct);
      if (acct) lighterMain = { equityUsd: Number(acct.total_asset_value), freeUsd: Number(acct.available_balance) };
    } catch (e) { dq.push(`lighter main account unreadable: ${msg(e)}`); }
  }

  for (const rule of cfg.rebalance.enabled ? cfg.rebalance.rules : []) {
    const rk = ruleKey(rule);
    moved[rk] = deps.moved24h(wallet, network, rk).toString();
    try {
      if (rule.venue === 'lighter') {
        if (!lighterCreds) { health[rk] = lighter.healthOf(null); continue; }
        const idx = rule.accountRef === '' ? lighterCreds.accountIndex : Number(rule.accountRef);
        health[rk] = lighter.healthOf(await deps.lighterAccount(network, idx));
      } else {
        if (!deriveCreds) { health[rk] = derive.healthOf(null); continue; }
        const id = rule.accountRef ? Number(rule.accountRef) : deriveCreds.subaccountId;
        health[rk] = derive.healthOf(await deps.deriveSubaccount(network, wallet, deriveCreds, id));
      }
      if (!health[rk].connected) dq.push(rule.venue === 'lighter' ? `${rk} account not found: create your Lighter account first (no deposit was sent)` : `${rk} account not found: check the Derive subaccount (no deposit was sent)`);
    } catch (e) { dq.push(`${rk} unreadable: ${msg(e)}`); health[rk] = { connected: false, utilBps: null, accountUsd: null, usedUsd: null }; }
  }

  if (wide && deriveCreds && !Object.keys(health).some((k) => k.startsWith('derive:'))) {
    const rk = `derive:${deriveCreds.subaccountId}`;
    try { health[rk] = derive.healthOf(await deps.deriveSubaccount(network, wallet, deriveCreds, deriveCreds.subaccountId)); }
    catch (e) { dq.push(`${rk} unreadable: ${msg(e)}`); }
  }

  try {
    const symbols = [...new Set([...cfg.hedge.legs.map((l) => l.bstock), ...cfg.rebalance.sellOrder, ...(wide ? TRADEABLE.map((t) => t.symbol) : [])])];
    const r = await deps.funds(wallet, symbols);
    funds = r.funds; dq.push(...r.problems);
  } catch (e) { dq.push(`BNB balances unreadable: ${msg(e)}`); }

  // Hedging inputs. A problem here only stops hedging (never margin top-ups): the agent never guesses a volatility.
  let market: Snapshot['market'];
  const options: Record<string, OptionChain> = {};
  let hedgeData: Awaited<ReturnType<typeof collectHedgeData>> | undefined;
  const marketMins: NonNullable<Snapshot['marketMins']> = {};
  if (cfg.hedge.enabled && cfg.hedge.legs.length) {
    if (needLighter && !lighterMain) hedgeProblems.push('no Lighter account to hedge on');
    const heldSet = new Set(funds.bstocks.filter((b) => b.qty > 0).map((b) => b.symbol));
    if (cfg.hedge.sizing === 'ratio') {
      // Value-based sizing: read the HEDGE price, positions and venue minimums per leg. A leg whose price cannot be read is skipped.
      if (heldSet.size) {
        const hd = await collectHedgeData(network, wallet, cfg.hedge, heldSet, lighterPositions, deriveCreds, deps.hedge ?? realHedgeDeps);
        hedgeData = hd; hedgeProblems.push(...hd.problems);
      }
    } else
    if (heldSet.size && deps.sigma) { const m = await collectMarket(network, cfg.hedge, heldSet, deps.sigma); market = m.market; hedgeProblems.push(...m.problems); unassessed = m.unassessed; }
    // Lighter order minimums for the hedge markets of held bStocks (a missing read just skips the check).
    if (cfg.hedge.sizing !== 'ratio') for (const leg of cfg.hedge.legs.filter((l) => heldSet.has(l.bstock) && l.venue === 'lighter' && l.marketId !== undefined)) { try { const m = await lighter.getMarket(network, leg.marketId as number); marketMins[leg.marketId as number] = { minBase: Number(m.min_base_amount), sizeDecimals: m.size_decimals, minNotionalUsd: 10 }; } catch { /* no minimum known */ } }
    // Derive put chains for the held tickers (loss-limit mode). A missing chain just means no put is offered for that ticker.
    if (cfg.hedge.sizing !== 'ratio') for (const leg of cfg.hedge.legs.filter((l) => heldSet.has(l.bstock))) { try { const ch = await getChain(network, tickerOf(leg.bstock)); if (ch) options[ch.ticker] = ch; } catch { /* no put offered */ } }
  }

  // Running totals the policy engine checks. The store may be closed in tests; then everything reads as zero.
  let today: Snapshot['today'];
  try {
    const off = (lighterMain?.equityUsd ?? 0) + Object.entries(health).filter(([k, h]) => k !== 'lighter:' && h.connected).reduce((a, [, h]) => a + (h.accountUsd ?? 0), 0);
    const dl = store.dailyLoss(wallet, network, off);
    today = { notionalUsd: store.notional24h(wallet, network), lossUsd: dl.lossUsd, capitalOffBnbUsd: off, pausedReason: store.pausedReason(wallet, network) };
  } catch { today = undefined; }

  return { wallet, network, takenAt: new Date().toISOString(), config: cfg, ruleState, health, lighterPositions, bsc: funds, dataQuality: dq, moved24hBase: moved, market, hedgeProblems, unassessed: unassessed && Object.keys(unassessed).length ? unassessed : undefined, lighterMain, today, bridgeEtaSec: metrics.topUpLatencySec('lighter').sec, venueProblems: Object.keys(venueProblems).length ? venueProblems : undefined, marketMins: Object.keys(marketMins).length ? marketMins : undefined,
    hedgePrices: hedgeData?.prices, hedgePositions: hedgeData?.positions, hedgeMins: hedgeData?.mins, putPositions: hedgeData?.putPositions, putPicks: hedgeData?.putPicks,
    options: Object.keys(options).length ? options : undefined, heldPuts: safe(() => store.openPuts(wallet, network)), deriveEtaSec: config().DERIVE_ETA_SEC,
    deriveFree: (() => { const k = Object.keys(health).find((x) => x.startsWith('derive:') && health[x].connected); return k ? { ref: k.slice(7), freeUsd: Math.max(0, (health[k].accountUsd ?? 0) - (health[k].usedUsd ?? 0)) } : undefined; })() };
}
