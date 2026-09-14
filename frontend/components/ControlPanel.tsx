'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import Icon, { type IconName } from '@/components/Icon';
import { useSimulationStore, type Basemap, type ScenarioPreset } from '@/hooks/useSimulation';
import { formatDistance } from '@/lib/exports';
import { logicalJunctions } from '@/lib/network';
import { floodStage, vehicleCore, waterSurfaceM } from '@/lib/solver';
import styles from './ControlPanel.module.css';

type Tab = 'scenario' | 'route' | 'analysis' | 'layers';

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'scenario', label: 'Scenario', icon: 'water' },
  { id: 'route', label: 'Route', icon: 'route' },
  { id: 'analysis', label: 'Analysis', icon: 'chart' },
  { id: 'layers', label: 'Layers', icon: 'layers' },
];

const PRESETS: Array<{ id: ScenarioPreset; title: string; detail: (surface: number) => string; level: number }> = [
  { id: 'clear', title: 'Normal day', detail: () => 'Dry streets, full grid', level: 0 },
  { id: 'flood', title: 'Bayou flood', detail: (surface) => `Water at ${surface.toFixed(0)} m NAVD88`, level: 8 },
  { id: 'cascade', title: 'Feeder loss', detail: () => 'Two substations down', level: 0 },
  { id: 'heatwave', title: 'Heat peak', detail: () => 'Transmission strain', level: 0 },
];

const HAS_ION = Boolean((process.env.NEXT_PUBLIC_CESIUM_TOKEN ?? '').trim());
const FEET = 3.28084;

interface SearchHit {
  key: string;
  label: string;
  detail: string;
  kind: 'street' | 'junction';
  nodeId?: number;
  roadKey?: string;
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h3>{title}</h3>
        {aside && <span className={styles.aside}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Switch({ checked, onChange, label, detail }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail?: string }) {
  return (
    <label className={styles.switch}>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className={styles.switchTrack} aria-hidden="true"><i /></span>
      <span className={styles.switchText}>{label}{detail && <small>{detail}</small>}</span>
    </label>
  );
}

export default function ControlPanel() {
  const [tab, setTab] = useState<Tab>('scenario');
  const [collapsed, setCollapsed] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    // Phones start with the map visible; the sheet is one tap away.
    if (window.matchMedia('(max-width: 760px)').matches) setCollapsed(true);
  }, []);

  const route = useSimulationStore((state) => state.route);
  const cityData = useSimulationStore((state) => state.cityData);
  const evacuees = useSimulationStore((state) => state.evacuees);
  const isLoading = useSimulationStore((state) => state.isLoading);
  const closureMode = useSimulationStore((state) => state.closureMode);

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((item) => item.id === tab);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  useEffect(() => {
    // Turning the closure tool on from the keyboard or map toolbar opens the matching tab.
    if (closureMode) {
      setTab('route');
    }
  }, [closureMode]);

  const eta = route?.success ? (evacuees > 0 ? route.congested_eta_minutes : route.eta_minutes) : null;
  const statusLine = isLoading
    ? 'Solving the corridor…'
    : route?.success
      ? `${eta?.toFixed(1)} min to ${route.destination_name || cityData?.exit_names?.[String(route.dest_node)] || 'exit'}`
      : route ? 'No passable corridor' : 'Loading';
  const tabIndex = TABS.findIndex((item) => item.id === tab);
  const hiddenProps = collapsed ? ({ inert: '' } as Record<string, string>) : {};

  return (
    <>
      <button className={`${styles.reopen} ${collapsed ? styles.reopenVisible : ''}`} onClick={() => setCollapsed(false)} aria-hidden={!collapsed} tabIndex={collapsed ? 0 : -1}>
        <Icon name="layers" size={16} />Controls
        {route?.success && <span className={styles.reopenEta}>{eta?.toFixed(1)} min</span>}
      </button>
      <aside className={`${styles.panel} ${collapsed ? styles.panelHidden : ''}`} aria-label="Scenario and route controls" {...hiddenProps}>
        <header className={styles.header}>
          <div>
            <h2>Controls</h2>
            <p className={route && !route.success ? styles.statusBad : undefined} aria-live="polite">{statusLine}</p>
          </div>
          <button className={styles.iconButton} onClick={() => setCollapsed(true)} aria-label="Hide controls"><Icon name="chevronRight" size={16} /></button>
        </header>

        <div className={styles.tabs} role="tablist" aria-label="Control groups" onKeyDown={onTabKey} style={{ '--tab': tabIndex } as CSSProperties}>
          <span className={styles.tabIndicator} aria-hidden="true" />
          {TABS.map((item, index) => (
            <button
              key={item.id}
              ref={(element) => { tabRefs.current[index] = element; }}
              role="tab"
              id={`control-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`control-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <div className={styles.body} role="tabpanel" id={`control-panel-${tab}`} aria-labelledby={`control-tab-${tab}`} key={tab}>
          {tab === 'scenario' && <ScenarioTab />}
          {tab === 'route' && <RouteTab />}
          {tab === 'analysis' && <AnalysisTab />}
          {tab === 'layers' && <LayersTab />}
        </div>
      </aside>
    </>
  );
}

/* ------------------------------------------------------------ scenario */

function ScenarioTab() {
  const cityData = useSimulationStore((state) => state.cityData);
  const route = useSimulationStore((state) => state.route);
  const floodLevel = useSimulationStore((state) => state.floodLevel);
  const setFloodLevel = useSimulationStore((state) => state.setFloodLevel);
  const applyScenario = useSimulationStore((state) => state.applyScenario);
  const observations = useSimulationStore((state) => state.observations);
  const syncFloodToGage = useSimulationStore((state) => state.syncFloodToGage);
  const evacuees = useSimulationStore((state) => state.evacuees);
  const setEvacuees = useSimulationStore((state) => state.setEvacuees);
  const failedSubstations = useSimulationStore((state) => state.failedSubstations);
  const toggleSubstation = useSimulationStore((state) => state.toggleSubstation);
  const substationLoads = useSimulationStore((state) => state.substationLoads);
  const snapshots = useSimulationStore((state) => state.snapshots);
  const activeSnapshotId = useSimulationStore((state) => state.activeSnapshotId);
  const saveSnapshot = useSimulationStore((state) => state.saveSnapshot);
  const applySnapshot = useSimulationStore((state) => state.applySnapshot);
  const deleteSnapshot = useSimulationStore((state) => state.deleteSnapshot);
  const [snapshotLabel, setSnapshotLabel] = useState('');

  const surface = waterSurfaceM(cityData, floodLevel);
  const liveLevel = observations?.equivalent_flood_level ?? null;
  const activeSnapshot = snapshots.find((snap) => snap.id === activeSnapshotId);
  const currentEta = route?.success ? (evacuees > 0 ? route.congested_eta_minutes : route.eta_minutes) : null;

  return (
    <>
      <Section title="Start from a preset">
        <div className={styles.presetGrid}>
          {PRESETS.map((preset) => (
            <button key={preset.id} className={styles.preset} onClick={() => applyScenario(preset.id)}>
              <strong>{preset.title}</strong>
              <span>{preset.detail(waterSurfaceM(cityData, preset.level))}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Water surface" aside={`level ${floodLevel.toFixed(1)}`}>
        <div className={styles.bigValue}>
          <strong>{surface.toFixed(2)}<small>m</small></strong>
          <span>{(surface * FEET).toFixed(1)} ft NAVD88</span>
        </div>
        <input
          aria-label="Scenario water surface level"
          aria-valuetext={`${surface.toFixed(2)} metres NAVD88`}
          className={`${styles.slider} ${styles.sliderWater}`}
          type="range"
          min="0"
          max="10"
          step="0.1"
          value={floodLevel}
          onChange={(event) => setFloodLevel(Number(event.target.value))}
          style={{ '--fill': `${floodLevel * 10}%`, '--live': liveLevel !== null ? `${liveLevel * 10}%` : '-100%' } as CSSProperties}
        />
        <div className={styles.scale} aria-hidden="true">
          {[0, 2.5, 5, 7.5, 10].map((level) => <span key={level}>{waterSurfaceM(cityData, level).toFixed(0)} m</span>)}
        </div>
        <p className={styles.note}>
          {(route?.flooded_nodes.length ?? 0).toLocaleString()} junctions under water
          {route?.flooded_substations.length ? `, ${route.flooded_substations.length} substation${route.flooded_substations.length > 1 ? 's' : ''} flooded` : ''}.
        </p>
        {liveLevel !== null && observations && (
          <div className={styles.liveRow}>
            <span><i className={styles.liveDot} />Today {observations.gage_water_surface_m?.toFixed(2)} m at USGS {cityData?.flood_model?.gage.site}</span>
            <button className={styles.textButton} onClick={syncFloodToGage}>Use live reading</button>
          </div>
        )}
      </Section>

      <Section title="Evacuation demand" aside={evacuees ? `${evacuees.toLocaleString()} people` : 'free flow'}>
        <input
          aria-label="Evacuating population"
          className={styles.slider}
          type="range"
          min="0"
          max="100000"
          step="1000"
          value={evacuees}
          onChange={(event) => setEvacuees(Number(event.target.value))}
          style={{ '--fill': `${Math.min(100, evacuees / 1000)}%` } as CSSProperties}
        />
        <div className={styles.chips}>
          {([[0, 'None'], [10000, '10k'], [25000, '25k'], [50000, '50k'], [100000, '100k']] as const).map(([value, label]) => (
            <button key={value} className={evacuees === value ? styles.chipActive : ''} aria-pressed={evacuees === value} onClick={() => setEvacuees(value)}>{label}</button>
          ))}
        </div>
        {route?.success && evacuees > 0 && (
          <p className={styles.callout}>
            Travel runs <b>{route.congestion_factor.toFixed(2)}×</b> slower than free flow. Clearing everyone through every dry exit takes about <b>{route.corridor_capacity?.clearance_minutes.toFixed(0)} min</b>.
          </p>
        )}
      </Section>

      <Section title="Substations" aside={`${failedSubstations.length} manual outage${failedSubstations.length === 1 ? '' : 's'}`}>
        <ul className={styles.rows}>
          {(cityData?.substations ?? []).map((sub) => {
            const manual = failedSubstations.includes(sub.id);
            const flooded = route?.flooded_substations.includes(sub.id) ?? false;
            const cascaded = route?.cascaded_substations.includes(sub.id) ?? false;
            const overloaded = route?.overloaded_substations.includes(sub.id) ?? false;
            const offline = manual || flooded || cascaded;
            const load = offline ? 0 : substationLoads[sub.id] ?? sub.base_load_mw;
            const status = manual ? 'Manual outage' : flooded ? 'Flooded' : cascaded ? 'Cascade trip' : overloaded ? 'Overloaded' : 'In service';
            const tone = offline ? styles.toneCritical : overloaded ? styles.toneWatch : styles.toneSafe;
            return (
              <li key={sub.id} className={styles.subRow}>
                <span className={`${styles.dot} ${tone}`} />
                <span className={styles.rowBody}>
                  <strong>{sub.name.replace(' Substation', '')}</strong>
                  <small>{status}, {load.toFixed(0)} of {sub.capacity_mw} MW</small>
                  <span className={styles.meter}><i className={tone} style={{ transform: `scaleX(${Math.min(1, load / sub.capacity_mw)})` }} /></span>
                </span>
                <button className={styles.smallButton} onClick={() => toggleSubstation(sub.id)} disabled={(flooded || cascaded) && !manual}>
                  {manual ? 'Restore' : flooded || cascaded ? 'Locked' : 'Fail'}
                </button>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Snapshots" aside={`${snapshots.length} saved on this device`}>
        <form className={styles.inline} onSubmit={(event) => { event.preventDefault(); saveSnapshot(snapshotLabel); setSnapshotLabel(''); }}>
          <input className={styles.input} maxLength={40} placeholder="Name this scenario" value={snapshotLabel} onChange={(event) => setSnapshotLabel(event.target.value)} aria-label="Snapshot name" />
          <button className={styles.smallButton} type="submit">Save</button>
        </form>
        {snapshots.length > 0 && (
          <ul className={styles.rows}>
            {snapshots.map((snap) => (
              <li key={snap.id} className={`${styles.snapRow} ${activeSnapshotId === snap.id ? styles.rowActive : ''}`}>
                <span className={styles.rowBody}>
                  <strong>{snap.label}</strong>
                  <small>{snap.travelMode}, level {snap.floodLevel.toFixed(1)}{snap.closures.length ? `, ${snap.closures.length} closures` : ''}, {snap.outcome.success ? `${snap.outcome.eta_minutes.toFixed(1)} min` : 'no route'}</small>
                </span>
                <button className={styles.smallButton} onClick={() => applySnapshot(snap.id)}>Restore</button>
                <button className={styles.iconButton} onClick={() => deleteSnapshot(snap.id)} aria-label={`Delete ${snap.label}`}><Icon name="close" size={14} /></button>
              </li>
            ))}
          </ul>
        )}
        {activeSnapshot && route && (
          <div className={styles.diff}>
            <span>Compared with <b>{activeSnapshot.label}</b></span>
            <div>
              <span><small>Now</small><b>{currentEta !== null ? `${currentEta.toFixed(1)} min` : 'no route'}</b></span>
              <span><small>Saved</small><b>{activeSnapshot.outcome.success ? `${activeSnapshot.outcome.eta_minutes.toFixed(1)} min` : 'no route'}</b></span>
              <span>
                <small>Change</small>
                <b className={currentEta !== null && activeSnapshot.outcome.success && currentEta <= activeSnapshot.outcome.eta_minutes ? styles.better : styles.worse}>
                  {currentEta !== null && activeSnapshot.outcome.success ? `${(currentEta - activeSnapshot.outcome.eta_minutes >= 0 ? '+' : '')}${(currentEta - activeSnapshot.outcome.eta_minutes).toFixed(1)} min` : '-'}
                </b>
              </span>
            </div>
          </div>
        )}
      </Section>
    </>
  );
}

/* --------------------------------------------------------------- route */

function RouteTab() {
  const cityData = useSimulationStore((state) => state.cityData);
  const route = useSimulationStore((state) => state.route);
  const floodLevel = useSimulationStore((state) => state.floodLevel);
  const originNode = useSimulationStore((state) => state.originNode);
  const setOriginNode = useSimulationStore((state) => state.setOriginNode);
  const travelMode = useSimulationStore((state) => state.travelMode);
  const setTravelMode = useSimulationStore((state) => state.setTravelMode);
  const destinationId = useSimulationStore((state) => state.destinationId);
  const setDestination = useSimulationStore((state) => state.setDestination);
  const closures = useSimulationStore((state) => state.closures);
  const closureMode = useSimulationStore((state) => state.closureMode);
  const setClosureMode = useSimulationStore((state) => state.setClosureMode);
  const toggleClosure = useSimulationStore((state) => state.toggleClosure);
  const clearClosures = useSimulationStore((state) => state.clearClosures);
  const evacuees = useSimulationStore((state) => state.evacuees);
  const setFlyToNodeId = useSimulationStore((state) => state.setFlyToNodeId);
  const setFlyToRoadKey = useSimulationStore((state) => state.setFlyToRoadKey);
  const userLocation = useSimulationStore((state) => state.userLocation);
  const locationStatus = useSimulationStore((state) => state.locationStatus);
  const locationMessage = useSimulationStore((state) => state.locationMessage);
  const followLocation = useSimulationStore((state) => state.followLocation);
  const locateUser = useSimulationStore((state) => state.locateUser);
  const setFollowLocation = useSimulationStore((state) => state.setFollowLocation);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeHit, setActiveHit] = useState(0);

  const surface = waterSurfaceM(cityData, floodLevel);
  const nodes = useMemo(() => cityData?.nodes ?? [], [cityData]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const junctionIds = useMemo(() => (cityData ? logicalJunctions(cityData).ids : new Set<number>()), [cityData]);
  const core = useMemo(() => (cityData ? vehicleCore(cityData) : new Set<number>()), [cityData]);
  const origin = nodesById.get(originNode);
  const edgesByKey = useMemo(() => new Map((cityData?.edges ?? []).map((edge) => [`${Math.min(edge.source, edge.target)}-${Math.max(edge.source, edge.target)}`, edge])), [cityData]);

  const originOptions = useMemo(() => nodes
    .filter((node) => (junctionIds.has(node.id) && !node.elevated) || node.id === originNode)
    .sort((a, b) => a.intersection_name.localeCompare(b.intersection_name)), [nodes, junctionIds, originNode]);

  const searchIndex = useMemo(() => {
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    (cityData?.edges ?? []).forEach((edge) => {
      if (!edge.road_name || edge.road_name === 'Unnamed street') return;
      const key = `${Math.min(edge.source, edge.target)}-${Math.max(edge.source, edge.target)}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ key, kind: 'street', label: edge.road_name, detail: `${nodesById.get(edge.source)?.intersection_name ?? edge.source} to ${nodesById.get(edge.target)?.intersection_name ?? edge.target}`, roadKey: key });
    });
    nodes.filter((node) => junctionIds.has(node.id)).forEach((node) => {
      hits.push({ key: `node-${node.id}`, kind: 'junction', label: node.intersection_name, detail: `Junction, ground ${node.elevation.toFixed(1)} m`, nodeId: node.id });
    });
    return hits;
  }, [cityData, nodes, nodesById, junctionIds]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return searchIndex
      .map((hit) => ({ hit, rank: hit.label.toLowerCase().startsWith(needle) ? 0 : hit.label.toLowerCase().includes(needle) ? 1 : 2 }))
      .filter((entry) => entry.rank < 2)
      .sort((a, b) => a.rank - b.rank || (a.hit.kind === 'junction' ? -1 : 1) || a.hit.label.localeCompare(b.hit.label))
      .slice(0, 8)
      .map((entry) => entry.hit);
  }, [query, searchIndex]);

  const choose = (hit: SearchHit) => {
    setOpen(false);
    setQuery('');
    if (hit.kind === 'junction' && hit.nodeId !== undefined) {
      setOriginNode(hit.nodeId);
      setFlyToNodeId(hit.nodeId);
    } else if (hit.roadKey) {
      setFlyToRoadKey(hit.roadKey);
    }
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActiveHit((value) => Math.min(results.length - 1, value + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveHit((value) => Math.max(0, value - 1)); }
    else if (event.key === 'Enter' && results[activeHit]) { event.preventDefault(); choose(results[activeHit]); }
    else if (event.key === 'Escape') setOpen(false);
  };

  const eta = route?.success ? (evacuees > 0 ? route.congested_eta_minutes : route.eta_minutes) : null;
  const originDry = origin ? floodStage(origin) > surface : false;
  const pocket = origin && travelMode !== 'foot' && !core.has(origin.id);

  return (
    <>
      <Section title="Travel mode">
        <div className={styles.segment} role="radiogroup" aria-label="Travel mode" style={{ '--seg': ['vehicle', 'foot', 'ems'].indexOf(travelMode), '--count': 3 } as CSSProperties}>
          <span className={styles.segmentThumb} aria-hidden="true" />
          {([['vehicle', 'Vehicle'], ['foot', 'On foot'], ['ems', 'EMS']] as const).map(([mode, label]) => (
            <button key={mode} role="radio" aria-checked={travelMode === mode} className={travelMode === mode ? styles.segmentActive : ''} onClick={() => setTravelMode(mode)}>{label}</button>
          ))}
        </div>
        <p className={styles.note}>{travelMode === 'foot' ? 'Walking pace on sidewalks in both directions of one-way streets.' : travelMode === 'ems' ? 'Faster than posted limits, strong preference for arterials; obeys one-way rules.' : 'Posted speed limits and one-way rules, mild preference for arterials.'}</p>
      </Section>

      <Section title="Origin" aside={origin ? `ground ${origin.elevation.toFixed(1)} m` : undefined}>
        <button className={styles.locateButton} onClick={() => void locateUser()} disabled={locationStatus === 'requesting'} aria-busy={locationStatus === 'requesting'}>
          <Icon name="locate" size={16} />
          {locationStatus === 'requesting' ? 'Finding your location…' : userLocation?.active ? 'Update from my location' : 'Use my location'}
        </button>
        {userLocation && (
          <div className={styles.locateFollow}>
            <Switch checked={followLocation} onChange={setFollowLocation} label="Follow my location" detail="Moves the start as you move" />
          </div>
        )}
        {locationMessage && locationStatus !== 'located' && <p className={`${styles.note} ${styles.noteWarn}`}>{locationMessage}</p>}
        {userLocation?.active && (
          <p className={styles.note}>
            You are {Math.round(userLocation.distanceToStreetM)} m from {userLocation.streetName}. The route starts {Math.round(userLocation.accessM)} m along it, at {origin?.intersection_name} (accuracy ±{Math.round(userLocation.fix.accuracy)} m).
          </p>
        )}
        <div className={styles.search}>
          <Icon name="search" size={15} />
          <input
            className={styles.input}
            type="search"
            placeholder="Search a street or junction"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setOpen(true); setActiveHit(0); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={onSearchKey}
            role="combobox"
            aria-expanded={open && results.length > 0}
            aria-controls="origin-search-results"
            aria-activedescendant={open && results[activeHit] ? `search-hit-${activeHit}` : undefined}
            aria-label="Search streets and junctions"
          />
          {open && results.length > 0 && (
            <ul className={styles.results} id="origin-search-results" role="listbox">
              {results.map((hit, index) => (
                <li key={hit.key} id={`search-hit-${index}`} role="option" aria-selected={index === activeHit}>
                  <button className={index === activeHit ? styles.resultActive : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(hit)}>
                    <span className={styles.resultKind}>{hit.kind === 'street' ? 'Street' : 'Start'}</span>
                    <span className={styles.rowBody}><strong>{hit.label}</strong><small>{hit.detail}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <select className={styles.select} aria-label="Origin junction" value={originNode} onChange={(event) => setOriginNode(Number(event.target.value))}>
          {originOptions.map((node) => {
            const flooded = floodStage(node) <= surface;
            return <option key={node.id} value={node.id} disabled={flooded}>{node.intersection_name}{flooded ? ' (under water)' : ''}</option>;
          })}
        </select>
        {origin && (
          <p className={`${styles.note} ${!originDry || pocket ? styles.noteWarn : ''}`}>
            {!originDry
              ? 'This junction is under the modeled water. Pick a dry one.'
              : pocket
                ? 'One-way pocket: vehicles cannot legally leave this junction. Pick a through street or switch to on foot.'
                : `Floods when the water reaches ${floodStage(origin).toFixed(2)} m${origin.elevated ? ' (bridge deck)' : ''}, ${(floodStage(origin) - surface).toFixed(1)} m above the current surface.`}
          </p>
        )}
      </Section>

      <Section title="Destination">
        <div className={styles.options} role="radiogroup" aria-label="Destination">
          <button role="radio" aria-checked={!destinationId} className={`${styles.option} ${!destinationId ? styles.optionActive : ''}`} onClick={() => setDestination(null)}>
            <span className={`${styles.kind} ${styles.kindExit}`}>Exit</span>
            <span className={styles.rowBody}><strong>Safest perimeter exit</strong><small>Chooses among {cityData?.safe_exits.length ?? 4} exits</small></span>
          </button>
          {(cityData?.shelters ?? []).map((shelter) => {
            const node = nodesById.get(shelter.node);
            const flooded = node ? floodStage(node) <= surface : false;
            const active = destinationId === shelter.id;
            return (
              <button key={shelter.id} role="radio" aria-checked={active} disabled={flooded && !active} className={`${styles.option} ${active ? styles.optionActive : ''}`} onClick={() => setDestination(shelter.id)}>
                <span className={`${styles.kind} ${shelter.kind === 'medical' ? styles.kindMedical : styles.kindShelter}`}>{shelter.kind === 'medical' ? 'Medical' : 'Shelter'}</span>
                <span className={styles.rowBody}><strong>{shelter.name}</strong><small>{flooded ? 'Approach under water' : `${shelter.capacity.toLocaleString()} capacity`}</small></span>
                {active && route?.success && eta !== null && <span className={styles.rowValue}>{eta.toFixed(1)} min</span>}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Road closures" aside={`${closures.length} active`}>
        <Switch checked={closureMode} onChange={setClosureMode} label="Close streets on the map" detail="Click a street to close it, click again to reopen (C)" />
        {closures.length > 0 && (
          <ul className={styles.rows}>
            {closures.map(([u, v]) => {
              const key = `${Math.min(u, v)}-${Math.max(u, v)}`;
              const edge = edgesByKey.get(key);
              return (
                <li key={key} className={styles.closureRow}>
                  <Icon name="barrier" size={15} />
                  <span className={styles.rowBody}>
                    <button className={styles.linkish} onClick={() => setFlyToRoadKey(key)}>{edge?.road_name && edge.road_name !== 'Unnamed street' ? edge.road_name : 'Street segment'}</button>
                    <small>{nodesById.get(u)?.intersection_name} to {nodesById.get(v)?.intersection_name}</small>
                  </span>
                  <button className={styles.smallButton} onClick={() => toggleClosure(u, v)}>Reopen</button>
                </li>
              );
            })}
          </ul>
        )}
        {closures.length > 1 && <button className={styles.textButton} onClick={clearClosures}>Reopen all</button>}
      </Section>

      <Section title="Recommendation" aside={route?.risk_level ? `risk ${route.risk_level.toLowerCase()}` : undefined}>
        {route?.success ? (
          <>
            <div className={styles.summary}>
              <span><b>{eta?.toFixed(1)}</b><small>min{evacuees > 0 ? ' with demand' : ''}</small></span>
              <span><b>{formatDistance(route.distance_m)}</b><small>street distance</small></span>
              <span><b>{(route.corridor_capacity?.people_per_hour ?? 0).toLocaleString()}</b><small>people per hour</small></span>
              <span><b>{route.blocked_edges.length}</b><small>segments under water</small></span>
            </div>
            <ol className={styles.steps}>
              {route.route_steps.slice(0, 5).map((step, index) => (
                <li key={`${step.from_node}-${index}`}><span>{index + 1}</span><div><strong>{step.instruction}</strong><small>{formatDistance(step.distance_m)}</small></div></li>
              ))}
            </ol>
            {route.route_steps.length > 5 && <p className={styles.note}>{route.route_steps.length - 5} more steps in the route audit.</p>}
          </>
        ) : (
          <p className={`${styles.note} ${styles.noteWarn}`}>{route?.message ?? 'Waiting for the first assessment.'}</p>
        )}
      </Section>
    </>
  );
}

/* ------------------------------------------------------------ analysis */

function AnalysisTab() {
  const cityData = useSimulationStore((state) => state.cityData);
  const route = useSimulationStore((state) => state.route);
  const corridorComparison = useSimulationStore((state) => state.corridorComparison);
  const triggerPoints = useSimulationStore((state) => state.triggerPoints);
  const floodLevel = useSimulationStore((state) => state.floodLevel);
  const evacuees = useSimulationStore((state) => state.evacuees);
  const isochrone = useSimulationStore((state) => state.isochrone);
  const isochroneVisible = useSimulationStore((state) => state.isochroneVisible);
  const setIsochroneVisible = useSimulationStore((state) => state.setIsochroneVisible);
  const setFlyToNodeId = useSimulationStore((state) => state.setFlyToNodeId);
  const surface = waterSurfaceM(cityData, floodLevel);

  return (
    <>
      <Section title="Exit corridors" aside="safest first">
        {!corridorComparison?.corridors.length ? (
          <p className={`${styles.note} ${styles.noteWarn}`}>No perimeter exit is reachable from this origin.</p>
        ) : (
          <ol className={styles.rank}>
            {corridorComparison.corridors.map((corridor, index) => (
              <li key={corridor.exit_node}>
                <button className={route?.success && route.dest_node === corridor.exit_node ? styles.rankChosen : ''} onClick={() => setFlyToNodeId(corridor.exit_node)}>
                  <span className={styles.rankIndex}>{index + 1}</span>
                  <span className={styles.rowBody}><strong>{corridor.exit_name}</strong><small>{formatDistance(corridor.distance_m)}, {corridor.people_per_hour.toLocaleString()}/h, {corridor.hazard_count} hazard segment{corridor.hazard_count === 1 ? '' : 's'}</small></span>
                  <span className={styles.rowValue}>{(evacuees > 0 ? corridor.congested_eta_minutes : corridor.eta_minutes).toFixed(1)}<small>min</small></span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Trigger points" aside="cut-off water surface">
        {!triggerPoints?.targets.length ? (
          <p className={styles.note}>Trigger points appear once an origin is set.</p>
        ) : (
          <ul className={styles.rows}>
            {triggerPoints.targets.map((target) => {
              const margin = target.threshold_m - surface;
              const tone = margin <= 0 ? styles.toneCritical : margin < 1 ? styles.toneWatch : styles.toneSafe;
              return (
                <li key={`${target.kind}-${target.id}`} className={styles.triggerRow}>
                  <span className={`${styles.diamond} ${tone}`} />
                  <span className={styles.rowBody}>
                    <button className={styles.linkish} onClick={() => setFlyToNodeId(target.limited_by === 'corridor' ? target.bottleneck_node : target.node)}>{target.name}</button>
                    <small>{target.limited_by === 'corridor' ? `${target.bottleneck_road} floods first` : target.limited_by === 'origin' ? 'Origin floods first' : 'Its own approach floods first'}</small>
                  </span>
                  <span className={styles.rowValue}>{target.threshold_m.toFixed(1)}<small>{margin <= 0 ? 'cut off' : `+${margin.toFixed(1)} m`}</small></span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Reachability" aside={isochroneVisible ? 'on the map' : undefined}>
        <Switch checked={isochroneVisible} onChange={setIsochroneVisible} label="Show streets reachable in time" detail="Real travel time from the origin, slowed by demand" />
        {isochroneVisible && isochrone && (
          <div className={styles.rings}>
            {isochrone.rings.map((ring, index) => (
              <span key={ring.minutes} style={{ '--ring': index } as CSSProperties}><i />{ring.minutes} min<small>{ring.node_count} junctions</small></span>
            ))}
            {isochrone.congestion_factor > 1 && <p className={styles.note}>Demand slows every street {isochrone.congestion_factor.toFixed(2)}×.</p>}
          </div>
        )}
      </Section>
    </>
  );
}

/* -------------------------------------------------------------- layers */

function LayersTab() {
  const basemap = useSimulationStore((state) => state.basemap);
  const setBasemap = useSimulationStore((state) => state.setBasemap);
  const showBuildings = useSimulationStore((state) => state.showBuildings);
  const setShowBuildings = useSimulationStore((state) => state.setShowBuildings);
  const showWaterways = useSimulationStore((state) => state.showWaterways);
  const setShowWaterways = useSimulationStore((state) => state.setShowWaterways);
  const showIntersections = useSimulationStore((state) => state.showIntersections);
  const setShowIntersections = useSimulationStore((state) => state.setShowIntersections);
  const showRoadNames = useSimulationStore((state) => state.showRoadNames);
  const setShowRoadNames = useSimulationStore((state) => state.setShowRoadNames);
  const showSubstations = useSimulationStore((state) => state.showSubstations);
  const setShowSubstations = useSimulationStore((state) => state.setShowSubstations);
  const showPowerLines = useSimulationStore((state) => state.showPowerLines);
  const setShowPowerLines = useSimulationStore((state) => state.setShowPowerLines);
  const setFlyToCoords = useSimulationStore((state) => state.setFlyToCoords);
  const cityData = useSimulationStore((state) => state.cityData);
  const options: Array<[Basemap, string]> = [['dark', 'Dark'], ['light', 'Light'], ['aerial', 'Aerial']];

  return (
    <>
      <Section title="Basemap">
        <div className={styles.segment} role="radiogroup" aria-label="Basemap" style={{ '--seg': options.findIndex(([id]) => id === basemap), '--count': 3 } as CSSProperties}>
          <span className={styles.segmentThumb} aria-hidden="true" />
          {options.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={basemap === id} disabled={id === 'aerial' && !HAS_ION} className={basemap === id ? styles.segmentActive : ''} onClick={() => setBasemap(id)} title={id === 'aerial' && !HAS_ION ? 'Needs a Cesium ion token' : undefined}>{label}</button>
          ))}
        </div>
        <p className={styles.note}>Light suits daylight rooms and printouts. Aerial imagery helps confirm what is on the ground.</p>
      </Section>

      <Section title="Layers">
        <div className={styles.switches}>
          <Switch checked={showBuildings} onChange={setShowBuildings} label="Buildings" detail="Tinted blue when flooded, dimmed without power" />
          <Switch checked={showWaterways} onChange={setShowWaterways} label="Bayou centerlines" />
          <Switch checked={showIntersections} onChange={setShowIntersections} label="Junction dots" detail="Click one to start from it" />
          <Switch checked={showRoadNames} onChange={setShowRoadNames} label="Street names" />
          <Switch checked={showSubstations} onChange={setShowSubstations} label="Substations" />
          <Switch checked={showPowerLines} onChange={setShowPowerLines} label="Transmission links" />
        </div>
      </Section>

      <Section title="Camera">
        <div className={styles.cameraGrid}>
          <button className={styles.preset} onClick={() => setFlyToCoords({ lon: cityData?.center_lon ?? -95.3698, lat: cityData?.center_lat ?? 29.7604, elev: 5600, heading: 0, pitch: -89 })}>
            <strong>District</strong><span>Top-down overview</span>
          </button>
          <button className={styles.preset} onClick={() => setFlyToCoords({ lon: (cityData?.center_lon ?? -95.3698) + 0.004, lat: (cityData?.center_lat ?? 29.7604) - 0.03, elev: 2600, heading: -18, pitch: -38 })}>
            <strong>Skyline</strong><span>Tilted 3D from the south</span>
          </button>
        </div>
      </Section>
    </>
  );
}
