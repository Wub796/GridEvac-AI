/**
 * useSimulation.ts — Zustand store for GridEvac AI simulation state
 * Houston, TX edition (with live grid load flow and telemetry logging)
 */
import { create } from 'zustand';
import { api } from '@/lib/api';
import type { CityData, RouteResponse, NodeData, EdgeData, SubstationData } from '@/lib/types';

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
    const nextFloodLevel = Math.max(0, Math.min(10, v));
    set({ floodLevel: nextFloodLevel });
    get().addLog(`Simulation: Flood slider adjusted to level ${nextFloodLevel.toFixed(1)}`);

    // Auto-relocate origin if it is now flooded
    const { originNode, cityData } = get();
    if (cityData) {
      const currentOrigin = cityData.nodes.find(n => n.id === originNode);
      if (currentOrigin && currentOrigin.elevation <= nextFloodLevel * 1.7) {
        let bestNodeId = -1;
        let minDistance = Number.POSITIVE_INFINITY;

        cityData.nodes.forEach(node => {
          // Skip if flooded or is an exit node
          const isExit = [14, 120, 164, 210].includes(node.id);
          const isFlooded = node.elevation <= nextFloodLevel * 1.7;
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
      // Offline fallback grid generation
      const mockData = generateMockCityData();
      const defaultLoads: Record<number, number> = {};
      mockData.substations.forEach((s) => {
        defaultLoads[s.id] = s.base_load_mw;
      });
      
      set({
        cityData: mockData,
        substationLoads: defaultLoads,
        isLoading: false,
        backendOnline: false,
        error: null // clear error so UI continues seamlessly in offline mode
      });
      get().addLog("Offline Fallback: Loaded client-side grid layout (FastAPI server unreachable).");
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
      // Offline fallback routing
      const cityData = get().cityData;
      if (cityData) {
        const route = calculateMockRoute(cityData, floodLevel, failedSubstations, originNode);
        
        const loadLogs: string[] = [];
        if (route.overloaded_substations.length > get().overloadedSubstations.length) {
          route.overloaded_substations.forEach(id => {
            if (!get().overloadedSubstations.includes(id)) {
              const name = cityData.substations.find(s => s.id === id)?.name || `Sub #${id}`;
              loadLogs.push(`Overload warning: ${name} is drawing excessive current!`);
            }
          });
        }
        if (route.cascaded_substations.length > get().cascadedSubstations.length) {
          route.cascaded_substations.forEach(id => {
            if (!get().cascadedSubstations.includes(id)) {
              const name = cityData.substations.find(s => s.id === id)?.name || `Sub #${id}`;
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

        if (loadLogs.length > 0) {
          loadLogs.forEach(log => get().addLog(log));
        } else {
          get().addLog(`Offline Routing: Computed optimal fallback route (${route.path.length} nodes).`);
        }
      } else {
        set({
          isLoading: false,
          error: 'Route calculation failed. Check backend connection.',
        });
        get().addLog("Error: Real-time pathfinding computation failed.");
      }
    }
  },

  // Fluctuate telemetry values dynamically to show live monitoring
  triggerLiveTick: () => {
    const { route, substationLoads, gridFrequency, cascadedSubstations, failedSubstations, cityData } = get();
    if (!route || Object.keys(substationLoads).length === 0) return;

    // 1. Fluctuates loads slightly (±0.2 to ±1.2 MW) for active substations
    const nextLoads = { ...substationLoads };
    const nextOverloaded = [...get().overloadedSubstations];

    Object.keys(nextLoads).forEach((key) => {
      const id = parseInt(key, 10);
      const isFailed = failedSubstations.includes(id) || cascadedSubstations.includes(id);
      if (!isFailed) {
        const delta = (Math.random() - 0.5) * 1.8;
        nextLoads[id] = Math.max(10.0, parseFloat((nextLoads[id] + delta).toFixed(1)));

        // Dynamic overload check against substation capacity
        const sub = cityData?.substations.find(s => s.id === id);
        if (sub && nextLoads[id] > sub.capacity_mw) {
          if (!nextOverloaded.includes(id)) nextOverloaded.push(id);
        } else {
          const index = nextOverloaded.indexOf(id);
          if (index !== -1) nextOverloaded.splice(index, 1);
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

// ─────────────────────────────────────────────────────────────────────────────
// Client-side Fallbacks for Offline Mode
// ─────────────────────────────────────────────────────────────────────────────

const SUBSTATION_DEFS = [
  { id: 0, node: 32,  name: "Third Ward Substation",     radius: 2.8, capacity_mw: 150.0, base_load_mw: 90.0 },
  { id: 1, node: 68,  name: "Montrose Substation",       radius: 3.2, capacity_mw: 200.0, base_load_mw: 140.0 },
  { id: 2, node: 112, name: "Downtown Loop Substation",  radius: 2.5, capacity_mw: 250.0, base_load_mw: 195.0 },
  { id: 3, node: 154, name: "Buffalo Bayou Substation",  radius: 3.0, capacity_mw: 180.0, base_load_mw: 110.0 },
  { id: 4, node: 192, name: "East Houston Substation",   radius: 2.9, capacity_mw: 160.0, base_load_mw: 105.0 },
];

const TRANSMISSION_LINKS = [
  { id: 0, from_sub: 0, to_sub: 2 },
  { id: 1, from_sub: 1, to_sub: 2 },
  { id: 2, from_sub: 3, to_sub: 2 },
  { id: 3, from_sub: 4, to_sub: 2 },
  { id: 4, from_sub: 0, to_sub: 1 },
  { id: 5, from_sub: 3, to_sub: 4 },
];

function generateMockCityData(): CityData {
  const CENTER_LAT = 29.7700;
  const CENTER_LON = -95.3800;
  const GRID_ROWS = 15;
  const GRID_COLS = 15;
  const LAT_STEP = 0.0070;
  const LON_STEP = 0.0080;
  const BASE_ELEV = 9.0;
  const ROW_RISE = 0.5;
  const COL_RISE = 0.6;
  const NOISE_AMP = 0.8;

  const nodes: NodeData[] = [];
  const edges: EdgeData[] = [];

  const nodeId = (r: number, c: number) => r * GRID_COLS + c;

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const nid = nodeId(r, c);
      const lat = CENTER_LAT + (r - GRID_ROWS / 2.0) * LAT_STEP;
      const lon = CENTER_LON + (c - GRID_COLS / 2.0) * LON_STEP;
      const elev = BASE_ELEV + r * ROW_RISE + (GRID_COLS - 1 - c) * COL_RISE + NOISE_AMP * (Math.sin(r * 1.4 + c * 0.9) + Math.cos(r * 0.7 + c * 1.5)) * 0.5;
      nodes.push({
        id: nid,
        lat,
        lon,
        elevation: Math.max(4.0, elev),
        row: r,
        col: c
      });
    }
  }

  // E-W edges
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS - 1; c++) {
      edges.push({ source: nodeId(r, c), target: nodeId(r, c + 1), weight: 1.0 });
    }
  }
  // N-S edges
  for (let r = 0; r < GRID_ROWS - 1; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      edges.push({ source: nodeId(r, c), target: nodeId(r + 1, c), weight: 1.0 });
    }
  }

  const substations: SubstationData[] = SUBSTATION_DEFS.map((def) => {
    const node = nodes.find(n => n.id === def.node)!;
    const cr = Math.floor(def.node / GRID_COLS);
    const cc = def.node % GRID_COLS;
    const affected_nodes: number[] = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (Math.sqrt((r - cr) ** 2 + (c - cc) ** 2) <= def.radius) {
          affected_nodes.push(r * GRID_COLS + c);
        }
      }
    }
    return {
      ...def,
      lat: node.lat,
      lon: node.lon,
      affected_nodes
    };
  });

  return {
    nodes,
    edges,
    substations,
    transmission_links: TRANSMISSION_LINKS,
    center_lat: CENTER_LAT,
    center_lon: CENTER_LON,
    grid_rows: GRID_ROWS,
    grid_cols: GRID_COLS
  };
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ab_x = bx - ax;
  const ab_y = by - ay;
  const ap_x = px - ax;
  const ap_y = py - ay;
  
  const ab_len_sq = ab_x * ab_x + ab_y * ab_y;
  if (ab_len_sq === 0) {
    return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  }
  
  const t = Math.max(0.0, Math.min(1.0, (ap_x * ab_x + ap_y * ab_y) / ab_len_sq));
  const proj_x = ax + t * ab_x;
  const proj_y = ay + t * ab_y;
  return Math.sqrt((px - proj_x) ** 2 + (py - proj_y) ** 2);
}

function getTransmissionLineEdges(cityData: CityData) {
  const linkEdges: Record<number, [number, number][]> = {};
  const nodesMap: Record<number, NodeData> = {};
  cityData.nodes.forEach(n => { nodesMap[n.id] = n; });

  cityData.transmission_links.forEach(link => {
    const subA = cityData.substations.find(s => s.id === link.from_sub)!;
    const subB = cityData.substations.find(s => s.id === link.to_sub)!;
    
    const nodeA = nodesMap[subA.node];
    const nodeB = nodesMap[subB.node];
    
    const ar = nodeA.row;
    const ac = nodeA.col;
    const br = nodeB.row;
    const bc = nodeB.col;
    
    const under: [number, number][] = [];
    cityData.edges.forEach(e => {
      const nu = nodesMap[e.source];
      const nv = nodesMap[e.target];
      const mr = (nu.row + nv.row) / 2.0;
      const mc = (nu.col + nv.col) / 2.0;
      
      const dist = distanceToSegment(mr, mc, ar, ac, br, bc);
      if (dist <= 1.25) {
        under.push([e.source, e.target]);
      }
    });
    linkEdges[link.id] = under;
  });
  
  return linkEdges;
}

function simulateMockPowerFlow(failedInputs: number[], cityData: CityData) {
  const failed_set = new Set(failedInputs);
  const cascaded_set = new Set<number>();
  
  const substations = cityData.substations.map(s => ({ ...s, current_load: s.base_load_mw }));
  
  const GRID_COLS = 15;
  const nodesMap: Record<number, NodeData> = {};
  cityData.nodes.forEach(n => { nodesMap[n.id] = n; });

  for (let step = 0; step < 5; step++) {
    const active_subs = substations.filter(s => !failed_set.has(s.id) && !cascaded_set.has(s.id));
    const failed_subs = substations.filter(s => failed_set.has(s.id) || cascaded_set.has(s.id));
    
    active_subs.forEach(s => { s.current_load = s.base_load_mw; });
    
    if (active_subs.length === 0) {
      substations.forEach(s => { s.current_load = 0.0; });
      break;
    }
    
    let new_cascade = false;
    failed_subs.forEach(f_sub => {
      const f_load = f_sub.base_load_mw;
      const f_node = nodesMap[f_sub.node];
      const fr = f_node.row;
      const fc = f_node.col;
      
      const weights: number[] = [];
      let total_weight = 0.0;
      active_subs.forEach(a_sub => {
        const a_node = nodesMap[a_sub.node];
        const ar = a_node.row;
        const ac = a_node.col;
        const dist = Math.sqrt((fr - ar) ** 2 + (fc - ac) ** 2);
        const weight = 1.0 / (dist + 0.5);
        weights.push(weight);
        total_weight += weight;
      });
      
      active_subs.forEach((a_sub, idx) => {
        const share = (weights[idx] / total_weight) * f_load;
        a_sub.current_load += share;
      });
    });
    
    active_subs.forEach(a_sub => {
      if (a_sub.current_load > a_sub.capacity_mw * 1.25) {
        cascaded_set.add(a_sub.id);
        new_cascade = true;
      }
    });
    
    if (!new_cascade) break;
  }
  
  const overloaded_ids: number[] = [];
  const blackout_nodes = new Set<number>();
  const substation_loads: Record<number, number> = {};
  
  let total_capacity = 0.0;
  let total_load = 0.0;
  
  substations.forEach(s => {
    const is_failed = failed_set.has(s.id) || cascaded_set.has(s.id);
    if (is_failed) {
      s.current_load = 0.0;
      substation_loads[s.id] = 0.0;
      s.affected_nodes.forEach(nid => blackout_nodes.add(nid));
    } else {
      substation_loads[s.id] = Math.round(s.current_load * 10) / 10;
      total_capacity += s.capacity_mw;
      total_load += s.current_load;
      
      if (s.current_load > s.capacity_mw) {
        overloaded_ids.push(s.id);
        const overload_pct = (s.current_load - s.capacity_mw) / s.capacity_mw;
        const effective_radius = s.radius * (1.0 + 0.6 * overload_pct);
        const cr = Math.floor(s.node / GRID_COLS);
        const cc = s.node % GRID_COLS;
        cityData.nodes.forEach(nd => {
          if (Math.sqrt((nd.row - cr) ** 2 + (nd.col - cc) ** 2) <= effective_radius) {
            blackout_nodes.add(nd.id);
          }
        });
      }
    }
  });
  
  let noise = Math.random() * 0.024 - 0.012;
  let freq = 0.0;
  if (total_capacity > 0) {
    const overload_ratio = total_load / total_capacity;
    if (overload_ratio > 1.0) {
      freq = 60.0 - 1.4 * (overload_ratio - 1.0) - 0.08 * (failed_set.size + cascaded_set.size);
    } else {
      freq = 60.0 - 0.06 * (failed_set.size + cascaded_set.size);
    }
  } else {
    noise = 0.0;
  }
  
  const grid_frequency = freq > 0 ? Math.max(45.0, Math.min(60.1, freq + noise)) : 0.0;
  
  // Voltages
  const voltage_readings: Record<number, number> = {};
  cityData.nodes.forEach(node => {
    if (blackout_nodes.has(node.id)) {
      voltage_readings[node.id] = 0.0;
    } else {
      let voltage = 100.0;
      const nr = node.row;
      const nc = node.col;
      substations.forEach(s => {
        if (overloaded_ids.includes(s.id)) {
          const s_node = nodesMap[s.node];
          const sr = s_node.row;
          const sc = s_node.col;
          const dist = Math.sqrt((nr - sr) ** 2 + (nc - sc) ** 2);
          const overload_pct = (s.current_load - s.capacity_mw) / s.capacity_mw;
          if (dist <= s.radius * 1.5) {
            const drop = 22.0 * overload_pct * (1.0 - (dist / (s.radius * 1.5)));
            voltage -= Math.max(0.0, drop);
          }
        }
      });
      voltage_readings[node.id] = Math.round(Math.max(40.0, Math.min(100.0, voltage)) * 10) / 10;
    }
  });

  // Transmission line states
  const transmission_line_states: Record<number, string> = {};
  cityData.transmission_links.forEach(link => {
    const from_failed = failed_set.has(link.from_sub) || cascaded_set.has(link.from_sub);
    const to_failed = failed_set.has(link.to_sub) || cascaded_set.has(link.to_sub);
    if (from_failed || to_failed) {
      transmission_line_states[link.id] = "dead";
    } else {
      const from_overloaded = overloaded_ids.includes(link.from_sub);
      const to_overloaded = overloaded_ids.includes(link.to_sub);
      if (from_overloaded || to_overloaded) {
        transmission_line_states[link.id] = "overloaded";
      } else {
        transmission_line_states[link.id] = "active";
      }
    }
  });

  return {
    substation_loads,
    overloaded_substations: overloaded_ids,
    cascaded_substations: Array.from(cascaded_set),
    blackout_nodes,
    voltage_readings,
    grid_frequency: Math.round(grid_frequency * 100) / 100,
    transmission_line_states,
  };
}

function calculateMockRoute(
  cityData: CityData,
  floodLevel: number,
  failedSubstations: number[],
  originNode: number
): RouteResponse {
  const flow = simulateMockPowerFlow(failedSubstations, cityData);
  const blackout = flow.blackout_nodes;

  const FLOOD_RISE_PER_LEVEL = 1.7;
  const floodedNodes = cityData.nodes.filter(n => n.elevation <= floodLevel * FLOOD_RISE_PER_LEVEL).map(n => n.id);
  const floodedSet = new Set(floodedNodes);

  if (floodedSet.has(originNode)) {
    return {
      success: false,
      path: [],
      path_coords: [],
      total_nodes: 0,
      flooded_nodes: floodedNodes,
      blackout_nodes: Array.from(blackout),
      blocked_edges: [],
      anomaly_score: 0.99,
      risk_level: "CRITICAL",
      message: "Starting intersection is flooded — choose a higher-ground origin node.",
      dest_node: -1,
      substation_loads: flow.substation_loads,
      overloaded_substations: flow.overloaded_substations,
      cascaded_substations: flow.cascaded_substations,
      grid_frequency: flow.grid_frequency,
      voltage_readings: flow.voltage_readings,
      transmission_line_states: flow.transmission_line_states,
      usgs_gage_height: Math.round((4.2 + floodLevel * 0.9 + Math.random() * 0.2) * 100) / 100,
      surface_temp: Math.round((84.0 + Math.random() * 1.5) * 10) / 10,
      hazard_roads: {}
    };
  }

  const linkEdges = getTransmissionLineEdges(cityData);
  const deadEdges = new Set<string>();
  const overloadedEdges = new Set<string>();

  Object.entries(flow.transmission_line_states).forEach(([linkIdStr, state]) => {
    const linkId = parseInt(linkIdStr, 10);
    const edges = linkEdges[linkId] || [];
    edges.forEach(([u, v]) => {
      if (state === "dead") {
        deadEdges.add(`${u}-${v}`);
        deadEdges.add(`${v}-${u}`);
      } else if (state === "overloaded") {
        overloadedEdges.add(`${u}-${v}`);
        overloadedEdges.add(`${v}-${u}`);
      }
    });
  });

  const FLOOD_BLOCK = 100000.0;
  const PARTIAL_FLOOD_WEIGHT = 10.0;
  const BLACKOUT_MULT = 3.0;

  interface AdjList {
    [nid: number]: { [neighborId: number]: number };
  }
  const adj: AdjList = {};
  cityData.nodes.forEach(n => { adj[n.id] = {}; });

  const blocked_edges: [number, number][] = [];

  cityData.edges.forEach(e => {
    const u = e.source;
    const v = e.target;
    const u_flooded = floodedSet.has(u);
    const v_flooded = floodedSet.has(v);
    const u_dark = blackout.has(u);
    const v_dark = blackout.has(v);

    let weight = 1.0;
    if (u_flooded && v_flooded) {
      weight = FLOOD_BLOCK;
      blocked_edges.push([u, v]);
    } else if (u_flooded || v_flooded) {
      weight = PARTIAL_FLOOD_WEIGHT;
    } else {
      weight = 1.0;
    }

    if (weight < FLOOD_BLOCK && (u_dark || v_dark)) {
      weight *= BLACKOUT_MULT;
    }

    if (weight < FLOOD_BLOCK) {
      if (deadEdges.has(`${u}-${v}`)) {
        weight += 25.0;
      } else if (overloadedEdges.has(`${u}-${v}`)) {
        weight += 10.0;
      }
    }

    adj[u][v] = weight;
    adj[v][u] = weight;
  });

  const SAFE_EXITS = [14, 120, 164, 210];

  const dists: Record<number, number> = {};
  const prev: Record<number, number | null> = {};
  const q = new Set<number>();

  cityData.nodes.forEach(n => {
    dists[n.id] = Infinity;
    prev[n.id] = null;
    q.add(n.id);
  });

  dists[originNode] = 0;

  while (q.size > 0) {
    let u: number | null = null;
    let minDist = Infinity;
    q.forEach(nid => {
      if (dists[nid] < minDist) {
        minDist = dists[nid];
        u = nid;
      }
    });

    if (u === null || minDist === Infinity) break;
    q.delete(u);

    const neighbors = adj[u];
    for (const [vStr, weight] of Object.entries(neighbors)) {
      const v = parseInt(vStr, 10);
      const alt = dists[u] + weight;
      if (alt < dists[v]) {
        dists[v] = alt;
        prev[v] = u;
      }
    }
  }

  let bestExit = -1;
  let minExitDist = Infinity;
  SAFE_EXITS.forEach(exitId => {
    if (dists[exitId] < minExitDist) {
      minExitDist = dists[exitId];
      bestExit = exitId;
    }
  });

  if (bestExit === -1 || minExitDist === Infinity) {
    return {
      success: false,
      path: [],
      path_coords: [],
      total_nodes: 0,
      flooded_nodes: floodedNodes,
      blackout_nodes: Array.from(blackout),
      blocked_edges: blocked_edges,
      anomaly_score: 0.99,
      risk_level: "CRITICAL",
      message: "Evacuation route blocked — grid is completely inundated or blacked out.",
      dest_node: -1,
      substation_loads: flow.substation_loads,
      overloaded_substations: flow.overloaded_substations,
      cascaded_substations: flow.cascaded_substations,
      grid_frequency: flow.grid_frequency,
      voltage_readings: flow.voltage_readings,
      transmission_line_states: flow.transmission_line_states,
      usgs_gage_height: Math.round((4.2 + floodLevel * 0.9 + Math.random() * 0.2) * 100) / 100,
      surface_temp: Math.round((84.0 + Math.random() * 1.5) * 10) / 10,
      hazard_roads: {}
    };
  }

  const path: number[] = [];
  let curr: number | null = bestExit;
  while (curr !== null) {
    path.push(curr);
    curr = prev[curr];
  }
  path.reverse();

  const path_coords = path.map(nid => {
    const node = cityData.nodes.find(n => n.id === nid)!;
    return { lon: node.lon, lat: node.lat, elevation: node.elevation };
  });

  const hazard_roads: Record<string, string> = {};
  cityData.edges.forEach(e => {
    if (deadEdges.has(`${e.source}-${e.target}`)) {
      hazard_roads[`${e.source}-${e.target}`] = 'dead';
    } else if (overloadedEdges.has(`${e.source}-${e.target}`)) {
      hazard_roads[`${e.source}-${e.target}`] = 'overloaded';
    }
  });

  return {
    success: true,
    path,
    path_coords,
    total_nodes: path.length,
    flooded_nodes: floodedNodes,
    blackout_nodes: Array.from(blackout),
    blocked_edges: blocked_edges,
    anomaly_score: Math.round((0.04 + (failedSubstations.length + flow.cascaded_substations.length) * 0.15 + floodLevel * 0.05) * 100) / 100,
    risk_level: floodLevel > 7.0 || failedSubstations.length >= 3 ? "CRITICAL" : (floodLevel > 4.0 || failedSubstations.length >= 1 ? "HIGH" : "LOW"),
    message: "Optimal evacuation route computed successfully.",
    dest_node: bestExit,
    substation_loads: flow.substation_loads,
    overloaded_substations: flow.overloaded_substations,
    cascaded_substations: flow.cascaded_substations,
    grid_frequency: flow.grid_frequency,
    voltage_readings: flow.voltage_readings,
    transmission_line_states: flow.transmission_line_states,
    usgs_gage_height: Math.round((4.2 + floodLevel * 0.9 + Math.random() * 0.2) * 100) / 100,
    surface_temp: Math.round((84.0 + Math.random() * 1.5) * 10) / 10,
    hazard_roads
  };
}
