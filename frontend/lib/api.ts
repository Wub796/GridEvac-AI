import axios from 'axios';
import type {
  CityData,
  CorridorComparisonResponse,
  IsochroneResponse,
  ObservationsResponse,
  RouteResponse,
  SimulationParams,
  TravelMode,
  TriggerPointsResponse,
} from './types';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' },
});

/** Scenario query parameters shared by the GET analysis endpoints. */
export interface ScenarioQuery {
  origin: number;
  floodLevel: number;
  failed: number[];
  mode: TravelMode;
  evacuees: number;
  closures: Array<[number, number]>;
}

const closureParam = (closures: Array<[number, number]>) => closures.map(([u, v]) => `${u}-${v}`).join(',');

const scenarioParams = (query: ScenarioQuery) => ({
  origin: query.origin,
  flood_level: query.floodLevel,
  failed_substations: query.failed.join(','),
  travel_mode: query.mode,
  evacuees: query.evacuees,
  closed_edges: closureParam(query.closures),
});

export const api = {
  /** Full static city graph: junctions, curved streets, footprints, utilities, flood model. */
  getCityData: async (): Promise<CityData> => {
    const { data } = await http.get<CityData>('/api/city');
    return data;
  },

  /** Least-cost evacuation route for the current scenario. */
  calculateRoute: async (params: SimulationParams): Promise<RouteResponse> => {
    const { data } = await http.post<RouteResponse>('/api/calculate-route', {
      flood_level: params.flood_level,
      failed_substations: params.failed_substations,
      origin_node: params.origin_node,
      travel_mode: params.travel_mode ?? 'vehicle',
      evacuees: params.evacuees ?? 0,
      destination: params.destination ?? null,
      closed_edges: params.closed_edges ?? [],
    });
    return data;
  },

  /** Every perimeter exit corridor from one origin, safest first. */
  compareCorridors: async (query: ScenarioQuery): Promise<CorridorComparisonResponse> => {
    const { data } = await http.get<CorridorComparisonResponse>('/api/compare-corridors', { params: scenarioParams(query) });
    return data;
  },

  /** Street-network reachability rings from an origin. */
  isochrone: async (query: ScenarioQuery, minutes: number[]): Promise<IsochroneResponse> => {
    const { data } = await http.get<IsochroneResponse>('/api/isochrone', { params: { ...scenarioParams(query), minutes: minutes.join(',') } });
    return data;
  },

  /** Water surface at which each exit and shelter becomes unreachable. */
  triggerPoints: async (origin: number, mode: TravelMode, closures: Array<[number, number]>): Promise<TriggerPointsResponse> => {
    const { data } = await http.get<TriggerPointsResponse>('/api/trigger-points', {
      params: { origin, travel_mode: mode, closed_edges: closureParam(closures) },
    });
    return data;
  },

  /** Live gage and temperature observations relayed by the API. */
  observations: async (): Promise<ObservationsResponse> => {
    const { data } = await http.get<ObservationsResponse>('/api/observations', { timeout: 12_000 });
    return data;
  },

  health: async (): Promise<boolean> => {
    try {
      await http.get('/health', { timeout: 4_000 });
      return true;
    } catch {
      return false;
    }
  },
};
