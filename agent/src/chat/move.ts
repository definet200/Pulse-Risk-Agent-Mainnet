import { createHash } from 'node:crypto';
import type { ActionPost } from '../tools/appApi';
import type { SubaccountView } from '../tools/derive';
import type { Snapshot } from '../types';

// Margin the user asks to move between their own Derive subaccounts ("move 200 from my NVDA account to main"). Like a chat trade, the chat only
// posts a request; nothing moves until the user presses Approve, and on approval the live agent re-checks everything against fresh balances.

export interface ChatMoveSpec { venue: 'derive'; fromId: number; toId: number; fromLabel: string; toLabel: string; /** USDC, at most 2 decimals */ amountUsd: string }

export const MIN_MOVE_USD = 1;
export const usdcOf = (s: SubaccountView) => Number(s.collaterals.find((c) => c.asset_name === 'USDC')?.amount ?? 0);
/** Free margin: what is left after positions and open orders (Derive reports it as initial_margin). */
export const freeOf = (s: SubaccountView) => Number(s.initial_margin);
export const subLabel = (s: SubaccountView) => `${s.isFallback ? 'main account' : `${s.universeName ?? 'subaccount'} subaccount`} #${s.subaccount_id}`;
export const describeSubs = (subs: SubaccountView[]) => subs.map((s) => `${subLabel(s)}: ${usdcOf(s).toFixed(2)} USDC, ${Math.max(0, freeOf(s)).toFixed(2)} free${s.positions.length ? `, positions ${s.positions.map((p) => p.instrument_name).slice(0, 4).join(', ')}` : ', no positions'}`).join('; ');

/** What the user called an account -> one of their subaccounts: an id (#123456), "main", a universe name (RWA, PRIME...), or a ticker they hold there (NVDA). */
export function resolveSub(subs: SubaccountView[], ref: string): SubaccountView {
  const r = ref.trim().toUpperCase().replace(/^#/, '').replace(/^MY\s+/, '').replace(/\s*(SUB)?ACCOUNT$/, '').trim();
  const fail = (why: string): never => { throw new Error(`${why}. Your Derive subaccounts: ${describeSubs(subs)}`); };
  if (/^\d+$/.test(r)) return subs.find((s) => s.subaccount_id === Number(r)) ?? fail(`"${ref}" is not one of your Derive subaccounts`);
  if (['MAIN', 'DEFAULT', 'FALLBACK', 'MAIN ACCOUNT'].includes(r)) { const m = subs.filter((s) => s.isFallback); return m.length === 1 ? m[0] : fail('I could not tell which one is your main account'); }
  const byUniverse = subs.filter((s) => s.universeName?.toUpperCase() === r);
  if (byUniverse.length === 1) return byUniverse[0];
  if (byUniverse.length > 1) fail(`More than one subaccount is in the ${r} universe`);
  const byTicker = subs.filter((s) => s.positions.some((p) => p.instrument_name.toUpperCase().startsWith(`${r}-`)));
  if (byTicker.length === 1) return byTicker[0];
  if (byTicker.length > 1) fail(`${r} positions are in more than one subaccount`);
  return fail(`I could not match "${ref}" to a subaccount`);
}

/** Every reason this move cannot go ahead right now, in plain words. Empty = ok. Used when the request is made and again when it is approved. */
export function moveProblems(subs: SubaccountView[], spec: ChatMoveSpec, limits: { killSwitch: boolean; maxNotionalPerTradeUsd: number }): string[] {
  const out: string[] = []; const from = subs.find((s) => s.subaccount_id === spec.fromId); const to = subs.find((s) => s.subaccount_id === spec.toId); const amt = Number(spec.amountUsd);
  if (limits.killSwitch) out.push('the kill switch is on: no new orders or transfers');
  if (!from) out.push(`subaccount #${spec.fromId} is not yours`); if (!to) out.push(`subaccount #${spec.toId} is not yours`);
  if (spec.fromId === spec.toId) out.push('the source and destination are the same account');
  if (!/^\d+(\.\d{1,2})?$/.test(spec.amountUsd) || !(amt >= MIN_MOVE_USD)) out.push(`the amount must be at least ${MIN_MOVE_USD} USDC`);
  if (amt > limits.maxNotionalPerTradeUsd) out.push(`$${amt} is over your per-move cap of $${limits.maxNotionalPerTradeUsd}`);
  if (from) {
    if (from.is_under_liquidation) out.push(`${subLabel(from)} is being liquidated`);
    if (usdcOf(from) < amt) out.push(`${subLabel(from)} holds only ${usdcOf(from).toFixed(2)} USDC`);
    else if (freeOf(from) < amt) out.push(`only ${Math.max(0, freeOf(from)).toFixed(2)} USDC is free in ${subLabel(from)}; the rest backs its open positions`);
  }
  return out;
}

export function moveRequest(s: Snapshot, spec: ChatMoveSpec, now = Date.now()): ActionPost {
  const key = `act-move-${createHash('sha256').update(`${s.wallet.toLowerCase()}|${s.network}|${spec.fromId}|${spec.toId}|${spec.amountUsd}|${Math.floor(now / 600_000)}`).digest('hex').slice(0, 20)}`;
  return {
    wallet: s.wallet, network: s.network, kind: 'top_up', venue: 'derive', origin: 'chat', slot: `chat-move:derive:${spec.fromId}:${spec.toId}`.slice(0, 60),
    title: `Move $${spec.amountUsd} USDC margin on Derive: ${spec.fromLabel} to ${spec.toLabel} (you asked in chat)`.slice(0, 160),
    why: `You asked for this in the chat. It moves your own USDC between two of your own Derive subaccounts; nothing leaves Derive. On approval the agent re-reads both balances and refuses if the source no longer has this much free margin, if the kill switch is on, or if it is over your per-move cap.`.slice(0, 800),
    helps: `Gives ${spec.toLabel} more margin so it is further from liquidation, taken from ${spec.fromLabel}'s free margin.`.slice(0, 500),
    willDo: [`transfer exactly ${spec.amountUsd} USDC from ${spec.fromLabel} to ${spec.toLabel} on Derive (signed with your session key)`, 'check the transfer was accepted'],
    detail: { candidateId: `chat-move:${spec.fromId}:${spec.toId}`, kind: 'top_up', ruleKey: null, amountBaseUnit: '0', hedgeMarket: null, hedgeKey: null, hedgeDelta: null, optionContracts: null, chatMove: spec },
    idempotencyKey: key,
  };
}
