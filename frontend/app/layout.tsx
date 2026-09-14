import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Public_Sans } from 'next/font/google';
import './globals.css';

// Public Sans is the typeface of the U.S. Web Design System: built for public
// service interfaces, with tabular figures for live readings. IBM Plex Mono
// carries coordinates, grid references, and timestamps.
const publicSans = Public_Sans({
  subsets: ['latin'],
  variable: '--font-public-sans',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'GridEvac: Houston evacuation routing',
  description:
    'Evacuation routing for downtown Houston on real USGS terrain and the OpenStreetMap street network. '
    + 'Model Buffalo Bayou flooding, utility outages, and road closures; get passable corridors, trigger points, and exportable situation reports.',
  keywords: ['evacuation', 'Houston', 'flood', 'emergency management', 'routing', 'GIS', 'USNG'],
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'GridEvac' },
  formatDetection: { telephone: false },
};

/**
 * `viewportFit: cover` extends the app under the iOS notch (paired with
 * safe-area CSS); `themeColor` tints browser chrome. Page zoom stays enabled
 * (WCAG 1.4.4); the map canvas handles its own pinch gestures.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0a1115',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${publicSans.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
