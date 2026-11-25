import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type AgentConfig } from '../../lib/agent-config';
import { clearOptionNames, makeDeriveOptions } from '../src/risk/options';
import { candidatesFor, clearProxyCache, pickProxy, returnCorrelation } from '../src/risk/proxy';
import { clearMarketCache } from '../src/risk/market';
import { assessRisk } from '../src/risk/plan';
import { collectSnapshot, type CollectDeps } from '../src/tools/collect';
import { closeStore, openStore } from '../src/tools/store';

// A deterministic price walk: closes from a sequence of returns.
const walk = (rets: number[], p0 = 100) => rets.reduce((a, r) => [...a, a[a.length - 1] * Math.exp(r)], [p0]);
const noise = (seed: number, n: number) => Array.from({ length: n }, (_, i) => Math.sin(seed * 12.9898 + i * 78.233) * 0.01);

describe('returnCorrelation', () => {
  const base = noise(1, 100);
  it('identical moves correlate 1, opposite moves -1', () => {
    expect(returnCorrelation(walk(base), walk(base))).toBeCloseTo(1, 6);
    expect(returnCorrelation(walk(base), walk(base.map((r) => -r)))).toBeCloseTo(-1, 6);
  });
  it('needs at least 48 hourly returns', () => {
    expect(returnCorrelation(walk(base.slice(0, 30)), walk(base.slice(0, 30)))).toBeNull();
  });
});

describe('pickProxy: measured, never assumed', () => {
  beforeEach(() => clearProxyCache());
  const ids = { MSTR: 122, BTC: 1, US500: 180, US100: 181, SPY: 128 };
  const btc = noise(2, 100); const other = noise(3, 100);
  // MSTR = 0.8 x BTC moves + independent noise.
  const mstr = btc.map((r, i) => 0.8 * r + 0.4 * other[i]);
  const closes = async (_n: string, id: number) => (id === 122 ? walk(mstr) : id === 1 ? walk(btc, 90_000) : walk(other));

  it('MSTR proxies through BTC with its measured correlation and the latest BTC price', async () => {
    const p = await pickProxy('mainnet', 'MSTR', ids, closes as never);
    expect(p?.via).toBe('BTC'); expect(p?.viaMarketId).toBe(1);
    expect(p!.beta).toBeGreaterThan(0.8); expect(p!.beta).toBeLessThanOrEqual(0.95);
    expect(p!.price).toBeGreaterThan(80_000);
  });
  it('a weak correlation is not offered', async () => {
    const p = await pickProxy('mainnet', 'MSTR', ids, (async (_n: string, id: number) => (id === 122 ? walk(noise(9, 100)) : walk(noise(4, 100)))) as never);
    expect(p).toBeNull();
  });
  it('no own Lighter market = nothing to measure = no proxy', async () => {
    expect(await pickProxy('mainnet', 'ZZZ', ids, closes as never)).toBeNull();
  });
  it('SPY tries US500, tech names US100, MSTR BTC', () => {
    expect(candidatesFor('SPY')).toEqual(['US500']); expect(candidatesFor('NVDA')).toEqual(['US100']); expect(candidatesFor('MSTR')).toEqual(['BTC']);
  });
});

describe('Derive option reader (live endpoints, faked here)', () => {
  beforeEach(() => clearOptionNames());
  const day = (d: number) => { const t = new Date(Date.now() + d * 86_400_000); return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`; };
  const e1 = day(5); const e2 = day(12); const far = day(90);
  const rpc = async (_n: string, method: string, params: { currency?: string; expiry_date?: string }) => {
    if (method === 'public/get_all_live_instruments') return [`NVDA-${e1}-150-P`, `NVDA-${e1}-140-P`, `NVDA-${e1}-150-C`, `NVDA-${e2}-150-P`, `NVDA-${far}-150-P`, `US500-${e1}-7100-P`, 'NVDA-PERP'];
    if (method === 'public/get_tickers') return { tickers: params.currency === 'NVDA'
      ? { [`NVDA-${params.expiry_date}-150-P`]: { b: '5.6', a: '6.1', A: '33', I: '148.8', option_pricing: { i: '0.70', d: '-0.53' } }, [`NVDA-${params.expiry_date}-140-P`]: { b: '0', a: '0', I: '148.8' } }
      : { [`US500-${params.expiry_date}-7100-P`]: { b: '72', a: '79', A: '1.4', I: '7107', option_pricing: { i: '0.25', d: '-0.45' } } } };
    throw new Error(method);
  };
  const read = makeDeriveOptions(rpc as never);

  it('NVDA: puts per expiry within 45 days, from the live quotes; a put with no ask is dropped', async () => {
    const c = await read('mainnet', 'NVDA');
    expect(c?.spot).toBe(148.8);
    expect(c?.expiries.map((e) => e.expiry.slice(0, 10).replace(/-/g, ''))).toEqual([e1, e2]);
    expect(c?.expiries[0].puts).toEqual([{ strike: 150, bid: 5.6, ask: 6.1, iv: 0.7, delta: -0.53, size: 33 }]);
  });
  it('SPY reads Derive US500 options', async () => {
    expect((await read('mainnet', 'SPY'))?.expiries[0].puts[0].strike).toBe(7100);
  });
  it('MSTR: no options listed = no chain', async () => {
    expect(await read('mainnet', 'MSTR')).toBeNull();
  });
});

describe('collectSnapshot wires live puts and measured proxies', () => {
  beforeEach(() => { closeStore(); openStore(':memory:'); clearMarketCache(); });
  afterEach(() => closeStore());
  const cfg = (): AgentConfig => structuredClone({ ...DEFAULT_CONFIG, hedge: { ...DEFAULT_CONFIG.hedge, enabled: true, sizing: 'loss_limit', legs: [] } });
  const deps = (): CollectDeps => ({
    getRuleStates: async () => ({}), getLighterCreds: async () => { throw new Error('no key'); }, getDeriveCreds: async () => { throw new Error('no key'); },
    lighterAccount: async () => null, deriveSubaccount: async () => { throw new Error('unused'); },
    funds: async (_w, symbols) => ({ funds: { usdcUsd: 0, usdtUsd: 0, allowanceUsdcBase: '0', bstocks: symbols.map((s) => ({ symbol: s, qty: s === 'MSTRB' || s === 'NVDAB' ? 1 : 0, value: s === 'MSTRB' ? 76 : s === 'NVDAB' ? 150 : 0, allowanceQty: 0 })) }, problems: [] }),
    moved24h: () => 0n,
    lighterMarkets: async () => [{ symbol: 'NVDA', marketId: 110 }, { symbol: 'MSTR', marketId: 122 }, { symbol: 'BTC', marketId: 1 }, { symbol: 'US100', marketId: 181 }],
    sigma: async (_n, id) => ({ 110: 0.08, 122: 0.063, 1: 0.03, 181: 0.015 } as Record<number, number>)[id] ?? null,
    options: async (_n, t) => (t === 'NVDA' ? { ticker: 'NVDA', spot: 150, expiries: [{ expiry: new Date(Date.now() + 7 * 86_400_000).toISOString(), puts: [{ strike: 150, bid: 5.6, ask: 6.1, iv: 0.7, delta: -0.53, size: 33 }] }], feeFraction: 0.0003, settlement: 'cash', quotesOffHours: true, contractSize: 1 } : null),
    proxy: async (_n, t) => (t === 'MSTR' ? { via: 'BTC', viaMarketId: 1, beta: 0.72, price: 90_000 } : t === 'NVDA' ? { via: 'US100', viaMarketId: 181, beta: 0.8, price: 21_000 } : null),
  });

  it('NVDA gets its Derive put; MSTR and NVDA each show their measured proxy; the user config is untouched', async () => {
    const c = cfg();
    const s = await collectSnapshot('0x1111111111111111111111111111111111111111', 'mainnet', c, deps());
    expect(Object.keys(s.options ?? {})).toEqual(['NVDA']);
    expect(s.config.risk.proxyMap).toEqual({ MSTR: { via: 'BTC', beta: 0.72 }, NVDA: { via: 'US100', beta: 0.8 } });
    expect(s.proxyPrices).toEqual({ BTC: 90_000, US100: 21_000 });
    expect(s.market?.sigmaDay.BTC).toBe(0.03);
    const r = assessRisk(s)!;
    const nv = r.tickers.find((t) => t.ticker === 'NVDA')!; const ms = r.tickers.find((t) => t.ticker === 'MSTR')!;
    expect(nv.putOk).toBe(true); expect(nv.proxyVia?.ticker).toBe('US100'); expect(nv.bucket).toBe('direct');
    expect(ms.perpOk).toBe(true); expect(ms.proxyVia).toMatchObject({ ticker: 'BTC', beta: 0.72, marketId: 1 });
    expect(c.risk.proxyMap).toEqual({}); expect(c.hedge.legs).toEqual([]);
  });

  it("the user's own proxy choice wins", async () => {
    const c = cfg(); c.risk.proxyMap = { MSTR: { via: 'US100', beta: 0.5 } };
    const s = await collectSnapshot('0x1111111111111111111111111111111111111111', 'mainnet', c, deps());
    expect(s.config.risk.proxyMap.MSTR).toEqual({ via: 'US100', beta: 0.5 });
  });
});
