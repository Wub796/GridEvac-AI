'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useSimulationStore } from '@/hooks/useSimulation';
import ControlPanel from '@/components/ControlPanel';
import TutorialModal from '@/components/TutorialModal';
import Sparkline from '@/components/Sparkline';

const CesiumViewer = dynamic(() => import('@/components/CesiumViewer'), {
  ssr: false,
  loading: () => <MapBootSkeletonFallback />,
});

function MapBootSkeletonFallback() {
  return (
    <div className="map-loading">
      <div className="boot-rings"><i /><i /><i /></div>
      <span>PREPARING STREET NETWORK</span>
      <div className="boot-bars"><i style={{ '--d': '0ms' } as CSSProperties} /><i style={{ '--d': '120ms' } as CSSProperties} /><i style={{ '--d': '240ms' } as CSSProperties} /><i style={{ '--d': '360ms' } as CSSProperties} /></div>
    </div>
  );
}

const responseZones = [
  { code: 'DT', name: 'Downtown core', description: 'Civic buildings · high density', status: 'Monitor', tone: 'teal' },
  { code: 'BW', name: 'Buffalo Bayou', description: 'Low-lying corridor · water watch', status: 'Watch', tone: 'amber' },
  { code: 'EW', name: 'East / Fifth Ward', description: 'Arterial exits · response ready', status: 'Ready', tone: 'green' },
];

function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = element.closest('.content-scroll');
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.unobserve(element);
        }
      },
      { root, threshold: 0.12, rootMargin: '0px 0px -30px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} className={`scroll-reveal ${visible ? 'is-visible' : ''} ${className}`}>{children}</div>;
}

function formatDistance(meters: number) {
  if (!meters) return '-';
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatClock(date: Date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Tween a number from its previous value to the new one; renders via a mask so the swap flips. */
function TweenNumber({ value, decimals = 1, suffix = '' }: { value: number; decimals?: number; suffix?: string }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = fromRef.current;
    const delta = value - from;
    if (reduced || Math.abs(delta) < 10 ** -decimals / 2) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const duration = 480;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - (1 - p) ** 3;
      const next = from + delta * eased;
      setDisplay(next);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = value;
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, decimals]);

  return (
    <span className="tween-mask">
      <span key={display.toFixed(decimals)} className="tween-value">
        {display.toFixed(decimals)}
        {suffix}
      </span>
    </span>
  );
}



/** Self-ticking clock: the 1 Hz update re-renders only this span, not the page tree. */
function TopbarClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <>{formatClock(now)} CST</>;
}

/** Gage/temperature readout: isolates 3 s telemetry churn to this one element. */
function TelemetryReadout() {
  const usgsGageHeight = useSimulationStore((state) => state.usgsGageHeight);
  const surfaceTemp = useSimulationStore((state) => state.surfaceTemp);
  const isLoading = useSimulationStore((state) => state.isLoading);
  return (
    <div className="map-readout"><span>Scenario surface</span><strong>{usgsGageHeight.toFixed(2)} ft gage · {surfaceTemp.toFixed(1)}°F</strong><small>{isLoading ? 'Recalculating route weights…' : 'Telemetry refresh every 3 sec'}</small></div>
  );
}

export default function HomePage() {
  const [isTutorialOpen, setIsTutorialOpen] = useState(false);
  // Rendered once; the wall clock lives in <TopbarClock /> so its 1 Hz tick
  // does not re-render the page tree.
  const [briefingDay] = useState(() => new Date());
  const progressRef = useRef<HTMLDivElement>(null);
  const {
    fetchCityData,
    triggerLiveTick,
    activeSection,
    setActiveSection,
    route,
    backendOnline,
    gridFrequency,
    failedSubstations,
    overloadedSubstations,
    cascadedSubstations,
    frequencyHistory,
    gageHistory,
    cityData,
    originNode,
    liveLogs,
    isLoading,
    floodLevel,
    travelMode,
    corridorComparison,
    addLog,
  } = useSimulationStore();
  useEffect(() => {
    void fetchCityData();
    // Self-rescheduling timer: an inline interval fires mid-interaction and
    // re-renders the workspace under the user's cursor. A trailing timeout
    // waits for each tick's render to settle before scheduling the next.
    let timer = 0;
    const scheduleTick = () => {
      timer = window.setTimeout(() => {
        triggerLiveTick();
        scheduleTick();
      }, 3000 + Math.random() * 450);
    };
    scheduleTick();
    return () => window.clearTimeout(timer);
  }, [fetchCityData, triggerLiveTick]);

  // Scroll progress hairline: rAF-driven transform, no re-renders per frame.
  useEffect(() => {
    const scrollRoot = document.querySelector('.content-scroll');
    const bar = progressRef.current;
    if (!scrollRoot || !bar) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = scrollRoot.scrollHeight - scrollRoot.clientHeight;
      const ratio = max > 0 ? scrollRoot.scrollTop / max : 0;
      bar.style.transform = `scaleX(${ratio.toFixed(4)})`;
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    scrollRoot.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => {
      scrollRoot.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const scrollRoot = document.querySelector('.content-scroll');
    if (!scrollRoot) return;
    const sections = Array.from(scrollRoot.querySelectorAll<HTMLElement>('[data-section]'));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        const section = visible?.target.getAttribute('data-section') as 'briefing' | 'map' | 'audit' | null;
        if (section) setActiveSection(section);
      },
      { root: scrollRoot, threshold: [0.2, 0.45, 0.7] },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [setActiveSection]);

  const totalOutages = new Set([...failedSubstations, ...cascadedSubstations]).size;
  const risk = route?.risk_level ?? 'LOW';
  const riskLabel = risk === 'LOW' ? 'Operational' : risk === 'MEDIUM' ? 'Elevated' : risk === 'HIGH' ? 'High risk' : 'Critical';
  const nodesById = useMemo(() => new Map((cityData?.nodes ?? []).map((node) => [node.id, node])), [cityData]);
  const origin = nodesById.get(originNode);
  const destination = route ? nodesById.get(route.dest_node) : undefined;

  // Shareable scenario link: encodes the full operating picture in the URL so
  // an operator can hand the exact scenario to another responder.
  const shareScenario = () => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams({
      origin: String(originNode),
      flood: floodLevel.toFixed(1),
      mode: travelMode,
    });
    if (failedSubstations.length) params.set('failed', failedSubstations.join(','));
    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    void navigator.clipboard?.writeText(url).then(
      () => addLog('Scenario link copied to clipboard.'),
      () => addLog(`Scenario link: ${url}`),
    );
  };

  // Operator briefing: a plain-text export of the current assessment that
  // drops straight into an incident log or radio transcript.
  const exportBriefing = () => {
    if (typeof window === 'undefined' || !route) return;
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const lines = [
      `GridEvac AI - OPERATOR BRIEFING - ${stamp} CST`,
      `Origin: ${origin?.intersection_name ?? `Node ${originNode}`}`,
      `Scenario: flood ${floodLevel.toFixed(1)}/10, ${failedSubstations.length} substation(s) offline, mode ${travelMode}`,
      `Recommendation: ${route.success ? `evacuate via ${destination?.intersection_name ?? `Node ${route.dest_node}`}` : 'NO PASSABLE CORRIDOR'}`,
      route.success ? `ETA ${route.eta_minutes.toFixed(1)} min over ${formatDistance(route.distance_m)} (${route.route_steps.length} road segments)` : `Reason: ${route.message}`,
      `Risk: ${route.risk_level} (anomaly ${route.anomaly_score.toFixed(2)}), grid ${route.grid_frequency.toFixed(2)} Hz`,
      route.corridor_capacity?.people_per_hour ? `Capacity: ${route.corridor_capacity.people_per_hour.toLocaleString()} people/hour (bottleneck: ${route.corridor_capacity.limiting_road}), ~${route.corridor_capacity.clearance_minutes.toFixed(0)} min clearance` : '',
      `Flooded intersections: ${route.flooded_nodes.length}, blackout grid cells: ${route.blackout_nodes.length}`,
      ...route.route_steps.slice(0, 6).map((step, i) => `  ${i + 1}. ${step.instruction} (${formatDistance(step.distance_m)})`),
      corridorComparison?.corridors.length ? `Alternate exits: ${corridorComparison.corridors.slice(1, 4).map((c) => `${c.exit_name} ${c.eta_minutes.toFixed(1)} min, ${c.people_per_hour.toLocaleString()} ppl/hr`).join('; ') || 'none ranked'}` : '',
    ].filter(Boolean);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `gridevac-briefing-${Date.now()}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    addLog('Operator briefing exported.');
  };

  const scrollTo = (section: 'briefing' | 'map' | 'audit') => {
    setActiveSection(section);
    document.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="scroll-progress" ref={progressRef} aria-hidden="true" />
        <div className="brand-lockup">
          <div className="brand-mark"><span>G</span><i>↗</i></div>
          <div>
            <strong>GridEvac</strong>
            <span>Regional response intelligence</span>
          </div>
        </div>
        <div className="topbar-center">
          <span className="live-dot" /> Houston operations district <b>·</b> <TopbarClock />
        </div>
        <div className="topbar-actions">
          <span className={`connection-pill ${backendOnline ? 'online' : ''}`}>
            <i /> {backendOnline ? 'Live API connected' : 'Local solver active'}
          </span>
          <button className="icon-button" onClick={shareScenario} aria-label="Copy shareable scenario link" title="Copy shareable scenario link">⇗</button>
          <button className="icon-button" onClick={exportBriefing} aria-label="Export operator briefing" title="Export operator briefing (TXT)">⇩</button>
          <button className="icon-button" onClick={() => setIsTutorialOpen(true)} aria-label="Open operator guide">?</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="nav-rail" aria-label="Workspace navigation">
          <div className="rail-label">Command view</div>
          <button className={`rail-link ${activeSection === 'briefing' ? 'active' : ''}`} onClick={() => scrollTo('briefing')}><span className="rail-initial">B</span><b>Briefing</b></button>
          <button className={`rail-link ${activeSection === 'map' ? 'active' : ''}`} onClick={() => scrollTo('map')}><span className="rail-initial">M</span><b>Live map</b></button>
          <button className={`rail-link ${activeSection === 'audit' ? 'active' : ''}`} onClick={() => scrollTo('audit')}><span className="rail-initial">A</span><b>Route audit</b></button>
          <div className="rail-spacer" />
        </aside>

        <div className="content-scroll">
          <section className="overview-section" data-section="briefing">
            <Reveal className="section-heading">
              <div>
                <p className="eyebrow">Regional situation room / Houston, Texas</p>
                <h1>Make the next move <em>safer.</em></h1>
                <p className="lede">Model floodwater, utility failures, and street-level access in one operational view. Every route follows a named road corridor instead of cutting across city blocks.</p>
              </div>
              <div className="briefing-meta"><span>Operational day</span><strong>{briefingDay.toLocaleDateString([], { weekday: 'short' }).toUpperCase()}</strong><b>{briefingDay.toLocaleDateString([], { month: 'short', day: '2-digit' }).toUpperCase()}</b></div>
            </Reveal>

            <Reveal>
              <div className={`alert-banner ${risk.toLowerCase()}`}>
                <div className="alert-icon">{risk === 'LOW' ? '✓' : '!'}</div>
                <div className="alert-copy"><strong>{riskLabel} conditions · {route ? 'assessment ready' : 'awaiting first assessment'}</strong><span>{route?.message ?? 'Load a scenario or choose an origin to calculate a passable street corridor.'}</span></div>
                <button onClick={() => scrollTo('map')}>Open route planner <b>↗</b></button>
              </div>
            </Reveal>

            <div className="metric-grid">
              <Reveal><article className="metric-card metric-card-route"><div className="metric-top"><span>Recommended ETA</span><span className="metric-status green">ROAD-AWARE</span></div><strong className="metric-figure">{route?.success ? <TweenNumber value={route.eta_minutes} decimals={1} /> : '-'}<small>{route?.success ? ' min' : ' pending'}</small></strong><div className="metric-caption">{destination ? `To ${destination.intersection_name}` : 'Run a route assessment to begin'}</div></article></Reveal>
              <Reveal><article className="metric-card"><div className="metric-top"><span>Street distance</span><span className="metric-status green">{route?.success ? 'VALIDATED' : 'READY'}</span></div><strong>{route?.success ? formatDistance(route.distance_m) : '-'}<small>{route?.success ? '' : ' route'}</small></strong><div className="metric-caption">Weighted by road class, hazards, and access</div></article></Reveal>
              <Reveal><article className="metric-card"><div className="metric-top"><span>Grid frequency</span><span className={`metric-status ${gridFrequency < 59.7 ? 'red' : 'green'}`}>{gridFrequency < 59.7 ? 'DEGRADED' : 'STABLE'}</span></div><strong className="metric-figure"><TweenNumber value={gridFrequency} decimals={2} /><small> Hz</small></strong><Sparkline data={frequencyHistory} width={170} height={32} stroke={gridFrequency < 59.7 ? '#a8453e' : '#157050'} /><div className="metric-caption">Live utility telemetry · target 60.00 Hz</div></article></Reveal>
              <Reveal><article className="metric-card"><div className="metric-top"><span>Network impact</span><span className={`metric-status ${totalOutages ? 'amber' : 'green'}`}>{totalOutages ? 'WATCH' : 'CLEAR'}</span></div><strong>{String(totalOutages).padStart(2, '0')}<small> outages</small></strong><div className="impact-bar"><i style={{ width: `${Math.min(100, totalOutages * 16 + overloadedSubstations.length * 10)}%` }} /></div><div className="metric-caption">{overloadedSubstations.length} overloaded · {cascadedSubstations.length} cascaded</div></article></Reveal>
            </div>

            <div className="overview-columns">
              <Reveal className="panel-card zone-card"><div className="panel-heading"><div><h2>Response zones</h2></div><button className="text-button" onClick={() => scrollTo('map')}>Inspect map <b>↗</b></button></div><div className="zone-rows cascade">{responseZones.map((zone) => <div className="zone-row" key={zone.name}><div className={`zone-avatar ${zone.tone}`}>{zone.code}</div><div className="zone-info"><strong>{zone.name}</strong><span>{zone.description}</span></div><span className={`zone-status ${zone.tone}`}>{zone.status}</span><span className="row-arrow">›</span></div>)}</div></Reveal>
              <Reveal className="panel-card readiness-card"><div className="panel-heading"><div><h2>Response posture</h2></div><span className="score">{route ? Math.max(0, 100 - Math.round((route.anomaly_score ?? 0) * 36)) : 84}<small>%</small></span></div><div className="readiness-track"><i style={{ width: `${route ? Math.max(0, 100 - Math.round((route.anomaly_score ?? 0) * 36)) : 84}%` }} /></div><div className="readiness-list"><span><i className="check">✓</i> Street graph loaded <b>{cityData ? `${cityData.nodes.length} nodes` : 'loading'}</b></span><span><i className="check">✓</i> Utility feeds available <b>{backendOnline ? '4 / 4' : 'local'}</b></span><span><i className={route?.success ? 'check' : 'warn'}>{route?.success ? '✓' : '!'}</i> Evacuation corridor <b>{route?.success ? 'validated' : 'not set'}</b></span></div></Reveal>
            </div>
          </section>

          <section className="map-section" data-section="map">
            <Reveal className="map-header"><div><h2>Houston route planner</h2><p>Road centerlines, block footprints, utility risk, and modeled flood cells share one coordinate system.</p></div><div className="map-header-actions"><span className="map-coordinates">{CENTER_LAT_LABEL} · {CENTER_LON_LABEL}</span><button className="outline-button" onClick={() => scrollTo('audit')}>Review audit <b>↗</b></button></div></Reveal>

            <Reveal className="map-console-reveal">
              <div className="map-console">
                <CesiumViewer />
                <div className="map-overlay map-overlay-top"><span className="live-dot" /> STREET NETWORK <b>·</b> {cityData?.edges.length ?? 0} street segments, {cityData?.blocks.length ?? 0} buildings</div>
                <div className="map-overlay map-overlay-instruction"><strong>Map interaction</strong><span>Click a dry intersection to set a new origin</span></div>
                <div className="map-legend"><span><i className="legend-line route" /> Recommended route</span><span><i className="legend-line arterial" /> Arterial</span><span><i className="legend-line local" /> Street</span><span><i className="legend-line hazard" /> Hazard / closure</span><span><i className="legend-dot flood" /> Flood cell</span></div>
                <TelemetryReadout />
                <ControlPanel />
              </div>
            </Reveal>

            <Reveal className="map-bottom-grid"><div className="map-stat"><span>Origin</span><strong>{origin ? `Node ${origin.id}` : '-'}</strong><small>{origin?.intersection_name ?? 'Select a dry intersection'}</small></div><div className="map-stat"><span>Destination</span><strong>{destination ? `Node ${destination.id}` : 'Awaiting route'}</strong><small>{destination?.intersection_name ?? 'Safest exit is calculated'}</small></div><div className="map-stat"><span>Corridor state</span><strong className={`risk-${risk.toLowerCase()}`}>{route?.success ? 'Passable' : 'Unresolved'}</strong><small>{route?.route_steps.length ?? 0} named road segments</small></div><div className="map-stat"><span>Flood exposure</span><strong>{route?.flooded_nodes.length ?? 0} nodes</strong><small>Threshold responds to slider</small></div></Reveal>
          </section>

          <section className="audit-section" data-section="audit">
            <Reveal className="audit-intro"><div className="audit-intro-copy"><h2>Route audit</h2><p>See exactly which corridors the solver selected, how far the team must travel, and which signals changed the recommendation.</p></div><button className="primary-button" onClick={() => scrollTo('map')}>Adjust scenario <b>↗</b></button></Reveal>
            <div className="audit-content">
              <Reveal className="route-report"><div className="audit-card-heading"><div><h3>{route?.success ? `Exit via Node ${route.dest_node}` : 'No route assessed'}</h3></div><span className={`report-status ${route?.success ? 'good' : 'pending'}`}>{route?.success ? `${route.eta_minutes.toFixed(1)} min` : 'PENDING'}</span></div><div className="route-report-meta"><span><b>{route?.success ? formatDistance(route.distance_m) : '-'}</b> street distance</span><span><b>{route?.route_steps.length ?? 0}</b> road segments</span><span><b>{route?.blocked_edges.length ?? 0}</b> closures modeled</span></div>{route?.route_steps.length ? <div className="route-steps cascade">{route.route_steps.slice(0, 5).map((step, index) => <div className="route-step" key={`${step.from_node}-${step.to_node}-${index}`}><span className="step-index">{String(index + 1).padStart(2, '0')}</span><div><strong>{step.instruction}</strong><span>{formatDistance(step.distance_m)}, {Math.round(step.duration_s / 60)} min, {step.road_class}</span></div></div>)}</div> : <div className="empty-report">Use the route planner to generate named-road guidance and a transparent risk assessment.</div>}</Reveal>
              <Reveal className="activity-card"><div className="audit-card-heading"><div><h3>Operator event stream</h3></div><span className="activity-live"><i /> streaming</span></div><div className="activity-list">{liveLogs.slice(0, 5).map((log, index) => <div key={`${log}-${index}`}><i className="log-marker" /><p>{log}</p></div>)}</div></Reveal>
              <div className="audit-cards"><Reveal><article className="audit-feature"><h3>Road-aware by design</h3><p>Named arterials, collectors, and local streets carry measured lengths, lane counts, and speed assumptions for a credible ETA.</p><div className="feature-foot">CORRIDORS <b>{cityData?.edges.length ?? 0}</b></div></article></Reveal><Reveal><article className="audit-feature"><h3>Blocks stay blocks</h3><p>Inset procedural footprints leave a visible road shoulder. The route is clamped to centerlines instead of floating through extruded buildings.</p><div className="feature-foot">BLOCK FOOTPRINTS <b>{cityData?.blocks.length ?? 0}</b></div></article></Reveal><Reveal><article className="audit-feature accent-card"><h3>Model what changes</h3><p>Flood cells, substations, blackouts, and overhead utility hazards update the route without hiding the underlying decision.</p><div className="feature-foot">ANOMALY SCORE <b>{route ? `${Math.round(route.anomaly_score * 100)}%` : '-'}</b></div></article></Reveal></div>
            </div>
          </section>
        </div>
      </div>
      <TutorialModal isOpen={isTutorialOpen} onClose={() => setIsTutorialOpen(false)} />
    </main>
  );
}

const CENTER_LAT_LABEL = '29.7604° N';
const CENTER_LON_LABEL = '95.3698° W';
