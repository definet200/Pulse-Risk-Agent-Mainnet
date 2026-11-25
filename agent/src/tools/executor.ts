import { ruleKey } from '../../../lib/risk-rules';
import { config } from '../config';
import { getDeriveCreds, getLighterCreds, type LighterCreds } from './appApi';
import * as bsc from './bsc';
import * as derive from './derive';
import * as funding from './deriveFunding';
import { SELL_BUFFER, splitFunding, type SaleLeg } from './funding';
import * as lighter from './lighter';
import * as pancake from './pancake';
import * as relay from './relay';
import * as store from './store';
import type { Candidate, Snapshot, StepResult } from '../types';

// Runs the steps of ONE approved candidate. In a dry run nothing is signed or sent: each step is returned as
// 'simulated'. Live mode needs DRY_RUN=false AND ALLOW_LIVE=yes-i-understand. Every live step is recorded under
// its own idempotency key, so a crash and retry resumes instead of repeating a transfer.
// Margin comes from USDC, then USDT (swapped), then bStocks the user allowed (pulled to the agent wallet and sold for USDC).

const usd = (base: string) => `$${(Number(BigInt(base)) / 1e6).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const baseOfUsd = (x: number) => BigInt(Math.round(x * 100)) * 10_000n;

function fundingSteps(s: Snapshot, c: Pick<Candidate, 'amountBaseUnit' | 'funding'>, dest: string): string[] {
  const sp = splitFunding(c); const amt = usd(c.amountBaseUnit); const steps: string[] = [];
  if (sp.usdtBase > 0n) steps.push(`pull ${usd(sp.usdtBase.toString())} USDT from the user's BNB wallet, then swap it to USDC on PancakeSwap (0.01% pool, 0.5% max slippage)`);
  if (sp.usdcBase > 0n || (!sp.sales.length && sp.usdtBase === 0n)) steps.push(`pull ${usd((sp.usdcBase > 0n ? sp.usdcBase : BigInt(c.amountBaseUnit)).toString())} USDC from the user's BNB wallet via the on-chain allowance`);
  for (const l of sp.sales) steps.push(`pull ~$${((l.usd / (1 - s.config.collateral.bstockHaircut)) * SELL_BUFFER).toFixed(2)} of ${l.symbol} from the user's BNB wallet via the on-chain allowance, then sell it for USDC on PancakeSwap V3 (1% max slippage; a sale is final)`);
  steps.push(`bridge ${amt} BSC USDC → ${dest} via Relay (validate quote first)`);
  return steps;
}

export function describeSteps(s: Snapshot, c: Candidate): string[] {
  if (c.kind === 'hedge') {
    const h = c.hedge!; const mp = c.plan?.marginPlan;
    if (h.derive) {
      const q = Math.abs(h.deltaToShort);
      const sells = (h.derive.roll?.sell ?? []).map((x) => `sell ${x.amount} ${x.instrument} on Derive (reduce-only) because it is close to expiry`);
      const main = h.kind === 'perp' ? (h.deltaToShort > 0 ? `place a Derive market order (IOC, 2% through the touch) on the RWA subaccount: sell ${q} ${h.derive.instrument} (adds to your short hedge)` : `place a Derive market order (IOC, reduce-only): buy ${q} ${h.derive.instrument} (closes part of your short hedge)`) : `buy ${q} ${h.derive.instrument} (put) on Derive with an IOC order 2% through the ask`;
      return [...sells, main, 'check that the resulting Derive position matches the plan'];
    }
    const dest = h.option ? 'Derive subaccount (via Ethereum USDC)' : 'Lighter main account';
    const margin = mp ? [...fundingSteps(s, { amountBaseUnit: baseOfUsd(mp.moveUsd).toString(), funding: [{ source: 'bsc_usdc', amountUsd: mp.moveUsd }] }, dest), 'wait for Relay status = success'] : [];
    if (h.option) return [...margin, `buy ${h.option.contracts} ${h.market} put${h.option.contracts === 1 ? '' : 's'} (strike ${h.option.strike}, expires ${h.option.expiry.slice(0, 10)}) on Derive with a limit order at the ask $${h.option.ask}`, 'check the put position on Derive matches the plan'];
    const order = h.orderQtys && h.orderQtys.length > 1 ? `place ${h.orderQtys.length} Lighter market orders (${h.orderQtys.join(', ')} ${h.market}), one after another, each under your per-trade cap` : h.deltaToShort > 0 ? `place a Lighter market order: sell ${Math.abs(h.deltaToShort)} ${h.market} (adds to your short hedge)` : `place a Lighter market order: buy ${Math.abs(h.deltaToShort)} ${h.market} (closes part of your short hedge)`;
    return [...margin, order, 'check that the resulting position matches the plan'];
  }
  const rule = c.rule!; const amt = usd(c.amountBaseUnit);
  if (c.kind === 'top_up') {
    if (rule.venue === 'lighter') return [...fundingSteps(s, c, 'Lighter main account'), ...(rule.accountRef ? [`transfer ${amt} Lighter main → sub-account #${rule.accountRef}`] : []), 'wait for Relay status = success'];
    return [...fundingSteps(s, c, 'Ethereum USDC'), 'depositToNewSubaccount on Derive', `transfer_spot into subaccount ${rule.accountRef || 'default'}`];
  }
  return rule.venue === 'lighter' ? [`Lighter secure withdraw ${amt} to the user's Ethereum address (~26 min)`] : [`Derive private/withdraw ${amt} to the user's Ethereum address (~14 min)`];
}

async function once(key: string, label: string, fn: () => Promise<string | undefined>, out: StepResult[]): Promise<boolean> {
  const done = store.getStep(key);
  if (done?.status === 'done') { out.push({ step: label, status: 'done', detail: 'already done (resumed)', ref: done.ref ?? undefined }); return true; }
  try {
    const ref = await fn();
    store.saveStep(key, 'done', ref);
    out.push({ step: label, status: 'done', ref });
    return true;
  } catch (e) {
    out.push({ step: label, status: 'failed', detail: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * Put `usdcBase` of the user's USDC, swapped USDT and the proceeds of bStock sales onto the Lighter main account
 * (one Relay bridge). A sale is final, so there is no rollback: a failed step stops the move and is reported.
 */
export async function fundLighterMain(s: Snapshot, k: string, creds: LighterCreds, usdcBase: bigint, sales: SaleLeg[], out: StepResult[], usdtBase = 0n): Promise<boolean> {
  const agent = bsc.agentAddress(); if (!agent) throw new Error('AGENT_BSC_PRIVATE_KEY is not set');
  const totalWei = await collectOnAgent(s, k, usdcBase, sales, out, usdtBase);
  if (totalWei === null) return false;

  // One bridge for everything.
  let requestId = '';
  const bridged = await once(`${k}:bridge`, 'Bridge via Relay', async () => {
    const req = { depositor: agent, recipientAccountIndex: String(creds.accountIndex), amountWei: totalWei };
    const v = relay.validateQuote(await relay.getQuote(req), req);
    requestId = v.requestId; await relay.executeSteps(v); return v.requestId;
  }, out);
  if (!bridged) return false;
  requestId ||= store.getStep(`${k}:bridge`)?.ref ?? '';
  return once(`${k}:status`, 'Wait for Relay delivery', async () => {
    for (let i = 0; i < 40; i++) { const st = await relay.getStatus(requestId); if (st === 'success') return requestId; if (st === 'refund' || st === 'failed') throw new Error(`Relay ${st}`); await sleep(6000); }
    throw new Error('Relay still pending: check status before retrying');
  }, out);
}

/**
 * Gather the top-up's USDC on the agent's BSC address: pull USDC, pull + swap USDT, and pull + sell bStocks. Returns the
 * total BSC USDC (18-dp wei) now held for this move, or null if a step failed. Step keys are unchanged, so moves that
 * started before this split still resume.
 */
async function collectOnAgent(s: Snapshot, k: string, usdcBase: bigint, sales: SaleLeg[], out: StepResult[], usdtBase = 0n): Promise<bigint | null> {
  let totalWei = 0n;

  if (usdtBase > 0n) {
    if (!(await once(`${k}:pullusdt`, 'Pull USDT from user wallet', async () => (await bsc.pullStable('usdt', s.wallet, usdtBase.toString())).txHash, out))) return null;
    if (!(await once(`${k}:swap`, 'Swap USDT to USDC on PancakeSwap (0.01% pool, 0.5% max slippage)', async () => {
      const r = await pancake.swapUsdtToUsdc(bsc.baseToBsc(usdtBase.toString()));
      return `${r.txHash}:${r.usdcOutWei}`;
    }, out))) return null;
    totalWei += BigInt((store.getStep(`${k}:swap`)?.ref ?? ':0').split(':')[1] || '0');
  }

  if (usdcBase > 0n) {
    if (!(await once(`${k}:pull`, 'Pull USDC from user wallet', async () => (await bsc.pullUsdc(s.wallet, usdcBase.toString())).txHash, out))) return null;
    totalWei += bsc.baseToBsc(usdcBase.toString());
  }

  for (const leg of sales) {
    const h = s.bsc.bstocks.find((b) => b.symbol === leg.symbol);
    if (!h || h.qty <= 0 || h.value <= 0) { out.push({ step: `sell ${leg.symbol}`, status: 'failed', detail: `${leg.symbol} is not held` }); return null; }
    // Sell enough that the value after the haircut covers the cash needed, plus a small buffer for slippage.
    const qty = Math.min(h.qty, h.allowanceQty ?? h.qty, (leg.usd / (1 - s.config.collateral.bstockHaircut)) * SELL_BUFFER / (h.value / h.qty));
    if (!(qty > 0)) { out.push({ step: `sell ${leg.symbol}`, status: 'failed', detail: 'nothing to sell' }); return null; }
    const raw = await bsc.rawForUi(leg.symbol, qty);
    if (!(await once(`${k}:${leg.symbol}:pullb`, `Pull ${leg.symbol} from user wallet`, async () => (await bsc.pullBstock(leg.symbol, s.wallet, raw)).txHash, out))) return null;
    if (!(await once(`${k}:${leg.symbol}:sell`, `Sell ${leg.symbol} for USDC on PancakeSwap (1% max slippage)`, async () => {
      const r = await pancake.sellBstockForUsdc(leg.symbol, raw);
      return `${r.txHash}:${r.usdcOutWei}`;
    }, out))) return null;
    totalWei += BigInt((store.getStep(`${k}:${leg.symbol}:sell`)?.ref ?? ':0').split(':')[1] || '0');
  }
  if (totalWei <= 0n) { out.push({ step: 'fund the top-up', status: 'failed', detail: 'nothing to bridge' }); return null; }
  return totalWei;
}

/** Minimum ETH the agent keeps on Ethereum for a Derive deposit (USDC approve + depositToNewSubaccount, about 150k gas). */
export const MIN_AGENT_ETH_WEI = 300_000_000_000_000n; // 0.0003 ETH
/** Smallest Derive top-up: $7 must still arrive after Relay's fee for the deposit to be safe. */
export const DERIVE_TOPUP_MIN_BASE = 8_000_000n;

/**
 * Derive top-up: collect the funds on BSC, then deriveFunding.fundDeriveSubaccount bridges them to the agent's own
 * Ethereum address, deposits them into a new subaccount OWNED BY THE USER, and moves them into the rule's subaccount.
 * Checked BEFORE pulling anything: the agent has ETH for the deposit (otherwise USDC would sit on its Ethereum address).
 */
async function topUpDerive(s: Snapshot, c: Candidate, k: string, out: StepResult[]): Promise<StepResult[]> {
  const rule = c.rule!; const net = s.network;
  const agentBsc = bsc.agentAddress(); if (!agentBsc) throw new Error('AGENT_BSC_PRIVATE_KEY is not set');
  const creds = await getDeriveCreds(s.wallet, net);
  const target = rule.accountRef ? Number(rule.accountRef) : creds.subaccountId;
  const sub = (await derive.listSubaccounts(net, s.wallet, creds)).find((x) => x.subaccount_id === target);
  if (!sub) { out.push({ step: 'find the Derive subaccount', status: 'failed', detail: `subaccount ${target} is not yours` }); return out; }
  if (!sub.manager_id) { out.push({ step: 'find the Derive subaccount', status: 'failed', detail: `subaccount ${target} has no margin manager (fallback); pick a trading subaccount` }); return out; }
  const gas = await funding.agentEthBalance(net);
  if (gas < MIN_AGENT_ETH_WEI && !store.getStep(`${k}:deposit`)) {
    out.push({ step: 'check agent gas on Ethereum', status: 'failed', detail: `the agent's Ethereum address ${funding.agentEthAddress()} has ${Number(gas) / 1e18} ETH; it needs about ${Number(MIN_AGENT_ETH_WEI) / 1e18} ETH to deposit into Derive. Nothing was pulled.` });
    return out;
  }
  // Relay takes its fee from the bridged amount, so a $7 move would land under the $7 deposit floor and get stuck on the
  // agent's Ethereum address. Refuse below $8 before anything is pulled.
  if (BigInt(c.amountBaseUnit) < DERIVE_TOPUP_MIN_BASE && !store.getStep(`${k}:bridge`)) {
    out.push({ step: 'check the top-up size', status: 'failed', detail: `Derive top-ups need at least $${Number(DERIVE_TOPUP_MIN_BASE) / 1e6} (the bridge fee comes off the amount and Derive loses deposits under $5). Nothing was pulled.` });
    return out;
  }
  const sp = splitFunding(c);
  if (sp.usdcBase < 0n || sp.unsupported.length) { out.push({ step: 'plan funding', status: 'failed', detail: 'funding plan not supported' }); return out; }
  const totalWei = await collectOnAgent(s, k, sp.sales.length || sp.usdtBase > 0n ? sp.usdcBase : BigInt(c.amountBaseUnit), sp.sales, out, sp.usdtBase);
  if (totalWei === null) return out;
  const amountBase = (totalWei / 10n ** 12n).toString(); // BSC USDC is 18 dp; Ethereum/Derive USDC is 6 dp
  const steps = await funding.fundDeriveSubaccount({
    n: net, wallet: s.wallet as `0x${string}`, creds, amountBase, managerId: sub.manager_id, targetSubaccountId: target, agentBsc, key: k,
    isDone: (sk) => { const st = store.getStep(sk); return st?.status === 'done' ? (st.ref ?? true) : undefined; },
    markDone: (sk, ref) => store.saveStep(sk, 'done', ref),
  });
  const LABEL: Record<funding.StepName, string> = { bridge: 'Bridge BSC USDC to the agent on Ethereum (Relay)', bridge_wait: 'Wait for Relay delivery', deposit: 'Deposit into your Derive account (new subaccount, you are the owner)', credit: 'Wait for Derive to credit the deposit', consolidate: `Move it into subaccount ${target}` };
  for (const st of steps) out.push({ step: LABEL[st.step], status: st.status, detail: st.detail, ref: st.ref });
  return out;
}

async function verifyPosition(net: Snapshot['network'], creds: LighterCreds, marketId: number, expected: number, tolerance: number): Promise<string | null> {
  let last = NaN;
  for (let i = 0; i < 5; i++) {
    await sleep(i === 0 ? 2000 : 3000);
    last = lighter.positionsOf(await lighter.getAccount(net, creds.accountIndex))[marketId] ?? 0;
    if (Math.abs(last - expected) <= tolerance) return null;
  }
  return `position is ${last}, the plan expected ${expected}`;
}

export async function execute(s: Snapshot, c: Candidate): Promise<StepResult[]> {
  const out: StepResult[] = [];
  if (!config().live) return describeSteps(s, c).map((step) => ({ step, status: 'simulated' as const }));

  const net = s.network; const k = c.idempotencyKey;

  if (c.kind === 'hedge' && c.hedge!.derive) {
    const h = c.hedge!; const d = h.derive!; const creds = await getDeriveCreds(s.wallet, net);
    const before = (await derive.hedgePositions(net, s.wallet, creds))[h.key!] ?? 0;
    const sells = d.roll?.sell ?? [];
    for (let i = 0; i < sells.length; i++) {
      const old = sells[i];
      if (!(await once(`${k}:sell${i}`, `Sell ${old.instrument} (reduce-only)`, async () => (await derive.placeOrder(net, s.wallet, creds, { instrument: old.instrument, side: 'sell', amount: String(old.amount), type: 'market', reduceOnly: true })).orderId, out))) return out;
    }
    const perp = h.kind === 'perp'; const sellSide = perp && h.deltaToShort > 0; const q = Math.abs(h.deltaToShort);
    const placed = await once(`${k}:order`, perp ? `Derive hedge order ${d.instrument}` : `Buy ${d.instrument}`, async () => {
      const r = await derive.placeOrder(net, s.wallet, creds, { instrument: d.instrument, side: perp ? (sellSide ? 'sell' : 'buy') : 'buy', amount: String(q), type: 'market', reduceOnly: perp && !sellSide });
      if (!(r.filled > 0)) throw new Error(`order ${r.status}: nothing filled`);
      return `${r.orderId} filled ${r.filled} at ${r.avgPrice}`;
    }, out);
    if (!placed) return out;
    store.logNotional(s.wallet, net, c.notionalUsd ?? 0);
    const rolled = sells.reduce((a, x) => a + x.amount, 0);
    const expected = perp ? before - h.deltaToShort : before - rolled + q;       // short perp is negative; puts are long contracts
    let after = NaN;
    for (let i = 0; i < 5; i++) { await sleep(i === 0 ? 2000 : 3000); after = (await derive.hedgePositions(net, s.wallet, creds))[h.key!] ?? 0; if (Math.abs(after - expected) <= q * 0.1 + 1e-9) break; }
    out.push(Math.abs(after - expected) <= q * 0.1 + 1e-9 ? { step: 'Check the position matches the plan', status: 'done' } : { step: 'Check the position matches the plan', status: 'failed', detail: `position is ${after}, the plan expected ${expected}` });
    return out;
  }

  if (c.kind === 'hedge' && c.hedge!.option) {
    out.push({ step: 'Buy the put on Derive', status: 'failed', detail: 'Loss-limit puts are chosen from a sample chain with no instrument names; use a put hedge leg (kind put) so the agent can pick a real listed put.' });
    return out;
  }

  if (c.kind === 'hedge') {
    const h = c.hedge!; const creds = await getLighterCreds(s.wallet, net);
    const mp = c.plan?.marginPlan;
    if (mp && mp.moveUsd > 0) { if (!(await fundLighterMain(s, `${k}:margin`, creds, baseOfUsd(mp.moveUsd), [], out))) return out; }
    const m = await lighter.getMarket(net, h.marketId);
    const px = m.last_trade_price; const sell = h.deltaToShort > 0;
    // Worst acceptable price: 2% through the last trade, in the direction that keeps the order fillable.
    const worst = (px * (sell ? 0.98 : 1.02)).toFixed(m.price_decimals);
    const before = lighter.positionsOf(await lighter.getAccount(net, creds.accountIndex))[h.marketId] ?? 0;
    const qtys = h.orderQtys && h.orderQtys.length > 1 ? h.orderQtys : [Math.abs(h.deltaToShort)];
    for (let i = 0; i < qtys.length; i++) {
      const placed = await once(qtys.length > 1 ? `${k}:order${i}` : `${k}:order`, qtys.length > 1 ? `Lighter hedge order ${i + 1} of ${qtys.length}` : 'Lighter hedge order', async () => (await lighter.placeMarketOrder(net, creds, creds.accountIndex, { marketId: h.marketId, side: sell ? 'sell' : 'buy', size: qtys[i].toFixed(m.size_decimals), worstPrice: worst, reduceOnly: !sell })).txHash, out);
      if (!placed) return out;
    }
    store.logNotional(s.wallet, net, c.notionalUsd ?? 0);
    const expected = before - h.deltaToShort;                     // short is negative: selling makes it more negative
    const bad = await verifyPosition(net, creds, h.marketId, expected, Math.abs(h.deltaToShort) * 0.1 + 10 ** -m.size_decimals);
    out.push(bad ? { step: 'Check the position matches the plan', status: 'failed', detail: bad } : { step: 'Check the position matches the plan', status: 'done' });
    return out;
  }

  const rule = c.rule!; if (ruleKey(rule) !== c.ruleKey) throw new Error('candidate/rule mismatch');
  const amount = c.amountBaseUnit;

  if (c.kind === 'top_up' && rule.venue === 'lighter') {
    const creds = await getLighterCreds(s.wallet, net);
    const sp = splitFunding(c);
    if (sp.usdcBase < 0n || sp.unsupported.length) { out.push({ step: 'plan funding', status: 'failed', detail: 'funding plan not supported' }); return out; }
    const ok = await fundLighterMain(s, k, creds, sp.sales.length || sp.usdtBase > 0n ? sp.usdcBase : BigInt(amount), sp.sales, out, sp.usdtBase);
    if (ok && rule.accountRef) {
      await once(`${k}:sub`, 'Transfer main → sub-account', async () => (await lighter.transferToOwnAccount(net, creds, creds.accountIndex, Number(rule.accountRef), amount)).txHash, out);
    }
    return out;
  }

  if (c.kind === 'release' && rule.venue === 'lighter') {
    const creds = await getLighterCreds(s.wallet, net);
    const acct = rule.accountRef === '' ? creds.accountIndex : Number(rule.accountRef);
    await once(`${k}:withdraw`, 'Lighter secure withdraw', async () => (await lighter.withdrawToOwner(net, creds, acct, amount)).txHash, out);
    return out;
  }

  if (c.kind === 'top_up' && rule.venue === 'derive') return topUpDerive(s, c, k, out);

  if (c.kind === 'release' && rule.venue === 'derive') {
    // Session key, recipient pinned to the owner: released margin lands in the USER's Ethereum wallet (~14 min, ~$1 fee).
    const creds = await getDeriveCreds(s.wallet, net);
    const sub = rule.accountRef ? Number(rule.accountRef) : creds.subaccountId;
    const usd = (BigInt(amount) / 1_000_000n).toString() + '.' + (BigInt(amount) % 1_000_000n).toString().padStart(6, '0');
    await once(`${k}:withdraw`, 'Derive withdraw to your Ethereum wallet', async () => (await derive.withdrawToOwner(net, s.wallet, creds, sub, usd)).opUuid ?? 'sent', out);
    return out;
  }

  out.push({ step: `${rule.venue} ${c.kind}`, status: 'failed', detail: 'unsupported' });
  return out;
}
