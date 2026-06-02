/**
 * useSimulation.ts — Zustand store for GridEvac AI simulation state
 * Houston, TX edition (with live grid load flow and telemetry logging)
 */
import { create } from 'zustand';
import { api } from '@/lib/api';
import type { CityData, RouteResponse } from '@/lib/types';

interface SimulationStore {
  // ── Simulation parameters ──────────────────────────────────────────────────
  floodLevel:        number;           // 0–10
  failedSubstations: number[];         // substation IDs that are manually offline
  originNode:        number;           // 0–224
  destNode:          number;           // Safest exit node (returned from backend)

  // ── Live Grid Telemetry ────────────────────────────────────────────────────
  gridFrequency:         number;
  substationLoads:       Record<number, number>;
  overloadedSubstations: number[];
  cascadedSubstations:   number[];
  voltageReadings:       Record<number, number>;
  liveLogs:              string[];
  usgsGageHeight:        number;
  surfaceTemp:           number;

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
  fetchCityData:        () => Promise<void>;
  calculateRoute:       () => Promise<void>;
  clearRoute:           () => void;
  checkBackend:         () => Promise<void>;
  addLog:               (msg: string) => void;
  triggerLiveTick:      () => void;
}

export const useSimulationStore = create<SimulationStore>((set, get) => ({
  floodLevel:        0,
  failedSubstations: [],
  originNode:        0,
  destNode:          14,
  
  gridFrequency:         60.00,
  substationLoads:       {},
  overloadedSubstations: [],
  cascadedSubstations:   [],
  voltageReadings:       {},
  usgsGageHeight:        4.5,
  surfaceTemp:           87.5,
  liveLogs:              [
    "GridEvac AI: Core monitoring console initialized.",
    "Grid status: Nominal. Awaiting simulation parameter changes."
  ],

  cityData:          null,
  route:             null,
  isLoading:         false,
  backendOnline:     false,
  error:             null,

  addLog: (msg) => {
    const timestamp = new Date().toLocaleTimeString();
    set((state) => ({
      liveLogs: [`[${timestamp}] ${msg}`, ...state.liveLogs.slice(0, 49)]
    }));
  },

  setFloodLevel: (v) => {
    set({ floodLevel: v });
    get().addLog(`Simulation: Flood slider adjusted to level ${v.toFixed(1)}`);
    get().calculateRoute();
  },

  toggleSubstation: (id) => {
    const { failedSubstations, cityData } = get();
    const subName = cityData?.substations.find((s) => s.id === id)?.name || `Substation #${id}`;
    const nextFailed = failedSubstations.includes(id)
      ? failedSubstations.filter((s) => s !== id)
      : [...failedSubstations, id];
    
    set({ failedSubstations: nextFailed });
    
    const statusStr = failedSubstations.includes(id) ? "ONLINE" : "OFFLINE (Manual Override)";
    get().addLog(`Grid Alert: ${subName} switched ${statusStr}`);
    
    // Automatically recalculate route and load flow on toggle
    get().calculateRoute();
  },

  setOriginNode: (id) => {
    set({ originNode: id });
    get().addLog(`Navigation: Origin waypoint updated to Node #${id}`);
    get().calculateRoute();
  },

  clearRoute: () => set({ route: null, error: null }),

  checkBackend: async () => {
    const online = await api.health();
    set({ backendOnline: online });
  },

  fetchCityData: async () => {
    set({ isLoading: true, error: null });
    try {
      const cityData = await api.getCityData();
      
      // Seed default substation loads
      const defaultLoads: Record<number, number> = {};
      cityData.substations.forEach((s) => {
        defaultLoads[s.id] = s.base_load_mw;
      });

      set({ 
        cityData, 
        substationLoads: defaultLoads,
        isLoading: false, 
        backendOnline: true 
      });
      get().addLog("Database: Successfully loaded Houston downtown grid layout.");
    } catch (e: any) {
      set({
        isLoading:     false,
        backendOnline: false,
        error:         'Cannot reach backend. Make sure the API server is online.',
      });
      get().addLog("Error: Failed to connect to GridEvac AI API server.");
    }
  },

  calculateRoute: async () => {
    const { floodLevel, failedSubstations, originNode } = get();
    set({ isLoading: true, error: null });
    try {
      const route = await api.calculateRoute({
        flood_level:        floodLevel,
        failed_substations: failedSubstations,
        origin_node:        originNode,
      });

      // Update telemetry variables from calculations
      const loadLogs: string[] = [];
      
      // Detect newly overloaded/cascaded substations for logs
      if (route.overloaded_substations.length > get().overloadedSubstations.length) {
        route.overloaded_substations.forEach(id => {
          if (!get().overloadedSubstations.includes(id)) {
            const name = get().cityData?.substations.find(s => s.id === id)?.name || `Sub #${id}`;
            loadLogs.push(`Overload warning: ${name} is drawing excessive current!`);
          }
        });
      }
      
      if (route.cascaded_substations.length > get().cascadedSubstations.length) {
        route.cascaded_substations.forEach(id => {
          if (!get().cascadedSubstations.includes(id)) {
            const name = get().cityData?.substations.find(s => s.id === id)?.name || `Sub #${id}`;
            loadLogs.push(`CRITICAL: Cascading failure tripped! ${name} went offline.`);
          }
        });
      }

      set({ 
        route, 
        destNode: route.dest_node,
        gridFrequency: route.grid_frequency,
        substationLoads: route.substation_loads,
        overloadedSubstations: route.overloaded_substations,
        cascadedSubstations: route.cascaded_substations,
        voltageReadings: route.voltage_readings,
        usgsGageHeight: route.usgs_gage_height,
        surfaceTemp: route.surface_temp,
        isLoading: false 
      });

      // Write logs
      if (loadLogs.length > 0) {
        loadLogs.forEach(log => get().addLog(log));
      } else {
        get().addLog(`Evacuation: Computed new optimal safety route (${route.path.length} nodes).`);
      }
    } catch (e: any) {
      set({
        isLoading: false,
        error: 'Route calculation failed. Check backend connection.',
      });
      get().addLog("Error: Real-time pathfinding computation failed.");
    }
  },

  // Fluctuate telemetry values dynamically to show live monitoring
  triggerLiveTick: () => {
    const { route, substationLoads, gridFrequency, cascadedSubstations, failedSubstations } = get();
    if (!route || Object.keys(substationLoads).length === 0) return;

    // 1. Fluctuates loads slightly (±0.2 to ±1.2 MW) for active substations
    const nextLoads = { ...substationLoads };
    Object.keys(nextLoads).forEach((key) => {
      const id = parseInt(key, 10);
      const isFailed = failedSubstations.includes(id) || cascadedSubstations.includes(id);
      if (!isFailed) {
        const delta = (Math.random() - 0.5) * 1.8;
        nextLoads[id] = Math.max(10.0, parseFloat((nextLoads[id] + delta).toFixed(1)));
      }
    });

    // 2. Fluctuate grid frequency slightly
    const totalFailed = failedSubstations.length + cascadedSubstations.length;
    let nextFreq = gridFrequency;
    if (totalFailed < 5) {
      const deltaFreq = (Math.random() - 0.5) * 0.02;
      nextFreq = parseFloat((gridFrequency + deltaFreq).toFixed(2));
      // clamp around the load-induced frequency level
      const baseExpected = 60.0 - 0.05 * totalFailed;
      nextFreq = Math.max(baseExpected - 0.15, Math.min(baseExpected + 0.05, nextFreq));
    }

    // Fluctuates USGS water height and surface temp
    const nextGage = Math.max(1.0, get().usgsGageHeight + (Math.random() - 0.5) * 0.1);
    const nextTemp = Math.max(50.0, get().surfaceTemp + (Math.random() - 0.5) * 0.15);

    set({
      substationLoads: nextLoads,
      gridFrequency: nextFreq,
      usgsGageHeight: parseFloat(nextGage.toFixed(2)),
      surfaceTemp: parseFloat(nextTemp.toFixed(1))
    });

    // 3. Occasionally post a sensor reading update in log
    if (Math.random() < 0.25) {
      const sensors = [
        "Sensor #12 (Main St Bayou): flood clearance level stable.",
        `Frequency: grid operating at ${nextFreq.toFixed(2)} Hz.`,
        "Zonal Scan: dynamic risk envelope nominal.",
        "System: processing telemetry payload from Houston Grid SCADA."
      ];
      const selected = sensors[Math.floor(Math.random() * sensors.length)];
      get().addLog(selected);
    }
  }
}));
