#!/usr/bin/env python3
"""One-command smoke test for every GridEvac API endpoint.

Usage: python3 scripts/api_smoke_test.py [base_url | --inprocess]
       default base_url: http://localhost:8000
       --inprocess: exercise the FastAPI app directly (no server needed)

Exits non-zero if any endpoint fails or returns an incoherent payload.
"""

import json
import os
import sys
from typing import Optional

import httpx

INPROCESS = "--inprocess" in sys.argv
BASE = next((a for a in sys.argv[1:] if not a.startswith("--")), "http://localhost:8000")
failures: list = []


def make_client():
    if not INPROCESS:
        return httpx.Client(base_url=BASE, timeout=30.0)
    # In-process ASGI: no network, no server process.
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
    from fastapi.testclient import TestClient
    import main as api  # backend/main.py
    return TestClient(api.app)


def check(name: str, condition: bool, detail: str = "") -> None:
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {name}{f' - {detail}' if detail else ''}")
    if not condition:
        failures.append(name)


def route(client, **overrides):
    body = {"flood_level": 0.0, "failed_substations": [], "travel_mode": "vehicle", **overrides}
    response = client.post("/api/calculate-route", json=body)
    return response.status_code, (response.json() if response.status_code == 200 else {})


def main() -> int:
    client = make_client()
    print(f"GridEvac API smoke test against {BASE}{' (in-process)' if INPROCESS else ''}\n")

    r = client.get("/health")
    check("GET /health", r.status_code == 200, f"{r.status_code}")
    if r.status_code == 200:
        check("  health payload", r.json().get("status") == "ok")

    # ---- CORS ----
    # `next dev` takes whatever port is free, so every loopback origin must be
    # accepted without GRIDEVAC_CORS_ORIGINS; otherwise the board silently falls
    # back to the browser solver. Anything else stays opt-in.
    for origin in ("http://localhost:5173", "http://127.0.0.1:4321"):
        r = client.options("/api/city", headers={"Origin": origin, "Access-Control-Request-Method": "GET"})
        check(f"CORS preflight from {origin}",
              r.status_code == 200 and r.headers.get("access-control-allow-origin") == origin,
              f"{r.status_code} {r.headers.get('access-control-allow-origin', 'no header')}")
    r = client.options("/api/calculate-route", headers={
        "Origin": "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    })
    check("  POST preflight allows the JSON body",
          r.status_code == 200 and r.headers.get("access-control-allow-origin") == "http://localhost:5173",
          f"{r.status_code}")
    r = client.options("/api/city", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    check("  foreign origin refused",
          r.status_code == 400 and "access-control-allow-origin" not in r.headers,
          f"{r.status_code}")

    r = client.get("/api/city", headers={"Accept-Encoding": "gzip"})
    check("GET /api/city", r.status_code == 200, f"{r.status_code}")
    city = r.json() if r.status_code == 200 else {}
    nodes = city.get("nodes", [])
    edges = city.get("edges", [])
    exits = city.get("safe_exits", [])
    shelters = city.get("shelters", [])
    check("  city has nodes", len(nodes) > 0, f"{len(nodes)} nodes")
    check("  city has exits", len(exits) >= 4, f"{len(exits)} exits")
    check("  city has shelters", len(shelters) >= 3, f"{len(shelters)} shelters")
    check("  shelters snapped to network", all(s.get("node", -1) >= 0 and s.get("snap_distance_m", 9e9) < 1000 for s in shelters))
    check("  street curves survive the API", sum(1 for e in edges if e.get("geometry")) > len(edges) // 3,
          f"{sum(1 for e in edges if e.get('geometry'))} curved segments")
    check("  junctions carry flood stages", all(n.get("flood_stage_m") is not None for n in nodes))
    check("  flood model published", (city.get("flood_model") or {}).get("rise_per_level_m", 0) > 0)
    check("  waterways published", len(city.get("waterways", [])) > 0)

    # The graph is static, so repeat loads must not reach the function: a long
    # max-age/s-maxage pair plus an ETag that turns revalidation into a 304.
    cache_control = r.headers.get("cache-control", "")
    check("  city is cacheable", "max-age=" in cache_control and "s-maxage=" in cache_control
          and "stale-while-revalidate" in cache_control, cache_control or "no header")
    etag = r.headers.get("etag")
    check("  city has an ETag", bool(etag), etag or "no header")
    if etag:
        r_cond = client.get("/api/city", headers={"If-None-Match": etag})
        check("  matching If-None-Match is a 304", r_cond.status_code == 304, f"{r_cond.status_code}")
        r_stale = client.get("/api/city", headers={"If-None-Match": '"stale"'})
        check("  other ETag still returns the body", r_stale.status_code == 200, f"{r_stale.status_code}")

    # A dry interior junction with a named street (exits are endpoints, not origins).
    # `is not None`, not truthiness: node id 0 is a valid interior origin.
    origin = next((n["id"] for n in nodes if n["id"] not in exits and not n.get("elevated")), exits[0] if exits else 0)

    status, vehicle = route(client, origin_node=origin)
    check("POST /api/calculate-route (vehicle, dry)", status == 200, f"{status}")
    check("  route success", vehicle.get("success") is True)
    check("  congested == free at zero demand", vehicle.get("congested_eta_minutes") == vehicle.get("eta_minutes"))
    check("  route has capacity", (vehicle.get("corridor_capacity") or {}).get("people_per_hour", 0) > 0,
          f"{(vehicle.get('corridor_capacity') or {}).get('people_per_hour')} ppl/hr")
    steps = vehicle.get("route_steps", [])
    check("  route has steps", len(steps) > 0)
    check("  first step departs, later steps carry maneuvers",
          bool(steps) and steps[0].get("maneuver") == "depart" and all(s.get("maneuver") for s in steps))
    check("  route follows street curves", len(vehicle.get("path_coords", [])) >= len(vehicle.get("path", [])))
    step_minutes = sum(s["duration_s"] for s in steps) / 60.0
    check("  step durations add up to the ETA", abs(step_minutes - vehicle.get("eta_minutes", 0)) <= 0.15,
          f"{step_minutes:.2f} vs {vehicle.get('eta_minutes')} min")
    if os.environ.get("SMOKE_DEBUG"):
        print("DEBUG route payload:", json.dumps(vehicle, indent=1)[:900])

    status, foot = route(client, origin_node=origin, travel_mode="foot")
    check("POST /api/calculate-route (foot)", status == 200 and foot.get("success") is True)
    if vehicle.get("eta_minutes") and foot.get("eta_minutes"):
        check("  foot slower than vehicle", foot["eta_minutes"] > vehicle["eta_minutes"],
              f"{foot['eta_minutes']} vs {vehicle['eta_minutes']} min")

    r = client.post("/api/calculate-route", json={"flood_level": 0, "failed_substations": [], "origin_node": origin, "travel_mode": "boat"})
    check("  unknown travel mode rejected", r.status_code == 422, f"{r.status_code}")

    status, demand = route(client, origin_node=origin, evacuees=60_000)
    check("POST /api/calculate-route (60k evacuees)", status == 200, f"{status}")
    if demand.get("success"):
        check("  congested ETA > free ETA", demand["congested_eta_minutes"] > demand["eta_minutes"],
              f"{demand['congested_eta_minutes']} vs {demand['eta_minutes']} min")
        check("  clearance time reported", demand["corridor_capacity"]["clearance_minutes"] > 0)

    if shelters:
        status, dest = route(client, origin_node=origin, destination=shelters[0]["id"])
        check("POST /api/calculate-route (to shelter)", status == 200 and dest.get("success") is True, f"{status}")
        check("  destination name set", bool(dest.get("destination_name")), dest.get("destination_name", ""))
        check("  terminates at shelter node", dest.get("dest_node") == shelters[0]["node"],
              f"{dest.get('dest_node')} vs {shelters[0]['node']}")

    # ---- live road conditions (rainfall ponding, wet/wind/ice/heat) ----

    def weather_snapshot(rate: float, gust: float = 0.0, code: int = 0, alerts: Optional[list] = None) -> dict:
        """A normalized Open-Meteo/NWS snapshot, so these checks need no network."""
        return {
            "weather": {
                "status": "live", "observed_at": "2026-09-19T21:00",
                "rain_rate_mm_h": rate, "rain_1h_mm": rate, "rain_6h_mm": rate * 2, "rain_24h_mm": rate * 3,
                "rain_6h_forecast_mm": rate * 2, "peak_rate_6h_mm_h": rate,
                "wind_speed_mph": gust * 0.6, "wind_gust_mph": gust,
                "temperature_f": 84.0, "weather_code": code, "source": "smoke test",
            },
            "alerts": alerts or [],
            "gage_surface_m": None,
        }

    status, clear = route(client, origin_node=origin)
    check("  dry route reports its own dry baseline", clear.get("dry_eta_minutes") == clear.get("eta_minutes"),
          f"{clear.get('dry_eta_minutes')} vs {clear.get('eta_minutes')} min")
    check("  dry route carries no condition block", clear.get("road_conditions") is None)

    status, wet = route(client, origin_node=origin, use_live_conditions=True, conditions=weather_snapshot(60.0))
    check("POST /api/calculate-route (60 mm/h rain)", status == 200 and wet.get("success") is True, f"{status}")
    wet_conditions = wet.get("road_conditions") or {}
    check("  conditions echoed back", bool(wet_conditions), wet_conditions.get("weather_label", ""))
    check("  rain slows the roadway", 0 < wet_conditions.get("speed_factor", 1) < 1, f"x{wet_conditions.get('speed_factor')}")
    check("  rain inflates the ETA above the dry baseline", wet.get("eta_minutes", 0) > wet.get("dry_eta_minutes", 0),
          f"{wet.get('eta_minutes')} vs {wet.get('dry_eta_minutes')} min")
    check("  delay attributed to weather", wet.get("weather_delay_s", 0) > 0, f"{wet.get('weather_delay_s')} s")
    check("  standing water is found", len(wet_conditions.get("ponded_nodes") or []) > 0,
          f"{len(wet_conditions.get('ponded_nodes') or [])} junctions")
    check("  segments too deep to cross are reported", len(wet.get("ponded_edges") or []) > 0,
          f"{len(wet.get('ponded_edges') or [])} segments")
    check("  route steers around the water it can", wet.get("route_ponded_segments", 0) < len(wet.get("path", [])),
          f"{wet.get('route_ponded_segments')} of {len(wet.get('path', []))} segments")
    # The dry baseline is per-path, so a condition-aware detour legitimately
    # has a different one. What must hold is that the reported weather delay
    # is exactly the gap between the route and its own dry baseline.
    gap_seconds = (wet.get("eta_minutes", 0) - wet.get("dry_eta_minutes", 0)) * 60.0
    check("  weather delay is the gap to the dry baseline",
          abs(wet.get("weather_delay_s", 0) - gap_seconds) <= 1.5,
          f"{wet.get('weather_delay_s')} s vs {gap_seconds:.1f} s")
    check("  the dry baseline is never slower than the conditioned route",
          wet.get("dry_eta_minutes", 0) <= wet.get("eta_minutes", 0),
          f"{wet.get('dry_eta_minutes')} vs {wet.get('eta_minutes')} min")
    ponding_advisory = next((a for a in wet_conditions.get("advisories", []) if a.get("kind") == "ponding"), None)
    check("  standing water is explained in plain language", ponding_advisory is not None,
          (ponding_advisory or {}).get("message", "")[:70])

    status, flooded_out = route(client, origin_node=origin, use_live_conditions=True, conditions=weather_snapshot(140.0))
    check("POST /api/calculate-route (140 mm/h, district-impassable)", status == 200, f"{status}")
    check("  extreme rainfall leaves no route", flooded_out.get("success") is False, flooded_out.get("message", "")[:70])

    status, warned = route(client, origin_node=origin, use_live_conditions=True, conditions=weather_snapshot(
        3.0, alerts=[{"event": "Flash Flood Warning", "hazard": "flood", "severity": "severe", "weight": 0.75}]))
    warned_conditions = warned.get("road_conditions") or {}
    check("POST /api/calculate-route (flash flood warning)", status == 200, f"{status}")
    check("  warning raises the assumed rainfall intensity", warned_conditions.get("intensity_mm_h", 0) > 30,
          f"{warned_conditions.get('intensity_mm_h')} mm/h from a 3 mm/h local gauge")
    check("  warning is carried through to the operator",
          bool(warned_conditions.get("alerts")) and warned_conditions["alerts"][0]["event"] == "Flash Flood Warning")

    status, windy = route(client, origin_node=origin, use_live_conditions=True,
                          conditions=weather_snapshot(0.0, gust=60.0))
    wind_factors = (windy.get("road_conditions") or {}).get("speed_factors", {})
    check("POST /api/calculate-route (60 mph gusts)", status == 200, f"{status}")
    check("  bridge decks slow more than sheltered streets",
          wind_factors.get("bridge_vehicle", 1) < wind_factors.get("vehicle", 1),
          f"deck x{wind_factors.get('bridge_vehicle')} vs street x{wind_factors.get('vehicle')}")

    status, icy = route(client, origin_node=origin, use_live_conditions=True, conditions=weather_snapshot(3.0, code=66))
    check("POST /api/calculate-route (freezing rain)", status == 200, f"{status}")
    check("  freezing conditions cut speed hardest", (icy.get("road_conditions") or {}).get("speed_factor", 1) <= 0.6,
          f"x{(icy.get('road_conditions') or {}).get('speed_factor')}")

    status, hot = route(client, origin_node=origin, travel_mode="foot", use_live_conditions=True, conditions=weather_snapshot(
        0.0, alerts=[{"event": "Excessive Heat Warning", "hazard": "heat", "severity": "severe", "weight": 0.75}]))
    check("POST /api/calculate-route (heat warning, on foot)", status == 200, f"{status}")
    check("  heat slows pedestrians only", (hot.get("road_conditions") or {}).get("speed_factor", 1) < 0.9,
          f"foot x{(hot.get('road_conditions') or {}).get('speed_factor')}")
    status, hot_drive = route(client, origin_node=origin, use_live_conditions=True, conditions=weather_snapshot(
        0.0, alerts=[{"event": "Excessive Heat Warning", "hazard": "heat", "severity": "severe", "weight": 0.75}]))
    check("  heat leaves vehicles alone", abs(hot_drive.get("eta_minutes", 0) - clear.get("eta_minutes", 0)) <= 0.1,
          f"{hot_drive.get('eta_minutes')} vs {clear.get('eta_minutes')} min")

    # ---- operator's own destination ----

    inner = [n["id"] for n in nodes if n["id"] not in exits and not n.get("elevated") and n["id"] != origin]
    custom_target = inner[len(inner) // 2]
    status, custom = route(client, origin_node=origin, destination_node=custom_target, destination_label="Rally point 4")
    check("POST /api/calculate-route (custom destination)", status == 200 and custom.get("success") is True, f"{status}")
    check("  route terminates at the operator's junction", custom.get("dest_node") == custom_target,
          f"{custom.get('dest_node')} vs {custom_target}")
    check("  custom destination is labelled", custom.get("destination_name") == "Rally point 4", custom.get("destination_name", ""))
    check("  custom destination is typed", custom.get("destination_kind") == "custom", custom.get("destination_kind", ""))
    check("  custom route still has turn-by-turn steps", len(custom.get("route_steps", [])) > 0)

    status, same = route(client, origin_node=origin, destination_node=origin)
    check("  destination at the origin is refused", same.get("success") is False, same.get("message", "")[:60])
    status, nowhere = route(client, origin_node=origin, destination_node=30000)
    check("  destination outside the district is refused", nowhere.get("success") is False, nowhere.get("message", "")[:60])

    # ---- corridors under conditions ----

    r = client.get("/api/compare-corridors", params={"origin": origin, "travel_mode": "vehicle", "use_live_conditions": True})
    check("GET /api/compare-corridors (live conditions)", r.status_code == 200, f"{r.status_code}")
    live_corridors = r.json() if r.status_code == 200 else {}
    check("  corridors carry standing-water detail",
          all("ponded_segments" in c and "max_ponding_m" in c for c in live_corridors.get("corridors", [])))
    check("  unusable exits are listed", isinstance(live_corridors.get("unusable_exits"), list))

    # Closing the first segment of the route forces a different first segment.
    if len(vehicle.get("path", [])) >= 2:
        first = vehicle["path"][:2]
        status, detour = route(client, origin_node=origin, closed_edges=[first])
        check("POST /api/calculate-route (road closure)", status == 200, f"{status}")
        check("  closure reported", [sorted(e) for e in detour.get("closed_edges", [])] == [sorted(first)])
        check("  route avoids the closed segment", detour.get("path", [])[:2] != first)

    status, flood = route(client, origin_node=origin, flood_level=8.0)
    check("POST /api/calculate-route (flood 8.0)", status == 200, f"{status}")
    check("  water surface reported", flood.get("water_surface_m", 0) > 0, f"{flood.get('water_surface_m')} m NAVD88")

    r = client.get("/api/compare-corridors", params={"origin": origin, "flood_level": 0.0, "travel_mode": "vehicle"})
    check("GET /api/compare-corridors", r.status_code == 200, f"{r.status_code}")
    corridors = r.json().get("corridors", []) if r.status_code == 200 else []
    check("  all exits ranked", len(corridors) >= 4, f"{len(corridors)} corridors")
    check("  ranked safest first", corridors == sorted(corridors, key=lambda c: (c["cost_minutes"], c["eta_minutes"])))
    check("  best corridor is the recommendation", bool(corridors) and corridors[0]["exit_node"] == vehicle.get("dest_node"))
    check("  corridors carry capacity", all(c.get("people_per_hour", 0) > 0 for c in corridors))

    r = client.get("/api/compare-corridors", params={"origin": origin, "travel_mode": "vehicle", "evacuees": 60_000})
    congested = r.json().get("corridors", []) if r.status_code == 200 else []
    check("GET /api/compare-corridors (60k evacuees)", r.status_code == 200, f"{r.status_code}")
    check("  congested ETAs >= free", bool(congested) and all(c["congested_eta_minutes"] >= c["eta_minutes"] for c in congested))

    r = client.get("/api/isochrone", params={"origin": origin, "travel_mode": "foot", "minutes": "5,10,15"})
    check("GET /api/isochrone", r.status_code == 200, f"{r.status_code}")
    rings = r.json().get("rings", []) if r.status_code == 200 else []
    check("  rings returned", len(rings) == 3, f"{len(rings)} rings")
    if len(rings) == 3:
        check("  ring counts grow", rings[0]["node_count"] <= rings[1]["node_count"] <= rings[2]["node_count"],
              f"{[ring['node_count'] for ring in rings]}")

    r = client.get("/api/isochrone", params={"origin": origin, "travel_mode": "foot", "minutes": "5,10,15", "evacuees": 60_000})
    iso = r.json() if r.status_code == 200 else {}
    check("GET /api/isochrone (60k evacuees)", r.status_code == 200, f"{r.status_code}")
    check("  congestion factor > 1", (iso.get("congestion_factor") or 1) > 1.0, f"x{iso.get('congestion_factor')}")
    if iso.get("rings") and rings:
        check("  reachability shrinks under demand",
              sum(ring["node_count"] for ring in iso["rings"]) < sum(ring["node_count"] for ring in rings))
    r = client.get("/api/isochrone", params={"origin": origin, "minutes": "abc"})
    check("  malformed minutes rejected", r.status_code == 422, f"{r.status_code}")

    r = client.get("/api/trigger-points", params={"origin": origin})
    check("GET /api/trigger-points", r.status_code == 200, f"{r.status_code}")
    triggers = r.json() if r.status_code == 200 else {}
    targets = triggers.get("targets", [])
    check("  every exit and shelter has a trigger", len(targets) >= len(exits) + len(shelters) - 1, f"{len(targets)} targets")
    check("  triggers never exceed the origin's own stage", all(t["threshold_m"] <= triggers["origin_stage_m"] + 1e-6 for t in targets))
    if targets:
        best = targets[0]
        below = best["threshold_level"] - 0.05
        above = best["threshold_level"] + 0.05
        if 0 <= below <= 10 and best["kind"] == "exit":
            _, dry = route(client, origin_node=origin, flood_level=round(below, 2))
            check("  just below the best trigger a route exists", dry.get("success") is True, f"level {below:.2f}")
        if 0 <= above <= 10:
            _, wet = route(client, origin_node=origin, flood_level=round(max(t["threshold_level"] for t in targets) + 0.05, 2))
            check("  above every trigger no route exists", wet.get("success") is False)

    r = client.get("/api/flood-zones", params={"flood_level": 8.0})
    check("GET /api/flood-zones", r.status_code == 200, f"{r.status_code}")

    if os.environ.get("SMOKE_OBSERVATIONS"):
        r = client.get("/api/observations")
        check("GET /api/observations", r.status_code == 200, f"{r.status_code}")

    if os.environ.get("SMOKE_LIVE"):
        r = client.get("/api/conditions")
        check("GET /api/conditions", r.status_code == 200, f"{r.status_code}")
        live = r.json().get("conditions", {}) if r.status_code == 200 else {}
        check("  live conditions carry a source", bool(live.get("sources", {}).get("weather")), live.get("status", ""))
        check("  speed factors published for every mode",
              all(mode in live.get("speed_factors", {}) for mode in ("vehicle", "ems", "foot")))
        check("  advisories always explain the roadway", len(live.get("advisories", [])) > 0)

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: {', '.join(failures)}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
