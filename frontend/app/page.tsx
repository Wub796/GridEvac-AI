'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSimulationStore } from '@/hooks/useSimulation';
import ControlPanel from '@/components/ControlPanel';
import TutorialModal from '@/components/TutorialModal';
import Sparkline from '@/components/Sparkline';

const CesiumViewer = dynamic(() => import('@/components/CesiumViewer'), {
  ssr: false,
  loading: () => <div className="map-loading">Loading live geospatial operations map…</div>,
});

const zones = [
  { name: 'Downtown', detail: 'Harris County · Zone 01', status: 'MONITOR', tone: 'cyan' },
  { name: 'East Houston', detail: 'Harris County · Zone 04', status: 'READY', tone: 'green' },
  { name: 'Buffalo Bayou', detail: 'Harris County · Zone 06', status: 'WATCH', tone: 'amber' },
];

export default function HomePage() {
  const [isTutorialOpen, setIsTutorialOpen] = useState(false);
  const {
    fetchCityData, triggerLiveTick, activeSection, setActiveSection,
    route, backendOnline, gridFrequency, usgsGageHeight, surfaceTemp,
    failedSubstations, overloadedSubstations, cascadedSubstations,
    frequencyHistory, gageHistory, cityData,
  } = useSimulationStore();

  useEffect(() => {
    fetchCityData();
    const interval = window.setInterval(triggerLiveTick, 3000);
    return () => window.clearInterval(interval);
  }, [fetchCityData, triggerLiveTick]);

  const totalOutages = new Set([...failedSubstations, ...cascadedSubstations]).size;
  const risk = route?.risk_level ?? 'LOW';
  const riskLabel = risk === 'LOW' ? 'Operational' : risk === 'MEDIUM' ? 'Elevated' : risk === 'HIGH' ? 'High risk' : 'Critical';
  const scrollTo = (section: 'briefing' | 'map' | 'audit') => {
    setActiveSection(section);
    document.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <main className="app-shell">
      <div className="ambient-grid" aria-hidden="true" />
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">GE</div>
          <div><strong>GridEvac</strong><span>Emergency intelligence</span></div>
        </div>
        <div className="topbar-center"><span className="live-dot" /> Houston regional operations · <b>08:42 CST</b></div>
        <div className="topbar-actions">
          <span className={`connection-pill ${backendOnline ? 'online' : ''}`}><i /> {backendOnline ? 'Live feeds connected' : 'Local fallback mode'}</span>
          <button className="icon-button" onClick={() => setIsTutorialOpen(true)} aria-label="Open help">?</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="nav-rail">
          <div className="rail-label">Workspace</div>
          <button className={activeSection === 'briefing' ? 'rail-link active' : 'rail-link'} onClick={() => scrollTo('briefing')}><span>01</span> Briefing</button>
          <button className={activeSection === 'map' ? 'rail-link active' : 'rail-link'} onClick={() => scrollTo('map')}><span>02</span> Live map</button>
          <button className={activeSection === 'audit' ? 'rail-link active' : 'rail-link'} onClick={() => scrollTo('audit')}><span>03</span> Grid audit</button>
          <div className="rail-spacer" />
          <div className="rail-footer">SIM<br /><b>v1.0</b></div>
        </aside>

        <div className="content-scroll">
          <section className="overview-section" data-section="briefing">
            <div className="section-heading">
              <div><p className="eyebrow">Regional situation room / Houston, Texas</p><h1>Good morning, <em>operator.</em></h1><p className="lede">Monitor hazards, validate evacuation routes, and coordinate a safer response across the city grid.</p></div>
              <div className="date-card"><span>THU</span><strong>24</strong><small>OCT 2024</small></div>
            </div>

            <div className="alert-banner"><div className="alert-icon">!</div><div><strong>{riskLabel} conditions detected</strong><span>{route ? route.message : 'No active route assessment. Start a scenario to evaluate the network.'}</span></div><button onClick={() => scrollTo('map')}>Review map <b>↗</b></button></div>

            <div className="metric-grid">
              <article className="metric-card"><div className="metric-top"><span>Grid frequency</span><span className="metric-status green">STABLE</span></div><strong>{gridFrequency.toFixed(2)}<small> Hz</small></strong><Sparkline data={frequencyHistory} width={180} height={36} stroke="#39d98a" /><footer>Target 60.00 Hz · live SCADA</footer></article>
              <article className="metric-card"><div className="metric-top"><span>Bayou gage height</span><span className="metric-status amber">WATCH</span></div><strong>{usgsGageHeight.toFixed(2)}<small> ft</small></strong><Sparkline data={gageHistory} width={180} height={36} stroke="#f4b860" /><footer>USGS 08074000 · updated just now</footer></article>
              <article className="metric-card"><div className="metric-top"><span>Substations offline</span><span className={`metric-status ${totalOutages ? 'red' : 'green'}`}>{totalOutages ? 'ACTION' : 'CLEAR'}</span></div><strong>{String(totalOutages).padStart(2, '0')}<small> nodes</small></strong><div className="mini-bars"><i style={{ height: `${Math.max(12, totalOutages * 20)}%` }} /><i style={{ height: `${Math.max(18, overloadedSubstations.length * 28)}%` }} /><i style={{ height: `${Math.max(22, cascadedSubstations.length * 35)}%` }} /><i style={{ height: '72%' }} /><i style={{ height: '55%' }} /></div><footer>{overloadedSubstations.length} overloaded · {cascadedSubstations.length} cascaded</footer></article>
              <article className="metric-card"><div className="metric-top"><span>Surface temperature</span><span className="metric-status amber">HEAT INDEX</span></div><strong>{surfaceTemp.toFixed(1)}<small> °F</small></strong><div className="temperature-scale"><i /><span>82°</span><span>95°</span><span>105°</span></div><footer>Houston surface telemetry feed</footer></article>
            </div>

            <div className="overview-columns">
              <article className="panel-card zone-card"><div className="panel-heading"><div><p className="eyebrow">Coverage</p><h2>Response zones</h2></div><button className="text-button" onClick={() => scrollTo('map')}>View map ↗</button></div>{zones.map((zone) => <div className="zone-row" key={zone.name}><div className={`zone-avatar ${zone.tone}`}>{zone.name.slice(0, 2).toUpperCase()}</div><div className="zone-info"><strong>{zone.name}</strong><span>{zone.detail}</span></div><span className={`zone-status ${zone.tone}`}>{zone.status}</span><span className="row-arrow">›</span></div>)}</article>
              <article className="panel-card readiness-card"><div className="panel-heading"><div><p className="eyebrow">System readiness</p><h2>Response posture</h2></div><span className="score">86<span>%</span></span></div><div className="readiness-track"><i style={{ width: '86%' }} /></div><div className="readiness-list"><span><i className="check">✓</i> Data feeds connected <b>4/4</b></span><span><i className="check">✓</i> Evacuation exits available <b>4</b></span><span><i className="warn">!</i> Grid anomalies detected <b>{route ? Math.round((route.anomaly_score ?? 0) * 100) : 0}%</b></span></div></article>
            </div>
          </section>

          <section className="map-section" data-section="map">
            <div className="map-header"><div><p className="eyebrow">Live operations / geospatial view</p><h2>Houston network map</h2></div><div className="map-header-actions"><span className="map-coordinates">29.7604° N&nbsp;&nbsp; 95.3698° W</span><button className="outline-button" onClick={() => scrollTo('audit')}>Grid audit ↗</button></div></div>
            <div className="map-frame"><CesiumViewer /><div className="map-vignette" /><div className="map-chip"><span className="live-dot" /> LIVE NETWORK VIEW <b>·</b> {cityData?.nodes.length ?? 0} intersections</div><div className="map-legend"><span><i className="legend-line route" /> Safe route</span><span><i className="legend-line flood" /> Flood zone</span><span><i className="legend-dot power" /> Substation</span></div><div className="map-help">Drag to explore&nbsp; · &nbsp;Scroll to zoom</div></div>
            <div className="map-bottom-grid"><div className="map-stat"><span>Active route</span><strong>{route?.success ? 'Validated' : 'Awaiting input'}</strong><small>{route?.path.length ?? 0} waypoints</small></div><div className="map-stat"><span>Current risk</span><strong className={`risk-${risk.toLowerCase()}`}>{riskLabel}</strong><small>ML anomaly scan</small></div><div className="map-stat"><span>Next update</span><strong>00:03</strong><small>Automatic telemetry refresh</small></div></div>
            <ControlPanel />
          </section>

          <section className="audit-section" data-section="audit"><div className="audit-intro"><p className="eyebrow">Decision support / model transparency</p><h2>Grid audit <em>&amp; controls</em></h2><p>Understand the signals behind each evacuation recommendation. Adjust a scenario in the control center to see the network respond in real time.</p><button className="primary-button" onClick={() => scrollTo('map')}>Open control center ↗</button></div><div className="audit-cards"><article className="audit-feature"><span className="feature-number">01</span><h3>IsolationForest</h3><p>Monitors nine telemetry dimensions to surface unusual combinations before they become incidents.</p><div className="feature-foot">MODEL HEALTH <b>98.4%</b></div></article><article className="audit-feature"><span className="feature-number">02</span><h3>Weighted routing</h3><p>NetworkX pathfinding avoids flooded roads, blackout zones, and overloaded transmission corridors.</p><div className="feature-foot">ROUTES TESTED <b>{route?.total_nodes ?? 0}</b></div></article><article className="audit-feature accent-card"><span className="feature-number">03</span><h3>Operator controls</h3><p>Test flood levels, substation failures, and heatwave conditions without affecting live infrastructure.</p><div className="feature-foot">SAFE SIMULATION <b>ENABLED</b></div></article></div></section>
        </div>
      </div>
      <TutorialModal isOpen={isTutorialOpen} onClose={() => setIsTutorialOpen(false)} />
    </main>
  );
}
