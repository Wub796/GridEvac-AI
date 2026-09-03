import sys
import os
import json
import urllib.request

current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.append(current_dir)

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from models import (
    CityResponse, NodeData, EdgeData, BlockData, SubstationData, TransmissionLink,
    SimulationRequest, RouteResponse, RouteCoord, RouteStep, FloodZoneResponse,
)
from city_graph import (
    _G, _NODES, _BLOCKS, _SUBSTATIONS, TRANSMISSION_LINKS,
    CENTER_LAT, CENTER_LON, GRID_ROWS, GRID_COLS,
)
from routing import compute_route, get_flooded_nodes, FLOOD_RISE_PER_LEVEL, _LINK_EDGES
from anomaly import detect_anomaly

app = FastAPI(
    title="GridEvac AI - Houston",
    description="Street-aware emergency evacuation routing and utility impact simulation for Houston, TX.",
    version="1.1.0",
    docs_url="/docs",
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
async def health():
    return {"status": "ok", "city": "Houston, TX", "service": "GridEvac AI"}


@app.get("/api/city", response_model=CityResponse)
async def get_city():
    nodes = [NodeData(**data) for data in _NODES.values()]
    edges = [EdgeData(source=u, target=v, weight=float(data.get("weight", 1.0)), distance_m=float(data.get("distance_m", 0.0)), road_name=str(data.get("road_name", "")), road_class=str(data.get("road_class", "local")), lanes=int(data.get("lanes", 2)), speed_limit_mph=int(data.get("speed_limit_mph", 25))) for u, v, data in _G.edges(data=True)]
    return CityResponse(nodes=nodes, edges=edges, blocks=[BlockData(**block) for block in _BLOCKS], substations=[SubstationData(**sub) for sub in _SUBSTATIONS], transmission_links=[TransmissionLink(**link) for link in TRANSMISSION_LINKS], center_lat=CENTER_LAT, center_lon=CENTER_LON, grid_rows=GRID_ROWS, grid_cols=GRID_COLS)


@app.get("/api/flood-zones", response_model=FloodZoneResponse)
async def flood_zones(flood_level: float = Query(default=0.0, ge=0.0, le=10.0)):
    flooded = get_flooded_nodes(flood_level)
    return FloodZoneResponse(flood_level=flood_level, flooded_nodes=sorted(flooded), flood_threshold_m=flood_level * FLOOD_RISE_PER_LEVEL)


def fetch_usgs_water_level() -> float:
    try:
        request = urllib.request.Request("https://waterservices.usgs.gov/nwis/iv/?format=json&sites=08074000&parameterCd=00065", headers={"User-Agent": "GridEvac-AI-Emergency-Utility"})
        with urllib.request.urlopen(request, timeout=3.0) as response:
            series = json.loads(response.read().decode()).get("value", {}).get("timeSeries", [])
            values = series[0].get("values", []) if series else []
            reading = values[0].get("value", []) if values else []
            return float(reading[0].get("value")) if reading else -999.0
    except Exception:
        return -999.0


def fetch_houston_weather_temp() -> float:
    try:
        request = urllib.request.Request("https://api.open-meteo.com/v1/forecast?latitude=29.7604&longitude=-95.3698&current_weather=true", headers={"User-Agent": "GridEvac-AI-Emergency-Utility"})
        with urllib.request.urlopen(request, timeout=3.0) as response:
            current = json.loads(response.read().decode()).get("current_weather", {})
            return round(float(current["temperature"]) * 9.0 / 5.0 + 32.0, 1) if "temperature" in current else -999.0
    except Exception:
        return -999.0


@app.post("/api/calculate-route", response_model=RouteResponse)
async def calculate_route(req: SimulationRequest):
    result = compute_route(origin=req.origin_node, flood_level=req.flood_level, failed_substations=req.failed_substations)
    flow = result["power_flow"]
    total_load = 0.0
    total_capacity = 0.0
    for sub in _SUBSTATIONS:
        if sub["id"] not in req.failed_substations and sub["id"] not in flow["cascaded_substations"]:
            total_load += flow["substation_loads"][sub["id"]]
            total_capacity += sub["capacity_mw"]
    avg_load_ratio = total_load / total_capacity if total_capacity else 1.5
    voltages = list(flow["voltage_readings"].values())
    avg_voltage = sum(voltages) / len(voltages) if voltages else 100.0
    failed_total = len(req.failed_substations) + len(flow["cascaded_substations"])
    overload_ratio = total_load / total_capacity if total_capacity else 2.0
    cascade_probability = min(0.95, (overload_ratio - 1.0) * 1.5 + overload_ratio * 0.1 * failed_total) if overload_ratio > 1.0 else (0.25 if failed_total >= 3 else 0.0)
    usgs_gage = fetch_usgs_water_level()
    if usgs_gage == -999.0:
        usgs_gage = round(4.2 + req.flood_level * 2.8, 2)
    weather_temp = fetch_houston_weather_temp()
    if weather_temp == -999.0:
        weather_temp = 88.0
    surface_temp = round(weather_temp - req.flood_level * 0.95 - failed_total * 0.45, 2)
    anomaly_score, risk_level = detect_anomaly(flood_level=req.flood_level, failed_count=failed_total, overload_count=len(flow["overloaded_substations"]), average_grid_load_ratio=avg_load_ratio, voltage_stability_index=avg_voltage, cascade_probability=cascade_probability, usgs_gage_height=usgs_gage, surface_temp=surface_temp)
    hazard_roads = {}
    for link_id, state in flow["transmission_line_states"].items():
        if state in {"dead", "overloaded"}:
            for u, v in _LINK_EDGES.get(link_id, []):
                hazard_roads[f"{u}-{v}"] = state
    return RouteResponse(success=result["success"], path=result["path"], path_coords=[RouteCoord(**coord) for coord in result["path_coords"]], total_nodes=result["total_nodes"], distance_m=result["distance_m"], eta_minutes=result["eta_minutes"], route_steps=[RouteStep(**step) for step in result["route_steps"]], flooded_nodes=result["flooded_nodes"], blackout_nodes=result["blackout_nodes"], blocked_edges=result["blocked_edges"], anomaly_score=round(anomaly_score, 4), risk_level=risk_level, message=result["message"], dest_node=result["dest_node"], substation_loads=flow["substation_loads"], overloaded_substations=flow["overloaded_substations"], cascaded_substations=flow["cascaded_substations"], grid_frequency=flow["grid_frequency"], voltage_readings=flow["voltage_readings"], transmission_line_states=flow["transmission_line_states"], usgs_gage_height=usgs_gage, surface_temp=surface_temp, hazard_roads=hazard_roads)
