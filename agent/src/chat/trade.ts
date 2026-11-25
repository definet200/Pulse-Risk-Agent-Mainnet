import { createHash } from 'node:crypto';
import type { Candidate, Network, Snapshot } from '../types';
import type { ActionPost } from '../tools/appApi';
import * as derive from '../tools/derive';
import * as lighter from '../tools/lighter';
import { realLighterMarkets } from '../tools/collect';
import { payoff, type Payoff } from '../risk/payoff';
import { venueAlternatives } from '../risk/alternatives';

// Positions the user asks for in the chat ("buy that NVDA put", "short 0.07 NVDA on Lighter"). The chat never trades:
// it posts a request with the exact order, payoff and venue comparison, and nothing is sent until the user presses
// Approve. On approval the live agent rebuilds the order from this spec, re-quotes it, and runs it through the same
// guard as every other trade (kill switch, per-trade and daily caps, daily loss stop).

export interface ChatTradeSpec {
  venue: 'lighter' | 'derive';
  /** Derive instrument name (NVDA-20261204-133-P, NVDA-PERP) or the Lighter market symbol (NVDA). */
  instrument: string;
  /** Lighter market id (Lighter only). */
  marketId?: number;
  kind: 'perp' | 'put';
  side: 'buy' | 'sell';
  /** Contracts (Derive) or base units (Lighter). */
  amount: number;
  /** Price the user saw when approving: the ask for a buy, the bid for a sell (per contract / unit). */
  quotedPrice: number;
  /** Underlying ticker, e.g. NVDA. */
  ticker: string;
}

export interface LiveQuote { price: number; index: number; notionalUsd: number; costUsd: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PUT = /^([A-Z0-9_]+)-(\d{8})-([0-9_]+)-P$/;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Check the order against the venue right now: listed, active, size within the venue's rules, a live price. */
export async function quoteSpec(n: Network, spec: ChatTradeSpec): Promise<LiveQuote> {
  if (spec.venue === 'derive') {
    const inst = await derive.getInstrument(n, spec.instrument);
    if (!inst.isActive) throw new Error(`${spec.instrument} is not active on Derive`);
    if (spec.amount < inst.minimumAmount) throw new Error(`Derive's minimum for ${spec.instrument} is ${inst.minimumAmount}`);
    const steps = spec.amount / inst.amountStep;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) throw new Error(`Derive trades ${spec.instrument} in steps of ${inst.amountStep}`);
    // Market makers on Derive's stock options pull quotes for moments (often outside US market hours): read the
    // book a few times before giving up (live 2026-11-25: one empty read failed an approved order).
    let t = await derive.getTicker(n, spec.instrument);
    for (let i = 0; i < 3 && !((spec.side === 'buy' ? t.ask : t.bid) > 0); i++) { await sleep(2_000); t = await derive.getTicker(n, spec.instrument); }
    const price = spec.side === 'buy' ? t.ask : t.bid;
    if (!(price > 0)) throw new Error(`Derive had no ${spec.side === 'buy' ? 'seller' : 'buyer'} quoting ${spec.instrument} for 6 seconds (stock-option quotes come and go, most often outside US market hours). Ask again for a fresh quote`);
    const index = t.index || price;
    return { price, index, notionalUsd: r2(spec.amount * (spec.kind === 'put' ? index : price)), costUsd: spec.kind === 'put' ? r2(spec.amount * price) : 0 };
  }
  if (spec.marketId === undefined) throw new Error('Lighter market id missing');
  const m = await lighter.getMarket(n, spec.marketId);
  const price = Number(m.last_trade_price);
  if (!(price > 0)) throw new Error(`no live price on Lighter ${spec.instrument}`);
  if (spec.amount < Number(m.min_base_amount)) throw new Error(`Lighter's minimum for ${spec.instrument} is ${m.min_base_amount}`);
  const notional = spec.amount * price;
  if (notional < 10) throw new Error(`$${notional.toFixed(2)} is under Lighter's $10 minimum order`);
  return { price, index: price, notionalUsd: r2(notional), costUsd: 0 };
}

/** Resolve what the user named into a spec (Lighter symbol → market id; Derive kind from the name). */
export async function specFrom(n: Network, a: { venue: 'lighter' | 'derive'; instrument: string; side: 'buy' | 'sell'; amount: number }): Promise<ChatTradeSpec> {
  const name = a.instrument.trim().toUpperCase();
  if (a.venue === 'derive') {
    const put = PUT.exec(name);
    const perp = /^([A-Z0-9_]+)-PERP$/.exec(name);
    if (!put && !perp) throw new Error('On Derive the chat can buy a put (e.g. NVDA-20261204-133-P) or trade a perp (e.g. NVDA-PERP). Calls and selling options are not supported.');
    if (put && a.side !== 'buy') throw new Error('Selling options is not supported from the chat; only buying protective puts.');
    return { venue: 'derive', instrument: name, kind: put ? 'put' : 'perp', side: a.side, amount: a.amount, quotedPrice: 0, ticker: (put ?? perp)![1] };
  }
  const sym = name.replace(/-PERP$/, '');
  const mk = (await realLighterMarkets(n)).find((x) => x.symbol === sym);
  if (!mk) throw new Error(`Lighter lists no ${sym} perp`);
  return { venue: 'lighter', instrument: sym, marketId: mk.marketId, kind: 'perp', side: a.side, amount: a.amount, quotedPrice: 0, ticker: sym };
}

/** The candidate the executor runs, built from the approved spec (never from the planner). */
export function candidateFromSpec(spec: ChatTradeSpec, q: LiveQuote, key: string): Candidate {
  const short = spec.side === 'sell';
  const what = `${spec.side === 'buy' ? 'Buy' : 'Sell'} ${spec.amount} ${spec.instrument} on ${spec.venue === 'derive' ? 'Derive' : 'Lighter'}`;
  return {
    id: `chat:${spec.venue}:${spec.instrument}:${spec.side}:${spec.amount}`, kind: 'hedge', venue: spec.venue, amountBaseUnit: '0', chat: true,
    reason: `You asked in the chat: ${what}`, explain: `${what} at about $${q.price} (${spec.kind === 'put' ? `premium about $${q.costUsd}` : `notional about $${q.notionalUsd}`}).`,
    notionalUsd: q.notionalUsd, idempotencyKey: key,
    hedge: spec.venue === 'derive'
      ? { bstock: `${spec.ticker}B`, market: spec.ticker, marketId: 0, deltaToShort: spec.kind === 'put' ? spec.amount : short ? spec.amount : -spec.amount, driftPct: 100, ticker: spec.ticker, venue: 'derive', kind: spec.kind,
        instrument: spec.kind, key: spec.kind === 'put' ? `derive-put:${spec.ticker}` : `derive-perp:${spec.ticker}`, derive: { instrument: spec.instrument } }
      : { bstock: `${spec.ticker}B`, market: spec.ticker, marketId: spec.marketId!, deltaToShort: short ? spec.amount : -spec.amount, driftPct: 100, ticker: spec.ticker, venue: 'lighter', kind: 'perp', key: `lighter:${spec.marketId}` },
  } as Candidate;
}

/** The request shown in the chat with Approve / Reject (payoff + venue comparison for the user's holding). */
export function chatTradeRequest(s: Snapshot, spec: ChatTradeSpec, q: LiveQuote, now = Date.now()): { post: ActionPost; payoff: Payoff | null } {
  const held = s.bsc.bstocks.filter((b) => b.symbol === `${spec.ticker}B` && b.qty > 0).reduce((a, b) => a + b.value, 0);
  const put = spec.kind === 'put' ? PUT.exec(spec.instrument) : null;
  const holding = held > 0 ? held : q.notionalUsd;
  const po = put ? payoff(spec.ticker, holding, { kind: 'put', contracts: spec.amount, strike: Number(put[3].replace('_', '.')), spot: q.index, premiumUsd: q.costUsd, feesUsd: r2(spec.amount * 0.5) })
    : spec.side === 'sell' ? payoff(spec.ticker, holding, { kind: 'perp', shortUsd: q.notionalUsd, feesUsd: 0 }) : null;
  const chosen = spec.venue === 'derive' ? (spec.kind === 'put' ? 'put' : null) : 'perp';
  const alts = held > 0 ? venueAlternatives(s, spec.ticker, chosen) : [];
  const verb = spec.side === 'buy' ? 'Buy' : 'Sell';
  const title = `${verb} ${spec.amount} ${spec.instrument} on ${spec.venue === 'derive' ? 'Derive' : 'Lighter'} (you asked in chat)`;
  const key = `act-chat-${createHash('sha256').update(`${s.wallet.toLowerCase()}|${s.network}|${spec.venue}|${spec.instrument}|${spec.side}|${spec.amount}|${Math.floor(now / 600_000)}`).digest('hex').slice(0, 20)}`;
  const post: ActionPost = {
    wallet: s.wallet, network: s.network, kind: 'hedge', venue: spec.venue, origin: 'chat', slot: `chat:${spec.venue}:${spec.instrument}`.slice(0, 60),
    title: title.slice(0, 160),
    why: `You asked for this in the chat. Live quote now: ${spec.side === 'buy' ? 'ask' : 'bid'} $${q.price}${spec.kind === 'put' ? `, premium about $${q.costUsd} plus fees` : `, notional about $${q.notionalUsd}`}. On approval the agent re-quotes it and refuses if the price is more than 25% worse, and your caps and kill switch still apply.`.slice(0, 800),
    helps: (spec.kind === 'put' ? `Caps your ${spec.ticker} loss below the strike and keeps the upside.` : spec.side === 'sell' ? `Offsets moves in your ${spec.ticker} 1:1.` : `Reduces or closes your ${spec.ticker} short.`).slice(0, 500),
    willDo: [`place a ${spec.venue === 'derive' ? 'Derive' : 'Lighter'} market order: ${verb.toLowerCase()} ${spec.amount} ${spec.instrument}`, 'check that the resulting position matches the order'],
    detail: { candidateId: `chat:${spec.instrument}`, kind: 'hedge', ruleKey: null, amountBaseUnit: '0', hedgeMarket: spec.ticker, hedgeKey: null, hedgeDelta: null, optionContracts: null, chatTrade: { ...spec, quotedPrice: q.price } },
    ...(po ? { payoff: po } : {}), ...(alts.length ? { alternatives: alts } : {}),
    idempotencyKey: key,
  };
  return { post, payoff: po };
}

/** On approval: the order may not have got more than 25% worse than the price the user saw. */
export function priceStillOk(spec: ChatTradeSpec, nowPrice: number): boolean {
  if (!(spec.quotedPrice > 0) || !(nowPrice > 0)) return false;
  return spec.side === 'buy' ? nowPrice <= spec.quotedPrice * 1.25 : nowPrice >= spec.quotedPrice * 0.75;
}
