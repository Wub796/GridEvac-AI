export interface NodeData {
  id: number;
  osm?: number;
  lat: number;
  lon: number;
  /** Ground elevation, metres NAVD88 (USGS 3DEP bare-earth DEM). */
  elevation: number;
  /** Water surface (m NAVD88) at which bayou water first reaches this junction. */
  flood_stage_m?: number;
  /** Bridge-deck junction: stays dry when the ground beneath floods. */
  elevated?: boolean;
  intersection_name: string;
  district: string;
}

export interface EdgeData {
  source: number;
  target: number;
  weight: number;
  distance_m: number;
  road_name: string;
  road_class: 'arterial' | 'collector' | 'local' | 'service' | string;
  lanes: number;
  speed_limit_mph: number;
  /** 0 two-way, 1 source -> target only, -1 target -> source only. */
  oneway?: number;
  /** Intermediate street-curve coordinates between the two junctions, source -> target. */
  geometry?: [number, number][];
}

export interface BlockData {
  id: string;
  /** Real building footprint ring: [lat, lon] pairs. */
  footprint: [number, number][];
  height_m: number;
}

export interface ParkData {
  id: string;
  footprint: [number, number][];
}

export interface WaterwayData {
  id: string;
  name: string;
  kind: string;
  coords: [number, number][];
}

export interface SubstationData {
  id: number;
  node: number;
  name: string;
  radius: number;
  lat: number;
  lon: number;
  capacity_mw: number;
  base_load_mw: number;
  affected_nodes: number[];
}

export interface TransmissionLink {
  id: number;
  from_sub: number;
  to_sub: number;
}

export interface ShelterData {
  id: string;
  name: string;
  kind: 'shelter' | 'medical';
  capacity: number;
  lat: number;
  lon: number;
  /** Nearest street-network junction id. */
  node: number;
  /** How far the real facility sits from that junction, in meters. */
  snap_distance_m: number;
  note: string;
}

/** A place the operator picked themselves: a junction plus whatever they call it. */
export interface CustomDestination {
  node: number;
  lat: number;
  lon: number;
  label: string;
  /** How the place was chosen, so the panel can explain the snap. */
  source: 'map' | 'search' | 'coords' | 'link';
  /** Distance from the requested point to the junction actually routed to. */
  snapDistanceM: number;
}

/** One active NWS watch, warning, or advisory over the district. */
export interface WeatherAlert {
  id: string;
  event: string;
  hazard: 'flood' | 'wind' | 'ice' | 'fog' | 'heat' | 'other' | string;
  severity: string;
  weight: number;
  urgency: string;
  certainty: string;
  headline: string;
  instruction: string;
  sender: string;
  onset: string;
  ends: string;
}

/** The weather snapshot a condition-aware route is computed from. */
export interface WeatherSnapshot {
  status: 'live' | 'unavailable';
  observed_at: string | null;
  rain_rate_mm_h: number;
  rain_1h_mm: number;
  rain_6h_mm: number;
  rain_24h_mm: number;
  rain_6h_forecast_mm: number;
  peak_rate_6h_mm_h: number;
  wind_speed_mph: number;
  wind_gust_mph: number;
  temperature_f: number;
  weather_code: number;
  source: string;
}

export interface ConditionAdvisory {
  kind: 'ponding' | 'surface' | 'wind' | 'ice' | 'fog' | 'heat' | 'clear' | 'feed' | string;
  severity: string;
  message: string;
  affected: number;
}

/**
 * The live roadway as it affects routing: standing water per junction, the
 * speed each mode actually achieves, and why.
 */
export interface RoadConditions {
  status: 'live' | 'unavailable';
  observed_at: string | null;
  fetched_at: string;
  weather_code: number;
  weather_label: string;
  temperature_f: number;
  rain_rate_mm_h: number;
  rain_1h_mm: number;
  rain_6h_mm: number;
  rain_24h_mm: number;
  rain_6h_forecast_mm: number;
  peak_rate_6h_mm_h: number;
  intensity_mm_h: number;
  wind_speed_mph: number;
  wind_gust_mph: number;
  river_surface_m: number | null;
  wetness: number;
  alerts: WeatherAlert[];
  /** Junction id -> standing water depth in metres (string keys over JSON). */
  ponding_depth_m: Record<string, number>;
  ponded_nodes: number[];
  wetted_nodes: number;
  deepest_ponding_m: number;
  impassable: Record<string, number[]>;
  speed_factors: Record<string, number>;
  advisories: ConditionAdvisory[];
  sources: Record<string, string>;
  travel_mode: string;
  clearance_m: number | null;
  speed_factor: number;
  bridge_speed_factor: number;
  impassable_nodes: number[];
}

export interface ConditionsResponse {
  conditions: RoadConditions;
  feeds: Record<string, boolean>;
}

export interface FloodModel {
  method: string;
  /** Water surface at scenario level 0, m NAVD88. */
  datum_m: number;
  rise_per_level_m: number;
  vertical_datum: string;
  elevation_source: string;
  gage: { site?: string; name?: string; lat?: number; lon?: number; datum_navd88_ft?: number };
}

export interface CityData {
  nodes: NodeData[];
  edges: EdgeData[];
  blocks: BlockData[];
  parks: ParkData[];
  waterways?: WaterwayData[];
  substations: SubstationData[];
  transmission_links: TransmissionLink[];
  center_lat: number;
  center_lon: number;
  safe_exits: number[];
  /** Quadrant label per exit node id ("North exit", ...). */
  exit_names?: Record<string, string>;
  shelters?: ShelterData[];
  flood_model?: FloodModel;
}

export interface RouteCoord {
  lat: number;
  lon: number;
  elevation: number;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type Maneuver =
  | 'depart' | 'continue' | 'uturn'
  | 'slight-left' | 'slight-right' | 'turn-left' | 'turn-right' | 'sharp-left' | 'sharp-right';

export interface RouteStep {
  instruction: string;
  road_name: string;
  road_class: string;
  distance_m: number;
  duration_s: number;
  from_node: number;
  to_node: number;
  maneuver: Maneuver | string;
  /** Heading leaving the step's first junction, degrees clockwise from north. */
  bearing: number;
}

export interface RouteResponse {
  success: boolean;
  path: number[];
  path_coords: RouteCoord[];
  total_nodes: number;
  distance_m: number;
  eta_minutes: number;
  route_steps: RouteStep[];
  flooded_nodes: number[];
  blackout_nodes: number[];
  blocked_edges: [number, number][];
  closed_edges: [number, number][];
  anomaly_score: number;
  risk_level: RiskLevel;
  message: string;
  dest_node: number;
  substation_loads: Record<number, number>;
  overloaded_substations: number[];
  cascaded_substations: number[];
  /** Substations tripped because their site is under water. */
  flooded_substations: number[];
  grid_frequency: number;
  voltage_readings: Record<number, number>;
  transmission_line_states: Record<number, string>;
  /** Scenario water surface elevation, m NAVD88. */
  water_surface_m: number;
  /** Modeled reading at USGS 08074000 for this scenario, ft (gage datum 0.00 ft NAVD88). */
  usgs_gage_height: number;
  surface_temp: number;
  hazard_roads: Record<string, string>;
  corridor_capacity?: CorridorCapacity;
  /** Free-flow ETA inflated by the BPR congestion curve for `evacuees`. */
  congested_eta_minutes: number;
  congestion_factor: number;
  destination_name: string;
  destination_kind: '' | 'shelter' | 'medical' | 'custom';
  /** Free-flow ETA for this path on dry, unobstructed pavement. */
  dry_eta_minutes: number;
  /** Seconds this route costs because of live road conditions. */
  weather_delay_s: number;
  /** Segments on this route still holding visible standing water. */
  route_ponded_segments: number;
  /** Live conditions applied to this route, when conditions routing is on. */
  road_conditions: RoadConditions | null;
  /** Segments with both ends too deep for this mode to cross. */
  ponded_edges: [number, number][];
}

export type TravelMode = 'vehicle' | 'foot' | 'ems';

export interface SimulationParams {
  flood_level: number;
  failed_substations: number[];
  origin_node: number;
  travel_mode?: TravelMode;
  evacuees?: number;
  destination?: string | null;
  /** The operator's own destination junction, overriding `destination`. */
  destination_node?: number | null;
  destination_label?: string;
  /** Route on live rainfall, wind, ice and heat rather than dry pavement. */
  use_live_conditions?: boolean;
  /** A snapshot the browser measured, replayed instead of re-fetched. */
  conditions?: { weather: WeatherSnapshot; alerts: WeatherAlert[]; gage_surface_m: number | null } | null;
  closed_edges?: [number, number][];
}

export interface CorridorInfo {
  exit_node: number;
  exit_name: string;
  eta_minutes: number;
  /** Routing cost in minute-equivalents; corridors are ranked by it. */
  cost_minutes: number;
  distance_m: number;
  hazard_count: number;
  path_length: number;
  people_per_hour: number;
  congested_eta_minutes: number;
  /** Segments along this corridor holding visible standing water. */
  ponded_segments: number;
  max_ponding_m: number;
}

/** An exit that is no longer an option, and why. */
export interface UnusableExit {
  exit_node: number;
  exit_name: string;
  reason: string;
}

export interface CorridorCapacity {
  people_per_hour: number;
  clearance_minutes: number;
  limiting_road: string;
}

export interface CorridorComparisonResponse {
  origin: number;
  travel_mode: TravelMode;
  corridors: CorridorInfo[];
  unusable_exits: UnusableExit[];
  flooded_nodes: number[];
  blackout_nodes: number[];
  road_conditions: RoadConditions | null;
}

export interface IsochroneRing {
  minutes: number;
  node_count: number;
  nodes: number[];
}

export interface IsochroneResponse {
  origin: number;
  travel_mode: TravelMode;
  rings: IsochroneRing[];
  flooded_nodes: number[];
  blackout_nodes: number[];
  congestion_factor: number;
  road_conditions: RoadConditions | null;
}

export interface TriggerTarget {
  kind: 'exit' | 'shelter' | 'medical' | string;
  id: string;
  node: number;
  name: string;
  /** Water surface (m NAVD88) at which this target stops being reachable. */
  threshold_m: number;
  threshold_level: number;
  limited_by: 'origin' | 'destination' | 'corridor';
  bottleneck_road: string;
  bottleneck_node: number;
  bottleneck_name: string;
}

export interface TriggerPointsResponse {
  origin: number;
  origin_stage_m: number;
  origin_level: number;
  targets: TriggerTarget[];
}

export interface Observation {
  status: 'live' | 'unavailable';
  value: number | null;
  unit: string;
  observed_at: string | null;
  source: string;
}

export interface ObservationsResponse {
  gage_height: Observation;
  discharge: Observation;
  air_temperature: Observation;
  gage_water_surface_m: number | null;
  equivalent_flood_level: number | null;
  fetched_at: string;
}
