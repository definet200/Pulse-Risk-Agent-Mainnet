import { ruleKey, type AccountHealth, type RuleState } from '../../../lib/risk-rules';
import type { VenueAccount } from '../types';
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
import { getChain, type OptionChain, type OptionsProvider } from '../risk/options';
import { pickProxy, type ProxyPick } from '../risk/proxy';

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
  /** Hedge prices, positions and minimums (value-based sizing). Omitted = not read (real runs pass the live venues). */
  hedge?: HedgeDataDeps;
  /** Lighter's listed perp markets (symbol -> market id), used to give a held bStock a default hedge leg. */
  lighterMarkets?: (n: Network) => Promise<{ symbol: string; marketId: number }[]>;
  /** Live Derive put chain per underlying. Omitted = no puts read (real runs pass the live Derive reader). */
  options?: OptionsProvider;
  /** A Lighter market's order minimums. Omitted = no minimums read. */
  lighterMarket?: (n: Network, marketId: number) => Promise<lighter.LighterMarket>;
  /** Every Lighter account of the wallet (master + sub-accounts) and every Derive subaccount. Omitted = main accounts only. */
  allLighterAccounts?: (n: Network, wallet: string, mainIndex: number) => Promise<VenueAccount[]>;
  allDeriveSubaccounts?: (n: Network, wallet: string, c: app.DeriveCreds, mainId: number) => Promise<VenueAccount[]>;
  /** Best measured proxy market for a holding (correlation of hourly returns), or null. Omitted = no proxies. */
  proxy?: (n: Network, ticker: string, marketIds: Record<string, number>) => Promise<ProxyPick | null>;
}

/** Lighter's active perp markets, cached for 10 minutes per network. */
const marketCache = new Map<Network, { at: number; list: { symbol: string; marketId: number }[] }>();
export async function realLighterMarkets(n: Network): Promise<{ symbol: string; marketId: number }[]> {
  const hit = marketCache.get(n);
  if (hit && Date.now() - hit.at < 600_000) return hit.list;
  const j = await lighter.lighterGet<{ order_book_details?: { symbol: string; market_id: number; status?: string; market_type?: string }[] }>(n, 'orderBookDetails');
  const list = (j.order_book_details ?? []).filter((m) => (m.status ?? 'active') === 'active' && (m.market_type ?? 'perp') === 'perp').map((m) => ({ symbol: m.symbol, marketId: m.market_id }));
  marketCache.set(n, { at: Date.now(), list });
  return list;
}

/**
 * A held bStock with no hedge leg of its own gets the matching Lighter perp (NVDAB -> NVDA) at ratio 1, so hedging
 * works without hand-configuring every holding. Legs the user set always win; a stock Lighter does not list stays
 * without a leg (the planner then tries a proxy, or reports it as unhedgeable).
 */
export function defaultHedgeLegs(legs: AgentConfig['hedge']['legs'], held: string[], markets: { symbol: string; marketId: number }[]): AgentConfig['hedge']['legs'] {
  const covered = new Set(legs.map((l) => tickerOf(l.bstock)));
  const added: AgentConfig['hedge']['legs'] = [];
  for (const bstock of held) {
    const ticker = tickerOf(bstock);
    if (covered.has(ticker)) continue;
    const m = markets.find((x) => x.symbol === ticker);
    if (!m) continue;
    added.push({ bstock, venue: 'lighter', kind: 'perp', market: ticker, marketId: m.marketId, hedgeRatio: 1 });
    covered.add(ticker);
  }
  return added;
}

export const realDeps: CollectDeps = {
  getRuleStates: app.getRuleStates, getLighterCreds: app.getLighterCreds, getDeriveCreds: app.getDeriveCreds,
  lighterAccount: lighter.getAccount, deriveSubaccount: derive.getSubaccount,
  funds: (wallet, symbols) => bsc.getFunds(wallet, bsc.agentAddress(), symbols, pancake.priceOf),
  moved24h: store.moved24h,
  sigma: realSigma,
  proxy: (n, t, ids) => pickProxy(n, t, ids),
  options: (n, t) => getChain(n, t),
  hedge: realHedgeDeps,
  lighterMarket: lighter.getMarket,
  allLighterAccounts: async (n, wallet, mainIndex) => {
    const j = await lighter.lighterGet<{ sub_accounts?: { index: number; account_type?: number }[] }>(n, 'accountsByL1Address', { l1_address: wallet });
    const idx = [...new Set([mainIndex, ...(j.sub_accounts ?? []).map((a) => a.index)])];
    const rows: (VenueAccount | null)[] = await Promise.all(idx.map(async (i): Promise<VenueAccount | null> => { const a = await lighter.getAccount(n, i).catch(() => null); return a ? { venue: 'lighter' as const, id: i, label: i === mainIndex ? `Lighter main #${i}` : `Lighter sub-account #${i}`, equityUsd: Number(a.total_asset_value) || 0, freeUsd: Number(a.available_balance) || 0, main: i === mainIndex } : null; }));
    return rows.filter((r): r is VenueAccount => r !== null);
  },
  allDeriveSubaccounts: async (n, wallet, c, mainId) => (await derive.listSubaccounts(n, wallet, c)).map((x) => {
    // Derive's initial_margin IS the free margin (equity minus the initial-margin requirement), as healthOf reads it.
    const eq = Number(x.collaterals_value) || 0; const free = Number(x.initial_margin) || 0;
    return { venue: 'derive' as const, id: x.subaccount_id, label: `Derive #${x.subaccount_id}${x.universeName ? ` (${x.universeName})` : ''}`, equityUsd: eq, freeUsd: Math.max(0, Math.min(eq, free)), main: x.subaccount_id === mainId };
  }),
};

const safe = <T,>(f: () => T): T | undefined => { try { return f(); } catch { return undefined; } };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * `wide` (chat only): also read every listed bStock and both venues even when no rule or hedge leg names them, so
 * "what do I hold?" is answered from the real wallet. The tick loop leaves it off and reads only what its rules need.
 */
export async function collectSnapshot(wallet: string, network: Network, userCfg: AgentConfig, deps: CollectDeps = realDeps, wide = false): Promise<Snapshot> {
  // May gain default hedge legs below (never saved: the user's settings are untouched).
  let cfg = userCfg;
  const dq: string[] = []; const health: Record<string, AccountHealth> = {}; const moved: Record<string, string> = {};
  let ruleState: Record<string, RuleState> = {}; let lighterPositions: Record<number, number> = {};
  let lighterMain: Snapshot['lighterMain'];
  const hedgeProblems: string[] = [];
  let unassessed: Record<string, string> | undefined;
  let funds: BscFunds = { usdcUsd: 0, usdtUsd: 0, bstocks: [], allowanceUsdcBase: '0' };

  try { ruleState = await deps.getRuleStates(wallet, network); } catch (e) { dq.push(`rule-state unreadable: ${msg(e)}`); }

  let lighterCreds: app.LighterCreds | null = null; let deriveCreds: app.DeriveCreds | null = null;
  // Hedging on means Lighter may be needed even with no leg configured yet (a held bStock gets a default leg).
  const needLighter = wide || cfg.rebalance.rules.some((r) => r.venue === 'lighter') || cfg.hedge.enabled;
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

  // Every account, not only the ones a rule points at: balances and free margin across all sub-accounts.
  const venueAccounts: VenueAccount[] = [];
  if (lighterCreds && deps.allLighterAccounts) { try { venueAccounts.push(...await deps.allLighterAccounts(network, wallet, lighterCreds.accountIndex)); } catch (e) { dq.push(`Lighter sub-accounts unreadable: ${msg(e)}`); } }
  if (deriveCreds && deps.allDeriveSubaccounts) { try { venueAccounts.push(...await deps.allDeriveSubaccounts(network, wallet, deriveCreds, deriveCreds.subaccountId)); } catch (e) { dq.push(`Derive subaccounts unreadable: ${msg(e)}`); } }

  try {
    // With hedging on, read every listed bStock: a holding with no leg yet must still be seen to be hedged.
    const symbols = [...new Set([...cfg.hedge.legs.map((l) => l.bstock), ...cfg.rebalance.sellOrder, ...(wide || cfg.hedge.enabled ? TRADEABLE.map((t) => t.symbol) : [])])];
    const r = await deps.funds(wallet, symbols);
    funds = r.funds; dq.push(...r.problems);
  } catch (e) { dq.push(`BNB balances unreadable: ${msg(e)}`); }

  if (cfg.hedge.enabled) {
    const held = funds.bstocks.filter((b) => b.qty > 0).map((b) => b.symbol);
    if (held.some((s) => !cfg.hedge.legs.some((l) => tickerOf(l.bstock) === tickerOf(s)))) {
      try {
        const added = defaultHedgeLegs(cfg.hedge.legs, held, await (deps.lighterMarkets ?? realLighterMarkets)(network));
        if (added.length) cfg = { ...cfg, hedge: { ...cfg.hedge, legs: [...cfg.hedge.legs, ...added] } };
      } catch (e) { hedgeProblems.push(`Lighter market list unreadable, so holdings without a hedge leg are not hedged: ${msg(e)}`); }
    }
  }

  // Hedging inputs. A problem here only stops hedging (never margin top-ups): the agent never guesses a volatility.
  let market: Snapshot['market'];
  let proxyPrices: Snapshot['proxyPrices'];
  const options: Record<string, OptionChain> = {};
  let hedgeData: Awaited<ReturnType<typeof collectHedgeData>> | undefined;
  const marketMins: NonNullable<Snapshot['marketMins']> = {};
  if (cfg.hedge.enabled && cfg.hedge.legs.length) {
    if (needLighter && !lighterMain) hedgeProblems.push('no Lighter account to hedge on');
    const heldSet = new Set(funds.bstocks.filter((b) => b.qty > 0).map((b) => b.symbol));
    if (cfg.hedge.sizing === 'ratio') {
      // Value-based sizing: read the HEDGE price, positions and venue minimums per leg. A leg whose price cannot be read is skipped.
      if (heldSet.size) {
        // Live reads come only from the deps (realDeps passes the real venues), never as a hidden default.
        if (deps.hedge) { const hd = await collectHedgeData(network, wallet, cfg.hedge, heldSet, lighterPositions, deriveCreds, deps.hedge); hedgeData = hd; hedgeProblems.push(...hd.problems); }
      }
    }
    // Volatility for every held name, in both sizing modes: the risk view (modelled loss, required hedge ratio) needs it
    // even when hedges are sized by ratio. Read live from the Lighter candles, cached 10 minutes.
    if (heldSet.size && deps.sigma) { const m = await collectMarket(network, cfg.hedge, heldSet, deps.sigma); market = m.market; hedgeProblems.push(...m.problems); unassessed = m.unassessed; }
    // Lighter order minimums for the hedge markets of held bStocks (a missing read just skips the check).
    if (cfg.hedge.sizing !== 'ratio' && deps.lighterMarket) for (const leg of cfg.hedge.legs.filter((l) => heldSet.has(l.bstock) && l.venue === 'lighter' && l.marketId !== undefined)) { try { const m = await deps.lighterMarket(network, leg.marketId as number); marketMins[leg.marketId as number] = { minBase: Number(m.min_base_amount), sizeDecimals: m.size_decimals, minNotionalUsd: 10 }; } catch { /* no minimum known */ } }
    // Derive put chains for every held ticker, read live (both sizing modes, so the risk view knows a put exists).
    // A missing chain just means no put is offered for that ticker.
    const chainOf = deps.options;
    if (chainOf) await Promise.all([...new Set([...heldSet].map(tickerOf))].map(async (t) => { try { const ch = await chainOf(network, t); if (ch) options[ch.ticker] = ch; } catch { /* no put offered */ } }));
    // Proxy hedges: for each held name, the Lighter market whose hourly returns track it best (measured live).
    // The user's own proxyMap entries win; the via market gets a perp leg so the planner can trade it.
    if (deps.proxy && market) {
      try {
        const ids = Object.fromEntries((await (deps.lighterMarkets ?? realLighterMarkets)(network)).map((m) => [m.symbol, m.marketId]));
        const proxyMap = { ...(cfg.risk.proxyMap ?? {}) }; const legs = [...cfg.hedge.legs]; const prices: Record<string, number> = {};
        for (const t of [...new Set([...heldSet].map(tickerOf))]) {
          const p = await deps.proxy(network, t, ids).catch(() => null);
          if (!p) continue;
          const via = proxyMap[t]?.via ?? p.via; if (via !== p.via) continue;   // user chose another proxy: leave it
          proxyMap[t] ??= { via: p.via, beta: p.beta };
          prices[p.via] = p.price;
          if (market.sigmaDay[p.via] === undefined && deps.sigma) { const sg = await deps.sigma(network, p.viaMarketId).catch(() => null); if (sg) market.sigmaDay[p.via] = sg; }
          if (!legs.some((l) => l.venue === 'lighter' && tickerOf(l.bstock) === p.via)) legs.push({ bstock: `${p.via}B`, venue: 'lighter', kind: 'perp', market: p.via, marketId: p.viaMarketId, hedgeRatio: 1 });
        }
        if (Object.keys(prices).length) { cfg = { ...cfg, risk: { ...cfg.risk, proxyMap }, hedge: { ...cfg.hedge, legs } }; proxyPrices = prices; }
      } catch (e) { hedgeProblems.push(`proxy markets unreadable: ${msg(e)}`); }
    }
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
    options: Object.keys(options).length ? options : undefined, proxyPrices, heldPuts: safe(() => store.openPuts(wallet, network)), deriveEtaSec: config().DERIVE_ETA_SEC,
    venueAccounts: venueAccounts.length ? venueAccounts : undefined,
    // Derive: the subaccount with the most free funds across ALL of them (falls back to a rule's account).
    deriveFree: (() => {
      const best = venueAccounts.filter((a) => a.venue === 'derive').sort((a, b) => b.freeUsd - a.freeUsd)[0];
      if (best) return { ref: String(best.id), freeUsd: best.freeUsd };
      const k = Object.keys(health).find((x) => x.startsWith('derive:') && health[x].connected); return k ? { ref: k.slice(7), freeUsd: Math.max(0, (health[k].accountUsd ?? 0) - (health[k].usedUsd ?? 0)) } : undefined;
    })() };
}
