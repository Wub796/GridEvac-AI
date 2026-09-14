import { create } from 'zustand';
import { api, type ScenarioQuery } from '@/lib/api';
import type { OperatorEvent } from '@/lib/exports';
import { logicalJunctions } from '@/lib/network';
import { fetchObservations } from '@/lib/observations';
import {
  ISOCHRONE_MINUTES,
  compareCorridors,
  edgeKey,
  floodStage,
  solveIsochrone,
  solveRoute,
  solveTriggerPoints,
  vehicleCore,
  waterSurfaceM,
} from '@/lib/solver';
import type {
  BlockData,
  CityData,
  CorridorComparisonResponse,
  IsochroneResponse,
  NodeData,
  ObservationsResponse,
  RouteResponse,
  ShelterData,
  SubstationData,
  TravelMode,
  TriggerPointsResponse,
} from '@/lib/types';

/**
 * The baked OpenStreetMap network is a static asset, not a JS import, so it
 * never enters the application bundle. It is fetched once when the backend is
 * unreachable and shared by the offline map and solver.
 */
type BakedNetwork = Omit<CityData, 'center_lat' | 'center_lon' | 'nodes' | 'flood_model'> & {
  nodes: Array<Omit<NodeData, 'district'>>;
  meta: {
    center_lat: number;
    center_lon: number;
    vertical_datum?: string;
    elevation_source?: string;
    flood_model?: { method: string; datum_m: number; rise_per_level_m: number; gage: CityData['flood_model'] extends infer M ? M extends { gage: infer G } ? G : never : never };
  };
};

let bakedNetwork: Promise<BakedNetwork> | null = null;

function loadBakedNetwork(): Promise<BakedNetwork> {
  // The baked graph only changes on deploy, so repeat visits resolve from the
  // HTTP cache instead of refetching ~1.9 MB.
  bakedNetwork ??= fetch('/data/houston_network.json', { cache: 'force-cache' }).then((response) => {
    if (!response.ok) throw new Error('Baked street network unavailable');
    return response.json() as Promise<BakedNetwork>;
  }).catch((error) => {
    bakedNetwork = null;
    throw error;
  });
  return bakedNetwork;
}

export type Section = 'briefing' | 'map' | 'audit';
export type Basemap = 'dark' | 'light' | 'aerial';
export type ScenarioPreset = 'clear' | 'flood' | 'cascade' | 'heatwave';
export type { OperatorEvent };

/** A saved operating picture plus its outcome, so two snapshots can be compared later. */
export interface ScenarioSnapshot {
  id: string;
  label: string;
  savedAt: number;
  originNode: number;
  floodLevel: number;
  failedSubstations: number[];
  travelMode: TravelMode;
  evacuees: number;
  destinationId: string | null;
  closures: Array<[number, number]>;
  outcome: { success: boolean; eta_minutes: number; distance_m: number; dest_node: number; risk_level: string };
}

type SimulationStore = {
  floodLevel: number;
  failedSubstations: number[];
  originNode: number;
  closures: Array<[number, number]>;
  closureMode: boolean;

  gridFrequency: number;
  substationLoads: Record<number, number>;
  overloadedSubstations: number[];
  cascadedSubstations: number[];
  floodedSubstations: number[];
  frequencyHistory: number[];
  events: OperatorEvent[];
  observations: ObservationsResponse | null;

  showBuildings: boolean;
  showPowerLines: boolean;
  showSubstations: boolean;
  showIntersections: boolean;
  showRoadNames: boolean;
  showWaterways: boolean;
  basemap: Basemap;
  flyToNodeId: number | null;
  flyToRoadKey: string | null;
  flyToCoords: { lon: number; lat: number; elev: number; heading?: number; pitch?: number } | null;
  highlightedStep: number | null;
  activeSection: Section;

  travelMode: TravelMode;
  evacuees: number;
  destinationId: string | null;
  corridorComparison: CorridorComparisonResponse | null;
  isochrone: IsochroneResponse | null;
  isochroneVisible: boolean;
  triggerPoints: TriggerPointsResponse | null;

  snapshots: ScenarioSnapshot[];
  activeSnapshotId: string | null;

  cityData: CityData | null;
  route: RouteResponse | null;
  lastSolvedAt: string | null;
  isLoading: boolean;
  backendOnline: boolean;
  error: string | null;

  addLog: (message: string, kind?: OperatorEvent['kind']) => void;
  fetchCityData: () => Promise<void>;
  loadCity: () => Promise<void>;
  reconnect: () => Promise<void>;
  calculateRoute: () => Promise<void>;
  refreshAnalysis: () => Promise<void>;
  refreshIsochrone: () => Promise<void>;
  refreshObservations: () => Promise<void>;
  syncFloodToGage: () => void;
  triggerLiveTick: () => void;

  setFloodLevel: (value: number) => void;
  toggleSubstation: (id: number) => void;
  setOriginNode: (id: number) => void;
  setTravelMode: (mode: TravelMode) => void;
  setEvacuees: (value: number) => void;
  setDestination: (id: string | null) => void;
  toggleClosure: (source: number, target: number) => void;
  clearClosures: () => void;
  setClosureMode: (value: boolean) => void;
  applyScenario: (preset: ScenarioPreset) => void;

  saveSnapshot: (label: string) => void;
  applySnapshot: (id: string) => void;
  deleteSnapshot: (id: string) => void;

  setShowBuildings: (value: boolean) => void;
  setShowPowerLines: (value: boolean) => void;
  setShowSubstations: (value: boolean) => void;
  setShowIntersections: (value: boolean) => void;
  setShowRoadNames: (value: boolean) => void;
  setShowWaterways: (value: boolean) => void;
  setBasemap: (value: Basemap) => void;
  setIsochroneVisible: (value: boolean) => void;
  setFlyToNodeId: (id: number | null) => void;
  setFlyToRoadKey: (key: string | null) => void;
  setFlyToCoords: (coords: SimulationStore['flyToCoords']) => void;
  setHighlightedStep: (index: number | null) => void;
  setActiveSection: (section: Section) => void;
};

const MAX_EVENTS = 250;
const SNAPSHOT_KEY = 'gridevac-snapshots';
let eventSerial = 0;
let routeRequestSerial = 0;
// One city load per page: React strict mode runs mount effects twice in
// development, which previously solved and logged the first route twice.
let cityLoad: Promise<void> | null = null;
let recalculateTimer: ReturnType<typeof setTimeout> | null = null;
const pendingReasons = new Map<string, string>();

const TRAVEL_MODE_LABELS: Record<TravelMode, string> = { vehicle: 'response vehicle', foot: 'on-foot evacuation', ems: 'EMS priority run' };

const PRESETS: Record<ScenarioPreset, { label: string; floodLevel: number; failedSubstations: number[] }> = {
  clear: { label: 'Normal operations', floodLevel: 0, failedSubstations: [] },
  flood: { label: 'Buffalo Bayou flood', floodLevel: 8, failedSubstations: [] },
  cascade: { label: 'Downtown feeder cascade', floodLevel: 0, failedSubstations: [0, 2] },
  heatwave: { label: 'Peak heat and transmission strain', floodLevel: 0, failedSubstations: [1, 3] },
};

const nodeIndexes = new WeakMap<CityData, Map<number, NodeData>>();
function nodeById(city: CityData | null, id: number): NodeData | undefined {
  if (!city) return undefined;
  let index = nodeIndexes.get(city);
  if (!index) {
    index = new Map(city.nodes.map((node) => [node.id, node]));
    nodeIndexes.set(city, index);
  }
  return index.get(id);
}

/**
 * A sensible origin: a real street junction vehicles can leave, not a bridge
 * deck or exit, dry by `margin` metres at `surface`, nearest `near`.
 */
function pickOrigin(city: CityData, surface: number, near: { lat: number; lon: number }, margin = 1): number | null {
  const junctions = logicalJunctions(city).ids;
  const core = vehicleCore(city);
  const exits = new Set(city.safe_exits);
  let best: NodeData | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  city.nodes.forEach((node) => {
    if (!junctions.has(node.id) || !core.has(node.id) || exits.has(node.id) || node.elevated) return;
    if (floodStage(node) <= surface + margin) return;
    const distance = Math.hypot(node.lat - near.lat, (node.lon - near.lon) * Math.cos((near.lat * Math.PI) / 180));
    if (distance < bestDistance) { best = node; bestDistance = distance; }
  });
  return best ? (best as NodeData).id : null;
}

function queueRouteCalculation(get: () => SimulationStore, key: string, reason: string) {
  pendingReasons.set(key, reason);
  if (recalculateTimer) clearTimeout(recalculateTimer);
  recalculateTimer = setTimeout(() => {
    recalculateTimer = null;
    // One log line per settled change: dragging a slider no longer writes a
    // hundred events into the audit trail.
    pendingReasons.forEach((message) => get().addLog(message, 'action'));
    pendingReasons.clear();
    void get().calculateRoute();
  }, 160);
}

function normalizeRoute(route: RouteResponse): RouteResponse {
  return {
    ...route,
    path_coords: route.path_coords ?? [],
    blocked_edges: route.blocked_edges ?? [],
    closed_edges: route.closed_edges ?? [],
    flooded_substations: route.flooded_substations ?? [],
    distance_m: route.distance_m ?? 0,
    eta_minutes: route.eta_minutes ?? 0,
    congested_eta_minutes: route.congested_eta_minutes ?? route.eta_minutes ?? 0,
    congestion_factor: route.congestion_factor ?? 1,
    water_surface_m: route.water_surface_m ?? 0,
    destination_name: route.destination_name ?? '',
    destination_kind: route.destination_kind ?? '',
    route_steps: (route.route_steps ?? []).map((step) => ({ ...step, maneuver: step.maneuver ?? 'continue', bearing: step.bearing ?? 0 })),
    hazard_roads: route.hazard_roads ?? {},
  };
}

function normalizeCityData(data: CityData): CityData {
  return {
    ...data,
    nodes: (data.nodes ?? []).map((node) => ({ ...node, intersection_name: node.intersection_name || `Node ${node.id}`, district: node.district || 'Houston operations district' })),
    edges: (data.edges ?? []).map((edge) => ({ ...edge, road_name: edge.road_name || 'Unnamed street', road_class: edge.road_class || 'local', lanes: edge.lanes || 2, speed_limit_mph: edge.speed_limit_mph || 25, oneway: edge.oneway ?? 0, geometry: edge.geometry ?? [] })),
    blocks: (data.blocks ?? []).map((block: BlockData) => ({ ...block, footprint: block.footprint ?? [] })),
    parks: data.parks ?? [],
    waterways: data.waterways ?? [],
    substations: (data.substations ?? []).map((sub: SubstationData) => ({ ...sub, affected_nodes: sub.affected_nodes ?? [] })),
    transmission_links: data.transmission_links ?? [],
    safe_exits: data.safe_exits ?? [],
    exit_names: data.exit_names ?? {},
    shelters: (data.shelters ?? []).map((shelter: ShelterData) => ({ ...shelter, kind: shelter.kind === 'medical' ? 'medical' : 'shelter' })),
  };
}

function buildOfflineCityData(network: BakedNetwork): CityData {
  const meta = network.meta;
  return normalizeCityData({
    ...network,
    nodes: network.nodes.map((node) => ({ ...node, district: 'Houston operations district' })),
    center_lat: meta.center_lat,
    center_lon: meta.center_lon,
    flood_model: meta.flood_model ? {
      method: meta.flood_model.method,
      datum_m: meta.flood_model.datum_m,
      rise_per_level_m: meta.flood_model.rise_per_level_m,
      vertical_datum: meta.vertical_datum ?? 'NAVD88',
      elevation_source: meta.elevation_source ?? '',
      gage: meta.flood_model.gage ?? {},
    } : undefined,
  } as CityData);
}

interface SharedScenario {
  origin?: number;
  flood?: number;
  mode?: TravelMode;
  failed?: number[];
  evacuees?: number;
  dest?: string;
  closed?: Array<[number, number]>;
}

/** Deep-link restore: a shared link drops the recipient into the same operating picture. */
function readSharedScenario(): SharedScenario {
  if (typeof window === 'undefined' || !window.location.search) return {};
  const params = new URLSearchParams(window.location.search);
  const number = (key: string) => {
    const value = params.get(key);
    return value !== null && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined;
  };
  return {
    origin: number('origin'),
    flood: number('flood'),
    mode: (['vehicle', 'foot', 'ems'] as const).find((mode) => mode === params.get('mode')),
    failed: params.get('failed')?.split(',').map(Number).filter(Number.isInteger),
    evacuees: number('evacuees'),
    dest: params.get('dest') || undefined,
    closed: params.get('closed')?.split(',').map((pair) => pair.split('-').map(Number) as [number, number]).filter((pair) => pair.length === 2 && pair.every(Number.isInteger)),
  };
}

export function scenarioUrl(state: Pick<SimulationStore, 'originNode' | 'floodLevel' | 'travelMode' | 'failedSubstations' | 'evacuees' | 'destinationId' | 'closures'>): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams({ origin: String(state.originNode), flood: state.floodLevel.toFixed(2), mode: state.travelMode });
  if (state.failedSubstations.length) params.set('failed', state.failedSubstations.join(','));
  if (state.evacuees > 0) params.set('evacuees', String(state.evacuees));
  if (state.destinationId) params.set('dest', state.destinationId);
  if (state.closures.length) params.set('closed', state.closures.map(([u, v]) => `${u}-${v}`).join(','));
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function readSnapshots(): ScenarioSnapshot[] {
  try {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(SNAPSHOT_KEY) : null;
    const parsed = stored ? (JSON.parse(stored) as Partial<ScenarioSnapshot>[]) : [];
    return parsed.filter((snap) => typeof snap?.id === 'string').map((snap) => ({
      evacuees: 0,
      destinationId: null,
      closures: [],
      ...snap,
    }) as ScenarioSnapshot);
  } catch {
    return [];
  }
}

function writeSnapshots(snapshots: ScenarioSnapshot[]) {
  try { window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots)); } catch { /* private mode: session only */ }
}

export const useSimulationStore = create<SimulationStore>((set, get) => {
  const scenarioQuery = (): ScenarioQuery => {
    const state = get();
    return { origin: state.originNode, floodLevel: state.floodLevel, failed: state.failedSubstations, mode: state.travelMode, evacuees: state.evacuees, closures: state.closures };
  };
  const solverInput = () => {
    const state = get();
    return { origin: state.originNode, floodLevel: state.floodLevel, failedSubstations: state.failedSubstations, travelMode: state.travelMode, evacuees: state.evacuees, destination: state.destinationId, closures: state.closures };
  };

  return {
    floodLevel: 0,
    failedSubstations: [],
    originNode: 0,
    closures: [],
    closureMode: false,

    gridFrequency: 60,
    substationLoads: {},
    overloadedSubstations: [],
    cascadedSubstations: [],
    floodedSubstations: [],
    frequencyHistory: Array(24).fill(60),
    events: [],
    observations: null,

    showBuildings: true,
    showPowerLines: false,
    showSubstations: true,
    showIntersections: true,
    showRoadNames: false,
    showWaterways: true,
    basemap: 'dark',
    flyToNodeId: null,
    flyToRoadKey: null,
    flyToCoords: null,
    highlightedStep: null,
    activeSection: 'briefing',

    travelMode: 'vehicle',
    evacuees: 0,
    destinationId: null,
    corridorComparison: null,
    isochrone: null,
    isochroneVisible: false,
    triggerPoints: null,

    snapshots: [],
    activeSnapshotId: null,

    cityData: null,
    route: null,
    lastSolvedAt: null,
    isLoading: false,
    backendOnline: false,
    error: null,

    addLog: (message, kind = 'action') => {
      eventSerial += 1;
      const event: OperatorEvent = { id: eventSerial, at: new Date().toISOString(), kind, message };
      set((state) => ({ events: [event, ...state.events].slice(0, MAX_EVENTS) }));
    },

    fetchCityData: () => {
      if (cityLoad && !get().error) return cityLoad;
      cityLoad = get().loadCity();
      return cityLoad;
    },

    loadCity: async () => {
      set({ isLoading: true, error: null, snapshots: readSnapshots() });
      // Start the static network download immediately: if the API is down the
      // offline graph is already mid-flight instead of starting cold.
      const baked = loadBakedNetwork().catch(() => null);
      const shared = readSharedScenario();
      let city: CityData | null = null;
      let online = false;
      try {
        city = normalizeCityData(await api.getCityData());
        online = true;
      } catch {
        const network = await baked;
        if (network) city = buildOfflineCityData(network);
      }
      if (!city) {
        set({ isLoading: false, error: 'No street data is available. Check the network connection, then reload.' });
        return;
      }

      const next: Partial<SimulationStore> = {
        cityData: city,
        backendOnline: online,
        substationLoads: Object.fromEntries(city.substations.map((sub) => [sub.id, sub.base_load_mw])),
      };
      const hasShared = Object.values(shared).some((value) => value !== undefined);
      if (shared.origin !== undefined && nodeById(city, shared.origin)) next.originNode = shared.origin;
      if (shared.flood !== undefined) next.floodLevel = Math.max(0, Math.min(10, shared.flood));
      if (shared.mode) next.travelMode = shared.mode;
      if (shared.failed) next.failedSubstations = shared.failed.filter((id) => city!.substations.some((sub) => sub.id === id));
      if (shared.evacuees !== undefined) next.evacuees = Math.max(0, Math.min(200_000, Math.round(shared.evacuees)));
      if (shared.dest && city.shelters?.some((shelter) => shelter.id === shared.dest)) next.destinationId = shared.dest;
      if (shared.closed) {
        const known = new Set(city.edges.map((edge) => edgeKey(edge.source, edge.target)));
        next.closures = shared.closed.filter(([u, v]) => known.has(edgeKey(u, v)));
      }
      if (next.originNode === undefined) {
        next.originNode = pickOrigin(city, waterSurfaceM(city, next.floodLevel ?? 0), { lat: city.center_lat, lon: city.center_lon }) ?? city.nodes[0]?.id ?? 0;
      }
      set({ ...next, isLoading: false });
      get().addLog(online
        ? `Connected to the routing API: ${city.nodes.length.toLocaleString()} junctions, ${city.edges.length.toLocaleString()} street segments.`
        : `Working offline from the baked OpenStreetMap network: ${city.nodes.length.toLocaleString()} junctions. The local solver mirrors the API.`, 'system');
      if (hasShared) get().addLog('Shared scenario restored from the link.', 'system');
      await get().calculateRoute();
      void get().refreshObservations();
    },

    reconnect: async () => {
      const online = await api.health();
      set({ backendOnline: online });
      get().addLog(online ? 'Routing API reachable again; results now come from the API.' : 'Routing API still unreachable; staying on the local solver.', online ? 'system' : 'warning');
      if (online) await get().calculateRoute();
    },

    calculateRoute: async () => {
      const requestId = ++routeRequestSerial;
      const { cityData, backendOnline, originNode, floodLevel, failedSubstations, travelMode, evacuees, destinationId, closures } = get();
      if (!cityData) return;
      set({ isLoading: true, error: null });
      let online = backendOnline;
      let response: RouteResponse;
      if (online) {
        try {
          response = normalizeRoute(await api.calculateRoute({
            origin_node: originNode, flood_level: floodLevel, failed_substations: failedSubstations,
            travel_mode: travelMode, evacuees, destination: destinationId, closed_edges: closures,
          }));
        } catch {
          online = false;
          response = solveRoute(cityData, solverInput());
          get().addLog('Routing API stopped responding; switched to the local solver.', 'warning');
        }
      } else {
        response = solveRoute(cityData, solverInput());
      }
      if (requestId !== routeRequestSerial) return;
      set({
        route: response,
        backendOnline: online,
        isLoading: false,
        lastSolvedAt: new Date().toISOString(),
        gridFrequency: response.grid_frequency,
        substationLoads: response.substation_loads,
        overloadedSubstations: response.overloaded_substations,
        cascadedSubstations: response.cascaded_substations,
        floodedSubstations: response.flooded_substations,
        highlightedStep: null,
      });
      const destination = response.destination_name
        || cityData.exit_names?.[String(response.dest_node)]
        || nodeById(cityData, response.dest_node)?.intersection_name
        || `node ${response.dest_node}`;
      get().addLog(response.success
        ? `Route solved (${TRAVEL_MODE_LABELS[travelMode]}): ${formatDistance(response.distance_m)} to ${destination}, ${response.eta_minutes.toFixed(1)} min.`
        : `No passable corridor: ${response.message}`, response.success ? 'result' : 'warning');
      response.flooded_substations.forEach((id) => {
        if (!get().floodedSubstations.includes(id)) return;
        const name = cityData.substations.find((sub) => sub.id === id)?.name ?? `Substation ${id}`;
        if (!get().events.slice(0, 8).some((event) => event.message.startsWith(name))) get().addLog(`${name} is under water and tripped offline.`, 'warning');
      });
      void get().refreshAnalysis();
    },

    refreshAnalysis: async () => {
      const { cityData, backendOnline, isochroneVisible, originNode, travelMode, closures } = get();
      if (!cityData) return;
      const input = solverInput();
      const serial = routeRequestSerial;
      if (backendOnline) {
        const query = scenarioQuery();
        const [corridors, triggers] = await Promise.allSettled([
          api.compareCorridors(query),
          api.triggerPoints(originNode, travelMode, closures),
        ]);
        if (serial !== routeRequestSerial) return;
        set({
          corridorComparison: corridors.status === 'fulfilled' ? corridors.value : compareCorridors(cityData, input),
          triggerPoints: triggers.status === 'fulfilled' ? triggers.value : solveTriggerPoints(cityData, originNode, travelMode, closures),
        });
      } else {
        set({
          corridorComparison: compareCorridors(cityData, input),
          triggerPoints: solveTriggerPoints(cityData, originNode, travelMode, closures),
        });
      }
      if (isochroneVisible) void get().refreshIsochrone();
    },

    refreshIsochrone: async () => {
      const { cityData, backendOnline, isochroneVisible, travelMode } = get();
      if (!cityData || !isochroneVisible) return;
      const minutes = ISOCHRONE_MINUTES[travelMode];
      if (backendOnline) {
        try {
          set({ isochrone: await api.isochrone(scenarioQuery(), minutes) });
          return;
        } catch { /* local solver below */ }
      }
      set({ isochrone: solveIsochrone(cityData, { ...solverInput(), minutes }) });
    },

    refreshObservations: async () => {
      const { cityData, backendOnline } = get();
      if (!cityData) return;
      const observations = await fetchObservations(cityData, backendOnline);
      const previous = get().observations;
      set({ observations });
      if (!previous) {
        const gage = observations.gage_height;
        get().addLog(gage.status === 'live'
          ? `USGS ${cityData.flood_model?.gage.site ?? '08074000'} reports ${gage.value?.toFixed(2)} ft (${observations.gage_water_surface_m?.toFixed(2)} m NAVD88).`
          : 'Live river gage unavailable; scenario values are modeled only.', gage.status === 'live' ? 'system' : 'warning');
      }
    },

    syncFloodToGage: () => {
      const { observations, cityData } = get();
      if (!observations || observations.equivalent_flood_level === null || !cityData) return;
      get().setFloodLevel(observations.equivalent_flood_level);
      pendingReasons.set('flood', `Water surface synced to the live USGS ${cityData.flood_model?.gage.site ?? ''} reading: ${observations.gage_height.value?.toFixed(2)} ft (${observations.gage_water_surface_m?.toFixed(2)} m NAVD88).`);
    },

    triggerLiveTick: () => {
      const { route, cityData, gridFrequency, substationLoads } = get();
      if (!route || !cityData) return;
      // Simulated SCADA jitter that mean-reverts to the solved power flow:
      // readings breathe around the scenario instead of drifting away from it.
      const noise = () => Math.random() + Math.random() - 1;
      const target = route.grid_frequency || 60;
      const nextFrequency = Number(Math.max(45, Math.min(60.1, gridFrequency + 0.3 * (target - gridFrequency) + noise() * 0.012)).toFixed(2));
      const nextLoads: Record<number, number> = {};
      cityData.substations.forEach((sub) => {
        const solved = route.substation_loads[sub.id] ?? sub.base_load_mw;
        const current = substationLoads[sub.id] ?? solved;
        nextLoads[sub.id] = solved === 0 ? 0 : Number(Math.max(0, current + 0.3 * (solved - current) + noise() * 0.9).toFixed(1));
      });
      set((state) => ({
        gridFrequency: nextFrequency,
        substationLoads: nextLoads,
        frequencyHistory: [...state.frequencyHistory.slice(1), nextFrequency],
      }));
    },

    setFloodLevel: (value) => {
      const next = Math.round(Math.max(0, Math.min(10, value)) * 100) / 100;
      const { cityData, originNode } = get();
      let nextOrigin = originNode;
      if (cityData) {
        const surface = waterSurfaceM(cityData, next);
        const current = nodeById(cityData, originNode);
        if (current && floodStage(current) <= surface) {
          const replacement = pickOrigin(cityData, surface, current, 0.25);
          if (replacement !== null) {
            nextOrigin = replacement;
            pendingReasons.set('origin', `Origin ${current.intersection_name} went under water; moved to the nearest dry junction, ${nodeById(cityData, replacement)?.intersection_name}.`);
          }
        }
        pendingReasons.set('flood', `Water surface set to ${surface.toFixed(2)} m NAVD88 (level ${next.toFixed(1)}).`);
      }
      set({ floodLevel: next, originNode: nextOrigin, activeSnapshotId: null });
      queueRouteCalculation(get, 'flood', pendingReasons.get('flood') ?? `Scenario level ${next.toFixed(1)}.`);
    },

    toggleSubstation: (id) => {
      const { failedSubstations, cityData } = get();
      const failed = failedSubstations.includes(id);
      const nextFailed = failed ? failedSubstations.filter((item) => item !== id) : [...failedSubstations, id];
      const name = cityData?.substations.find((sub) => sub.id === id)?.name ?? `Substation ${id}`;
      set({ failedSubstations: nextFailed, activeSnapshotId: null });
      queueRouteCalculation(get, `substation-${id}`, `${name}: ${failed ? 'returned to service' : 'manual outage applied'}.`);
    },

    setOriginNode: (id) => {
      const node = nodeById(get().cityData, id);
      set({ originNode: id, activeSnapshotId: null });
      queueRouteCalculation(get, 'origin', `Origin set to ${node?.intersection_name ?? `node ${id}`}.`);
    },

    setTravelMode: (mode) => {
      set({ travelMode: mode, activeSnapshotId: null });
      queueRouteCalculation(get, 'mode', `Travel mode: ${TRAVEL_MODE_LABELS[mode]}.`);
    },

    setEvacuees: (value) => {
      const next = Math.max(0, Math.min(200_000, Math.round(value)));
      set({ evacuees: next, activeSnapshotId: null });
      queueRouteCalculation(get, 'demand', next === 0 ? 'Evacuation demand cleared: free-flow travel times.' : `Evacuation demand: ${next.toLocaleString()} people leaving within the hour.`);
    },

    setDestination: (id) => {
      const shelter = get().cityData?.shelters?.find((item) => item.id === id);
      set({ destinationId: shelter ? shelter.id : null, activeSnapshotId: null });
      queueRouteCalculation(get, 'destination', shelter
        ? `Destination set: ${shelter.name} (${shelter.kind === 'medical' ? 'medical facility' : 'shelter'}, capacity ${shelter.capacity.toLocaleString()}).`
        : 'Destination cleared; routing to the safest dry perimeter exit.');
    },

    toggleClosure: (source, target) => {
      const { closures, cityData } = get();
      const key = edgeKey(source, target);
      const exists = closures.some(([u, v]) => edgeKey(u, v) === key);
      const edge = cityData?.edges.find((item) => edgeKey(item.source, item.target) === key);
      set({ closures: exists ? closures.filter(([u, v]) => edgeKey(u, v) !== key) : [...closures, [source, target]], activeSnapshotId: null });
      const road = edge?.road_name && edge.road_name !== 'Unnamed street' ? edge.road_name : 'street segment';
      const near = [nodeById(cityData, source)?.intersection_name, nodeById(cityData, target)?.intersection_name]
        .find((name) => name && name !== road && !name.startsWith('Node '));
      queueRouteCalculation(get, `closure-${key}`, `${exists ? 'Reopened' : 'Closed'} ${road}${near ? ` near ${near}` : ''}.`);
    },

    clearClosures: () => {
      if (!get().closures.length) return;
      set({ closures: [], activeSnapshotId: null });
      queueRouteCalculation(get, 'closures', 'All operator road closures reopened.');
    },

    setClosureMode: (value) => set({ closureMode: value }),

    applyScenario: (preset) => {
      const { cityData } = get();
      if (!cityData) return;
      const scenario = PRESETS[preset];
      const surface = waterSurfaceM(cityData, scenario.floodLevel);
      const origin = pickOrigin(cityData, surface, { lat: cityData.center_lat, lon: cityData.center_lon }) ?? get().originNode;
      set({ floodLevel: scenario.floodLevel, failedSubstations: scenario.failedSubstations, originNode: origin, closures: [], destinationId: null, activeSnapshotId: null });
      pendingReasons.clear();
      queueRouteCalculation(get, 'preset', `Scenario loaded: ${scenario.label} (water surface ${surface.toFixed(1)} m NAVD88).`);
    },

    saveSnapshot: (label) => {
      const { originNode, floodLevel, failedSubstations, travelMode, evacuees, destinationId, closures, route, snapshots } = get();
      const snapshot: ScenarioSnapshot = {
        id: `snap-${Date.now()}-${Math.round(Math.random() * 1e4)}`,
        label: label.trim() || `Scenario ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false })}`,
        savedAt: Date.now(),
        originNode,
        floodLevel,
        failedSubstations: [...failedSubstations],
        travelMode,
        evacuees,
        destinationId,
        closures: [...closures],
        outcome: {
          success: route?.success ?? false,
          eta_minutes: route ? (evacuees > 0 ? route.congested_eta_minutes : route.eta_minutes) : 0,
          distance_m: route?.distance_m ?? 0,
          dest_node: route?.dest_node ?? -1,
          risk_level: route?.risk_level ?? '-',
        },
      };
      const next = [snapshot, ...snapshots].slice(0, 12);
      writeSnapshots(next);
      set({ snapshots: next, activeSnapshotId: snapshot.id });
      get().addLog(`Scenario snapshot saved: ${snapshot.label}.`, 'action');
    },

    applySnapshot: (id) => {
      const snapshot = get().snapshots.find((snap) => snap.id === id);
      if (!snapshot) return;
      set({
        originNode: snapshot.originNode,
        floodLevel: snapshot.floodLevel,
        failedSubstations: [...snapshot.failedSubstations],
        travelMode: snapshot.travelMode,
        evacuees: snapshot.evacuees,
        destinationId: snapshot.destinationId,
        closures: [...snapshot.closures],
      });
      queueRouteCalculation(get, 'snapshot', `Scenario restored: ${snapshot.label}.`);
      // Restoring counts as comparing against the snapshot just applied.
      setTimeout(() => set({ activeSnapshotId: id }), 200);
    },

    deleteSnapshot: (id) => {
      const next = get().snapshots.filter((snap) => snap.id !== id);
      writeSnapshots(next);
      set({ snapshots: next, activeSnapshotId: get().activeSnapshotId === id ? null : get().activeSnapshotId });
    },

    setShowBuildings: (value) => set({ showBuildings: value }),
    setShowPowerLines: (value) => set({ showPowerLines: value }),
    setShowSubstations: (value) => set({ showSubstations: value }),
    setShowIntersections: (value) => set({ showIntersections: value }),
    setShowRoadNames: (value) => set({ showRoadNames: value }),
    setShowWaterways: (value) => set({ showWaterways: value }),
    setBasemap: (value) => set({ basemap: value }),
    setIsochroneVisible: (value) => {
      set({ isochroneVisible: value });
      if (value) void get().refreshIsochrone();
    },
    setFlyToNodeId: (id) => set({ flyToNodeId: id }),
    setFlyToRoadKey: (key) => set({ flyToRoadKey: key }),
    setFlyToCoords: (coords) => set({ flyToCoords: coords }),
    setHighlightedStep: (index) => set({ highlightedStep: index }),
    setActiveSection: (section) => set({ activeSection: section }),
  };
});
