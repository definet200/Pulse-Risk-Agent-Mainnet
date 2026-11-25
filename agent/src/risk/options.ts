import type { Network } from '../types';

// Derive RWA options (spec: "Derive RWA option data the agent needs"). The agent buys PROTECTIVE PUTS on Derive: a put
// needs no monitoring and caps the loss, which is why the spec prefers it ahead of a binary gap such as earnings.
// The chain below is the data the agent needs per underlying. The REAL Derive reader is not wired yet (it returns
// null, so no put is ever offered from live data); tests and the sample mode supply a chain through setOptionsProvider.

export interface PutQuote { strike: number; bid: number; ask: number; iv: number; delta: number; /** contracts quoted at the ask */ size: number }
export interface OptionExpiry { expiry: string; puts: PutQuote[] }
export interface OptionChain {
  ticker: string;
  /** Underlying price used to pick the strike. */
  spot: number;
  expiries: OptionExpiry[];
  /** Fee per contract as a fraction of notional (trading plus settlement). */
  feeFraction: number;
  settlement: 'cash' | 'physical';
  /** Whether quotes stay live while the underlying is closed (spreads can widen then). */
  quotesOffHours: boolean;
  /** Contract size in units of the underlying. */
  contractSize: number;
}

export type OptionsProvider = (network: Network, ticker: string) => Promise<OptionChain | null>;

/** Live Derive reads are not wired yet: no chain means no put is offered. */
export const realOptions: OptionsProvider = async () => null;
let provider: OptionsProvider = realOptions;
export const setOptionsProvider = (p?: OptionsProvider) => { provider = p ?? realOptions; };
export const getChain: OptionsProvider = (n, t) => provider(n, t);

export interface PutPick {
  expiry: string; strike: number; ask: number; spreadPct: number; iv: number; delta: number;
  contracts: number; /** Contracts quoted at the ask (the chain depth). */ quotedSize: number; notionalUsd: number; premiumUsd: number; feesUsd: number; costFraction: number; daysToExpiry: number;
}

/**
 * Pick the cheapest listed put that covers the whole risk window: the first expiry on or after `coverUntil`, strike
 * nearest the spot (at the money). Sized to `notionalUsd` of the underlying, limited by the quoted size.
 * Returns null when nothing lists, the quote is stale (no ask), or the book is too thin.
 */
export function pickPut(chain: OptionChain, notionalUsd: number, coverUntil: Date, now = new Date(), lot = 0.01): PutPick | null {
  if (!(chain.spot > 0) || !(notionalUsd > 0)) return null;
  const ex = chain.expiries.filter((e) => Date.parse(e.expiry) >= coverUntil.getTime()).sort((a, b) => Date.parse(a.expiry) - Date.parse(b.expiry))[0];
  if (!ex) return null;
  const q = ex.puts.filter((p) => p.ask > 0 && p.size > 0).sort((a, b) => Math.abs(a.strike - chain.spot) - Math.abs(b.strike - chain.spot))[0];
  if (!q) return null;
  const wantContracts = notionalUsd / (chain.spot * chain.contractSize);
  const contracts = Math.floor(Math.min(wantContracts, q.size) / lot + 1e-9) * lot;   // whole lots only (Derive puts trade in whole contracts)
  if (contracts <= 0) return null;
  const notional = contracts * chain.spot * chain.contractSize;
  const premium = contracts * q.ask * chain.contractSize;
  const fees = notional * chain.feeFraction;
  return {
    expiry: ex.expiry, strike: q.strike, ask: q.ask, spreadPct: q.ask > 0 ? Math.round(((q.ask - q.bid) / q.ask) * 10_000) / 100 : 0, iv: q.iv, delta: q.delta,
    contracts, quotedSize: q.size, notionalUsd: Math.round(notional * 100) / 100, premiumUsd: Math.round(premium * 100) / 100, feesUsd: Math.round(fees * 100) / 100,
    costFraction: premium / notional, daysToExpiry: Math.round(((Date.parse(ex.expiry) - now.getTime()) / 86_400_000) * 10) / 10,
  };
}

/** Test data for the sample mode: a plausible 1-week and 2-week put grid priced with 0.4 x sigma x sqrt(T) at the money. */
export function sampleChain(ticker: string, spot: number, annualVol: number, now = new Date(), depth = 50): OptionChain {
  const mk = (days: number): OptionExpiry => {
    const T = days / 365; const atm = 0.4 * annualVol * Math.sqrt(T) * spot;
    const strikes = [0.9, 0.95, 1, 1.05].map((m) => Math.round(spot * m));
    return { expiry: new Date(now.getTime() + days * 86_400_000).toISOString(), puts: strikes.map((k) => {
      const intrinsic = Math.max(0, k - spot); const otm = Math.max(0, spot - k);
      const mid = Math.max(0.05 * atm, atm * Math.exp(-3 * (otm / spot) / Math.max(0.05, annualVol * Math.sqrt(T))) + intrinsic);
      return { strike: k, bid: Math.round(mid * 0.96 * 100) / 100, ask: Math.round(mid * 1.04 * 100) / 100, iv: annualVol, delta: -Math.round(Math.min(0.95, 0.5 + (k - spot) / (2 * spot * annualVol * Math.sqrt(T))) * 100) / 100, size: depth };
    }) };
  };
  return { ticker, spot, expiries: [mk(7), mk(14)], feeFraction: 0.0003, settlement: 'cash', quotesOffHours: true, contractSize: 1 };
}
