'use client';
import { useState } from 'react';
import { useAccount, useReadContracts } from 'wagmi';
import { erc20Abi, type Address } from 'viem';
import clsx from 'clsx';
import { ArrowDown } from 'lucide-react';
import { useVenueNetwork } from '@/lib/network';
import { useSession } from '@/lib/session';
import { useBscBalances } from '@/lib/hooks/useBscBalances';
import { getJson, useLighterAccount, useDeriveAccount } from '@/lib/hooks/useVenues';
import { useTxRunner, type Log } from '@/components/funding/useTxRunner';
import { WithdrawFlow } from '@/components/funding/WithdrawFlow';
import { DERIVE, DERIVE_DEFAULT_MANAGER_ID, DERIVE_USDC_ASSET, LIGHTER, LIGHTER_USDC_ASSET } from '@/lib/venues';
import { DERIVE_ACTION_MANAGER_ABI, LIGHTER_DEPOSIT_ABI, MOCK_MINT_ABI } from '@/lib/l1';
import { fmtUnits, safeParseUnits } from '@/lib/format';
import type { BridgeRoute, RelayQuote } from '@/lib/relay';

type Flow = 'bsc_to_lighter' | 'bsc_to_eth' | 'eth_to_lighter' | 'eth_to_derive' | 'withdraw' | 'eth_to_bsc';
const FLOWS: { id: Flow; title: string; sub: string; mainnetOnly?: boolean }[] = [
  { id: 'bsc_to_lighter', title: 'BNB → Perps', sub: 'Relay delivers straight into your perps account · ~1 min', mainnetOnly: true },
  { id: 'bsc_to_eth', title: 'BNB → Ethereum', sub: 'Relay · for options, or your first perps deposit', mainnetOnly: true },
  { id: 'eth_to_lighter', title: 'Ethereum → Perps', sub: 'Direct deposit · creates the account' },
  { id: 'eth_to_derive', title: 'Ethereum → Options', sub: 'Direct deposit via ActionManager · ~2 min' },
  { id: 'withdraw', title: 'Perps / Options → Ethereum', sub: 'Withdraw to your own wallet · 14–26 min' },
  { id: 'eth_to_bsc', title: 'Ethereum → BNB', sub: 'Relay · bring venue withdrawals home', mainnetOnly: true },
];

export default function FundingPage() {
  const { network } = useVenueNetwork();
  const [flow, setFlow] = useState<Flow>(network === 'testnet' ? 'eth_to_lighter' : 'bsc_to_lighter');
  const testnet = network === 'testnet';
  return (
    <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[320px_1fr]">
      <div className="lg:col-span-2"><WhereMoneyIs /></div>
      <div className="panel p-3 h-fit">
        <div className="px-2 pb-2 text-sm text-muted">Move USDC</div>
        {FLOWS.map((f) => {
          const disabled = testnet && f.mainnetOnly;
          return (
            <button key={f.id} disabled={disabled} onClick={() => setFlow(f.id)}
              className={clsx('w-full rounded-xl px-3 py-3 text-left disabled:opacity-40', flow === f.id ? 'bg-panel2' : 'hover:bg-panel2/50')}>
              <div className="font-medium">{f.title}</div><div className="text-xs text-muted">{disabled ? 'Mainnet only: Relay has no testnet route for this' : f.sub}</div>
            </button>
          );
        })}
        {testnet && <TestnetFaucets />}
      </div>
      <div className="panel p-6">
        {flow === 'bsc_to_lighter' || flow === 'bsc_to_eth' || flow === 'eth_to_bsc' ? <RelayFlow route={flow} />
          : flow === 'withdraw' ? <WithdrawFlow onBridge={() => setFlow('eth_to_bsc')} />
          : flow === 'eth_to_lighter' ? <LighterDirect /> : <DeriveDirect />}
      </div>
    </div>
  );
}

/** Every place USDC can sit, all owned by the same MetaMask address. The app never holds funds. */
function WhereMoneyIs() {
  const { network } = useVenueNetwork();
  const { address } = useAccount();
  const bsc = useBscBalances();
  const l1 = useL1Usdc(LIGHTER[network].usdc, LIGHTER[network].l1ChainId);
  const dl1 = useL1Usdc(DERIVE[network].usdc, DERIVE[network].chainId);
  const lighter = useLighterAccount(address);
  const derive = useDeriveAccount();
  const l1Name = network === 'testnet' ? 'Sepolia' : 'Ethereum';
  const box = (title: string, sub: string, value: string, note: string, accent?: boolean) => (
    <div className={clsx('min-w-[170px] flex-1 rounded-xl p-3', accent ? 'border border-accent/30 bg-accent/10' : 'bg-bg')}>
      <div className="text-xs text-muted">{sub}</div><div className="font-medium">{title}</div>
      <div className="num mt-1 text-lg">{value}</div><div className="text-[11px] text-muted">{note}</div>
    </div>
  );
  const arrow = <div className="hidden self-center text-muted md:block">→</div>;
  const ds = derive.data?.subaccount;
  const deriveVal = ds ? `$${Number(ds.collaterals_value).toFixed(2)}` : derive.data?.state === 'no_account' ? 'no account' : derive.data?.state === 'needs_agent' ? 'agent needed' : '—';
  return (
    <div className="panel p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium">Where your money is</div>
        <div className="text-xs text-muted">All owned by your MetaMask address. Pulse Risk never holds funds; it only moves them between your own accounts.</div>
      </div>
      <div className="flex flex-wrap gap-2 md:flex-nowrap">
        {box('BNB Chain wallet', 'MetaMask · mainnet', `${fmtUnits(bsc.usdc, 18, 2)} USDC`, 'bStocks collateral + rebalance source')}
        {arrow}
        {box(`${l1Name} wallet`, 'MetaMask · L1',
          network === 'testnet' ? `${fmtUnits(l1.bal ?? null, l1.dec, 2)} / ${fmtUnits(dl1.bal ?? null, dl1.dec, 2)}` : `${fmtUnits(l1.bal ?? null, l1.dec, 2)} USDC`,
          network === 'testnet' ? 'perps test USDC / options mock USDC' : 'transit: Relay lands here for options')}
        {arrow}
        <div className="flex flex-1 flex-col gap-2 sm:flex-row">
          {box('Perps account', lighter.data ? `#${lighter.data.index} · perps margin` : 'perps margin',
            lighter.data ? `$${Number(lighter.data.collateral).toFixed(2)}` : lighter.isLoading ? '—' : 'no account', 'on perps (zk L2 of Ethereum)', true)}
          {box('Options subaccount', ds ? `#${ds.subaccount_id} · options margin` : 'options margin', deriveVal, 'on options (settles to Ethereum)', true)}
        </div>
      </div>
    </div>
  );
}

function Logs({ logs }: { logs: Log[] }) {
  if (!logs.length) return null;
  return (
    <div className="mt-4 space-y-1 rounded-xl bg-bg p-3 text-xs">
      {logs.map((l, i) => <div key={i} className={l.kind === 'err' ? 'text-down' : l.kind === 'ok' ? 'text-up' : 'text-[#c9ccd6]'}>
        {l.text} {l.href && <a href={l.href} target="_blank" rel="noreferrer" className="underline">view ↗</a>}</div>)}
    </div>
  );
}

function AmountBox({ label, value, onChange, balance, unit }: { label: string; value: string; onChange: (v: string) => void; balance: string; unit: string }) {
  return (
    <div className="rounded-2xl bg-bg p-4">
      <div className="mb-2 flex justify-between text-xs text-muted"><span>{label}</span><button onClick={() => onChange(balance.replace(/,/g, ''))}>Balance: {balance} {unit}</button></div>
      <div className="flex items-center gap-3"><input className="w-full bg-transparent text-3xl outline-none num" inputMode="decimal" placeholder="0" value={value} onChange={(e) => onChange(e.target.value)} /><span className="pill bg-panel2">{unit}</span></div>
    </div>
  );
}

/** Ethereum USDC balance for the connected wallet on the venue network's L1. */
function useL1Usdc(usdc: Address, chainId: number) {
  const { address } = useAccount();
  const r = useReadContracts({ contracts: address ? [{ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [address], chainId: chainId as 1 }, { address: usdc, abi: erc20Abi, functionName: 'decimals', chainId: chainId as 1 }] : [], query: { enabled: !!address, refetchInterval: 5_000 } });
  return { bal: r.data?.[0]?.result as bigint | undefined, dec: (r.data?.[1]?.result as number | undefined) ?? 6, refetch: r.refetch };
}

function RelayFlow({ route }: { route: BridgeRoute }) {
  const { address } = useAccount();
  const { wallet, signIn } = useSession();
  const bsc = useBscBalances();
  const eth = useL1Usdc(LIGHTER.mainnet.usdc, 1);
  const lighter = useLighterAccount(address);
  const tx = useTxRunner();
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<RelayQuote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fromBsc = route !== 'eth_to_bsc';
  const inDec = fromBsc ? 18 : 6;
  const units = safeParseUnits(amount, inDec);
  const bal = fromBsc ? bsc.usdc : eth.bal ?? null;
  const dest = route === 'bsc_to_lighter' ? `Perps account #${lighter.data?.index ?? '—'}` : route === 'bsc_to_eth' ? 'Ethereum USDC (your wallet)' : 'BNB Chain USDC (your wallet)';

  async function getQuote() {
    setErr(null); setQuote(null);
    if (!units) return;
    try { setQuote(await getJson<RelayQuote>('/api/relay/quote', { method: 'POST', body: JSON.stringify({ route, amount: units.toString() }) })); }
    catch (e) { setErr((e as Error).message); }
  }
  async function execute() {
    if (!quote) return;
    await tx.run(async () => {
      for (const s of quote.steps) await tx.raw(s.chainId, s.id === 'approve' ? 'Approve USDC (exact amount)' : 'Bridge deposit', s.to, s.data);
      tx.log({ text: 'Waiting for Relay to fill on the destination…', kind: 'info' });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 3_000));
        const st = await getJson<{ status: string }>(`/api/relay/status?requestId=${quote.requestId}`).catch(() => ({ status: 'unknown' }));
        if (st.status === 'success') { tx.log({ text: `Delivered to ${dest}`, kind: 'ok' }); bsc.refetch(); void eth.refetch(); return; }
        if (st.status === 'refund') { tx.log({ text: 'Relay refunded the deposit', kind: 'err' }); return; }
      }
      tx.log({ text: 'Still pending after 3 min. Check relay.link for request ' + quote.requestId, kind: 'err' });
    });
    setQuote(null);
  }

  if (!wallet) return <div><h2 className="text-xl font-semibold">Bridge with Relay</h2><p className="my-3 text-sm text-muted">Sign in first so the quote is bound to your wallet.</p><button className="btn-primary" onClick={() => void signIn()}>Sign in</button></div>;
  return (
    <div className="mx-auto max-w-lg">
      <h2 className="mb-4 text-xl font-semibold">{FLOWS.find((f) => f.id === route)?.title}</h2>
      <AmountBox label={fromBsc ? 'From BNB Chain' : 'From Ethereum'} value={amount} onChange={(v) => { setAmount(v); setQuote(null); }} balance={fmtUnits(bal, inDec, 2)} unit="USDC" />
      <div className="my-2 flex justify-center"><ArrowDown className="text-muted" /></div>
      <div className="rounded-2xl bg-bg p-4">
        <div className="text-xs text-muted">To</div><div className="mt-1">{dest}</div>
        {quote && <div className="mt-3 space-y-1 text-sm num">
          <div className="flex justify-between"><span className="text-muted">You receive</span><span>{fmtUnits(BigInt(quote.amountOut), quote.outDecimals, 4)} USDC</span></div>
          <div className="flex justify-between"><span className="text-muted">Guaranteed minimum</span><span>{fmtUnits(BigInt(quote.minOut || '0'), quote.outDecimals, 4)}</span></div>
          <div className="flex justify-between"><span className="text-muted">Relay fee</span><span>${Number(quote.feeUsd).toFixed(3)}</span></div>
          <div className="flex justify-between"><span className="text-muted">ETA</span><span>~{quote.timeEstimateSec}s</span></div>
        </div>}
      </div>
      {route === 'bsc_to_lighter' && lighter.data === null && <p className="mt-3 text-xs text-accent">You don&apos;t have a perps account yet. Bridge BNB → Ethereum first, then use Ethereum → Perps; that first deposit creates the account.</p>}
      <div className="mt-4 flex gap-2">
        <button className="btn-ghost flex-1" disabled={!units || tx.busy} onClick={() => void getQuote()}>Get quote</button>
        <button className="btn-primary flex-1" disabled={!quote || tx.busy || (bal !== null && units !== null && units > bal)} onClick={() => void execute()}>{tx.busy ? 'Working…' : 'Bridge'}</button>
      </div>
      {err && <div className="mt-3 rounded-xl bg-down/10 px-3 py-2 text-xs text-down">{err}</div>}
      <Logs logs={tx.logs} />
      <p className="mt-4 text-[11px] text-muted">Each Relay step is checked server-side (router, token, amount, depositor) before MetaMask sees it. The approval is for the exact amount.</p>
    </div>
  );
}

function LighterDirect() {
  const { network } = useVenueNetwork();
  const { address } = useAccount();
  const cfg = LIGHTER[network];
  const l1 = useL1Usdc(cfg.usdc, cfg.l1ChainId);
  const lighter = useLighterAccount(address);
  const tx = useTxRunner();
  const [amount, setAmount] = useState('');
  const units = safeParseUnits(amount, l1.dec);
  const min = 5n * 10n ** BigInt(l1.dec);
  async function go() {
    if (!units || !address) return;
    await tx.run(async () => {
      await tx.call(cfg.l1ChainId, 'Approve USDC (exact amount)', cfg.usdc, erc20Abi, 'approve', [cfg.zkLighter, units]);
      await tx.call(cfg.l1ChainId, 'Deposit to perps', cfg.zkLighter, LIGHTER_DEPOSIT_ABI, 'deposit', [address, LIGHTER_USDC_ASSET, 0, units]);
      tx.log({ text: 'Perps credits L1 deposits in a few minutes. Your balance updates on the Portfolio page.', kind: 'ok' });
    });
  }
  return (
    <div className="mx-auto max-w-lg">
      <h2 className="mb-1 text-xl font-semibold">Ethereum → Perps</h2>
      <p className="mb-4 text-sm text-muted">{network === 'testnet' ? 'Sepolia' : 'Ethereum mainnet'} · {lighter.data ? `account #${lighter.data.index}` : 'creates your perps account'} · gas paid in {network === 'testnet' ? 'Sepolia ' : ''}ETH</p>
      <AmountBox label={`USDC on ${network === 'testnet' ? 'Sepolia' : 'Ethereum'}`} value={amount} onChange={setAmount} balance={fmtUnits(l1.bal ?? null, l1.dec, 2)} unit="USDC" />
      {units !== null && units < min && <p className="mt-2 text-xs text-accent">Use at least 5 USDC (perps minimum).</p>}
      <button className="btn-primary mt-4 w-full" disabled={!units || units < min || tx.busy || (l1.bal !== undefined && units > l1.bal)} onClick={() => void go()}>{tx.busy ? 'Working…' : 'Approve & deposit'}</button>
      <Logs logs={tx.logs} />
    </div>
  );
}

function DeriveDirect() {
  const { network } = useVenueNetwork();
  const { address } = useAccount();
  const cfg = DERIVE[network];
  const l1 = useL1Usdc(cfg.usdc, cfg.chainId);
  const acct = useDeriveAccount();
  const tx = useTxRunner();
  const [amount, setAmount] = useState('');
  const units = safeParseUnits(amount, l1.dec);
  const min = 7n * 10n ** BigInt(l1.dec); // live min_deposit_usd is 5; below it the deposit is donated, so keep a margin
  const existing = acct.data?.state === 'ok' || acct.data?.state === 'needs_agent';
  async function go() {
    if (!units || !address) return;
    await tx.run(async () => {
      await tx.call(cfg.chainId, 'Approve USDC (exact amount)', cfg.usdc, erc20Abi, 'approve', [cfg.actionManager, units]);
      await tx.call(cfg.chainId, 'Deposit to options', cfg.actionManager, DERIVE_ACTION_MANAGER_ABI, 'depositToNewSubaccount', [DERIVE_USDC_ASSET, units, DERIVE_DEFAULT_MANAGER_ID, address]);
      tx.log({ text: 'Options credits L1 deposits in ~1.5–2 min.', kind: 'ok' });
    });
  }
  return (
    <div className="mx-auto max-w-lg">
      <h2 className="mb-1 text-xl font-semibold">Ethereum → Options</h2>
      <p className="mb-4 text-sm text-muted">{network === 'testnet' ? 'Sepolia (options mock USDC)' : 'Ethereum mainnet'} · Standard margin, PRIME universe (BTC/ETH options + perps)</p>
      <AmountBox label="USDC" value={amount} onChange={setAmount} balance={fmtUnits(l1.bal ?? null, l1.dec, 2)} unit="USDC" />
      {units !== null && units < min && <p className="mt-2 text-xs text-accent">Deposit at least 7 USDC. Below the options live minimum ($5), the deposit is lost.</p>}
      {existing && <p className="mt-2 text-xs text-muted">Each direct deposit opens a new subaccount. The agent consolidates into your trading subaccount with transfer_spot.</p>}
      <button className="btn-primary mt-4 w-full" disabled={!units || units < min || tx.busy || (l1.bal !== undefined && units > l1.bal)} onClick={() => void go()}>{tx.busy ? 'Working…' : 'Approve & deposit'}</button>
      <Logs logs={tx.logs} />
    </div>
  );
}

function TestnetFaucets() {
  const { address } = useAccount();
  const tx = useTxRunner();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="mt-3 border-t border-line px-2 pt-3 text-xs">
      <div className="mb-2 text-muted">Testnet faucets (need Sepolia ETH for gas)</div>
      <button className="btn-ghost mb-2 w-full py-2 text-xs" disabled={!address} onClick={async () => {
        const r: { code?: number; message?: string } = await getJson<{ code?: number; message?: string }>(`/api/lighter/faucet?network=testnet&l1_address=${address}`).catch((e: Error) => ({ message: e.message }));
        setMsg(`Perps faucet: ${r.message ?? r.code ?? 'requested'}`);
      }}>Perps testnet funds</button>
      <button className="btn-ghost w-full py-2 text-xs" disabled={!address || tx.busy} onClick={() => void tx.run(() => tx.call(11155111, 'Mint 1,000 options mock USDC', DERIVE.testnet.usdc, MOCK_MINT_ABI, 'mint', [address, 1_000_000_000n]))}>Mint options mock USDC</button>
      {msg && <div className="mt-2 text-muted">{msg}</div>}
      <Logs logs={tx.logs} />
    </div>
  );
}
