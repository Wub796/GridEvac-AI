import type { Metadata } from 'next';
import { DM_Mono, Manrope } from 'next/font/google';
import './globals.css';

const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-manrope',
  display: 'swap',
});

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-dm-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'GridEvac AI - Houston Emergency Routing',
  description:
    'Real-time emergency evacuation routing for Houston, TX. ' +
    'Analyzes flash flooding and CenterPoint Energy substation failures ' +
    'using IsolationForest anomaly detection and NetworkX weighted pathfinding.',
  keywords: ['evacuation', 'Houston', 'flood', 'emergency', 'routing', 'AI', 'GIS'],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${dmMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
