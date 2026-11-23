'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { CorridorTable, EventLog, MethodNotes } from '@/components/AuditPanels';
import { ExposureCard, Readings, RecommendationCard, SheltersCard } from '@/components/BriefingPanels';
import ControlPanel from '@/components/ControlPanel';
import ExportMenu, { type ExportKind } from '@/components/ExportMenu';
import Icon from '@/components/Icon';
import ConditionsPanel from '@/components/ConditionsPanel';
import LiveConditions from '@/components/LiveConditions';
import LocationPrompt from '@/components/LocationPrompt';
import NetworkCanvas from '@/components/NetworkCanvas';
import RouteTimeline from '@/components/RouteTimeline';
import TriggerGauge from '@/components/TriggerGauge';
import TutorialModal from '@/components/TutorialModal';
import WaterRail from '@/components/WaterRail';
import { apiConfigured } from '@/lib/api';
import { scenarioUrl, useSimulationStore, type Section } from '@/hooks/useSimulation';
import { computeExposure } from '@/lib/exposure';
import { buildEventCsv, buildGeoJson, buildSituationReport, centralTime, downloadFile, fileStamp } from '@/lib/exports';
import { waterSurfaceM } from '@/lib/solver';
import { loadTerrain, type TerrainGrid } from '@/lib/terrain';
import { toUsng } from '@/lib/usng';

const CesiumViewer = dynamic(() => import('@/components/CesiumViewer'), {
  ssr: false,
  loading: () => (
    <div className="map-loading" role="status">
      <span className="map-loading-rings" aria-hidden="true"><i /><i /><i /></span>
      <span>Loading the street network</span>
    </div>
  ),
});

const SECTION_ORDER: Section[] = ['briefing', 'map', 'audit'];

type AuditTab = 'turns' | 'corridors' | 'triggers' | 'log' | 'notes';

const AUDIT_TABS: Array<{ id: AuditTab; label: string }> = [
  { id: 'turns', label: 'Turn by turn' },
  { id: 'corridors', label: 'Exit corridors' },
  { id: 'triggers', label: 'Trigger points' },
  { id: 'log', label: 'Event log' },
  { id: 'notes', label: 'Method' },
];

/** Houston wall clock with the correct CST/CDT abbreviation; ticks without re-rendering the page. */
function HoustonClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <time className="clock" dateTime={now?.toISOString()}>{now ? centralTime(now, false) : '--:--:--'}</time>;
}

function ConnectionStatus() {
  const backendOnline = useSimulationStore((state) => state.backendOnline);
  const cityData = useSimulationStore((state) => state.cityData);
  const reconnect = useSimulationStore((state) => state.reconnect);
  if (!cityData) return <span className="connection">Connecting</span>;
  if (backendOnline) return <span className="connection connection--online"><i />Routing API</span>;
  return (
    <button
      className="connection connection--offline"
      onClick={() => void reconnect()}
      title={apiConfigured
        ? 'The routing API is unreachable. Routes are solved in this browser; click to retry.'
        : 'This build has no routing API, so every route is solved in your browser.'}
    >
      <i />{apiConfigured ? 'Local solver' : 'Local solver · no API'}
    </button>
  );
}

/** The standing answer, kept in the bar so the scenario never leaves the screen. */
function VerdictTicker() {
  const route = useSimulationStore((state) => state.route);
  const cityData = useSimulationStore((state) => state.cityData);
  const floodLevel = useSimulationStore((state) => state.floodLevel);
  const isLoading = useSimulationStore((state) => state.isLoading);
  const destination = route?.success
    ? route.destination_name || cityData?.exit_names?.[String(route.dest_node)] || 'Exit'
    : null;
  const eta = route?.success ? route.eta_minutes : null;
  const tone = isLoading
    ? 'watch'
    : route?.success
      ? (route.risk_level === 'LOW' ? 'safe' : route.risk_level === 'CRITICAL' ? 'critical' : 'watch')
      : 'critical';
  return (
    <p className={`ticker ticker--${tone}`} aria-live="polite">
      <i className="ticker-dot" aria-hidden="true" />
      {isLoading ? (
        <span className="ticker-label">Solving</span>
      ) : destination && eta !== null ? (
        <>
          <strong>{destination}</strong>
          <span className="ticker-eta">{eta.toFixed(1)}<small>min</small></span>
          <span className="ticker-meta">{waterSurfaceM(cityData, floodLevel).toFixed(1)} m surface</span>
        </>
      ) : (
        <span className="ticker-label">No passable corridor</span>
      )}
    </p>
  );
}

function MapFacts() {
  const cityData = useSimulationStore((state) => state.cityData);
  const route = useSimulationStore((state) => state.route);
  const originNode = useSimulationStore((state) => state.originNode);
  const floodLevel = useSimulationStore((state) => state.floodLevel);
  const nodes = useMemo(() => new Map((cityData?.nodes ?? []).map((node) => [node.id, node])), [cityData]);
  const origin = nodes.get(originNode);
  const destination = route ? nodes.get(route.dest_node) : undefined;
  return (
    <dl className="map-facts">
      <div>
        <dt>Origin</dt>
        <dd>{origin?.intersection_name ?? 'Select a junction'}</dd>
        <dd className="mono">{origin ? toUsng(origin.lat, origin.lon) : ''}</dd>
      </div>
      <div>
        <dt>Destination</dt>
        <dd>{route?.success ? route.destination_name || cityData?.exit_names?.[String(route.dest_node)] : 'None reachable'}</dd>
        <dd className="mono">{destination && route?.success ? toUsng(destination.lat, destination.lon) : ''}</dd>
      </div>
      <div>
        <dt>Origin ground</dt>
        <dd>{origin ? `${origin.elevation.toFixed(1)} m, floods at ${(origin.flood_stage_m ?? origin.elevation).toFixed(1)} m` : '-'}</dd>
        <dd className="mono">{origin?.elevated ? 'bridge deck' : 'NAVD88'}</dd>
      </div>
      <div>
        <dt>Water surface</dt>
        <dd>{waterSurfaceM(cityData, floodLevel).toFixed(2)} m NAVD88</dd>
        <dd className="mono">level {floodLevel.toFixed(1)} of 10</dd>
      </div>
    </dl>
  );
}

export default function HomePage() {
  const [guideOpen, setGuideOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [terrain, setTerrain] = useState<TerrainGrid | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditTab, setAuditTab] = useState<AuditTab>('turns');
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [boardRestored, setBoardRestored] = useState(false);
  const auditTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const auditToggleRef = useRef<HTMLButtonElement | null>(null);
  const briefingToggleRef = useRef<HTMLButtonElement | null>(null);

  const fetchCityData = useSimulationStore((state) => state.fetchCityData);
  const triggerLiveTick = useSimulationStore((state) => state.triggerLiveTick);
  const refreshObservations = useSimulationStore((state) => state.refreshObservations);
  const setActiveSection = useSimulationStore((state) => state.setActiveSection);
  const addLog = useSimulationStore((state) => state.addLog);
  const cityData = useSimulationStore((state) => state.cityData);
  const route = useSimulationStore((state) => state.route);
  const floodLevel = useSimulationStore((state) => state.floodLevel);

  const exposure = useMemo(() => (cityData ? computeExposure(cityData, terrain, route, floodLevel) : null), [cityData, terrain, route, floodLevel]);

  useEffect(() => {
    void fetchCityData();
    void loadTerrain().then(setTerrain);
    // Self-rescheduling telemetry tick: waits for each render to settle
    // instead of firing mid-interaction like a fixed interval would.
    let tick = 0;
    const scheduleTick = () => {
      tick = window.setTimeout(() => {
        if (document.visibilityState === 'visible') triggerLiveTick();
        scheduleTick();
      }, 3000 + Math.random() * 400);
    };
    scheduleTick();
    const observationTimer = window.setInterval(() => void refreshObservations(), 5 * 60 * 1000);
    return () => {
      window.clearTimeout(tick);
      window.clearInterval(observationTimer);
    };
  }, [fetchCityData, triggerLiveTick, refreshObservations]);

  // The board remembers how this operator works: a drawer left open stays open.
  useEffect(() => {
    try {
      setAuditOpen(window.localStorage.getItem('gridevac-board-audit') === '1');
      setBriefingOpen(window.localStorage.getItem('gridevac-board-briefing') === '1');
    } catch { /* storage blocked */ }
    setBoardRestored(true);
  }, []);

  useEffect(() => {
    if (!boardRestored) return;
    try { window.localStorage.setItem('gridevac-board-audit', auditOpen ? '1' : '0'); } catch { /* ignore */ }
  }, [auditOpen, boardRestored]);

  // First visit: open the guide once per browser, after hydration.
  useEffect(() => {
    let seen = true;
    try { seen = window.localStorage.getItem('gridevac-guide-seen') === '1'; } catch { /* private mode */ }
    if (seen) return;
    const timer = window.setTimeout(() => setGuideOpen(true), 900);
    return () => window.clearTimeout(timer);
  }, []);

  const closeGuide = useCallback(() => {
    setGuideOpen(false);
    try { window.localStorage.setItem('gridevac-guide-seen', '1'); } catch { /* reopens next visit */ }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const focusAuditTab = useCallback((id: AuditTab) => {
    const index = AUDIT_TABS.findIndex((item) => item.id === id);
    window.requestAnimationFrame(() => auditTabRefs.current[index]?.focus());
  }, []);

  /** Remember the sheet only for the operator's own gestures: navigation must not overwrite it. */
  const setBriefing = useCallback((open: boolean) => {
    setBriefingOpen(open);
    try { window.localStorage.setItem('gridevac-board-briefing', open ? '1' : '0'); } catch { /* ignore */ }
  }, []);

  /** Closing the sheet hands focus back to the toggle that reopens it, before the sheet hides it. */
  const closeBriefing = useCallback(() => {
    briefingToggleRef.current?.focus();
    setBriefing(false);
  }, [setBriefing]);

  /** Closing the drawer hands focus back to its toggle; every close path goes through here. */
  const closeAudit = useCallback(() => {
    setAuditOpen(false);
    window.requestAnimationFrame(() => auditToggleRef.current?.focus());
  }, []);

  /** Open or close the audit drawer, taking focus with it in both directions. */
  const toggleAudit = useCallback(() => {
    if (auditOpen) {
      closeAudit();
      return;
    }
    setAuditOpen(true);
    focusAuditTab(auditTab);
  }, [auditOpen, auditTab, focusAuditTab, closeAudit]);

  const onAuditTabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = AUDIT_TABS.findIndex((item) => item.id === auditTab);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % AUDIT_TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + AUDIT_TABS.length) % AUDIT_TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = AUDIT_TABS.length - 1;
    else return;
    event.preventDefault();
    setAuditTab(AUDIT_TABS[next].id);
    setAuditOpen(true);
    auditTabRefs.current[next]?.focus();
  };

  /** Rail and number keys move the workspace, not a document: each one reveals its region. */
  const navigate = useCallback((section: Section) => {
    setActiveSection(section);
    if (section === 'briefing') setBriefingOpen(true);
    if (section === 'audit') setAuditOpen(true);
    if (section === 'map') {
      // Below 1361px the briefing is a sheet over the map: dismiss it, or the map stays covered.
      if (window.matchMedia('(max-width: 1360px)').matches) setBriefingOpen(false);
      document.getElementById('route-planner')?.focus({ preventScroll: true });
    }
  }, [setActiveSection]);

  const exportState = useCallback(() => {
    const state = useSimulationStore.getState();
    if (!state.cityData) return null;
    return { ...state, cityData: state.cityData, exposure, scenarioUrl: scenarioUrl(state) };
  }, [exposure]);

  const handleExport = useCallback((kind: ExportKind) => {
    if (kind === 'print') {
      addLog('Briefing sent to print.', 'action');
      window.print();
      return;
    }
    const state = exportState();
    if (!state) return;
    if (kind === 'report') {
      downloadFile(`gridevac-sitrep-${fileStamp()}.txt`, buildSituationReport(state), 'text/plain;charset=utf-8');
      addLog('Situation report exported.', 'action');
      setToast('Situation report downloaded');
    } else if (kind === 'geojson') {
      downloadFile(`gridevac-scenario-${fileStamp()}.geojson`, JSON.stringify(buildGeoJson(state), null, 1), 'application/geo+json');
      addLog('GIS package exported (GeoJSON).', 'action');
      setToast('GeoJSON package downloaded');
    } else {
      downloadFile(`gridevac-events-${fileStamp()}.csv`, buildEventCsv(state.events), 'text/csv;charset=utf-8');
      addLog('Event log exported (CSV).', 'action');
      setToast('Event log downloaded');
    }
  }, [addLog, exportState]);

  const share = useCallback(async () => {
    const url = scenarioUrl(useSimulationStore.getState());
    try {
      await navigator.clipboard.writeText(url);
      setToast('Scenario link copied');
      addLog('Scenario link copied to the clipboard.', 'action');
    } catch {
      window.prompt('Copy this scenario link', url);
    }
  }, [addLog]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      const state = useSimulationStore.getState();
      if (event.key === '?') {
        setGuideOpen(true);
      } else if (['1', '2', '3'].includes(event.key)) {
        navigate(SECTION_ORDER[Number(event.key) - 1]);
      } else if (event.key.toLowerCase() === 'c' && state.cityData) {
        state.setClosureMode(!state.closureMode);
        if (!state.closureMode) navigate('map');
      } else if (event.key.toLowerCase() === 'd' && state.cityData) {
        // Arm the destination pin: the next map click chooses where to route.
        state.setPinMode(!state.pinMode);
        if (!state.pinMode) navigate('map');
      } else if (event.key === 'Escape') {
        if (state.pinMode) state.setPinMode(false);
        else if (state.closureMode) state.setClosureMode(false);
        else if (auditOpen) closeAudit();
        else closeBriefing();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, auditOpen, closeBriefing, closeAudit]);

  return (
    <main className="app-shell" data-audit={auditOpen}>
      <a className="skip-link" href="#route-planner" onClick={() => navigate('map')}>Skip to the route planner</a>

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Icon name="route" size={18} /></span>
          <span className="brand-name">
            <strong>GridEvac</strong>
            <span>Houston evacuation routing</span>
          </span>
        </div>

        <VerdictTicker />

        <div className="topbar-status">
          <HoustonClock />
          <ConnectionStatus />
        </div>

        <div className="topbar-actions">
          <button ref={briefingToggleRef} className="tool-button pane-toggle" onClick={() => setBriefing(!briefingOpen)} aria-label="Briefing" aria-expanded={briefingOpen} aria-controls="briefing-pane">
            <Icon name="file" size={16} /><span>Briefing</span>
          </button>
          <button className="tool-button" onClick={() => void share()} aria-label="Share this scenario"><Icon name="share" size={17} /><span>Share</span></button>
          <ExportMenu onExport={handleExport} />
          <button className="icon-button" onClick={() => setGuideOpen(true)} aria-label="Open the operator guide" aria-keyshortcuts="?"><Icon name="help" size={18} /></button>
        </div>
      </header>

      <div className="board-main">
        <WaterRail onNavigate={navigate} />

        <aside className="pane pane-directive" id="briefing-pane" data-open={briefingOpen} aria-label="Situation briefing">
          <div className="pane-head">
            <h2>Briefing</h2>
            <button className="pane-close" onClick={closeBriefing} aria-label="Close the briefing"><Icon name="close" size={15} /></button>
          </div>
          <div className="pane-scroll">
            <div className="brief-mark">
              <h1>Find the safe way out of downtown Houston.</h1>
              <NetworkCanvas />
            </div>
            <RecommendationCard onOpenPlanner={() => navigate('map')} onReport={() => handleExport('report')} />
            <LocationPrompt />
            <Readings />
            <LiveConditions />
            <ConditionsPanel />
            <SheltersCard exposure={exposure} />
            <ExposureCard exposure={exposure} />
          </div>
        </aside>

        <section className="pane pane-map" id="route-planner" aria-label="Route planner map" tabIndex={-1}>
          <div className="map-console">
            <CesiumViewer />
          </div>
          <MapFacts />
          <div id="map-credit-mount" className="map-credit-mount" role="group" aria-label="Map data attribution" />
        </section>

        <section className="pane pane-scenario" aria-label="Scenario and route controls">
          <ControlPanel />
        </section>
      </div>

      <section className="drawer" data-open={auditOpen} aria-label="Route audit">
        <header className="drawer-bar">
          <button
            ref={auditToggleRef}
            className="drawer-toggle"
            onClick={toggleAudit}
            aria-expanded={auditOpen}
            aria-controls="audit-body"
          >
            <Icon name="chevronRight" size={15} className={auditOpen ? 'drawer-chevron is-open' : 'drawer-chevron'} />
            Route audit
          </button>
          <div className="drawer-tabs" role="tablist" aria-label="Audit views" onKeyDown={onAuditTabKey}>
            {AUDIT_TABS.map((item, index) => (
              <button
                key={item.id}
                ref={(element) => { auditTabRefs.current[index] = element; }}
                role="tab"
                id={`audit-tab-${item.id}`}
                aria-selected={auditTab === item.id}
                aria-controls="audit-body"
                tabIndex={auditTab === item.id ? 0 : -1}
                className={auditTab === item.id ? 'drawer-tab is-active' : 'drawer-tab'}
                onClick={() => { setAuditTab(item.id); setAuditOpen(true); }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="drawer-meta">{route?.success ? `${route.route_steps.length} turns · ${route.eta_minutes.toFixed(1)} min` : '—'}</span>
        </header>

        <div
          className="drawer-body"
          id="audit-body"
          hidden={!auditOpen}
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`audit-tab-${auditTab}`}
        >
          {auditTab === 'turns' && <RouteTimeline />}
          {auditTab === 'corridors' && <CorridorTable />}
          {auditTab === 'triggers' && <TriggerGauge />}
          {auditTab === 'log' && (
            <div className="drawer-split">
              <EventLog onExport={() => handleExport('csv')} />
              <MethodNotes />
            </div>
          )}
          {auditTab === 'notes' && (
            <>
              <MethodNotes />
              <footer className="page-foot">
                <p>Street, building, and waterway data © OpenStreetMap contributors. Elevation: USGS 3DEP. Basemap © CARTO. Live river data: USGS Water Services. Rainfall, wind and forecast: Open-Meteo. Warnings and advisories: National Weather Service (api.weather.gov).</p>
                <p>GridEvac is a planning aid. Confirm conditions on the ground before directing people.</p>
              </footer>
            </>
          )}
        </div>
      </section>

      <div className={`toast ${toast ? 'is-visible' : ''}`} role="status" aria-live="polite">{toast}</div>
      <TutorialModal isOpen={guideOpen} onClose={closeGuide} />
    </main>
  );
}
