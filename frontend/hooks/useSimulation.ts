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
  frequencyHistory:      number[];
  gageHistory:           number[];

  // ── GIS Display Options ────────────────────────────────────────────────────
  showBuildings:         boolean;
  showPowerLines:        boolean;
  showSubstations:       boolean;
  showIntersections:     boolean;
  flyToNodeId:           number | null;
  flyToCoords:           { lon: number, lat: number, elev: number, heading?: number, pitch?: number } | null;
  mapFilterMode:         'nominal' | 'radar' | 'thermal';
  activeSection:         'briefing' | 'map' | 'audit';

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
  setShowBuildings:     (b: boolean) => void;
  setShowPowerLines:    (b: boolean) => void;
  setShowSubstations:   (b: boolean) => void;
  setShowIntersections: (b: boolean) => void;
  setFlyToNodeId:       (id: number | null) => void;
  setFlyToCoords:       (coords: { lon: number, lat: number, elev: number, heading?: number, pitch?: number } | null) => void;
  setMapFilterMode:     (mode: 'nominal' | 'radar' | 'thermal') => void;
  applyScenario:        (preset: 'flood' | 'cascade' | 'heatwave' | 'clear') => void;
  setActiveSection:     (s: 'briefing' | 'map' | 'audit') => void;
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
  frequencyHistory:      Array(12).fill(60.00),
  gageHistory:           Array(12).fill(4.5),
  liveLogs:              [
    "GridEvac AI: Core monitoring console initialized.",
    "Grid status: Nominal. Awaiting simulation parameter changes."
  ],

  showBuildings:         true,
  showPowerLines:        true,
  showSubstations:       true,
  showIntersections:     true,
  flyToNodeId:           null,
  flyToCoords:           null,
  mapFilterMode:         'nominal',
  activeSection:         'briefing',

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

    // Auto-relocate origin if it is now flooded
    const { originNode, cityData } = get();
    if (cityData) {
      const currentOrigin = cityData.nodes.find(n => n.id === originNode);
      if (currentOrigin && currentOrigin.elevation <= v * 1.7) {
        let bestNodeId = -1;
        let minDistance = Number.POSITIVE_INFINITY;

        cityData.nodes.forEach(node => {
          // Skip if flooded or is an exit node
          const isExit = [14, 120, 164, 210].includes(node.id);
          const isFlooded = node.elevation <= v * 1.7;
          if (!isFlooded && !isExit) {
            const dist = Math.hypot(node.lat - currentOrigin.lat, node.lon - currentOrigin.lon);
            if (dist < minDistance) {
              minDistance = dist;
              bestNodeId = node.id;
            }
          }
        });

        if (bestNodeId !== -1) {
          set({ originNode: bestNodeId });
          get().addLog(`Navigation Alert: Origin Node #${originNode} flooded! Automatically relocated to closest dry Node #${bestNodeId}.`);
        } else {
          get().addLog(`Navigation Alert: Origin Node #${originNode} flooded! No dry intersections remaining on grid.`);
        }
      }
    }

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
    const { route, substationLoads, gridFrequency, cascadedSubstations, failedSubstations, cityData } = get();
    if (!route || Object.keys(substationLoads).length === 0) return;

    // 1. Fluctuates loads slightly (±0.2 to ±1.2 MW) for active substations
    const nextLoads = { ...substationLoads };
    const nextOverloaded: number[] = [];

    Object.keys(nextLoads).forEach((key) => {
      const id = parseInt(key, 10);
      const isFailed = failedSubstations.includes(id) || cascadedSubstations.includes(id);
      if (!isFailed) {
        const delta = (Math.random() - 0.5) * 1.8;
        nextLoads[id] = Math.max(10.0, parseFloat((nextLoads[id] + delta).toFixed(1)));

        // Dynamic overload check against substation capacity
        const sub = cityData?.substations.find(s => s.id === id);
        if (sub && nextLoads[id] > sub.capacity_mw) {
          nextOverloaded.push(id);
        }
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

    set((state) => ({
      substationLoads: nextLoads,
      overloadedSubstations: nextOverloaded,
      gridFrequency: nextFreq,
      usgsGageHeight: parseFloat(nextGage.toFixed(2)),
      surfaceTemp: parseFloat(nextTemp.toFixed(1)),
      frequencyHistory: [...state.frequencyHistory.slice(1), nextFreq],
      gageHistory: [...state.gageHistory.slice(1), parseFloat(nextGage.toFixed(2))]
    }));

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
  },

  setShowBuildings:     (b) => set({ showBuildings: b }),
  setShowPowerLines:    (b) => set({ showPowerLines: b }),
  setShowSubstations:   (b) => set({ showSubstations: b }),
  setShowIntersections: (b) => set({ showIntersections: b }),
  setFlyToNodeId:       (id) => set({ flyToNodeId: id }),

  applyScenario: (preset) => {
    const { addLog, calculateRoute } = get();
    if (preset === 'flood') {
      set({
        floodLevel: 8.5,
        failedSubstations: [],
        originNode: 72,
      });
      addLog("Scenario Loaded: Bayou Flash Flood Overflow. Water level set to 8.5m. Origin snapped to Node #72.");
    } else if (preset === 'cascade') {
      set({
        floodLevel: 2.0,
        failedSubstations: [0, 4],
        originNode: 50,
      });
      addLog("Scenario Loaded: SCADA Cascade Failure. Substations 0 & 4 offline. Origin snapped to Node #50.");
    } else if (preset === 'heatwave') {
      set({
        floodLevel: 0.0,
        failedSubstations: [1, 3],
        originNode: 105,
      });
      addLog("Scenario Loaded: Grid Heatwave Strain. Substations 1 & 3 offline. Origin snapped to Node #105.");
    } else if (preset === 'clear') {
      set({
        floodLevel: 0.0,
        failedSubstations: [],
        originNode: 0,
      });
      addLog("Scenario Loaded: All Clear. Parameters reset to nominal safety baseline. Origin snapped to Node #0.");
    }
    calculateRoute();
  },

  setActiveSection: (s) => set({ activeSection: s }),
  setFlyToCoords: (coords) => set({ flyToCoords: coords }),
  setMapFilterMode: (mode) => set({ mapFilterMode: mode })
}));
