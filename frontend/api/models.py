from pydantic import BaseModel, Field
from typing import Dict, List, Optional, Tuple


class SimulationRequest(BaseModel):
    flood_level: float = Field(ge=0.0, le=10.0, description="Flood level 0-10 scale")
    failed_substations: List[int] = Field(default=[], description="IDs of failed substations")
    origin_node: int = Field(ge=0, le=100000, description="Origin intersection node ID")
    travel_mode: str = Field(default="vehicle", description="vehicle | foot | ems")


class NodeData(BaseModel):
    id: int
    osm: Optional[int] = None
    lat: float
    lon: float
    elevation: float
    intersection_name: str = ""
    district: str = "Houston operations district"


class EdgeData(BaseModel):
    source: int
    target: int
    weight: float
    distance_m: float = 0.0
    road_name: str = ""
    road_class: str = "local"
    lanes: int = 2
    speed_limit_mph: int = 25
    geometry: List[List[float]] = []


class BlockData(BaseModel):
    id: str
    footprint: List[List[float]]
    height_m: float = 0.0


class ParkData(BaseModel):
    id: str
    footprint: List[List[float]]


class SubstationData(BaseModel):
    id: int
    node: int
    name: str
    radius: float
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
    blocks: List[BlockData] = []
    parks: List[ParkData] = []
    substations: List[SubstationData]
    transmission_links: List[TransmissionLink]
    center_lat: float
    center_lon: float
    safe_exits: List[int] = []
    exit_names: Dict[str, str] = {}


class RouteCoord(BaseModel):
    lat: float
    lon: float
    elevation: float


class RouteStep(BaseModel):
    instruction: str
    road_name: str
    road_class: str
    distance_m: float
    duration_s: float
    from_node: int
    to_node: int


class RouteResponse(BaseModel):
    success: bool
    path: List[int]
    path_coords: List[RouteCoord]
    total_nodes: int
    distance_m: float = 0.0
    eta_minutes: float = 0.0
    route_steps: List[RouteStep] = []
    flooded_nodes: List[int]
    blackout_nodes: List[int]
    blocked_edges: List[List[int]]
    anomaly_score: float
    risk_level: str
    message: str
    dest_node: int
    substation_loads: Dict[int, float]
    overloaded_substations: List[int]
    cascaded_substations: List[int]
    grid_frequency: float
    voltage_readings: Dict[int, float]
    transmission_line_states: Dict[int, str]
    usgs_gage_height: float
    surface_temp: float
    hazard_roads: Dict[str, str] = {}


class CorridorInfo(BaseModel):
    exit_node: int
    exit_name: str
    eta_minutes: float
    distance_m: float
    hazard_count: int = 0
    path_length: int = 0


class CorridorComparisonResponse(BaseModel):
    origin: int
    travel_mode: str
    corridors: List[CorridorInfo]
    flooded_nodes: List[int]
    blackout_nodes: List[int]


class IsochroneRing(BaseModel):
    minutes: float
    node_count: int
    nodes: List[int]


class IsochroneResponse(BaseModel):
    origin: int
    travel_mode: str
    rings: List[IsochroneRing]
    flooded_nodes: List[int]
    blackout_nodes: List[int]


class FloodZoneResponse(BaseModel):
    flood_level: float
    flooded_nodes: List[int]
    flood_threshold_m: float
