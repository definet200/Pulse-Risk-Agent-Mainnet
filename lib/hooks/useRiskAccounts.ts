'use client';
import { useMemo } from 'react';
import { useAccount } from 'wagmi';
import { useDeriveAccount, useLighterAllAccounts } from './useVenues';
import type { AccountHealth, RuleVenue } from '@/lib/risk-rules';

export interface RiskPosition {
  venue: RuleVenue; account: string; market: string; side: 'long' | 'short'; size: number;
  valueUsd: number; upnl: number; liqPrice: number | null; markPrice: number | null; kind: 'perp' | 'option';
}

export interface RiskAccount {
  key: string; venue: RuleVenue; accountRef: string; title: string; label: string | null;
  health: AccountHealth; positions: RiskPosition[];
}

/**
 * Every venue account a rebalance rule can watch, with live health:
 * - Lighter main account: equity = total_asset_value, margin used = equity − available.
 * - Each tradeable Derive subaccount (one per risk universe): account value = collateral + positions,
 *   margin used = collateral − initial_margin (Derive's initial_margin is the free headroom).
 */
export function useRiskAccounts() {
  const { address } = useAccount();
  const lighter = useLighterAllAccounts(address);
  const derive = useDeriveAccount();

  return useMemo(() => {
    const accounts: RiskAccount[] = [];
    // Lighter: the master is ruleKey "lighter:" (accountRef ''), each sub-account "lighter:<index>".
    for (const la of lighter.data ?? []) {
      const master = la.account_type === 0;
      const eq = Number(la.total_asset_value || la.collateral);
      const used = Math.max(0, eq - Number(la.available_balance));
      accounts.push({
        key: master ? 'lighter:' : `lighter:${la.index}`, venue: 'lighter', accountRef: master ? '' : String(la.index),
        title: master ? 'Perps · Main' : `Perps · Sub #${la.index}`, label: master ? `Main #${la.index}` : `Sub #${la.index}`,
        health: { connected: true, accountUsd: eq, usedUsd: used, utilBps: eq > 0 ? Math.round((used / eq) * 10_000) : null },
        positions: la.positions.filter((p) => +p.position !== 0).map((p) => {
          const size = Math.abs(+p.position);
          return { venue: 'lighter' as const, account: master ? 'Perps · Main' : `Perps · Sub #${la.index}`, market: `${p.symbol}-PERP`, side: p.sign > 0 ? 'long' as const : 'short' as const, size,
            valueUsd: Math.abs(+p.position_value), upnl: +p.unrealized_pnl, liqPrice: +p.liquidation_price || null,
            markPrice: size > 0 ? Math.abs(+p.position_value) / size : null, kind: 'perp' as const };
        }),
      });
    }
    for (const s of derive.data?.subaccounts ?? []) {
      if (s.isFallback) continue;
      const coll = Number(s.collaterals_value);
      const used = Math.max(0, coll - Number(s.initial_margin));
      const title = `Options · ${s.universeName ?? `#${s.subaccount_id}`}`;
      accounts.push({
        key: `derive:${s.subaccount_id}`, venue: 'derive', accountRef: String(s.subaccount_id), title, label: `${s.universeName ?? ''} #${s.subaccount_id}`.trim(),
        health: { connected: true, accountUsd: coll + Number(s.positions_value ?? 0), usedUsd: used, utilBps: coll > 0 ? Math.round((used / coll) * 10_000) : null },
        positions: s.positions.map((p) => ({
          venue: 'derive' as const, account: title, market: p.instrument_name, side: +p.amount >= 0 ? 'long' as const : 'short' as const,
          size: Math.abs(+p.amount), valueUsd: Math.abs(+p.mark_value), upnl: +p.unrealized_pnl,
          liqPrice: p.liquidation_price ? +p.liquidation_price || null : null, markPrice: +p.mark_price || null,
          kind: p.instrument_type === 'option' ? 'option' as const : 'perp' as const,
        })),
      });
    }
    return {
      accounts,
      loading: lighter.isLoading || derive.isLoading,
      deriveState: derive.data?.state ?? null,
    };
  }, [lighter.data, lighter.isLoading, derive.data, derive.isLoading]);
}
