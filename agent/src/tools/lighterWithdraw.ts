import { getAddress } from 'viem';
import { scaleDecimal } from '../../../lib/decimal';
import { config } from '../config';
import type { Network } from '../types';
import type { LighterCreds } from './appApi';
import { getAccount, lighterGet, transferToOwnAccount, withdrawToOwner } from './lighter';
import { loadSigner } from './lighterSigner';

// Release leg for Lighter (ported from withdrawLighter / lighterWithdrawals in lib/server/lighter.ts).
// SignWithdraw has no destination field: Lighter can only pay the account's L1 owner, on Ethereum (~26 min).
// Only the MASTER can withdraw, so a sub-account first moves its funds to the master (same owner).

/** Lighter's own floor for a USDC withdrawal. */
export const LIGHTER_WITHDRAW_MIN_BASE = 1_000_000n;

export interface LighterWithdrawResult { txHash: string; transferTxHash?: string; master: number; amountBase: string }
export interface WithdrawDeps { sleep?: (ms: number) => Promise<void>; pollAttempts?: number; pollMs?: number }

const availBase = (a: { available_balance: string } | null): bigint => (a ? scaleDecimal(a.available_balance, 6) : 0n);

/**
 * `creds.accountIndex` is the master. `accountIndexOrSub` is the account the funds sit in (master or one of its subs).
 * Never more than the source's available_balance; minimum 1 USDC. amountBase = USDC base units (6 dp), integer string.
 */
export async function withdrawFromLighter(n: Network, creds: LighterCreds, accountIndexOrSub: number, amountBase: string, deps: WithdrawDeps = {}): Promise<LighterWithdrawResult> {
  if (!config().live) throw new Error('Lighter withdraw called while not live');
  if (!/^\d+$/.test(amountBase)) throw new Error('amount must be an integer base-unit string');
  const amount = BigInt(amountBase);
  if (amount < LIGHTER_WITHDRAW_MIN_BASE) throw new Error('Lighter withdrawals are at least 1 USDC');
  const master = creds.accountIndex;

  const src = await getAccount(n, accountIndexOrSub);
  if (!src) throw new Error(`Lighter account ${accountIndexOrSub} not found`);
  if (availBase(src) < amount) throw new Error(`Only ${src.available_balance} USDC is available in Lighter account ${accountIndexOrSub}`);

  let transferTxHash: string | undefined;
  if (accountIndexOrSub !== master) {
    // Sub-account: move to the master first, then wait until the master can actually cover the withdrawal.
    const before = availBase(await getAccount(n, master));
    transferTxHash = (await transferToOwnAccount(n, creds, accountIndexOrSub, master, amountBase)).txHash;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let ok = false;
    for (let i = 0; i < (deps.pollAttempts ?? 20); i++) {
      if (availBase(await getAccount(n, master)) >= before + amount) { ok = true; break; }
      await sleep(deps.pollMs ?? 3_000);
    }
    if (!ok) throw new Error(`transfer ${transferTxHash} sent but the master has not received it yet; retry the withdraw later (do not transfer again)`);
  }

  const { txHash } = await withdrawToOwner(n, creds, master, amountBase);
  return { txHash, transferTxHash, master, amountBase };
}

export interface LighterWithdrawal { amount: string; status: 'pending' | 'claimable' | 'completed' | 'failed'; rawStatus: string; timestamp: number; l1TxHash: string | null; claimTxHash: string | null }

/** The master's withdrawals, newest first. Needs the agent key (auth token). `l1Address` must own the master account. */
export async function lighterWithdrawals(n: Network, l1Address: string, creds: LighterCreds): Promise<LighterWithdrawal[]> {
  const owner = await lighterGet<{ accounts?: { index: number; l1_address?: string }[] }>(n, 'account', { by: 'index', value: creds.accountIndex });
  const acct = owner.accounts?.[0];
  if (!acct) throw new Error(`Lighter account ${creds.accountIndex} not found`);
  if (acct.l1_address && getAddress(acct.l1_address) !== getAddress(l1Address)) throw new Error('Lighter account does not belong to this wallet');
  const s = await loadSigner();
  const c = s.CreateClient('', creds.apiPrivateKey, n === 'mainnet' ? 304 : 300, creds.apiKeyIndex, creds.accountIndex);
  if (c.error) throw new Error(`lighter CreateClient: ${c.error}`);
  const t = s.CreateAuthToken(Math.floor(Date.now() / 1000) + 600, creds.apiKeyIndex, creds.accountIndex);
  if (t.error || !t.authToken) throw new Error(`lighter CreateAuthToken: ${t.error ?? 'empty'}`);
  const j = await lighterGet<{ withdraws?: { amount: string; status: string; timestamp: number; l1_tx_hash?: string; l1_claim_tx_hash?: string }[] }>(
    n, 'withdraw/history', { account_index: creds.accountIndex, filter: 'all', auth: t.authToken });
  if (typeof j.code === 'number' && j.code !== 200 && !j.withdraws) throw new Error(`lighter withdraw/history: ${j.message ?? j.code}`);
  return (j.withdraws ?? []).map((w) => ({
    amount: w.amount, rawStatus: w.status,
    status: w.status === 'completed' ? 'completed' as const : w.status === 'claimable' ? 'claimable' as const : w.status === 'failed' || w.status === 'refunded' ? 'failed' as const : 'pending' as const,
    // Timestamps are ms on some routes and s on others; normalise to ms.
    timestamp: w.timestamp < 1e12 ? w.timestamp * 1000 : w.timestamp, l1TxHash: w.l1_tx_hash || null, claimTxHash: w.l1_claim_tx_hash || null,
  })).sort((a, b) => b.timestamp - a.timestamp);
}
