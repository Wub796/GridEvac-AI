import { create } from 'zustand';
import { api } from '@/lib/api';
import type {
  BlockData,
  CityData,
  CorridorComparisonResponse,
  CorridorInfo,
  EdgeData,
  IsochroneResponse,
  NodeData,
  RouteResponse,
  RouteStep,
  SubstationData,
  TravelMode,
} from '@/lib/types';

const FLOOD_RISE_PER_LEVEL = 1.7;
// Exits come from the loaded network; these fallbacks are replaced on fetch.
let SAFE_EXITS: number[] = [];
let EXIT_NAMES: Record<string, string> = {};
const DEFAULT_ORIGIN = 0;

/**
 * The baked OpenStreetMap network is a static asset, not a JS import, so it
 * never enters the application bundle. It is fetched once when the backend is
 * unreachable and shared by the offline map and solver.
 */
type BakedNetwork = {
  nodes: Array<{ id: number; osm?: number; lat: number; lon: number; elevation: number; intersection_name?: string }>;
  edges: Array<{ source: number; target: number; weight: number; distance_m: number; road_name: string; road_class: string; lanes: number; speed_limit_mph: number; geometry?: [number, number][] }>;
  blocks: BlockData[];
  parks: BlockData[];
  substations: SubstationData[];
  transmission_links: CityData['transmission_links'];
  safe_exits: number[];
  exit_names?: Record<string, string>;
  meta: { center_lat: number; center_lon: number };
};

let bakedNetwork: BakedNetwork | null = null;

async function loadBakedNetwork(): Promise<BakedNetwork> {
  if (bakedNetwork) return bakedNetwork;
  // Cache-friendly: the baked graph only changes on deploy, so a 1-day TTL
  // lets repeat visits resolve from disk cache instead of refetching 1.8 MB.
  const response = await fetch('/data/houston_network.json', { cache: 'force-cache' });
  if (!response.ok) throw new Error('Baked street network unavailable');
  const parsed = (await response.json()) as BakedNetwork;
  bakedNetwork = parsed;
  SAFE_EXITS = parsed.safe_exits ?? [];
  EXIT_NAMES = parsed.exit_names ?? {};
  return parsed;
}

type Section = 'briefing' | 'map' | 'audit';
type MapFilterMode = 'nominal' | 'radar' | 'thermal';
type ScenarioPreset = 'flood' | 'cascade' | 'heatwave' | 'clear';

/* Travel-mode profiles mirror backend/routing.py so offline results match the
 * API exactly: seconds = distance_m * 2.23694 / mph, adjusted per road class. */
const TRAVEL_MODES: Record<TravelMode, { mph: (limit: number) => number; roadClass: Record<string, number>; floodPartial: number; blackoutMult: number }> = {
  vehicle: { mph: (limit) => Math.min(70, limit), roadClass: { arterial: 0.94, collector: 1, local: 1, service: 1.35 }, floodPartial: 180, blackoutMult: 4.5 },
  foot: { mph: () => 3.1, roadClass: { arterial: 1.6, collector: 1.2, local: 1, service: 1 }, floodPartial: 450, blackoutMult: 1.6 },
  ems: { mph: (limit) => Math.min(65, limit * 1.3), roadClass: { arterial: 0.8, collector: 0.9, local: 1.05, service: 1.9 }, floodPartial: 240, blackoutMult: 2 },
};

function travelModeConfig(mode: TravelMode) {
  return TRAVEL_MODES[mode] ?? TRAVEL_MODES.vehicle;
}

const ISOCHRONE_MINUTES: Record<TravelMode, number[]> = {
  vehicle: [3, 6, 9, 12],
  foot: [5, 10, 15, 20],
  ems: [2, 4, 6, 8],
};

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
  flyToRoadKey: string | null;
  flyToCoords: { lon: number; lat: number; elev: number; heading?: number; pitch?: number } | null;
  mapFilterMode: MapFilterMode;
  activeSection: Section;

  travelMode: TravelMode;
  corridorComparison: CorridorComparisonResponse | null;
  isochrone: IsochroneResponse | null;
  isochroneVisible: boolean;

  cityData: CityData | null;
  route: RouteResponse | null;
  isLoading: boolean;
  backendOnline: boolean;
  error: string | null;

  setTravelMode: (mode: TravelMode) => void;
  refreshCorridors: () => Promise<void>;
  setIsochroneVisible: (value: boolean) => void;
  refreshIsochrone: () => Promise<void>;
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
  setFlyToRoadKey: (key: string | null) => void;
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
      road_name: edge.road_name || 'Unnamed street',
      road_class: edge.road_class || 'local',
      lanes: edge.lanes || 2,
      speed_limit_mph: edge.speed_limit_mph || 25,
      geometry: edge.geometry ?? [],
    };
  });
  return {
    ...data,
    nodes,
    edges,
    blocks: (data.blocks ?? []).map((block) => ({ ...block, footprint: block.footprint ?? [] })),
    parks: data.parks ?? [],
    substations: (data.substations ?? []).map((sub) => ({ ...sub, affected_nodes: sub.affected_nodes ?? [] })),
    transmission_links: data.transmission_links ?? [],
    safe_exits: data.safe_exits?.length ? data.safe_exits : SAFE_EXITS,
    exit_names: data.exit_names && Object.keys(data.exit_names).length ? data.exit_names : EXIT_NAMES,
  };
}

export const useSimulationStore = create<SimulationStore>((set, get) => ({
  floodLevel: 0,
  failedSubstations: [],
  originNode: DEFAULT_ORIGIN,
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
  // Intersections and road-name labels start off: with ~4,000 junctions and
  // ~90 labels the default view stays calm, and both are one toggle away.
  // Street-level dots stay visible by default; a hidden-dots default made the
  // map look inert. Clickability is independent of this toggle anyway (there
  // is an invisible always-pickable dot layer), so this is purely cosmetic.
  showIntersections: true,
  showRoadNames: false,
  flyToNodeId: null,
  flyToRoadKey: null,
  flyToCoords: null,
  mapFilterMode: 'nominal',
  activeSection: 'briefing',

  travelMode: 'vehicle' as TravelMode,
  corridorComparison: null,
  isochrone: null,
  isochroneVisible: false,

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
    // Start pulling the baked network immediately: if the API path fails, the
    // 1.8 MB offline graph is already mid-flight instead of starting cold.
    const bakedPromise = loadBakedNetwork().catch(() => null);
    // Deep-link restore (?origin=&flood=&mode=&failed=) - a shared scenario
    // link drops the recipient into the exact operating picture.
    let shared: { origin?: number; flood?: number; mode?: TravelMode; failed?: number[] } = {};
    if (typeof window !== 'undefined' && window.location.search) {
      const params = new URLSearchParams(window.location.search);
      shared = {
        origin: params.get('origin') ? Number(params.get('origin')) : undefined,
        flood: params.get('flood') ? Number(params.get('flood')) : undefined,
        mode: (['vehicle', 'foot', 'ems'] as const).find((m) => m === params.get('mode')),
        failed: params.get('failed') ? params.get('failed')!.split(',').map(Number).filter(Number.isInteger) : undefined,
      };
    }
    try {
      const cityData = normalizeCityData(await api.getCityData());
      const loads: Record<number, number> = {};
      cityData.substations.forEach((sub) => { loads[sub.id] = sub.base_load_mw; });
      SAFE_EXITS = cityData.safe_exits;
      const sharedState: Partial<SimulationStore> = {};
      if (shared.origin !== undefined && cityData.nodes.some((node) => node.id === shared.origin)) sharedState.originNode = shared.origin;
      if (shared.flood !== undefined) sharedState.floodLevel = Math.max(0, Math.min(10, shared.flood));
      if (shared.mode) sharedState.travelMode = shared.mode;
      if (shared.failed) sharedState.failedSubstations = shared.failed;
      if (Object.keys(sharedState).length) set(sharedState);
      set({ cityData, substationLoads: loads, isLoading: false, backendOnline: true });
      get().addLog(`Street database loaded: ${cityData.nodes.length} intersections, ${cityData.edges.length} street segments.`);
      await get().calculateRoute();
    } catch {
      try {
        const network = await bakedPromise;
        if (!network) throw new Error('Baked street network unavailable');
        const cityData = buildOfflineCityData(network);
        const loads: Record<number, number> = {};
        cityData.substations.forEach((sub) => { loads[sub.id] = sub.base_load_mw; });
        const sharedState: Partial<SimulationStore> = {};
        if (shared.origin !== undefined && cityData.nodes.some((node) => node.id === shared.origin)) sharedState.originNode = shared.origin;
        if (shared.flood !== undefined) sharedState.floodLevel = Math.max(0, Math.min(10, shared.flood));
        if (shared.mode) sharedState.travelMode = shared.mode;
        if (shared.failed) sharedState.failedSubstations = shared.failed;
        if (Object.keys(sharedState).length) set(sharedState);
        set({ cityData, substationLoads: loads, isLoading: false, backendOnline: false, error: null });
        get().addLog('Offline mode: local OpenStreetMap street graph loaded; route solver remains available.');
        await get().calculateRoute();
      } catch {
        set({ isLoading: false, error: 'No street data is available. Check the backend connection and reload.' });
      }
    }
  },

  calculateRoute: async () => {
    const requestId = ++routeRequestSerial;
    const { floodLevel, failedSubstations, originNode, travelMode } = get();
    set({ isLoading: true, error: null });
    try {
      const response = normalizeRoute(await api.calculateRoute({ flood_level: floodLevel, failed_substations: failedSubstations, origin_node: originNode, travel_mode: travelMode }));
      if (requestId !== routeRequestSerial) return;
      setRouteTelemetry(set, response);
      set({ backendOnline: true, isLoading: false });
      get().addLog(`Route solved (${travelMode}): ${response.success ? `${formatDistance(response.distance_m)} to Node ${response.dest_node}` : 'no passable corridor'}.`);
    } catch {
      const cityData = get().cityData;
      if (requestId !== routeRequestSerial) return;
      if (!cityData) {
        set({ isLoading: false, error: 'No street data is available for route calculation.' });
        return;
      }
      const response = calculateOfflineRoute(cityData, floodLevel, failedSubstations, originNode, travelMode);
      setRouteTelemetry(set, response);
      set({ backendOnline: false, isLoading: false });
      get().addLog(`Local route solver (${travelMode}): ${response.success ? `${formatDistance(response.distance_m)} corridor found` : 'no passable corridor'}.`);
    }
    // Keep the comparison and reachability views in sync with the new state.
    void get().refreshCorridors();
    if (get().isochroneVisible) void get().refreshIsochrone();
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
  setTravelMode: (mode) => {
    set({ travelMode: mode });
    get().addLog(`Travel mode: ${mode === 'vehicle' ? 'response vehicle' : mode === 'foot' ? 'on-foot evacuation' : 'EMS priority run'}.`);
    queueRouteCalculation(get().calculateRoute);
  },
  refreshCorridors: async () => {
    const { cityData, floodLevel, failedSubstations, originNode, travelMode } = get();
    if (!cityData) return;
    if (get().backendOnline) {
      try {
        set({ corridorComparison: await api.compareCorridors(originNode, floodLevel, failedSubstations, travelMode) });
        return;
      } catch { /* fall through to local solver */ }
    }
    set({ corridorComparison: offlineCompareCorridors(cityData, originNode, floodLevel, failedSubstations, travelMode) });
  },
  setIsochroneVisible: (value) => set({ isochroneVisible: value }),
  refreshIsochrone: async () => {
    const { cityData, floodLevel, failedSubstations, originNode, travelMode, isochroneVisible } = get();
    if (!cityData || !isochroneVisible) return;
    if (get().backendOnline) {
      try {
        set({ isochrone: await api.isochrone(originNode, floodLevel, failedSubstations, travelMode, ISOCHRONE_MINUTES[travelMode]) });
        return;
      } catch { /* fall through to local solver */ }
    }
    set({ isochrone: offlineIsochrone(cityData, originNode, floodLevel, failedSubstations, travelMode, ISOCHRONE_MINUTES[travelMode]) });
  },
  setFlyToNodeId: (id) => set({ flyToNodeId: id }),
  setFlyToRoadKey: (key) => set({ flyToRoadKey: key }),
  setFlyToCoords: (coords) => set({ flyToCoords: coords }),
  setMapFilterMode: (mode) => set({ mapFilterMode: mode }),

  applyScenario: (preset) => {
    const { cityData } = get();
    const substations = cityData?.substations ?? [];
    const downtown = substations[0]?.node ?? DEFAULT_ORIGIN;
    const secondary = substations[1]?.node ?? DEFAULT_ORIGIN;
    // Bayou-rise drill: start from the driest central node so the operator
    // watches the low corridor flood while the origin stays viable.
    const centerLat = cityData?.center_lat ?? 29.7604;
    const centerLon = cityData?.center_lon ?? -95.3698;
    const bayouRiseOrigin = cityData?.nodes
      .slice()
      .filter((node) => node.elevation > 7.2 * FLOOD_RISE_PER_LEVEL)
      .sort((a, b) => Math.hypot(a.lat - centerLat, a.lon - centerLon) - Math.hypot(b.lat - centerLat, b.lon - centerLon))[0]?.id ?? downtown;
    const scenarios: Record<ScenarioPreset, { floodLevel: number; failedSubstations: number[]; originNode: number; label: string }> = {
      clear: { floodLevel: 0, failedSubstations: [], originNode: downtown, label: 'Normal operations' },
      flood: { floodLevel: 7.2, failedSubstations: [], originNode: bayouRiseOrigin, label: 'Buffalo Bayou flash flood' },
      cascade: { floodLevel: 1.8, failedSubstations: [0, 2], originNode: downtown, label: 'Downtown feeder cascade' },
      heatwave: { floodLevel: 0.4, failedSubstations: [1, 3], originNode: secondary, label: 'Peak heat and transmission strain' },
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

function distanceMeters(a: NodeData, b: NodeData) {
  const lat = (b.lat - a.lat) * 111320;
  const lon = (b.lon - a.lon) * 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(lat, lon);
}

/* ------------------------------------------------------------------ */
/* Offline city data: built from the same baked OpenStreetMap network  */
/* the backend uses, so offline mode matches online behavior exactly.  */
/* ------------------------------------------------------------------ */

function buildOfflineCityData(network: BakedNetwork): CityData {
  const nodes: NodeData[] = network.nodes.map((node) => ({
    id: node.id,
    osm: node.osm,
    lat: node.lat,
    lon: node.lon,
    elevation: node.elevation,
    intersection_name: node.intersection_name || `Node ${node.id}`,
    district: 'Houston operations district',
  }));
  const edges: EdgeData[] = network.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
    distance_m: edge.distance_m,
    road_name: edge.road_name,
    road_class: edge.road_class,
    lanes: edge.lanes,
    speed_limit_mph: edge.speed_limit_mph,
    geometry: edge.geometry ?? [],
  }));
  return {
    nodes,
    edges,
    blocks: network.blocks ?? [],
    parks: network.parks ?? [],
    substations: (network.substations ?? []).map((sub) => ({ ...sub, affected_nodes: sub.affected_nodes ?? [] })),
    transmission_links: network.transmission_links ?? [],
    center_lat: network.meta.center_lat,
    center_lon: network.meta.center_lon,
    safe_exits: network.safe_exits ?? [],
    exit_names: network.exit_names ?? {},
  };
}

/* --------------------------- offline solver --------------------------- */

function bearingLabel(a: NodeData, b: NodeData): string {
  const dLat = b.lat - a.lat;
  const dLon = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  const angle = Math.atan2(dLon, dLat) * 180 / Math.PI;
  const compass = ['northbound', 'northeastbound', 'eastbound', 'southeastbound', 'southbound', 'southwestbound', 'westbound', 'northwestbound'];
  return compass[Math.floor((((angle + 360) % 360) + 22.5) / 45) % 8];
}

function transmissionLineEdges(cityData: CityData): Record<number, [number, number][]> {
  const mapped: Record<number, [number, number][]> = {};
  cityData.transmission_links.forEach((link) => {
    const subA = cityData.substations.find((sub) => sub.id === link.from_sub);
    const subB = cityData.substations.find((sub) => sub.id === link.to_sub);
    const a = subA && cityData.nodes.find((node) => node.id === subA.node);
    const b = subB && cityData.nodes.find((node) => node.id === subB.node);
    mapped[link.id] = a && b
      ? cityData.edges.filter((edge) => {
          const start = cityData.nodes.find((node) => node.id === edge.source);
          const end = cityData.nodes.find((node) => node.id === edge.target);
          if (!start || !end) return false;
          return pointLineDistanceMeters({ lat: (start.lat + end.lat) / 2, lon: (start.lon + end.lon) / 2 }, a, b) <= 90;
        }).map((edge) => [edge.source, edge.target])
      : [];
  });
  return mapped;
}

function pointLineDistanceMeters(point: { lat: number; lon: number }, a: NodeData, b: NodeData): number {
  const cosLat = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  const px = point.lon * cosLat;
  const py = point.lat;
  const ax = a.lon * cosLat;
  const ay = a.lat;
  const bx = b.lon * cosLat;
  const by = b.lat;
  const lengthSq = (bx - ax) ** 2 + (by - ay) ** 2;
  if (!lengthSq) return Math.hypot(px - ax, py - ay) * 111320;
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSq));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))) * 111320;
}

function offlinePowerFlow(cityData: CityData, failedInputs: number[]) {
  const failed = new Set(failedInputs);
  const cascaded = new Set<number>();
  const substations = cityData.substations.map((sub) => ({ ...sub, current: sub.base_load_mw }));

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const active = substations.filter((sub) => !failed.has(sub.id) && !cascaded.has(sub.id));
    const offline = substations.filter((sub) => failed.has(sub.id) || cascaded.has(sub.id));
    active.forEach((sub) => { sub.current = sub.base_load_mw; });
    if (!active.length) break;
    offline.forEach((offlineSub) => {
      const origin = cityData.nodes.find((node) => node.id === offlineSub.node);
      if (!origin) return;
      const weights = active.map((activeSub) => {
        const target = cityData.nodes.find((node) => node.id === activeSub.node);
        if (!target) return 0;
        const distance = Math.hypot(
          origin.lat - target.lat,
          (origin.lon - target.lon) * Math.cos(origin.lat * Math.PI / 180),
        );
        return 1 / (distance + 0.001);
      });
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
        // radius is in city blocks (~150 m each), matching the bake script.
        const radiusMeters = sub.radius * 150 * (1 + 0.6 * ((sub.current - sub.capacity_mw) / sub.capacity_mw));
        const center = cityData.nodes.find((node) => node.id === sub.node);
        if (center) {
          cityData.nodes.forEach((node) => {
            const distance = Math.hypot(
              node.lat - center.lat,
              (node.lon - center.lon) * Math.cos(center.lat * Math.PI / 180),
            );
            if (distance * 111320 <= radiusMeters) blackout.add(node.id);
          });
        }
      }
    }
  });

  const ratio = capacity ? load / capacity : 1.5;
  const gridFrequency = Number(Math.max(45, Math.min(60.1, 60 - (ratio > 1 ? 1.4 * (ratio - 1) : 0.06 * (failed.size + cascaded.size)) + (Math.random() - 0.5) * 0.02)).toFixed(2));
  const voltageReadings: Record<number, number> = {};
  cityData.nodes.forEach((node) => { voltageReadings[node.id] = blackout.has(node.id) ? 0 : 100; });
  const transmission_line_states: Record<number, string> = {};
  cityData.transmission_links.forEach((link) => {
    transmission_line_states[link.id] = failed.has(link.from_sub) || failed.has(link.to_sub) || cascaded.has(link.from_sub) || cascaded.has(link.to_sub)
      ? 'dead'
      : overloaded.includes(link.from_sub) || overloaded.includes(link.to_sub) ? 'overloaded' : 'active';
  });
  return {
    substation_loads: loads,
    overloaded_substations: overloaded,
    cascaded_substations: Array.from(cascaded),
    blackout_nodes: blackout,
    voltage_readings: voltageReadings,
    grid_frequency: gridFrequency,
    transmission_line_states,
  };
}

type WeightedEdge = EdgeData & { routeWeight: number };

function buildOfflineEdgeMap(
  cityData: CityData,
  flow: ReturnType<typeof offlinePowerFlow>,
  flooded: Set<number>,
  mode: ReturnType<typeof travelModeConfig>,
) {
  const hazards = transmissionLineEdges(cityData);
  const deadEdges = new Set<string>();
  const overloadedEdges = new Set<string>();
  Object.entries(flow.transmission_line_states).forEach(([linkId, state]) => {
    hazards[Number(linkId)]?.forEach(([u, v]) => (state === 'dead' ? deadEdges : overloadedEdges).add(`${u}-${v}`));
  });
  const edgeMap = new Map<string, WeightedEdge>();
  cityData.edges.forEach((edge) => {
    if (flooded.has(edge.source) && flooded.has(edge.target)) {
      edgeMap.set(`${edge.source}-${edge.target}`, { ...edge, routeWeight: Number.POSITIVE_INFINITY });
      return;
    }
    const mph = Math.max(1, mode.mph(edge.speed_limit_mph));
    let routeWeight = edge.distance_m * 2.23694 / mph * (mode.roadClass[edge.road_class] ?? 1);
    if (flooded.has(edge.source) || flooded.has(edge.target)) routeWeight += mode.floodPartial;
    if (flow.blackout_nodes.has(edge.source) || flow.blackout_nodes.has(edge.target)) routeWeight *= mode.blackoutMult;
    if (deadEdges.has(`${edge.source}-${edge.target}`) || deadEdges.has(`${edge.target}-${edge.source}`)) routeWeight += 240;
    else if (overloadedEdges.has(`${edge.source}-${edge.target}`) || overloadedEdges.has(`${edge.target}-${edge.source}`)) routeWeight += 90;
    edgeMap.set(`${edge.source}-${edge.target}`, { ...edge, routeWeight });
  });
  return { edgeMap, deadEdges, overloadedEdges };
}

function offlineDijkstra(cityData: CityData, edgeMap: Map<string, WeightedEdge>, originNode: number) {
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
  return { distances, previous };
}

function offlinePathFrom(previous: Record<number, number | null>, destination: number): number[] {
  const path: number[] = [];
  let cursor: number | null = destination;
  while (cursor !== null) { path.unshift(cursor); cursor = previous[cursor]; }
  return path;
}

function offlinePathEdges(path: number[], edgeMap: Map<string, WeightedEdge>): WeightedEdge[] {
  return path.slice(0, -1)
    .map((from, index) => edgeMap.get(`${from}-${path[index + 1]}`) ?? edgeMap.get(`${path[index + 1]}-${from}`))
    .filter((edge): edge is WeightedEdge => Boolean(edge));
}

function buildRouteSteps(path: number[], cityData: CityData, edgeMap: Map<string, WeightedEdge>): RouteStep[] {
  const steps: Array<RouteStep & { direction: string }> = [];
  path.slice(0, -1).forEach((from, index) => {
    const to = path[index + 1];
    const edge = edgeMap.get(`${from}-${to}`) ?? edgeMap.get(`${to}-${from}`);
    const nodeA = cityData.nodes.find((node) => node.id === from);
    const nodeB = cityData.nodes.find((node) => node.id === to);
    if (!edge || !nodeA || !nodeB) return;
    const direction = bearingLabel(nodeA, nodeB);
    const previous = steps[steps.length - 1];
    if (previous && previous.road_name === edge.road_name) {
      previous.distance_m += edge.distance_m;
      previous.duration_s += edge.routeWeight;
      previous.to_node = to;
    } else {
      steps.push({
        instruction: `${previous ? 'Turn onto' : 'Depart on'} ${edge.road_name} ${direction}`,
        road_name: edge.road_name,
        road_class: edge.road_class,
        distance_m: edge.distance_m,
        duration_s: edge.routeWeight,
        from_node: from,
        to_node: to,
        direction,
      });
    }
  });
  return steps.map(({ direction: _direction, ...step }) => ({ ...step, distance_m: Number(step.distance_m.toFixed(1)), duration_s: Number(step.duration_s.toFixed(1)) }));
}

function calculateOfflineRoute(cityData: CityData, floodLevel: number, failedSubstations: number[], originNode: number, travelMode: TravelMode = 'vehicle'): RouteResponse {
  const flow = offlinePowerFlow(cityData, failedSubstations);
  const flooded = new Set(cityData.nodes.filter((node) => node.elevation <= floodLevel * FLOOD_RISE_PER_LEVEL).map((node) => node.id));
  if (flooded.has(originNode)) return failureRoute(flow, flooded, 'Starting intersection is flooded. Select a dry origin on higher ground.');
  const mode = travelModeConfig(travelMode);
  const { edgeMap, deadEdges, overloadedEdges } = buildOfflineEdgeMap(cityData, flow, flooded, mode);

  const { distances, previous } = offlineDijkstra(cityData, edgeMap, originNode);
  let destination = -1;
  SAFE_EXITS.forEach((exit) => {
    if (cityData.nodes.some((node) => node.id === exit) && !flooded.has(exit) && distances[exit] < (destination < 0 ? Number.POSITIVE_INFINITY : distances[destination])) destination = exit;
  });
  if (destination < 0 || !Number.isFinite(distances[destination])) return failureRoute(flow, flooded, 'No passable street corridor found. Floodwater and utility hazards isolate this origin.');
  const path = offlinePathFrom(previous, destination);

  // Interleave street-curve geometry so the drawn route follows real roads.
  const pathCoords: Array<{ lat: number; lon: number; elevation: number }> = [];
  path.slice(0, -1).forEach((from, index) => {
    const to = path[index + 1];
    const node = cityData.nodes.find((item) => item.id === from);
    if (!node) return;
    pathCoords.push({ lat: node.lat, lon: node.lon, elevation: Number((node.elevation + 0.65).toFixed(2)) });
    const edge = edgeMap.get(`${from}-${to}`) ?? edgeMap.get(`${to}-${from}`);
    (edge?.geometry ?? []).forEach(([lat, lon]) => pathCoords.push({ lat, lon, elevation: 0 }));
  });
  const lastNode = cityData.nodes.find((item) => item.id === path[path.length - 1]);
  if (lastNode) pathCoords.push({ lat: lastNode.lat, lon: lastNode.lon, elevation: Number((lastNode.elevation + 0.65).toFixed(2)) });

  const pathEdges = offlinePathEdges(path, edgeMap);
  const distance_m = Number(pathEdges.reduce((sum, edge) => sum + edge.distance_m, 0).toFixed(1));
  const failedCount = failedSubstations.length + flow.cascaded_substations.length;
  const anomaly_score = Math.min(1, Number((0.04 + floodLevel * 0.05 + failedCount * 0.14 + flow.overloaded_substations.length * 0.08).toFixed(4)));
  const risk_level = anomaly_score >= 0.78 ? 'CRITICAL' : anomaly_score >= 0.55 ? 'HIGH' : anomaly_score >= 0.3 ? 'MEDIUM' : 'LOW';
  const hazard_roads: Record<string, string> = {};
  cityData.edges.forEach((edge) => {
    if (deadEdges.has(`${edge.source}-${edge.target}`)) hazard_roads[`${edge.source}-${edge.target}`] = 'dead';
    else if (overloadedEdges.has(`${edge.source}-${edge.target}`)) hazard_roads[`${edge.source}-${edge.target}`] = 'overloaded';
  });
  const destinationNode = cityData.nodes.find((node) => node.id === destination);
  const exitLabel = destinationNode && destinationNode.intersection_name !== 'Intersection' ? destinationNode.intersection_name : `Node ${destination}`;
  return {
    success: true,
    path,
    path_coords: pathCoords,
    total_nodes: path.length,
    distance_m,
    eta_minutes: Number((distances[destination] / 60).toFixed(1)),
    route_steps: buildRouteSteps(path, cityData, edgeMap),
    flooded_nodes: Array.from(flooded),
    blackout_nodes: Array.from(flow.blackout_nodes),
    blocked_edges: cityData.edges.filter((edge) => flooded.has(edge.source) && flooded.has(edge.target)).map((edge) => [edge.source, edge.target]),
    anomaly_score,
    risk_level,
    message: `Safest street corridor mapped to ${exitLabel}.`,
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

function failureRoute(flow: ReturnType<typeof offlinePowerFlow>, flooded: Set<number>, message: string): RouteResponse {
  const failedCount = flow.cascaded_substations.length;
  return {
    success: false,
    path: [],
    path_coords: [],
    total_nodes: 0,
    distance_m: 0,
    eta_minutes: 0,
    route_steps: [],
    flooded_nodes: Array.from(flooded),
    blackout_nodes: Array.from(flow.blackout_nodes),
    blocked_edges: [],
    anomaly_score: Math.min(1, 0.65 + failedCount * 0.1),
    risk_level: 'CRITICAL',
    message,
    dest_node: -1,
    substation_loads: flow.substation_loads,
    overloaded_substations: flow.overloaded_substations, // keep shape
    cascaded_substations: flow.cascaded_substations,
    grid_frequency: flow.grid_frequency,
    voltage_readings: flow.voltage_readings,
    transmission_line_states: flow.transmission_line_states,
    usgs_gage_height: 4.2,
    surface_temp: 88,
    hazard_roads: {},
  };
}

/* --------------------- offline corridor + isochrone --------------------- */

function offlineCompareCorridors(cityData: CityData, origin: number, floodLevel: number, failed: number[], mode: TravelMode): CorridorComparisonResponse {
  const flow = offlinePowerFlow(cityData, failed);
  const flooded = new Set(cityData.nodes.filter((node) => node.elevation <= floodLevel * FLOOD_RISE_PER_LEVEL).map((node) => node.id));
  const dryExits = SAFE_EXITS.filter((exit) => cityData.nodes.some((node) => node.id === exit) && !flooded.has(exit));
  const { edgeMap, deadEdges } = buildOfflineEdgeMap(cityData, flow, flooded, travelModeConfig(mode));

  const nodesById = new Map(cityData.nodes.map((node) => [node.id, node]));
  const corridors: CorridorInfo[] = [];
  if (dryExits.length && nodesById.has(origin)) {
    const { distances, previous } = offlineDijkstra(cityData, edgeMap, origin);
    dryExits.forEach((exit) => {
      const cost = distances[exit];
      if (cost === undefined || !Number.isFinite(cost)) return;
      const path = offlinePathFrom(previous, exit);
      const pathEdgeList = offlinePathEdges(path, edgeMap);
      const hazardCount = pathEdgeList.filter((edge) =>
        deadEdges.has(`${edge.source}-${edge.target}`)
        || deadEdges.has(`${edge.target}-${edge.source}`)
        || flow.blackout_nodes.has(edge.source)
        || flow.blackout_nodes.has(edge.target)).length;
      corridors.push({
        exit_node: exit,
        exit_name: nodesById.get(exit)?.intersection_name || `Exit ${exit}`,
        eta_minutes: Number((cost / 60).toFixed(1)),
        distance_m: Number(pathEdgeList.reduce((sum, edge) => sum + edge.distance_m, 0).toFixed(1)),
        hazard_count: hazardCount,
        path_length: path.length,
      });
    });
  }
  corridors.sort((a, b) => a.eta_minutes - b.eta_minutes);
  return { origin, travel_mode: mode, corridors, flooded_nodes: Array.from(flooded), blackout_nodes: Array.from(flow.blackout_nodes) };
}

function offlineIsochrone(cityData: CityData, origin: number, floodLevel: number, failed: number[], mode: TravelMode, minutes: number[]): IsochroneResponse {
  const flow = offlinePowerFlow(cityData, failed);
  const flooded = new Set(cityData.nodes.filter((node) => node.elevation <= floodLevel * FLOOD_RISE_PER_LEVEL).map((node) => node.id));
  const modeCfg = travelModeConfig(mode);
  const { edgeMap } = buildOfflineEdgeMap(cityData, flow, flooded, modeCfg);
  const { distances } = offlineDijkstra(cityData, edgeMap, origin);
  const limits = (minutes.length ? minutes : ISOCHRONE_MINUTES[mode]).slice().sort((a, b) => a - b).map((m) => m * 60);
  const rings = limits.map((limit) => {
    const nodes = Object.entries(distances)
      .filter(([, cost]) => cost <= limit)
      .map(([id]) => Number(id));
    return { minutes: Number((limit / 60).toFixed(1)), node_count: nodes.length, nodes };
  });
  return { origin, travel_mode: mode, rings, flooded_nodes: Array.from(flooded), blackout_nodes: Array.from(flow.blackout_nodes) };
}
