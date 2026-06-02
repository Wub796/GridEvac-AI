// ─────────────────────────────────────────────────────────────────────────────
// Shared TypeScript types for GridEvac AI (Houston, TX)
// ─────────────────────────────────────────────────────────────────────────────

// ── City Graph ────────────────────────────────────────────────────────────────

export interface NodeData {
  id: number;
  lat: number;
  lon: number;
  elevation: number;   // metres ASL (synthetic)
  row: number;
  col: number;
}

export interface EdgeData {
  source: number;
  target: number;
  weight: number;
}

export interface SubstationData {
  id: number;
  node: number;
  name: string;
  radius: number;
  lat: number;
  lon: number;
  affected_nodes: number[];
}

export interface CityData {
  nodes: NodeData[];
  edges: EdgeData[];
  substations: SubstationData[];
  center_lat: number;
  center_lon: number;
  grid_rows: number;
  grid_cols: number;
}

// ── Route ─────────────────────────────────────────────────────────────────────

export interface RouteCoord {
  lat: number;
  lon: number;
  elevation: number;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RouteResponse {
  success: boolean;
  path: number[];
  path_coords: RouteCoord[];
  total_nodes: number;
  flooded_nodes: number[];
  blackout_nodes: number[];
  blocked_edges: [number, number][];
  anomaly_score: number;
  risk_level: RiskLevel;
  message: string;
}

// ── Simulation ────────────────────────────────────────────────────────────────

export interface SimulationParams {
  flood_level: number;
  failed_substations: number[];
  origin_node: number;
  dest_node: number;
}
