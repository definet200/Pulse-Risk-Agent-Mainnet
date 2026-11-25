import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type AgentConfig } from '../../lib/agent-config';
import { collectSnapshot, defaultHedgeLegs, type CollectDeps } from '../src/tools/collect';
import { closeStore, openStore } from '../src/tools/store';
import { clearMarketCache } from '../src/risk/market';
import { assessRisk } from '../src/risk/plan';

beforeEach(() => { closeStore(); openStore(':memory:'); }); // the tick loop opens its store before collecting
afterEach(() => closeStore());

// Live 2026-11-25: a wallet with hedging ON but no hedge legs held NVDAB + MSTRB, and the agent said "no hedge market
// exists for NVDA or MSTR" although Lighter lists both (markets 110 and 122). A held bStock now gets its Lighter perp.
const LIGHTER = [{ symbol: 'NVDA', marketId: 110 }, { symbol: 'MSTR', marketId: 122 }, { symbol: 'US500', marketId: 180 }];

describe('defaultHedgeLegs', () => {
  it('gives each held bStock with no leg its matching Lighter perp at ratio 1', () => {
    expect(defaultHedgeLegs([], ['NVDAB', 'MSTRB'], LIGHTER)).toEqual([
      { bstock: 'NVDAB', venue: 'lighter', kind: 'perp', market: 'NVDA', marketId: 110, hedgeRatio: 1 },
      { bstock: 'MSTRB', venue: 'lighter', kind: 'perp', market: 'MSTR', marketId: 122, hedgeRatio: 1 },
    ]);
  });
  it('never overrides a leg the user set (any venue)', () => {
    const userLeg = { bstock: 'NVDAB', venue: 'derive' as const, kind: 'put' as const, market: 'NVDA', hedgeRatio: 0.5, put: { strikePct: 90, minDaysToExpiry: 7, targetDaysToExpiry: 30 } };
    expect(defaultHedgeLegs([userLeg], ['NVDAB'], LIGHTER)).toEqual([]);
  });
  it('skips a stock Lighter does not list', () => {
    expect(defaultHedgeLegs([], ['ZZZB'], LIGHTER)).toEqual([]);
  });
});

describe('collectSnapshot with hedging on and no legs', () => {
  const cfg = (over: Partial<AgentConfig['hedge']> = {}): AgentConfig => structuredClone({ ...DEFAULT_CONFIG, hedge: { ...DEFAULT_CONFIG.hedge, enabled: true, legs: [], ...over } });
  const funds: CollectDeps['funds'] = async (_w, symbols) => ({ funds: { usdcUsd: 0, usdtUsd: 0, allowanceUsdcBase: '0',
    bstocks: symbols.map((s) => ({ symbol: s, qty: s === 'NVDAB' || s === 'MSTRB' ? 1 : 0, value: s === 'NVDAB' ? 150 : s === 'MSTRB' ? 300 : 0, allowanceQty: 0 })) }, problems: [] });
  const deps = (seen: string[][]): CollectDeps => ({
    getRuleStates: async () => ({}), getLighterCreds: async () => { throw new Error('no key in test'); }, getDeriveCreds: async () => { throw new Error('no key in test'); },
    lighterAccount: async () => null, deriveSubaccount: async () => { throw new Error('unused'); },
    funds: async (w, s) => { seen.push(s); return funds(w, s); }, moved24h: () => 0n,
    lighterMarkets: async () => LIGHTER,
  });

  it('reads every listed bStock and hedges NVDAB and MSTRB on their Lighter perps', async () => {
    const seen: string[][] = [];
    const s = await collectSnapshot('0x1111111111111111111111111111111111111111', 'mainnet', cfg(), deps(seen));
    expect(seen[0]).toEqual(expect.arrayContaining(['NVDAB', 'MSTRB'])); // holdings are read even with no leg
    expect(s.config.hedge.legs.map((l) => `${l.bstock}->${l.market}#${l.marketId}`)).toEqual(['NVDAB->NVDA#110', 'MSTRB->MSTR#122']);
  });

  it('hedging off: no default legs and no extra reads', async () => {
    const seen: string[][] = [];
    const s = await collectSnapshot('0x1111111111111111111111111111111111111111', 'mainnet', cfg({ enabled: false }), deps(seen));
    expect(s.config.hedge.legs).toEqual([]);
    expect(seen[0]).not.toContain('MSTRB');
  });

  it("the user's saved config object is never modified", async () => {
    const c = cfg();
    await collectSnapshot('0x1111111111111111111111111111111111111111', 'mainnet', c, deps([]));
    expect(c.hedge.legs).toEqual([]);
  });

  // Live 2026-11-25: in "By ratio" sizing the agent never read volatility, so chat said NVDA and MSTR had "no risk model".
  it('reads live volatility for every holding in ratio sizing too, so the risk view is complete', async () => {
    clearMarketCache();
    const ids: number[] = [];
    const d = { ...deps([]), sigma: async (_n: string, id: number) => { ids.push(id); return id === 110 ? 0.08 : 0.063; },
      hedge: { lighterMid: async () => null, lighterPosition: async () => 0, lighterMin: async () => null, derivePuts: async () => [] } } as unknown as CollectDeps;
    const s = await collectSnapshot('0x1111111111111111111111111111111111111111', 'mainnet', cfg({ sizing: 'ratio' }), d);
    expect(ids.sort()).toEqual([110, 122]);
    expect(s.market?.sigmaDay).toEqual({ NVDA: 0.08, MSTR: 0.063 });
    expect(assessRisk(s)?.tickers.map((t) => t.ticker).sort()).toEqual(['MSTR', 'NVDA']);
  });
});
