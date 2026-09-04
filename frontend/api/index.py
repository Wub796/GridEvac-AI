from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import json
import urllib.request
import uvicorn

from models import (
    CityResponse, NodeData, EdgeData, BlockData, ParkData, SubstationData, TransmissionLink,
    SimulationRequest, RouteResponse, RouteCoord, RouteStep, FloodZoneResponse,
    CorridorComparisonResponse, CorridorInfo, IsochroneResponse, IsochroneRing,
)
from city_graph import (
    _G, _NODES, _BLOCKS, PARKS, _SUBSTATIONS, TRANSMISSION_LINKS,
    CENTER_LAT, CENTER_LON, SAFE_EXITS, EXIT_NAMES,
)
from routing import compute_route, get_flooded_nodes, FLOOD_RISE_PER_LEVEL, _LINK_EDGES, compare_exit_corridors, compute_isochrone
from anomaly import detect_anomaly

app = FastAPI(
    title="GridEvac AI - Houston",
    description="Street-aware emergency evacuation routing and utility impact simulation for Houston, TX.",
    version="1.1.0",
    docs_url="/docs",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "city": "Houston, TX", "service": "GridEvac AI"}


@app.get("/api/city", response_model=CityResponse)
async def get_city():
    nodes = [NodeData(**data) for data in _NODES.values()]
    edges = [
        EdgeData(
            source=u,
            target=v,
            weight=float(data.get("weight", 1.0)),
            distance_m=float(data.get("distance_m", 0.0)),
            road_name=str(data.get("road_name", "")),
            road_class=str(data.get("road_class", "local")),
            lanes=int(data.get("lanes", 2)),
            speed_limit_mph=int(data.get("speed_limit_mph", 25)),
            geometry=[list(pair) for pair in data.get("geometry", [])],
        )
        for u, v, data in _G.edges(data=True)
    ]
    return CityResponse(
        nodes=nodes,
        edges=edges,
        blocks=[BlockData(**block) for block in _BLOCKS],
        parks=[ParkData(**park) for park in PARKS],
        substations=[SubstationData(**sub) for sub in _SUBSTATIONS],
        transmission_links=[TransmissionLink(**link) for link in TRANSMISSION_LINKS],
        center_lat=CENTER_LAT,
        center_lon=CENTER_LON,
        safe_exits=list(SAFE_EXITS),
        exit_names=dict(EXIT_NAMES),
    )


@app.get("/api/flood-zones", response_model=FloodZoneResponse)
async def flood_zones(flood_level: float = Query(default=0.0, ge=0.0, le=10.0)):
    flooded = get_flooded_nodes(flood_level)
    return FloodZoneResponse(
        flood_level=flood_level,
        flooded_nodes=sorted(flooded),
        flood_threshold_m=flood_level * FLOOD_RISE_PER_LEVEL,
    )


def fetch_usgs_water_level() -> float:
    url = "https://waterservices.usgs.gov/nwis/iv/?format=json&sites=08074000&parameterCd=00065"
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "GridEvac-AI-Emergency-Utility"})
        with urllib.request.urlopen(request, timeout=3.0) as response:
            payload = json.loads(response.read().decode())
            series = payload.get("value", {}).get("timeSeries", [])
            values = series[0].get("values", []) if series else []
            reading = values[0].get("value", []) if values else []
            if reading:
                return float(reading[0].get("value"))
    except Exception:
        pass
    return -999.0


def fetch_houston_weather_temp() -> float:
    url = "https://api.open-meteo.com/v1/forecast?latitude=29.7604&longitude=-95.3698&current_weather=true"
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "GridEvac-AI-Emergency-Utility"})
        with urllib.request.urlopen(request, timeout=3.0) as response:
            current = json.loads(response.read().decode()).get("current_weather", {})
            if "temperature" in current:
                return round(float(current["temperature"]) * 9.0 / 5.0 + 32.0, 1)
    except Exception:
        pass
    return -999.0


@app.post("/api/calculate-route", response_model=RouteResponse)
async def calculate_route(req: SimulationRequest):
    result = compute_route(
        origin=req.origin_node,
        flood_level=req.flood_level,
        failed_substations=req.failed_substations,
        travel_mode=req.travel_mode,
    )
    flow = result["power_flow"]

    total_active_load = 0.0
    total_active_capacity = 0.0
    for sub in _SUBSTATIONS:
        failed = sub["id"] in req.failed_substations or sub["id"] in flow["cascaded_substations"]
        if not failed:
            total_active_load += flow["substation_loads"][sub["id"]]
            total_active_capacity += sub["capacity_mw"]
    avg_load_ratio = total_active_load / total_active_capacity if total_active_capacity else 1.5
    voltages = list(flow["voltage_readings"].values())
    avg_voltage = sum(voltages) / len(voltages) if voltages else 100.0
    failed_total = len(req.failed_substations) + len(flow["cascaded_substations"])
    overload_ratio = total_active_load / total_active_capacity if total_active_capacity else 2.0
    cascade_probability = 0.0
    if overload_ratio > 1.0:
        cascade_probability = min(0.95, (overload_ratio - 1.0) * 1.5 + overload_ratio * 0.1 * failed_total)
    elif failed_total >= 3:
        cascade_probability = 0.25

    usgs_gage = fetch_usgs_water_level()
    if usgs_gage == -999.0:
        usgs_gage = round(4.2 + req.flood_level * 2.8, 2)
    weather_temp = fetch_houston_weather_temp()
    if weather_temp == -999.0:
        weather_temp = 88.0
    surface_temp = round(weather_temp - req.flood_level * 0.95 - failed_total * 0.45, 2)
    anomaly_score, risk_level = detect_anomaly(
        flood_level=req.flood_level,
        failed_count=failed_total,
        overload_count=len(flow["overloaded_substations"]),
        average_grid_load_ratio=avg_load_ratio,
        voltage_stability_index=avg_voltage,
        cascade_probability=cascade_probability,
        usgs_gage_height=usgs_gage,
        surface_temp=surface_temp,
    )

    hazard_roads = {}
    for link_id, state in flow["transmission_line_states"].items():
        if state in {"dead", "overloaded"}:
            for u, v in _LINK_EDGES.get(link_id, []):
                hazard_roads[f"{u}-{v}"] = state

    return RouteResponse(
        success=result["success"],
        path=result["path"],
        path_coords=[RouteCoord(**coord) for coord in result["path_coords"]],
        total_nodes=result["total_nodes"],
        distance_m=result["distance_m"],
        eta_minutes=result["eta_minutes"],
        route_steps=[RouteStep(**step) for step in result["route_steps"]],
        flooded_nodes=result["flooded_nodes"],
        blackout_nodes=result["blackout_nodes"],
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
        hazard_roads=hazard_roads,
    )


@app.get("/api/compare-corridors", response_model=CorridorComparisonResponse)
async def compare_corridors(
    origin: int = Query(...),
    flood_level: float = Query(default=0.0, ge=0.0, le=10.0),
    failed_substations: str = Query(default=""),
    travel_mode: str = Query(default="vehicle"),
):
    failed = [int(x) for x in failed_substations.split(",") if x.strip().lstrip("-").isdigit()]
    result = compare_exit_corridors(origin, flood_level, failed, travel_mode)
    return CorridorComparisonResponse(
        origin=origin,
        travel_mode=travel_mode,
        corridors=[CorridorInfo(**c) for c in result["corridors"]],
        flooded_nodes=result["flooded_nodes"],
        blackout_nodes=result["blackout_nodes"],
    )


@app.get("/api/isochrone", response_model=IsochroneResponse)
async def isochrone(
    origin: int = Query(...),
    flood_level: float = Query(default=0.0, ge=0.0, le=10.0),
    failed_substations: str = Query(default=""),
    travel_mode: str = Query(default="vehicle"),
    minutes: str = Query(default="2,4,6,8"),
):
    failed = [int(x) for x in failed_substations.split(",") if x.strip().lstrip("-").isdigit()]
    ring_minutes = [float(x) for x in minutes.split(",") if x.strip()]
    result = compute_isochrone(origin, flood_level, failed, travel_mode, ring_minutes or [2, 4, 6, 8])
    return IsochroneResponse(
        origin=origin,
        travel_mode=travel_mode,
        rings=[IsochroneRing(**ring) for ring in result["rings"]],
        flooded_nodes=result["flooded_nodes"],
        blackout_nodes=result["blackout_nodes"],
    )


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
