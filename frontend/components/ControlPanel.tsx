'use client';

import { useState, type CSSProperties } from 'react';
import { useSimulationStore } from '@/hooks/useSimulation';
import type { RiskLevel } from '@/lib/types';
import styles from './ControlPanel.module.css';

/* Aligned with the WCAG-AA status tokens in globals.css */
const RISK_COLORS: Record<RiskLevel, string> = {
  LOW: '#157050',
  MEDIUM: '#96601c',
  HIGH: '#9a5321',
  CRITICAL: '#a8453e',
};

const EXIT_NAMES: Record<number, string> = {
  7: 'South exit',
  105: 'West exit',
  119: 'East exit',
  217: 'North exit',
};

function formatDistance(meters: number) {
  if (!meters) return '-';
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

export default function ControlPanel() {
  const [searchNodeInput, setSearchNodeInput] = useState('');
  const {
    floodLevel,
    setFloodLevel,
    failedSubstations,
    toggleSubstation,
    originNode,
    setOriginNode,
    cityData,
    route,
    isLoading,
    backendOnline,
    error,
    fetchCityData,
    calculateRoute,
    clearRoute,
    substationLoads,
    overloadedSubstations,
    cascadedSubstations,
    showBuildings,
    setShowBuildings,
    showPowerLines,
    setShowPowerLines,
    showSubstations,
    setShowSubstations,
    showIntersections,
    setShowIntersections,
    showRoadNames,
    setShowRoadNames,
    setFlyToNodeId,
    applyScenario,
    mapFilterMode,
    setMapFilterMode,
    setFlyToCoords,
  } = useSimulationStore();

  const nodes = cityData?.nodes ?? [];
  const substations = cityData?.substations ?? [];
  const riskLevel = route?.risk_level ?? 'LOW';
  const riskColor = RISK_COLORS[riskLevel];
  const floodedCount = route?.flooded_nodes.length ?? nodes.filter((node) => node.elevation <= floodLevel * 1.7).length;

  return (
    <aside className={styles.panel} aria-label="Route planning controls">
      <div className={styles.panelHeader}>
        <div>
          <p className={styles.kicker}>Route planning desk</p>
          <h2>Scenario controls</h2>
        </div>
        <span className={`${styles.connection} ${backendOnline ? styles.connectionOnline : ''}`}><i />{backendOnline ? 'API live' : 'Local'}</span>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}
      {!backendOnline && <div className={styles.notice}><span>Local solver is active.</span><button onClick={fetchCityData}>Retry API</button></div>}

      <section className={styles.controlSection}>
        <div className={styles.sectionHeading}><div><h3>Load a scenario</h3></div><span className={styles.sectionHint}>Auto-solves</span></div>
        <div className={styles.scenarioGrid}>
          <button onClick={() => applyScenario('clear')} className={styles.scenarioButton}><b>Clear</b><span>Normal grid</span></button>
          <button onClick={() => applyScenario('flood')} className={styles.scenarioButton}><b>Bayou rise</b><span>Flood stress</span></button>
          <button onClick={() => applyScenario('cascade')} className={styles.scenarioButton}><b>Feeder loss</b><span>Utility cascade</span></button>
          <button onClick={() => applyScenario('heatwave')} className={styles.scenarioButton}><b>Heat peak</b><span>Transmission strain</span></button>
        </div>
      </section>

      <section className={styles.controlSection}>
        <div className={styles.sectionHeading}><div><h3>Water surface</h3></div><strong className={styles.value}>{floodLevel.toFixed(1)}<small>/ 10</small></strong></div>
        <input aria-label="Flood scenario level" className={styles.slider} type="range" min="0" max="10" step="0.1" value={floodLevel} onChange={(event) => setFloodLevel(Number(event.target.value))} style={{ '--fill': `${floodLevel * 10}%` } as CSSProperties} />
        <div className={styles.sliderLabels}><span>Dry</span><span>Modeled rise {(floodLevel * 1.7).toFixed(1)} m</span><span>Severe</span></div>
      </section>

      <section className={styles.controlSection}>
        <div className={styles.sectionHeading}><div><h3>Choose origin</h3></div><span className={styles.sectionHint}>Click map or select</span></div>
        <select className={styles.select} aria-label="Origin intersection" value={originNode} onChange={(event) => setOriginNode(Number(event.target.value))}>
          {nodes.map((node) => {
            const isFlooded = node.elevation <= floodLevel * 1.7;
            return <option key={node.id} value={node.id} disabled={isFlooded}>{`Node ${node.id}: ${node.intersection_name}${isFlooded ? ', flooded' : ''}`}</option>;
          })}
        </select>
        <div className={styles.searchRow}>
          <input className={styles.searchInput} type="number" min="0" max="224" placeholder="Node number 0-224" value={searchNodeInput} onChange={(event) => setSearchNodeInput(event.target.value)} />
          <button className={styles.smallButton} onClick={() => { const id = Number(searchNodeInput); if (Number.isInteger(id) && id >= 0 && id <= 224) setFlyToNodeId(id); }}>Locate</button>
        </div>
        <button className={styles.solveButton} onClick={() => void calculateRoute()} disabled={isLoading || !cityData}><span>{isLoading ? 'Recalculating corridor…' : 'Recalculate safe route'}</span><b>↗</b></button>
      </section>

      <section className={styles.controlSection}>
        <div className={styles.sectionHeading}><div><h3>Utility interruptions</h3></div><span className={styles.sectionHint}>{failedSubstations.length} manual</span></div>
        <div className={styles.substationList}>
          {substations.map((sub) => {
            const manualFailed = failedSubstations.includes(sub.id);
            const cascaded = cascadedSubstations.includes(sub.id);
            const failed = manualFailed || cascaded;
            const overloaded = overloadedSubstations.includes(sub.id);
            const load = substationLoads[sub.id] ?? sub.base_load_mw;
            const percentage = failed ? 0 : Math.min(100, Math.round((load / sub.capacity_mw) * 100));
            const status = failed ? (cascaded ? 'CASCADE' : 'OFFLINE') : overloaded ? 'OVERLOAD' : 'ONLINE';
            return <div className={styles.substationRow} key={sub.id}>
              <div className={styles.substationTop}><span className={`${styles.statusDot} ${failed ? styles.statusFailed : overloaded ? styles.statusWarn : styles.statusGood}`} /><div className={styles.substationName}><strong>{sub.name.replace(' Substation', '')}</strong><span>{status}, {failed ? '0' : load.toFixed(0)} / {sub.capacity_mw} MW</span></div><button className={`${styles.statusButton} ${failed ? styles.statusButtonOff : ''}`} onClick={() => toggleSubstation(sub.id)} disabled={cascaded}>{manualFailed ? 'Restore' : cascaded ? 'Locked' : 'Fail'}</button></div>
              <div className={styles.loadTrack}><i className={failed ? styles.loadFailed : overloaded ? styles.loadWarn : ''} style={{ width: `${percentage}%` }} /></div>
            </div>;
          })}
        </div>
      </section>

      <section className={styles.controlSection}>
        <div className={styles.sectionHeading}><div><h3>Map layers</h3></div><span className={styles.sectionHint}>Live canvas</span></div>
        <div className={styles.toggleGrid}>
          <label><input type="checkbox" checked={showBuildings} onChange={(event) => setShowBuildings(event.target.checked)} /><span>Block footprints</span></label>
          <label><input type="checkbox" checked={showRoadNames} onChange={(event) => setShowRoadNames(event.target.checked)} /><span>Road labels</span></label>
          <label><input type="checkbox" checked={showIntersections} onChange={(event) => setShowIntersections(event.target.checked)} /><span>Intersections</span></label>
          <label><input type="checkbox" checked={showSubstations} onChange={(event) => setShowSubstations(event.target.checked)} /><span>Substations</span></label>
          <label><input type="checkbox" checked={showPowerLines} onChange={(event) => setShowPowerLines(event.target.checked)} /><span>Utility links</span></label>
        </div>
        <div className={styles.modeRow}><span>Map treatment</span><div>{(['nominal', 'radar', 'thermal'] as const).map((mode) => <button key={mode} className={mapFilterMode === mode ? styles.modeActive : ''} onClick={() => setMapFilterMode(mode)}>{mode}</button>)}</div></div>
        <div className={styles.presetRow}><button onClick={() => setFlyToCoords({ lon: -95.3698, lat: 29.7604, elev: 4300, heading: 8, pitch: -62 })}>District overview</button><button onClick={() => setFlyToCoords({ lon: -95.375, lat: 29.755, elev: 1500, heading: 0, pitch: -70 })}>Street detail</button></div>
      </section>

      <section className={styles.routeSummary}>
        <div className={styles.routeSummaryTop}><div><p className={styles.kicker}>Current recommendation</p><h3 style={{ color: riskColor }}>{route?.success ? 'PASSABLE CORRIDOR' : route ? 'NO PASSABLE ROUTE' : 'AWAITING ASSESSMENT'}</h3></div><span className={styles.riskMark} style={{ color: riskColor }}>{route ? riskLevel : '-'}</span></div>
        <div className={styles.summaryGrid}><span><b>{route?.success ? `${route.eta_minutes.toFixed(1)} min` : '-'}</b><small>estimated time</small></span><span><b>{route?.success ? formatDistance(route.distance_m) : '-'}</b><small>street distance</small></span><span><b>{floodedCount}</b><small>flooded nodes</small></span><span><b>{route?.blocked_edges.length ?? 0}</b><small>closures</small></span></div>
        {route?.success && <div className={styles.stepList}>{route.route_steps.slice(0, 4).map((step, index) => <div className={styles.stepRow} key={`${step.from_node}-${step.to_node}`}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{step.instruction}</strong><small>{formatDistance(step.distance_m)}, {Math.round(step.duration_s / 60)} min</small></div></div>)}</div>}
        {route?.success && <p className={styles.destination}>{EXIT_NAMES[route.dest_node] ?? `Exit node ${route.dest_node}`}. {route.message}</p>}
        {route && <button className={styles.clearButton} onClick={clearRoute}>Clear route overlay</button>}
      </section>
    </aside>
  );
}
