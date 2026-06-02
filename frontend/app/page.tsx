'use client';

/**
 * page.tsx — Main application shell for GridEvac AI (Houston, TX)
 * Initialises the Zustand store on mount, then renders:
 *   - Full-screen CesiumJS viewer (background)
 *   - HUD decorations (title, corner brackets, scanlines, legend)
 *   - Glass control panel (right sidebar)
 */

import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useSimulationStore } from '@/hooks/useSimulation';
import ControlPanel from '@/components/ControlPanel';

// CesiumJS must only run in the browser — disable SSR for this component
const CesiumViewer = dynamic(() => import('@/components/CesiumViewer'), {
  ssr: false,
  loading: () => (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#020912', color: '#00e5ff',
      fontFamily: 'Rajdhani, sans-serif', fontSize: '18px', letterSpacing: '3px',
    }}>
      INITIALISING 3D MAP…
    </div>
  ),
});

export default function HomePage() {
  const { fetchCityData } = useSimulationStore();

  // Fetch city graph data as soon as the app loads
  useEffect(() => {
    fetchCityData();
  }, [fetchCityData]);

  return (
    <main style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>

      {/* ── 3D Cesium map (full screen background) ── */}
      <CesiumViewer />

      {/* ── Scanline vignette overlay (atmosphere effect) ── */}
      <div className="scanlines" aria-hidden="true" />

      {/* ── HUD corner brackets ── */}
      <div className="corner corner--tl" aria-hidden="true" />
      <div className="corner corner--bl" aria-hidden="true" />

      {/* ── Top-left HUD title ── */}
      <div className="hud-title" role="banner">
        <h1>GridEvac AI</h1>
        <p>Houston · Emergency Evacuation Routing System</p>
      </div>

      {/* ── Bottom-left legend ── */}
      <nav className="legend" aria-label="Map Legend">
        <div className="legend-item">
          <div className="legend-swatch" style={{ background: '#1e4a8a' }} />
          Street Grid
        </div>
        <div className="legend-item">
          <div className="legend-swatch" style={{ background: '#ff2222' }} />
          Blocked Streets
        </div>
        <div className="legend-item">
          <div className="legend-swatch" style={{ background: 'rgba(0,85,221,0.7)' }} />
          Flood Zone
        </div>
        <div className="legend-item">
          <div className="legend-swatch" style={{ background: 'rgba(26,5,0,0.85)', border: '1px solid #ff4400' }} />
          Blackout Zone
        </div>
        <div className="legend-item">
          <div className="legend-swatch" style={{ background: '#00ff88', boxShadow: '0 0 6px #00ff88' }} />
          Safe Route
        </div>
        <div className="legend-item">
          <div className="legend-swatch" style={{ background: '#ffc107' }} />
          Substation
        </div>
      </nav>

      {/* ── Right sidebar control panel ── */}
      <ControlPanel />
    </main>
  );
}
