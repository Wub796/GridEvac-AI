'use client';

import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import Icon, { type IconName } from '@/components/Icon';
import { useSimulationStore, type Section } from '@/hooks/useSimulation';
import { waterSurfaceM } from '@/lib/solver';

const SECTIONS: Array<{ id: Section; label: string; icon: IconName; key: string }> = [
  { id: 'briefing', label: 'Briefing', icon: 'file', key: '1' },
  { id: 'map', label: 'Route planner', icon: 'route', key: '2' },
  { id: 'audit', label: 'Audit', icon: 'chart', key: '3' },
];

/**
 * Section navigation above a staff gauge. The gauge is the scenario itself:
 * drag its water column (or use the arrow keys) and the flood level follows.
 * Its scale is the modeled water surface on NAVD88, always in view.
 */
export default function WaterRail({ onNavigate }: { onNavigate: (section: Section) => void }) {
  const active = useSimulationStore((state) => state.activeSection);
  const floodLevel = useSimulationStore((state) => state.floodLevel);
  const setFloodLevel = useSimulationStore((state) => state.setFloodLevel);
  const cityData = useSimulationStore((state) => state.cityData);
  const staffRef = useRef<HTMLDivElement | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const activeIndex = Math.max(0, SECTIONS.findIndex((section) => section.id === active));
  const surface = waterSurfaceM(cityData, floodLevel);
  const datum = cityData?.flood_model?.datum_m ?? 0;
  const rise = cityData?.flood_model?.rise_per_level_m ?? 1.7;

  /** Turn a pointer height inside the staff into a 0–10 level, rounded to 0.1. */
  const levelAt = useCallback((clientY: number) => {
    const rect = staffRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return 0;
    const ratio = (rect.bottom - clientY) / rect.height;
    return Math.round(Math.min(1, Math.max(0, ratio)) * 100) / 10;
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrubbing(true);
    setFloodLevel(levelAt(event.clientY));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    setFloodLevel(levelAt(event.clientY));
  };

  const endScrub = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setScrubbing(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'PageUp' || event.key === 'PageDown' ? 1 : 0.2;
    let next: number | null = null;
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = floodLevel + step;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = floodLevel - step;
    else if (event.key === 'PageUp') next = floodLevel + step;
    else if (event.key === 'PageDown') next = floodLevel - step;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 10;
    if (next === null) return;
    event.preventDefault();
    setFloodLevel(Math.round(Math.min(10, Math.max(0, next)) * 10) / 10);
  };

  return (
    <nav className="rail" aria-label="Workspace sections">
      <div className="rail-nav" style={{ '--active': activeIndex } as CSSProperties}>
        <span className="rail-pill" aria-hidden="true" />
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            className="rail-link"
            aria-current={active === section.id ? 'true' : undefined}
            aria-keyshortcuts={section.key}
            onClick={() => onNavigate(section.id)}
          >
            <Icon name={section.icon} size={19} />
            <span>{section.label}</span>
          </button>
        ))}
      </div>

      <div className="rail-gauge">
        <span className="rail-gauge-title">Water</span>
        <div
          ref={staffRef}
          className={scrubbing ? 'rail-staff is-scrubbing' : 'rail-staff'}
          style={{ '--level': floodLevel / 10 } as CSSProperties}
          role="slider"
          tabIndex={0}
          aria-label="Scenario water level"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={10}
          aria-valuenow={Number(floodLevel.toFixed(1))}
          aria-valuetext={`${surface.toFixed(1)} metres NAVD88`}
          title="Drag or use the arrow keys to raise the water"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onKeyDown={onKeyDown}
        >
          <div className="rail-water" aria-hidden="true"><i /></div>
          {[0, 2, 4, 6, 8, 10].map((level) => (
            <span key={level} className="rail-tick" style={{ '--at': level / 10 } as CSSProperties} aria-hidden="true">
              <b>{Math.round(datum + level * rise)}</b>
            </span>
          ))}
        </div>
        <strong className="rail-gauge-value">{surface.toFixed(1)}<small>m</small></strong>
        <span className="rail-gauge-datum">NAVD88</span>
      </div>
    </nav>
  );
}
