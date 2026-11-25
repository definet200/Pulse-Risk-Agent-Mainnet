import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Live-path test with every venue call mocked: a bStock is pulled from the user, sold for USDC on PancakeSwap,
// and the proceeds are bridged once. A failed step stops the move. Nothing touches a network.

const calls: string[] = [];
let sellFails = false;
let bridgeFails = false;
let relayStatus: 'success' | 'refund' = 'success';
let bridgedWei = 0n;

vi.mock('../src/tools/bsc', async () => {
  const real = await vi.importActual<typeof import('../src/tools/bsc')>('../src/tools/bsc');
  return {
    ...real,
    agentAddress: () => '0x00000000000000000000000000000000000000aa',
    rawForUi: async (_s: string, q: number) => BigInt(Math.floor(q * 1e8)) * 10n ** 10n,
    pullUsdc: async () => { calls.push('pullUsdc'); return { txHash: '0xpull' }; },
    pullBstock: async (sym: string) => { calls.push(`pullBstock:${sym}`); return { txHash: '0xpullb' }; },
  };
});
vi.mock('../src/tools/pancake', async () => {
  const real = await vi.importActual<typeof import('../src/tools/pancake')>('../src/tools/pancake');
  return {
    ...real,
    sellBstockForUsdc: async (sym: string) => { if (sellFails) throw new Error('sale reverted'); calls.push(`sell:${sym}`); return { txHash: '0xsell', usdcOutWei: 82n * 10n ** 18n }; },
  };
});
vi.mock('../src/tools/relay', () => ({
  getQuote: async () => { if (bridgeFails) throw new Error('Relay: no route'); return {}; },
  validateQuote: (_q: unknown, req: { amountWei: bigint }) => { bridgedWei = req.amountWei; return { requestId: 'req1', steps: [], amountOut: '0', minOut: '0', feeUsd: '0' }; },
  executeSteps: async () => { calls.push('bridge'); return { txHashes: [] }; },
  getStatus: async () => relayStatus,
}));
vi.mock('../src/tools/appApi', async () => {
  const real = await vi.importActual<typeof import('../src/tools/appApi')>('../src/tools/appApi');
  return { ...real, getLighterCreds: async () => ({ accountIndex: 7, apiKeyIndex: 4, apiPrivateKey: 'x' }), getDeriveCreds: async () => { throw new Error('unused'); } };
});

import { loadConfig, resetConfigForTests } from '../src/config';
import { fixtureSnapshot } from '../src/fixtures';
import { execute } from '../src/tools/executor';
import { buildCandidates } from '../src/tools/planner';
import { closeStore, openStore } from '../src/tools/store';

const snap = () => {
  const s = fixtureSnapshot({ bsc: { usdcUsd: 0, usdtUsd: 0, bstocks: [{ symbol: 'SPYB', qty: 1, value: 500, allowanceQty: 1 }], allowanceUsdcBase: '0' } });
  s.config.rebalance.sources = ['sell_bstocks']; s.config.rebalance.sellOrder = ['SPYB'];
  return s;
};

beforeEach(() => {
  openStore(':memory:'); calls.length = 0; sellFails = false; bridgeFails = false; relayStatus = 'success'; bridgedWei = 0n;
  resetConfigForTests(loadConfig({ DRY_RUN: 'false', ALLOW_LIVE: 'yes-i-understand', POST_EVENTS: 'false', LLM_MODE: 'off' }));
});
afterEach(() => { closeStore(); resetConfigForTests(); });

describe('sell then bridge (live path, mocked venues)', () => {
  it('pulls the bStock, sells it, and bridges the USDC it raised', async () => {
    const s = snap(); const c = buildCandidates(s).candidates[0];
    const steps = await execute(s, c);
    expect(steps.every((x) => x.status === 'done')).toBe(true);
    expect(calls).toEqual(['pullBstock:SPYB', 'sell:SPYB', 'bridge']);
    expect(bridgedWei).toBe(82n * 10n ** 18n);
  });

  it('a failed sale stops the move: nothing is bridged', async () => {
    sellFails = true;
    const s = snap(); const c = buildCandidates(s).candidates[0];
    const steps = await execute(s, c);
    expect(steps.some((x) => /^Sell SPYB/.test(x.step) && x.status === 'failed')).toBe(true);
    expect(calls).not.toContain('bridge');
  });

  it('a failed bridge is reported and there is no rollback of the sale', async () => {
    bridgeFails = true;
    const s = snap(); const c = buildCandidates(s).candidates[0];
    const steps = await execute(s, c);
    expect(steps.some((x) => x.step === 'Bridge via Relay' && x.status === 'failed')).toBe(true);
    expect(calls).toEqual(['pullBstock:SPYB', 'sell:SPYB']);
  });

  it('a rerun after a crash resumes instead of selling twice', async () => {
    const s = snap(); const c = buildCandidates(s).candidates[0];
    await execute(s, c); await execute(s, c);
    expect(calls.filter((x) => x === 'sell:SPYB')).toHaveLength(1);
    expect(calls.filter((x) => x === 'pullBstock:SPYB')).toHaveLength(1);
  });

  it('a Relay refund marks the move failed and nothing is retried', async () => {
    relayStatus = 'refund';
    const s = snap(); const c = buildCandidates(s).candidates[0];
    const steps = await execute(s, c);
    expect(steps.find((x) => x.status === 'failed')?.detail).toMatch(/Relay refund/);
    expect(calls.filter((x) => x === 'bridge')).toHaveLength(1);
  });
});
