'use client';

import { useMemo, useRef, type CSSProperties } from 'react';
import Icon, { type IconName } from '@/components/Icon';
import { useSimulationStore } from '@/hooks/useSimulation';
import { useScrollProgress } from '@/hooks/useScrollProgress';
import { formatDistance } from '@/lib/exports';
import { toUsng } from '@/lib/usng';

const MANEUVER_ICONS: Record<string, IconName> = {
  depart: 'depart',
  continue: 'continue',
  'turn-left': 'turn-left',
  'turn-right': 'turn-right',
  'slight-left': 'slight-left',
  'slight-right': 'slight-right',
  'sharp-left': 'sharp-left',
  'sharp-right': 'sharp-right',
  uturn: 'uturn',
};

/**
 * Turn-by-turn strip map. The spine draws down as the reader scrolls through
 * the steps; hovering a step lights that stretch of road on the map.
 */
export default function RouteTimeline() {
  const ref = useRef<HTMLElement>(null);
  useScrollProgress(ref);
  const route = useSimulationStore((state) => state.route);
  const cityData = useSimulationStore((state) => state.cityData);
  const originNode = useSimulationStore((state) => state.originNode);
  const highlightedStep = useSimulationStore((state) => state.highlightedStep);
  const setHighlightedStep = useSimulationStore((state) => state.setHighlightedStep);
  const setFlyToNodeId = useSimulationStore((state) => state.setFlyToNodeId);

  const nodes = useMemo(() => new Map((cityData?.nodes ?? []).map((node) => [node.id, node])), [cityData]);
  const origin = nodes.get(originNode);
  const destination = route ? nodes.get(route.dest_node) : undefined;
  let cumulative = 0;

  return (
    <article className="card rt" ref={ref}>
      <header className="card-head">
        <div>
          <h3>Turn by turn</h3>
          <p className="card-sub">{route?.success ? `${route.route_steps.length} road segments, ${formatDistance(route.distance_m)}, ${route.eta_minutes.toFixed(1)} min at free flow` : 'Directions appear when a corridor is passable'}</p>
        </div>
      </header>
      {!route?.success ? (
        <p className="empty">{route?.message ?? 'Waiting for the first route assessment.'}</p>
      ) : (
        <ol className="rt-list" style={{ '--n': route.route_steps.length + 2 } as CSSProperties} onMouseLeave={() => setHighlightedStep(null)}>
          <span className="rt-spine" aria-hidden="true"><i /></span>
          <li className="rt-row rt-row--end">
            <span className="rt-icon rt-icon--origin"><Icon name="pin" size={16} /></span>
            <span className="rt-body">
              <strong>{origin?.intersection_name ?? `Node ${originNode}`}</strong>
              <span className="mono">{origin ? toUsng(origin.lat, origin.lon) : ''}</span>
            </span>
          </li>
          {route.route_steps.map((step, index) => {
            cumulative += step.distance_m;
            return (
              <li key={`${step.from_node}-${index}`} className={`rt-row ${highlightedStep === index ? 'is-active' : ''}`} style={{ '--i': index } as CSSProperties}>
                <button
                  className="rt-step"
                  onMouseEnter={() => setHighlightedStep(index)}
                  onFocus={() => setHighlightedStep(index)}
                  onBlur={() => setHighlightedStep(null)}
                  onClick={() => setFlyToNodeId(step.from_node)}
                >
                  <span className="rt-icon"><Icon name={MANEUVER_ICONS[step.maneuver] ?? 'continue'} size={16} /></span>
                  <span className="rt-body">
                    <strong>{step.instruction}</strong>
                    <span>{formatDistance(step.distance_m)}, {Math.max(1, Math.round(step.duration_s))} s</span>
                  </span>
                  <span className="rt-cumulative">{(cumulative / 1000).toFixed(2)} km</span>
                </button>
              </li>
            );
          })}
          <li className="rt-row rt-row--end">
            <span className="rt-icon rt-icon--arrive"><Icon name="arrive" size={16} /></span>
            <span className="rt-body">
              <strong>Arrive at {route.destination_name || cityData?.exit_names?.[String(route.dest_node)] || destination?.intersection_name}</strong>
              <span className="mono">{destination ? `${destination.intersection_name}, ${toUsng(destination.lat, destination.lon)}` : ''}</span>
            </span>
          </li>
        </ol>
      )}
    </article>
  );
}
