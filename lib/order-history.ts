// One row shape for past orders on every venue, and the plain-language status for each. Pure (shared by server and UI).

export type HistoryVenue = 'lighter' | 'derive' | 'bstocks';

export interface HistoryRow {
  venue: HistoryVenue;
  /** Unix ms. */
  time: number;
  /** e.g. 'BTC-PERP', 'ETH-20261204-1700-C', 'NVDAB'. */
  market: string;
  side: 'buy' | 'sell';
  type: string;
  size: string;
  filled: string;
  avgPrice: string | null;
  /** The venue's own status string. Lighter: 'filled' / 'canceled-…'; Derive: 'filled' or 'cancelled:insufficient_margin'; bStocks: 'filled'. */
  status: string;
  account: string | null;
  txHash: string | null;
}

const LIGHTER_REASON: Record<string, string> = {
  'canceled-margin-not-allowed': 'not enough margin',
  'canceled-not-enough-liquidity': 'not enough liquidity on the book',
  'canceled-too-much-slippage': 'the price moved past your limit',
  'canceled-post-only': 'would have filled immediately (post-only)',
  'canceled-reduce-only': 'would have increased the position (reduce-only)',
  'canceled-expired': 'expired',
  'canceled-self-trade': 'would have traded with your own order',
  'canceled-invalid-balance': 'balance check failed',
};

const DERIVE_REASON: Record<string, string> = {
  user_request: 'canceled by you',
  insufficient_margin: 'not enough margin',
  ioc_or_market_partial_fill: 'rest of a market order not filled',
  signed_max_fee_too_low: 'fee limit too low',
  cancel_on_disconnect: 'canceled on disconnect',
  mmp_trigger: 'market-maker protection',
  session_key_deregistered: 'agent key removed',
  subaccount_withdrawn: 'subaccount emptied',
  compliance: 'compliance',
  trigger_failed: 'trigger failed',
  validation_failed: 'rejected by Derive',
};

const words = (s: string) => s.replace(/^canceled-|^cancelled-/, '').replace(/[-_]/g, ' ');

/** Short status for the table, plus whether it is good (filled), bad (nothing filled) or neutral. */
export function statusLabel(r: Pick<HistoryRow, 'venue' | 'status' | 'filled' | 'size'>): { text: string; tone: 'up' | 'down' | 'muted' } {
  const filled = Number(r.filled); const size = Number(r.size);
  const part = filled > 0 && filled < size;
  if (r.venue === 'derive') {
    const [st, reason] = r.status.split(':');
    if (st === 'filled') return { text: 'Filled', tone: 'up' };
    if (st === 'open') return { text: part ? 'Partly filled, open' : 'Open', tone: 'muted' };
    const why = reason ? DERIVE_REASON[reason] ?? words(reason) : st;
    return { text: `${part ? 'Partly filled · ' : ''}${st === 'expired' ? 'Expired' : st === 'rejected' ? 'Rejected' : 'Canceled'}${why && why !== st ? `: ${why}` : ''}`, tone: part ? 'muted' : 'down' };
  }
  if (r.status === 'filled') return { text: 'Filled', tone: 'up' };
  if (r.status.startsWith('canceled')) {
    const why = LIGHTER_REASON[r.status] ?? words(r.status);
    return { text: `${part ? 'Partly filled · ' : ''}Canceled: ${why}`, tone: part ? 'muted' : 'down' };
  }
  return { text: words(r.status), tone: 'muted' };
}
