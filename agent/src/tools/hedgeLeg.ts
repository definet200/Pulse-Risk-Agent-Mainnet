import { hedgeKey, type HedgeLeg } from '../../../lib/agent-config';

/** The leg key a hedge candidate trades (older Lighter candidates only carry a market id). */
export const legKeyOf = (h: { key?: string; marketId: number }): string => h.key ?? `lighter:${h.marketId}`;
/** True when the hedge candidate matches a leg the user configured (the market allowlist). */
export const legInConfig = (legs: HedgeLeg[], h: { bstock: string; key?: string; marketId: number; proxyFor?: string }): boolean => legs.some((l) => (h.proxyFor ? true : l.bstock === h.bstock) && hedgeKey(l) === legKeyOf(h));
