import type { Network } from '../types';
import { fetchHourlyCloses } from '../tools/metrics';

// Proxy hedges: a holding is also hedgeable through a related Lighter market (MSTR through BTC, SPY through US500,
// a tech stock through US100). The hedge strength is MEASURED, never assumed: the correlation of hourly returns
// over the last 7 days between the holding's own Lighter market and the proxy. The planner sizes a proxy short as
// correlation x (holding volatility / proxy volatility) and reports the share of risk a proxy leaves (sqrt(1 - rho^2)).

/** Candidate proxies per underlying, best first. Any ticker not listed is tried against US500 then US100. */
export const PROXY_CANDIDATES: Record<string, string[]> = {
  MSTR: ['BTC'], COIN: ['BTC'], HOOD: ['BTC', 'US100'], CRCL: ['BTC', 'US100'],
  SPY: ['US500'], QQQ: ['US100'],
  NVDA: ['US100'], AAPL: ['US100'], GOOGL: ['US100'], META: ['US100'], AMZN: ['US100'], TSLA: ['US100'], NFLX: ['US100'],
  MU: ['US100'], AMD: ['US100'], INTC: ['US100'], TSM: ['US100'], SKHY: ['US100'], SNDK: ['US100'], ORCL: ['US100'], SOXL: ['US100'], DRAM: ['US100'],
};
const FALLBACK = ['US500', 'US100'];
/** Below this correlation a proxy removes too little risk to be worth the fees and margin. */
export const MIN_PROXY_CORRELATION = 0.3;
/** Never trust a measured correlation above this: 7 days of hourly data overstates how tight a relation stays. */
export const MAX_PROXY_CORRELATION = 0.95;

export const candidatesFor = (ticker: string): string[] => (PROXY_CANDIDATES[ticker] ?? FALLBACK).filter((v) => v !== ticker);

/** Pearson correlation of hourly log returns, aligned from the most recent close backwards. null below 48 pairs. */
export function returnCorrelation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length); if (n < 49) return null;
  const ra: number[] = []; const rb: number[] = [];
  const A = a.slice(-n); const B = b.slice(-n);
  for (let i = 1; i < n; i++) if (A[i - 1] > 0 && A[i] > 0 && B[i - 1] > 0 && B[i] > 0) { ra.push(Math.log(A[i] / A[i - 1])); rb.push(Math.log(B[i] / B[i - 1])); }
  if (ra.length < 48) return null;
  const ma = ra.reduce((x, y) => x + y, 0) / ra.length; const mb = rb.reduce((x, y) => x + y, 0) / rb.length;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < ra.length; i++) { const da = ra[i] - ma; const db = rb[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  if (saa <= 0 || sbb <= 0) return null;
  const r = sab / Math.sqrt(saa * sbb);
  return Number.isFinite(r) ? r : null;
}

export interface ProxyPick { via: string; viaMarketId: number; beta: number; price: number }
export type ClosesFn = (n: Network, marketId: number) => Promise<number[]>;

const cache = new Map<string, { at: number; pick: ProxyPick | null }>();
const TTL_MS = 10 * 60_000;
export const clearProxyCache = () => cache.clear();

/**
 * The best measured proxy for `ticker` among its candidates that Lighter lists. `marketIds` maps symbol → Lighter
 * market id. Returns null when the holding has no Lighter market to measure against, or no candidate correlates
 * at least MIN_PROXY_CORRELATION.
 */
export async function pickProxy(n: Network, ticker: string, marketIds: Record<string, number>, closes: ClosesFn = fetchHourlyCloses, now = Date.now()): Promise<ProxyPick | null> {
  const own = marketIds[ticker]; if (own === undefined) return null;
  const k = `${n}:${ticker}`; const hit = cache.get(k); if (hit && now - hit.at < TTL_MS) return hit.pick;
  const ownCloses = await closes(n, own);
  let best: ProxyPick | null = null;
  for (const via of candidatesFor(ticker)) {
    const id = marketIds[via]; if (id === undefined) continue;
    const vc = await closes(n, id).catch(() => [] as number[]);
    const rho = returnCorrelation(ownCloses, vc);
    if (rho === null || rho < MIN_PROXY_CORRELATION) continue;
    const beta = Math.round(Math.min(rho, MAX_PROXY_CORRELATION) * 100) / 100;
    if (!best || beta > best.beta) best = { via, viaMarketId: id, beta, price: vc[vc.length - 1] };
  }
  cache.set(k, { at: now, pick: best });
  return best;
}
