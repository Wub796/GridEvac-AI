import type {
  CityData,
  ConditionsResponse,
  CorridorComparisonResponse,
  IsochroneResponse,
  ObservationsResponse,
  RouteResponse,
  SimulationParams,
  TravelMode,
  TriggerPointsResponse,
} from './types';

// A trailing slash in the configured origin would produce `//api/city`, which
// some hosts reject, so normalize it away here.
const BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? '').trim().replace(/\/+$/, '');
const DEFAULT_TIMEOUT = 20_000;

const LOOPBACK = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i;

/**
 * Whether this build can actually reach a routing API. A loopback URL baked
 * into a deployed page points at the visitor's own machine, so the app treats
 * it as absent and never fires requests that can only fail.
 */
export const apiConfigured: boolean = (() => {
  if (!BASE_URL) return false;
  if (typeof window === 'undefined') return true;
  return !LOOPBACK.test(BASE_URL.trim()) || LOOPBACK.test(window.location.origin);
})();

/** Scenario query parameters shared by the GET analysis endpoints. */
export interface ScenarioQuery {
  origin: number;
  floodLevel: number;
  failed: number[];
  mode: TravelMode;
  evacuees: number;
  closures: Array<[number, number]>;
  useLiveConditions?: boolean;
}

const closureParam = (closures: Array<[number, number]>) => closures.map(([u, v]) => `${u}-${v}`).join(',');

const scenarioParams = (query: ScenarioQuery) => ({
  origin: query.origin,
  flood_level: query.floodLevel,
  failed_substations: query.failed.join(','),
  travel_mode: query.mode,
  evacuees: query.evacuees,
  closed_edges: closureParam(query.closures),
  use_live_conditions: query.useLiveConditions ?? false,
});

type QueryValue = string | number | boolean;

const queryString = (params: Record<string, QueryValue>) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => search.set(key, String(value)));
  return search.toString();
};

type RequestOptions = {
  method?: 'GET' | 'POST';
  params?: Record<string, QueryValue>;
  body?: unknown;
  timeout?: number;
};

/** One fetch wrapper for every endpoint: abortable timeout, JSON in and out, throws on non-2xx. */
async function request<T>(path: string, { method = 'GET', params, body, timeout = DEFAULT_TIMEOUT }: RequestOptions = {}): Promise<T> {
  const url = `${BASE_URL}${path}${params ? `?${queryString(params)}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  /** Full static city graph: junctions, curved streets, footprints, utilities, flood model. */
  getCityData: async (): Promise<CityData> => request<CityData>('/api/city'),

  /** Least-cost evacuation route for the current scenario. */
  calculateRoute: async (params: SimulationParams): Promise<RouteResponse> =>
    request<RouteResponse>('/api/calculate-route', {
      method: 'POST',
      body: {
        flood_level: params.flood_level,
        failed_substations: params.failed_substations,
        origin_node: params.origin_node,
        travel_mode: params.travel_mode ?? 'vehicle',
        evacuees: params.evacuees ?? 0,
        destination: params.destination ?? null,
        destination_node: params.destination_node ?? null,
        destination_label: params.destination_label ?? '',
        use_live_conditions: params.use_live_conditions ?? false,
        conditions: params.conditions ?? null,
        closed_edges: params.closed_edges ?? [],
      },
    }),

  /** Live roadway conditions: rainfall ponding, speed factors, active warnings. */
  conditions: async (): Promise<ConditionsResponse> => request<ConditionsResponse>('/api/conditions', { timeout: 15_000 }),

  /** Every perimeter exit corridor from one origin, safest first. */
  compareCorridors: async (query: ScenarioQuery): Promise<CorridorComparisonResponse> =>
    request<CorridorComparisonResponse>('/api/compare-corridors', { params: scenarioParams(query) }),

  /** Street-network reachability rings from an origin. */
  isochrone: async (query: ScenarioQuery, minutes: number[]): Promise<IsochroneResponse> =>
    request<IsochroneResponse>('/api/isochrone', { params: { ...scenarioParams(query), minutes: minutes.join(',') } }),

  /** Water surface at which each exit and shelter becomes unreachable. */
  triggerPoints: async (origin: number, mode: TravelMode, closures: Array<[number, number]>): Promise<TriggerPointsResponse> =>
    request<TriggerPointsResponse>('/api/trigger-points', {
      params: { origin, travel_mode: mode, closed_edges: closureParam(closures) },
    }),

  /** Live gage and temperature observations relayed by the API. */
  observations: async (): Promise<ObservationsResponse> => request<ObservationsResponse>('/api/observations', { timeout: 12_000 }),

  health: async (): Promise<boolean> => {
    try {
      await request('/health', { timeout: 4_000 });
      return true;
    } catch {
      return false;
    }
  },
};
