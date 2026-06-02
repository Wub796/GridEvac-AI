'use client';

/**
 * ControlPanel.tsx — Glass-morphic right-sidebar control panel
 * Houston, TX — GridEvac AI
 */

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
  const {
    floodLevel, setFloodLevel,
    failedSubstations, toggleSubstation,
    originNode, setOriginNode,
    destNode,   setDestNode,
    cityData,
    route,
    isLoading,
    backendOnline,
    error,
    fetchCityData,
    calculateRoute,
    clearRoute,
    gridFrequency,
    substationLoads,
    overloadedSubstations,
    cascadedSubstations,
  } = useSimulationStore();

  const substations = cityData?.substations ?? [];
  const nodes = cityData?.nodes ?? [];

  const riskLevel  = route?.risk_level ?? null;
  const anonScore  = route?.anomaly_score ?? null;

  // Flood height in metres
  const floodHeightM = (floodLevel * 1.7).toFixed(1);

  return (
    <aside className={styles.panel}>
      {/* ── Header ── */}
      <div className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>⚡</span>
          <div>
            <h1 className={styles.title}>GridEvac AI</h1>
            <p className={styles.subtitle}>Houston Emergency Routing</p>
          </div>
        </div>
        <div className={`${styles.statusDot} ${backendOnline ? styles.online : styles.offline}`} />
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
          <div className={styles.selectGroup}>
            <label htmlFor="origin-select" className={styles.selectLabel}>Origin Node</label>
            <select
              id="origin-select"
              className={styles.nodeSelect}
              value={originNode}
              onChange={(e) => setOriginNode(parseInt(e.target.value))}
            >
              {Array.from({ length: 100 }, (_, i) => {
                const node = nodes.find((n) => n.id === i);
                const elev = node ? ` (${node.elevation.toFixed(0)}m)` : '';
                return (
                  <option key={i} value={i}>
                    Node {i}{elev}
                  </option>
                );
              })}
            </select>
          </div>
          <div className={styles.selectGroup}>
            <label htmlFor="dest-select" className={styles.selectLabel}>Destination Node</label>
            <select
              id="dest-select"
              className={styles.nodeSelect}
              value={destNode}
              onChange={(e) => setDestNode(parseInt(e.target.value))}
            >
              {Array.from({ length: 100 }, (_, i) => {
                const node = nodes.find((n) => n.id === i);
                const elev = node ? ` (${node.elevation.toFixed(0)}m)` : '';
                return (
                  <option key={i} value={i}>
                    Node {i}{elev}
                  </option>
                );
              })}
            </select>
          </div>
        </div>

        <button
          id="calculate-route-btn"
          className={`${styles.calcBtn} ${isLoading ? styles.calcBtnLoading : ''}`}
          onClick={calculateRoute}
          disabled={isLoading || !backendOnline}
        >
          {isLoading ? (
            <span className={styles.spinner} />
          ) : (
            <>⚡ Calculate Evacuation Route</>
          )}
        </button>

        {route && (
          <button className={styles.clearBtn} onClick={clearRoute}>
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
