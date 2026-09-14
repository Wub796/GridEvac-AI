'use client';

import type { CSSProperties } from 'react';
import Icon, { type IconName } from '@/components/Icon';
import Sparkline from '@/components/Sparkline';
import TweenNumber from '@/components/TweenNumber';
import { useSimulationStore } from '@/hooks/useSimulation';
import { SQ_M_PER_OCCUPANT, type ExposureSummary } from '@/lib/exposure';
import { centralTime, formatDistance } from '@/lib/exports';
import { waterSurfaceM } from '@/lib/solver';

export function RecommendationCard({ onOpenPlanner, onReport }: { onOpenPlanner: () => void; onReport: () => void }) {
  const route = useSimulationStore((state) => state.route);
  const cityData = useSimulationStore((state) => state.cityData);
  const evacuees = useSimulationStore((state) => state.evacuees);
  const isLoading = useSimulationStore((state) => state.isLoading);
  const lastSolvedAt = useSimulationStore((state) => state.lastSolvedAt);
  const backendOnline = useSimulationStore((state) => state.backendOnline);

  const tone = !route ? 'pending' : route.success ? (route.risk_level === 'LOW' ? 'safe' : route.risk_level === 'CRITICAL' ? 'critical' : 'watch') : 'critical';
  const destinationNode = route ? cityData?.nodes.find((node) => node.id === route.dest_node) : undefined;
  const destination = route?.destination_name || (route ? cityData?.exit_names?.[String(route.dest_node)] : '') || 'Safest exit';
  const eta = route?.success ? (evacuees > 0 ? route.congested_eta_minutes : route.eta_minutes) : 0;
  const status = !route ? 'Calculating the first corridor' : route.success ? 'Passable corridor' : 'No passable corridor';

  return (
    <section className={`reco reco--${tone}`} aria-live="polite" aria-busy={isLoading}>
      <p className="reco-status">
        <i className="status-dot" aria-hidden="true" />
        {status}
        {route && <span className="reco-risk">Risk {route.risk_level.toLowerCase()}</span>}
      </p>
      {route?.success ? (
        <>
          <div className="reco-main">
            <div className="reco-destination">
              <span>Evacuate toward</span>
              <strong>{destination}</strong>
              <small>{route.destination_name ? `${route.destination_kind === 'medical' ? 'Medical facility' : 'Shelter'} at ${destinationNode?.intersection_name ?? ''}` : destinationNode?.intersection_name}</small>
            </div>
            <div className="reco-eta">
              <strong><TweenNumber value={eta} decimals={1} /></strong>
              <span>min</span>
            </div>
          </div>
          <dl className="reco-facts">
            <div><dt>Distance</dt><dd>{formatDistance(route.distance_m)}</dd></div>
            <div><dt>Turns</dt><dd>{Math.max(0, route.route_steps.length - 1)}</dd></div>
            <div>
              <dt>{evacuees > 0 ? 'Congestion' : 'Capacity'}</dt>
              <dd>{evacuees > 0 ? `${route.congestion_factor.toFixed(2)}× free flow` : `${(route.corridor_capacity?.people_per_hour ?? 0).toLocaleString()}/h`}</dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="reco-message">{route?.message ?? 'Loading the Houston street network and terrain.'}</p>
      )}
      <div className="reco-actions">
        <button className="button button-primary" onClick={onOpenPlanner}><Icon name="route" size={17} />Open route planner</button>
        <button className="button button-secondary" onClick={onReport} disabled={!route}><Icon name="file" size={17} />Situation report</button>
      </div>
      {lastSolvedAt && <p className="reco-foot">Solved {centralTime(lastSolvedAt, false)} by the {backendOnline ? 'routing API' : 'local solver'}</p>}
    </section>
  );
}

export function Readings() {
  const route = useSimulationStore((state) => state.route);
  const cityData = useSimulationStore((state) => state.cityData);
  const floodLevel = useSimulationStore((state) => state.floodLevel);
  const gridFrequency = useSimulationStore((state) => state.gridFrequency);
  const frequencyHistory = useSimulationStore((state) => state.frequencyHistory);
  const closures = useSimulationStore((state) => state.closures);
  const evacuees = useSimulationStore((state) => state.evacuees);
  const failedSubstations = useSimulationStore((state) => state.failedSubstations);
  const surface = waterSurfaceM(cityData, floodLevel);
  const offline = new Set([...failedSubstations, ...(route?.flooded_substations ?? []), ...(route?.cascaded_substations ?? [])]).size;
  const flooded = route?.flooded_nodes.length ?? 0;
  const gridTone = gridFrequency < 59.8 || offline > 1 ? 'critical' : offline ? 'watch' : 'safe';

  const items: Array<{ key: string; icon: IconName; label: string; value: string; unit: string; detail: string; tone: string; extra?: React.ReactNode }> = [
    {
      key: 'water',
      icon: 'water',
      label: 'Water surface',
      value: surface.toFixed(2),
      unit: 'm',
      detail: `${(surface * 3.28084).toFixed(1)} ft NAVD88, level ${floodLevel.toFixed(1)}`,
      tone: floodLevel >= 8 ? 'critical' : floodLevel >= 6 ? 'watch' : 'water',
      extra: <span className="reading-meter" style={{ '--fill': floodLevel / 10 } as CSSProperties} aria-hidden="true"><i /></span>,
    },
    {
      key: 'flooded',
      icon: 'alert',
      label: 'Under water',
      value: flooded.toLocaleString(),
      unit: 'junctions',
      detail: `${(route?.blocked_edges.length ?? 0).toLocaleString()} street segments impassable`,
      tone: flooded > 400 ? 'critical' : flooded > 0 ? 'watch' : 'safe',
    },
    {
      key: 'grid',
      icon: 'bolt',
      label: 'Grid',
      value: gridFrequency > 0 ? gridFrequency.toFixed(2) : 'Down',
      unit: gridFrequency > 0 ? 'Hz' : '',
      detail: offline ? `${offline} substation${offline === 1 ? '' : 's'} offline` : 'All substations in service',
      tone: gridTone,
      extra: <Sparkline data={frequencyHistory} tone={gridTone === 'safe' ? 'safe' : gridTone === 'watch' ? 'watch' : 'critical'} label={`Grid frequency trend, latest ${gridFrequency.toFixed(2)} hertz`} />,
    },
    {
      key: 'roads',
      icon: evacuees > 0 ? 'people' : 'barrier',
      label: evacuees > 0 ? 'Evacuating' : 'Road closures',
      value: evacuees > 0 ? evacuees.toLocaleString() : String(closures.length),
      unit: evacuees > 0 ? 'people' : 'segments',
      detail: evacuees > 0
        ? `${route?.corridor_capacity?.clearance_minutes ? `~${route.corridor_capacity.clearance_minutes.toFixed(0)} min to clear the district` : 'No clearance estimate'}${closures.length ? `, ${closures.length} closures` : ''}`
        : closures.length ? 'Operator closures in effect' : 'No operator closures',
      tone: closures.length || evacuees > 0 ? 'watch' : 'safe',
    },
  ];

  return (
    <ul className="readings">
      {items.map((item, index) => (
        <li key={item.key} className={`reading reading--${item.tone}`} style={{ '--i': index } as CSSProperties}>
          <span className="reading-label"><Icon name={item.icon} size={15} />{item.label}</span>
          <strong className="reading-value">{item.value}<small>{item.unit}</small></strong>
          <span className="reading-detail">{item.detail}</span>
          {item.extra}
        </li>
      ))}
    </ul>
  );
}

export function ExposureCard({ exposure }: { exposure: ExposureSummary | null }) {
  return (
    <article className="card xp">
      <header className="card-head">
        <div>
          <h3>Exposure estimate</h3>
          <p className="card-sub">{exposure ? `${exposure.buildings.toLocaleString()} mapped building footprints` : 'Waiting for terrain'}</p>
        </div>
      </header>
      {exposure && (
        <>
          <div className="xp-grid">
            <div className="xp-figure xp-figure--water"><strong>{exposure.buildingsFlooded.toLocaleString()}</strong><span>buildings in the flood extent</span></div>
            <div className="xp-figure xp-figure--water"><strong>~{exposure.occupantsFlooded.toLocaleString()}</strong><span>daytime occupants in them</span></div>
            <div className="xp-figure"><strong>{exposure.floodedAreaKm2.toFixed(2)}<small>km²</small></strong><span>under water, deepest {exposure.maxDepthM.toFixed(1)} m</span></div>
            <div className="xp-figure xp-figure--dark"><strong>{exposure.buildingsDark.toLocaleString()}</strong><span>buildings without grid power</span></div>
          </div>
          <p className="card-note">Occupancy assumes one person per {SQ_M_PER_OCCUPANT} m² of floor area. Use it for order of magnitude, not headcounts.</p>
        </>
      )}
    </article>
  );
}

export function SheltersCard({ exposure }: { exposure: ExposureSummary | null }) {
  const evacuees = useSimulationStore((state) => state.evacuees);
  const destinationId = useSimulationStore((state) => state.destinationId);
  const setDestination = useSimulationStore((state) => state.setDestination);
  if (!exposure) return null;
  const shortfall = Math.max(0, evacuees - exposure.shelterCapacityUsable);
  const scale = Math.max(evacuees, exposure.shelterCapacity);

  return (
    <article className="card sh">
      <header className="card-head">
        <div>
          <h3>Shelter capacity</h3>
          <p className="card-sub">{exposure.shelterCapacityUsable.toLocaleString()} of {exposure.shelterCapacity.toLocaleString()} beds reachable on dry streets</p>
        </div>
        {evacuees > 0 && <span className={`chip ${shortfall ? 'chip--critical' : 'chip--safe'}`}>{shortfall ? `Short ${shortfall.toLocaleString()}` : 'Covered'}</span>}
      </header>
      <div className="sh-bar" role="img" aria-label={`Usable shelter capacity ${exposure.shelterCapacityUsable} against demand ${evacuees}`}>
        <i className="sh-bar-capacity" style={{ width: `${(exposure.shelterCapacityUsable / scale) * 100}%` }} />
        {evacuees > 0 && <i className="sh-bar-demand" style={{ left: `${Math.min(100, (evacuees / scale) * 100)}%` }} />}
      </div>
      <ul className="sh-list">
        {exposure.shelters.map(({ shelter, flooded, dark }) => (
          <li key={shelter.id} className={destinationId === shelter.id ? 'is-active' : ''}>
            <span className={`sh-kind sh-kind--${shelter.kind}`}>{shelter.kind === 'medical' ? 'Medical' : 'Shelter'}</span>
            <span className="sh-body">
              <strong>{shelter.name}</strong>
              <small>{shelter.capacity.toLocaleString()} capacity{flooded ? ', approach flooded' : ''}{dark ? ', no grid power' : ''}</small>
            </span>
            <button className="button button-ghost button-small" disabled={flooded} onClick={() => setDestination(destinationId === shelter.id ? null : shelter.id)}>
              {destinationId === shelter.id ? 'Routing here' : 'Route here'}
            </button>
          </li>
        ))}
      </ul>
    </article>
  );
}
