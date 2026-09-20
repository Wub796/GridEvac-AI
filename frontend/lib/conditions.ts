/**
 * Offline road-condition model: a mirror of backend/conditions.py.
 *
 * Rainfall, wind, ice and heat are turned into the two things the router can
 * use - standing-water depth per junction against each mode's crossing
 * clearance, and the speed a segment actually achieves - so the browser gives
 * the same answer as the API when the API is unreachable, and a shared link
 * replays identically from the snapshot it carries.
 *
 * Sources are public and key-free: Open-Meteo for rainfall, accumulations and
 * gusts, and NWS api.weather.gov for every active watch, warning, and
 * advisory over the district.
 */
import type { CityData, ConditionAdvisory, NodeData, RoadConditions, WeatherAlert, WeatherSnapshot } from './types';

/** Houston storm sewers are designed for roughly a 2-year storm. */
const DRAINAGE_CAPACITY_MM_H = 35.0;
const PONDING_M_PER_EXCESS_MM_H = 0.006;
const MAX_PONDING_M = 1.2;
/** Water shallower than this sheets without deciding anything. */
export const PONDING_VISIBLE_M = 0.05;
/** An active flood warning sets the floor for the intensity being drained. */
const FLOOD_ALERT_INTENSITY_FLOOR_MM_H = 30.0;
const FLOOD_ALERT_INTENSITY_PER_WEIGHT_MM_H = 25.0;
const PONDING_DELAY_S = 40.0;
const PONDING_COST_S = 45.0;
const PONDING_DELAY_EXPONENT = 2.0;
const PONDING_COST_EXPONENT = 1.5;
const WET_SPEED_LOSS = 0.1;
const VISIBILITY_ONSET_MM_H = 7.6;
const VISIBILITY_FULL_MM_H = 30.0;
const VISIBILITY_SPEED_LOSS = 0.22;
const BRIDGE_WIND_EXPOSURE = 0.85;
const STREET_WIND_EXPOSURE = 0.18;
const WIND_GUST_ONSET_MPH = 25.0;
const WIND_GUST_RANGE_MPH = 45.0;
const ICE_SPEED_FACTOR = 0.6;
const FOG_SPEED_LOSS = 0.35;
const HEAT_FOOT_SPEED_LOSS = 0.25;

/** Depth at which each mode can no longer cross: NWS "Turn Around Don't Drown". */
export const MODE_CLEARANCE_M: Record<string, number> = { vehicle: 0.15, ems: 0.2, foot: 0.3 };

const WMO_LABELS: Record<number, string> = {
  0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'heavy freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'heavy freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm',
  96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

/** NWS event name -> the roadway problem it describes. First match wins. */
const EVENT_HAZARDS: Array<[string, string]> = [
  ['flash flood', 'flood'], ['flood', 'flood'], ['hurricane', 'flood'],
  ['tropical storm', 'flood'], ['storm surge', 'flood'], ['hydrologic', 'flood'],
  ['tornado', 'wind'], ['high wind', 'wind'], ['wind advisory', 'wind'],
  ['extreme wind', 'wind'], ['dust storm', 'wind'],
  ['ice storm', 'ice'], ['winter storm', 'ice'], ['winter weather', 'ice'],
  ['freezing rain', 'ice'], ['blizzard', 'ice'], ['snow squall', 'ice'],
  ['fog', 'fog'], ['dense fog', 'fog'],
  ['heat', 'heat'],
];

const FREEZING_CODES = new Set([48, 56, 57, 66, 67, 71, 73, 75, 77, 85, 86]);
const SEVERITY_WEIGHT: Record<string, number> = { extreme: 1, severe: 0.75, moderate: 0.45, minor: 0.2, unknown: 0.3 };

export const HAZARD_LABELS: Record<string, string> = {
  flood: 'Flooding', wind: 'Wind', ice: 'Ice and snow', fog: 'Visibility', heat: 'Heat', other: 'Weather',
};

/* --------------------------------------------------------------- snapshot */

export function unavailableWeather(source = 'Open-Meteo forecast API'): WeatherSnapshot {
  return {
    status: 'unavailable', observed_at: null,
    rain_rate_mm_h: 0, rain_1h_mm: 0, rain_6h_mm: 0, rain_24h_mm: 0, rain_6h_forecast_mm: 0, peak_rate_6h_mm_h: 0,
    wind_speed_mph: 0, wind_gust_mph: 0, temperature_f: 0, weather_code: 0, source,
  };
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/* --------------------------------------------------------------- fetching */

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

/** Current rainfall, accumulations, the coming short forecast, and gusts. */
export async function fetchWeather(lat: number, lon: number): Promise<WeatherSnapshot> {
  const source = 'Open-Meteo forecast API';
  try {
    const payload = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&current=temperature_2m,precipitation,rain,weather_code,wind_speed_10m,wind_gusts_10m' +
      '&hourly=precipitation,wind_gusts_10m&past_hours=24&forecast_hours=6' +
      '&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=America%2FChicago',
    );
    const current = payload?.current ?? {};
    const rain: number[] = (payload?.hourly?.precipitation ?? []).map((value: unknown) => finite(value) ?? 0);
    const gusts: Array<number | null> = (payload?.hourly?.wind_gusts_10m ?? []).map((value: unknown) => finite(value));
    // Past hours come first and the series ends with the coming six.
    const nowIndex = Math.max(0, rain.length - 6);
    const past = rain.slice(0, nowIndex);
    const ahead = rain.slice(nowIndex);
    // `current.precipitation` is a sum over the named block (15 minutes), so
    // scale it to an hourly rate rather than trusting the units label.
    const intervalSeconds = finite(current.interval) ?? 900;
    const blockMm = finite(current.precipitation) ?? 0;
    return {
      status: 'live',
      observed_at: current.time ?? null,
      rain_rate_mm_h: Math.round((blockMm * 3600) / Math.max(60, intervalSeconds) * 100) / 100,
      rain_1h_mm: past.length ? past[past.length - 1] : 0,
      rain_6h_mm: Math.round(past.slice(-6).reduce((sum, value) => sum + value, 0) * 100) / 100,
      rain_24h_mm: Math.round(past.reduce((sum, value) => sum + value, 0) * 100) / 100,
      rain_6h_forecast_mm: Math.round(ahead.reduce((sum, value) => sum + value, 0) * 100) / 100,
      peak_rate_6h_mm_h: Math.round(Math.max(0, ...past.slice(-6), ...ahead) * 100) / 100,
      wind_speed_mph: finite(current.wind_speed_10m) ?? 0,
      wind_gust_mph: finite(current.wind_gusts_10m) ?? 0,
      temperature_f: finite(current.temperature_2m) ?? 0,
      weather_code: Math.trunc(finite(current.weather_code) ?? 0),
      source,
    };
  } catch {
    return unavailableWeather(source);
  }
}

function alertHazard(event: string): string {
  const lowered = (event || '').toLowerCase();
  for (const [needle, hazard] of EVENT_HAZARDS) if (lowered.includes(needle)) return hazard;
  return 'other';
}

/** Every active NWS watch, warning, and advisory over the district. */
export async function fetchAlerts(lat: number, lon: number): Promise<WeatherAlert[]> {
  try {
    const payload = await getJson(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
    const alerts: WeatherAlert[] = (payload?.features ?? []).map((feature: any) => {
      const props = feature?.properties ?? {};
      const event = String(props.event ?? 'Weather alert');
      const severity = String(props.severity ?? 'Unknown').toLowerCase();
      return {
        id: String(props.id ?? event),
        event,
        hazard: alertHazard(event),
        severity,
        weight: SEVERITY_WEIGHT[severity] ?? 0.3,
        urgency: String(props.urgency ?? 'Unknown').toLowerCase(),
        certainty: String(props.certainty ?? 'Unknown').toLowerCase(),
        headline: String(props.headline ?? ''),
        instruction: String(props.instruction ?? ''),
        sender: String(props.senderName ?? 'NWS'),
        onset: props.onset ?? props.effective ?? '',
        ends: props.ends ?? props.expires ?? '',
      };
    });
    return alerts.sort((a, b) => b.weight - a.weight || a.event.localeCompare(b.event));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ model */

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)))];
}

/**
 * Standing water on a street at `elevation` under a rainfall intensity.
 *
 * `lowness` is where the junction sits between the district's low decile and
 * its 60th percentile: bayou-adjacent streets pond first and deepest, while
 * high ground with intact drainage clears everything but a downpour.
 */
export function pondingDepthM(elevation: number, intensityMmH: number, lowReferenceM: number, midReferenceM: number): number {
  const span = Math.max(0.5, midReferenceM - lowReferenceM);
  const lowness = Math.min(1, Math.max(0, (midReferenceM - elevation) / span));
  const localCapacity = DRAINAGE_CAPACITY_MM_H * (1 - 0.75 * lowness);
  const excess = Math.max(0, intensityMmH - localCapacity);
  const depth = PONDING_M_PER_EXCESS_MM_H * excess * (0.35 + 0.65 * lowness);
  return Math.round(Math.min(MAX_PONDING_M, depth) * 1000) / 1000;
}

/**
 * Turn a weather snapshot into per-junction water and per-mode speed factors.
 *
 * Pure: identical inputs always give the identical roadway, which is what
 * makes a live-conditions route reproducible from a recorded snapshot.
 */
export function buildConditions(
  nodes: Array<Pick<NodeData, 'id' | 'elevation' | 'elevated'>>,
  weather: WeatherSnapshot = unavailableWeather(),
  alerts: WeatherAlert[] = [],
  gageSurfaceM: number | null = null,
): RoadConditions {
  const elevations = nodes.map((node) => node.elevation).sort((a, b) => a - b);
  const lowReference = percentile(elevations, 0.05);
  const midReference = percentile(elevations, 0.6);

  const alertWeight: Record<string, number> = {};
  alerts.forEach((alert) => {
    alertWeight[alert.hazard] = Math.max(alertWeight[alert.hazard] ?? 0, alert.weight ?? 0.3);
  });

  const rainRate = weather.rain_rate_mm_h ?? 0;
  const rain1h = weather.rain_1h_mm ?? 0;
  const rain6h = weather.rain_6h_mm ?? 0;
  const rain24h = weather.rain_24h_mm ?? 0;
  const forecast1h = (weather.rain_6h_forecast_mm ?? 0) / 6;
  const peak = weather.peak_rate_6h_mm_h ?? 0;

  // The worst measuring window, because a street floods on the peak.
  let intensity = Math.max(rainRate, rain1h, rain6h / 6, rain24h / 24, forecast1h);
  const floodWeight = alertWeight.flood ?? 0;
  if (floodWeight) {
    const floor = FLOOD_ALERT_INTENSITY_FLOOR_MM_H + FLOOD_ALERT_INTENSITY_PER_WEIGHT_MM_H * floodWeight;
    intensity = Math.max(intensity, peak, floor);
  }

  let gust = weather.wind_gust_mph ?? 0;
  if (alertWeight.wind) gust = Math.max(gust, 40 + 25 * alertWeight.wind);
  const ice = Boolean(alertWeight.ice) || FREEZING_CODES.has(weather.weather_code ?? 0);
  const fog = Boolean(alertWeight.fog) || [45, 48].includes(weather.weather_code ?? 0);
  const heat = alertWeight.heat ?? 0;

  // Wet-pavement loss, graded by how hard and how long it has been raining.
  const wetness = Math.min(1, Math.max(rain1h / 4, rain6h / 12, rain24h / 25, rainRate / 8));
  let visibilityLoss = VISIBILITY_SPEED_LOSS * Math.min(1, Math.max(0, (intensity - VISIBILITY_ONSET_MM_H) / (VISIBILITY_FULL_MM_H - VISIBILITY_ONSET_MM_H)));
  if (fog) visibilityLoss = FOG_SPEED_LOSS;

  let surfaceVehicle = (1 - WET_SPEED_LOSS * wetness) * (1 - visibilityLoss);
  if (ice) surfaceVehicle *= ICE_SPEED_FACTOR;
  const gustOver = Math.max(0, gust - WIND_GUST_ONSET_MPH);
  const windStreet = Math.min(0.35, (gustOver / WIND_GUST_RANGE_MPH) * STREET_WIND_EXPOSURE);
  const windBridge = Math.min(0.5, (gustOver / WIND_GUST_RANGE_MPH) * BRIDGE_WIND_EXPOSURE);
  const vehicleFactor = Math.max(0.4, surfaceVehicle * (1 - windStreet));
  const vehicleBridge = Math.max(0.3, surfaceVehicle * (1 - windBridge));

  let surfaceFoot = (1 - visibilityLoss * 0.6) * (1 - heat * HEAT_FOOT_SPEED_LOSS);
  if (ice) surfaceFoot *= 0.75;
  const footFactor = Math.max(0.4, surfaceFoot * (1 - 0.35 * windStreet));
  const footBridge = Math.max(0.4, surfaceFoot * (1 - 0.75 * windBridge));

  const ponding: Record<number, number> = {};
  const visible: Record<number, number> = {};
  nodes.forEach((node) => {
    const depth = pondingDepthM(node.elevation, intensity, lowReference, midReference);
    // A bridge deck is above the standing water on the road beneath it.
    if (depth < 0.005 || node.elevated) return;
    ponding[node.id] = depth;
    if (depth >= PONDING_VISIBLE_M) visible[node.id] = depth;
  });
  const depths = Object.values(visible).sort((a, b) => a - b);
  const deepest = depths.length ? depths[depths.length - 1] : 0;
  const impassable: Record<string, number[]> = {};
  Object.entries(MODE_CLEARANCE_M).forEach(([mode, clearance]) => {
    impassable[mode] = Object.entries(ponding).filter(([, depth]) => depth >= clearance).map(([id]) => Number(id)).sort((a, b) => a - b);
  });

  const advisories: ConditionAdvisory[] = [];
  if (weather.status !== 'live') {
    advisories.push({
      kind: 'feed', severity: 'unknown',
      message: 'Live weather feed unreachable: roadway conditions are unknown, so this route assumes dry pavement and no standing water.',
      affected: 0,
    });
  }
  if (Object.keys(visible).length > 0) {
    advisories.push({
      kind: 'ponding',
      severity: impassable.vehicle.length ? 'critical' : 'warning',
      message: impassable.vehicle.length
        ? `Standing water on ${Object.keys(visible).length} junctions, deepest ${deepest.toFixed(2)} m (${Math.round(deepest * 39.3701)} in); ${impassable.vehicle.length} impassable to vehicles.`
        : `Standing water on ${Object.keys(visible).length} junctions, deepest ${deepest.toFixed(2)} m (${Math.round(deepest * 39.3701)} in).`,
      affected: Object.keys(visible).length,
    });
  }
  if (wetness > 0.15) {
    advisories.push({
      kind: 'surface', severity: wetness < 0.6 ? 'advisory' : 'warning',
      message: `Wet pavement: achieved speeds run about ${Math.round((1 - vehicleFactor) * 100)}% below the dry limit.`,
      affected: 0,
    });
  }
  if (gust >= WIND_GUST_ONSET_MPH) {
    advisories.push({
      kind: 'wind', severity: gust >= 45 ? 'warning' : 'advisory',
      message: `Gusts to ${Math.round(gust)} mph: sheltered streets run ${Math.round(windStreet * 100)}% slower, exposed bridge decks ${Math.round(windBridge * 100)}% slower.`,
      affected: 0,
    });
  }
  if (ice) advisories.push({ kind: 'ice', severity: 'critical', message: 'Freezing conditions: the roadway is treated as icy all over, with bridge decks worst.', affected: 0 });
  if (fog) advisories.push({ kind: 'fog', severity: 'warning', message: `Dense fog: speeds cut ${Math.round(FOG_SPEED_LOSS * 100)}% and turn guidance assumes reduced sight distance.`, affected: 0 });
  if (heat) advisories.push({ kind: 'heat', severity: 'warning', message: `Extreme heat: on-foot time inflated ${Math.round(heat * HEAT_FOOT_SPEED_LOSS * 100)}% for heat stress; vehicle routing unaffected.`, affected: 0 });
  if (advisories.length === 0) {
    advisories.push({ kind: 'clear', severity: 'nominal', message: 'No weather-driven roadway restrictions: dry pavement, no standing water, no active warnings.', affected: 0 });
  }

  return {
    status: weather.status,
    observed_at: weather.observed_at,
    fetched_at: new Date().toISOString(),
    weather_code: weather.weather_code,
    weather_label: WMO_LABELS[weather.weather_code] ?? 'unknown',
    temperature_f: Math.round(weather.temperature_f * 10) / 10,
    rain_rate_mm_h: Math.round(rainRate * 100) / 100,
    rain_1h_mm: Math.round(rain1h * 100) / 100,
    rain_6h_mm: Math.round(rain6h * 100) / 100,
    rain_24h_mm: Math.round(rain24h * 100) / 100,
    rain_6h_forecast_mm: Math.round((weather.rain_6h_forecast_mm ?? 0) * 100) / 100,
    peak_rate_6h_mm_h: Math.round(peak * 100) / 100,
    intensity_mm_h: Math.round(intensity * 100) / 100,
    wind_speed_mph: Math.round((weather.wind_speed_mph ?? 0) * 10) / 10,
    wind_gust_mph: Math.round(gust * 10) / 10,
    river_surface_m: gageSurfaceM,
    wetness: Math.round(wetness * 1000) / 1000,
    alerts,
    ponding_depth_m: Object.fromEntries(Object.entries(ponding).map(([id, depth]) => [id, depth])),
    ponded_nodes: Object.keys(visible).map(Number).sort((a, b) => a - b),
    wetted_nodes: Object.keys(ponding).length,
    deepest_ponding_m: deepest,
    impassable,
    speed_factors: {
      vehicle: Math.round(vehicleFactor * 1000) / 1000,
      ems: Math.round(Math.min(1, vehicleFactor * 1.08) * 1000) / 1000,
      foot: Math.round(footFactor * 1000) / 1000,
      bridge_vehicle: Math.round(vehicleBridge * 1000) / 1000,
      bridge_ems: Math.round(Math.min(1, vehicleBridge * 1.08) * 1000) / 1000,
      bridge_foot: Math.round(footBridge * 1000) / 1000,
      bridge_wind_loss: Math.round(windBridge * 1000) / 1000,
      street_wind_loss: Math.round(windStreet * 1000) / 1000,
    },
    advisories,
    sources: { weather: weather.source, alerts: 'NWS api.weather.gov active alerts' },
    travel_mode: '',
    clearance_m: null,
    speed_factor: 1,
    bridge_speed_factor: 1,
    impassable_nodes: [],
  };
}

/**
 * Live roadway for the district: read the two public services directly, then
 * build the model. The API relay is the fallback for networks that block
 * third-party hosts, mirroring how the observations panel already works.
 */
export async function fetchConditions(city: CityData, gageSurfaceM: number | null, backendOnline: boolean): Promise<RoadConditions> {
  const [weather, alerts] = await Promise.all([
    fetchWeather(city.center_lat, city.center_lon),
    fetchAlerts(city.center_lat, city.center_lon),
  ]);
  if (weather.status === 'unavailable' && alerts.length === 0 && backendOnline) {
    try {
      const { api } = await import('./api');
      return (await api.conditions()).conditions;
    } catch {
      /* fall through to the unavailable report */
    }
  }
  return buildConditions(city.nodes, weather, alerts, gageSurfaceM);
}

/** Per-mode roadway factors, mirroring `conditions.mode_roadway`. */
export interface Roadway {
  speedFactor: number;
  bridgeFactor: number;
  clearanceM: number;
  ponding: Record<number, number>;
  impassable: Set<number> | null;
  pondingDelayS: number;
  pondingPenaltyS: number;
  delayExponent: number;
  costExponent: number;
  visibleM: number;
}

export const NEUTRAL_ROADWAY: Roadway = {
  speedFactor: 1, bridgeFactor: 1, clearanceM: Number.POSITIVE_INFINITY, ponding: {},
  impassable: null, pondingDelayS: 0, pondingPenaltyS: 0,
  delayExponent: PONDING_DELAY_EXPONENT, costExponent: PONDING_COST_EXPONENT, visibleM: PONDING_VISIBLE_M,
};

export function modeRoadway(conditions: RoadConditions | null | undefined, travelMode: string): Roadway {
  if (!conditions) return NEUTRAL_ROADWAY;
  const factors = conditions.speed_factors ?? {};
  const mode = travelMode in MODE_CLEARANCE_M ? travelMode : 'vehicle';
  const speedFactor = factors[mode] ?? 1;
  const bridgeFactor = Math.min(speedFactor, factors[`bridge_${mode}`] ?? speedFactor);
  const ponding: Record<number, number> = {};
  Object.entries(conditions.ponding_depth_m ?? {}).forEach(([id, depth]) => { ponding[Number(id)] = depth; });
  return {
    speedFactor,
    bridgeFactor,
    clearanceM: MODE_CLEARANCE_M[mode],
    ponding,
    impassable: new Set((conditions.impassable ?? {})[mode] ?? []),
    pondingDelayS: PONDING_DELAY_S,
    pondingPenaltyS: PONDING_COST_S,
    delayExponent: PONDING_DELAY_EXPONENT,
    costExponent: PONDING_COST_EXPONENT,
    visibleM: PONDING_VISIBLE_M,
  };
}

/** Route-request payload for the API, from a built model. */
export function conditionInput(conditions: RoadConditions | null, gageSurfaceM: number | null) {
  if (!conditions) return null;
  return {
    weather: {
      status: conditions.status,
      observed_at: conditions.observed_at,
      rain_rate_mm_h: conditions.rain_rate_mm_h,
      rain_1h_mm: conditions.rain_1h_mm,
      rain_6h_mm: conditions.rain_6h_mm,
      rain_24h_mm: conditions.rain_24h_mm,
      rain_6h_forecast_mm: conditions.rain_6h_forecast_mm,
      peak_rate_6h_mm_h: conditions.peak_rate_6h_mm_h,
      wind_speed_mph: conditions.wind_speed_mph,
      wind_gust_mph: conditions.wind_gust_mph,
      temperature_f: conditions.temperature_f,
      weather_code: conditions.weather_code,
      source: conditions.sources?.weather ?? '',
    },
    alerts: conditions.alerts ?? [],
    gage_surface_m: gageSurfaceM,
  };
}
