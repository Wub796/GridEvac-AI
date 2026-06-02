from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
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


import urllib.request
import json

def fetch_usgs_water_level() -> float:
    """Fetch streaming gage height in feet from USGS sensor 08074000 (Buffalo Bayou)."""
    url = "https://waterservices.usgs.gov/nwis/iv/?format=json&sites=08074000&parameterCd=00065"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'GridEvac-AI-Emergency-Utility'})
        with urllib.request.urlopen(req, timeout=3.0) as response:
            data = json.loads(response.read().decode())
            ts_list = data.get("value", {}).get("timeSeries", [])
            if ts_list:
                values = ts_list[0].get("values", [])
                if values and values[0].get("value"):
                    val_str = values[0]["value"][0].get("value")
                    return float(val_str)
    except Exception:
        pass
    return -999.0


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

    # 1. Fetch real USGS water sensor gage height (with fallback)
    usgs_gage = fetch_usgs_water_level()
    if usgs_gage == -999.0:
        # Fallback based on slider + baseline
        usgs_gage = round(4.2 + req.flood_level * 2.8, 2)

    # 2. Compute micro-climate surface temp (Fahrenheit)
    surface_temp = round(87.5 - req.flood_level * 0.9 - failed_total * 0.45, 2)

    # Run IsolationForest Anomaly Model
    anomaly_score, risk_level = detect_anomaly(
        flood_level=req.flood_level,
        failed_count=failed_total,
        overload_count=len(flow["overloaded_substations"]),
        average_grid_load_ratio=avg_load_ratio,
        voltage_stability_index=avg_voltage,
        cascade_probability=cascade_prob,
        usgs_gage_height=usgs_gage,
        surface_temp=surface_temp,
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
        usgs_gage_height=usgs_gage,
        surface_temp=surface_temp,
    )

# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
