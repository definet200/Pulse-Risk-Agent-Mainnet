import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { config } from '../config';
import { log } from '../log';
import { readPrompt } from '../llm/prompts';
import * as app from '../tools/appApi';
import { collectSnapshot } from '../tools/collect';
import { assessRisk } from '../risk/plan';
import { buildStatus } from '../status';
import type { Snapshot } from '../types';
import { buildFacts, type Fact, type Recorded } from './facts';
import { buildMockSnapshot, describeMock, MARKETS, MockPortfolio } from './mock';
import { applyOverrides, Overrides } from './overrides';
import { DEFAULT_CONFIG } from '../../../lib/agent-config';
import { runWhatIf, withScratchStore, type WhatIfResult } from './whatif';
import { lighterGet } from '../tools/lighter';
import { rpc as deriveRpc } from '../tools/derive';

// The chat agent: a tool-using LangGraph (model -> tools -> model ...). The model decides, per message, whether it needs any tool at all. "Hi"
// gets a plain reply and no data is read. Questions about the user's money read their portfolio; "what if" questions and portfolios typed in text
// run the real hedging agent (the graph in src/graph) as a tool on mock numbers, in dry run. Every fact a tool returns gets an id; the reply cites
// ids and code checks every dollar figure and percentage in it against those facts. The chat cannot execute, approve or save anything: approving
// is the Approve button the chat UI shows for a pending request, which calls the app's own approval endpoint.

export interface ChatRequest { wallet: string; network: 'mainnet' | 'testnet'; message: string; history: { role: 'user' | 'agent'; text: string }[]; recorded: Recorded }
export interface Step { tool: string; label: string }
/** What the hedge card shows in its Home and Limits tabs, built by code from the numbers the test ran on. */
export interface CardView {
  portfolioUsd: number; hedgedPct: number; requiredHedgePct: number; varPct: number; limitPct: number; mode: 'autonomous' | 'confirm'; killSwitch: boolean;
  holdings: { ticker: string; usd: number; hedgedPct: number }[]; nextEvent: { ticker: string; kind: string; inHours: number } | null;
  limits: { maxPerTradeUsd: number; maxPerDayUsd: number; maxLeverage: number; dailyLossCapUsd: number; weeklyBudgetPct: number; lossTolerancePct: number };
}
export interface Scenario { kind: 'current' | 'mock'; /** the user's real numbers with nothing changed, so an Approve on a matching pending request is real */ live: boolean; view: CardView | null; inputs: string[]; decision: string; outcome: string; reasons: string[]; why: string | null; limitMet: boolean | null;
  plan: { instrument?: string; sizeUsd?: number; varBeforePct?: number; varAfterPct?: number; limitPct?: number; costUsd?: number; budgetUsd?: number } | null }
export interface ChatResponse {
  answer: string; cites: Fact[]; unsure: boolean; unsureReason: string | null;
  source: 'live' | null; sourceNote: string | null; steps: Step[]; scenarios: Scenario[];
  ui: { showPending: boolean; showActivity: boolean }; usedTools: boolean; usedModel: boolean;
}

/** Money and percentages in a text, as numbers: "$1,500" -> 1500, "$50k" -> 50000, "7.45%" -> 7.45. Only tokens with a $ or % sign count. */
export function figures(text: string): { raw: string; value: number }[] {
  const out: { raw: string; value: number }[] = [];
  for (const m of text.matchAll(/(\$)?(\d[\d,]*(?:\.\d+)?)\s?([kKmM])?(%)?/g)) {
    if (!m[1] && !m[4]) continue;
    let v = Number(m[2].replace(/,/g, '')); if (Number.isNaN(v)) continue;
    if (m[3]) v *= /k/i.test(m[3]) ? 1e3 : 1e6;
    out.push({ raw: m[0].trim(), value: v });
  }
  return out;
}
/** Figures in the answer that appear nowhere in the facts, the user's message or the conversation. Rounding to the displayed precision is allowed. */
export function ungroundedFigures(answer: string, sources: string[]): string[] {
  const allowed = sources.flatMap((t) => [...t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?([kKmM])?/g)].map((m) => Number(m[1].replace(/,/g, '')) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1))).filter((n) => !Number.isNaN(n));
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.06, Math.abs(b) * 0.005);
  return [...new Set(figures(answer).filter((f) => !allowed.some((n) => near(f.value, n))).map((f) => f.raw))];
}

// ---- the model (injectable so tests never touch the network) ------------------------------------------------------------------------------
export type ChatModel = (messages: BaseMessage[], tools: StructuredToolInterface[]) => Promise<AIMessage>;
const realModel: ChatModel = async (messages, tools) => {
  const c = config();
  if (!c.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
  const llm = new ChatOpenAI({ model: c.LLM_MODEL_ANALYST, apiKey: c.OPENROUTER_API_KEY, temperature: c.LLM_TEMPERATURE, timeout: c.LLM_TIMEOUT_MS, maxRetries: c.LLM_MAX_RETRIES, configuration: { baseURL: c.OPENROUTER_BASE_URL } });
  return (await llm.bindTools(tools).invoke(messages)) as AIMessage;
};
let model: ChatModel = realModel;
export const setChatModel = (m?: ChatModel) => { model = m ?? realModel; };
const modelAvailable = () => model !== realModel || !!config().OPENROUTER_API_KEY;

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
const text = (m: AIMessage) => (typeof m.content === 'string' ? m.content : (m.content as { type: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n'));

// ---- per-request context and the tools -----------------------------------------------------------------------------------------------------
/** Thrown when the user's live accounts cannot be read. The tool result carries the message, so the model tells the user and answers nothing from data. */
class LiveUnavailable extends Error {}
type LiveReader = (wallet: string, network: ChatRequest['network']) => Promise<{ snapshot: Snapshot; note: string | null }>;
const realReadLive: LiveReader = async (wallet, network) => {
  const ws = await withTimeout(app.listWallets(network), 15_000, 'the app');
  const w = ws.find((x) => x.wallet.toLowerCase() === wallet.toLowerCase());
  // No saved settings yet: still read the wallet and venues live, with the default settings.
  const snapshot = await withTimeout(withScratchStore(() => collectSnapshot(wallet, network, w?.config ?? DEFAULT_CONFIG, undefined, true)), 45_000, 'reading the accounts');
  return { snapshot, note: w ? null : 'No agent settings saved for this wallet yet; read with the defaults.' };
};
let readLive: LiveReader = realReadLive;
/** Tests only: supply the account read (like setChatModel). No argument restores the real live read. */
export function setLiveReader(fn?: LiveReader) { readLive = fn ?? realReadLive; }

class Ctx {
  snapshot: Snapshot | null = null; source: 'live' | null = null; sourceNote: string | null = null; blocked: string | null = null;
  facts: Fact[] = []; steps: Step[] = []; scenarios: Scenario[] = []; ui = { showPending: false, showActivity: false };
  constructor(readonly req: ChatRequest) {}
  /** Give every fact a conversation-wide id and return them for the model to read. */
  register(items: { label: string; value: string }[]): Fact[] { const base = this.facts.length; const out = items.map((x, i) => ({ id: `F${base + i + 1}`, label: x.label, value: x.value })); this.facts.push(...out.map((f) => ({ ...f }))); return out; }
  /** Live data only, read fresh for every message. There is no sample fallback: if the accounts cannot be read, say why and answer nothing from data. */
  async ensureSnapshot(): Promise<Snapshot> {
    if (this.snapshot) return this.snapshot;
    if (this.blocked) throw new LiveUnavailable(this.blocked);
    const { wallet, network } = this.req;
    // Not signed in: the app sends the zero address. There is no account to read.
    if (/^0x0{40}$/i.test(wallet)) { this.blocked = 'No wallet is registered with the agent on this app yet, so there is no live portfolio to read. Connect a wallet and its agent keys on the Risk management page, then ask again.'; throw new LiveUnavailable(this.blocked); }
    try { const r = await readLive(wallet, network); this.snapshot = r.snapshot; this.source = 'live'; this.sourceNote = r.note; return this.snapshot; }
    catch (e) {
      const why = e instanceof Error ? e.message : String(e); log.warn(`chat: live read failed: ${why}`);
      this.blocked = `I could not read your live accounts just now (${why}). I only answer from your live portfolio, so I will not guess. Try again in a moment.`; throw new LiveUnavailable(this.blocked);
    }
  }
}

const when = (t?: number | null) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown time');
const ok = (ctx: Ctx, items: { label: string; value: string }[], note?: string) => JSON.stringify({ facts: ctx.register(items), ...(note ? { note } : {}) });

function viewOf(s: Snapshot): CardView | null {
  try {
    const st = buildStatus(s); const l = s.config.limits;
    return { portfolioUsd: st.portfolioUsd, hedgedPct: st.hedgedPct, requiredHedgePct: st.requiredHedgePct, varPct: st.varPct, limitPct: st.limitPct, mode: st.mode as 'autonomous' | 'confirm', killSwitch: st.killSwitch,
      holdings: st.tickers.map((t) => ({ ticker: t.ticker, usd: t.usd, hedgedPct: t.hedgedPct })), nextEvent: st.nextEvent ? { ticker: st.nextEvent.ticker, kind: st.nextEvent.kind, inHours: st.nextEvent.inHours } : null,
      limits: { maxPerTradeUsd: l.maxNotionalPerTradeUsd, maxPerDayUsd: l.maxNotionalPerDayUsd, maxLeverage: l.maxLeverage, dailyLossCapUsd: l.dailyLossCapUsd, weeklyBudgetPct: s.config.risk.premiumBudgetWeeklyPct, lossTolerancePct: s.config.risk.lossTolerancePct } };
  } catch { return null; }
}
function scenarioOf(kind: 'current' | 'mock', inputs: string[], r: WhatIfResult, snap: Snapshot, live = false): Scenario {
  const p = r.card?.plan as { instrument?: string; sizeUsd?: number; varBeforePct?: number; varAfterPct?: number; limitPct?: number; cost?: { premiumUsd: number; feesUsd: number; weeklyBudgetUsd: number } } | null | undefined;
  return { kind, live, view: viewOf(snap), inputs, decision: r.decision, outcome: r.outcome, reasons: r.reasons, why: r.card?.why ?? null,
    limitMet: p && p.varAfterPct !== undefined && p.limitPct !== undefined ? p.varAfterPct <= p.limitPct + 1e-9 : null,
    plan: p ? { instrument: p.instrument, sizeUsd: p.sizeUsd, varBeforePct: p.varBeforePct, varAfterPct: p.varAfterPct, limitPct: p.limitPct, costUsd: p.cost ? p.cost.premiumUsd + p.cost.feesUsd : undefined, budgetUsd: p.cost?.weeklyBudgetUsd } : null };
}
const usd = (n: number | undefined) => (n === undefined ? 'unknown' : `$${Math.round(n).toLocaleString('en-US')}`);
function resultFacts(inputs: string[], r: WhatIfResult): { label: string; value: string }[] {
  const p = r.card?.plan as { instrument?: string; sizeUsd?: number; varBeforePct?: number; varAfterPct?: number; limitPct?: number; cost?: { premiumUsd: number; feesUsd: number; weeklyBudgetUsd: number } } | null | undefined;
  const f = [{ label: 'Test input', value: `${inputs.join('. ')} (a dry-run test: nothing was sent or saved)` }, { label: 'Test decision', value: `${r.decision} [${r.outcome}]` }];
  if (p) f.push({ label: 'Test plan', value: `${p.instrument ?? ''} ${usd(p.sizeUsd)}; modelled loss ${p.varBeforePct}% to ${p.varAfterPct}% against a ${p.limitPct}% limit; cost ${usd((p.cost?.premiumUsd ?? 0) + (p.cost?.feesUsd ?? 0))} of a ${usd(p.cost?.weeklyBudgetUsd)} weekly budget. Limit ${(p.varAfterPct ?? 99) <= (p.limitPct ?? 0) + 1e-9 ? 'MET' : 'NOT met'}: ${p.varAfterPct}% after against ${p.limitPct}%` });
  if (r.card) f.push({ label: 'Test why', value: r.card.why.slice(0, 600) }, { label: 'Test steps if approved', value: r.card.willDo.join('; ').slice(0, 400) });
  for (const x of r.reasons.slice(0, 4)) f.push({ label: 'Test note', value: x });
  for (const x of r.events.slice(0, 5)) f.push({ label: 'Test event posted', value: x.slice(0, 300) });
  return f;
}

function makeTools(ctx: Ctx): StructuredToolInterface[] {
  return [
    tool(async () => {
      ctx.steps.push({ tool: 'get_portfolio', label: 'Read your portfolio' });
      const s = await ctx.ensureSnapshot();
      const facts = buildFacts(s, { actions: [], events: [] }, null, ctx.source!).map((f) => ({ label: f.label, value: f.value }));
      return ok(ctx, facts, ctx.sourceNote ?? undefined);
    }, { name: 'get_portfolio', description: "Read the user's portfolio: holdings, hedges, positions, balances, limits, settings, mode, modelled loss, events, news flags. Use for anything about their current state.", schema: z.object({}) }),

    tool(async ({ limit }: { limit?: number }) => {
      ctx.steps.push({ tool: 'get_activity', label: 'Read recent activity' }); ctx.ui.showActivity = true;
      const s = await ctx.ensureSnapshot();
      const rec = ctx.req.recorded; const n = Math.min(limit ?? 6, 10);
      const items: { label: string; value: string }[] = [{ label: 'Mode', value: s.config.mode === 'autonomous' ? 'Autonomous: the agent acts on its own inside your caps' : 'Ask me first: the agent waits for your approval' }];
      for (const a of rec.actions.slice(0, n)) items.push({ label: `Recorded request #${a.id}`, value: `${a.status} on ${when(a.created_at)}: ${a.title}. Why: ${a.why.slice(0, 320)}${a.result_message ? ` Result: ${a.result_message.slice(0, 180)}` : ''}` });
      for (const e of rec.events.slice(0, n)) items.push({ label: 'Recorded event', value: `${when(e.created_at)} ${e.kind}${e.status ? `/${e.status}` : ''}: ${e.message.slice(0, 240)}` });
      if (!rec.actions.length && !rec.events.length) items.push({ label: 'Recorded activity', value: 'none yet' });
      return ok(ctx, items);
    }, { name: 'get_activity', description: 'Read what the agent has recorded: requests it proposed, what it did, what was blocked and why, and the current mode. Use for "why did you ...", "what did you do", and in autonomous mode to say what the agent has been doing. The chat then shows the activity list.', schema: z.object({ limit: z.number().int().min(1).max(10).optional() }) }),

    tool(async () => {
      ctx.steps.push({ tool: 'get_pending_requests', label: 'Checked what is waiting for approval' });
      const s = await ctx.ensureSnapshot(); const pend = ctx.req.recorded.actions.filter((a) => a.status === 'pending');
      if (pend.length) ctx.ui.showPending = true;
      const items: { label: string; value: string }[] = [{ label: 'Mode', value: s.config.mode === 'autonomous' ? 'Autonomous (a request still waits for you only when the agent needed your approval)' : 'Ask me first: nothing runs until the user presses Approve' }];
      for (const a of pend) items.push({ label: `Pending request #${a.id}`, value: `${a.title}. Why: ${a.why.slice(0, 360)}` });
      if (!pend.length) items.push({ label: 'Pending requests', value: 'none waiting' });
      return ok(ctx, items, pend.length ? 'The chat shows each pending request with Approve and Decline buttons. Tell the user to press Approve to run it.' : undefined);
    }, { name: 'get_pending_requests', description: 'List hedge requests waiting for the user. The chat then shows each with Approve and Decline buttons. Use when they ask what is waiting, what you propose, or want to approve.', schema: z.object({}) }),

    tool(async ({ base, overrides, mock }: { base: 'current' | 'mock'; overrides?: Overrides; mock?: MockPortfolio }) => {
      try {
        if (base === 'mock') {
          const m = MockPortfolio.parse(mock); const snap = buildMockSnapshot(m, ctx.req.wallet, ctx.req.network); const inputs = describeMock(m);
          const r = await withTimeout(runWhatIf(snap, { news: m.news }), 60_000, 'the hedging agent');
          ctx.steps.push({ tool: 'run_hedging_agent', label: 'Ran the hedging agent on a mock portfolio' }); ctx.scenarios.push(scenarioOf('mock', inputs, r, snap)); if (r.card?.plan) ctx.ui.showPending = false;
          return ok(ctx, resultFacts(inputs, r));
        }
        const s = await ctx.ensureSnapshot(); const o = Overrides.parse(overrides ?? {});
        const { snapshot, applied } = applyOverrides(s, o); const inputs = [`your portfolio with ${applied.length ? applied.join('; ') : 'no changes'}`];
        const r = await withTimeout(runWhatIf(snapshot), 60_000, 'the hedging agent');
        ctx.steps.push({ tool: 'run_hedging_agent', label: applied.length ? 'Ran the hedging agent with changed values' : 'Ran the hedging agent on your current numbers' }); ctx.scenarios.push(scenarioOf('current', inputs, r, snapshot, applied.length === 0)); if (applied.length === 0 && r.card?.plan) ctx.ui.showPending = true;
        return ok(ctx, resultFacts(inputs, r), ctx.sourceNote ?? undefined);
      } catch (e) {
        const msg = e instanceof z.ZodError ? `invalid arguments: ${e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` : e instanceof Error ? e.message : String(e);
        return JSON.stringify({ error: msg });
      }
    }, { name: 'run_hedging_agent', description: 'Run the real hedging agent in dry run on numbers you choose, and read its decision, plan and whether the limit is met. base "current" with overrides tests the user\'s portfolio with a few values changed; base "mock" with mock tests a whole portfolio you build from what the user typed (defaults fill in what they did not say). Nothing is sent or saved.',
      schema: z.object({ base: z.enum(['current', 'mock']), overrides: Overrides.optional(), mock: MockPortfolio.optional() }) }),

    tool(async ({ tickers }: { tickers?: string[] }) => {
      ctx.steps.push({ tool: 'get_venue_tickers', label: 'Looked up the tickers on Lighter and Derive' });
      const want = (tickers ?? []).map((t) => t.toUpperCase().replace(/B$/, '')).filter(Boolean);
      const items: { label: string; value: string }[] = [];
      try {
        const j = await withTimeout(lighterGet<{ order_books?: { symbol: string; market_type?: string }[] }>('mainnet', 'orderBooks'), 12_000, 'Lighter');
        const all = j.order_books ?? []; const perps = all.filter((m) => (m.market_type ?? 'perp') !== 'spot').map((m) => m.symbol);
        if (!want.length) items.push({ label: 'Lighter markets', value: `${perps.length} perp markets: ${perps.join(', ')}` });
        for (const t of want) { const hit = all.filter((m) => m.symbol.toUpperCase() === t || m.symbol.toUpperCase().startsWith(`${t}-`) || m.symbol.toUpperCase() === `${t}USD`); items.push({ label: `Lighter ${t}`, value: hit.length ? `listed: ${hit.map((m) => `${m.symbol}${m.market_type ? ` (${m.market_type})` : ''}`).join(', ')}` : 'no market with that symbol in the live Lighter market list' }); }
      } catch (e) { items.push({ label: 'Lighter markets', value: `could not be read just now (${e instanceof Error ? e.message : String(e)})` }); }
      try {
        const cur = await withTimeout(deriveRpc<{ currency: string }[]>('mainnet', 'public/get_all_currencies', {}, {}), 12_000, 'Derive');
        const names = (Array.isArray(cur) ? cur : []).map((c) => c.currency);
        if (!want.length) items.push({ label: 'Derive currencies', value: `${names.length} underlyings: ${names.join(', ')}` });
        for (const t of want) {
          let opts = 0;
          try { const r = await withTimeout(deriveRpc<{ instrument_name: string }[]>('mainnet', 'public/get_instruments', { currency: t, instrument_type: 'option', expired: false }, {}), 12_000, 'Derive'); opts = Array.isArray(r) ? r.length : 0; } catch { /* not listed */ }
          items.push({ label: `Derive ${t}`, value: opts ? `listed, ${opts} live option instruments` : names.includes(t) ? 'listed as an underlying, no live option instruments returned' : 'no live option instruments with that underlying in the live Derive list' });
        }
      } catch (e) { items.push({ label: 'Derive currencies', value: `could not be read just now (${e instanceof Error ? e.message : String(e)})` }); }
      return ok(ctx, items, 'Read live from the Lighter and Derive public APIs just now.');
    }, { name: 'get_venue_tickers', description: 'List what is actually tradeable right now on Lighter (perp markets) and Derive (option underlyings), read live from both venues. Pass tickers to check specific ones (for example NVDA, XAU, ETH); omit to list everything. Use it when the user asks which tickers or markets exist, or before saying a hedge market is unavailable: never claim a ticker is missing without checking here.', schema: z.object({ tickers: z.array(z.string().max(10)).max(12).optional() }) }),

    tool(async ({ tickers }: { tickers?: string[] }) => {
      ctx.steps.push({ tool: 'get_market_data', label: 'Looked up market data' });
      const want = (tickers?.length ? tickers : Object.keys(MARKETS)).map((t) => t.toUpperCase());
      return ok(ctx, want.map((t) => { const m = MARKETS[t]; return { label: `${t} market`, value: m ? `spot ${usd(m.spot)}, daily volatility ${(m.sigma * 100).toFixed(1)}%, Lighter perp ${m.perp !== null ? 'yes' : 'no'}, Derive put ${m.put !== null ? `yes (implied volatility ${Math.round(m.put * 100)}%)` : 'no'}` : 'not in the agent market table' }; }), "These are the agent's market table values, used for tests; live runs read prices from the venues.");
    }, { name: 'get_market_data', description: "Spot, daily volatility and which hedge markets (Lighter perp, Derive put) exist, per ticker, from the agent's market table.", schema: z.object({ tickers: z.array(z.string().max(8)).max(12).optional() }) }),
    tool(async () => {
      ctx.steps.push({ tool: 'get_context', label: 'Checked the agent state' });
      const s = await ctx.ensureSnapshot(); const st = buildStatus(s); const rec = ctx.req.recorded; const pend = rec.actions.filter((a) => a.status === 'pending').length;
      const last = rec.events[0]?.created_at ?? rec.actions[0]?.created_at ?? null;
      return ok(ctx, [
        { label: 'Data source', value: 'live accounts' },
        { label: 'Mode', value: `${st.mode === 'autonomous' ? 'Autonomous: acts on its own inside the caps' : 'Ask me first: waits for approval'}${st.killSwitch ? '; kill switch ON, no new orders or transfers' : ''}${st.limitsUsed.autonomyExpiresAt ? `; autonomy until ${st.limitsUsed.autonomyExpiresAt.slice(0, 16).replace('T', ' ')} UTC` : ''}` },
        { label: 'Agent state', value: `network ${ctx.req.network}; hedging ${s.config.hedge.enabled ? 'on' : 'OFF'}; news flags ${s.config.hedge.news.enabled ? 'on' : 'off'}; ${pend} request${pend === 1 ? '' : 's'} waiting for approval; last recorded activity ${last ? when(last) : 'none'}${st.paused ? `; PAUSED: ${st.paused.reason}` : ''}` },
        ...st.alerts.slice(0, 3).map((a) => ({ label: 'Alert', value: a })),
      ], ctx.sourceNote ?? undefined);
    }, { name: 'get_context', description: 'A short read of the agent state: live or sample data, the mode (Ask me first or Autonomous), the kill switch, whether it is paused, how many requests wait for approval, the last activity. Use for "what mode am I in", "is the agent running", "what is going on". Cheaper than get_portfolio.', schema: z.object({}) }),

    tool(async () => {
      const s = await ctx.ensureSnapshot(); const st = buildStatus(s); const risk = assessRisk(s);
      const r = await withTimeout(runWhatIf(s), 60_000, 'the hedging agent');
      ctx.steps.push({ tool: 'get_suggestions', label: 'Worked out suggestions' }); ctx.scenarios.push(scenarioOf('current', [`your current numbers`], r, s, true)); if (r.card?.plan) ctx.ui.showPending = true;
      const items: { label: string; value: string }[] = [];
      const p = r.card?.plan as { options?: string[]; varAfterPct?: number; limitPct?: number } | null | undefined;
      items.push({ label: 'Suggestion: the agent would', value: `${r.decision}${p && p.varAfterPct !== undefined && p.limitPct !== undefined ? `. Limit ${p.varAfterPct <= p.limitPct + 1e-9 ? 'MET' : 'NOT met'}: ${p.varAfterPct}% after against ${p.limitPct}%` : ''}` });
      for (const o of p?.options ?? []) items.push({ label: 'Suggestion: option', value: o });
      if (st.varPct > st.limitPct + 1e-9) items.push({ label: 'Suggestion: why', value: `modelled loss ${st.varPct}% is above your ${st.limitPct}% limit; the limit needs ${st.requiredHedgePct}% of the portfolio hedged and ${st.hedgedPct}% is` });
      for (const t of st.tickers.filter((x) => x.bucket === 'none' && !x.excluded)) items.push({ label: 'Suggestion: no hedge market', value: `${t.ticker} (${usd(t.usd)}) has no hedge market, so it stays unhedged` });
      if (risk?.concentration) items.push({ label: 'Suggestion: concentration', value: risk.concentration });
      if (st.nextEvent) { const t = st.tickers.find((x) => x.ticker === st.nextEvent!.ticker); items.push({ label: 'Suggestion: next event', value: `${st.nextEvent.ticker} ${st.nextEvent.kind} in ${Math.round(st.nextEvent.inHours)}h; ${t ? `${Math.round(t.hedgedPct)}% hedged now` : 'not held'}` }); }
      const pend = ctx.req.recorded.actions.filter((a) => a.status === 'pending').length;
      if (pend) { items.push({ label: 'Suggestion: waiting for you', value: `${pend} request${pend === 1 ? '' : 's'} waiting for your approval` }); ctx.ui.showPending = true; }
      for (const a of st.alerts.slice(0, 3)) items.push({ label: 'Alert', value: a });
      if (r.reasons[0] && !r.card) items.push({ label: 'Suggestion: why nothing', value: r.reasons[0] });
      return ok(ctx, items, ctx.sourceNote ?? undefined);
    }, { name: 'get_suggestions', description: 'Work out what to do next: runs the hedging agent on the current numbers and collects code-derived suggestions (what it would do, whether the limit is met, options when it is not, unhedged names, the next event, concentration, requests waiting). Use when the user asks what to do, what you suggest, or how to improve their protection. Do not call it for greetings or general questions.', schema: z.object({}) }),
  ] as unknown as StructuredToolInterface[];
}

// ---- the graph: model -> tools -> model ... -------------------------------------------------------------------------------------------------
const MAX_STEPS = 7;
const S = Annotation.Root({ messages: Annotation<BaseMessage[]>({ reducer: (a, b) => a.concat(b), default: () => [] }), n: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }) });

function buildLoop(ctx: Ctx) {
  const tools = makeTools(ctx); const byName = new Map(tools.map((t) => [t.name, t]));
  return new StateGraph(S)
    .addNode('model', async (st: typeof S.State) => ({ messages: [await withTimeout(model(st.messages, tools), 90_000, 'the model')], n: st.n + 1 }))
    .addNode('tools', async (st: typeof S.State) => {
      const last = st.messages[st.messages.length - 1] as AIMessage; const out: ToolMessage[] = [];
      for (const c of last.tool_calls ?? []) {
        const t = byName.get(c.name);
        let content: string;
        try { content = t ? String(await (t as unknown as { invoke: (a: unknown) => Promise<unknown> }).invoke(c.args)) : JSON.stringify({ error: `unknown tool ${c.name}` }); }
        catch (e) { content = JSON.stringify({ error: e instanceof z.ZodError ? `invalid arguments: ${e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` : e instanceof Error ? e.message : String(e) }); }
        out.push(new ToolMessage({ content, tool_call_id: c.id ?? c.name, name: c.name }));
      }
      return { messages: out };
    })
    .addEdge(START, 'model')
    .addConditionalEdges('model', (st) => ((st.messages[st.messages.length - 1] as AIMessage).tool_calls?.length && st.n < MAX_STEPS ? 'tools' : END), ['tools', END])
    .addEdge('tools', 'model').compile();
}

/** Split the model's closing SOURCES and UNSURE lines from the answer. */
export function parseReply(raw: string): { answer: string; sources: string[]; unsure: string | null } {
  let sources: string[] = []; let unsure: string | null = null; const keep: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.replace(/^[`*\s]+|[`*\s]+$/g, '');
    const a = /^SOURCES:\s*(.*)$/i.exec(s); const b = /^UNSURE:\s*(.*)$/i.exec(s);
    if (a) sources = a[1].split(/[,\s]+/).map((x) => x.trim()).filter((x) => /^F\d+$/i.test(x)).map((x) => x.toUpperCase());
    else if (b) unsure = b[1].trim() || 'The agent is not sure.';
    else keep.push(line);
  }
  return { answer: keep.join('\n').trim(), sources, unsure };
}

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const ctx = new Ctx(req);
  const empty = (answer: string, why: string): ChatResponse => ({ answer, cites: [], unsure: true, unsureReason: why, source: ctx.source, sourceNote: ctx.sourceNote, steps: ctx.steps, scenarios: ctx.scenarios, ui: ctx.ui, usedTools: ctx.steps.length > 0, usedModel: false });
  if (!modelAvailable()) {
    // No model: the plain summary of the portfolio, labelled as such.
    let s: Snapshot; try { s = await ctx.ensureSnapshot(); } catch (e) { return empty(e instanceof Error ? e.message : String(e), 'No live data was read for this answer.'); }
    const f = buildFacts(s, req.recorded, null, 'live');
    const pick = ['Portfolio', 'Modelled 99% loss', 'Next event'].map((l) => f.find((x) => x.label === l)).filter((x): x is Fact => !!x);
    ctx.steps.push({ tool: 'get_portfolio', label: 'Read your portfolio' });
    return { ...empty(`${pick.map((x) => `${x.label}: ${x.value}.`).join(' ')} (The language model is not configured, so this is the plain summary.)`, 'The language model is not configured.'), cites: ctx.register(pick), usedTools: true };
  }
  const loop = buildLoop(ctx);
  const history = req.history.slice(-8).map((h) => (h.role === 'user' ? new HumanMessage(h.text) : new AIMessage(h.text)));
  const start: BaseMessage[] = [new SystemMessage(`${readPrompt('chat_agent.md')}\n\nContext: network ${req.network}. Today is ${new Date().toISOString().slice(0, 10)}.`), ...history, new HumanMessage(req.message)];
  let messages: BaseMessage[]; let finalText = '';
  try {
    const r = await loop.invoke({ messages: start });
    messages = r.messages; finalText = text(messages[messages.length - 1] as AIMessage);
  } catch (e) {
    log.warn(`chat failed: ${e instanceof Error ? e.message : String(e)}`);
    return empty('I could not answer that just now: the language model did not respond. Try again in a moment.', 'The language model did not respond.');
  }
  const sources = [req.message, ...req.history.map((h) => h.text)]; // With no tool used, plain percentages are general knowledge (a 10% gap, a 0.01% funding rate) but a dollar figure would be a claim about money with no live read behind it.
  const check = (t: string) => { const bad = ungroundedFigures(t, [...sources, ...ctx.facts.map((f) => f.value)]); return ctx.steps.length ? bad : bad.filter((x) => x.includes('$')); };
  let parsed = parseReply(finalText); let bad = check(parsed.answer);
  // Every money figure and percentage must come from the tool results. If the model made one up, ask once more with the offending figures named.
  if (bad.length) {
    try {
      const r2 = await loop.invoke({ messages: [...messages, new HumanMessage(`Your last answer used figures that are not in the tool results or my message: ${bad.join(', ')}. Any figure about my portfolio must come from a tool that read my live accounts: call the right tool first if you have not, then answer using only figures from the tool results. If they cannot answer it, say so and add an UNSURE line. Do not mention this correction, do not apologise, and do not refer to an earlier answer: reply as if it were your first answer.`)] });
      parsed = parseReply(text(r2.messages[r2.messages.length - 1] as AIMessage)); bad = check(parsed.answer);
    } catch { /* keep the first answer, it is flagged below */ }
  }
  const known = new Map(ctx.facts.map((f) => [f.id, f])); const cites = [...new Set(parsed.sources)].map((i) => known.get(i)).filter((x): x is Fact => !!x);
  const usedTools = ctx.steps.length > 0;
  let unsureReason: string | null = parsed.unsure;
  if (bad.length) unsureReason = `Some figures in this answer are not in my data and may be wrong: ${bad.slice(0, 6).join(', ')}.`;
  else if (ctx.blocked && !cites.length) unsureReason = 'No live data was read for this answer.';
  else if (usedTools && !cites.length && !unsureReason) unsureReason = 'I could not tie this answer to any of the data I read.';
  return { answer: (parsed.answer.length > 2200 ? `${parsed.answer.slice(0, 2200)}...` : parsed.answer) || 'I have nothing to add.', cites, unsure: !!unsureReason, unsureReason, source: ctx.source, sourceNote: ctx.sourceNote,
    steps: ctx.steps, scenarios: ctx.scenarios, ui: ctx.ui, usedTools, usedModel: true };
}
