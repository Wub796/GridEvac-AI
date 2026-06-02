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
              const isFailed = failedSubstations.includes(sub.id);
              return (
                <div
                  key={sub.id}
                  className={`${styles.substationRow} ${isFailed ? styles.substationFailed : ''}`}
                >
                  <div className={styles.substationInfo}>
                    <div
                      className={styles.substationDot}
                      style={{ background: isFailed ? '#ff4400' : '#ffc107' }}
                    />
                    <span className={styles.substationName}>{sub.name}</span>
                  </div>
                  <button
                    className={`${styles.toggle} ${isFailed ? styles.toggleOff : styles.toggleOn}`}
                    onClick={() => toggleSubstation(sub.id)}
                    aria-label={`${isFailed ? 'Restore' : 'Fail'} ${sub.name}`}
                  >
                    {isFailed ? 'FAILED' : 'ONLINE'}
                  </button>
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
