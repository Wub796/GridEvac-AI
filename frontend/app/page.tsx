'use client';

/**
 * page.tsx — Main application shell for GridEvac AI (Houston, TX)
 * Initialises the Zustand store on mount, runs the live ticker, and renders:
 *   - Full-screen CesiumJS viewer (background)
 *   - HUD decorations (title, corner brackets, scanlines, legend)
 *   - Glass control panel (right sidebar)
 *   - Scrolling live telemetry console log (bottom left)
 *   - Tutorial Modal & HUD help trigger button
 */

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSimulationStore } from '@/hooks/useSimulation';
import ControlPanel from '@/components/ControlPanel';
import TutorialModal from '@/components/TutorialModal';

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
  const { fetchCityData, triggerLiveTick, liveLogs } = useSimulationStore();
  const [isTutorialOpen, setIsTutorialOpen] = useState(false);

  // Fetch city graph data on load
  useEffect(() => {
    fetchCityData();
    // Open tutorial automatically on first load
    setIsTutorialOpen(true);
  }, [fetchCityData]);

  // Dynamic telemetry tick interval (every 3 seconds)
  useEffect(() => {
    const timer = setInterval(() => {
      triggerLiveTick();
    }, 3000);
    return () => clearInterval(timer);
  }, [triggerLiveTick]);

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

      {/* ── Help Guide HUD Button ── */}
      <button 
        className="tutorial-trigger-btn" 
        onClick={() => setIsTutorialOpen(true)}
        title="Open Interactive User Guide"
      >
        ❓ User Guide
      </button>

      {/* ── Interactive Tutorial Overlay ── */}
      <TutorialModal 
        isOpen={isTutorialOpen} 
        onClose={() => setIsTutorialOpen(false)} 
      />

      {/* ── Bottom-left Console Ticker Log & Legend Container ── */}
      <div style={{
        position: 'fixed',
        bottom: '24px',
        left: '20px',
        zIndex: 900,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        pointerEvents: 'none'
      }}>
        
        {/* Live Grid Event Logs */}
        <div style={{
          width: '420px',
          height: '140px',
          background: 'rgba(5, 12, 26, 0.82)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid rgba(0, 200, 255, 0.14)',
          borderRadius: '8px',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: 'auto'
        }}>
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            borderBottom: '1px solid rgba(0,200,255,0.08)', 
            paddingBottom: '4px',
            marginBottom: '6px'
          }}>
            <span style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '11px', fontWeight: '600', letterSpacing: '1px', color: '#00e5ff' }}>
              📡 LIVE SCADA TELEMETRY FEED
            </span>
            <span style={{ width: '6px', height: '6px', background: '#00e5ff', borderRadius: '50%', boxShadow: '0 0 6px #00e5ff', alignSelf: 'center', animation: 'blink 1s infinite' }} />
          </div>
          
          <div style={{ 
            flex: 1, 
            overflowY: 'auto', 
            display: 'flex', 
            flexDirection: 'column-reverse', 
            gap: '5px',
            fontFamily: 'monospace',
            fontSize: '10px',
            color: 'rgba(160, 210, 240, 0.85)',
            scrollbarWidth: 'none'
          }}>
            {liveLogs.slice().reverse().map((log, idx) => {
              // Highlight alerts / warnings / successes
              let color = 'rgba(160, 210, 240, 0.85)';
              if (log.includes('Alert') || log.includes('warning') || log.includes('Warning') || log.includes('REDISTRIBUTION')) {
                color = '#ff9100';
              } else if (log.includes('CRITICAL') || log.includes('Error') || log.includes('FAILED')) {
                color = '#ff3d3d';
              } else if (log.includes('Evacuation') || log.includes('ONLINE') || log.includes('Nominal') || log.includes('Successfully')) {
                color = '#00ff88';
              }
              
              return (
                <div key={idx} style={{ color, wordBreak: 'break-all', textShadow: color !== 'rgba(160, 210, 240, 0.85)' ? `0 0 4px ${color}40` : 'none' }}>
                  {log}
                </div>
              );
            })}
          </div>
        </div>

        {/* Legend */}
        <nav className="legend" style={{ position: 'static', pointerEvents: 'auto' }} aria-label="Map Legend">
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
      </div>

      {/* ── Right sidebar control panel ── */}
      <ControlPanel />
    </main>
  );
}
