'use client';

/**
 * ControlPanel.tsx — Glass-morphic right-sidebar control panel
 * Houston, TX — GridEvac AI
 */

import { useState } from 'react';
import { useSimulationStore } from '@/hooks/useSimulation';
import type { RiskLevel } from '@/lib/types';
import styles from './ControlPanel.module.css';

const RISK_COLORS: Record<RiskLevel, string> = {
  LOW:      '#00e676',
  MEDIUM:   '#ffea00',
  HIGH:     '#ff9100',
  CRITICAL: '#ff1744',
};

const RISK_LABELS: Record<RiskLevel, string> = {
  LOW:      '✓ LOW RISK',
  MEDIUM:   '⚠ MEDIUM RISK',
  HIGH:     '⚡ HIGH RISK',
  CRITICAL: '☢ CRITICAL',
};

export default function ControlPanel() {
  const [searchNodeInput, setSearchNodeInput] = useState('');

  const {
    floodLevel, setFloodLevel,
    failedSubstations, toggleSubstation,
    originNode, setOriginNode,
    destNode,
    cityData,
    route,
    isLoading,
    backendOnline,
    error,
    fetchCityData,
    clearRoute,
    gridFrequency,
    substationLoads,
    overloadedSubstations,
    cascadedSubstations,
    usgsGageHeight,
    surfaceTemp,
    showBuildings, setShowBuildings,
    showPowerLines, setShowPowerLines,
    showSubstations, setShowSubstations,
    showIntersections, setShowIntersections,
    setFlyToNodeId,
    applyScenario,
    activeSection,
  } = useSimulationStore();

  const EXIT_NAMES: Record<number, string> = {
    14: 'East Gate (Node 14)',
    120: 'West Gate (Node 120)',
    164: 'South Gate (Node 164)',
    210: 'North Gate (Node 210)',
  };

  const substations = cityData?.substations ?? [];
  const nodes = cityData?.nodes ?? [];

  const riskLevel  = route?.risk_level ?? null;
  const anonScore  = route?.anomaly_score ?? null;

  // Flood height in metres
  const floodHeightM = (floodLevel * 1.7).toFixed(1);

  return (
    <aside className={`${styles.panel} ${activeSection === 'map' ? styles.panelVisible : styles.panelHidden}`}>
      {/* ── Header ── */}
      <div className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>⚡</span>
          <div>
            <h2 className={styles.title}>GridEvac AI</h2>
            <p className={styles.subtitle}>Houston Emergency Routing</p>
          </div>
        </div>
        <div className={`${styles.statusDot} ${backendOnline ? styles.online : styles.offline}`} />
      </div>

      {/* ── Section Quick Navigation ── */}
      <div style={{
        display: 'flex',
        gap: '6px',
        padding: '8px 16px',
        borderBottom: '1px solid rgba(0, 229, 255, 0.12)',
        background: 'rgba(0, 229, 255, 0.02)',
        justifyContent: 'space-between'
      }}>
        <button
          onClick={() => {
            const container = document.querySelector('.scroll-container');
            if (container) {
              container.scrollTo({ top: 0, behavior: 'smooth' });
            }
          }}
          style={{
            background: 'transparent',
            border: '1px solid rgba(0, 229, 255, 0.3)',
            color: '#00e5ff',
            fontSize: '9px',
            padding: '5px 8px',
            borderRadius: '4px',
            fontFamily: 'var(--font-rajdhani)',
            fontWeight: '600',
            letterSpacing: '1px',
            cursor: 'none',
            flex: 1,
            textAlign: 'center',
            transition: 'all 0.2s'
          }}
          className="nav-btn-jump"
          title="Go to Tactical Briefing"
        >
          ▲ BRIEFING
        </button>
        <button
          onClick={() => {
            const container = document.querySelector('.scroll-container');
            if (container) {
              container.scrollTo({ top: window.innerHeight * 2, behavior: 'smooth' });
            }
          }}
          style={{
            background: 'transparent',
            border: '1px solid rgba(0, 255, 136, 0.3)',
            color: '#00ff88',
            fontSize: '9px',
            padding: '5px 8px',
            borderRadius: '4px',
            fontFamily: 'var(--font-rajdhani)',
            fontWeight: '600',
            letterSpacing: '1px',
            cursor: 'none',
            flex: 1,
            textAlign: 'center',
            transition: 'all 0.2s'
          }}
          className="nav-btn-jump"
          title="Go to Machine Learning Audit"
        >
          ▼ ML AUDIT
        </button>
      </div>

      {/* ── Backend connection ── */}
      {!backendOnline && (
        <div className={styles.warningBanner}>
          <span>⚠ Backend offline</span>
          <button className={styles.connectBtn} onClick={fetchCityData}>Connect</button>
        </div>
      )}

      {error && (
        <div className={styles.errorBanner}>
          {error}
        </div>
      )}

      {/* ── Section: Disaster Scenario Presets ── */}
      {backendOnline && (
        <section className={styles.section} style={{ background: 'rgba(255, 145, 0, 0.02)', borderBottom: '1px solid rgba(255, 145, 0, 0.12)' }}>
          <h3 className={styles.sectionTitle}>
            <span className={styles.sectionIcon}>🚨</span> Scenario Manager
          </h3>
          <div className={styles.scenarioGrid}>
            <button 
              className={styles.scenarioBtn} 
              onClick={() => applyScenario('flood')}
              title="Simulate flash flooding at 8.5m"
            >
              🌊 Bayou Flood
            </button>
            <button 
              className={styles.scenarioBtn} 
              onClick={() => applyScenario('cascade')}
              title="Simulate substation outages triggering cascading failures"
            >
              ⚡ Cascades
            </button>
            <button 
              className={styles.scenarioBtn} 
              onClick={() => applyScenario('heatwave')}
              title="Simulate severe summer grid load strain"
            >
              🔥 Heatwave
            </button>
            <button 
              className={styles.scenarioBtnClear} 
              onClick={() => applyScenario('clear')}
              title="Restore nominal operating states"
            >
              🔄 Reset Grid
            </button>
          </div>
        </section>
      )}

      {/* ── Grid Dashboard Telemetry HUD ── */}
      {backendOnline && (
        <section className={styles.section} style={{ background: 'rgba(0, 229, 255, 0.02)' }}>
          <h2 className={styles.sectionTitle}>
            <span className={styles.sectionIcon}>📊</span> Grid Telemetry HUD
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', padding: '8px', borderRadius: '6px', textAlign: 'center' }}>
              <span style={{ fontSize: '9px', color: 'rgba(160,210,240,0.5)', textTransform: 'uppercase', letterSpacing: '0.8px', display: 'block', marginBottom: '4px' }}>Frequency</span>
              <span style={{ fontFamily: 'var(--font-rajdhani)', fontSize: '18px', fontWeight: '700', color: gridFrequency < 59.8 ? '#ff3d3d' : '#00ff88' }}>
                {gridFrequency.toFixed(2)} Hz
              </span>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', padding: '8px', borderRadius: '6px', textAlign: 'center' }}>
              <span style={{ fontSize: '9px', color: 'rgba(160,210,240,0.5)', textTransform: 'uppercase', letterSpacing: '0.8px', display: 'block', marginBottom: '4px' }}>Grid Stability</span>
              <span style={{ fontFamily: 'var(--font-rajdhani)', fontSize: '18px', fontWeight: '700', color: overloadedSubstations.length > 0 ? '#ffea00' : (cascadedSubstations.length > 0 ? '#ff3d3d' : '#00e5ff') }}>
                {cascadedSubstations.length > 0 ? 'CRITICAL' : (overloadedSubstations.length > 0 ? 'OVERLOAD' : 'NOMINAL')}
              </span>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', padding: '8px', borderRadius: '6px', textAlign: 'center' }}>
              <span style={{ fontSize: '9px', color: 'rgba(160,210,240,0.5)', textTransform: 'uppercase', letterSpacing: '0.8px', display: 'block', marginBottom: '4px' }}>USGS Gage height</span>
              <span style={{ fontFamily: 'var(--font-rajdhani)', fontSize: '18px', fontWeight: '700', color: usgsGageHeight > 10.0 ? '#ff9100' : '#00ff88' }}>
                {usgsGageHeight.toFixed(2)} ft
              </span>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', padding: '8px', borderRadius: '6px', textAlign: 'center' }}>
              <span style={{ fontSize: '9px', color: 'rgba(160,210,240,0.5)', textTransform: 'uppercase', letterSpacing: '0.8px', display: 'block', marginBottom: '4px' }}>Micro-Temp</span>
              <span style={{ fontFamily: 'var(--font-rajdhani)', fontSize: '18px', fontWeight: '700', color: '#ffea00' }}>
                {surfaceTemp.toFixed(1)} °F
              </span>
            </div>
          </div>
        </section>
      )}

      {/* ── Section: Flood Simulation ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>
          <span className={styles.sectionIcon}>🌊</span> Flood Level
        </h2>
        <div className={styles.sliderRow}>
          <input
            id="flood-slider"
            type="range"
            min={0} max={10} step={0.1}
            value={floodLevel}
            onChange={(e) => setFloodLevel(parseFloat(e.target.value))}
            className={styles.slider}
            style={{ '--fill': `${floodLevel * 10}%` } as any}
          />
          <span className={styles.sliderValue}>{floodLevel.toFixed(1)}</span>
        </div>
        <div className={styles.floodMeta}>
          <span className={styles.metaLabel}>Water rise:</span>
          <span className={styles.metaValue} style={{ color: floodLevel > 5 ? '#ff3d3d' : '#00bcd4' }}>
            {floodHeightM} m ASL
          </span>
        </div>
        <div className={styles.floodBar}>
          <div
            className={styles.floodFill}
            style={{ width: `${floodLevel * 10}%` }}
          />
        </div>
      </section>

      {/* ── Section: GIS Layer Options ── */}
      {backendOnline && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>
            <span className={styles.sectionIcon}>👁</span> Map Display Options
          </h3>
          <div className={styles.toggleGrid}>
            <label className={styles.toggleRow}>
              <input
                type="checkbox"
                checked={showBuildings}
                onChange={(e) => setShowBuildings(e.target.checked)}
                className={styles.toggleCheckbox}
              />
              <span className={styles.toggleLabel}>3D City Buildings</span>
            </label>
            <label className={styles.toggleRow}>
              <input
                type="checkbox"
                checked={showPowerLines}
                onChange={(e) => setShowPowerLines(e.target.checked)}
                className={styles.toggleCheckbox}
              />
              <span className={styles.toggleLabel}>Transmission Lines</span>
            </label>
            <label className={styles.toggleRow}>
              <input
                type="checkbox"
                checked={showSubstations}
                onChange={(e) => setShowSubstations(e.target.checked)}
                className={styles.toggleCheckbox}
              />
              <span className={styles.toggleLabel}>Substation Towers</span>
            </label>
            <label className={styles.toggleRow}>
              <input
                type="checkbox"
                checked={showIntersections}
                onChange={(e) => setShowIntersections(e.target.checked)}
                className={styles.toggleCheckbox}
              />
              <span className={styles.toggleLabel}>Grid Waypoints (Dots)</span>
            </label>
          </div>
        </section>
      )}

      {/* ── Section: Substations ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>
          <span className={styles.sectionIcon}>🔌</span> CenterPoint Substations
        </h2>
        <div className={styles.substationList}>
          {substations.length === 0 ? (
            <p className={styles.placeholder}>Load city data to see substations</p>
          ) : (
            substations.map((sub) => {
              const isManualFailed = failedSubstations.includes(sub.id);
              const isCascaded = cascadedSubstations.includes(sub.id);
              const isFailed = isManualFailed || isCascaded;

              const currentLoad = substationLoads[sub.id] ?? sub.base_load_mw;
              const isOverloaded = overloadedSubstations.includes(sub.id);

              const loadPercent = Math.min(100, Math.round((currentLoad / sub.capacity_mw) * 100));

              let statusLabel = "ONLINE";
              let statusColor = "#00e676";

              if (isManualFailed) {
                statusLabel = "OFFLINE";
                statusColor = "#ff3d3d";
              } else if (isCascaded) {
                statusLabel = "CASCADE";
                statusColor = "#ff3d3d";
              } else if (isOverloaded) {
                statusLabel = "OVERLOAD";
                statusColor = "#ff9100";
              }

              const barColor = isFailed ? '#1a0d0d' : (isOverloaded ? '#ff9100' : (loadPercent > 80 ? '#ffea00' : '#00ff88'));

              return (
                <div
                  key={sub.id}
                  className={`${styles.substationRow} ${isFailed ? styles.substationFailed : ''}`}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '6px' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <div className={styles.substationInfo}>
                      <div
                        className={styles.substationDot}
                        style={{ 
                          background: statusColor, 
                          boxShadow: `0 0 8px ${statusColor}`,
                          animation: isOverloaded ? 'blink 0.6s infinite' : 'none'
                        }}
                      />
                      <span className={styles.substationName}>{sub.name}</span>
                    </div>
                    <button
                      className={`${styles.toggle} ${isFailed ? styles.toggleOff : styles.toggleOn}`}
                      onClick={() => toggleSubstation(sub.id)}
                      disabled={isCascaded}
                      style={{ cursor: isCascaded ? 'not-allowed' : 'pointer' }}
                    >
                      {statusLabel}
                    </button>
                  </div>

                  {/* Dynamic Load Indicator */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '2px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9.5px', color: 'rgba(160,210,240,0.5)' }}>
                      <span>Load: {isFailed ? '0' : currentLoad.toFixed(1)} MW / {sub.capacity_mw} MW</span>
                      <span>{isFailed ? '0%' : `${loadPercent}%`}</span>
                    </div>
                    <div style={{ height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
                      <div 
                        style={{ 
                          height: '100%', 
                          width: `${isFailed ? 0 : loadPercent}%`, 
                          background: barColor,
                          transition: 'width 0.5s ease, background 0.5s ease' 
                        }} 
                      />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* ── Section: Route ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>
          <span className={styles.sectionIcon}>🗺</span> Evacuation Route
        </h2>
        <div className={styles.routeSelectors}>
          <div className={styles.selectGroup} style={{ width: '100%' }}>
            <label htmlFor="origin-select" className={styles.selectLabel}>Origin Intersection</label>
            <select
              id="origin-select"
              className={styles.nodeSelect}
              value={originNode}
              onChange={(e) => setOriginNode(parseInt(e.target.value))}
            >
              {nodes.map((node) => {
                const isExit = [14, 120, 164, 210].includes(node.id);
                const isFlooded = node.elevation <= floodLevel * 1.7;
                const role = isExit ? ' [EXIT]' : (isFlooded ? ' [FLOODED]' : '');
                return (
                  <option key={node.id} value={node.id} disabled={isFlooded}>
                    Node {node.id} - Row {node.row}, Col {node.col} ({node.elevation.toFixed(1)}m){role}
                  </option>
                );
              })}
            </select>
          </div>
        </div>

        {/* Node Search / Fly-To */}
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label htmlFor="search-node-input" className={styles.selectLabel}>Locate / Fly to Grid Node</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              id="search-node-input"
              type="number"
              min={0}
              max={224}
              placeholder="Enter Node ID (0-224)"
              value={searchNodeInput}
              onChange={(e) => setSearchNodeInput(e.target.value)}
              className={styles.searchNodeInput}
            />
            <button
              onClick={() => {
                const id = parseInt(searchNodeInput, 10);
                if (!isNaN(id) && id >= 0 && id <= 224) {
                  setFlyToNodeId(id);
                } else {
                  alert('Please enter a valid Node ID between 0 and 224.');
                }
              }}
              className={styles.flyToBtn}
              title="Fly camera to node"
            >
              🚀 Fly
            </button>
          </div>
        </div>

        {/* Real-time calculated Target Exit Node */}
        <div style={{ marginTop: '12px', padding: '10px', background: 'rgba(0, 229, 255, 0.04)', borderRadius: '6px', border: '1px solid rgba(0, 229, 255, 0.15)' }}>
          <span style={{ fontSize: '9px', color: 'rgba(160,210,240,0.6)', textTransform: 'uppercase', letterSpacing: '0.8px', display: 'block', marginBottom: '4px' }}>Safest Calculated Exit</span>
          <span style={{ fontFamily: 'var(--font-rajdhani)', fontSize: '15px', fontWeight: '700', color: route?.success && route.dest_node !== -1 ? '#00ff88' : '#ff3d3d' }}>
            {route?.success && route.dest_node !== -1 ? (EXIT_NAMES[route.dest_node] || `Node ${route.dest_node}`) : 'NO PASSABLE PATH'}
          </span>
        </div>

        {/* Route Waypoints Detail */}
        {route?.success && route.path.length > 0 && (
          <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '9px', color: 'rgba(160,210,240,0.6)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
              Waypoint Guidance Log
            </span>
            <div className={styles.waypointLogContainer}>
              {route.path.map((nid, index) => {
                const node = cityData?.nodes.find(n => n.id === nid);
                const isFirst = index === 0;
                const isLast = index === route.path.length - 1;
                const elevation = node ? node.elevation.toFixed(1) : '0.0';
                
                const isUnderCompromisedWire = route.hazard_roads && Object.keys(route.hazard_roads).some(key => {
                  const state = route.hazard_roads?.[key];
                  if (state !== 'dead' && state !== 'overloaded') return false;
                  const [u, v] = key.split('-').map(Number);
                  return (u === nid || v === nid);
                });
                const isBlackout = route.blackout_nodes.includes(nid);
                
                let warning = '';
                if (isUnderCompromisedWire) warning += '⚡';
                if (isBlackout) warning += '🔌';
                
                let textColor = 'rgba(255, 255, 255, 0.85)';
                if (isFirst) textColor = '#00e5ff';
                else if (isLast) textColor = '#00ff88';
                else if (isBlackout) textColor = '#ffea00';
                
                return (
                  <div key={nid} className={styles.waypointLogRow} style={{ color: textColor }}>
                    <span style={{ fontWeight: '600' }}>
                      {isFirst ? 'START' : (isLast ? 'EXIT' : `#${index}`)}: Node {nid}
                    </span>
                    <span style={{ fontSize: '9.5px', color: 'rgba(160,210,240,0.6)' }}>
                      ({elevation}m ASL){warning && <span title="Blackout/Power line Hazard area" style={{ color: '#ffea00', marginLeft: '4px' }}>{warning}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px 0', marginTop: '10px', color: '#00e5ff' }}>
            <span className={styles.spinner} />
            <span style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', letterSpacing: '0.5px' }}>SOLVING DIJKSTRA WEIGHTS...</span>
          </div>
        )}

        {route && (
          <button className={styles.clearBtn} onClick={clearRoute} style={{ marginTop: '10px', width: '100%' }}>
            ✕ Clear Route
          </button>
        )}
      </section>

      {/* ── Section: Anomaly / ML Status ── */}
      {route && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            <span className={styles.sectionIcon}>🤖</span> ML Anomaly Scan
          </h2>

          {/* Risk badge */}
          <div
            className={styles.riskBadge}
            style={{ borderColor: RISK_COLORS[route.risk_level], color: RISK_COLORS[route.risk_level] }}
          >
            {RISK_LABELS[route.risk_level]}
          </div>

          {/* Anomaly score bar */}
          <div className={styles.scoreRow}>
            <span className={styles.metaLabel}>Anomaly Score</span>
            <span className={styles.scoreValue}>{(anonScore! * 100).toFixed(0)}%</span>
          </div>
          <div className={styles.scoreBar}>
            <div
              className={styles.scoreFill}
              style={{
                width: `${anonScore! * 100}%`,
                background: RISK_COLORS[route.risk_level],
              }}
            />
          </div>
        </section>
      )}

      {/* ── Section: Route Stats ── */}
      {route && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            <span className={styles.sectionIcon}>📊</span> Route Statistics
          </h2>
          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <span className={styles.statNum}>{route.total_nodes}</span>
              <span className={styles.statLbl}>Waypoints</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statNum} style={{ color: '#ff4400' }}>
                {route.flooded_nodes.length}
              </span>
              <span className={styles.statLbl}>Flooded Nodes</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statNum} style={{ color: '#ffc107' }}>
                {route.blackout_nodes.length}
              </span>
              <span className={styles.statLbl}>Blackout Nodes</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statNum} style={{ color: '#ff2222' }}>
                {route.blocked_edges.length}
              </span>
              <span className={styles.statLbl}>Blocked Streets</span>
            </div>
          </div>

          <div className={`${styles.routeStatusBanner} ${route.success ? styles.routeOk : styles.routeFail}`}>
            {route.success ? '✓ SAFE ROUTE FOUND' : '✕ NO SAFE ROUTE'}
          </div>
          <p className={styles.routeMsg}>{route.message}</p>
        </section>
      )}

      {/* ── Footer ── */}
      <div className={styles.footer}>
        <span>GridEvac AI v1.0 · Houston, TX</span>
        <span>IsolationForest + NetworkX</span>
      </div>
    </aside>
  );
}
