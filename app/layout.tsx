import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/Providers';
import { Shell } from '@/components/Shell';

export const metadata: Metadata = {
  title: 'PulsarX Portfolio · BNB',
  description: 'bStocks collateral on BNB Chain, Lighter perps and Derive options, with an agent that hedges and rebalances margin.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
