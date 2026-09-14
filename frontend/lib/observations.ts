import { api } from './api';
import { levelForWaterSurface } from './solver';
import type { CityData, Observation, ObservationsResponse } from './types';

const FEET_PER_METER = 3.28084;

async function getJson(url: string, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const unavailable = (unit: string, source: string): Observation => ({ status: 'unavailable', value: null, unit, observed_at: null, source });

async function usgs(site: string) {
  const source = `USGS ${site} instantaneous values`;
  const readings = { gage_height: unavailable('ft', source), discharge: unavailable('ft3/s', source) };
  try {
    const payload = await getJson(`https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${site}&parameterCd=00065,00060`);
    (payload?.value?.timeSeries ?? []).forEach((series: any) => {
      const code = series?.variable?.variableCode?.[0]?.value;
      const values = series?.values?.[0]?.value ?? [];
      const latest = values[values.length - 1];
      const value = Number(latest?.value);
      if (!latest || !Number.isFinite(value)) return;
      if (code === '00065') readings.gage_height = { status: 'live', value, unit: 'ft', observed_at: latest.dateTime, source };
      if (code === '00060') readings.discharge = { status: 'live', value, unit: 'ft3/s', observed_at: latest.dateTime, source };
    });
  } catch {
    /* reported as unavailable */
  }
  return readings;
}

async function weather(lat: number, lon: number): Promise<Observation> {
  const source = 'Open-Meteo current conditions';
  try {
    const payload = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&temperature_unit=fahrenheit&timezone=America%2FChicago`);
    const value = Number(payload?.current?.temperature_2m);
    if (!Number.isFinite(value)) throw new Error('missing');
    return { status: 'live', value, unit: '°F', observed_at: payload.current.time ?? null, source };
  } catch {
    return unavailable('°F', source);
  }
}

/**
 * Live conditions for the district. Both public services allow browser
 * requests, so the workspace reads them directly; the API relay is the
 * fallback for networks that block third-party hosts.
 */
export async function fetchObservations(city: CityData, backendOnline: boolean): Promise<ObservationsResponse> {
  const gage = city.flood_model?.gage;
  const [river, air] = await Promise.all([usgs(gage?.site ?? '08074000'), weather(city.center_lat, city.center_lon)]);
  if (river.gage_height.status === 'unavailable' && air.status === 'unavailable' && backendOnline) {
    try {
      return await api.observations();
    } catch {
      /* fall through to the unavailable report */
    }
  }
  let surface: number | null = null;
  let level: number | null = null;
  if (river.gage_height.value !== null) {
    surface = Math.round(((river.gage_height.value + (gage?.datum_navd88_ft ?? 0)) / FEET_PER_METER) * 100) / 100;
    level = Math.round(Math.max(0, Math.min(10, levelForWaterSurface(city, surface))) * 100) / 100;
  }
  return {
    gage_height: river.gage_height,
    discharge: river.discharge,
    air_temperature: air,
    gage_water_surface_m: surface,
    equivalent_flood_level: level,
    fetched_at: new Date().toISOString(),
  };
}
