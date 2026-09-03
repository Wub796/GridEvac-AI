import axios from 'axios';
import type { CityData, RouteResponse, SimulationParams } from './types';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

export const api = {
  /** Full static city graph - nodes, edges, substations */
  getCityData: async (): Promise<CityData> => {
    const { data } = await http.get<CityData>('/api/city');
    return data;
  },

  /** Compute optimal evacuation route with given simulation state */
  calculateRoute: async (params: SimulationParams): Promise<RouteResponse> => {
    const { data } = await http.post<RouteResponse>('/api/calculate-route', {
      flood_level:        params.flood_level,
      failed_substations: params.failed_substations,
      origin_node:        params.origin_node,
    });
    return data;
  },

  /** Flooded node IDs for a given flood level (lightweight) */
  getFloodZones: async (floodLevel: number): Promise<{ flooded_nodes: number[]; flood_threshold_m: number }> => {
    const { data } = await http.get('/api/flood-zones', { params: { flood_level: floodLevel } });
    return data;
  },

  /** Backend health check */
  health: async (): Promise<boolean> => {
    try {
      await http.get('/health');
      return true;
    } catch {
      return false;
    }
  },
};
