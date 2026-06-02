import sys
import os

# Add the current directory to sys.path so we can import local modules
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.append(current_dir)

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from models import (
    CityResponse, NodeData, EdgeData, SubstationData, TransmissionLink,
    SimulationRequest, RouteResponse, RouteCoord, FloodZoneResponse,
)
from city_graph import _G, _NODES, _SUBSTATIONS, TRANSMISSION_LINKS, CENTER_LAT, CENTER_LON, GRID_ROWS, GRID_COLS
from routing import compute_route, get_flooded_nodes, FLOOD_RISE_PER_LEVEL
from anomaly import detect_anomaly

# ── App setup ──────────────────────────────────────────────────────────────────

app = FastAPI(
    title="GridEvac AI — Houston",
    description=(
        "Real-time emergency evacuation routing for Houston, TX. "
        "Combines IsolationForest anomaly detection with NetworkX "
        "weighted pathfinding across a synthetic downtown street grid."
    ),
    version="1.0.0",
    docs_url="/docs",
)

# Enable CORS for frontend routing on Vercel (and local cross-origin)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "city": "Houston, TX", "service": "GridEvac AI"}


@app.get("/api/city", response_model=CityResponse)
async def get_city():
    """Return the full static city graph structure."""
    nodes = [NodeData(**data) for data in _NODES.values()]
    edges = [
        EdgeData(source=u, target=v, weight=float(data.get("weight", 1.0)))
        for u, v, data in _G.edges(data=True)
    ]
    substations = [SubstationData(**sub) for sub in _SUBSTATIONS]
    links = [TransmissionLink(**l) for l in TRANSMISSION_LINKS]

    return CityResponse(
        nodes=nodes,
        edges=edges,
        substations=substations,
        transmission_links=links,
        center_lat=CENTER_LAT,
        center_lon=CENTER_LON,
        grid_rows=GRID_ROWS,
        grid_cols=GRID_COLS,
    )


@app.get("/api/flood-zones", response_model=FloodZoneResponse)
async def flood_zones(flood_level: float = Query(default=0.0, ge=0.0, le=10.0)):
    """Return which node IDs are currently inundated at the given flood level."""
    flooded = get_flooded_nodes(flood_level)
    threshold = flood_level * FLOOD_RISE_PER_LEVEL
    return FloodZoneResponse(
        flood_level=flood_level,
        flooded_nodes=sorted(flooded),
        flood_threshold_m=threshold,
    )


@app.post("/api/calculate-route", response_model=RouteResponse)
async def calculate_route(req: SimulationRequest):
    """
    Compute the optimal safe evacuation route for the given simulation state.
    Runs IsolationForest scoring and weighted Dijkstra pathfinding.
    """
    result = compute_route(
        origin=req.origin_node,
        flood_level=req.flood_level,
        failed_substations=req.failed_substations,
    )

    flow = result["power_flow"]

    # Calculate average load ratio across all active substations
    total_active_load = 0.0
    total_active_capacity = 0.0
    for sub in _SUBSTATIONS:
        sub_id = sub["id"]
        is_failed = sub_id in req.failed_substations or sub_id in flow["cascaded_substations"]
        if not is_failed:
            current_load = flow["substation_loads"][sub_id]
            total_active_load += current_load
            total_active_capacity += sub["capacity_mw"]

    avg_load_ratio = (total_active_load / total_active_capacity) if total_active_capacity > 0 else 1.5

    # Calculate average voltage stability across all grid nodes
    node_voltages = list(flow["voltage_readings"].values())
    avg_voltage = sum(node_voltages) / len(node_voltages) if node_voltages else 100.0

    # Calculate cascading failure probability
    failed_total = len(req.failed_substations) + len(flow["cascaded_substations"])
    overload_ratio = (total_active_load / total_active_capacity) if total_active_capacity > 0 else 2.0
    cascade_prob = 0.0
    if overload_ratio > 1.0:
        cascade_prob = min(0.95, (overload_ratio - 1.0) * 1.5 + overload_ratio * 0.1 * failed_total)
    elif failed_total >= 3:
        cascade_prob = 0.25

    # Run IsolationForest Anomaly Model
    anomaly_score, risk_level = detect_anomaly(
        flood_level=req.flood_level,
        failed_count=failed_total,
        overload_count=len(flow["overloaded_substations"]),
        average_grid_load_ratio=avg_load_ratio,
        voltage_stability_index=avg_voltage,
        cascade_probability=cascade_prob,
    )

    return RouteResponse(
        success=result["success"],
        path=result["path"],
        path_coords=[RouteCoord(**c) for c in result["path_coords"]],
        total_nodes=len(result["path"]),
        flooded_nodes=result["flooded_nodes"],
        blackout_nodes=list(result["blackout_nodes"]),
        blocked_edges=result["blocked_edges"],
        anomaly_score=round(anomaly_score, 4),
        risk_level=risk_level,
        message=result["message"],
        dest_node=result["dest_node"],
        substation_loads=flow["substation_loads"],
        overloaded_substations=flow["overloaded_substations"],
        cascaded_substations=flow["cascaded_substations"],
        grid_frequency=flow["grid_frequency"],
        voltage_readings=flow["voltage_readings"],
        transmission_line_states=flow["transmission_line_states"],
    )
