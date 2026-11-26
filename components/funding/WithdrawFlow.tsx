'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDown } from 'lucide-react';
import { useVenueNetwork } from '@/lib/network';
import { useSession } from '@/lib/session';
import { getJson, useDeriveAccount, useLighterAgentAccounts } from '@/lib/hooks/useVenues';

// Venue → the user's own Ethereum wallet. Signed server-side by the agent key the user already approved;
// neither venue lets that key pay anyone but the account owner. Bringing it on to BNB is the next step
// (Ethereum → BNB, which the user signs).

type Venue = 'lighter' | 'derive';
interface Withdrawal { venue: Venue; account: string; amount: string; fee: string | null; status: string; done: boolean; failed: boolean; timestamp: number; txHash: string | null }

const MIN: Record<Venue, number> = { lighter: 1, derive: 5 };
const INFO: Record<Venue, string> = {
  lighter: 'Secure withdrawal from the main account · arrives in about 26 min · perps allows 3 withdrawals per 2 hours',
  derive: 'Arrives in about 14 min · options charges a fee of about $1 (capped at $3) from the amount',
};
const AMT = /^\d+(\.\d{1,6})?$/;
const newIdem = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function WithdrawFlow({ onBridge }: { onBridge: () => void }) {
  const { network } = useVenueNetwork();
  const { wallet, signIn } = useSession();
  const [venue, setVenue] = useState<Venue>('lighter');
  const [subId, setSubId] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [idem, setIdem] = useState(newIdem);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const lighter = useLighterAgentAccounts();
  const derive = useDeriveAccount();
  const history = useQuery({
    queryKey: ['withdrawals', network, venue, wallet], enabled: !!wallet, refetchInterval: 15_000,
    queryFn: async () => (await getJson<{ withdrawals: Withdrawal[] }>(`/api/trade/withdraw?network=${network}&venue=${venue}`)).withdrawals,
  });

  const master = lighter.data?.find((a) => a.isMaster);
  const subsWithFunds = (lighter.data ?? []).filter((a) => !a.isMaster && Number(a.available) > 0);
  const deriveSubs = useMemo(() => (derive.data?.subaccounts ?? []).filter((s) => Number(s.collaterals_value) > 0), [derive.data]);
  const sub = deriveSubs.find((s) => s.subaccount_id === subId) ?? deriveSubs[0];

  // Withdrawable = what the venue will release: Lighter's available balance; on Derive, USDC held capped by free margin.
  const max = venue === 'lighter'
    ? Number(master?.available ?? 0)
    : sub ? Math.min(Number(sub.collaterals.find((c) => c.asset_name === 'USDC')?.amount ?? 0), Math.max(0, Number(sub.initial_margin))) : 0;
  const n = AMT.test(amount) ? Number(amount) : null;
  const problem = n === null ? null : n < MIN[venue] ? `Withdraw at least ${MIN[venue]} USDC.` : n > max ? `Only ${max.toFixed(2)} USDC can be withdrawn right now.` : null;
  const ready = venue === 'lighter' ? master?.agent === 'active' : derive.data?.state === 'ok';

  function change(v: string) { setAmount(v); setMsg(null); setIdem(newIdem()); }

  async function submit() {
    if (n === null || problem || busy) return;
    setBusy(true); setMsg(null);
    try {
      const body = { network, venue, amount, ...(venue === 'derive' ? { subaccountId: sub?.subaccount_id } : {}) };
      await getJson('/api/trade/withdraw', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idem }, body: JSON.stringify(body) });
      setMsg({ kind: 'ok', text: `Withdrawal of ${amount} USDC sent. It lands in your Ethereum wallet in about ${venue === 'lighter' ? '26' : '14'} min.` });
      setAmount(''); setIdem(newIdem()); void history.refetch();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(false); }
  }

  if (!wallet) return <div><h2 className="text-xl font-semibold">Withdraw from a venue</h2><p className="my-3 text-sm text-muted">Sign in first.</p><button className="btn-primary" onClick={() => void signIn()}>Sign in</button></div>;

  return (
    <div className="mx-auto max-w-lg">
      <h2 className="mb-1 text-xl font-semibold">Withdraw from a venue</h2>
      <p className="mb-4 text-sm text-muted">Sends USDC back to your own wallet on {network === 'testnet' ? 'Sepolia' : 'Ethereum'}. No MetaMask popup: your agent key signs, and it can only pay you.</p>

      <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-bg p-1 text-sm">
        {(['lighter', 'derive'] as const).map((v) => (
          <button key={v} onClick={() => { setVenue(v); change(''); }} className={clsx('rounded-lg py-2', venue === v ? 'bg-panel2 text-white' : 'text-muted hover:text-white')}>{v === 'lighter' ? 'Perps' : 'Options'}</button>
        ))}
      </div>

      <div className="rounded-2xl bg-bg p-4">
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
          {venue === 'lighter'
            ? <span>From {master ? `Main #${master.index}` : 'your perps main account'}</span>
            : <select className="rounded-lg bg-panel2 px-2 py-1 text-xs text-white" value={sub?.subaccount_id ?? ''} onChange={(e) => { setSubId(Number(e.target.value)); change(''); }}>
                {deriveSubs.length === 0 && <option value="">No funded subaccount</option>}
                {deriveSubs.map((s) => <option key={s.subaccount_id} value={s.subaccount_id}>#{s.subaccount_id} · {s.universeName ?? (s.isFallback ? 'fallback' : 'subaccount')} · ${Number(s.collaterals_value).toFixed(2)}</option>)}
              </select>}
          <button onClick={() => change(max > 0 ? (Math.floor(max * 1e6) / 1e6).toString() : '')}>Withdrawable: {max.toFixed(2)} USDC</button>
        </div>
        <div className="flex items-center gap-3"><input className="w-full bg-transparent text-3xl outline-none num" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => change(e.target.value)} /><span className="pill bg-panel2">USDC</span></div>
      </div>
      <div className="my-2 flex justify-center"><ArrowDown className="text-muted" /></div>
      <div className="rounded-2xl bg-bg p-4 text-sm">
        <div className="text-xs text-muted">To</div><div className="mt-1">Your wallet on {network === 'testnet' ? 'Sepolia' : 'Ethereum'} (the account owner, fixed by the venue)</div>
        <div className="mt-2 text-xs text-muted">{INFO[venue]}</div>
      </div>

      {venue === 'lighter' && subsWithFunds.length > 0 && <p className="mt-3 text-xs text-muted">Funds in sub-accounts ({subsWithFunds.map((a) => `#${a.index}`).join(', ')}) withdraw from Main. Move them to Main first under Perps → Sub-accounts.</p>}
      {!ready && <p className="mt-3 text-xs text-accent">{venue === 'lighter' ? 'Register your perps agent key on the Agent keys page first.' : 'Register your options agent key on the Agent keys page first.'}</p>}
      {problem && <p className="mt-3 text-xs text-accent">{problem}</p>}

      <button className="btn-primary mt-4 w-full" disabled={!ready || n === null || !!problem || busy || (venue === 'derive' && !sub)} onClick={() => void submit()}>
        {busy ? 'Sending…' : 'Withdraw to my Ethereum wallet'}
      </button>
      {msg && <div className={clsx('mt-3 rounded-xl px-3 py-2 text-xs', msg.kind === 'ok' ? 'bg-up/10 text-up' : 'bg-down/10 text-down')}>{msg.text}</div>}

      <div className="mt-4 rounded-xl border border-line p-3 text-xs">
        <div className="font-medium">Then bring it to BNB Chain</div>
        <p className="mt-1 text-muted">Once it arrives, bridge it with Relay. You sign that step and pay a little ETH gas.</p>
        <button className="btn-ghost mt-2 w-full py-2 text-xs" disabled={network === 'testnet'} onClick={onBridge}>{network === 'testnet' ? 'Ethereum → BNB is mainnet only' : 'Open Ethereum → BNB'}</button>
      </div>

      <div className="mt-4">
        <div className="mb-1 text-xs text-muted">Recent {venue === 'lighter' ? 'perps' : 'options'} withdrawals</div>
        {history.isLoading ? <p className="text-xs text-muted">Loading…</p>
          : history.error ? <p className="text-xs text-down">{(history.error as Error).message}</p>
          : !history.data?.length ? <p className="text-xs text-muted">None yet.</p>
          : <div className="space-y-1">{history.data.slice(0, 8).map((w, i) => (
              <div key={`${w.timestamp}-${i}`} className="flex items-center justify-between rounded-lg bg-bg px-3 py-2 text-xs">
                <span className="num">{Number(w.amount).toFixed(2)} USDC{w.fee ? <span className="text-muted"> · fee {Number(w.fee).toFixed(2)}</span> : null}</span>
                <span className="text-muted">{new Date(w.timestamp).toLocaleString()}</span>
                <span className={w.failed ? 'text-down' : w.done ? 'text-up' : 'text-accent'} title={w.status === 'claimable' ? 'Ready on Ethereum. The venue normally completes the claim; if it stays here for hours, claim it on app.lighter.xyz.' : undefined}>
                  {w.status === 'claimable' ? 'ready on Ethereum' : w.status}
                </span>
              </div>
            ))}</div>}
      </div>
    </div>
  );
}
