import { create } from 'zustand';
import { api } from '@/lib/api';
import type {
  BlockData,
  CityData,
  EdgeData,
  NodeData,
  RouteResponse,
  RouteStep,
  SubstationData,
} from '@/lib/types';

const CENTER_LAT = 29.7604;
const CENTER_LON = -95.3698;
const GRID_ROWS = 15;
const GRID_COLS = 15;
const LAT_STEP = 0.00135;
const LON_STEP = 0.00165;
const BASE_ELEV = 8.5;
const FLOOD_RISE_PER_LEVEL = 1.7;
const SAFE_EXITS = [7, 105, 119, 217];

const EW_ROADS = [
  'Allen Parkway', 'Dallas Street', 'Lamar Street', 'McKinney Street',
  'Rusk Street', 'Capitol Street', 'Congress Street', 'Preston Street',
  'Franklin Street', 'Commerce Street', 'Leeland Street', 'Polk Street',
  'Jefferson Street', 'Clay Street', 'Bell Street',
];
const NS_ROADS = [
  'Bagby Street', 'Smith Street', 'Louisiana Street', 'Milam Street',
  'Travis Street', 'Main Street', 'Fannin Street', 'San Jacinto Street',
  'Caroline Street', 'Austin Street', 'La Branch Street', 'Crawford Street',
  'St. Charles Street', 'Chene Street', 'Jensen Drive',
];
const MAJOR_EW_ROWS = new Set([0, 3, 5, 8, 11, 14]);
const MAJOR_NS_COLS = new Set([1, 4, 6, 8, 11, 14]);

const SUBSTATION_DEFS = [
  { id: 0, node: 32, name: 'Third Ward Substation', radius: 2.8, capacity_mw: 150, base_load_mw: 90 },
  { id: 1, node: 56, name: 'River Oaks Substation', radius: 3.1, capacity_mw: 120, base_load_mw: 85 },
  { id: 2, node: 112, name: 'Downtown Core Substation', radius: 3.4, capacity_mw: 250, base_load_mw: 180 },
  { id: 3, node: 168, name: 'Fifth Ward Substation', radius: 2.6, capacity_mw: 110, base_load_mw: 70 },
  { id: 4, node: 192, name: 'Heights Substation', radius: 3.0, capacity_mw: 130, base_load_mw: 95 },
];
const TRANSMISSION_LINKS = [
  { id: 0, from_sub: 0, to_sub: 2 },
  { id: 1, from_sub: 1, to_sub: 2 },
  { id: 2, from_sub: 2, to_sub: 4 },
  { id: 3, from_sub: 3, to_sub: 4 },
  { id: 4, from_sub: 0, to_sub: 3 },
];

type Section = 'briefing' | 'map' | 'audit';
type MapFilterMode = 'nominal' | 'radar' | 'thermal';
type ScenarioPreset = 'flood' | 'cascade' | 'heatwave' | 'clear';

type SimulationStore = {
  floodLevel: number;
  failedSubstations: number[];
  originNode: number;
  destNode: number;

  gridFrequency: number;
  substationLoads: Record<number, number>;
  overloadedSubstations: number[];
  cascadedSubstations: number[];
  voltageReadings: Record<number, number>;
  liveLogs: string[];
  usgsGageHeight: number;
  surfaceTemp: number;
  frequencyHistory: number[];
  gageHistory: number[];

  showBuildings: boolean;
  showPowerLines: boolean;
  showSubstations: boolean;
  showIntersections: boolean;
  showRoadNames: boolean;
  flyToNodeId: number | null;
  flyToCoords: { lon: number; lat: number; elev: number; heading?: number; pitch?: number } | null;
  mapFilterMode: MapFilterMode;
  activeSection: Section;

  cityData: CityData | null;
  route: RouteResponse | null;
  isLoading: boolean;
  backendOnline: boolean;
  error: string | null;

  setFloodLevel: (value: number) => void;
  toggleSubstation: (id: number) => void;
  setOriginNode: (id: number) => void;
  fetchCityData: () => Promise<void>;
  calculateRoute: () => Promise<void>;
  clearRoute: () => void;
  checkBackend: () => Promise<void>;
  addLog: (message: string) => void;
  triggerLiveTick: () => void;
  setShowBuildings: (value: boolean) => void;
  setShowPowerLines: (value: boolean) => void;
  setShowSubstations: (value: boolean) => void;
  setShowIntersections: (value: boolean) => void;
  setShowRoadNames: (value: boolean) => void;
  setFlyToNodeId: (id: number | null) => void;
  setFlyToCoords: (coords: { lon: number; lat: number; elev: number; heading?: number; pitch?: number } | null) => void;
  setMapFilterMode: (mode: MapFilterMode) => void;
  applyScenario: (preset: ScenarioPreset) => void;
  setActiveSection: (section: Section) => void;
};

let routeRequestSerial = 0;
let recalculateTimer: ReturnType<typeof setTimeout> | null = null;

function queueRouteCalculation(calculate: () => Promise<void>) {
  if (recalculateTimer) clearTimeout(recalculateTimer);
  recalculateTimer = setTimeout(() => {
    recalculateTimer = null;
    void calculate();
  }, 140);
}

function normalizeRoute(route: RouteResponse): RouteResponse {
  return {
    ...route,
    path_coords: route.path_coords ?? [],
    blocked_edges: route.blocked_edges ?? [],
    distance_m: route.distance_m ?? 0,
    eta_minutes: route.eta_minutes ?? 0,
    route_steps: route.route_steps ?? [],
    hazard_roads: route.hazard_roads ?? {},
  };
}

function normalizeCityData(data: CityData): CityData {
  const rawNodes = data.nodes ?? [];
  const nodes = rawNodes.map((node) => ({
    ...node,
    intersection_name: node.intersection_name || `Node ${node.id}`,
    district: node.district || 'Houston operations district',
  }));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges = (data.edges ?? []).map((edge) => {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    const distance_m = edge.distance_m || (source && target ? distanceMeters(source, target) : 0);
    return {
      ...edge,
      distance_m,
      road_name: edge.road_name || `Local connector ${edge.source}-${edge.target}`,
      road_class: edge.road_class || 'local',
      lanes: edge.lanes || 2,
      speed_limit_mph: edge.speed_limit_mph || 25,
    };
  });
  return {
    ...data,
    nodes,
    edges,
    blocks: data.blocks && data.blocks.length ? data.blocks : generateFallbackBlocks(nodes),
    substations: data.substations ?? [],
    transmission_links: data.transmission_links ?? [],
  };
}

export const useSimulationStore = create<SimulationStore>((set, get) => ({
  floodLevel: 0,
  failedSubstations: [],
  originNode: 112,
  destNode: -1,

  gridFrequency: 60,
  substationLoads: {},
  overloadedSubstations: [],
  cascadedSubstations: [],
  voltageReadings: {},
  liveLogs: [
    'GridEvac AI: Regional operations console initialized.',
    'Street network: awaiting first route assessment.',
  ],
  usgsGageHeight: 4.5,
  surfaceTemp: 87.5,
  frequencyHistory: Array(16).fill(60),
  gageHistory: Array(16).fill(4.5),

  showBuildings: true,
  showPowerLines: true,
  showSubstations: true,
  showIntersections: true,
  showRoadNames: true,
  flyToNodeId: null,
  flyToCoords: null,
  mapFilterMode: 'nominal',
  activeSection: 'briefing',

  cityData: null,
  route: null,
  isLoading: false,
  backendOnline: false,
  error: null,

  addLog: (message) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    set((state) => ({ liveLogs: [`${time}  ${message}`, ...state.liveLogs].slice(0, 40) }));
  },

  setFloodLevel: (value) => {
    const next = Math.max(0, Math.min(10, value));
    const { cityData, originNode } = get();
    let nextOrigin = originNode;
    const currentOrigin = cityData?.nodes.find((node) => node.id === originNode);
    if (currentOrigin && currentOrigin.elevation <= next * FLOOD_RISE_PER_LEVEL) {
      const replacement = cityData?.nodes
        .filter((node) => !SAFE_EXITS.includes(node.id) && node.elevation > next * FLOOD_RISE_PER_LEVEL)
        .sort((a, b) => Math.hypot(a.lat - currentOrigin.lat, a.lon - currentOrigin.lon) - Math.hypot(b.lat - currentOrigin.lat, b.lon - currentOrigin.lon))[0];
      if (replacement) {
        nextOrigin = replacement.id;
        get().addLog(`Origin Node ${originNode} entered the flood surface; moved to dry Node ${replacement.id}.`);
      }
    }
    set({ floodLevel: next, originNode: nextOrigin });
    get().addLog(`Scenario parameter changed: water surface ${next.toFixed(1)} / 10.`);
    queueRouteCalculation(get().calculateRoute);
  },

  toggleSubstation: (id) => {
    const { failedSubstations, cityData } = get();
    const nextFailed = failedSubstations.includes(id)
      ? failedSubstations.filter((item) => item !== id)
      : [...failedSubstations, id];
    const name = cityData?.substations.find((sub) => sub.id === id)?.name ?? `Substation ${id}`;
    set({ failedSubstations: nextFailed });
    get().addLog(`${name}: ${nextFailed.includes(id) ? 'manual outage applied' : 'returned to service'}.`);
    queueRouteCalculation(get().calculateRoute);
  },

  setOriginNode: (id) => {
    const node = get().cityData?.nodes.find((item) => item.id === id);
    set({ originNode: id });
    get().addLog(`Origin moved to Node ${id}${node ? ` (${node.intersection_name})` : ''}.`);
    queueRouteCalculation(get().calculateRoute);
  },

  clearRoute: () => {
    set({ route: null, destNode: -1, error: null });
    get().addLog('Route overlay cleared; scenario parameters retained.');
  },

  checkBackend: async () => {
    const online = await api.health();
    set({ backendOnline: online });
  },

  fetchCityData: async () => {
    set({ isLoading: true, error: null });
    try {
      const cityData = normalizeCityData(await api.getCityData());
      const loads: Record<number, number> = {};
      cityData.substations.forEach((sub) => { loads[sub.id] = sub.base_load_mw; });
      set({ cityData, substationLoads: loads, isLoading: false, backendOnline: true });
      get().addLog(`Street database loaded: ${cityData.nodes.length} intersections, ${cityData.blocks.length} block footprints.`);
      await get().calculateRoute();
    } catch {
      const cityData = generateMockCityData();
      const loads: Record<number, number> = {};
      cityData.substations.forEach((sub) => { loads[sub.id] = sub.base_load_mw; });
      set({ cityData, substationLoads: loads, isLoading: false, backendOnline: false, error: null });
      get().addLog('Offline mode: local street graph loaded; route solver remains available.');
      await get().calculateRoute();
    }
  },

  calculateRoute: async () => {
    const requestId = ++routeRequestSerial;
    const { floodLevel, failedSubstations, originNode } = get();
    set({ isLoading: true, error: null });
    try {
      const response = normalizeRoute(await api.calculateRoute({ flood_level: floodLevel, failed_substations: failedSubstations, origin_node: originNode }));
      if (requestId !== routeRequestSerial) return;
      setRouteTelemetry(set, response);
      set({ backendOnline: true, isLoading: false });
      get().addLog(`Route solved: ${response.success ? `${formatDistance(response.distance_m)} to Node ${response.dest_node}` : 'no passable corridor'}.`);
    } catch {
      const cityData = get().cityData;
      if (requestId !== routeRequestSerial) return;
      if (!cityData) {
        set({ isLoading: false, error: 'No street data is available for route calculation.' });
        return;
      }
      const response = calculateMockRoute(cityData, floodLevel, failedSubstations, originNode);
      setRouteTelemetry(set, response);
      set({ backendOnline: false, isLoading: false });
      get().addLog(`Local route solver: ${response.success ? `${formatDistance(response.distance_m)} corridor found` : 'no passable corridor'}.`);
    }
  },

  triggerLiveTick: () => {
    const { route, cityData, failedSubstations, cascadedSubstations, substationLoads, gridFrequency, usgsGageHeight, surfaceTemp } = get();
    if (!route || !cityData || Object.keys(substationLoads).length === 0) return;

    const nextLoads = { ...substationLoads };
    const nextOverloaded = get().overloadedSubstations.filter((id) => !failedSubstations.includes(id) && !cascadedSubstations.includes(id));
    Object.keys(nextLoads).forEach((key) => {
      const id = Number(key);
      if (failedSubstations.includes(id) || cascadedSubstations.includes(id)) return;
      const sub = cityData.substations.find((item) => item.id === id);
      nextLoads[id] = Math.max(10, Number((nextLoads[id] + (Math.random() - 0.5) * 1.4).toFixed(1)));
      if (sub && nextLoads[id] > sub.capacity_mw && !nextOverloaded.includes(id)) nextOverloaded.push(id);
      if (sub && nextLoads[id] <= sub.capacity_mw) {
        const index = nextOverloaded.indexOf(id);
        if (index >= 0) nextOverloaded.splice(index, 1);
      }
    });

    const failedCount = failedSubstations.length + cascadedSubstations.length;
    const nextFrequency = Number(Math.max(45, Math.min(60, gridFrequency + (Math.random() - 0.5) * 0.02 - failedCount * 0.001)).toFixed(2));
    const nextGage = Number(Math.max(1, usgsGageHeight + (Math.random() - 0.5) * 0.08).toFixed(2));
    const nextTemp = Number(Math.max(50, surfaceTemp + (Math.random() - 0.5) * 0.12).toFixed(1));
    set((state) => ({
      substationLoads: nextLoads,
      overloadedSubstations: nextOverloaded,
      gridFrequency: nextFrequency,
      usgsGageHeight: nextGage,
      surfaceTemp: nextTemp,
      frequencyHistory: [...state.frequencyHistory.slice(1), nextFrequency],
      gageHistory: [...state.gageHistory.slice(1), nextGage],
    }));
  },

  setShowBuildings: (value) => set({ showBuildings: value }),
  setShowPowerLines: (value) => set({ showPowerLines: value }),
  setShowSubstations: (value) => set({ showSubstations: value }),
  setShowIntersections: (value) => set({ showIntersections: value }),
  setShowRoadNames: (value) => set({ showRoadNames: value }),
  setFlyToNodeId: (id) => set({ flyToNodeId: id }),
  setFlyToCoords: (coords) => set({ flyToCoords: coords }),
  setMapFilterMode: (mode) => set({ mapFilterMode: mode }),

  applyScenario: (preset) => {
    const scenarios: Record<ScenarioPreset, { floodLevel: number; failedSubstations: number[]; originNode: number; label: string }> = {
      clear: { floodLevel: 0, failedSubstations: [], originNode: 112, label: 'Normal operations' },
      flood: { floodLevel: 7.2, failedSubstations: [], originNode: 196, label: 'Buffalo Bayou flash flood' },
      cascade: { floodLevel: 1.8, failedSubstations: [0, 2], originNode: 112, label: 'Downtown feeder cascade' },
      heatwave: { floodLevel: 0.4, failedSubstations: [1, 3], originNode: 56, label: 'Peak heat and transmission strain' },
    };
    const scenario = scenarios[preset];
    set({ floodLevel: scenario.floodLevel, failedSubstations: scenario.failedSubstations, originNode: scenario.originNode });
    get().addLog(`Scenario loaded: ${scenario.label}.`);
    queueRouteCalculation(get().calculateRoute);
  },

  setActiveSection: (section) => set({ activeSection: section }),
}));

function setRouteTelemetry(set: (partial: Partial<SimulationStore>) => void, route: RouteResponse) {
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
  });
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function generateFallbackBlocks(nodes: NodeData[]): BlockData[] {
  const byPosition = new Map(nodes.map((node) => [`${node.row}-${node.col}`, node]));
  const maxRow = Math.max(-1, ...nodes.map((node) => node.row));
  const maxCol = Math.max(-1, ...nodes.map((node) => node.col));
  const kinds = ['office', 'residential', 'retail', 'civic'] as const;
  const blocks: BlockData[] = [];
  for (let row = 0; row < maxRow; row += 1) {
    for (let col = 0; col < maxCol; col += 1) {
      const corners = [byPosition.get(`${row}-${col}`), byPosition.get(`${row + 1}-${col}`), byPosition.get(`${row}-${col + 1}`), byPosition.get(`${row + 1}-${col + 1}`)];
      if (corners.some((corner) => !corner)) continue;
      const validCorners = corners as NodeData[];
      const park = (row * 7 + col * 11) % 19 === 0;
      blocks.push({
        id: `block-${row}-${col}`,
        row,
        col,
        lat: validCorners.reduce((sum, node) => sum + node.lat, 0) / validCorners.length,
        lon: validCorners.reduce((sum, node) => sum + node.lon, 0) / validCorners.length,
        kind: park ? 'park' : kinds[(row * 3 + col * 5) % kinds.length],
        height_m: park ? 0 : 22 + ((row * 13 + col * 17) % 8) * 8,
      });
    }
  }
  return blocks;
}

function nodeId(row: number, col: number) {
  return row * GRID_COLS + col;
}

function nodePosition(row: number, col: number) {
  const lat = CENTER_LAT + (row - (GRID_ROWS - 1) / 2) * LAT_STEP;
  const lon = CENTER_LON + (col - (GRID_COLS - 1) / 2) * LON_STEP;
  const elevation = Math.max(4, BASE_ELEV + row * 0.34 + (GRID_COLS - 1 - col) * 0.24 + 0.55 * (Math.sin(row * 1.4 + col * 0.9) + Math.cos(row * 0.7 + col * 1.5)) * 0.5);
  return { lat, lon, elevation };
}

function distanceMeters(a: NodeData, b: NodeData) {
  const lat = (b.lat - a.lat) * 111320;
  const lon = (b.lon - a.lon) * 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(lat, lon);
}

function edgeAttributes(row: number, col: number, horizontal: boolean) {
  const roadName = horizontal ? EW_ROADS[row] : NS_ROADS[col];
  const major = horizontal ? MAJOR_EW_ROWS.has(row) : MAJOR_NS_COLS.has(col);
  if (major) return { road_name: roadName, road_class: 'arterial', lanes: 4, speed_limit_mph: 35 };
  if ((row + col) % 3 === 0) return { road_name: roadName, road_class: 'collector', lanes: 3, speed_limit_mph: 30 };
  return { road_name: roadName, road_class: 'local', lanes: 2, speed_limit_mph: 25 };
}

function generateMockCityData(): CityData {
  const nodes: NodeData[] = [];
  const edges: EdgeData[] = [];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      const position = nodePosition(row, col);
      nodes.push({ id: nodeId(row, col), row, col, ...position, intersection_name: `${EW_ROADS[row]} / ${NS_ROADS[col]}`, district: row >= 4 && row <= 10 && col >= 4 && col <= 10 ? 'Downtown' : 'Houston operations district' });
    }
  }
  const addEdge = (row: number, col: number, horizontal: boolean) => {
    const source = nodeId(row, col);
    const target = horizontal ? nodeId(row, col + 1) : nodeId(row + 1, col);
    const attrs = edgeAttributes(row, col, horizontal);
    const distance_m = distanceMeters(nodes[source], nodes[target]);
    const seconds = distance_m / (attrs.speed_limit_mph * 0.44704);
    edges.push({ source, target, distance_m: Number(distance_m.toFixed(1)), weight: seconds, ...attrs });
  };
  for (let row = 0; row < GRID_ROWS; row += 1) for (let col = 0; col < GRID_COLS - 1; col += 1) addEdge(row, col, true);
  for (let row = 0; row < GRID_ROWS - 1; row += 1) for (let col = 0; col < GRID_COLS; col += 1) addEdge(row, col, false);

  const substations: SubstationData[] = SUBSTATION_DEFS.map((definition) => {
    const center = nodes[definition.node];
    const affected_nodes = nodes.filter((node) => Math.hypot(node.row - center.row, node.col - center.col) <= definition.radius).map((node) => node.id);
    return { ...definition, lat: center.lat, lon: center.lon, affected_nodes };
  });
  const blocks: BlockData[] = [];
  const kinds = ['office', 'residential', 'retail', 'civic'] as const;
  for (let row = 0; row < GRID_ROWS - 1; row += 1) {
    for (let col = 0; col < GRID_COLS - 1; col += 1) {
      const corners = [nodes[nodeId(row, col)], nodes[nodeId(row + 1, col)], nodes[nodeId(row, col + 1)], nodes[nodeId(row + 1, col + 1)]];
      const park = (row * 7 + col * 11) % 19 === 0 || (row === 6 && col === 2);
      blocks.push({ id: `block-${row}-${col}`, row, col, lat: corners.reduce((sum, node) => sum + node.lat, 0) / 4, lon: corners.reduce((sum, node) => sum + node.lon, 0) / 4, kind: park ? 'park' : kinds[(row * 3 + col * 5) % kinds.length], height_m: park ? 0 : 22 + (row >= 4 && row <= 9 && col >= 4 && col <= 9 ? 28 : 0) + ((row * 13 + col * 17) % 8) * 8 });
    }
  }
  return { nodes, edges, blocks, substations, transmission_links: TRANSMISSION_LINKS, center_lat: CENTER_LAT, center_lon: CENTER_LON, grid_rows: GRID_ROWS, grid_cols: GRID_COLS };
}

function transmissionLineEdges(cityData: CityData) {
  const mapped: Record<number, [number, number][]> = {};
  TRANSMISSION_LINKS.forEach((link) => {
    const a = cityData.nodes.find((node) => node.id === cityData.substations.find((sub) => sub.id === link.from_sub)?.node);
    const b = cityData.nodes.find((node) => node.id === cityData.substations.find((sub) => sub.id === link.to_sub)?.node);
    mapped[link.id] = a && b ? cityData.edges.filter((edge) => {
      const start = cityData.nodes[edge.source];
      const end = cityData.nodes[edge.target];
      return pointSegmentDistance((start.row + end.row) / 2, (start.col + end.col) / 2, a.row, a.col, b.row, b.col) <= 0.72;
    }).map((edge) => [edge.source, edge.target]) : [];
  });
  return mapped;
}

function pointSegmentDistance(pr: number, pc: number, ar: number, ac: number, br: number, bc: number) {
  const length = (br - ar) ** 2 + (bc - ac) ** 2;
  if (!length) return Math.hypot(pr - ar, pc - ac);
  const t = Math.max(0, Math.min(1, ((pr - ar) * (br - ar) + (pc - ac) * (bc - ac)) / length));
  return Math.hypot(pr - (ar + t * (br - ar)), pc - (ac + t * (bc - ac)));
}

function mockPowerFlow(cityData: CityData, failedInputs: number[]) {
  const failed = new Set(failedInputs);
  const cascaded = new Set<number>();
  const substations = cityData.substations.map((sub) => ({ ...sub, current: sub.base_load_mw }));
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const active = substations.filter((sub) => !failed.has(sub.id) && !cascaded.has(sub.id));
    const offline = substations.filter((sub) => failed.has(sub.id) || cascaded.has(sub.id));
    active.forEach((sub) => { sub.current = sub.base_load_mw; });
    if (!active.length) break;
    offline.forEach((offlineSub) => {
      const origin = cityData.nodes[offlineSub.node];
      const weights = active.map((activeSub) => 1 / (Math.hypot(origin.row - cityData.nodes[activeSub.node].row, origin.col - cityData.nodes[activeSub.node].col) + 0.5));
      const total = weights.reduce((sum, value) => sum + value, 0) || 1;
      active.forEach((activeSub, index) => { activeSub.current += (weights[index] / total) * offlineSub.base_load_mw; });
    });
    let addedCascade = false;
    active.forEach((sub) => {
      if (sub.current > sub.capacity_mw * 1.25) { cascaded.add(sub.id); addedCascade = true; }
    });
    if (!addedCascade) break;
  }
  const overloaded = substations.filter((sub) => !failed.has(sub.id) && !cascaded.has(sub.id) && sub.current > sub.capacity_mw).map((sub) => sub.id);
  const blackout = new Set<number>();
  const loads: Record<number, number> = {};
  let capacity = 0;
  let load = 0;
  substations.forEach((sub) => {
    if (failed.has(sub.id) || cascaded.has(sub.id)) {
      loads[sub.id] = 0;
      sub.affected_nodes.forEach((node) => blackout.add(node));
    } else {
      loads[sub.id] = Number(sub.current.toFixed(1));
      capacity += sub.capacity_mw;
      load += sub.current;
      if (overloaded.includes(sub.id)) {
        const radius = sub.radius * (1 + 0.6 * ((sub.current - sub.capacity_mw) / sub.capacity_mw));
        const center = cityData.nodes[sub.node];
        cityData.nodes.forEach((node) => { if (Math.hypot(node.row - center.row, node.col - center.col) <= radius) blackout.add(node.id); });
      }
    }
  });
  const ratio = capacity ? load / capacity : 1.5;
  const gridFrequency = Number(Math.max(45, Math.min(60.1, 60 - (ratio > 1 ? 1.4 * (ratio - 1) : 0.06 * (failed.size + cascaded.size)) + (Math.random() - 0.5) * 0.02)).toFixed(2));
  const voltageReadings: Record<number, number> = {};
  cityData.nodes.forEach((node) => { voltageReadings[node.id] = blackout.has(node.id) ? 0 : 100; });
  const transmission_line_states: Record<number, string> = {};
  TRANSMISSION_LINKS.forEach((link) => { transmission_line_states[link.id] = failed.has(link.from_sub) || failed.has(link.to_sub) || cascaded.has(link.from_sub) || cascaded.has(link.to_sub) ? 'dead' : overloaded.includes(link.from_sub) || overloaded.includes(link.to_sub) ? 'overloaded' : 'active'; });
  return { substation_loads: loads, overloaded_substations: overloaded, cascaded_substations: Array.from(cascaded), blackout_nodes: blackout, voltage_readings: voltageReadings, grid_frequency: gridFrequency, transmission_line_states };
}

function bearing(a: NodeData, b: NodeData) {
  if (Math.abs(b.col - a.col) > Math.abs(b.row - a.row)) return b.col > a.col ? 'eastbound' : 'westbound';
  return b.row > a.row ? 'northbound' : 'southbound';
}

function buildRouteSteps(path: number[], cityData: CityData, weightedEdges: Map<string, EdgeData & { routeWeight: number }>): RouteStep[] {
  const steps: Array<RouteStep & { direction: string }> = [];
  path.slice(0, -1).forEach((from, index) => {
    const to = path[index + 1];
    const edge = weightedEdges.get(`${from}-${to}`) ?? weightedEdges.get(`${to}-${from}`);
    if (!edge) return;
    const direction = bearing(cityData.nodes[from], cityData.nodes[to]);
    const previous = steps[steps.length - 1];
    if (previous && previous.road_name === edge.road_name && previous.direction === direction) {
      previous.distance_m += edge.distance_m;
      previous.duration_s += edge.routeWeight;
      previous.to_node = to;
    } else {
      steps.push({ instruction: `${previous ? 'Turn onto' : 'Depart on'} ${edge.road_name} ${direction}`, road_name: edge.road_name, road_class: edge.road_class, distance_m: edge.distance_m, duration_s: edge.routeWeight, from_node: from, to_node: to, direction });
    }
  });
  return steps.map(({ direction: _direction, ...step }) => ({ ...step, distance_m: Number(step.distance_m.toFixed(1)), duration_s: Number(step.duration_s.toFixed(1)) }));
}

function calculateMockRoute(cityData: CityData, floodLevel: number, failedSubstations: number[], originNode: number): RouteResponse {
  const flow = mockPowerFlow(cityData, failedSubstations);
  const flooded = new Set(cityData.nodes.filter((node) => node.elevation <= floodLevel * FLOOD_RISE_PER_LEVEL).map((node) => node.id));
  if (flooded.has(originNode)) return failureRoute(flow, flooded, 'Starting intersection is flooded. Select a dry origin on higher ground.');
  const hazards = transmissionLineEdges(cityData);
  const deadEdges = new Set<string>();
  const overloadedEdges = new Set<string>();
  Object.entries(flow.transmission_line_states).forEach(([linkId, state]) => hazards[Number(linkId)]?.forEach(([u, v]) => (state === 'dead' ? deadEdges : overloadedEdges).add(`${u}-${v}`)));
  const edgeMap = new Map<string, EdgeData & { routeWeight: number }>();
  cityData.edges.forEach((edge) => {
    if (flooded.has(edge.source) && flooded.has(edge.target)) {
      edgeMap.set(`${edge.source}-${edge.target}`, { ...edge, routeWeight: Number.POSITIVE_INFINITY });
      return;
    }
    let routeWeight = edge.weight;
    if (flooded.has(edge.source) || flooded.has(edge.target)) routeWeight += 180;
    if (flow.blackout_nodes.has(edge.source) || flow.blackout_nodes.has(edge.target)) routeWeight *= 4.5;
    if (deadEdges.has(`${edge.source}-${edge.target}`) || deadEdges.has(`${edge.target}-${edge.source}`)) routeWeight += 240;
    else if (overloadedEdges.has(`${edge.source}-${edge.target}`) || overloadedEdges.has(`${edge.target}-${edge.source}`)) routeWeight += 90;
    if (edge.road_class === 'arterial') routeWeight *= 0.94;
    edgeMap.set(`${edge.source}-${edge.target}`, { ...edge, routeWeight });
  });

  const distances: Record<number, number> = {};
  const previous: Record<number, number | null> = {};
  const remaining = new Set(cityData.nodes.map((node) => node.id));
  cityData.nodes.forEach((node) => { distances[node.id] = Number.POSITIVE_INFINITY; previous[node.id] = null; });
  distances[originNode] = 0;
  while (remaining.size) {
    let current: number | null = null;
    remaining.forEach((node) => { if (current === null || distances[node] < distances[current]) current = node; });
    if (current === null || distances[current] === Number.POSITIVE_INFINITY) break;
    remaining.delete(current);
    edgeMap.forEach((edge) => {
      if (edge.source !== current && edge.target !== current) return;
      const neighbor = edge.source === current ? edge.target : edge.source;
      if (!remaining.has(neighbor) || !Number.isFinite(edge.routeWeight)) return;
      const candidate = distances[current] + edge.routeWeight;
      if (candidate < distances[neighbor]) { distances[neighbor] = candidate; previous[neighbor] = current; }
    });
  }
  let destination = -1;
  SAFE_EXITS.forEach((exit) => { if (!flooded.has(exit) && distances[exit] < (destination < 0 ? Number.POSITIVE_INFINITY : distances[destination])) destination = exit; });
  if (destination < 0 || !Number.isFinite(distances[destination])) return failureRoute(flow, flooded, 'No passable street corridor found. Floodwater and utility hazards isolate this origin.');
  const path: number[] = [];
  let cursor: number | null = destination;
  while (cursor !== null) { path.unshift(cursor); cursor = previous[cursor]; }
  const pathEdges = path.slice(0, -1).map((from, index) => edgeMap.get(`${from}-${path[index + 1]}`) ?? edgeMap.get(`${path[index + 1]}-${from}`)).filter((edge): edge is EdgeData & { routeWeight: number } => Boolean(edge));
  const distance_m = Number(pathEdges.reduce((sum, edge) => sum + edge.distance_m, 0).toFixed(1));
  const failedCount = failedSubstations.length + flow.cascaded_substations.length;
  const anomaly_score = Math.min(1, Number((0.04 + floodLevel * 0.05 + failedCount * 0.14 + flow.overloaded_substations.length * 0.08).toFixed(4)));
  const risk_level = anomaly_score >= 0.78 ? 'CRITICAL' : anomaly_score >= 0.55 ? 'HIGH' : anomaly_score >= 0.3 ? 'MEDIUM' : 'LOW';
  const hazard_roads: Record<string, string> = {};
  cityData.edges.forEach((edge) => { if (deadEdges.has(`${edge.source}-${edge.target}`)) hazard_roads[`${edge.source}-${edge.target}`] = 'dead'; else if (overloadedEdges.has(`${edge.source}-${edge.target}`)) hazard_roads[`${edge.source}-${edge.target}`] = 'overloaded'; });
  return {
    success: true,
    path,
    path_coords: path.map((id) => ({ ...cityData.nodes[id], elevation: cityData.nodes[id].elevation + 0.65 })).map(({ lat, lon, elevation }) => ({ lat, lon, elevation })),
    total_nodes: path.length,
    distance_m,
    eta_minutes: Number((distances[destination] / 60).toFixed(1)),
    route_steps: buildRouteSteps(path, cityData, edgeMap),
    flooded_nodes: Array.from(flooded),
    blackout_nodes: Array.from(flow.blackout_nodes),
    blocked_edges: cityData.edges.filter((edge) => flooded.has(edge.source) && flooded.has(edge.target)).map((edge) => [edge.source, edge.target]),
    anomaly_score,
    risk_level,
    message: `Safest street corridor mapped to Node ${destination}.`,
    dest_node: destination,
    substation_loads: flow.substation_loads,
    overloaded_substations: flow.overloaded_substations,
    cascaded_substations: flow.cascaded_substations,
    grid_frequency: flow.grid_frequency,
    voltage_readings: flow.voltage_readings,
    transmission_line_states: flow.transmission_line_states,
    usgs_gage_height: Number((4.2 + floodLevel * 2.8).toFixed(2)),
    surface_temp: Number((88 - floodLevel * 0.95 - failedCount * 0.45).toFixed(1)),
    hazard_roads,
  };
}

function failureRoute(flow: ReturnType<typeof mockPowerFlow>, flooded: Set<number>, message: string): RouteResponse {
  const failedCount = flow.cascaded_substations.length;
  return { success: false, path: [], path_coords: [], total_nodes: 0, distance_m: 0, eta_minutes: 0, route_steps: [], flooded_nodes: Array.from(flooded), blackout_nodes: Array.from(flow.blackout_nodes), blocked_edges: [], anomaly_score: Math.min(1, 0.65 + failedCount * 0.1), risk_level: 'CRITICAL', message, dest_node: -1, substation_loads: flow.substation_loads, overloaded_substations: flow.overloaded_substations, cascaded_substations: flow.cascaded_substations, grid_frequency: flow.grid_frequency, voltage_readings: flow.voltage_readings, transmission_line_states: flow.transmission_line_states, usgs_gage_height: 4.2, surface_temp: 88, hazard_roads: {} };
}
