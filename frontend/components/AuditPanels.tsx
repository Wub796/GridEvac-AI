'use client';

import { useState } from 'react';
import Icon from '@/components/Icon';
import { useSimulationStore } from '@/hooks/useSimulation';
import { centralTime, formatDistance } from '@/lib/exports';

export function CorridorTable() {
  const corridorComparison = useSimulationStore((state) => state.corridorComparison);
  const triggerPoints = useSimulationStore((state) => state.triggerPoints);
  const evacuees = useSimulationStore((state) => state.evacuees);
  const route = useSimulationStore((state) => state.route);
  const setFlyToNodeId = useSimulationStore((state) => state.setFlyToNodeId);
  const corridors = corridorComparison?.corridors ?? [];

  return (
    <article className="card ct">
      <header className="card-head">
        <div>
          <h3>Exit corridors</h3>
          <p className="card-sub">Ranked safest first. Times are travel time; penalties only decide the order.</p>
        </div>
      </header>
      {corridors.length === 0 ? (
        <p className="empty">No perimeter exit is reachable from this origin in the current scenario.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Exit</th>
                <th scope="col" className="num">Free flow</th>
                <th scope="col" className="num">{evacuees > 0 ? 'Under demand' : 'Distance'}</th>
                <th scope="col" className="num">Capacity</th>
                <th scope="col" className="num">Hazard segments</th>
                <th scope="col" className="num">Cut off at</th>
              </tr>
            </thead>
            <tbody>
              {corridors.map((corridor, index) => {
                const trigger = triggerPoints?.targets.find((target) => target.kind === 'exit' && Number(target.id) === corridor.exit_node);
                const chosen = route?.success && !route.destination_name && route.dest_node === corridor.exit_node;
                return (
                  <tr key={corridor.exit_node} className={chosen ? 'is-chosen' : ''}>
                    <td>{index + 1}</td>
                    <td>
                      <button className="link-button" onClick={() => setFlyToNodeId(corridor.exit_node)}>{corridor.exit_name}</button>
                      {chosen && <span className="chip chip--signal">Recommended</span>}
                    </td>
                    <td className="num">{corridor.eta_minutes.toFixed(1)} min</td>
                    <td className="num">{evacuees > 0 ? `${corridor.congested_eta_minutes.toFixed(1)} min` : formatDistance(corridor.distance_m)}</td>
                    <td className="num">{corridor.people_per_hour.toLocaleString()}/h</td>
                    <td className="num">{corridor.hazard_count}</td>
                    <td className="num">{trigger ? `${trigger.threshold_m.toFixed(2)} m` : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function EventLog({ onExport }: { onExport: () => void }) {
  const events = useSimulationStore((state) => state.events);
  const [showAll, setShowAll] = useState(false);
  const list = showAll ? events : events.slice(0, 10);

  return (
    <article className="card log">
      <header className="card-head">
        <div>
          <h3>Operator event log</h3>
          <p className="card-sub">{events.length} events this session, times in Houston local time</p>
        </div>
        <button className="button button-ghost button-small" onClick={onExport}><Icon name="download" size={15} />CSV</button>
      </header>
      <ol className="log-list">
        {list.map((event) => (
          <li key={event.id} className={`log-item log-item--${event.kind}`}>
            <time dateTime={event.at}>{centralTime(event.at, false)}</time>
            <p>{event.message}</p>
          </li>
        ))}
      </ol>
      {events.length > 10 && (
        <button className="link-button" onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show the latest 10' : `Show all ${events.length}`}
        </button>
      )}
    </article>
  );
}

export function MethodNotes() {
  const cityData = useSimulationStore((state) => state.cityData);
  const model = cityData?.flood_model;
  return (
    <article className="card notes">
      <header className="card-head"><div><h3>Data and limitations</h3><p className="card-sub">What the model knows, and what it does not</p></div></header>
      <dl className="notes-list">
        <div><dt>Streets and buildings</dt><dd>OpenStreetMap contributors: named streets with one-way rules, tagged lane counts and speed limits, and {cityData?.blocks.length.toLocaleString() ?? '1,400'} building footprints.</dd></div>
        <div><dt>Ground elevation</dt><dd>{model?.elevation_source || 'USGS 3DEP bare-earth DEM'}, metres {model?.vertical_datum ?? 'NAVD88'}. Bridge decks stay dry above flooded ground.</dd></div>
        <div><dt>Flood model</dt><dd>Water spreads from Buffalo, White Oak, and Little White Oak bayous across connected ground below the scenario surface. Rainfall ponding, storm-drain backup, and the channel&rsquo;s downstream slope are not modeled.</dd></div>
        <div><dt>Routing</dt><dd>Least-cost path over passable streets; vehicles obey one-way rules. Penalties for flooded approaches, blackout districts, and energized lines change the order, never the reported minutes.</dd></div>
        <div><dt>Congestion</dt><dd>Bureau of Public Roads curve, with evacuating demand loading within one hour across every dry exit corridor.</dd></div>
        <div><dt>Utilities</dt><dd>Substations, loads, and service areas are illustrative, not CenterPoint Energy data. A flooded substation trips offline.</dd></div>
        <div><dt>Coordinates</dt><dd>WGS84 latitude and longitude, with U.S. National Grid references for field teams.</dd></div>
      </dl>
    </article>
  );
}
