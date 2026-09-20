'use client';

import { useState } from 'react';
import Icon from '@/components/Icon';
import { useSimulationStore } from '@/hooks/useSimulation';
import { centralTime } from '@/lib/exports';
import { HAZARD_LABELS } from '@/lib/conditions';

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, advisory: 2, unknown: 3, nominal: 4 };

/**
 * Today's roadway, and the switch that puts it in the route.
 *
 * Rainfall, gusts, and every active NWS warning are shown next to the water
 * they put on the streets, because that - not the weather itself - is what
 * changes the recommended route.
 */
export default function ConditionsPanel() {
  const conditions = useSimulationStore((state) => state.conditions);
  const status = useSimulationStore((state) => state.conditionsStatus);
  const useLiveConditions = useSimulationStore((state) => state.useLiveConditions);
  const setUseLiveConditions = useSimulationStore((state) => state.setUseLiveConditions);
  const refreshConditions = useSimulationStore((state) => state.refreshConditions);
  const [refreshing, setRefreshing] = useState(false);

  const live = conditions?.status === 'live';
  const advisories = [...(conditions?.advisories ?? [])].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
  const alerts = conditions?.alerts ?? [];
  const worst = advisories.find((advisory) => advisory.kind !== 'clear');

  const refresh = async () => {
    setRefreshing(true);
    await refreshConditions();
    setRefreshing(false);
  };

  const chipClass = !conditions ? 'chip chip--muted' : live ? 'chip chip--live' : 'chip chip--critical';

  return (
    <article className="card lc conditions">
      <header className="card-head">
        <div>
          <h3>Today&rsquo;s roadway</h3>
          <p className="card-sub">
            {live
              ? `${conditions!.weather_label.replace(/^./, (c) => c.toUpperCase())}, ${conditions!.temperature_f.toFixed(0)}°F downtown`
              : 'Rainfall, wind, ice and active warnings for the district'}
          </p>
        </div>
        <span className={chipClass}>
          {status === 'loading' || (!conditions && status !== 'unavailable') ? 'Checking' : live ? 'Live' : 'Unavailable'}
        </span>
      </header>

      <div className="lc-figures">
        <div>
          <span>Rain now</span>
          <strong>{conditions ? conditions.rain_rate_mm_h.toFixed(1) : '-'}<small>mm/h</small></strong>
          <em>{conditions ? `${conditions.rain_24h_mm.toFixed(1)} mm in 24 h` : 'no reading'}</em>
        </div>
        <div>
          <span>Gusts</span>
          <strong>{conditions ? conditions.wind_gust_mph.toFixed(0) : '-'}<small>mph</small></strong>
          <em>{conditions ? `${conditions.rain_6h_forecast_mm.toFixed(1)} mm next 6 h` : 'forecast'}</em>
        </div>
        <div>
          <span>Water</span>
          <strong>{conditions ? Math.round(conditions.deepest_ponding_m * 1000) : '-'}<small>mm</small></strong>
          <em>{conditions ? `${conditions.ponded_nodes.length} junctions` : 'none standing'}</em>
        </div>
      </div>

      {alerts.length > 0 && (
        <ul className="conditions-alerts">
          {alerts.slice(0, 3).map((alert) => (
            <li key={alert.id} className={`conditions-alert conditions-alert--${alert.hazard}`}>
              <span className="conditions-alert-kind">{HAZARD_LABELS[alert.hazard] ?? 'Weather'}</span>
              <div>
                <strong>{alert.event}</strong>
                <small>
                  {alert.sender}
                  {alert.severity !== 'unknown' ? ` · ${alert.severity}` : ''}
                  {alert.ends ? ` · until ${centralTime(alert.ends)}` : ''}
                </small>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ul className="conditions-advisories">
        {advisories.slice(0, 3).map((advisory, index) => (
          <li key={`${advisory.kind}-${index}`} className={`conditions-advisory conditions-advisory--${advisory.severity}`}>
            <span aria-hidden="true" className="conditions-dot" />
            <p>{advisory.message}</p>
          </li>
        ))}
      </ul>

      {worst?.kind === 'ponding' && !useLiveConditions && (
        <p className="conditions-prompt">
          <Icon name="alert" size={15} /> Street water is not being routed around yet. Turn conditions on to use it.
        </p>
      )}

      <div className="card-actions">
        <button
          className={`button ${useLiveConditions ? 'button-primary' : 'button-secondary'}`}
          onClick={() => setUseLiveConditions(!useLiveConditions)}
          aria-pressed={useLiveConditions}
          disabled={!conditions}
        >
          <Icon name="water" size={16} />{useLiveConditions ? 'Routing on conditions' : 'Route on these conditions'}
        </button>
        <button className="button button-ghost" onClick={() => void refresh()} disabled={refreshing} aria-busy={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <p className="lc-time">
        {conditions?.observed_at
          ? `Observed ${centralTime(conditions.observed_at)} · Open-Meteo rainfall, NWS warnings`
          : 'Public feeds, no key: Open-Meteo and api.weather.gov.'}
      </p>
    </article>
  );
}
