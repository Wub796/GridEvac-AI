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
        
        {/* Live Grid Event Logs (SCADA Retro CRT Terminal style) */}
        <div 
          className="scada-terminal"
          style={{
            width: '420px',
            height: '140px',
            borderRadius: '6px',
            padding: '12px 16px',
            display: 'flex',
            flexDirection: 'column',
            pointerEvents: 'auto'
          }}
        >
          {/* CRT sweep scanning line */}
          <div className="scada-sweep-line" aria-hidden="true" />
          
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            borderBottom: '1px solid rgba(0,255,102,0.15)', 
            paddingBottom: '4px',
            marginBottom: '6px',
            zIndex: 3
          }}>
            <span style={{ fontFamily: 'var(--font-rajdhani)', fontSize: '11px', fontWeight: '600', letterSpacing: '1px', color: '#00ff66', textShadow: '0 0 6px rgba(0,255,102,0.6)' }}>
              📡 LIVE SCADA TELEMETRY FEED
            </span>
            <span style={{ width: '6px', height: '6px', background: '#00ff66', borderRadius: '50%', boxShadow: '0 0 6px #00ff66', alignSelf: 'center', animation: 'blink 1s infinite' }} />
          </div>
          
          <div 
            className="scada-terminal-crt-glow"
            style={{ 
              flex: 1, 
              overflowY: 'auto', 
              display: 'flex', 
              flexDirection: 'column-reverse', 
              gap: '5px',
              fontFamily: 'monospace',
              fontSize: '10px',
              color: '#00ff55',
              scrollbarWidth: 'none',
              zIndex: 3
            }}
          >
            {liveLogs.slice().reverse().map((log, idx) => {
              // Highlight alerts / warnings / successes in phosphor green / neon amber / warning red
              let color = '#00ff55';
              let glow = 'rgba(0, 255, 85, 0.4)';
              if (log.includes('Alert') || log.includes('warning') || log.includes('Warning') || log.includes('REDISTRIBUTION')) {
                color = '#ffb300';
                glow = 'rgba(255, 179, 0, 0.4)';
              } else if (log.includes('CRITICAL') || log.includes('Error') || log.includes('FAILED')) {
                color = '#ff3333';
                glow = 'rgba(255, 51, 51, 0.4)';
              } else if (log.includes('Evacuation') || log.includes('ONLINE') || log.includes('Nominal') || log.includes('Successfully')) {
                color = '#00ff88';
                glow = 'rgba(0, 255, 136, 0.4)';
              }
              
              return (
                <div key={idx} style={{ color, wordBreak: 'break-all', textShadow: `0 0 4px ${glow}` }}>
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
            <div className="legend-swatch" style={{ background: '#ff6600', boxShadow: '0 0 4px #ff6600' }} />
            Dead Wire Hazard
          </div>
          <div className="legend-item">
            <div className="legend-swatch" style={{ background: '#ffea00', boxShadow: '0 0 4px #ffea00' }} />
            Overloaded Line Hazard
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
