'use client';
import { useMemo } from 'react';
import { useAccount } from 'wagmi';
import { useBscBalances } from './useBscBalances';
import { useBStockTickers } from './useBStockTickers';
import { useDeriveAccount, useLighterAllAccounts } from './useVenues';
import { toFloat } from '@/lib/format';

export const DEFAULT_HAIRCUT = 0.3;

/** One live view across BSC wallet, bStocks, Lighter and Derive. All numbers are display floats. */
export function usePortfolio(haircut = DEFAULT_HAIRCUT) {
  const { address } = useAccount();
  const bsc = useBscBalances();
  const tickers = useBStockTickers();
  const lighter = useLighterAllAccounts(address);
  const derive = useDeriveAccount();

  return useMemo(() => {
    const price = (s: string) => tickers.data?.find((t) => t.symbol === s)?.price ?? null;
    const usdc = bsc.usdc !== null ? toFloat(bsc.usdc, 18) : null;
    const usdt = bsc.usdt !== null ? toFloat(bsc.usdt, 18) : null;
    const stocks = bsc.holdings.filter((h) => h.raw > 0n).map((h) => {
      const qty = toFloat(h.ui, 18); const p = price(h.symbol);
      const tk = tickers.data?.find((t) => t.symbol === h.symbol);
      return { ...h, qty, price: p, value: p !== null ? qty * p : null, changePct: tk?.changePct ?? null, collateral: p !== null ? qty * p * (1 - haircut) : null };
    });
    const stocksValue = stocks.reduce((s, x) => s + (x.value ?? 0), 0);
    const stocksCollateral = stocks.reduce((s, x) => s + (x.collateral ?? 0), 0);

    // Sum the master and every sub-account.
    const lAll = lighter.data ?? [];
    const la = lAll.find((a) => a.account_type === 0) ?? lAll[0];
    const lighterEquity = lAll.length ? lAll.reduce((a, x) => a + Number(x.total_asset_value || x.collateral), 0) : null;
    const lighterAvail = lAll.length ? lAll.reduce((a, x) => a + Number(x.available_balance), 0) : null;
    const lighterUsage = la && lighterEquity ? Math.max(0, Math.min(100, ((lighterEquity - (lighterAvail ?? 0)) / lighterEquity) * 100)) : null;

    // Sum every Derive subaccount (one per risk universe, plus the fallback).
    const subs = derive.data?.subaccounts ?? (derive.data?.subaccount ? [derive.data.subaccount] : []);
    const ds = derive.data?.subaccount;
    const dColl = subs.reduce((a, s) => a + Number(s.collaterals_value), 0);
    const dFree = subs.filter((s) => !s.isFallback).reduce((a, s) => a + Number(s.initial_margin), 0);
    const deriveEquity = subs.length ? dColl + subs.reduce((a, s) => a + Number(s.positions_value ?? 0), 0) : null;
    const deriveUsage = subs.length && dColl > 0 ? Math.max(0, Math.min(100, (1 - dFree / dColl) * 100)) : null;

    const total = (usdc ?? 0) + (usdt ?? 0) + stocksValue + (lighterEquity ?? 0) + (deriveEquity ?? 0);
    return {
      address, loading: bsc.isLoading, updatedAt: bsc.updatedAt,
      bsc: { usdc, usdt, bnb: bsc.bnb !== null ? toFloat(bsc.bnb, 18) : null },
      stocks, stocksValue, stocksCollateral, haircut,
      lighter: { state: lighter.isLoading ? 'loading' : la ? 'ok' : lighter.isError ? 'unavailable' : 'no_account', error: lighter.error?.message ?? null, equity: lighterEquity, available: lighterAvail, usage: lighterUsage, positions: lAll.flatMap((x) => x.positions.filter((p) => +p.position !== 0)), index: la?.index, accounts: lAll.length },
      derive: { state: derive.data?.state ?? (derive.isLoading ? 'loading' : 'signed_out'), equity: deriveEquity, usage: deriveUsage, positions: subs.flatMap((s) => s.positions), subaccountId: ds?.subaccount_id },
      total,
    };
  }, [address, bsc, tickers.data, lighter.data, lighter.isLoading, lighter.isError, lighter.error, derive.data, derive.isLoading, haircut]);
}
