import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import { marked, Renderer } from 'marked';

// Markdown from the model, rendered safely: raw HTML is escaped, images are dropped, only http(s) links survive.
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const renderer = new Renderer();
renderer.html = ({ text }) => esc(text);
renderer.image = () => '';
renderer.link = ({ href, text }) => (/^https?:\/\//i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text);
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text, { renderer, gfm: true, breaks: true, async: false }) as string, [text]);
  return <div className="md break-words [&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-bg [&_code]:px-1 [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_p+ul]:mt-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-bg [&_pre]:p-2 [&_table]:my-2 [&_table]:w-full [&_table]:text-xs [&_td]:border [&_td]:border-line [&_td]:px-1.5 [&_td]:py-0.5 [&_th]:border [&_th]:border-line [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: html }} />;
}

const usd = (n: number | null | undefined, dp = 0) => (n === null || n === undefined ? '-' : `$${n.toLocaleString('en-US', { maximumFractionDigits: dp })}`);
export interface CardView {
  portfolioUsd: number; hedgedPct: number; requiredHedgePct: number; varPct: number; limitPct: number; mode: 'autonomous' | 'confirm'; killSwitch: boolean;
  holdings: { ticker: string; usd: number; hedgedPct: number }[]; nextEvent: { ticker: string; kind: string; inHours: number } | null;
  limits: { maxPerTradeUsd: number; maxPerDayUsd: number; maxLeverage: number; dailyLossCapUsd: number; weeklyBudgetPct: number; lossTolerancePct: number };
}
export interface CardScenario { kind: 'current' | 'mock'; live: boolean; view: CardView | null; inputs: string[]; decision: string; outcome: string; reasons: string[]; why: string | null; limitMet: boolean | null; plan: { instrument?: string; sizeUsd?: number; varBeforePct?: number; varAfterPct?: number; limitPct?: number; costUsd?: number; budgetUsd?: number } | null }
export interface CardPending { id: number; plan: { instrument?: string } | null }
type Tab = 'Home' | 'Hedges' | 'Activity' | 'Limits';

/** The hedge proposal card: Home, Hedges, Activity and Limits tabs, with Approve, Edit size and Decline on the Hedges tab. Approve only ever
 *  acts on a real pending request from the live agent (the same one the Risk page shows); on a test it says so and does nothing. */
export function HedgeCard({ s, pending, result, busy, onApprove, onDecline, onEdit }: { s: CardScenario; pending: CardPending | undefined; result: string | undefined; busy: boolean; onApprove: (id: number) => void; onDecline: (id: number | null) => void; onEdit: (size: number) => void }) {
  const [tab, setTab] = useState<Tab>(s.plan ? 'Hedges' : 'Home'); const [editing, setEditing] = useState(false); const [size, setSize] = useState(String(Math.round(s.plan?.sizeUsd ?? 0))); const [dismissed, setDismissed] = useState(false);
  const v = s.view; const p = s.plan; const test = s.kind === 'mock' || !s.live;
  const pill = 'rounded-full border px-2 py-0.5 text-[11px]';
  return (
    <div className="mt-2 rounded-xl border border-line bg-bg text-xs">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="text-sm font-semibold">{p ? 'Hedge proposal' : 'Hedge agent'}</div>
        <div className="flex items-center gap-1.5">{test && <span className={clsx(pill, 'border-yellow-400/60 text-yellow-400')}>{s.kind === 'mock' ? 'Mock test' : 'Test'}</span>}<span className={clsx(pill, v?.killSwitch ? 'border-down text-down' : 'border-line text-muted')}>Kill switch {v?.killSwitch ? 'ON' : 'off'}</span></div>
      </div>
      <div className="px-3 py-2.5">
        {tab === 'Home' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between"><span className="text-muted">Mode</span><span className="flex overflow-hidden rounded-full border border-line"><span className={clsx('px-2.5 py-0.5', v?.mode !== 'autonomous' && 'bg-accent/25 font-semibold')}>Confirm</span><span className={clsx('px-2.5 py-0.5', v?.mode === 'autonomous' && 'bg-accent/25 font-semibold')}>Auto</span></span></div>
            {v ? <>
              <div className="flex items-center justify-between"><span className="font-semibold">Portfolio {usd(v.portfolioUsd)}</span><span className="text-muted">Hedged {v.hedgedPct}%</span></div>
              <ul className="space-y-1">{v.holdings.length === 0 && <li className="text-muted">No holdings.</li>}{v.holdings.map((h) => <li key={h.ticker} className="flex items-center justify-between"><span>{h.ticker} <span className="text-muted">{usd(h.usd)}</span></span><span className={clsx(pill, h.hedgedPct >= 1 ? 'border-up/60 text-up' : 'border-yellow-400/60 text-yellow-400')}>{h.hedgedPct >= 1 ? `Hedged ${h.hedgedPct}%` : 'Unhedged'}</span></li>)}</ul>
              <div className="flex items-center justify-between border-t border-line pt-2"><span>Event VaR {v.varPct}%</span><span className="text-muted">Your limit {v.limitPct}%</span></div>
              {v.nextEvent && <div className="text-muted">{v.nextEvent.ticker} {v.nextEvent.kind} in {Math.round(v.nextEvent.inHours)}h.</div>}
            </> : <div className="text-muted">No portfolio numbers for this run.</div>}
          </div>)}
        {tab === 'Hedges' && (p ? (
          <div className="space-y-2">
            <div><div className="text-sm font-semibold">{s.decision}</div><div className="text-muted">{p.instrument} {usd(p.sizeUsd)} notional{v && v.portfolioUsd > 0 && p.sizeUsd ? `, ${Math.round((p.sizeUsd / v.portfolioUsd) * 1000) / 10}% of portfolio` : ''}</div></div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted">Cost</dt><dd className="text-right">{usd(p.costUsd, 2)}{p.budgetUsd ? <span className="text-muted"> of {usd(p.budgetUsd)} weekly budget</span> : ''}</dd>
              <dt className="text-muted">Event VaR</dt><dd className="text-right">{p.varBeforePct}% to {p.varAfterPct}%</dd>
              <dt className="text-muted">Your limit</dt><dd className="text-right">{p.limitPct}%{s.limitMet !== null && <span className={clsx('ml-1.5', s.limitMet ? 'text-up' : 'text-down')}>{s.limitMet ? 'met' : 'NOT met'}</span>}</dd>
            </dl>
            {s.why && <details className="text-muted"><summary className="cursor-pointer">Why</summary><p className="mt-1">{s.why}</p></details>}
            {result ? <div className="flex items-center gap-1 text-up"><Check size={13} />{result}</div>
              : dismissed ? <div className="text-muted">Declined. Nothing was sent.</div>
              : <>
                {editing && <div className="flex items-center gap-2"><span className="text-muted">Size $</span><input value={size} onChange={(e) => setSize(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" className="w-24 rounded border border-line bg-panel px-2 py-1 outline-none" /><button type="button" disabled={!Number(size)} onClick={() => { onEdit(Number(size)); setEditing(false); }} className="rounded-full border border-accent px-3 py-1 font-semibold disabled:opacity-40">Re-run</button></div>}
                <div className="flex gap-2">
                  <button type="button" disabled={!pending || busy} onClick={() => pending && onApprove(pending.id)} title={pending ? undefined : 'Only a live request from the agent can be approved'} className="flex-1 rounded-full border border-accent bg-accent/20 py-1.5 text-sm font-semibold disabled:opacity-40">{busy ? '...' : 'Approve'}</button>
                  <button type="button" onClick={() => setEditing((x) => !x)} className="rounded-full border border-line px-3 py-1.5">Edit size</button>
                  <button type="button" disabled={busy} onClick={() => { onDecline(pending?.id ?? null); if (!pending) setDismissed(true); }} className="rounded-full border border-line px-3 py-1.5">Decline</button>
                </div>
                <div className="text-muted">{pending ? 'Confirmation mode: nothing executes until you approve.' : test ? 'This is a test on numbers you gave, so there is nothing to approve. Nothing was sent or saved.' : 'The live agent has not raised this request yet. It checks every 30 seconds; it will appear here with Approve.'}</div>
              </>}
          </div>) : <div className="space-y-1"><div className="text-sm font-semibold">{s.decision}</div>{s.reasons.slice(0, 3).map((r) => <div key={r} className="text-muted">{r}</div>)}<div className="text-muted">No hedge to approve.</div></div>)}
        {tab === 'Activity' && (
          <div className="space-y-1.5">
            <div className="text-muted">Why the agent decided this ({s.outcome}):</div>
            <ul className="list-disc space-y-1 pl-4">{(s.reasons.length ? s.reasons : [s.why ?? s.decision]).map((r) => <li key={r}>{r}</li>)}</ul>
            <div className="text-muted">Run on: {s.inputs.join('; ')}</div>
          </div>)}
        {tab === 'Limits' && (v ? (
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <dt className="text-muted">Loss tolerance</dt><dd>{v.limits.lossTolerancePct}% of portfolio</dd>
            <dt className="text-muted">Weekly premium budget</dt><dd>{v.limits.weeklyBudgetPct}% of portfolio</dd>
            <dt className="text-muted">Max per trade</dt><dd>{usd(v.limits.maxPerTradeUsd)}</dd>
            <dt className="text-muted">Max per day</dt><dd>{usd(v.limits.maxPerDayUsd)}</dd>
            <dt className="text-muted">Max leverage</dt><dd>{v.limits.maxLeverage}x</dd>
            <dt className="text-muted">Daily loss cap</dt><dd>{usd(v.limits.dailyLossCapUsd)}</dd>
          </dl>) : <div className="text-muted">No limits for this run.</div>)}
      </div>
      <div className="flex border-t border-line">{(['Home', 'Hedges', 'Activity', 'Limits'] as Tab[]).map((t) => <button key={t} type="button" onClick={() => setTab(t)} className={clsx('flex-1 py-2 text-[11px]', tab === t ? 'border-t-2 border-accent font-semibold text-white' : 'text-muted hover:text-white')}>{t}</button>)}</div>
    </div>
  );
}
