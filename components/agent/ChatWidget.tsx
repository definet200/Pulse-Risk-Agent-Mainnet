'use client';
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown, MessageCircle, Send, X } from 'lucide-react';
import { getJson } from '@/lib/hooks/useVenues';
import { useSession } from '@/lib/session';

// A compact "Ask agent" dropdown at the bottom right of every page. The agent decides what it needs: a greeting gets a plain reply, a question about
// your money reads your portfolio, a "what if" or a portfolio you type runs the real hedging agent on those numbers. When something waits for you it
// shows Approve and Decline here; in autonomous mode it shows what the agent has been doing. The chat itself never trades.
const usd = (n: number | null | undefined, dp = 0) => (n === null || n === undefined ? '-' : `$${n.toLocaleString('en-US', { maximumFractionDigits: dp })}`);
interface Fact { id: string; label: string; value: string }
interface Scenario { kind: 'current' | 'mock'; inputs: string[]; decision: string; outcome: string; reasons: string[]; why: string | null; limitMet: boolean | null; plan: { instrument?: string; sizeUsd?: number; varBeforePct?: number; varAfterPct?: number; limitPct?: number; costUsd?: number; budgetUsd?: number } | null }
interface Pending { id: number; title: string; why: string; helps: string; willDo: string[]; plan: { cost?: { premiumUsd: number; feesUsd: number }; varBeforePct?: number; varAfterPct?: number; limitPct?: number; instrument?: string; sizeUsd?: number; marginPlan?: { moveUsd: number; from: string; to: string } | null } | null }
interface Activity { actions: { id: number; status: string; title: string; created_at: number }[]; events: { id: number; kind: string; status: string | null; message: string; created_at: number }[] }
interface Reply { answer: string; cites: Fact[]; unsure: boolean; unsureReason: string | null; source: 'live' | null; sourceNote: string | null; steps: { tool: string; label: string }[]; scenarios: Scenario[]; usedTools: boolean; pending: Pending[]; activity: Activity | null }
interface Msg { role: 'user' | 'agent'; text: string; reply?: Reply; decided?: Record<number, string> }
const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };

function ScenarioCard({ s }: { s: Scenario }) {
  return (
    <div className="mt-2 rounded-lg border border-accent/40 bg-bg p-2.5 text-xs">
      <div className="mb-1 font-semibold text-accent">{s.kind === 'mock' ? 'Test on a mock portfolio' : 'Test on your portfolio'} (nothing sent or saved)</div>
      <ul className="list-disc pl-4 text-muted">{s.inputs.map((i) => <li key={i}>{i}</li>)}</ul>
      <div className="mt-1.5 text-sm font-semibold">{s.decision}</div>
      {s.plan && <div className="mt-1 text-muted">{s.plan.instrument} {usd(s.plan.sizeUsd)}. Modelled loss {s.plan.varBeforePct}% to {s.plan.varAfterPct}% (limit {s.plan.limitPct}%{s.limitMet !== null ? `, ${s.limitMet ? 'met' : 'NOT met'}` : ''}). Cost {usd(s.plan.costUsd, 2)} of {usd(s.plan.budgetUsd)} budget.</div>}
      {!s.plan && s.reasons[0] && <div className="mt-1 text-muted">{s.reasons[0]}</div>}
    </div>
  );
}

export function ChatWidget() {
  const { wallet, signIn } = useSession();
  const network = 'mainnet' as const;
  const [open, setOpen] = useState(false); const [msgs, setMsgs] = useState<Msg[]>([]); const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [deciding, setDeciding] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) end.current?.scrollIntoView({ block: 'nearest' }); }, [msgs, busy, open]);

  async function send(q: string) {
    const message = q.trim(); if (!message || busy) return;
    const history = msgs.slice(-8).map((m) => ({ role: m.role, text: m.text }));
    setMsgs((m) => [...m, { role: 'user', text: message }]); setText(''); setBusy(true);
    try {
      const reply = await getJson<Reply>('/api/agent/chat', { method: 'POST', body: JSON.stringify({ network, message, history }) });
      setMsgs((m) => [...m, { role: 'agent', text: reply.answer, reply }]);
    } catch (e) { setMsgs((m) => [...m, { role: 'agent', text: e instanceof Error ? e.message : String(e) }]); }
    finally { setBusy(false); }
  }
  async function decide(msgIndex: number, id: number, decision: 'approve' | 'reject') {
    setDeciding(id);
    let result: string;
    try { await getJson(`/api/agent/actions/${id}?network=${network}`, { method: 'POST', body: JSON.stringify({ decision }) }); result = decision === 'approve' ? 'Approved. The agent runs it on its next check (within about 30 seconds).' : 'Declined.'; }
    catch (e) { result = `Could not ${decision}: ${e instanceof Error ? e.message : String(e)}`; }
    setMsgs((m) => m.map((x, i) => (i === msgIndex ? { ...x, decided: { ...(x.decided ?? {}), [id]: result } } : x))); setDeciding(null);
  }

  return (
    <div className="fixed bottom-20 right-4 z-50 flex flex-col items-end gap-2">
      {open && (
        <div role="dialog" aria-label="Hedge agent chat" className="flex h-[36rem] max-h-[78vh] w-[28rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <div><div className="text-sm font-semibold">Pulse</div><div className="text-[11px] text-muted">Hedge agent · {network}</div></div>
            <button type="button" aria-label="Close chat" onClick={() => setOpen(false)} className="text-muted hover:text-white"><X size={16} /></button>
          </div>
          {!wallet && <div className="bg-yellow-400/10 px-3.5 py-1.5 text-[11px] text-yellow-400">Not signed in: I can only answer about your money from your live mainnet accounts. <button type="button" onClick={() => void signIn()} className="underline">Sign in</button></div>}
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {msgs.length === 0 && <div className="rounded-lg border border-line p-2.5 text-sm">Hi, I am Pulse, the hedging agent. Ask me about your portfolio, markets or hedging, or describe a portfolio and I will test it.</div>}
            {msgs.map((m, i) => m.role === 'user'
              ? <div key={i} className="ml-8 rounded-lg bg-accent/15 px-2.5 py-1.5 text-sm">{m.text}</div>
              : (
                <div key={i} className="mr-3 rounded-lg border border-line px-2.5 py-1.5 text-sm">
                  {m.reply && m.reply.steps.length > 0 && <div className="mb-1.5 flex flex-wrap gap-1">{m.reply.steps.map((s, k) => <span key={k} className="rounded-full bg-bg px-2 py-0.5 text-[11px] text-muted">{s.label}</span>)}</div>}
                  <p className="whitespace-pre-wrap">{m.text}</p>
                  {m.reply?.unsure && <div className="mt-2 rounded-md bg-yellow-400/10 px-2 py-1 text-xs text-yellow-400">Not sure: {m.reply.unsureReason}</div>}
                  {m.reply?.scenarios.map((s, k) => <ScenarioCard key={k} s={s} />)}
                  {m.reply?.pending.map((p) => (
                    <div key={p.id} className="mt-2 rounded-lg border border-accent/50 bg-bg p-2.5 text-xs">
                      <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Waiting for your approval</div>
                      <div className="text-sm font-semibold">{p.title}</div>
                      {p.plan && <div className="mt-1 text-muted">{p.plan.instrument} {usd(p.plan.sizeUsd)}. Cost {usd((p.plan.cost?.premiumUsd ?? 0) + (p.plan.cost?.feesUsd ?? 0), 2)}. Modelled loss {p.plan.varBeforePct}% to {p.plan.varAfterPct}% (limit {p.plan.limitPct}%).{p.plan.marginPlan ? ` Moves ${usd(p.plan.marginPlan.moveUsd)} ${p.plan.marginPlan.from} to ${p.plan.marginPlan.to} first.` : ''}</div>}
                      <details className="mt-1 text-muted"><summary className="cursor-pointer">Why and what runs</summary><p className="mt-1">{p.why}</p><ol className="mt-1 list-decimal pl-4">{p.willDo.map((x) => <li key={x}>{x}</li>)}</ol></details>
                      {m.decided?.[p.id]
                        ? <div className="mt-2 flex items-center gap-1 text-up"><Check size={13} />{m.decided[p.id]}</div>
                        : <div className="mt-2 flex gap-2">
                            <button type="button" disabled={deciding === p.id} onClick={() => void decide(i, p.id, 'approve')} className="flex-1 rounded-full border border-accent bg-accent/20 py-1.5 text-sm font-semibold">{deciding === p.id ? '...' : 'Approve'}</button>
                            <button type="button" disabled={deciding === p.id} onClick={() => void decide(i, p.id, 'reject')} className="rounded-full border border-line px-4 py-1.5 text-sm">Decline</button>
                          </div>}
                    </div>))}
                  {m.reply?.activity && (
                    <div className="mt-2 rounded-lg border border-line bg-bg p-2.5 text-xs">
                      <div className="mb-1 font-semibold text-muted">Recent agent activity</div>
                      <ul className="space-y-1">{m.reply.activity.events.length === 0 && m.reply.activity.actions.length === 0 && <li className="text-muted">Nothing recorded yet.</li>}
                        {m.reply.activity.actions.map((a) => <li key={`a${a.id}`} className="flex justify-between gap-2"><span className="truncate">{a.title}</span><span className="shrink-0 text-muted">{a.status} · {ago(a.created_at)}</span></li>)}
                        {m.reply.activity.events.map((e) => <li key={`e${e.id}`} className="flex justify-between gap-2"><span className="truncate">{e.message}</span><span className="shrink-0 text-muted">{ago(e.created_at)}</span></li>)}</ul>
                    </div>)}
                  {m.reply && m.reply.usedTools && (
                    <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">Data used ({m.reply.cites.length}){m.reply.source ? ' · live mainnet' : ''}</summary>
                      {m.reply.sourceNote && <div className="mt-1 text-yellow-400">{m.reply.sourceNote}</div>}
                      <ul className="mt-1 space-y-1">{m.reply.cites.map((c) => <li key={c.id}><span className="text-white">{c.label}:</span> {c.value}</li>)}{m.reply.cites.length === 0 && <li>No specific data was cited.</li>}</ul>
                    </details>)}
                </div>))}
            {busy && <div className="mr-3 rounded-lg border border-line px-2.5 py-1.5 text-sm text-muted">Thinking...</div>}
            <div ref={end} />
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void send(text); }} className="m-2.5 flex items-center gap-2 rounded-full border border-line px-3 py-1">
            <input value={text} onChange={(e) => setText(e.target.value)} disabled={busy} placeholder="Ask the agent" maxLength={1200} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" />
            <button type="submit" disabled={busy || !text.trim()} aria-label="Send" className="flex h-6 w-6 items-center justify-center rounded-full border border-accent text-accent disabled:opacity-40"><Send size={12} /></button>
          </form>
        </div>
      )}
      <button type="button" aria-label={open ? 'Close hedge agent chat' : 'Open hedge agent chat'} aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={clsx('flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-semibold shadow-lg transition', open ? 'border-line bg-panel text-white' : 'border-accent bg-accent text-black hover:brightness-110')}>
        <MessageCircle size={16} />Ask agent<ChevronDown size={15} className={clsx('transition-transform', !open && 'rotate-180')} />
      </button>
    </div>
  );
}
