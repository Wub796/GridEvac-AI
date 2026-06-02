/**
 * useSimulation.ts — Zustand store for GridEvac AI simulation state
 * Houston, TX edition
 */
import { create } from 'zustand';
import { api } from '@/lib/api';
import type { CityData, RouteResponse, RiskLevel } from '@/lib/types';

interface SimulationStore {
  // ── Simulation parameters ──────────────────────────────────────────────────
  floodLevel:        number;           // 0–10
  failedSubstations: number[];         // substation IDs that are offline
  originNode:        number;           // 0–99
  destNode:          number;           // 0–99

  // ── Derived / async state ──────────────────────────────────────────────────
  cityData:      CityData    | null;
  route:         RouteResponse | null;
  isLoading:     boolean;
  backendOnline: boolean;
  error:         string | null;

  // ── Actions ────────────────────────────────────────────────────────────────
  setFloodLevel:        (v: number)  => void;
  toggleSubstation:     (id: number) => void;
  setOriginNode:        (id: number) => void;
  setDestNode:          (id: number) => void;
  fetchCityData:        () => Promise<void>;
  calculateRoute:       () => Promise<void>;
  clearRoute:           () => void;
  checkBackend:         () => Promise<void>;
}

export const useSimulationStore = create<SimulationStore>((set, get) => ({
  // defaults — node 0 = SW corner (near Buffalo Bayou, flood-prone)
  //            node 99 = NE corner (higher ground)
  floodLevel:        0,
  failedSubstations: [],
  originNode:        0,
  destNode:          99,
  cityData:          null,
  route:             null,
  isLoading:         false,
  backendOnline:     false,
  error:             null,

  setFloodLevel: (v) => set({ floodLevel: v }),

  toggleSubstation: (id) => {
    const { failedSubstations } = get();
    set({
      failedSubstations: failedSubstations.includes(id)
        ? failedSubstations.filter((s) => s !== id)
        : [...failedSubstations, id],
    });
  },

  setOriginNode: (id) => set({ originNode: id }),
  setDestNode:   (id) => set({ destNode:   id }),

  clearRoute: () => set({ route: null, error: null }),

  checkBackend: async () => {
    const online = await api.health();
    set({ backendOnline: online });
  },

  fetchCityData: async () => {
    set({ isLoading: true, error: null });
    try {
      const cityData = await api.getCityData();
      set({ cityData, isLoading: false, backendOnline: true });
    } catch (e: any) {
      set({
        isLoading:     false,
        backendOnline: false,
        error:         'Cannot reach backend. Make sure the FastAPI server is running on port 8000.',
      });
    }
  },

  calculateRoute: async () => {
    const { floodLevel, failedSubstations, originNode, destNode } = get();
    set({ isLoading: true, error: null });
    try {
      const route = await api.calculateRoute({
        flood_level:        floodLevel,
        failed_substations: failedSubstations,
        origin_node:        originNode,
        dest_node:          destNode,
      });
      set({ route, isLoading: false });
    } catch (e: any) {
      set({
        isLoading: false,
        error: 'Route calculation failed. Check backend connection.',
      });
    }
  },
}));
