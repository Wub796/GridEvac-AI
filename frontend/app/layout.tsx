import type { Metadata, Viewport } from 'next';
import { DM_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-jakarta',
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
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'GridEvac',
  },
  formatDetection: { telephone: false },
};

/**
 * Cross-platform viewport: `viewportFit: cover` extends the app under the
 * iOS notch/home-indicator (paired with safe-area CSS), `themeColor` tints
 * browser chrome on Android and Safari 15+, `maximumScale: 1` stops the
 * double-tap zoom from fighting map gestures (pinch zoom stays enabled).
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#050d0b',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${dmMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
