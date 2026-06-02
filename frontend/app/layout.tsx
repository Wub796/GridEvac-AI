import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GridEvac AI — Houston Emergency Routing',
  description:
    'Real-time emergency evacuation routing for Houston, TX. ' +
    'Analyzes flash flooding and CenterPoint Energy substation failures ' +
    'using IsolationForest anomaly detection and NetworkX weighted pathfinding.',
  keywords: ['evacuation', 'Houston', 'flood', 'emergency', 'routing', 'AI', 'GIS'],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
