'use client';

import { useState } from 'react';
import Icon from '@/components/Icon';
import { useSimulationStore } from '@/hooks/useSimulation';
import { centralTime } from '@/lib/exports';
import { waterSurfaceM } from '@/lib/solver';

/**
 * Today's river next to the scenario. Observations never overwrite the
 * scenario on their own; the operator chooses to adopt the live reading.
 */
export default function LiveConditions() {
  const observations = useSimulationStore((state) => state.observations);
  const cityData = useSimulationStore((state) => state.cityData);
  const floodLevel = useSimulationStore((state) => state.floodLevel);
  const refreshObservations = useSimulationStore((state) => state.refreshObservations);
  const syncFloodToGage = useSimulationStore((state) => state.syncFloodToGage);
  const [refreshing, setRefreshing] = useState(false);

  const gage = observations?.gage_height;
  const live = gage?.status === 'live';
  const site = cityData?.flood_model?.gage.site ?? '08074000';
  const scenarioSurface = waterSurfaceM(cityData, floodLevel);
  const liveSurface = observations?.gage_water_surface_m ?? null;

  const refresh = async () => {
    setRefreshing(true);
    await refreshObservations();
    setRefreshing(false);
  };

  return (
    <article className="card lc">
      <header className="card-head">
        <div>
          <h3>Buffalo Bayou today</h3>
          <p className="card-sub">USGS gage {site}, about 4 km upstream of downtown</p>
        </div>
        <span className={`chip ${live ? 'chip--live' : 'chip--muted'}`}>{live ? 'Live' : observations ? 'Unavailable' : 'Checking'}</span>
      </header>

      <div className="lc-figures">
        <div>
          <span>Gage height</span>
          <strong>{live && gage?.value !== null ? gage!.value!.toFixed(2) : '-'}<small>ft</small></strong>
          <em>{liveSurface !== null ? `${liveSurface.toFixed(2)} m NAVD88` : 'no reading'}</em>
        </div>
        <div>
          <span>Flow</span>
          <strong>{observations?.discharge.value !== null && observations?.discharge.value !== undefined ? Math.round(observations.discharge.value).toLocaleString() : '-'}<small>ft³/s</small></strong>
          <em>discharge</em>
        </div>
        <div>
          <span>Air</span>
          <strong>{observations?.air_temperature.value !== null && observations?.air_temperature.value !== undefined ? observations.air_temperature.value.toFixed(0) : '-'}<small>°F</small></strong>
          <em>downtown</em>
        </div>
      </div>

      {liveSurface !== null && (
        <p className="lc-compare">
          The scenario water surface is <b>{Math.abs(scenarioSurface - liveSurface).toFixed(1)} m {scenarioSurface >= liveSurface ? 'above' : 'below'}</b> today&rsquo;s reading.
        </p>
      )}
      <p className="lc-time">
        {gage?.observed_at ? `Observed ${centralTime(gage.observed_at)}` : 'Live readings refresh every five minutes.'}
      </p>
      <div className="card-actions">
        <button className="button button-secondary" onClick={syncFloodToGage} disabled={observations?.equivalent_flood_level === null || observations?.equivalent_flood_level === undefined}>
          <Icon name="water" size={16} />Use live reading
        </button>
        <button className="button button-ghost" onClick={() => void refresh()} disabled={refreshing} aria-busy={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </article>
  );
}
