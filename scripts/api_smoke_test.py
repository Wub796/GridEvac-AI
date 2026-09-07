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


def main() -> int:
    client = make_client()

    print(f"GridEvac API smoke test against {BASE}{' (in-process)' if INPROCESS else ''}\n")

    # Health
    r = client.get("/health")
    check("GET /health", r.status_code == 200, f"{r.status_code}")
    if r.status_code == 200:
        check("  health payload", r.json().get("status") == "ok")

    # City graph
    r = client.get("/api/city")
    check("GET /api/city", r.status_code == 200, f"{r.status_code}")
    city = r.json() if r.status_code == 200 else {}
    nodes = city.get("nodes", [])
    exits = city.get("safe_exits", [])
    shelters = city.get("shelters", [])
    check("  city has nodes", len(nodes) > 0, f"{len(nodes)} nodes")
    check("  city has exits", len(exits) >= 4, f"{len(exits)} exits")
    check("  city has shelters", len(shelters) >= 3, f"{len(shelters)} shelters")
    check("  shelters snapped to network", all(s.get("node", -1) >= 0 and s.get("snap_distance_m", 9e9) < 1000 for s in shelters))

    # Route: nominal vehicle
    origin = exits[0] if exits else 1075
    dry_origin = None
    # find a dry interior node to route from (exits are endpoints, not origins)
    for node in nodes:
        if node["id"] not in exits:
            dry_origin = node["id"]
            break
    # NOTE: `is not None`, not truthiness — node id 0 is a valid interior origin.
    origin = dry_origin if dry_origin is not None else origin

    r = client.post("/api/calculate-route", json={
        "flood_level": 0.0, "failed_substations": [], "origin_node": origin, "travel_mode": "vehicle",
    })
    check("POST /api/calculate-route (vehicle, dry)", r.status_code == 200, f"{r.status_code}")
    route = r.json() if r.status_code == 200 else {}
    check("  route success", route.get("success") is True)
    check("  congested == free at zero demand", route.get("congested_eta_minutes") == route.get("eta_minutes"))
    if os.environ.get("SMOKE_DEBUG"):
        print(f"DEBUG origin={origin} exits={exits[:6]} first_nodes={[n['id'] for n in nodes[:6]]}")
        print("DEBUG route payload:", json.dumps(route, indent=1)[:600])
    check("  route has capacity", (route.get("corridor_capacity") or {}).get("people_per_hour", 0) > 0,
          f"{(route.get('corridor_capacity') or {}).get('people_per_hour')} ppl/hr")
    check("  route has steps", len(route.get("route_steps", [])) > 0)

    # Route: foot mode should take longer than vehicle on the same scenario
    r2 = client.post("/api/calculate-route", json={
        "flood_level": 0.0, "failed_substations": [], "origin_node": origin, "travel_mode": "foot",
    })
    foot = r2.json() if r2.status_code == 200 else {}
    check("POST /api/calculate-route (foot)", r2.status_code == 200 and foot.get("success") is True)
    if route.get("eta_minutes") and foot.get("eta_minutes"):
        check("  foot slower than vehicle", foot["eta_minutes"] > route["eta_minutes"],
              f"{foot['eta_minutes']} vs {route['eta_minutes']} min")

    # Route: evacuation demand inflates ETA (BPR congestion)
    r_demand = client.post("/api/calculate-route", json={
        "flood_level": 0.0, "failed_substations": [], "origin_node": origin, "travel_mode": "vehicle", "evacuees": 60_000,
    })
    demand = r_demand.json() if r_demand.status_code == 200 else {}
    check("POST /api/calculate-route (60k evacuees)", r_demand.status_code == 200, f"{r_demand.status_code}")
    if demand.get("success") and route.get("eta_minutes"):
        check("  congested ETA > free ETA", demand["congested_eta_minutes"] > demand["eta_minutes"],
              f"{demand['congested_eta_minutes']} vs {demand['eta_minutes']} min")

    # Route: to a real shelter destination
    shelter_id = shelters[0]["id"] if shelters else None
    if shelter_id:
        r_dest = client.post("/api/calculate-route", json={
            "flood_level": 0.0, "failed_substations": [], "origin_node": origin, "travel_mode": "vehicle", "destination": shelter_id,
        })
        dest = r_dest.json() if r_dest.status_code == 200 else {}
        check("POST /api/calculate-route (to shelter)", r_dest.status_code == 200 and dest.get("success") is True, f"{r_dest.status_code}")
        check("  destination name set", bool(dest.get("destination_name")), dest.get("destination_name", ""))
        if shelters[0].get("node") is not None:
            check("  terminates at shelter node", dest.get("dest_node") == shelters[0]["node"],
                  f"{dest.get('dest_node')} vs {shelters[0]['node']}")

    # Route: flood 7.2 stress
    r3 = client.post("/api/calculate-route", json={
        "flood_level": 7.2, "failed_substations": [], "origin_node": origin, "travel_mode": "vehicle",
    })
    check("POST /api/calculate-route (flood 7.2)", r3.status_code == 200, f"{r.status_code}")

    # Corridor comparison
    r = client.get("/api/compare-corridors", params={
        "origin": origin, "flood_level": 0.0, "failed_substations": "", "travel_mode": "vehicle",
    })
    check("GET /api/compare-corridors", r.status_code == 200, f"{r.status_code}")
    corridors = r.json().get("corridors", []) if r.status_code == 200 else []
    check("  all exits ranked", len(corridors) >= 4, f"{len(corridors)} corridors")
    check("  ranked ascending", corridors == sorted(corridors, key=lambda c: c["eta_minutes"]))
    check("  corridors carry capacity", all(c.get("people_per_hour", 0) > 0 for c in corridors))

    # Corridor comparison under demand: congested ETAs everywhere
    r_cong = client.get("/api/compare-corridors", params={
        "origin": origin, "flood_level": 0.0, "travel_mode": "vehicle", "evacuees": 60_000,
    })
    congested = r_cong.json().get("corridors", []) if r_cong.status_code == 200 else []
    check("GET /api/compare-corridors (60k evacuees)", r_cong.status_code == 200, f"{r_cong.status_code}")
    check("  congested ETAs > free", congested and all(c["congested_eta_minutes"] >= c["eta_minutes"] for c in congested))

    # Isochrone
    r = client.get("/api/isochrone", params={
        "origin": origin, "flood_level": 0.0, "travel_mode": "foot", "minutes": "5,10,15",
    })
    check("GET /api/isochrone", r.status_code == 200, f"{r.status_code}")
    rings = r.json().get("rings", []) if r.status_code == 200 else []
    check("  rings returned", len(rings) == 3, f"{len(rings)} rings")
    if len(rings) == 3:
        check("  ring counts grow", rings[0]["node_count"] <= rings[1]["node_count"] <= rings[2]["node_count"],
              f"{[ring['node_count'] for ring in rings]}")

    # Isochrone under demand: rings shrink, factor reported
    r_cong_iso = client.get("/api/isochrone", params={
        "origin": origin, "flood_level": 0.0, "travel_mode": "foot", "minutes": "5,10,15", "evacuees": 40_000,
    })
    iso_cong = r_cong_iso.json() if r_cong_iso.status_code == 200 else {}
    check("GET /api/isochrone (40k evacuees)", r_cong_iso.status_code == 200, f"{r_cong_iso.status_code}")
    check("  congestion factor > 1", (iso_cong.get("congestion_factor") or 1) > 1.0,
          f"x{iso_cong.get('congestion_factor')}")
    if iso_cong.get("rings") and rings:
        total_cong = sum(r["node_count"] for r in iso_cong["rings"])
        total_free = sum(r["node_count"] for r in rings)
        check("  reachability shrinks under demand", total_cong < total_free, f"{total_cong} vs {total_free} nodes")

    # Flood zones
    r = client.get("/api/flood-zones", params={"flood_level": 3.0})
    check("GET /api/flood-zones", r.status_code == 200, f"{r.status_code}")

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: {', '.join(failures)}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
