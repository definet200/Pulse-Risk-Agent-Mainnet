import { LIGHTER } from '../../../lib/venues';
import { config } from '../config';
import type { Network } from '../types';
import { medianLatency } from './store';

/**
 * Realised 1h volatility of a Lighter market: standard deviation of 1-minute log returns over the last hour,
 * scaled by sqrt(60). Returned as a fraction (0.041 = 4.1%). null if there is not enough data (fail closed).
 */
export function realizedVol1h(closes: number[]): number | null {
  if (closes.length < 20) return null;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0 && closes[i] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < 19) return null;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance) * Math.sqrt(60);
}

export async function fetchCloses(n: Network, marketId: number, minutes = 61, now = Date.now()): Promise<number[]> {
  const end = Math.floor(now / 1000); const start = end - minutes * 60;
  const u = new URL(`${LIGHTER[n].rest}/api/v1/candles`);
  for (const [k, v] of Object.entries({ market_id: marketId, resolution: '1m', start_timestamp: start, end_timestamp: end, count_back: minutes })) u.searchParams.set(k, String(v));
  const res = await fetch(u, { signal: AbortSignal.timeout(10_000) });
  const j = (await res.json().catch(() => ({}))) as { c?: { t: number; c: number }[] };
  if (!res.ok || !j.c) throw new Error(`Lighter candles unavailable (HTTP ${res.status})`);
  return j.c.sort((a, b) => a.t - b.t).map((x) => x.c);
}

export const vol1h = async (n: Network, marketId: number): Promise<number | null> => realizedVol1h(await fetchCloses(n, marketId));

/** Seconds a top-up takes to land: the agent's own measured median, else the configured default. */
export function topUpLatencySec(venue: string): { sec: number; measured: boolean } {
  const m = medianLatency(venue);
  return m === null ? { sec: config().DEFAULT_LATENCY_SEC, measured: false } : { sec: m, measured: true };
}

/** Hourly closes for the last `hours` hours (Lighter candles, seconds timestamps). */
export async function fetchHourlyCloses(n: Network, marketId: number, hours = 168, now = Date.now()): Promise<number[]> {
  const end = Math.floor(now / 1000); const start = end - hours * 3600;
  const u = new URL(`${LIGHTER[n].rest}/api/v1/candles`);
  for (const [k, v] of Object.entries({ market_id: marketId, resolution: '1h', start_timestamp: start, end_timestamp: end, count_back: hours })) u.searchParams.set(k, String(v));
  const res = await fetch(u, { signal: AbortSignal.timeout(10_000) });
  const j = (await res.json().catch(() => ({}))) as { c?: { t: number; c: number }[] };
  if (!res.ok || !j.c) throw new Error(`Lighter candles unavailable (HTTP ${res.status})`);
  return j.c.sort((a, b) => a.t - b.t).map((x) => x.c);
}

/**
 * Daily volatility from hourly closes: standard deviation of hourly log returns x sqrt(24).
 * Needs at least 48 hourly closes (two days) or it returns null so the agent fails closed.
 */
export function sigmaDayFromHourly(closes: number[]): number | null {
  if (closes.length < 48) return null;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0 && closes[i] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < 47) return null;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  const s = Math.sqrt(variance) * Math.sqrt(24);
  return Number.isFinite(s) && s > 0 ? s : null;
}
