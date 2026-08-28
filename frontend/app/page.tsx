'use client';

/**
 * page.tsx — Refactored scroll-snapping narrative layout for GridEvac AI
 * Snaps between three operations sheets:
 *   - Section 1: Tactical Briefing (Hero Landing Page)
 *   - Section 2: Interactive 3D Evacuation Map (Operations Center)
 *   - Section 3: ML Technical Audit & Substation Analytics
 */

import { useEffect, useState, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useSimulationStore } from '@/hooks/useSimulation';
import ControlPanel from '@/components/ControlPanel';
import TutorialModal from '@/components/TutorialModal';
import CustomCursor from '@/components/CustomCursor';
import Sparkline from '@/components/Sparkline';

const CesiumViewer = dynamic(() => import('@/components/CesiumViewer'), {
  ssr: false,
  loading: () => (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#020912', color: '#00e5ff',
      fontFamily: 'Rajdhani, sans-serif', fontSize: '18px', letterSpacing: '3px',
      zIndex: 100
    }}>
      INITIALISING 3D MAP…
    </div>
  ),
});

export default function HomePage() {
  const { 
    fetchCityData, 
    triggerLiveTick, 
    liveLogs, 
    activeSection, 
    setActiveSection,
    usgsGageHeight,
    surfaceTemp,
    gridFrequency,
    substationLoads,
    route,
    cityData,
    failedSubstations,
    overloadedSubstations,
    cascadedSubstations,
    frequencyHistory,
    gageHistory
  } = useSimulationStore();

  const [isTutorialOpen, setIsTutorialOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Fetch city graph data on load
  useEffect(() => {
    fetchCityData();
    setIsTutorialOpen(true);
  }, [fetchCityData]);

  // Dynamic telemetry tick interval (every 3 seconds)
  useEffect(() => {
    const timer = setInterval(() => {
      triggerLiveTick();
    }, 3000);
    return () => clearInterval(timer);
  }, [triggerLiveTick]);

  // Scroll event handler to track active snap sections
  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const scrollY = container.scrollTop;
    const height = container.clientHeight;
    const index = Math.round(scrollY / height);

    const sections: ('briefing' | 'map' | 'audit')[] = ['briefing', 'map', 'audit'];
    const activeSec = sections[index] || 'briefing';

    if (activeSection !== activeSec) {
      setActiveSection(activeSec);
    }
  };

  // Jump to specific snap section
  const scrollToSection = (index: number) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTo({
      top: index * container.clientHeight,
      behavior: 'smooth',
    });
  };

  const riskLevel = route?.risk_level ?? 'LOW';
  const anonScore = route?.anomaly_score ?? 0.04;

  const totalOutages = new Set([...failedSubstations, ...cascadedSubstations]).size;

  return (
    <main style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      
      {/* ── Custom Sci-Fi Cursor ── */}
      <CustomCursor />

      {/* ── Background 3D Cesium Map ── */}
      <CesiumViewer />

      {/* ── Scanlines HUD background effect ── */}
      <div className="scanlines" aria-hidden="true" />
      <div className="corner corner--tl" aria-hidden="true" />
      <div className="corner corner--bl" aria-hidden="true" />

      {/* ── Scroll Snapping Container ── */}
      <div 
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="scroll-container"
      >
        
        {/* ==========================================
            SECTION 1: TACTICAL BRIEFING LANDING PAGE
           ========================================== */}
        <section className="scroll-section scroll-section--briefing" aria-label="Tactical Briefing Page">
          <div className="briefing-content">
            <div className="briefing-left-panel">
              <header>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
                  <img src="/logo.png" alt="GridEvac AI Logo" style={{ width: '64px', height: '64px', borderRadius: '8px', border: '1px solid rgba(0, 229, 255, 0.35)', boxShadow: '0 0 20px rgba(0, 229, 255, 0.25)' }} />
                  <div>
                    <span className="badge-glow" style={{ display: 'inline-block', margin: 0 }}>OPERATIONAL ALERT SYSTEM</span>
                    <h1 className="hero-title" style={{ marginTop: '4px', fontSize: '32px' }}>GridEvac AI</h1>
                  </div>
                </div>
                <p className="hero-subtitle">Houston Crisis Response & Evacuation Routing</p>
              </header>
              
              <div className="briefing-summary-card">
                <h3>Crisis Assessment Brief</h3>
                <p>
                  Severe storm fronts over Harris County have initiated localized flash flooding and power grid overloading. 
                  GridEvac AI leverages real-time hydrologic USGS sensors alongside CenterPoint electrical substation feeds to dynamically plot evacuation paths that bypass flooded roads and active blackout zones.
                </p>
                <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <span style={{ fontSize: '10px', color: 'rgba(160,210,240,0.5)', textTransform: 'uppercase' }}>Threat Level</span>
                    <span className={`threat-badge threat-badge--${riskLevel.toLowerCase()}`}>
                      ⚠️ {riskLevel} RISK
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <span style={{ fontSize: '10px', color: 'rgba(160,210,240,0.5)', textTransform: 'uppercase' }}>Anomaly Index</span>
                    <span className="threat-badge" style={{ borderColor: 'rgba(0, 229, 255, 0.4)', color: '#00e5ff' }}>
                      ⚡ {(anonScore * 100).toFixed(0)}% STRESS
                    </span>
                  </div>
                </div>
              </div>

              <div className="briefing-actions" style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                <button 
                  className="cta-btn-glow" 
                  onClick={() => scrollToSection(1)}
                  title="Load 3D Evacuation Map"
                >
                  Access Tactical Map ➔
                </button>
                <button 
                  className="secondary-btn" 
                  onClick={() => scrollToSection(2)}
                  title="View ML Technical Audit"
                >
                  ML System Audit
                </button>
              </div>
            </div>

            <div className="briefing-right-panel">
              <div className="hud-metric-card">
                <span className="metric-label">USGS Buffalo Bayou Gage</span>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
                  <span className="metric-num" style={{ color: usgsGageHeight > 10.0 ? '#ffea00' : '#00e5ff', margin: 0 }}>
                    {usgsGageHeight.toFixed(2)} ft
                  </span>
                  <Sparkline data={gageHistory} width={130} height={32} stroke={usgsGageHeight > 10.0 ? '#ffea00' : '#00e5ff'} strokeWidth={1.5} />
                </div>
                <div className="metric-footer">
                  Site ID: 08074000 · Hydrological Feed
                </div>
              </div>

              <div className="hud-metric-card">
                <span className="metric-label">Micro-Climate Surface Temp</span>
                <span className="metric-num" style={{ color: '#ffc107' }}>
                  {surfaceTemp.toFixed(1)} °F
                </span>
                <div className="metric-footer">
                  Houston Surface Telemetry Feed
                </div>
              </div>

              <div className="hud-metric-card">
                <span className="metric-label">Electrical Grid Frequency</span>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
                  <span className="metric-num" style={{ color: gridFrequency < 59.8 ? '#ff3d3d' : '#00ff88', margin: 0 }}>
                    {gridFrequency.toFixed(2)} Hz
                  </span>
                  <Sparkline data={frequencyHistory} width={130} height={32} stroke={gridFrequency < 59.8 ? '#ff3d3d' : '#00ff88'} strokeWidth={1.5} />
                </div>
                <div className="metric-footer">
                  Telemetry Frequency · Target: 60.00 Hz
                </div>
              </div>

              <div className="hud-metric-card">
                <span className="metric-label">Substation Outages</span>
                <span className="metric-num" style={{ color: totalOutages > 0 ? '#ff3d3d' : '#00ff88' }}>
                  {totalOutages} Towers
                </span>
                <div className="metric-footer">
                  Manual + Cascade Blackout Zones
                </div>
              </div>
            </div>
          </div>

          <div className="scroll-indicator" onClick={() => scrollToSection(1)}>
            <span>SCROLL TO INITIALISE MAP</span>
            <div className="arrow-down" />
          </div>
        </section>


        {/* ==========================================
            SECTION 2: ACTIVE TACTICAL EVACUATION MAP
           ========================================== */}
        <section className="scroll-section scroll-section--map" aria-label="Tactical Evacuation Map">
          
          {/* Top-left HUD title */}
          <div className="hud-title" role="banner">
            <h1>GridEvac AI</h1>
            <p>Houston · Emergency Evacuation Routing System</p>
          </div>

          {/* Back to Briefing HUD Button */}
          {activeSection !== 'briefing' && (
            <button 
              className="briefing-trigger-btn" 
              onClick={() => scrollToSection(0)}
              title="Return to Operational Briefing"
            >
              ◀ BRIEFING
            </button>
          )}

          {/* Help Guide HUD Button */}
          <button 
            className="tutorial-trigger-btn" 
            onClick={() => setIsTutorialOpen(true)}
            title="Open Interactive User Guide"
          >
            ❓ User Guide
          </button>

          {/* Tutorial Overlay */}
          <TutorialModal 
            isOpen={isTutorialOpen} 
            onClose={() => setIsTutorialOpen(false)} 
          />

          {/* Sidebar and HUD widgets fade in */}
          <div className="map-view-overlays">
            
            {/* Bottom-left Console Ticker & Legend Container */}
            <div style={{
              position: 'absolute',
              bottom: '24px',
              left: '20px',
              zIndex: 900,
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              pointerEvents: 'none'
            }}>
              
              {/* SCADA Terminal Log */}
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

              {/* Map Legend */}
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
                  <div className="legend-swatch" style={{ background: 'rgba(0, 136, 255, 0.45)', border: '1px solid rgba(0, 136, 255, 0.8)' }} />
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

            {/* Right sidebar control panel */}
            <ControlPanel />
          </div>

          {/* Quick jump to analytics page */}
          {activeSection !== 'audit' && (
            <div className="scroll-indicator scroll-indicator--top-right" onClick={() => scrollToSection(2)}>
              <span>ML ANALYSIS REPORT ➔</span>
            </div>
          )}
        </section>


        {/* ==========================================
            SECTION 3: ML SYSTEM AUDIT & ANALYTICS
           ========================================== */}
        <section className="scroll-section scroll-section--audit" aria-label="ML Technical Audit Page">
          <div className="audit-content">
            
            <div className="audit-left-panel">
              <header style={{ marginBottom: '16px' }}>
                <span className="badge-glow" style={{ borderColor: 'rgba(0, 255, 136, 0.4)', color: '#00ff88' }}>TECHNICAL AUDIT SHEET</span>
                <h2 className="audit-title">IsolationForest Predictive Engine</h2>
                <p style={{ fontSize: '11px', color: 'rgba(160,210,240,0.6)', letterSpacing: '1px', marginTop: '4px' }}>
                  Model Dimensions & Telemetry Boundary Envelopes
                </p>
              </header>

              <div className="briefing-summary-card">
                <h3>Anomaly Scoring Math</h3>
                <p style={{ fontSize: '12px', lineHeight: '1.5' }}>
                  The anomaly model operates inside a 9-dimensional space, assessing grid stability. If the scored features drift outside the trained normal boundary, the anomaly index spikes, triggering a threat escalation.
                </p>
                
                <h4 style={{ fontSize: '10px', color: '#00e5ff', textTransform: 'uppercase', letterSpacing: '1px', marginTop: '14px', marginBottom: '8px' }}>
                  9-D Input Vector Space
                </h4>
                <div className="audit-features-grid">
                  <div className="feature-item"><span>[1] Flood Level Slider</span></div>
                  <div className="feature-item"><span>[2] Failed Substations Count</span></div>
                  <div className="feature-item"><span>[3] Overloaded Substations</span></div>
                  <div className="feature-item"><span>[4] Mean Grid Load Ratio</span></div>
                  <div className="feature-item"><span>[5] Node Voltage Stability</span></div>
                  <div className="feature-item"><span>[6] Cascading Risk Score</span></div>
                  <div className="feature-item"><span>[7] Concurrent Deluge/Trip</span></div>
                  <div className="feature-item"><span>[8] USGS Bayou Gage height</span></div>
                  <div className="feature-item"><span>[9] Micro-climate Temp (°F)</span></div>
                </div>
              </div>

              <div className="audit-actions" style={{ display: 'flex', gap: '16px', marginTop: '20px' }}>
                <button 
                  className="secondary-btn" 
                  onClick={() => scrollToSection(0)}
                  title="Return to briefing"
                >
                  ➔ Briefing Page
                </button>
                <button 
                  className="cta-btn-glow" 
                  onClick={() => scrollToSection(1)}
                  title="Return to Map"
                >
                  ➔ Back to Map
                </button>
              </div>
            </div>

            <div className="audit-right-panel">
              <h3 style={{ fontFamily: 'var(--font-rajdhani)', fontSize: '18px', fontWeight: '700', letterSpacing: '1.5px', textTransform: 'uppercase', color: '#ffea00', marginBottom: '12px' }}>
                CenterPoint Electrical SCADA Nodes
              </h3>
              
              <div className="audit-table-wrapper">
                <table className="audit-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Substation Name</th>
                      <th>Base Load</th>
                      <th>Curr Load</th>
                      <th>Capacity</th>
                      <th>Telemetry Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cityData?.substations.map(sub => {
                      const isManualFailed = failedSubstations.includes(sub.id);
                      const isCascaded = cascadedSubstations.includes(sub.id);
                      const isFailed = isManualFailed || isCascaded;
                      const isOverloaded = overloadedSubstations.includes(sub.id);

                      const currLoad = isFailed ? 0.0 : (substationLoads[sub.id] ?? sub.base_load_mw);

                      let label = 'NOMINAL';
                      let color = '#00ff88';
                      if (isManualFailed) {
                        label = 'MANUAL OUT';
                        color = '#ff3d3d';
                      } else if (isCascaded) {
                        label = 'CASCADE';
                        color = '#ff3d3d';
                      } else if (isOverloaded) {
                        label = 'OVERLOADED';
                        color = '#ffb300';
                      }

                      return (
                        <tr key={sub.id} style={{ opacity: isFailed ? 0.5 : 1 }}>
                          <td style={{ color: '#00e5ff', fontFamily: 'monospace' }}>#{sub.id}</td>
                          <td style={{ fontWeight: '500' }}>{sub.name}</td>
                          <td>{sub.base_load_mw} MW</td>
                          <td style={{ fontFamily: 'monospace', color: isOverloaded ? '#ffea00' : 'inherit' }}>
                            {currLoad.toFixed(1)} MW
                          </td>
                          <td>{sub.capacity_mw} MW</td>
                          <td style={{ color, fontWeight: '700', fontSize: '9px', letterSpacing: '1px' }}>
                            {label}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        </section>

      </div>
    </main>
  );
}
