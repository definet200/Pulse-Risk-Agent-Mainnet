import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config';

// Lighter venue module is mocked entirely: no signer, no network.
const calls: string[] = [];
let accounts: Record<number, { available_balance: string }>;
let masterAfterTransfer: string | null;

vi.mock('../src/tools/lighter', () => ({
  getAccount: async (_n: string, i: number) => accounts[i] ?? null,
  lighterGet: async (_n: string, p: string) => { calls.push(`get:${p}`); return { code: 200, accounts: [{ index: 7, l1_address: '0x2222222222222222222222222222222222222222' }], withdraws: [
    { amount: '5', status: 'pending', timestamp: 1_700_000_000 }, { amount: '6', status: 'claimable', timestamp: 1_700_000_100_000, l1_tx_hash: '0xaa' },
    { amount: '7', status: 'completed', timestamp: 1_600_000_000 }, { amount: '8', status: 'refunded', timestamp: 1_500_000_000 }] }; },
  transferToOwnAccount: async (_n: string, _c: unknown, from: number, to: number, amt: string) => { calls.push(`transfer:${from}->${to}:${amt}`); if (masterAfterTransfer) accounts[to] = { available_balance: masterAfterTransfer }; return { txHash: '0xt' }; },
  withdrawToOwner: async (_n: string, _c: unknown, acct: number, amt: string) => { calls.push(`withdraw:${acct}:${amt}`); return { txHash: '0xw' }; },
}));
vi.mock('../src/tools/lighterSigner', () => ({
  loadSigner: async () => ({ CreateClient: () => ({}), CreateAuthToken: () => ({ authToken: 'tok' }) }),
}));

import { lighterWithdrawals, withdrawFromLighter } from '../src/tools/lighterWithdraw';

const creds = { accountIndex: 7, apiKeyIndex: 4, apiPrivateKey: 'x' };
const fast = { sleep: async () => {}, pollAttempts: 3 };

beforeEach(() => {
  calls.length = 0; masterAfterTransfer = null;
  accounts = { 7: { available_balance: '20' }, 8: { available_balance: '30' } };
  resetConfigForTests(loadConfig({ DRY_RUN: 'false', ALLOW_LIVE: 'yes-i-understand' }));
});
afterEach(() => resetConfigForTests(loadConfig({})));

describe('withdrawFromLighter', () => {
  it('withdraws from the master directly', async () => {
    const r = await withdrawFromLighter('mainnet', creds, 7, '10000000', fast);
    expect(calls).toEqual(['withdraw:7:10000000']);
    expect(r).toMatchObject({ txHash: '0xw', master: 7 });
    expect(r.transferTxHash).toBeUndefined();
  });
  it('sub-account: transfers to the master FIRST, then withdraws from the master', async () => {
    masterAfterTransfer = '30';
    const r = await withdrawFromLighter('mainnet', creds, 8, '10000000', fast);
    expect(calls).toEqual(['transfer:8->7:10000000', 'withdraw:7:10000000']);
    expect(r.transferTxHash).toBe('0xt');
  });
  it('sub-account: does not withdraw if the master never received the transfer', async () => {
    await expect(withdrawFromLighter('mainnet', creds, 8, '10000000', fast)).rejects.toThrow(/do not transfer again/);
    expect(calls).toEqual(['transfer:8->7:10000000']);
  });
  it('refuses below 1 USDC, above available_balance, and a missing account', async () => {
    await expect(withdrawFromLighter('mainnet', creds, 7, '999999', fast)).rejects.toThrow(/at least 1 USDC/);
    await expect(withdrawFromLighter('mainnet', creds, 7, '20000001', fast)).rejects.toThrow(/available/);
    await expect(withdrawFromLighter('mainnet', creds, 99, '5000000', fast)).rejects.toThrow(/not found/);
    await expect(withdrawFromLighter('mainnet', creds, 7, '1.5', fast)).rejects.toThrow(/integer/);
    expect(calls).toEqual([]);
  });
  it('throws when not live', async () => {
    resetConfigForTests(loadConfig({}));
    await expect(withdrawFromLighter('mainnet', creds, 7, '5000000', fast)).rejects.toThrow('called while not live');
    expect(calls).toEqual([]);
  });
});

describe('lighterWithdrawals', () => {
  it('normalises status and timestamps, newest first, and works while not live', async () => {
    resetConfigForTests(loadConfig({}));
    const w = await lighterWithdrawals('mainnet', '0x2222222222222222222222222222222222222222', creds);
    expect(w.map((x) => x.status)).toEqual(['claimable', 'pending', 'completed', 'failed']);
    expect(w[0].timestamp).toBe(1_700_000_100_000);
    expect(w[1].timestamp).toBe(1_700_000_000_000);
  });
  it('refuses an account that belongs to another wallet', async () => {
    await expect(lighterWithdrawals('mainnet', '0x3333333333333333333333333333333333333333', creds)).rejects.toThrow(/does not belong/);
  });
});
