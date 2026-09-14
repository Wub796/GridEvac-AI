import json
import os
import ssl
import time
import urllib.request
from datetime import datetime, timezone
from typing import Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response

from models import (
    BlockData, CityResponse, CorridorCapacity, CorridorComparisonResponse, CorridorInfo, EdgeData,
    FloodModel, FloodZoneResponse, IsochroneResponse, IsochroneRing, NodeData, Observation,
    ObservationsResponse, ParkData, RouteCoord, RouteResponse, RouteStep, ShelterData, SimulationRequest,
    SubstationData, TransmissionLink, TravelMode, TriggerPointsResponse, WaterwayData,
)
from city_graph import (
    _BLOCKS, _G, _NODES, _SUBSTATIONS, CENTER_LAT, CENTER_LON, EXIT_NAMES, FLOOD_MODEL, META, PARKS,
    SAFE_EXITS, SHELTERS, TRANSMISSION_LINKS, WATERWAYS, level_for_water_surface, water_surface_m,
)
from routing import (
    _LINK_EDGES, compare_exit_corridors, compute_isochrone, compute_route, compute_trigger_points,
    get_flooded_nodes,
)
from anomaly import detect_anomaly

API_VERSION = "1.2.0"
FEET_PER_METER = 3.28084

app = FastAPI(
    title="GridEvac AI - Houston",
    description="Street-aware emergency evacuation routing and utility impact simulation for Houston, TX.",
    version=API_VERSION,
    docs_url="/docs",
)
# The city payload is ~2 MB of JSON; gzip brings it to a few hundred KB for
# field laptops on constrained links.
app.add_middleware(GZipMiddleware, minimum_size=1024)
_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("GRIDEVAC_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


def _parse_int_list(raw: str, name: str) -> List[int]:
    try:
        return [int(part) for part in raw.split(",") if part.strip()]
    except ValueError:
        raise HTTPException(status_code=422, detail=f"{name} must be a comma-separated list of integers")


def _parse_closures(raw: str) -> List[List[int]]:
    """`closed_edges=12-40,40-41` -> [[12, 40], [40, 41]]."""
    closures: List[List[int]] = []
    for part in raw.split(","):
        if not part.strip():
            continue
        pieces = part.split("-")
        if len(pieces) != 2 or not all(piece.strip().isdigit() for piece in pieces):
            raise HTTPException(status_code=422, detail="closed_edges must look like '12-40,40-41'")
        closures.append([int(pieces[0]), int(pieces[1])])
    if len(closures) > 500:
        raise HTTPException(status_code=422, detail="closed_edges accepts at most 500 segments")
    return closures


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "GridEvac AI",
        "version": API_VERSION,
        "city": "Houston, TX",
        "junctions": len(_NODES),
        "street_segments": _G.number_of_edges(),
        "elevation_source": META.get("elevation_source", "synthetic"),
    }


def _build_city_json() -> bytes:
    edges = [
        EdgeData(
            source=data.get("source", u),
            target=v if data.get("source", u) == u else u,
            weight=float(data.get("base_weight", data.get("weight", 1.0))),
            distance_m=float(data.get("distance_m", 0.0)),
            road_name=str(data.get("road_name", "")),
            road_class=str(data.get("road_class", "local")),
            lanes=int(data.get("lanes", 2)),
            speed_limit_mph=int(data.get("speed_limit_mph", 25)),
            geometry=[list(pair) for pair in data.get("geometry", [])],
        )
        for u, v, data in _G.edges(data=True)
    ]
    city = CityResponse(
        nodes=[NodeData(**data) for data in _NODES.values()],
        edges=edges,
        blocks=[BlockData(**block) for block in _BLOCKS],
        parks=[ParkData(**park) for park in PARKS],
        waterways=[WaterwayData(**way) for way in WATERWAYS],
        substations=[SubstationData(**sub) for sub in _SUBSTATIONS],
        transmission_links=[TransmissionLink(**link) for link in TRANSMISSION_LINKS],
        center_lat=CENTER_LAT,
        center_lon=CENTER_LON,
        safe_exits=list(SAFE_EXITS),
        exit_names=dict(EXIT_NAMES),
        shelters=[ShelterData(**shelter) for shelter in SHELTERS],
        flood_model=FloodModel(
            method=FLOOD_MODEL.get("method", ""),
            datum_m=FLOOD_MODEL.get("datum_m", 0.0),
            rise_per_level_m=FLOOD_MODEL.get("rise_per_level_m", 1.7),
            vertical_datum=META.get("vertical_datum", "NAVD88"),
            elevation_source=META.get("elevation_source", ""),
            gage=FLOOD_MODEL.get("gage", {}),
        ),
    )
    return city.model_dump_json().encode()


# The street network is static for the life of the process: serialize once.
_CITY_JSON = _build_city_json()


@app.get("/api/city", response_model=CityResponse)
async def get_city():
    return Response(content=_CITY_JSON, media_type="application/json", headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/flood-zones", response_model=FloodZoneResponse)
async def flood_zones(flood_level: float = Query(default=0.0, ge=0.0, le=10.0)):
    return FloodZoneResponse(
        flood_level=flood_level,
        flooded_nodes=sorted(get_flooded_nodes(flood_level)),
        flood_threshold_m=round(water_surface_m(flood_level), 2),
    )


# ------------------------------------------------------------ observations
_OBSERVATION_TTL_SECONDS = 300.0
_OBSERVATION_CACHE: Dict[str, tuple] = {}


def _ssl_context() -> Optional[ssl.SSLContext]:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return None


def _get_json(url: str) -> Dict:
    request = urllib.request.Request(url, headers={"User-Agent": "GridEvac-AI-Emergency-Operations"})
    with urllib.request.urlopen(request, timeout=4.0, context=_ssl_context()) as response:
        return json.loads(response.read().decode())


def _usgs_observations() -> Dict[str, Observation]:
    gage = FLOOD_MODEL.get("gage", {}).get("site", "08074000")
    source = f"USGS {gage} instantaneous values"
    unavailable = {
        "gage_height": Observation(status="unavailable", unit="ft", source=source),
        "discharge": Observation(status="unavailable", unit="ft3/s", source=source),
    }
    try:
        payload = _get_json(f"https://waterservices.usgs.gov/nwis/iv/?format=json&sites={gage}&parameterCd=00065,00060")
    except Exception:
        return unavailable
    readings = dict(unavailable)
    for series in payload.get("value", {}).get("timeSeries", []):
        code = series.get("variable", {}).get("variableCode", [{}])[0].get("value")
        values = (series.get("values") or [{}])[0].get("value") or []
        if not values:
            continue
        latest = values[-1]
        try:
            value = float(latest["value"])
        except (KeyError, TypeError, ValueError):
            continue
        key = "gage_height" if code == "00065" else "discharge" if code == "00060" else None
        if key:
            readings[key] = Observation(status="live", value=value, unit=unavailable[key].unit, observed_at=latest.get("dateTime"), source=source)
    return readings


def _weather_observation() -> Observation:
    source = "Open-Meteo current conditions"
    try:
        current = _get_json(
            f"https://api.open-meteo.com/v1/forecast?latitude={CENTER_LAT}&longitude={CENTER_LON}"
            "&current=temperature_2m&temperature_unit=fahrenheit&timezone=America%2FChicago"
        ).get("current", {})
        return Observation(status="live", value=float(current["temperature_2m"]), unit="°F", observed_at=current.get("time"), source=source)
    except Exception:
        return Observation(status="unavailable", unit="°F", source=source)


def _cached(name: str, fetcher):
    now = time.monotonic()
    entry = _OBSERVATION_CACHE.get(name)
    if entry and now - entry[0] < _OBSERVATION_TTL_SECONDS:
        return entry[1]
    value = fetcher()
    _OBSERVATION_CACHE[name] = (now, value)
    return value


@app.get("/api/observations", response_model=ObservationsResponse)
async def observations():
    """Live Buffalo Bayou gage and air temperature, cached for five minutes.

    Observations are reported alongside - never mixed into - scenario
    results, so a hypothetical flood is not silently overwritten by today's
    reading. The gage datum is 0.00 ft NAVD88, so gage height converts
    directly to a water surface elevation on the scenario scale.
    """
    usgs = _cached("usgs", _usgs_observations)
    weather = _cached("weather", _weather_observation)
    gage_surface = None
    level = None
    if usgs["gage_height"].status == "live" and usgs["gage_height"].value is not None:
        datum_ft = float(FLOOD_MODEL.get("gage", {}).get("datum_navd88_ft", 0.0))
        gage_surface = round((usgs["gage_height"].value + datum_ft) / FEET_PER_METER, 2)
        level = round(max(0.0, min(10.0, level_for_water_surface(gage_surface))), 2)
    return ObservationsResponse(
        gage_height=usgs["gage_height"],
        discharge=usgs["discharge"],
        air_temperature=weather,
        gage_water_surface_m=gage_surface,
        equivalent_flood_level=level,
        fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )


# ------------------------------------------------------------------ routes
@app.post("/api/calculate-route", response_model=RouteResponse)
async def calculate_route(req: SimulationRequest):
    result = compute_route(
        origin=req.origin_node,
        flood_level=req.flood_level,
        failed_substations=req.failed_substations,
        travel_mode=req.travel_mode,
        evacuees=req.evacuees,
        destination=req.destination,
        closed_edges=req.closed_edges,
    )
    flow = result["power_flow"]
    offline = set(flow["offline_substations"])

    total_active_load = sum(flow["substation_loads"][sub["id"]] for sub in _SUBSTATIONS if sub["id"] not in offline)
    total_active_capacity = sum(sub["capacity_mw"] for sub in _SUBSTATIONS if sub["id"] not in offline)
    load_ratio = total_active_load / total_active_capacity if total_active_capacity else 2.0
    voltages = list(flow["voltage_readings"].values())
    avg_voltage = sum(voltages) / len(voltages) if voltages else 100.0
    failed_total = len(offline)
    cascade_probability = 0.0
    if load_ratio > 1.0:
        cascade_probability = min(0.95, (load_ratio - 1.0) * 1.5 + load_ratio * 0.1 * failed_total)
    elif failed_total >= 3:
        cascade_probability = 0.25

    # Anomaly features are the scenario's own modeled conditions, on the same
    # scales the model was trained on - not live readings, which describe
    # today rather than the scenario being evaluated.
    modeled_gage_feature = 5.5 + req.flood_level * 1.5
    modeled_temp_feature = 85.0 - req.flood_level * 0.8 - failed_total * 0.45
    anomaly_score, risk_level = detect_anomaly(
        flood_level=req.flood_level,
        failed_count=failed_total,
        overload_count=len(flow["overloaded_substations"]),
        average_grid_load_ratio=load_ratio,
        voltage_stability_index=avg_voltage,
        cascade_probability=cascade_probability,
        usgs_gage_height=modeled_gage_feature,
        surface_temp=modeled_temp_feature,
        flooded_fraction=len(result["flooded_nodes"]) / max(1, len(_NODES)),
    )
    if not result["success"]:
        # No passable corridor is critical whatever the telemetry says.
        anomaly_score, risk_level = max(anomaly_score, 0.8), "CRITICAL"

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
        closed_edges=result.get("closed_edges", []),
        anomaly_score=round(anomaly_score, 4),
        risk_level=risk_level,
        message=result["message"],
        dest_node=result["dest_node"],
        substation_loads=flow["substation_loads"],
        overloaded_substations=flow["overloaded_substations"],
        cascaded_substations=flow["cascaded_substations"],
        flooded_substations=flow["flooded_substations"],
        grid_frequency=flow["grid_frequency"],
        voltage_readings=flow["voltage_readings"],
        transmission_line_states=flow["transmission_line_states"],
        water_surface_m=result["water_surface_m"],
        usgs_gage_height=round(result["water_surface_m"] * FEET_PER_METER, 2),
        surface_temp=round(modeled_temp_feature, 1),
        hazard_roads=hazard_roads,
        corridor_capacity=CorridorCapacity(**result.get("corridor_capacity", {})),
        congested_eta_minutes=result.get("congested_eta_minutes", 0.0),
        congestion_factor=result.get("congestion_factor", 1.0),
        destination_name=result.get("destination_name", ""),
        destination_kind=result.get("destination_kind", ""),
    )


@app.get("/api/compare-corridors", response_model=CorridorComparisonResponse)
async def compare_corridors(
    origin: int = Query(..., ge=0),
    flood_level: float = Query(default=0.0, ge=0.0, le=10.0),
    failed_substations: str = Query(default=""),
    travel_mode: TravelMode = Query(default="vehicle"),
    evacuees: int = Query(default=0, ge=0, le=200_000),
    closed_edges: str = Query(default=""),
):
    failed = _parse_int_list(failed_substations, "failed_substations")
    result = compare_exit_corridors(origin, flood_level, failed, travel_mode, evacuees, _parse_closures(closed_edges))
    return CorridorComparisonResponse(
        origin=origin,
        travel_mode=travel_mode,
        corridors=[CorridorInfo(**corridor) for corridor in result["corridors"]],
        flooded_nodes=result["flooded_nodes"],
        blackout_nodes=result["blackout_nodes"],
    )


@app.get("/api/isochrone", response_model=IsochroneResponse)
async def isochrone(
    origin: int = Query(..., ge=0),
    flood_level: float = Query(default=0.0, ge=0.0, le=10.0),
    failed_substations: str = Query(default=""),
    travel_mode: TravelMode = Query(default="vehicle"),
    minutes: str = Query(default="2,4,6,8"),
    evacuees: int = Query(default=0, ge=0, le=200_000),
    closed_edges: str = Query(default=""),
):
    failed = _parse_int_list(failed_substations, "failed_substations")
    try:
        ring_minutes = [float(part) for part in minutes.split(",") if part.strip()]
    except ValueError:
        raise HTTPException(status_code=422, detail="minutes must be a comma-separated list of numbers")
    if not ring_minutes or len(ring_minutes) > 8 or any(m <= 0 or m > 180 for m in ring_minutes):
        raise HTTPException(status_code=422, detail="minutes needs 1-8 values between 0 and 180")
    result = compute_isochrone(origin, flood_level, failed, travel_mode, ring_minutes, evacuees, _parse_closures(closed_edges))
    return IsochroneResponse(
        origin=origin,
        travel_mode=travel_mode,
        rings=[IsochroneRing(**ring) for ring in result["rings"]],
        flooded_nodes=result["flooded_nodes"],
        blackout_nodes=result["blackout_nodes"],
        congestion_factor=result.get("congestion_factor", 1.0),
    )


@app.get("/api/trigger-points", response_model=TriggerPointsResponse)
async def trigger_points(
    origin: int = Query(..., ge=0),
    travel_mode: TravelMode = Query(default="vehicle"),
    closed_edges: str = Query(default=""),
):
    """Water surface at which each exit and shelter stops being reachable."""
    return TriggerPointsResponse(**compute_trigger_points(origin, travel_mode, _parse_closures(closed_edges)))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
