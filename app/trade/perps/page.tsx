'use client';
import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import clsx from 'clsx';
import { useVenueNetwork } from '@/lib/network';
import { useSession } from '@/lib/session';
import { getJson, lighterAccountName, useLighterAllAccounts, useLighterAgentAccounts, useLighterMarkets, type LighterAccountView, type LighterMarketDetail } from '@/lib/hooks/useVenues';
import { LighterSubaccounts } from '@/components/trade/LighterSubaccounts';
import { MarketHeader, Tabs } from '@/components/trade/MarketHeader';
import { CandleChart, type Candle } from '@/components/trade/CandleChart';
import { OrderBook, TradesList, type Level } from '@/components/trade/OrderBook';
import { TradeLayout, Empty } from '@/components/trade/TradeLayout';
import { AgentGate } from '@/components/AgentGate';
import { ClosePositionButton } from '@/components/trade/ClosePositionButton';
import { useAgentKeys } from '@/lib/hooks/useVenues';
import { fmtNum, fmtUsd, priceDecimals } from '@/lib/format';
import { BSTOCKS_BSC } from '@/lib/bstocks';
import { OrderHistory } from '@/components/trade/OrderHistory';
import { checkPerpOrder, describeOutcome, type OrderOutcome } from '@/lib/perp-order';

const RES = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 } as const;
type Res = keyof typeof RES;
const STOCKS = new Set(BSTOCKS_BSC.map((b) => b.underlying));

export default function PerpsPage() {
  return <Suspense fallback={null}><Perps /></Suspense>;
}

function Perps() {
  const sp = useSearchParams();
  const router = useRouter();
  const { network } = useVenueNetwork();
  const { address } = useAccount();
  const markets = useLighterMarkets();
  const q = sp.get('q')?.toUpperCase();
  const m: LighterMarketDetail | undefined = useMemo(() => {
    const list = markets.data ?? [];
    const id = sp.get('m');
    return (id !== null ? list.find((x) => String(x.market_id) === id) : undefined) ?? (q ? list.find((x) => x.symbol.includes(q)) : undefined) ?? list.find((x) => x.symbol === 'BTC') ?? list[0];
  }, [markets.data, sp, q]);
  const [res, setRes] = useState<Res>('1h');
  const [bookTab, setBookTab] = useState<'book' | 'trades'>('book');
  const [bottom, setBottom] = useState<'positions' | 'orders' | 'history' | 'subs'>('positions');
  // Which Lighter account trades: the master by default, or any sub-account the agent key is on.
  const all = useLighterAllAccounts(address);
  const [acctIdx, setAcctIdx] = useState<number | null>(null);
  const acct = { isLoading: all.isLoading, data: all.data === undefined ? undefined : (all.data?.find((a) => a.index === acctIdx) ?? all.data?.[0] ?? null) };
  const mid = m?.market_id;

  const candles = useQuery({
    queryKey: ['lc', network, mid, res], enabled: mid !== undefined, refetchInterval: 10_000,
    queryFn: async () => {
      const end = Math.floor(Date.now() / 1000);
      const j = await getJson<{ c?: { t: number; o: number; h: number; l: number; c: number; v: number }[] }>(`/api/lighter/candles?network=${network}&market_id=${mid}&resolution=${res}&start_timestamp=${end - RES[res] * 400}&end_timestamp=${end}&count_back=400`);
      return (j.c ?? []).map((k): Candle => ({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }));
    },
  });
  const book = useQuery({
    queryKey: ['lb', network, mid], enabled: mid !== undefined, refetchInterval: 1_000,
    queryFn: async () => {
      const j = await getJson<{ asks?: { price: string; remaining_base_amount: string }[]; bids?: { price: string; remaining_base_amount: string }[] }>(`/api/lighter/orderBookOrders?network=${network}&market_id=${mid}&limit=60`);
      const agg = (xs: { price: string; remaining_base_amount: string }[] = []): Level[] => {
        const mp = new Map<number, number>();
        for (const o of xs) mp.set(+o.price, (mp.get(+o.price) ?? 0) + +o.remaining_base_amount);
        return [...mp.entries()];
      };
      return { asks: agg(j.asks), bids: agg(j.bids) };
    },
  });
  const trades = useQuery({
    queryKey: ['lt', network, mid], enabled: mid !== undefined && bookTab === 'trades', refetchInterval: 2_000,
    queryFn: async () => (await getJson<{ trades?: { trade_id: number; price: string; size: string; timestamp: number; is_maker_ask: boolean }[] }>(`/api/lighter/recentTrades?network=${network}&market_id=${mid}&limit=40`))
      .trades?.map((t) => ({ id: t.trade_id, price: +t.price, size: +t.size, time: t.timestamp, side: (t.is_maker_ask ? 'buy' : 'sell') as 'buy' | 'sell' })) ?? [],
  });

  const last = m?.last_trade_price ?? null;
  const pct = m?.daily_price_change ?? null;
  const maxLev = m ? Math.round(10_000 / m.default_initial_margin_fraction) : null;

  // Lighter's own API is down (not our request): say so instead of spinning on "Loading…".
  if (markets.isError && !markets.data) {
    return (
      <div className="panel mx-auto mt-10 max-w-xl p-6 text-center">
        <div className="mb-2 text-lg font-semibold">Lighter {network} isn&apos;t responding</div>
        <p className="text-sm text-muted">{markets.error.message}. Your account, agent key and positions are unaffected. This page reconnects by itself once Lighter is back.</p>
        <p className="mt-3 text-xs text-muted">Check <a className="text-accent underline" href={network === 'testnet' ? 'https://testnet.app.lighter.xyz' : 'https://app.lighter.xyz'} target="_blank" rel="noreferrer">Lighter&apos;s own app</a>{network === 'testnet' ? ', or switch the sidebar to Mainnet' : ''}.</p>
      </div>
    );
  }

  return (
    <TradeLayout
      header={
        <MarketHeader
          icon={<span className="grid h-8 w-8 place-items-center rounded-full bg-[#7b61ff]/20 text-xs font-bold text-[#a593ff]">L</span>}
          title={m ? `${m.symbol}-PERP` : 'Loading…'} badge={maxLev ? `${maxLev}x · Lighter${network === 'testnet' ? ' testnet' : ''}` : 'Lighter'}
          price={last} changePct={pct}
          stats={[
            { label: 'Mark', value: fmtNum(m ? +m.mark_price : null, priceDecimals(last ?? 1)) },
            { label: 'Index', value: fmtNum(m ? +m.index_price : null, priceDecimals(last ?? 1)) },
            { label: '24H High', value: fmtNum(m?.daily_price_high, priceDecimals(last ?? 1)) },
            { label: '24H Low', value: fmtNum(m?.daily_price_low, priceDecimals(last ?? 1)) },
            { label: '24H Volume (USD)', value: fmtNum(m?.daily_quote_token_volume, 0) },
            { label: 'Open interest', value: fmtUsd(m ? +m.open_interest_usd : null, 0) },
          ]}
          markets={(markets.data ?? []).map((x) => ({ key: String(x.market_id), label: `${x.symbol}-PERP`, price: x.last_trade_price, changePct: x.daily_price_change, badge: STOCKS.has(x.symbol) ? 'stock · hedge' : undefined }))}
          onSelect={(k) => router.push(`/trade/perps?m=${k}`)}
        />
      }
      chart={
        <>
          <div className="mb-2 flex items-center justify-between"><span className="px-2 text-sm text-muted">Chart</span><Tabs size="sm" tabs={(Object.keys(RES) as Res[]).map((r) => ({ id: r, label: r }))} value={res} onChange={setRes} /></div>
          <div className="flex-1 min-h-0">{candles.data?.length ? <CandleChart candles={candles.data} watermark={m?.symbol} /> : <Empty>{candles.isLoading ? 'Loading chart…' : 'No candles'}</Empty>}</div>
        </>
      }
      book={
        <>
          <div className="mb-2 px-3"><Tabs tabs={[{ id: 'book', label: 'Book' }, { id: 'trades', label: 'Trades' }] as const} value={bookTab} onChange={setBookTab} /></div>
          <div className="flex-1 min-h-0">{bookTab === 'book' ? (book.data ? <OrderBook bids={book.data.bids} asks={book.data.asks} last={last} baseLabel={m?.symbol ?? ''} /> : <Empty>Loading book…</Empty>) : <TradesList trades={trades.data ?? []} />}</div>
        </>
      }
      ticket={m ? <PerpTicket m={m} hasAccount={acct.isLoading ? null : !!acct.data} available={acct.data ? +acct.data.available_balance : null} accounts={all.data ?? []} account={acct.data ?? null} onAccount={setAcctIdx} /> : <div className="panel p-4"><Empty>Loading…</Empty></div>}
      bottom={
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs tabs={[{ id: 'positions', label: `Positions (${acct.data?.positions.filter((p) => +p.position !== 0).length ?? 0})` }, { id: 'orders', label: 'Open orders' }, { id: 'history', label: 'Order history' }, { id: 'subs', label: `Sub-accounts (${all.data?.length ?? 0})` }] as const} value={bottom} onChange={setBottom} />
            {acct.data && <span className="text-xs text-muted">Account: <span className="text-white">{lighterAccountName(acct.data)}</span></span>}
          </div>
          {bottom === 'positions' ? <LighterPositions account={acct.data ?? null} loading={acct.isLoading} />
            : bottom === 'orders' ? <LighterOrders marketId={mid} accountIndex={acct.data?.index} />
            : bottom === 'history' ? <OrderHistory venues={['lighter']} />
            : <LighterSubaccounts accounts={all.data ?? []} onTradeFrom={(i) => { setAcctIdx(i); setBottom('positions'); }} />}
        </>
      }
    />
  );
}

function newIdem() { return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; }

function PerpTicket({ m, hasAccount, available, accounts, account, onAccount }: { m: LighterMarketDetail; hasAccount: boolean | null; available: number | null; accounts: LighterAccountView[]; account: LighterAccountView | null; onAccount: (i: number) => void }) {
  const agentAccts = useLighterAgentAccounts();
  const agentOn = !account || account.account_type === 0 || agentAccts.data?.some((a) => a.index === account.index && a.agent === 'active');
  const { network } = useVenueNetwork();
  const qc = useQueryClient();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<'limit' | 'market'>('market');
  const [price, setPrice] = useState('');
  const [size, setSize] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const last = m.last_trade_price;
  const px = type === 'market' ? last : Number(price);
  const imf = m.default_initial_margin_fraction / 10_000;
  const check = checkPerpOrder({ size: Number(size) || 0, px, imf, available, minBase: Number(m.min_base_amount), minQuote: Number(m.min_quote_amount) || 0, sizeDecimals: m.size_decimals, reduceOnly, symbol: m.symbol });
  const { notional, margin } = check;
  const dp = m.price_decimals;

  async function submit() {
    if (check.problem) { setMsg({ ok: false, text: check.problem }); return; }
    setBusy(true); setMsg(null);
    try {
      // Market orders carry a worst-acceptable price: 2% through last.
      const worst = type === 'market' ? (side === 'buy' ? last * 1.02 : last * 0.98).toFixed(dp) : price;
      const r = await getJson<{ txHash: string; clientOrderIndex: number }>('/api/trade/lighter', {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': newIdem() },
        body: JSON.stringify({ network, action: 'order', marketId: m.market_id, side, type, size, price: worst, reduceOnly, postOnly: type === 'limit' && postOnly, accountIndex: account?.index }),
      });
      setSize('');
      // sendTx only means Lighter accepted the transaction. Ask what actually happened (fill, rest, or cancel reason).
      setMsg(describeOutcome({ state: 'pending', status: null, size: null, filled: null, avgPrice: null }, m.symbol));
      const q = new URLSearchParams({ network, marketId: String(m.market_id), clientOrderIndex: String(r.clientOrderIndex), ...(account ? { accountIndex: String(account.index) } : {}) });
      for (let i = 0; i < 10; i++) {
        await new Promise((res) => setTimeout(res, 1_500));
        const o = await getJson<OrderOutcome>(`/api/trade/lighter?${q}`).catch(() => null);
        if (o && o.state !== 'pending') { setMsg(describeOutcome(o, m.symbol)); break; }
        if (i === 9) setMsg({ ok: true, text: `Order sent (tx ${r.txHash.slice(0, 10)}…). Lighter hasn't confirmed it yet; check Positions and Open orders.` });
      }
      void qc.invalidateQueries({ queryKey: ['lighter-account'] });
      void qc.invalidateQueries({ queryKey: ['lighter-orders'] });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }

  const valid = Number(size) > 0 && (type === 'market' || Number(price) > 0) && !check.problem;
  return (
    <div className="panel flex flex-col gap-4 p-4">
      <div className="grid grid-cols-2 rounded-2xl bg-bg p-1">
        <button className={clsx('rounded-xl py-3 font-medium', side === 'buy' ? 'bg-up/15 text-up' : 'text-[#c9ccd6]')} onClick={() => setSide('buy')}>Long</button>
        <button className={clsx('rounded-xl py-3 font-medium', side === 'sell' ? 'bg-down/15 text-down' : 'text-[#c9ccd6]')} onClick={() => setSide('sell')}>Short</button>
      </div>
      {accounts.length > 1 && (
        <label className="flex items-center gap-2 text-sm"><span className="label shrink-0">Account</span>
          <select className="input py-1.5 text-sm" value={account?.index ?? ''} onChange={(e) => onAccount(Number(e.target.value))}>
            {accounts.map((a) => <option key={a.index} value={a.index}>{lighterAccountName(a)} · ${(+a.available_balance).toFixed(2)} free</option>)}
          </select></label>
      )}
      <Tabs tabs={[{ id: 'limit', label: 'Limit' }, { id: 'market', label: 'Market' }] as const} value={type} onChange={setType} />
      <div className="flex justify-between"><span className="label">Available margin</span><span className="text-sm num">{available === null ? '—' : fmtUsd(available)}</span></div>
      {type === 'limit' && (
        <div><div className="mb-1.5 flex justify-between"><span className="label">Price</span><button className="text-xs text-accent" onClick={() => setPrice(String(last))}>Last</button></div>
          <input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={String(last)} /></div>
      )}
      <div><div className="mb-1.5 flex justify-between"><span className="label">Size ({m.symbol}) · min {m.min_base_amount}</span>
          {check.maxSize !== null && !reduceOnly && <button className="text-xs text-accent" onClick={() => setSize(check.maxSize!.toFixed(m.size_decimals))}>Max {check.maxSize.toFixed(m.size_decimals)}</button>}</div>
        <input className="input" inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} placeholder="0" /></div>
      {available !== null && px > 0 && (
        <div className="flex gap-2">{[10, 25, 50, 100].map((p) => (
          <button key={p} className="flex-1 rounded-lg bg-panel2 py-1.5 text-xs text-[#c9ccd6] hover:text-white"
            onClick={() => setSize(((available * p) / 100 / imf / px).toFixed(m.size_decimals))}>{p}%</button>
        ))}</div>
      )}
      <div className="rounded-xl bg-bg p-3 text-sm space-y-1.5">
        <div className="flex justify-between"><span className="text-muted">Order value</span><span className="num">{fmtUsd(notional || null)}</span></div>
        <div className="flex justify-between"><span className="text-muted">Initial margin ({(imf * 100).toFixed(0)}%)</span><span className="num">{fmtUsd(margin || null)}</span></div>
      </div>
      {check.problem && <div className="rounded-xl bg-down/10 px-3 py-2 text-xs text-down">{check.problem}</div>}
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />Reduce only</label>
        {type === 'limit' && <label className="flex items-center gap-2"><input type="checkbox" checked={postOnly} onChange={(e) => setPostOnly(e.target.checked)} />Post only</label>}
      </div>
      <AgentGate venue="lighter" hasAccount={hasAccount}>
        {agentOn ? (
          <button className={side === 'buy' ? 'btn bg-up text-black' : 'btn bg-down text-black'} disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'Signing with agent…' : `${side === 'buy' ? 'Long' : 'Short'} ${m.symbol}`}
          </button>
        ) : <div className="rounded-xl bg-bg p-3 text-xs text-muted">The agent key isn&apos;t on {account ? lighterAccountName(account) : 'this account'} yet. Enable it in the Sub-accounts tab below (one MetaMask signature).</div>}
      </AgentGate>
      {msg && <div className={clsx('rounded-xl px-3 py-2 text-xs', msg.ok ? 'bg-up/10 text-up' : 'bg-down/10 text-down')}>{msg.text}</div>}
      <p className="text-[11px] text-muted leading-snug">Lighter orders are signed by your registered agent key on the server. Trading on Lighter costs no gas.</p>
    </div>
  );
}

function LighterPositions({ account, loading }: { account: LighterAccountView | null; loading: boolean }) {
  const { address } = useAccount();
  const { network } = useVenueNetwork();
  const qc = useQueryClient();
  const markets = useLighterMarkets();
  const keys = useAgentKeys();
  const hasKey = !!keys.data?.some((k) => k.venue === 'lighter' && k.network === network && k.status === 'active');
  const pos = account?.positions.filter((p) => +p.position !== 0) ?? [];
  if (!address) return <Empty>Connect MetaMask</Empty>;
  if (!account) return <Empty>{loading ? 'Loading…' : 'No Lighter account yet'}</Empty>;
  if (!pos.length) return <Empty>No open positions</Empty>;
  const accountIndex = account.index;

  async function close(p: (typeof pos)[number]) {
    const m = markets.data?.find((x) => x.market_id === p.market_id);
    if (!m) throw new Error('market data not loaded yet');
    const ref = Number(m.mark_price) || m.last_trade_price;
    const side = p.sign > 0 ? 'sell' : 'buy';
    // Worst acceptable price 2% through mark; reduce-only so it can never flip the position.
    const worst = (side === 'sell' ? ref * 0.98 : ref * 1.02).toFixed(m.price_decimals);
    await getJson('/api/trade/lighter', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': newIdem() },
      body: JSON.stringify({ network, action: 'order', marketId: p.market_id, side, type: 'market', size: p.position.replace('-', ''), price: worst, reduceOnly: true, accountIndex }),
    });
    await new Promise((r) => setTimeout(r, 1_200));
    void qc.invalidateQueries({ queryKey: ['lighter-account'] });
  }

  return (
    <table className="mt-2 w-full"><thead><tr>{['Market', 'Side', 'Size', 'Entry', 'Value', 'uPnL', 'Liq. price', ''].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead><tbody>
      {pos.map((p) => <tr key={p.market_id}>
        <td className="td">{p.symbol}-PERP</td><td className={clsx('td', p.sign > 0 ? 'text-up' : 'text-down')}>{p.sign > 0 ? 'Long' : 'Short'}</td>
        <td className="td">{p.position}</td><td className="td">{fmtNum(+p.avg_entry_price, priceDecimals(+p.avg_entry_price))}</td><td className="td">{fmtUsd(+p.position_value)}</td>
        <td className={clsx('td', +p.unrealized_pnl >= 0 ? 'text-up' : 'text-down')}>{fmtUsd(+p.unrealized_pnl)}</td><td className="td">{+p.liquidation_price ? fmtNum(+p.liquidation_price, priceDecimals(+p.liquidation_price)) : '—'}</td>
        <td className="td text-right"><ClosePositionButton disabled={!hasKey} onClose={() => close(p)} /></td>
      </tr>)}
    </tbody></table>
  );
}

function LighterOrders({ marketId, accountIndex }: { marketId?: number; accountIndex?: number }) {
  const { network } = useVenueNetwork();
  const { wallet } = useSession();
  const qc = useQueryClient();
  const orders = useQuery({
    queryKey: ['lighter-orders', network, wallet, marketId, accountIndex], enabled: !!wallet && marketId !== undefined, refetchInterval: 4_000,
    queryFn: () => getJson<{ orders: { order_index: number; market_index: number; is_ask: boolean; price: string; remaining_base_amount: string; type: string }[]; needsAgent?: boolean }>(`/api/trade/lighter-orders?network=${network}&market_id=${marketId}${accountIndex !== undefined ? `&account=${accountIndex}` : ''}`),
  });
  if (!wallet) return <Empty>Sign in to see open orders</Empty>;
  if (orders.data?.needsAgent) return <Empty>Register a Lighter agent to see orders</Empty>;
  if (!orders.data?.orders.length) return <Empty>No open orders</Empty>;
  const cancel = async (o: { market_index: number; order_index: number }) => {
    await getJson('/api/trade/lighter', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': newIdem() }, body: JSON.stringify({ network, action: 'cancel', marketId: o.market_index, orderIndex: o.order_index, accountIndex }) }).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: ['lighter-orders'] });
  };
  return (
    <table className="mt-2 w-full"><thead><tr>{['Market', 'Side', 'Price', 'Remaining', 'Type', ''].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead><tbody>
      {orders.data.orders.map((o) => <tr key={o.order_index}>
        <td className="td">#{o.market_index}</td><td className={clsx('td', o.is_ask ? 'text-down' : 'text-up')}>{o.is_ask ? 'Sell' : 'Buy'}</td><td className="td">{o.price}</td><td className="td">{o.remaining_base_amount}</td><td className="td">{o.type}</td>
        <td className="td text-right"><button className="text-xs text-down" onClick={() => void cancel(o)}>Cancel</button></td>
      </tr>)}
    </tbody></table>
  );
}
