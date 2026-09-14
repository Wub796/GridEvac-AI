'use client';

import { useMemo, useRef, type CSSProperties } from 'react';
import { useSimulationStore } from '@/hooks/useSimulation';
import { useScrollProgress } from '@/hooks/useScrollProgress';
import { triggerCause } from '@/lib/exports';
import { waterSurfaceM } from '@/lib/solver';
import type { TriggerTarget } from '@/lib/types';

const FEET = 3.28084;

type Group = { threshold: number; targets: TriggerTarget[]; top: number; labelTop: number };

/**
 * Trigger points drawn on a river staff gauge: the modeled water line and,
 * for every exit and shelter, the water surface at which it is cut off from
 * the current origin. The distance between them is the time an operator has
 * to act, expressed in metres of rise.
 */
export default function TriggerGauge() {
  const ref = useRef<HTMLElement>(null);
  useScrollProgress(ref);
  const triggerPoints = useSimulationStore((state) => state.triggerPoints);
  const cityData = useSimulationStore((state) => state.cityData);
  const floodLevel = useSimulationStore((state) => state.floodLevel);
  const setFlyToNodeId = useSimulationStore((state) => state.setFlyToNodeId);
  const surface = waterSurfaceM(cityData, floodLevel);

  const layout = useMemo(() => {
    if (!triggerPoints?.targets.length) return null;
    const thresholds = triggerPoints.targets.map((target) => target.threshold_m);
    const min = Math.floor(Math.min(...thresholds, surface) - 1);
    const max = Math.ceil(Math.max(...thresholds, surface, Math.min(triggerPoints.origin_stage_m, Math.max(...thresholds) + 3)) + 0.5);
    const y = (value: number) => ((max - value) / (max - min)) * 100;
    const groups: Group[] = [];
    triggerPoints.targets.forEach((target) => {
      const group = groups.find((item) => Math.abs(item.threshold - target.threshold_m) < 0.05);
      if (group) group.targets.push(target);
      else groups.push({ threshold: target.threshold_m, targets: [target], top: y(target.threshold_m), labelTop: y(target.threshold_m) });
    });
    // Nudge labels apart so equal-ish thresholds never overprint.
    groups.sort((a, b) => a.top - b.top);
    const gap = 13;
    groups.forEach((group, index) => {
      if (index > 0) group.labelTop = Math.max(group.top, groups[index - 1].labelTop + gap);
    });
    const overflow = groups.length ? groups[groups.length - 1].labelTop - 94 : 0;
    if (overflow > 0) groups.forEach((group) => { group.labelTop -= overflow; });
    const step = max - min > 10 ? 2 : 1;
    const ticks: number[] = [];
    for (let value = min; value <= max; value += step) ticks.push(value);
    return { groups, ticks, y, originTop: triggerPoints.origin_stage_m <= max ? y(triggerPoints.origin_stage_m) : null };
  }, [triggerPoints, surface]);

  return (
    <article className="card tg" ref={ref}>
      <header className="card-head">
        <div>
          <h3>Trigger points</h3>
          <p className="card-sub">Water surface at which each destination is cut off from this origin</p>
        </div>
      </header>
      {!layout || !triggerPoints ? (
        <p className="empty">Trigger points appear once an origin is set.</p>
      ) : (
        <>
          <div className="tg-plot" style={{ '--water-top': `${layout.y(surface)}%` } as CSSProperties}>
            <div className="tg-axis" aria-hidden="true">
              {layout.ticks.map((value) => <span key={value} style={{ top: `${layout.y(value)}%` }}>{value}</span>)}
              <em>m NAVD88</em>
            </div>
            <div className="tg-staff" aria-hidden="true">
              <div className="tg-water"><i /></div>
              <span className="tg-water-label">Water {surface.toFixed(2)} m</span>
              {layout.originTop !== null && (
                <span className="tg-origin" style={{ top: `${layout.originTop}%` }}>Origin floods</span>
              )}
              {layout.groups.map((group) => {
                const margin = group.threshold - surface;
                const tone = margin <= 0 ? 'critical' : margin < 1 ? 'watch' : 'safe';
                return <i key={group.threshold} className={`tg-mark tg-mark--${tone}`} style={{ top: `${group.top}%` }} />;
              })}
            </div>
            <ul className="tg-labels">
              {layout.groups.map((group) => {
                const margin = group.threshold - surface;
                const tone = margin <= 0 ? 'critical' : margin < 1 ? 'watch' : 'safe';
                const lead = group.targets[0];
                return (
                  <li key={group.threshold} style={{ top: `${group.labelTop}%` }}>
                    <button className={`tg-label tg-label--${tone}`} onClick={() => setFlyToNodeId(lead.limited_by === 'corridor' ? lead.bottleneck_node : lead.node)}>
                      <strong>{group.targets.map((target) => target.name).join(', ')}</strong>
                      <span>
                        {group.threshold.toFixed(2)} m ({(group.threshold * FEET).toFixed(1)} ft)
                        {margin <= 0 ? ', already cut off' : `, ${margin.toFixed(1)} m above the water`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <table className="sr-only">
            <caption>Trigger points from the current origin</caption>
            <thead><tr><th>Destination</th><th>Cut off at (m NAVD88)</th><th>Cause</th></tr></thead>
            <tbody>
              {triggerPoints.targets.map((target) => (
                <tr key={target.id}><td>{target.name}</td><td>{target.threshold_m.toFixed(2)}</td><td>{target.limited_by === 'corridor' ? `${triggerCause(target)} floods` : `${target.limited_by} floods`}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="tg-note">
            {(() => {
              const first = triggerPoints.targets.filter((target) => target.threshold_m > surface).sort((a, b) => a.threshold_m - b.threshold_m)[0];
              if (!first) return 'Every destination is already cut off at the modeled water surface.';
              const cause = first.limited_by === 'corridor' ? `when ${triggerCause(first)} floods` : first.limited_by === 'destination' ? 'when its own approach floods' : 'when the origin floods';
              return `Next to go: ${first.name}, ${cause}, after ${(first.threshold_m - surface).toFixed(1)} m more rise.`;
            })()}
          </p>
        </>
      )}
    </article>
  );
}
