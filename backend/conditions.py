"""Live road-condition model: weather and warnings turned into routing facts.

The router does not consume "it is raining". It consumes the two things rain,
wind, ice and heat actually do to a roadway:

* how deep the water is standing on each junction, against the depth at which
  each travel mode can no longer cross it, and
* how much a segment's achievable speed drops - wet friction, spray and
  visibility, crosswind on exposed decks, ice, and heat stress on foot.

Sources, all public and key-free:

* Open-Meteo - current rainfall rate, 24 h and 6 h accumulation, the coming
  6 h forecast, wind speed and gusts, WMO weather code, air temperature.
* NWS `api.weather.gov/alerts/active` - every active watch, warning, and
  advisory covering the district, with its severity and expiry.
* The USGS gage reading (already fetched for the observations panel) is passed
  in as the river surface, so live river flooding and live rainfall ponding
  stay separate quantities rather than being conflated.

Everything here is deterministic in its inputs, so a route solved from a
recorded condition snapshot can be re-audited later.
"""

from __future__ import annotations

import json
import math
import os
import ssl
import time
import urllib.request
from datetime import datetime, timezone
from typing import Dict, List, Optional, Sequence, Tuple

# Houston storm sewers are designed for roughly a 2-year storm. Sustained
# rainfall above this rate exceeds local drainage and the streets begin to
# hold water; how much depends on how low the street sits.
DRAINAGE_CAPACITY_MM_H = 35.0
# Metres of standing water per mm/h of rainfall that drainage cannot take.
PONDING_M_PER_EXCESS_MM_H = 0.006
MAX_PONDING_M = 1.2
# Wet-pavement friction and spray cost ~10% of achievable speed at saturation.
WET_SPEED_LOSS = 0.10
# Visibility loss starts around moderate rain (7.6 mm/h) and is total by the
# violent end of the scale.
VISIBILITY_ONSET_MM_H = 7.6
VISIBILITY_FULL_MM_H = 30.0
VISIBILITY_SPEED_LOSS = 0.22
# Bridges are exposed; streets between buildings are sheltered.
BRIDGE_WIND_EXPOSURE = 0.85
STREET_WIND_EXPOSURE = 0.18
WIND_GUST_ONSET_MPH = 25.0
WIND_GUST_RANGE_MPH = 45.0
# Water shallower than this sheets across the roadway without deciding
# anything. Below it the router still pays the friction, but the map and the
# operator advisories stay focused on water deep enough to matter.
PONDING_VISIBLE_M = 0.05
# Added seconds per segment traversed through standing water, and the
# equivalent routing cost that makes the solver prefer a dry parallel street.
# Both scale with how close the depth is to the mode's own clearance.
PONDING_DELAY_S = 40.0
PONDING_COST_S = 45.0
PONDING_DELAY_EXPONENT = 2.0
PONDING_COST_EXPONENT = 1.5
# A flood warning is issued because water is already winning somewhere. Even
# against a light local rain gauge, an active warning sets the floor for the
# intensity the roadway is assumed to be draining (mm/h per unit of severity).
FLOOD_ALERT_INTENSITY_FLOOR_MM_H = 30.0
FLOOD_ALERT_INTENSITY_PER_WEIGHT_MM_H = 25.0
# Freezing rain and ice: uniform loss, plus bridges freezing first.
ICE_SPEED_FACTOR = 0.6
ICE_BRIDGE_FACTOR = 0.75
FOG_SPEED_LOSS = 0.35
# Heat: an unacclimatised person on foot in an extreme-heat warning.
HEAT_FOOT_SPEED_LOSS = 0.25

# Depth at which each mode can no longer cross standing water. NWS "Turn
# Around Don't Drown" guidance: 6 in of moving water reaches the body of a
# car and stalls it; 1 ft floats many vehicles. A person is unstable in 6 in;
# 18 in is treated here as impassable on foot.
MODE_CLEARANCE_M = {"vehicle": 0.15, "ems": 0.20, "foot": 0.30}

WMO_LABELS = {
    0: "clear", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "freezing fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
    56: "freezing drizzle", 57: "heavy freezing drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
    66: "freezing rain", 67: "heavy freezing rain", 71: "light snow", 73: "snow", 75: "heavy snow",
    77: "snow grains", 80: "light showers", 81: "showers", 82: "violent showers",
    85: "snow showers", 86: "heavy snow showers", 95: "thunderstorm",
    96: "thunderstorm with hail", 99: "severe thunderstorm with hail",
}

# NWS event name -> the roadway problem it describes. Ordered: the first
# match wins, so "Flash Flood Warning" is flood before it is a warning.
EVENT_HAZARDS: List[Tuple[str, str]] = [
    ("flash flood", "flood"), ("flood", "flood"), ("hurricane", "flood"),
    ("tropical storm", "flood"), ("storm surge", "flood"), ("hydrologic", "flood"),
    ("tornado", "wind"), ("high wind", "wind"), ("wind advisory", "wind"),
    ("extreme wind", "wind"), ("dust storm", "wind"),
    ("ice storm", "ice"), ("winter storm", "ice"), ("winter weather", "ice"),
    ("freezing rain", "ice"), ("blizzard", "ice"), ("snow squall", "ice"),
    ("fog", "fog"), ("dense fog", "fog"),
    ("heat", "heat"),
]

# Weather codes that mean the roadway is freezing.
FREEZING_CODES = {48, 56, 57, 66, 67, 71, 73, 75, 77, 85, 86}

SEVERITY_WEIGHT = {"extreme": 1.0, "severe": 0.75, "moderate": 0.45, "minor": 0.2, "unknown": 0.3}


def _ssl_context() -> Optional[ssl.SSLContext]:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return None


def _get_json(url: str, timeout: float = 6.0) -> Dict:
    request = urllib.request.Request(url, headers={"User-Agent": "GridEvac-AI-Emergency-Operations"})
    with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context()) as response:
        return json.loads(response.read().decode())


def _number(value) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


# ------------------------------------------------------------------ fetchers


def fetch_weather(lat: float, lon: float) -> Dict:
    """Current rainfall, accumulations, the short forecast, and wind."""
    payload = _get_json(
        f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
        "&current=temperature_2m,precipitation,rain,weather_code,wind_speed_10m,wind_gusts_10m"
        "&hourly=precipitation,wind_gusts_10m"
        "&past_hours=24&forecast_hours=6"
        "&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=America%2FChicago"
    )
    current = payload.get("current", {})
    hourly = payload.get("hourly", {}) or {}
    times: Sequence[str] = hourly.get("time", []) or []
    rain = [_number(value) or 0.0 for value in (hourly.get("precipitation", []) or [])]
    gusts = [_number(value) for value in (hourly.get("wind_gusts_10m", []) or [])]
    # The API returns past hours first, ending with the coming 6 hours; the
    # split point is where the series reaches "now".
    now_index = max(0, len(rain) - 6)
    past = rain[:now_index]
    ahead = rain[now_index:]
    observed_at = current.get("time") or (times[now_index] if now_index < len(times) else None)
    # `current.precipitation` is a sum over the block named by `interval`
    # (15 minutes here), so scale it to an hourly rate rather than trusting
    # the units label.
    interval_s = _number(current.get("interval")) or 900.0
    block_mm = _number(current.get("precipitation")) or 0.0
    return {
        "status": "live",
        "observed_at": observed_at,
        "rain_rate_mm_h": round(block_mm * 3600.0 / max(60.0, interval_s), 2),
        "rain_1h_mm": past[-1] if past else 0.0,
        "rain_6h_mm": round(sum(past[-6:]), 2),
        "rain_24h_mm": round(sum(past), 2),
        "rain_6h_forecast_mm": round(sum(ahead), 2),
        "peak_rate_6h_mm_h": round(max([*past[-6:], *ahead, 0.0]), 2),
        "wind_speed_mph": _number(current.get("wind_speed_10m")) or 0.0,
        "wind_gust_mph": _number(current.get("wind_gusts_10m")) or 0.0,
        "gust_6h_forecast_mph": round(max([g for g in gusts[now_index:] if g is not None] or [0.0]), 1),
        "temperature_f": _number(current.get("temperature_2m")) or 0.0,
        "weather_code": int(current.get("weather_code") or 0),
        "source": "Open-Meteo forecast API",
    }


def _alert_hazard(event: str) -> str:
    lowered = (event or "").lower()
    for needle, hazard in EVENT_HAZARDS:
        if needle in lowered:
            return hazard
    return "other"


def fetch_alerts(lat: float, lon: float) -> List[Dict]:
    """Every active NWS watch, warning, and advisory over the district."""
    payload = _get_json(f"https://api.weather.gov/alerts/active?point={lat},{lon}")
    alerts: List[Dict] = []
    for feature in payload.get("features", []) or []:
        props = feature.get("properties", {}) or {}
        event = str(props.get("event") or "Weather alert")
        severity = str(props.get("severity") or "Unknown").lower()
        alerts.append({
            "id": str(props.get("id") or event),
            "event": event,
            "hazard": _alert_hazard(event),
            "severity": severity,
            "weight": SEVERITY_WEIGHT.get(severity, 0.3),
            "urgency": str(props.get("urgency") or "Unknown").lower(),
            "certainty": str(props.get("certainty") or "Unknown").lower(),
            "headline": str(props.get("headline") or ""),
            "instruction": str(props.get("instruction") or ""),
            "sender": str(props.get("senderName") or "NWS"),
            "onset": props.get("onset") or props.get("effective") or "",
            "ends": props.get("ends") or props.get("expires") or "",
        })
    # Most severe first, so the panel and any "worst alert" logic agree.
    alerts.sort(key=lambda alert: (-alert["weight"], alert["event"]))
    return alerts


def unavailable_weather(reason: str = "Open-Meteo forecast API") -> Dict:
    return {
        "status": "unavailable",
        "observed_at": None,
        "rain_rate_mm_h": 0.0,
        "rain_1h_mm": 0.0,
        "rain_6h_mm": 0.0,
        "rain_24h_mm": 0.0,
        "rain_6h_forecast_mm": 0.0,
        "peak_rate_6h_mm_h": 0.0,
        "wind_speed_mph": 0.0,
        "wind_gust_mph": 0.0,
        "gust_6h_forecast_mph": 0.0,
        "temperature_f": 0.0,
        "weather_code": 0,
        "source": reason,
    }


# ------------------------------------------------------------- the model


def _percentile(sorted_values: List[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    index = min(len(sorted_values) - 1, max(0, int(fraction * len(sorted_values))))
    return sorted_values[index]


def ponding_depth_m(elevation: float, intensity_mm_h: float, low_reference_m: float, mid_reference_m: float) -> float:
    """Standing water on a street at `elevation` under a rainfall intensity.

    `lowness` is where the junction sits between the district's low decile and
    its 60th percentile: the bayou-adjacent streets pond first and deepest,
    while high ground with intact drainage clears everything but a downpour.
    """
    span = max(0.5, mid_reference_m - low_reference_m)
    lowness = min(1.0, max(0.0, (mid_reference_m - elevation) / span))
    local_capacity = DRAINAGE_CAPACITY_MM_H * (1.0 - 0.75 * lowness)
    excess = max(0.0, intensity_mm_h - local_capacity)
    depth = PONDING_M_PER_EXCESS_MM_H * excess * (0.35 + 0.65 * lowness)
    return round(min(MAX_PONDING_M, depth), 3)


def build_conditions(
    nodes: Sequence[Dict],
    weather: Optional[Dict] = None,
    alerts: Optional[Sequence[Dict]] = None,
    gage_surface_m: Optional[float] = None,
    pool: int = 0,
) -> Dict:
    """Turn a weather snapshot into per-junction water and per-mode speed.

    Pure: the same inputs always give the same roadway, which is what makes a
    live-conditions route reproducible from a recorded snapshot.
    """
    weather = weather or unavailable_weather()
    alerts = list(alerts or [])
    flooded_elevations = sorted(float(node["elevation"]) for node in nodes)
    low_reference = _percentile(flooded_elevations, 0.05)
    mid_reference = _percentile(flooded_elevations, 0.60)

    # Which roadway problem each alert describes, at its strongest.
    alert_weight: Dict[str, float] = {}
    for alert in alerts:
        hazard = alert.get("hazard", "other")
        alert_weight[hazard] = max(alert_weight.get(hazard, 0.0), float(alert.get("weight", 0.3)))

    rain_rate = float(weather.get("rain_rate_mm_h", 0.0))
    rain_1h = float(weather.get("rain_1h_mm", 0.0))
    rain_6h = float(weather.get("rain_6h_mm", 0.0))
    rain_24h = float(weather.get("rain_24h_mm", 0.0))
    forecast_1h = float(weather.get("rain_6h_forecast_mm", 0.0)) / 6.0
    peak = float(weather.get("peak_rate_6h_mm_h", 0.0))

    # Sustained intensity that drainage actually has to move. The worst of the
    # measuring windows, because a street floods on the peak, not the average.
    intensity = max(rain_rate, rain_1h, rain_6h / 6.0, rain_24h / 24.0, forecast_1h)
    # An active flood warning means water is already winning somewhere in the
    # district; assume the roadway is draining at least the warning's floor
    # even if this one gauge is between cells.
    flood_weight = float(alert_weight.get("flood", 0.0))
    if flood_weight:
        floor = FLOOD_ALERT_INTENSITY_FLOOR_MM_H + FLOOD_ALERT_INTENSITY_PER_WEIGHT_MM_H * flood_weight
        intensity = max(intensity, peak, floor)

    gust = float(weather.get("wind_gust_mph", 0.0))
    if alert_weight.get("wind"):
        gust = max(gust, 40.0 + 25.0 * alert_weight["wind"])
    ice = bool(alert_weight.get("ice")) or int(weather.get("weather_code", 0)) in FREEZING_CODES
    fog = bool(alert_weight.get("fog")) or int(weather.get("weather_code", 0)) in (45, 48)
    heat = float(alert_weight.get("heat", 0.0))

    # Wet-pavement loss, graded by how hard and how long it has been raining:
    # a wet street after light drizzle is not a street after a downpour.
    wetness = min(1.0, max(rain_1h / 4.0, rain_6h / 12.0, rain_24h / 25.0, rain_rate / 8.0))
    visibility_loss = VISIBILITY_SPEED_LOSS * min(1.0, max(0.0, (intensity - VISIBILITY_ONSET_MM_H) / (VISIBILITY_FULL_MM_H - VISIBILITY_ONSET_MM_H)))
    if fog:
        visibility_loss = FOG_SPEED_LOSS

    surface_vehicle = (1.0 - WET_SPEED_LOSS * wetness) * (1.0 - visibility_loss)
    if ice:
        surface_vehicle *= ICE_SPEED_FACTOR
    # Gusts slow everything a little, and exposed decks a lot. The loss is a
    # total per exposure class, so streets and decks stay comparable.
    gust_over = max(0.0, gust - WIND_GUST_ONSET_MPH)
    wind_street = min(0.35, gust_over / WIND_GUST_RANGE_MPH * STREET_WIND_EXPOSURE)
    wind_bridge = min(0.5, gust_over / WIND_GUST_RANGE_MPH * BRIDGE_WIND_EXPOSURE)
    vehicle_factor = max(0.4, surface_vehicle * (1.0 - wind_street))
    vehicle_bridge = max(0.3, surface_vehicle * (1.0 - wind_bridge))

    surface_foot = (1.0 - visibility_loss * 0.6) * (1.0 - heat * HEAT_FOOT_SPEED_LOSS)
    if ice:
        surface_foot *= 0.75
    # A pedestrian is barely slowed by wind off a building, but a person on an
    # exposed deck is pushed around by it.
    foot_factor = max(0.4, surface_foot * (1.0 - 0.35 * wind_street))
    foot_bridge = max(0.4, surface_foot * (1.0 - 0.75 * wind_bridge))

    ponding: Dict[int, float] = {}
    visible: Dict[int, float] = {}
    for node in nodes:
        depth = ponding_depth_m(float(node["elevation"]), intensity, low_reference, mid_reference)
        # A bridge deck is above the standing water on the road beneath it.
        if depth < 0.005 or node.get("elevated"):
            continue
        ponding[int(node["id"])] = depth
        if depth >= PONDING_VISIBLE_M:
            visible[int(node["id"])] = depth

    depth_values = sorted(visible.values())
    deepest = depth_values[-1] if depth_values else 0.0
    impassable = {mode: sorted(node for node, depth in ponding.items() if depth >= clearance) for mode, clearance in MODE_CLEARANCE_M.items()}

    advisories: List[Dict] = []
    if weather.get("status") != "live":
        advisories.append({
            "kind": "feed",
            "severity": "unknown",
            "message": "Live weather feed unreachable: roadway conditions are unknown, so this route assumes dry pavement and no standing water.",
            "affected": 0,
        })
    if visible:
        advisories.append({
            "kind": "ponding",
            "severity": "critical" if impassable["vehicle"] else "warning",
            "message": (
                f"Standing water on {len(visible)} junctions, deepest {deepest:.2f} m "
                f"({deepest * 39.3701:.0f} in); {len(impassable['vehicle'])} impassable to vehicles."
                if impassable["vehicle"]
                else f"Standing water on {len(visible)} junctions, deepest {deepest:.2f} m ({deepest * 39.3701:.0f} in)."
            ),
            "affected": len(visible),
        })
    if wetness > 0.15:
        advisories.append({
            "kind": "surface",
            "severity": "advisory" if wetness < 0.6 else "warning",
            "message": f"Wet pavement: achieved speeds run about {(1 - vehicle_factor) * 100:.0f}% below the dry limit.",
            "affected": 0,
        })
    if gust >= WIND_GUST_ONSET_MPH:
        advisories.append({
            "kind": "wind",
            "severity": "warning" if gust >= 45 else "advisory",
            "message": f"Gusts to {gust:.0f} mph: sheltered streets run {wind_street * 100:.0f}% slower, exposed bridge decks {wind_bridge * 100:.0f}% slower.",
            "affected": 0,
        })
    if ice:
        advisories.append({"kind": "ice", "severity": "critical", "message": "Freezing conditions: the roadway is treated as icy all over, with bridge decks worst.", "affected": 0})
    if fog:
        advisories.append({"kind": "fog", "severity": "warning", "message": f"Dense fog: speeds cut {FOG_SPEED_LOSS * 100:.0f}% and turn guidance assumes reduced sight distance.", "affected": 0})
    if heat:
        advisories.append({"kind": "heat", "severity": "warning", "message": f"Extreme heat: on-foot time inflated {heat * HEAT_FOOT_SPEED_LOSS * 100:.0f}% for heat stress; vehicle routing unaffected.", "affected": 0})
    if not advisories:
        advisories.append({"kind": "clear", "severity": "nominal", "message": "No weather-driven roadway restrictions: dry pavement, no standing water, no active warnings.", "affected": 0})

    return {
        "status": weather.get("status", "unavailable"),
        "observed_at": weather.get("observed_at"),
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "weather_code": int(weather.get("weather_code", 0)),
        "weather_label": WMO_LABELS.get(int(weather.get("weather_code", 0)), "unknown"),
        "temperature_f": round(float(weather.get("temperature_f", 0.0)), 1),
        "rain_rate_mm_h": round(rain_rate, 2),
        "rain_1h_mm": round(rain_1h, 2),
        "rain_6h_mm": round(rain_6h, 2),
        "rain_24h_mm": round(rain_24h, 2),
        "rain_6h_forecast_mm": round(float(weather.get("rain_6h_forecast_mm", 0.0)), 2),
        "peak_rate_6h_mm_h": round(peak, 2),
        "intensity_mm_h": round(intensity, 2),
        "wind_speed_mph": round(float(weather.get("wind_speed_mph", 0.0)), 1),
        "wind_gust_mph": round(gust, 1),
        "river_surface_m": gage_surface_m,
        "wetness": round(wetness, 3),
        "pool": pool,
        "alerts": alerts,
        "ponding_depth_m": {str(node): depth for node, depth in sorted(ponding.items())},
        "ponded_nodes": sorted(visible),
        "deepest_ponding_m": deepest,
        "wetted_nodes": len(ponding),
        "impassable": impassable,
        "speed_factors": {
            "vehicle": round(vehicle_factor, 3),
            "ems": round(min(1.0, vehicle_factor * 1.08), 3),
            "foot": round(foot_factor, 3),
            "bridge_vehicle": round(vehicle_bridge, 3),
            "bridge_ems": round(min(1.0, vehicle_bridge * 1.08), 3),
            "bridge_foot": round(foot_bridge, 3),
            "bridge_wind_loss": round(wind_bridge, 3),
            "street_wind_loss": round(wind_street, 3),
        },
        "advisories": advisories,
        "sources": {
            "weather": weather.get("source", ""),
            "alerts": "NWS api.weather.gov active alerts",
        },
    }


def mode_roadway(conditions: Optional[Dict], travel_mode: str) -> Dict:
    """Per-mode roadway factors the router applies to every segment.

    Returns unity when there are no conditions, so a dry scenario and a
    no-conditions run stay bit-identical.
    """
    if not conditions:
        return {
            "speed_factor": 1.0, "bridge_factor": 1.0, "clearance_m": float("inf"), "ponding": {},
            "impassable": frozenset(), "ponding_delay_s": 0.0, "ponding_penalty_s": 0.0,
            "delay_exponent": 2.0, "cost_exponent": 1.5, "visible_m": PONDING_VISIBLE_M,
        }
    factors = conditions.get("speed_factors", {}) or {}
    mode = travel_mode if travel_mode in MODE_CLEARANCE_M else "vehicle"
    speed_factor = float(factors.get(mode, 1.0) or 1.0)
    bridge_factor = float(factors.get(f"bridge_{mode}", speed_factor) or speed_factor)
    clearance = MODE_CLEARANCE_M[mode]
    # The router scales the delay by how full of water a segment is, so the
    # same depth means less to a pedestrian than to a sedan. Every street
    # shallower than the visible threshold is carried too, at a fraction of
    # the clearance, so friction still shows up in the ETA.
    ponding = {
        int(node): float(depth)
        for node, depth in (conditions.get("ponding_depth_m") or {}).items()
    }
    return {
        "speed_factor": speed_factor,
        # Wet surface and crosswind compound on an exposed deck.
        "bridge_factor": min(speed_factor, bridge_factor),
        "clearance_m": clearance,
        "ponding": ponding,
        "impassable": frozenset(int(node) for node in ((conditions.get("impassable") or {}).get(mode) or [])),
        "ponding_delay_s": PONDING_DELAY_S,
        "ponding_penalty_s": PONDING_COST_S,
        "delay_exponent": PONDING_DELAY_EXPONENT,
        "cost_exponent": PONDING_COST_EXPONENT,
        "visible_m": PONDING_VISIBLE_M,
    }


# ------------------------------------------------------------------- cache

_CACHE: Dict[str, Tuple[float, Dict]] = {}
_CACHE_TTL_S = 300.0
_ALERT_TTL_S = 180.0


def live_conditions(nodes: Sequence[Dict], center_lat: float, center_lon: float, gage_surface_m: Optional[float] = None) -> Dict:
    """Cached live roadway: fetch weather and alerts, then build the model.

    TTLs are short because a flash-flood warning is worth seeing within
    minutes, and the upstream services are free and key-free.
    """
    now = time.monotonic()
    cached = _CACHE.get("weather")
    if cached and now - cached[0] < _CACHE_TTL_S:
        weather = cached[1]
    else:
        try:
            weather = fetch_weather(center_lat, center_lon)
        except Exception:
            weather = unavailable_weather()
        _CACHE["weather"] = (now, weather)

    cached = _CACHE.get("alerts")
    if cached and now - cached[0] < _ALERT_TTL_S:
        alerts = cached[1]
    else:
        try:
            alerts = {"items": fetch_alerts(center_lat, center_lon)}
        except Exception:
            alerts = {"items": []}
        _CACHE["alerts"] = (now, alerts)

    return build_conditions(nodes, weather, alerts["items"], gage_surface_m)


_STATUS_TTL_S = 1800.0


def weather_status() -> Dict:
    """Which live feeds this process can actually reach (reporting only)."""
    cached = _CACHE.get("status")
    now = time.monotonic()
    if cached and now - cached[0] < _STATUS_TTL_S:
        return cached[1]
    probes = {
        "open_meteo": "https://api.open-meteo.com/v1/forecast?latitude=29.76&longitude=-95.37&current=temperature_2m",
        "nws_alerts": "https://api.weather.gov/alerts/active?point=29.76,-95.37",
        "usgs_iv": "https://waterservices.usgs.gov/nwis/iv/?format=json&sites=08074000&parameterCd=00065",
    }
    result: Dict[str, bool] = {}
    for name, url in probes.items():
        try:
            _get_json(url, timeout=4.0)
            result[name] = True
        except Exception:
            result[name] = False
    _CACHE["status"] = (now, result)
    return result


def reset_cache() -> None:
    """Test hook: drop cached upstream readings."""
    _CACHE.clear()


if __name__ == "__main__":  # pragma: no cover - manual probe
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "data", "houston_network.json")) as handle:
        network = json.load(handle)
    meta = network["meta"]
    live = live_conditions(network["nodes"], meta["center_lat"], meta["center_lon"])
    print(json.dumps({key: value for key, value in live.items() if key not in {"ponding_depth_m", "impassable", "alerts"}}, indent=2))
    print("alerts:", len(live["alerts"]))
    print("impassable:", {mode: len(nodes_) for mode, nodes_ in live["impassable"].items()})
