'use client';

import type { CSSProperties } from 'react';
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
 * its water column is the modeled water surface on the same NAVD88 scale as
 * the flood model, always in view whichever section is open.
 */
export default function WaterRail({ onNavigate }: { onNavigate: (section: Section) => void }) {
  const active = useSimulationStore((state) => state.activeSection);
  const floodLevel = useSimulationStore((state) => state.floodLevel);
  const cityData = useSimulationStore((state) => state.cityData);
  const activeIndex = Math.max(0, SECTIONS.findIndex((section) => section.id === active));
  const surface = waterSurfaceM(cityData, floodLevel);
  const datum = cityData?.flood_model?.datum_m ?? 0;
  const rise = cityData?.flood_model?.rise_per_level_m ?? 1.7;

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

      <div className="rail-gauge" role="img" aria-label={`Scenario water surface ${surface.toFixed(1)} metres NAVD88, level ${floodLevel.toFixed(1)} of 10`}>
        <span className="rail-gauge-title">Water</span>
        <div className="rail-staff" style={{ '--level': floodLevel / 10 } as CSSProperties}>
          <div className="rail-water"><i /></div>
          {[0, 2, 4, 6, 8, 10].map((level) => (
            <span key={level} className="rail-tick" style={{ '--at': level / 10 } as CSSProperties}>
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
