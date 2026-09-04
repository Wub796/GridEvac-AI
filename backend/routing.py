"""Street-aware evacuation routing over the real Houston network."""

import math
import random
from typing import Dict, List, Optional, Set, Tuple

import networkx as nx

from city_graph import (
    _G,
    _NODES,
    _SUBSTATIONS,
    SAFE_EXITS,
    TRANSMISSION_LINKS,
)

FLOOD_BLOCK = 999_999.0
PARTIAL_FLOOD_WEIGHT = 180.0
BLACKOUT_MULT = 4.5
FLOOD_RISE_PER_LEVEL = 1.7

# Travel-mode profiles: seconds-per-edge are derived from each segment's real
# speed limit, then adjusted by how the mode interacts with road classes and
# hazards. Pedestrians are slower but far less deterred by blackouts; EMS runs
# hot on arterials and hates alleys.
TRAVEL_MODES: Dict[str, Dict] = {
    "vehicle": {
        "mph": lambda limit: min(70.0, float(limit)),
        "road_class": {"arterial": 0.94, "collector": 1.0, "local": 1.0, "service": 1.35},
        "flood_partial": 180.0,
        "blackout_mult": 4.5,
    },
    "foot": {
        "mph": lambda _limit: 3.1,
        "road_class": {"arterial": 1.6, "collector": 1.2, "local": 1.0, "service": 1.0},
        "flood_partial": 450.0,
        "blackout_mult": 1.6,
    },
    "ems": {
        "mph": lambda limit: min(65.0, float(limit) * 1.3),
        "road_class": {"arterial": 0.8, "collector": 0.9, "local": 1.05, "service": 1.9},
        "flood_partial": 240.0,
        "blackout_mult": 2.0,
    },
}


def _edge_seconds(data: Dict, mode_cfg: Dict) -> float:
    """Mode-adjusted travel seconds for one street segment.

    mph -> m/s conversion: 1 mph = 1609.34 m / 3600 s, so seconds =
    distance_m * (3600 / 1609.34) / mph = distance_m * 2.23694 / mph.
    """
    mph = max(1.0, mode_cfg["mph"](data.get("speed_limit_mph", 25)))
    seconds = float(data.get("distance_m", 0.0)) * 2.23694 / mph
    seconds *= mode_cfg["road_class"].get(data.get("road_class", "local"), 1.0)
    return seconds


def _bearing_from_coords(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> str:
    """Compass direction of travel between two coordinates."""
    d_lat = lat_b - lat_a
    d_lon = (lon_b - lon_a) * math.cos(math.radians((lat_a + lat_b) / 2.0))
    angle = math.degrees(math.atan2(d_lon, d_lat))  # 0 = north, 90 = east
    compass = ["northbound", "northeastbound", "eastbound", "southeastbound",
               "southbound", "southwestbound", "westbound", "northwestbound"]
    index = int(((angle + 360.0) % 360.0 + 22.5) // 45.0) % 8
    return compass[index]


def _link_street_edges() -> Dict[int, List[Tuple[int, int]]]:
    """Map overhead utility links to the street segments they cross."""
    link_edges: Dict[int, List[Tuple[int, int]]] = {}
    for link in TRANSMISSION_LINKS:
        sub_a = next((s for s in _SUBSTATIONS if s["id"] == link["from_sub"]), None)
        sub_b = next((s for s in _SUBSTATIONS if s["id"] == link["to_sub"]), None)
        if not sub_a or not sub_b:
            link_edges[link["id"]] = []
            continue
        node_a = _NODES[sub_a["node"]]
        node_b = _NODES[sub_b["node"]]

        def distance_to_line(point: Dict) -> float:
            lat0 = math.radians((node_a["lat"] + node_b["lat"]) / 2.0)
            px = math.radians(point["lon"]) * math.cos(lat0) * 6_371_000.0
            py = math.radians(point["lat"]) * 6_371_000.0
            ax = math.radians(node_a["lon"]) * math.cos(lat0) * 6_371_000.0
            ay = math.radians(node_a["lat"]) * 6_371_000.0
            bx = math.radians(node_b["lon"]) * math.cos(lat0) * 6_371_000.0
            by = math.radians(node_b["lat"]) * 6_371_000.0
            length_sq = (bx - ax) ** 2 + (by - ay) ** 2
            if length_sq == 0:
                return math.hypot(px - ax, py - ay)
            t = max(0.0, min(1.0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / length_sq))
            return math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)))

        under_edges: List[Tuple[int, int]] = []
        for u, v in _G.edges():
            mid = {
                "lat": (_NODES[u]["lat"] + _NODES[v]["lat"]) / 2.0,
                "lon": (_NODES[u]["lon"] + _NODES[v]["lon"]) / 2.0,
            }
            if distance_to_line(mid) <= 90.0:
                under_edges.append((u, v))
        link_edges[link["id"]] = under_edges
    return link_edges


_LINK_EDGES = _link_street_edges()


def get_flooded_nodes(flood_level: float) -> Set[int]:
    threshold = flood_level * FLOOD_RISE_PER_LEVEL
    return {node_id for node_id, data in _NODES.items() if data["elevation"] <= threshold}


def simulate_power_flow(failed_inputs: List[int]) -> Dict:
    """Redistribute load across active substations and model cascade risk."""
    failed_set = set(failed_inputs)
    cascaded_set: Set[int] = set()
    substations = [dict(sub) for sub in _SUBSTATIONS]

    for _ in range(5):
        active = [s for s in substations if s["id"] not in failed_set and s["id"] not in cascaded_set]
        failed = [s for s in substations if s["id"] in failed_set or s["id"] in cascaded_set]
        for sub in active:
            sub["current_load"] = sub["base_load_mw"]
        if not active:
            for sub in substations:
                sub["current_load"] = 0.0
            break

        for failed_sub in failed:
            source = _NODES[failed_sub["node"]]
            weights = []
            for active_sub in active:
                target = _NODES[active_sub["node"]]
                distance = math.hypot(
                    source["lat"] - target["lat"],
                    (source["lon"] - target["lon"]) * math.cos(math.radians(source["lat"])),
                )
                weights.append(1.0 / (distance + 0.001))
            total_weight = sum(weights) or 1.0
            for active_sub, weight in zip(active, weights):
                active_sub["current_load"] += (weight / total_weight) * failed_sub["base_load_mw"]

        new_cascade = False
        for active_sub in active:
            if active_sub["current_load"] > active_sub["capacity_mw"] * 1.25:
                cascaded_set.add(active_sub["id"])
                new_cascade = True
        if not new_cascade:
            break

    overloaded: List[int] = []
    blackout_nodes: Set[int] = set()
    loads: Dict[int, float] = {}
    total_capacity = 0.0
    total_load = 0.0

    for sub in substations:
        sub_id = sub["id"]
        failed = sub_id in failed_set or sub_id in cascaded_set
        if failed:
            sub["current_load"] = 0.0
            loads[sub_id] = 0.0
            blackout_nodes.update(sub["affected_nodes"])
            continue

        loads[sub_id] = round(sub["current_load"], 1)
        total_capacity += sub["capacity_mw"]
        total_load += sub["current_load"]
        if sub["current_load"] > sub["capacity_mw"]:
            overloaded.append(sub_id)
            overload_ratio = (sub["current_load"] - sub["capacity_mw"]) / sub["capacity_mw"]
            # radius is in city blocks (~150 m each), matching the bake script.
            radius_m = sub["radius"] * 150.0 * (1.0 + 0.6 * overload_ratio)
            center = _NODES[sub["node"]]
            for node_id, data in _NODES.items():
                distance = math.hypot(
                    data["lat"] - center["lat"],
                    (data["lon"] - center["lon"]) * math.cos(math.radians(center["lat"])),
                )
                if distance * 111_320.0 <= radius_m:
                    blackout_nodes.add(node_id)

    ratio = total_load / total_capacity if total_capacity else 1.5
    base_frequency = 60.0 - (1.4 * max(0.0, ratio - 1.0) if ratio > 1.0 else 0.06 * len(failed_set | cascaded_set))
    frequency = max(45.0, min(60.1, base_frequency + random.uniform(-0.012, 0.012))) if total_capacity else 0.0

    voltages: Dict[int, float] = {}
    for node_id, node in _NODES.items():
        if node_id in blackout_nodes:
            voltages[node_id] = 0.0
            continue
        voltage = 100.0
        for sub in substations:
            if sub["id"] not in overloaded:
                continue
            center = _NODES[sub["node"]]
            distance = math.hypot(
                node["lat"] - center["lat"],
                (node["lon"] - center["lon"]) * math.cos(math.radians(center["lat"])),
            )
            radius_deg = sub["radius"] * 1.5 * 150.0 / 111_320.0
            if distance <= radius_deg:
                overload_ratio = (sub["current_load"] - sub["capacity_mw"]) / sub["capacity_mw"]
                voltage -= max(0.0, 22.0 * overload_ratio * (1.0 - distance / radius_deg))
        voltages[node_id] = round(max(40.0, min(100.0, voltage)), 1)

    line_states: Dict[int, str] = {}
    for link in TRANSMISSION_LINKS:
        from_failed = link["from_sub"] in failed_set or link["from_sub"] in cascaded_set
        to_failed = link["to_sub"] in failed_set or link["to_sub"] in cascaded_set
        if from_failed or to_failed:
            line_states[link["id"]] = "dead"
        elif link["from_sub"] in overloaded or link["to_sub"] in overloaded:
            line_states[link["id"]] = "overloaded"
        else:
            line_states[link["id"]] = "active"

    return {
        "substation_loads": loads,
        "overloaded_substations": overloaded,
        "cascaded_substations": sorted(cascaded_set),
        "blackout_nodes": blackout_nodes,
        "voltage_readings": voltages,
        "grid_frequency": round(frequency, 2),
        "transmission_line_states": line_states,
    }


def _build_route_steps(path: List[int], graph: nx.Graph) -> List[Dict]:
    """Group consecutive same-road edges into usable operator instructions."""
    if len(path) < 2:
        return []
    steps: List[Dict] = []
    current: Optional[Dict] = None
    previous_bearing: Optional[str] = None

    for from_node, to_node in zip(path, path[1:]):
        edge = graph.get_edge_data(from_node, to_node) or {}
        road_name = edge.get("road_name", "Unnamed street")
        node_a, node_b = _NODES[from_node], _NODES[to_node]
        bearing = _bearing_from_coords(node_a["lat"], node_a["lon"], node_b["lat"], node_b["lon"])
        distance_m = float(edge.get("distance_m", 0.0))
        duration_s = float(edge.get("weight", 0.0))
        if current and current["road_name"] == road_name:
            current["distance_m"] += distance_m
            current["duration_s"] += duration_s
            current["to_node"] = to_node
        else:
            if current:
                steps.append(current)
            current = {
                "instruction": f"Continue on {road_name}",
                "road_name": road_name,
                "road_class": edge.get("road_class", "local"),
                "distance_m": distance_m,
                "duration_s": duration_s,
                "from_node": from_node,
                "to_node": to_node,
                "bearing": bearing,
            }
            if previous_bearing is None:
                current["instruction"] = f"Depart on {road_name} {bearing}"
            else:
                current["instruction"] = f"Turn onto {road_name} {bearing}"
        previous_bearing = bearing
    if current:
        steps.append(current)

    for step in steps:
        step.pop("bearing", None)
    return steps


def _failure(message: str, flooded: Set[int], blackout: Set[int], blocked_edges: List[List[int]], flow: Dict) -> Dict:
    return {
        "success": False,
        "path": [],
        "path_coords": [],
        "total_nodes": 0,
        "distance_m": 0.0,
        "eta_minutes": 0.0,
        "route_steps": [],
        "message": message,
        "flooded_nodes": sorted(flooded),
        "blackout_nodes": sorted(blackout),
        "blocked_edges": blocked_edges,
        "dest_node": -1,
        "power_flow": flow,
    }


def _hazard_edge_sets(flow: Dict) -> Tuple[Set[Tuple[int, int]], Set[Tuple[int, int]]]:
    dead_edges: Set[Tuple[int, int]] = set()
    overloaded_edges: Set[Tuple[int, int]] = set()
    for link_id, state in flow["transmission_line_states"].items():
        if state == "dead":
            dead_edges.update(_LINK_EDGES.get(link_id, []))
        elif state == "overloaded":
            overloaded_edges.update(_LINK_EDGES.get(link_id, []))
    return dead_edges, overloaded_edges


def _build_weighted_graph(
    flooded: Set[int],
    blackout: Set[int],
    dead_edges: Set[Tuple[int, int]],
    overloaded_edges: Set[Tuple[int, int]],
    mode_cfg: Dict,
) -> Tuple[nx.Graph, List[List[int]]]:
    """Copy the street graph with mode- and hazard-adjusted edge weights."""
    graph = _G.copy()
    blocked_edges: List[List[int]] = []
    for u, v, data in list(graph.edges(data=True)):
        u_flooded, v_flooded = u in flooded, v in flooded
        if u_flooded and v_flooded:
            blocked_edges.append([u, v])
            graph.remove_edge(u, v)
            continue

        travel_seconds = _edge_seconds(data, mode_cfg)
        if u_flooded or v_flooded:
            travel_seconds += mode_cfg["flood_partial"]
        if u in blackout or v in blackout:
            travel_seconds *= mode_cfg["blackout_mult"]
        edge_pair = (u, v)
        reverse_pair = (v, u)
        if edge_pair in dead_edges or reverse_pair in dead_edges:
            travel_seconds += 240.0
        elif edge_pair in overloaded_edges or reverse_pair in overloaded_edges:
            travel_seconds += 90.0
        data["weight"] = travel_seconds
    return graph, blocked_edges


def compute_route(origin: int, flood_level: float, failed_substations: List[int], travel_mode: str = "vehicle") -> Dict:
    """Find the lowest-risk, lowest-time route to the best dry perimeter exit."""
    flooded = get_flooded_nodes(flood_level)
    flow = simulate_power_flow(failed_substations)
    blackout = flow["blackout_nodes"]

    if origin not in _NODES:
        return _failure("Origin intersection is outside the operations district.", flooded, blackout, [], flow)
    if origin in flooded:
        return _failure("Starting intersection is flooded. Select a dry origin on higher ground.", flooded, blackout, [], flow)

    mode_cfg = TRAVEL_MODES.get(travel_mode, TRAVEL_MODES["vehicle"])
    dead_edges, overloaded_edges = _hazard_edge_sets(flow)
    graph, blocked_edges = _build_weighted_graph(flooded, blackout, dead_edges, overloaded_edges, mode_cfg)

    best_path: List[int] = []
    best_weight = float("inf")
    best_exit = -1
    for exit_node in SAFE_EXITS:
        if exit_node in flooded:
            continue
        try:
            path = nx.shortest_path(graph, source=origin, target=exit_node, weight="weight")
            weight = nx.path_weight(graph, path, weight="weight")
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            continue
        if weight < best_weight:
            best_path, best_weight, best_exit = path, weight, exit_node

    if not best_path:
        return _failure("No passable route found. Floodwater and utility hazards have isolated this start point.", flooded, blackout, blocked_edges, flow)

    # Interleave each edge's curve geometry so the drawn route follows the
    # street, and terminate at the destination junction itself.
    curve_coords: List[Dict] = []
    for from_node, to_node in zip(best_path, best_path[1:]):
        edge = graph.get_edge_data(from_node, to_node) or {}
        curve_coords.append({
            "lat": _NODES[from_node]["lat"],
            "lon": _NODES[from_node]["lon"],
            "elevation": round(_NODES[from_node]["elevation"] + 0.65, 2),
        })
        for lat, lon in edge.get("geometry", []):
            curve_coords.append({"lat": lat, "lon": lon, "elevation": round(_NODES[to_node]["elevation"] + 0.65, 2)})
    curve_coords.append({
        "lat": _NODES[best_path[-1]]["lat"],
        "lon": _NODES[best_path[-1]]["lon"],
        "elevation": round(_NODES[best_path[-1]]["elevation"] + 0.65, 2),
    })

    route_steps = _build_route_steps(best_path, graph)
    distance_m = round(sum(float(graph.get_edge_data(u, v).get("distance_m", 0.0)) for u, v in zip(best_path, best_path[1:])), 1)
    eta_minutes = round(best_weight / 60.0, 1)

    exit_name = f"Exit Node {best_exit}"
    dest_intersection = _NODES[best_exit]["intersection_name"]
    if dest_intersection and dest_intersection != "Intersection":
        exit_name = dest_intersection

    return {
        "success": True,
        "path": best_path,
        "path_coords": curve_coords,
        "total_nodes": len(best_path),
        "distance_m": distance_m,
        "eta_minutes": eta_minutes,
        "route_steps": route_steps,
        "message": f"Safest street corridor mapped to {exit_name} with {len(route_steps)} road segments.",
        "flooded_nodes": sorted(flooded),
        "blackout_nodes": sorted(blackout),
        "blocked_edges": blocked_edges,
        "dest_node": best_exit,
        "power_flow": flow,
    }


def compare_exit_corridors(origin: int, flood_level: float, failed_substations: List[int], travel_mode: str = "vehicle") -> Dict:
    """Solve one Dijkstra per dry perimeter exit and rank every corridor.

    Operators rarely care about the single best exit; they want to know how
    much worse the second-best is, and whether two corridors stay separated.
    All exits share one hazard model, so comparison is apples-to-apples.
    """
    flooded = get_flooded_nodes(flood_level)
    flow = simulate_power_flow(failed_substations)
    blackout = flow["blackout_nodes"]
    if origin not in _NODES:
        return {"corridors": [], "flooded_nodes": sorted(flooded), "blackout_nodes": sorted(blackout)}

    mode_cfg = TRAVEL_MODES.get(travel_mode, TRAVEL_MODES["vehicle"])
    dead_edges, overloaded_edges = _hazard_edge_sets(flow)
    graph, _ = _build_weighted_graph(flooded, blackout, dead_edges, overloaded_edges, mode_cfg)

    dry_exits = [e for e in SAFE_EXITS if e in _NODES and e not in flooded]
    corridors: List[Dict] = []
    if dry_exits and origin in graph:
        # One Dijkstra from the origin prices every reachable junction; per-
        # exit paths are then read off for ranking details. All exits share
        # the same hazard-weighted graph, so the comparison is fair.
        distances = nx.single_source_dijkstra_path_length(graph, origin, weight="weight")
        for exit_node in dry_exits:
            try:
                cost = distances.get(exit_node)
                if cost is None:
                    continue
                path = nx.shortest_path(graph, source=origin, target=exit_node, weight="weight")
                distance_m = 0.0
                for u, v in zip(path, path[1:]):
                    distance_m += float(graph.get_edge_data(u, v).get("distance_m", 0.0))
                corridors.append({
                    "exit_node": exit_node,
                    "exit_name": _NODES[exit_node]["intersection_name"] or f"Exit {exit_node}",
                    "eta_minutes": round(cost / 60.0, 1),
                    "distance_m": round(distance_m, 1),
                    "hazard_count": sum(1 for u, v in zip(path, path[1:]) if (u, v) in dead_edges or (v, u) in dead_edges or u in blackout or v in blackout),
                    "path_length": len(path),
                })
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                continue
    corridors.sort(key=lambda c: c["eta_minutes"])
    return {"corridors": corridors, "flooded_nodes": sorted(flooded), "blackout_nodes": sorted(blackout)}


def compute_isochrone(origin: int, flood_level: float, failed_substations: List[int], travel_mode: str = "vehicle", minutes: List[float] = None) -> Dict:
    """Street-network reachability rings: which junctions are reachable in N minutes.

    Uses the same weighted graph as routing, so "5 minutes on foot" means the
    same thing as a 5-minute foot route. This is the evacuation-planning
    equivalent of a transit walk-shed, and the natural "who can get out" view.
    """
    minutes = minutes or [2, 4, 6, 8]
    flooded = get_flooded_nodes(flood_level)
    flow = simulate_power_flow(failed_substations)
    blackout = flow["blackout_nodes"]
    if origin not in _NODES:
        return {"origin": origin, "rings": [], "flooded_nodes": sorted(flooded), "blackout_nodes": sorted(blackout)}

    mode_cfg = TRAVEL_MODES.get(travel_mode, TRAVEL_MODES["vehicle"])
    dead_edges, overloaded_edges = _hazard_edge_sets(flow)
    graph, _ = _build_weighted_graph(flooded, blackout, dead_edges, overloaded_edges, mode_cfg)

    seconds_limit = [m * 60.0 for m in sorted(minutes)]
    try:
        distances = nx.single_source_dijkstra_path_length(graph, origin, cutoff=max(seconds_limit), weight="weight")
    except (nx.NetworkXError, nx.NodeNotFound):
        distances = {}

    rings = []
    for limit in seconds_limit:
        nodes = [node_id for node_id, cost in distances.items() if cost <= limit]
        rings.append({"minutes": round(limit / 60.0, 1), "node_count": len(nodes), "nodes": nodes})
    return {"origin": origin, "rings": rings, "flooded_nodes": sorted(flooded), "blackout_nodes": sorted(blackout)}
