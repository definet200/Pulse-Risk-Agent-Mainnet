import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type AgentConfig } from '../../lib/agent-config';
import { ActionIn } from '../../lib/agent-action';
import { fixtureSnapshot } from '../src/fixtures';
import { alternativesFor, venueAlternatives } from '../src/risk/alternatives';
import { buildActionRequest } from '../src/tools/approvals';
import { collectSnapshot, type CollectDeps } from '../src/tools/collect';
import { closeStore, openStore } from '../src/tools/store';
import type { Candidate, Snapshot } from '../src/types';
import type { OptionChain } from '../src/risk/options';

const chain = (spot: number): OptionChain => ({ ticker: 'NVDA', spot, contractSize: 1, feeFraction: 0.0003, settlement: 'cash', quotesOffHours: true,
  expiries: [{ expiry: new Date(Date.now() + 7 * 86_400_000).toISOString(), puts: [{ strike: 150, bid: 6.9, ask: 7.23, iv: 0.78, delta: -0.52, size: 33 }] }] });

function snap(nvdaUsd: number, mstrUsd: number): Snapshot {
  const s = fixtureSnapshot(); s.config.hedge.enabled = true;
  s.config.hedge.legs = [
    { bstock: 'NVDAB', venue: 'lighter', kind: 'perp', market: 'NVDA', marketId: 110, hedgeRatio: 1 },
    { bstock: 'MSTRB', venue: 'lighter', kind: 'perp', market: 'MSTR', marketId: 122, hedgeRatio: 1 },
    { bstock: 'BTCB', venue: 'lighter', kind: 'perp', market: 'BTC', marketId: 1, hedgeRatio: 1 },
  ] as Snapshot['config']['hedge']['legs'];
  s.config.risk.proxyMap = { MSTR: { via: 'BTC', beta: 0.9 } };
  s.bsc.bstocks = [{ symbol: 'NVDAB', qty: nvdaUsd / 150, value: nvdaUsd }, { symbol: 'MSTRB', qty: mstrUsd / 76, value: mstrUsd }];
  s.options = { NVDA: chain(150) }; s.proxyPrices = { BTC: 58_800 };
  s.market = { sigmaDay: { NVDA: 0.08, MSTR: 0.063, BTC: 0.03 }, at: new Date().toISOString() };
  s.venueAccounts = [
    { venue: 'lighter', id: 7, label: 'Lighter main #7', equityUsd: 7.95, freeUsd: 7.95, main: true },
    { venue: 'lighter', id: 9, label: 'Lighter sub-account #9', equityUsd: 3, freeUsd: 3, main: false },
    { venue: 'derive', id: 122955, label: 'Derive #122955 (PRIME)', equityUsd: 7.96, freeUsd: 1, main: true },
    { venue: 'derive', id: 130000, label: 'Derive #130000 (RWA)', equityUsd: 2, freeUsd: 2, main: false },
  ];
  return s;
}
const by = (a: ReturnType<typeof venueAlternatives>, v: string) => a.find((x) => x.venue === v)!;

describe('why this venue and not the others', () => {
  it('$10.35 of MSTR, perp chosen: Derive blocked (no MSTR options); BTC proxy possible but only without a direct hedge', () => {
    const a = venueAlternatives(snap(5, 10.35), 'MSTR', 'perp');
    expect(by(a, 'lighter')).toMatchObject({ status: 'chosen' });
    expect(by(a, 'derive')).toMatchObject({ status: 'blocked', why: 'Derive lists no MSTR options right now.' });
    expect(by(a, 'proxy').status).toBe('possible');
    expect(by(a, 'proxy').why).toMatch(/correlation 0.9.*only when there is no direct hedge/);
  });
  it('$5 of NVDA: Lighter blocked by the $10 minimum; Derive blocked by 1-contract minimum, budget and free funds across subaccounts', () => {
    const a = venueAlternatives(snap(5, 10.35), 'NVDA', null);
    expect(by(a, 'lighter').status).toBe('blocked'); expect(by(a, 'lighter').why).toMatch(/under Lighter's \$10.00 minimum/);
    const d = by(a, 'derive');
    expect(d.status).toBe('blocked');
    expect(d.why).toMatch(/minimum is 1 contract \(\$150.00 of cover\) against your \$5.00/);
    expect(d.why).toMatch(/best subaccount has \$2.00 free \(\$3.00 across 2 subaccounts\)/);
    expect(by(a, 'proxy').status).toBe('blocked');
  });
  it('margin on a sub-account is pointed out when Lighter main is short', () => {
    const s = snap(40, 0); s.venueAccounts![0].freeUsd = 1;
    expect(by(venueAlternatives(s, 'NVDA', null), 'lighter').why).toMatch(/\$3.00 more in sub-accounts \(an instant internal transfer\)/);
  });
});

describe('every hedge request carries payoff and alternatives', () => {
  it('a Lighter hedge request validates against the app schema with both attached', () => {
    const s = snap(5, 10.35);
    const c = { id: 'hedge:lighter:122:sell:0.1368', kind: 'hedge', venue: 'lighter', amountBaseUnit: '0', reason: 'hedge MSTR', hedge: { bstock: 'MSTRB', market: 'MSTR', marketId: 122, deltaToShort: 0.1368, driftPct: 100, ticker: 'MSTR', hedgePrice: 75.7 } } as unknown as Candidate;
    const req = buildActionRequest(s, c, undefined);
    expect(req.payoff?.hedgeLabel).toBe('Short $10.36 MSTR perp on Lighter');
    expect(req.alternatives?.map((x) => `${x.venue}:${x.status}`)).toEqual(['lighter:chosen', 'derive:blocked', 'proxy:possible']);
    expect(ActionIn.safeParse(req).success).toBe(true);
    expect(alternativesFor(s, { kind: 'top_up' } as unknown as Candidate)).toEqual([]);
  });
});

describe('collectSnapshot reads every sub-account', () => {
  beforeEach(() => { closeStore(); openStore(':memory:'); });
  afterEach(() => closeStore());
  it('all Lighter and Derive accounts land in venueAccounts; Derive free = best subaccount', async () => {
    const cfg: AgentConfig = structuredClone({ ...DEFAULT_CONFIG, hedge: { ...DEFAULT_CONFIG.hedge, enabled: true, legs: [] } });
    const deps: CollectDeps = {
      getRuleStates: async () => ({}), getLighterCreds: async () => ({ accountIndex: 7, apiKeyIndex: 2, apiPrivateKey: 'x' }),
      getDeriveCreds: async () => ({ subaccountId: 122955, sessionKeyAddress: '0x0', sessionPrivateKey: 'x', expiresAt: null }),
      lighterAccount: async () => ({ index: 7, collateral: '7.95', available_balance: '7.95', total_asset_value: '7.95', positions: [] }), deriveSubaccount: async () => { throw new Error('unused'); },
      funds: async () => ({ funds: { usdcUsd: 0, usdtUsd: 0, allowanceUsdcBase: '0', bstocks: [] }, problems: [] }), moved24h: () => 0n, lighterMarkets: async () => [],
      allLighterAccounts: async () => [{ venue: 'lighter', id: 7, label: 'Lighter main #7', equityUsd: 7.95, freeUsd: 7.95, main: true }, { venue: 'lighter', id: 9, label: 'Lighter sub-account #9', equityUsd: 3, freeUsd: 3, main: false }],
      allDeriveSubaccounts: async () => [{ venue: 'derive', id: 122955, label: 'Derive #122955', equityUsd: 7.96, freeUsd: 1, main: true }, { venue: 'derive', id: 130000, label: 'Derive #130000', equityUsd: 6, freeUsd: 6, main: false }],
    };
    const s = await collectSnapshot('0x1111111111111111111111111111111111111111', 'mainnet', cfg, deps, true);
    expect(s.venueAccounts?.map((a) => `${a.venue}#${a.id}`)).toEqual(['lighter#7', 'lighter#9', 'derive#122955', 'derive#130000']);
    expect(s.deriveFree).toEqual({ ref: '130000', freeUsd: 6 });
  });
});
