import { json } from '@/lib/server/auth';
import { netParam, withWallet } from '@/lib/server/http';
import { once } from '@/lib/server/idempotency';
import { deriveWithdrawals, withdrawDerive } from '@/lib/server/derive';
import { lighterWithdrawals, withdrawLighter } from '@/lib/server/lighter';

export const runtime = 'nodejs';

const AMT = /^\d+(\.\d{1,6})?$/;

/**
 * GET ?network=&venue=lighter|derive → the wallet's recent withdrawals on that venue.
 * POST { network, venue, amount, subaccountId? } + Idempotency-Key → withdraw USDC to the wallet on Ethereum.
 *   lighter: from the main account (move sub-account funds to main first).
 *   derive:  from `subaccountId`.
 * The payout address is never an input: both venues pay the account's own owner (the signed-in wallet).
 */
export async function GET(req: Request) {
  return withWallet(async (wallet) => {
    const q = new URL(req.url).searchParams;
    const n = netParam(q.get('network'));
    if (!n) return json({ error: 'network required' }, 400);
    const venue = q.get('venue');
    if (venue === 'lighter') return json({ withdrawals: await lighterWithdrawals(n, wallet) });
    if (venue === 'derive') return json({ withdrawals: await deriveWithdrawals(n, wallet) });
    return json({ error: 'venue must be lighter|derive' }, 400);
  });
}

export async function POST(req: Request) {
  return withWallet(async (wallet) => {
    const idem = req.headers.get('idempotency-key');
    if (!idem || idem.length < 8 || idem.length > 80) return json({ error: 'Idempotency-Key header required' }, 400);
    const b = (await req.json().catch(() => ({}))) as { network?: string; venue?: string; amount?: string; subaccountId?: number };
    const n = netParam(b.network);
    if (!n) return json({ error: 'network must be mainnet|testnet' }, 400);
    const amount = String(b.amount ?? '');
    if (!AMT.test(amount)) return json({ error: 'amount must be a USDC decimal (≤ 6 places)' }, 400);
    const key = `${wallet}:withdraw:${n}:${idem}`;
    if (b.venue === 'lighter') return json(await once(key, () => withdrawLighter(n, wallet, amount)));
    if (b.venue === 'derive') {
      if (!Number.isInteger(b.subaccountId) || b.subaccountId! <= 0) return json({ error: 'subaccountId required' }, 400);
      return json(await once(key, () => withdrawDerive(n, wallet, b.subaccountId!, amount)));
    }
    return json({ error: 'venue must be lighter|derive' }, 400);
  });
}
