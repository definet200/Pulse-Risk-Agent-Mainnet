import { LIGHTER, LIGHTER_USDC_ASSET } from '../../../lib/venues';
import { scaleDecimal } from '../../../lib/decimal';
import type { AccountHealth } from '../../../lib/risk-rules';
import { config } from '../config';
import type { Network } from '../types';
import type { LighterCreds } from './appApi';
import { loadSigner } from './lighterSigner';

// Lighter tools. Reads are plain REST. Writes sign with the user's agent key (fetched per tick, never stored)
// and are only reachable when config().live is true.

interface Resp { code?: number; message?: string }

export async function lighterGet<T>(n: Network, p: string, params: Record<string, string | number> = {}): Promise<T & Resp> {
  const u = new URL(`${LIGHTER[n].rest}/api/v1/${p}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
  const text = await r.text();
  let j: T & Resp;
  try { j = JSON.parse(text) as T & Resp; } catch { throw new Error(`Lighter ${n} API unavailable (HTTP ${r.status})`); }
  if (!r.ok && typeof j.code !== 'number') throw new Error(`lighter ${p} HTTP ${r.status}: ${j.message ?? ''}`);
  return j;
}

export interface LighterPosition { market_id: number; symbol: string; sign: number; position: string; position_value?: string }
export interface LighterAccount { index: number; collateral: string; available_balance: string; total_asset_value: string; positions: LighterPosition[] }

/** null = account not found (code 21100). Throws if the API itself is down. */
export async function getAccount(n: Network, index: number): Promise<LighterAccount | null> {
  const j = await lighterGet<{ accounts?: LighterAccount[] }>(n, 'account', { by: 'index', value: index });
  if (j.code === 21100) return null;
  return j.accounts?.[0] ?? null;
}

/** Health as planRule expects it: util = (equity − available) / equity, in bps. */
export function healthOf(a: LighterAccount | null): AccountHealth {
  if (!a) return { connected: false, utilBps: null, accountUsd: null, usedUsd: null };
  const equity = Number(a.total_asset_value); const avail = Number(a.available_balance);
  if (!Number.isFinite(equity) || !Number.isFinite(avail) || equity <= 0) return { connected: true, utilBps: equity === 0 ? 0 : null, accountUsd: Number.isFinite(equity) ? equity : null, usedUsd: 0 };
  const used = Math.max(0, equity - avail);
  return { connected: true, utilBps: Math.round((used / equity) * 10_000), accountUsd: equity, usedUsd: used };
}

/** Signed position size per market (negative = short). */
export function positionsOf(a: LighterAccount | null): Record<number, number> {
  const out: Record<number, number> = {};
  for (const p of a?.positions ?? []) { const v = Number(p.position) * (p.sign < 0 ? -1 : 1); if (v) out[p.market_id] = v; }
  return out;
}

export interface LighterMarket { market_id: number; symbol: string; size_decimals: number; price_decimals: number; min_base_amount: string; last_trade_price: number }
export async function getMarket(n: Network, marketId: number): Promise<LighterMarket> {
  const j = await lighterGet<{ order_book_details?: LighterMarket[] }>(n, 'orderBookDetails', { market_id: marketId });
  const m = j.order_book_details?.[0];
  if (!m) throw new Error(`unknown Lighter market ${marketId}`);
  return m;
}

export async function getNonce(n: Network, acct: number, keyIdx: number): Promise<number> {
  const j = await lighterGet<{ nonce: number }>(n, 'nextNonce', { account_index: acct, api_key_index: keyIdx });
  if (typeof j.nonce !== 'number') throw new Error(`lighter nextNonce: ${j.message ?? 'no nonce'}`);
  return j.nonce;
}

async function sendTx(n: Network, txType: number, txInfo: string): Promise<string> {
  const body = new URLSearchParams({ tx_type: String(txType), tx_info: txInfo, price_protection: 'true' });
  const r = await fetch(`${LIGHTER[n].rest}/api/v1/sendTx`, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
  const j = (await r.json().catch(() => ({}))) as { code?: number; message?: string; tx_hash?: string };
  if (!r.ok || j.code !== 200 || !j.tx_hash) throw new Error(`lighter sendTx rejected: ${j.code ?? r.status} ${j.message ?? ''}`.trim());
  return j.tx_hash;
}

export async function getTx(n: Network, hash: string): Promise<{ status?: number } & Resp> {
  return lighterGet(n, 'tx', { by: 'hash', value: hash });
}

async function client(n: Network, c: LighterCreds, acct: number) {
  if (!config().live) throw new Error('Lighter write called while not live');
  const s = await loadSigner();
  const r = s.CreateClient('', c.apiPrivateKey, LIGHTER[n].chainId, c.apiKeyIndex, acct);
  if (r.error) throw new Error(`lighter CreateClient: ${r.error}`);
  return s;
}

export interface OrderReq { marketId: number; side: 'buy' | 'sell'; size: string; worstPrice: string; reduceOnly: boolean }

/** Market IOC order from `acct`. size/price are decimal strings; scaled with the market's own decimals. */
export async function placeMarketOrder(n: Network, c: LighterCreds, acct: number, o: OrderReq): Promise<{ txHash: string }> {
  const m = await getMarket(n, o.marketId);
  const base = scaleDecimal(o.size, m.size_decimals); const price = scaleDecimal(o.worstPrice, m.price_decimals);
  if (base <= 0n) throw new Error('size rounds to zero for this market');
  if (base < scaleDecimal(m.min_base_amount, m.size_decimals)) throw new Error(`size below market minimum ${m.min_base_amount}`);
  if (price <= 0n || price > 0xffffffffn) throw new Error('price out of range');
  const s = await client(n, c, acct);
  const nonce = await getNonce(n, acct, c.apiKeyIndex);
  const tx = s.SignCreateOrder(o.marketId, Date.now() % 2 ** 47, Number(base), Number(price), o.side === 'sell' ? 1 : 0, 1, 0, o.reduceOnly ? 1 : 0, 0, 0, 0, 0, 0, 0, 0, 0, nonce, c.apiKeyIndex, acct);
  if (tx.error || !tx.txInfo || tx.txType === undefined) throw new Error(`SignCreateOrder: ${tx.error ?? 'empty'}`);
  return { txHash: await sendTx(n, tx.txType, tx.txInfo) };
}

/** Same-owner main ↔ sub-account transfer. Caller must have verified `to` belongs to the user. */
export async function transferToOwnAccount(n: Network, c: LighterCreds, from: number, to: number, amountBase: string): Promise<{ txHash: string }> {
  if (from === to) throw new Error('source and destination are the same');
  if (BigInt(amountBase) < 1_000_000n) throw new Error('Lighter transfers are at least 1 USDC');
  const s = await client(n, c, from);
  const nonce = await getNonce(n, from, c.apiKeyIndex);
  const tx = s.SignTransfer(to, LIGHTER_USDC_ASSET, 0, 0, Number(amountBase), 0, `0x${'00'.repeat(32)}`, 0, nonce, c.apiKeyIndex, from);
  if (tx.error || !tx.txInfo || tx.txType === undefined) throw new Error(`SignTransfer: ${tx.error ?? 'empty'}`);
  return { txHash: await sendTx(n, tx.txType, tx.txInfo) };
}

/** Secure withdraw to the owner's own Ethereum address (~26 min). Max 3 per 2 h per user. */
export async function withdrawToOwner(n: Network, c: LighterCreds, acct: number, amountBase: string): Promise<{ txHash: string }> {
  const s = await client(n, c, acct);
  const nonce = await getNonce(n, acct, c.apiKeyIndex);
  const tx = s.SignWithdraw(LIGHTER_USDC_ASSET, 0, Number(amountBase), 0, nonce, c.apiKeyIndex, acct);
  if (tx.error || !tx.txInfo || tx.txType === undefined) throw new Error(`SignWithdraw: ${tx.error ?? 'empty'}`);
  return { txHash: await sendTx(n, tx.txType, tx.txInfo) };
}
