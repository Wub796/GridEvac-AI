'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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

// Exit labels resolve from the loaded network's intersection names.
const EXIT_NAMES: Record<number, string> = {};

function formatDistance(meters: number) {
  if (!meters) return '-';
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

interface SearchHit {
  key: string;
  label: string;
  sublabel: string;
  kind: 'street' | 'intersection';
  nodeId?: number;
  roadKey?: string;
}

export default function ControlPanel() {
  const [searchInput, setSearchInput] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [showTab, setShowTab] = useState(false);
  const collapseTimer = useRef<number | null>(null);

  // The show tab fades in only after the panel has slid out, so the two
  // elements never cross paths mid-animation.
  useEffect(() => {
    if (collapseTimer.current) window.clearTimeout(collapseTimer.current);
    if (collapsed) {
      collapseTimer.current = window.setTimeout(() => setShowTab(true), 260);
    } else {
      setShowTab(false);
    }
    return () => {
      if (collapseTimer.current) window.clearTimeout(collapseTimer.current);
    };
  }, [collapsed]);

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
    travelMode,
    setTravelMode,
    corridorComparison,
    isochrone,
    isochroneVisible,
    setIsochroneVisible,
    refreshIsochrone,
    setFlyToNodeId,
    setFlyToRoadKey,
    addLog,
    applyScenario,
    mapFilterMode,
    setMapFilterMode,
    setFlyToCoords,
  } = useSimulationStore();

  const nodes = useMemo(() => cityData?.nodes ?? [], [cityData]);
  const substations = cityData?.substations ?? [];
  const riskLevel = route?.risk_level ?? 'LOW';
  const riskColor = RISK_COLORS[riskLevel];
  const floodedCount = route?.flooded_nodes.length ?? nodes.filter((node) => node.elevation <= floodLevel * 1.7).length;

  // Street search: indexes road segments and junctions once per dataset, then
  // answers prefix/substring queries client-side with zero latency.
  const searchIndex = useMemo(() => {
    const streets: SearchHit[] = [];
    const seenRoads = new Map<string, SearchHit>();
    const edges = cityData?.edges ?? [];
    const nodeNames = new Map(nodes.map((node) => [node.id, node.intersection_name]));
    edges.forEach((edge) => {
      if (!edge.road_name || edge.road_name === 'Unnamed street') return;
      const key = `${Math.min(edge.source, edge.target)}-${Math.max(edge.source, edge.target)}`;
      const existing = seenRoads.get(key);
      if (existing) return;
      const sub = nodeNames.get(edge.source) ?? '?';
      const dst = nodeNames.get(edge.target) ?? '?';
      const hit: SearchHit = {
        key,
        label: edge.road_name,
        sublabel: `${sub} → ${dst}`,
        kind: 'street',
        roadKey: key,
      };
      seenRoads.set(key, hit);
      streets.push(hit);
    });
    const junctions: SearchHit[] = nodes.map((node) => ({
      key: `node-${node.id}`,
      label: node.intersection_name,
      sublabel: `Intersection · node ${node.id}`,
      kind: 'intersection' as const,
      nodeId: node.id,
    }));
    return { streets, junctions };
  }, [cityData, nodes]);

  const [searchOpen, setSearchOpen] = useState(false);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!searchOpen) return;
    const onClickAway = (event: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(event.target as Node)) setSearchOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, [searchOpen]);

  const query = searchInput.trim().toLowerCase();
  const searchHits: SearchHit[] = useMemo(() => {
    if (query.length < 2) return [];
    const startsWith = (value: string) => value.toLowerCase().startsWith(query);
    const includes = (value: string) => value.toLowerCase().includes(query);
    const scored = [...searchIndex.streets, ...searchIndex.junctions]
      .map((hit) => ({ hit, rank: startsWith(hit.label) ? 0 : includes(hit.label) ? 1 : 2 }))
      .filter((entry) => entry.rank < 2)
      .sort((a, b) => a.rank - b.rank || a.hit.label.localeCompare(b.hit.label));
    return scored.slice(0, 7).map((entry) => entry.hit);
  }, [query, searchIndex]);

  const gotoSearchHit = (hit: SearchHit) => {
    setSearchOpen(false);
    if (hit.kind === 'street' && hit.roadKey) {
      setFlyToRoadKey(hit.roadKey);
      addLog(`Map focused on ${hit.label}.`);
    } else if (hit.kind === 'intersection' && hit.nodeId !== undefined) {
      setOriginNode(hit.nodeId);
      setFlyToNodeId(hit.nodeId);
      addLog(`Origin set to ${hit.label}.`);
    }
    setSearchInput('');
  };

  return (
    <>
      <button className={`${styles.collapseTab} ${showTab ? styles.tabVisible : ''}`} onClick={() => setCollapsed(false)} aria-expanded={false} aria-hidden={!showTab} tabIndex={showTab ? 0 : -1}>
        Scenario controls
      </button>
      <aside className={`${styles.panel} ${collapsed ? styles.panelHidden : ''}`} aria-label="Route planning controls" aria-hidden={collapsed}>
      <div className={styles.panelHeader}>
        <div>
          <p className={styles.kicker}>Route planning desk</p>
          <h2>Scenario controls</h2>
        </div>
        <div className={styles.headerRight}>
          <span className={`${styles.connection} ${backendOnline ? styles.connectionOnline : ''}`}><i />{backendOnline ? 'API live' : 'Local'}</span>
          <button className={styles.collapseButton} onClick={() => setCollapsed(true)} aria-label="Hide controls">&rsaquo;</button>
        </div>
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
        <div className={styles.modeSegment} role="radiogroup" aria-label="Travel mode">
          {([['vehicle', 'Vehicle', 'response vehicle'], ['foot', 'On foot', 'evacuation on foot'], ['ems', 'EMS', 'priority medical run']] as const).map(([mode, label, hint]) => (
            <button key={mode} role="radio" aria-checked={travelMode === mode} title={hint}
              className={`${styles.modeSegmentBtn} ${travelMode === mode ? styles.modeSegmentActive : ''}`}
              onClick={() => setTravelMode(mode)}>{label}</button>
          ))}
        </div>
        <select className={styles.select} aria-label="Origin intersection" value={originNode} onChange={(event) => setOriginNode(Number(event.target.value))}>
          {nodes.map((node) => {
            const isFlooded = node.elevation <= floodLevel * 1.7;
            return <option key={node.id} value={node.id} disabled={isFlooded}>{`Node ${node.id}: ${node.intersection_name}${isFlooded ? ', flooded' : ''}`}</option>;
          })}
        </select>
        <div className={styles.searchRow} ref={searchBoxRef}>
          <input className={styles.searchInput} type="text" placeholder="Search streets or intersections…" value={searchInput}
            onChange={(event) => { setSearchInput(event.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(event) => { if (event.key === 'Escape') setSearchOpen(false); }}
            aria-label="Search streets or intersections" role="combobox" aria-expanded={searchOpen && searchHits.length > 0} aria-controls="map-search-results" />
          {searchOpen && searchHits.length > 0 && (
            <div className={styles.searchResults} id="map-search-results" role="listbox">
              {searchHits.map((hit) => (
                <button key={`${hit.kind}-${hit.key}`} role="option" aria-selected={false} className={styles.searchResult} onClick={() => gotoSearchHit(hit)}>
                  <span className={styles.searchResultKind}>{hit.kind === 'street' ? 'ST' : 'IX'}</span>
                  <span className={styles.searchResultBody}><strong>{hit.label}</strong><small>{hit.sublabel}</small></span>
                </button>
              ))}
            </div>
          )}
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
        <div className={styles.presetRow}><button onClick={() => setFlyToCoords({ lon: -95.3698, lat: 29.7604, elev: 5200, heading: 0, pitch: -88 })}>District overview</button><button onClick={() => setFlyToCoords({ lon: -95.375, lat: 29.755, elev: 1500, heading: 0, pitch: -80 })}>Street detail</button></div>
      </section>

      <section className={styles.routeSummary}>
        <div className={styles.routeSummaryTop}><div><p className={styles.kicker}>Current recommendation</p><h3 style={{ color: riskColor }}>{route?.success ? 'PASSABLE CORRIDOR' : route ? 'NO PASSABLE ROUTE' : 'AWAITING ASSESSMENT'}</h3></div><span className={styles.riskMark} style={{ color: riskColor }}>{route ? riskLevel : '-'}</span></div>
        <div className={styles.summaryGrid}><span><b>{route?.success ? `${route.eta_minutes.toFixed(1)} min` : '-'}</b><small>estimated time</small></span><span><b>{route?.success ? formatDistance(route.distance_m) : '-'}</b><small>street distance</small></span><span><b>{floodedCount}</b><small>flooded nodes</small></span><span><b>{route?.blocked_edges.length ?? 0}</b><small>closures</small></span></div>
        {route?.success && <div className={styles.stepList}>{route.route_steps.slice(0, 4).map((step, index) => <div className={styles.stepRow} key={`${step.from_node}-${step.to_node}`}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{step.instruction}</strong><small>{formatDistance(step.distance_m)}, {Math.round(step.duration_s / 60)} min</small></div></div>)}</div>}
        {route?.success && <p className={styles.destination}>{EXIT_NAMES[route.dest_node] ?? `Exit node ${route.dest_node}`}. {route.message}</p>}
        {route && <button className={styles.clearButton} onClick={clearRoute}>Clear route overlay</button>}
      </section>

      <section className={styles.controlSection}>
        <div className={styles.sectionHeading}><div><h3>Exit corridors</h3></div><span className={styles.sectionHint}>{corridorComparison?.corridors.length ?? 0} ranked</span></div>
        <div className={styles.corridorList}>
          {(corridorComparison?.corridors ?? []).map((corridor, index) => {
            const isChosen = route?.success && route.dest_node === corridor.exit_node;
            const isFastest = index === 0;
            return <button key={corridor.exit_node}
              className={`${styles.corridorRow} ${isChosen ? styles.corridorChosen : ''}`}
              onClick={() => setFlyToNodeId(corridor.exit_node)}>
              <span className={`${styles.corridorRank} ${isFastest ? styles.corridorRankBest : ''}`}>{String(index + 1).padStart(2, '0')}</span>
              <span className={styles.corridorBody}><strong>{corridor.exit_name}</strong><small>{formatDistance(corridor.distance_m)} · {corridor.hazard_count} hazard segment{corridor.hazard_count === 1 ? '' : 's'}</small></span>
              <span className={styles.corridorEta}>{corridor.eta_minutes.toFixed(1)}<small> min</small></span>
            </button>;
          })}
          {!corridorComparison && <p className={styles.corridorEmpty}>Load a scenario to rank every perimeter exit.</p>}
        </div>
      </section>

      <section className={styles.controlSection}>
        <div className={styles.sectionHeading}><div><h3>Reachability</h3></div><span className={styles.sectionHint}>{isochroneVisible ? 'on map' : 'hidden'}</span></div>
        <div className={styles.isochroneRow}>
          <button className={`${styles.isochroneToggle} ${isochroneVisible ? styles.isochroneOn : ''}`} onClick={() => { const next = !isochroneVisible; setIsochroneVisible(next); if (next) void refreshIsochrone(); }}>
            {isochroneVisible ? 'Hide reachability rings' : 'Show reachability rings'}
          </button>
          {isochroneVisible && isochrone && (
            <div className={styles.isochroneLegend}>
              {isochrone.rings.map((ring, index) => <span key={ring.minutes}><i data-ring={index} />{ring.minutes} min · {ring.node_count}</span>)}
            </div>
          )}
        </div>
      </section>
      </aside>
    </>
  );
}
