"""Bake real Houston evacuation destinations into the baked street network.

Each destination is a real, publicly documented facility inside the baked
district (downtown Houston). It is snapped at build time to the nearest
street junction that a vehicle can both reach and leave: the largest
strongly connected component of the one-way street graph, excluding bridge
decks. The snap distance is recorded so callers can flag unusable
placements.

Run from the repo root after tools/bake_street_attributes.py:
  python3 tools/bake_shelters.py
"""

import json
import math
import os
from collections import defaultdict

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


def vehicle_core(network: dict) -> set:
    """Largest strongly connected component of the one-way graph (Kosaraju)."""
    forward, backward = defaultdict(list), defaultdict(list)
    for edge in network["edges"]:
        source, target, oneway = edge["source"], edge["target"], int(edge.get("oneway", 0))
        arcs = [(source, target)] if oneway == 1 else [(target, source)] if oneway == -1 else [(source, target), (target, source)]
        for a, b in arcs:
            forward[a].append(b)
            backward[b].append(a)

    order, visited = [], set()
    for start in (node["id"] for node in network["nodes"]):
        if start in visited:
            continue
        visited.add(start)
        stack = [(start, iter(forward[start]))]
        while stack:
            node, successors = stack[-1]
            for successor in successors:
                if successor not in visited:
                    visited.add(successor)
                    stack.append((successor, iter(forward[successor])))
                    break
            else:
                stack.pop()
                order.append(node)

    component_of, components = {}, []
    for start in reversed(order):
        if start in component_of:
            continue
        component_of[start] = len(components)
        members, stack = [start], [start]
        while stack:
            node = stack.pop()
            for predecessor in backward[node]:
                if predecessor not in component_of:
                    component_of[predecessor] = len(components)
                    members.append(predecessor)
                    stack.append(predecessor)
        components.append(members)
    return set(max(components, key=len))


def snap(network: dict, lat: float, lon: float, allowed: set):
    best_node, best_distance = -1, float("inf")
    for node in network["nodes"]:
        if node["id"] not in allowed or node.get("elevated"):
            continue
        distance = math.hypot(
            (node["lat"] - lat) * 111_320.0,
            (node["lon"] - lon) * 111_320.0 * math.cos(math.radians(lat)),
        )
        if distance < best_distance:
            best_node, best_distance = node["id"], distance
    return best_node, round(best_distance, 1)


def main():
    with open(COPIES[0]) as handle:
        network = json.load(handle)
    core = vehicle_core(network)
    print(f"vehicle core: {len(core)} of {len(network['nodes'])} junctions")
    network["shelters"] = []
    for shelter in SHELTERS:
        node, distance = snap(network, shelter["lat"], shelter["lon"], core)
        network["shelters"].append({**shelter, "node": node, "snap_distance_m": distance})
        print(f"  {shelter['id']:>12} -> node {node:>5}  ({distance} m)")
    for path in COPIES:
        with open(path, "w") as handle:
            json.dump(network, handle, separators=(",", ":"))


if __name__ == "__main__":
    main()
