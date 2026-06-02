from pydantic import BaseModel, Field
from typing import List, Optional, Tuple, Dict


# ─── Request Models ────────────────────────────────────────────────────────────

class SimulationRequest(BaseModel):
    flood_level: float = Field(ge=0.0, le=10.0, description="Flood level 0–10 scale")
    failed_substations: List[int] = Field(default=[], description="IDs of failed substations")
    origin_node: int = Field(ge=0, le=224, description="Origin intersection node ID (15x15)")


# ─── City Graph Models ─────────────────────────────────────────────────────────

class NodeData(BaseModel):
    id: int
    lat: float
    lon: float
    elevation: float          # metres above sea level (synthetic)
    row: int
    col: int


class EdgeData(BaseModel):
    source: int
    target: int
    weight: float


class SubstationData(BaseModel):
    id: int
    node: int                 # grid node the substation sits on
    name: str
    radius: float             # blackout radius in grid-unit distance
    lat: float
    lon: float
    capacity_mw: float
    base_load_mw: float
    affected_nodes: List[int]


class TransmissionLink(BaseModel):
    id: int
    from_sub: int
    to_sub: int


class CityResponse(BaseModel):
    nodes: List[NodeData]
    edges: List[EdgeData]
    substations: List[SubstationData]
    transmission_links: List[TransmissionLink]
    center_lat: float
    center_lon: float
    grid_rows: int
    grid_cols: int


# ─── Route Models ──────────────────────────────────────────────────────────────

class RouteCoord(BaseModel):
    lat: float
    lon: float
    elevation: float          # elevated for 3-D visibility


class RouteResponse(BaseModel):
    success: bool
    path: List[int]                         # ordered list of node IDs
    path_coords: List[RouteCoord]           # 3-D coordinates for each waypoint
    total_nodes: int
    flooded_nodes: List[int]
    blackout_nodes: List[int]
    blocked_edges: List[List[int]]          # list of [source, target] pairs
    anomaly_score: float                    # 0 (normal) → 1 (critical)
    risk_level: str                         # LOW | MEDIUM | HIGH | CRITICAL
    message: str
    dest_node: int                          # algorithm-selected exit node
    substation_loads: Dict[int, float]      # live load in MW for each substation
    overloaded_substations: List[int]       # IDs of substations currently overloaded
    cascaded_substations: List[int]         # IDs of substations failed by cascade
    grid_frequency: float                   # live grid frequency (e.g. 59.98 Hz)
    voltage_readings: Dict[int, float]      # local node voltage stability percentage (0-100%)
    transmission_line_states: Dict[int, str] # map of link ID to state: 'active' | 'overloaded' | 'dead'
    usgs_gage_height: float                  # dynamic USGS gauge height reading in feet
    surface_temp: float                      # average grid-wide micro-climate temperature in Fahrenheit


# ─── Anomaly Scan Models ───────────────────────────────────────────────────────

class FloodZoneResponse(BaseModel):
    flood_level: float
    flooded_nodes: List[int]
    flood_threshold_m: float
