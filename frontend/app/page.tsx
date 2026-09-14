'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CorridorTable, EventLog, MethodNotes } from '@/components/AuditPanels';
import { ExposureCard, Readings, RecommendationCard, SheltersCard } from '@/components/BriefingPanels';
import ControlPanel from '@/components/ControlPanel';
import ExportMenu, { type ExportKind } from '@/components/ExportMenu';
import Icon from '@/components/Icon';
import LiveConditions from '@/components/LiveConditions';
import NetworkCanvas from '@/components/NetworkCanvas';
import RouteTimeline from '@/components/RouteTimeline';
import TriggerGauge from '@/components/TriggerGauge';
import TutorialModal from '@/components/TutorialModal';
import WaterRail from '@/components/WaterRail';
import { scenarioUrl, useSimulationStore, type Section } from '@/hooks/useSimulation';
import { useScrollProgress } from '@/hooks/useScrollProgress';
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
  return backendOnline
    ? <span className="connection connection--online"><i />Routing API</span>
    : <button className="connection connection--offline" onClick={() => void reconnect()} title="Retry the routing API"><i />Local solver</button>;
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
  const mapStageRef = useRef<HTMLDivElement>(null);
  useScrollProgress(mapStageRef);

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

  useEffect(() => {
    const scrollRoot = document.querySelector('.content-scroll');
    if (!scrollRoot) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const section = visible?.target.getAttribute('data-section') as Section | null;
      if (section) setActiveSection(section);
    }, { root: scrollRoot, threshold: [0.25, 0.5, 0.75] });
    scrollRoot.querySelectorAll('[data-section]').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [setActiveSection]);

  const navigate = useCallback((section: Section) => {
    setActiveSection(section);
    document.querySelector(`[data-section="${section}"]`)?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
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
      } else if (event.key === 'Escape' && state.closureMode) {
        state.setClosureMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <main className="app-shell">
      <a className="skip-link" href="#route-planner" onClick={() => navigate('map')}>Skip to the route planner</a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Icon name="route" size={18} /></span>
          <span className="brand-name">
            <strong>GridEvac</strong>
            <span>Houston evacuation routing</span>
          </span>
        </div>
        <div className="topbar-status">
          <HoustonClock />
          <ConnectionStatus />
        </div>
        <div className="topbar-actions">
          <button className="tool-button" onClick={() => void share()}><Icon name="share" size={17} /><span>Share</span></button>
          <ExportMenu onExport={handleExport} />
          <button className="icon-button" onClick={() => setGuideOpen(true)} aria-label="Open the operator guide" aria-keyshortcuts="?"><Icon name="help" size={18} /></button>
        </div>
      </header>

      <div className="workspace">
        <WaterRail onNavigate={navigate} />

        <div className="content-scroll">
          <section className="section briefing" data-section="briefing" aria-labelledby="briefing-title">
            <div className="hero">
              <div className="hero-copy">
                <h1 id="briefing-title">Find the safe way out of downtown Houston.</h1>
                <p className="hero-lede">
                  Raise the water on real USGS terrain, take substations offline, and close the streets you know are blocked.
                  GridEvac routes people along the streets that stay passable and tells you how much rise is left before each way out is cut off.
                </p>
                <RecommendationCard onOpenPlanner={() => navigate('map')} onReport={() => handleExport('report')} />
              </div>
              <NetworkCanvas />
            </div>
            <Readings />
            <div className="briefing-grid">
              <LiveConditions />
              <ExposureCard exposure={exposure} />
              <SheltersCard exposure={exposure} />
            </div>
          </section>

          <section className="section planner" data-section="map" id="route-planner" aria-labelledby="planner-title" tabIndex={-1}>
            <header className="section-head">
              <div>
                <h2 id="planner-title">Route planner</h2>
                <p>Click a dry junction to start from it. With <strong>Close streets</strong> on, click a street to block it. Hover the turn list in the audit to light up each stretch of road.</p>
              </div>
            </header>
            <div className="map-stage" ref={mapStageRef}>
              <div className="map-console">
                <CesiumViewer />
                <ControlPanel />
              </div>
            </div>
            <MapFacts />
          </section>

          <section className="section audit" data-section="audit" aria-labelledby="audit-title">
            <header className="section-head">
              <div>
                <h2 id="audit-title">Route audit</h2>
                <p>Every turn, every alternative exit, and the water levels that would change the answer.</p>
              </div>
            </header>
            <div className="audit-grid">
              <RouteTimeline />
              <TriggerGauge />
            </div>
            <CorridorTable />
            <div className="audit-grid audit-grid--even">
              <EventLog onExport={() => handleExport('csv')} />
              <MethodNotes />
            </div>
            <footer className="page-foot">
              <p>Street, building, and waterway data © OpenStreetMap contributors. Elevation: USGS 3DEP. Basemap © CARTO. Live river data: USGS Water Services.</p>
              <p>GridEvac is a planning aid. Confirm conditions on the ground before directing people.</p>
            </footer>
          </section>
        </div>
      </div>

      <div className={`toast ${toast ? 'is-visible' : ''}`} role="status" aria-live="polite">{toast}</div>
      <TutorialModal isOpen={guideOpen} onClose={closeGuide} />
    </main>
  );
}
