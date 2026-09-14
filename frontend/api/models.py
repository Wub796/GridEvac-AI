from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field

TravelMode = Literal["vehicle", "foot", "ems"]


class SimulationRequest(BaseModel):
    flood_level: float = Field(ge=0.0, le=10.0, description="Scenario level 0-10; water surface = datum + level * rise (m NAVD88)")
    failed_substations: List[int] = Field(default=[], max_length=50, description="IDs of manually failed substations")
    origin_node: int = Field(ge=0, le=100000, description="Origin intersection node ID")
    travel_mode: TravelMode = Field(default="vehicle", description="vehicle | foot | ems")
    evacuees: int = Field(default=0, ge=0, le=200_000, description="Evacuating population driving road congestion")
    destination: Optional[str] = Field(default=None, max_length=64, description="Shelter/medical id to route to instead of perimeter exits")
    closed_edges: List[List[int]] = Field(default=[], max_length=500, description="Operator road closures as [source, target] node pairs")


class ShelterData(BaseModel):
    id: str
    name: str
    kind: str = "shelter"
    capacity: int
    lat: float
    lon: float
    node: int
    snap_distance_m: float = 0.0
    note: str = ""


class NodeData(BaseModel):
    id: int
    osm: Optional[int] = None
    lat: float
    lon: float
    elevation: float
    flood_stage_m: Optional[float] = None
    elevated: bool = False
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


class WaterwayData(BaseModel):
    id: str
    name: str
    kind: str = "river"
    coords: List[List[float]]


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


class FloodModel(BaseModel):
    method: str = ""
    datum_m: float = 0.0
    rise_per_level_m: float = 1.7
    vertical_datum: str = "NAVD88"
    elevation_source: str = ""
    gage: Dict[str, object] = {}


class CityResponse(BaseModel):
    nodes: List[NodeData]
    edges: List[EdgeData]
    blocks: List[BlockData] = []
    parks: List[ParkData] = []
    waterways: List[WaterwayData] = []
    substations: List[SubstationData]
    transmission_links: List[TransmissionLink]
    center_lat: float
    center_lon: float
    safe_exits: List[int] = []
    exit_names: Dict[str, str] = {}
    shelters: List[ShelterData] = []
    flood_model: FloodModel = FloodModel()


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
    maneuver: str = "continue"
    bearing: int = 0


class CorridorCapacity(BaseModel):
    people_per_hour: int = 0
    clearance_minutes: float = 0.0
    limiting_road: str = "-"


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
    closed_edges: List[List[int]] = []
    anomaly_score: float
    risk_level: str
    message: str
    dest_node: int
    substation_loads: Dict[int, float]
    overloaded_substations: List[int]
    cascaded_substations: List[int]
    flooded_substations: List[int] = []
    grid_frequency: float
    voltage_readings: Dict[int, float]
    transmission_line_states: Dict[int, str]
    water_surface_m: float = 0.0
    usgs_gage_height: float = Field(description="Modeled reading at USGS 08074000 for this scenario, ft (gage datum 0.00 ft NAVD88)")
    surface_temp: float
    hazard_roads: Dict[str, str] = {}
    corridor_capacity: CorridorCapacity = CorridorCapacity()
    congested_eta_minutes: float = 0.0
    congestion_factor: float = 1.0
    destination_name: str = ""
    destination_kind: str = ""


class CorridorInfo(BaseModel):
    exit_node: int
    exit_name: str
    eta_minutes: float
    cost_minutes: float = 0.0
    distance_m: float
    hazard_count: int = 0
    path_length: int = 0
    people_per_hour: int = 0
    congested_eta_minutes: float = 0.0


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
    congestion_factor: float = 1.0


class TriggerTarget(BaseModel):
    kind: str
    id: str
    node: int
    name: str
    threshold_m: float
    threshold_level: float
    limited_by: Literal["origin", "destination", "corridor"]
    bottleneck_road: str
    bottleneck_node: int
    bottleneck_name: str


class TriggerPointsResponse(BaseModel):
    origin: int
    origin_stage_m: float
    origin_level: float
    targets: List[TriggerTarget]


class FloodZoneResponse(BaseModel):
    flood_level: float
    flooded_nodes: List[int]
    flood_threshold_m: float


class Observation(BaseModel):
    status: Literal["live", "unavailable"]
    value: Optional[float] = None
    unit: str = ""
    observed_at: Optional[str] = None
    source: str = ""


class ObservationsResponse(BaseModel):
    gage_height: Observation
    discharge: Observation
    air_temperature: Observation
    gage_water_surface_m: Optional[float] = None
    equivalent_flood_level: Optional[float] = None
    fetched_at: str
