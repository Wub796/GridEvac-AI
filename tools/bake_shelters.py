"""Bake real Houston evacuation destinations into the baked street network.

Each destination is a real, publicly documented facility inside the baked
district (downtown Houston). It is snapped to the nearest street-network
junction at build time so routing can treat it as a graph destination, and
the snap distance is recorded so callers can flag unusable placements.

Run from the repo root:  python3 tools/bake_shelters.py
"""

import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COPIES = [
    os.path.join(ROOT, "backend", "data", "houston_network.json"),
    os.path.join(ROOT, "frontend", "api", "data", "houston_network.json"),
    os.path.join(ROOT, "frontend", "public", "data", "houston_network.json"),
]

# Real facilities inside the baked district, with rough public capacities.
SHELTERS = [
    {
        "id": "grb",
        "name": "George R. Brown Convention Center",
        "kind": "shelter",
        "capacity": 10000,
        "lat": 29.7520,
        "lon": -95.3568,
        "note": "Harris County primary evacuation shelter",
    },
    {
        "id": "uhd",
        "name": "University of Houston-Downtown",
        "kind": "shelter",
        "capacity": 5000,
        "lat": 29.7617,
        "lon": -95.3593,
        "note": "Downtown campus shelter and assembly point",
    },
    {
        "id": "metropolitan",
        "name": "Metropolitan Multi-Service Center",
        "kind": "shelter",
        "capacity": 3000,
        "lat": 29.7533,
        "lon": -95.3895,
        "note": "City of Houston shelter of last resort",
    },
    {
        "id": "stjoseph",
        "name": "St. Joseph Medical Center",
        "kind": "medical",
        "capacity": 600,
        "lat": 29.7465,
        "lon": -95.3653,
        "note": "EMS destination - hospital with shelter capacity",
    },
]


def snap(network: dict, lat: float, lon: float):
    best_node = -1
    best_distance = float("inf")
    for node in network["nodes"]:
        distance = math.hypot(
            (node["lat"] - lat) * 111_320.0,
            (node["lon"] - lon) * 111_320.0 * math.cos(math.radians(lat)),
        )
        if distance < best_distance:
            best_distance = distance
            best_node = node["id"]
    return best_node, round(best_distance, 1)


def main():
    for path in COPIES:
        with open(path) as handle:
            network = json.load(handle)
        baked = []
        for shelter in SHELTERS:
            node, distance = snap(network, shelter["lat"], shelter["lon"])
            baked.append({**shelter, "node": node, "snap_distance_m": distance})
        network["shelters"] = baked
        with open(path, "w") as handle:
            json.dump(network, handle)
        print(f"{path}:")
        for shelter in baked:
            print(f"  {shelter['id']:>12} -> node {shelter['node']:>5}  ({shelter['snap_distance_m']} m)")


if __name__ == "__main__":
    main()