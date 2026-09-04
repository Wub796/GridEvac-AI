export interface NodeData {
  id: number;
  osm?: number;
  lat: number;
  lon: number;
  elevation: number;
  intersection_name: string;
  district: string;
}

export interface EdgeData {
  source: number;
  target: number;
  weight: number;
  distance_m: number;
  road_name: string;
  road_class: 'arterial' | 'collector' | 'local' | string;
  lanes: number;
  speed_limit_mph: number;
  /** Intermediate street-curve coordinates between the two junctions. */
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

export interface CityData {
  nodes: NodeData[];
  edges: EdgeData[];
  blocks: BlockData[];
  parks: ParkData[];
  substations: SubstationData[];
  transmission_links: TransmissionLink[];
  center_lat: number;
  center_lon: number;
  safe_exits: number[];
  /** Quadrant label per exit node id ("North exit", ...). */
  exit_names?: Record<string, string>;
}

export interface RouteCoord {
  lat: number;
  lon: number;
  elevation: number;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RouteStep {
  instruction: string;
  road_name: string;
  road_class: string;
  distance_m: number;
  duration_s: number;
  from_node: number;
  to_node: number;
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
  anomaly_score: number;
  risk_level: RiskLevel;
  message: string;
  dest_node: number;
  substation_loads: Record<number, number>;
  overloaded_substations: number[];
  cascaded_substations: number[];
  grid_frequency: number;
  voltage_readings: Record<number, number>;
  transmission_line_states: Record<number, string>;
  usgs_gage_height: number;
  surface_temp: number;
  hazard_roads: Record<string, string>;
}

export interface SimulationParams {
  flood_level: number;
  failed_substations: number[];
  origin_node: number;
}
