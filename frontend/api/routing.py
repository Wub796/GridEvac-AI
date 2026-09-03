"""Street-aware evacuation routing for the serverless API."""

import math
import random
from typing import Dict, List, Set, Tuple

import networkx as nx

from city_graph import _G, _NODES, _SUBSTATIONS, GRID_COLS, TRANSMISSION_LINKS

FLOOD_BLOCK = 999_999.0
PARTIAL_FLOOD_WEIGHT = 180.0
BLACKOUT_MULT = 4.5
FLOOD_RISE_PER_LEVEL = 1.7
SAFE_EXITS: List[int] = [7, 105, 119, 217]


def distance_to_segment(pr: float, pc: float, ar: float, ac: float, br: float, bc: float) -> float:
    length_sq = (br - ar) ** 2 + (bc - ac) ** 2
    if length_sq == 0:
        return math.hypot(pr - ar, pc - ac)
    t = ((pr - ar) * (br - ar) + (pc - ac) * (bc - ac)) / length_sq
    t = max(0.0, min(1.0, t))
    closest_r = ar + t * (br - ar)
    closest_c = ac + t * (bc - ac)
    return math.hypot(pr - closest_r, pc - closest_c)


def _build_link_edges() -> Dict[int, List[Tuple[int, int]]]:
    link_edges: Dict[int, List[Tuple[int, int]]] = {}
    for link in TRANSMISSION_LINKS:
        sub_a = next(s for s in _SUBSTATIONS if s["id"] == link["from_sub"])
        sub_b = next(s for s in _SUBSTATIONS if s["id"] == link["to_sub"])
        node_a, node_b = _NODES[sub_a["node"]], _NODES[sub_b["node"]]
        under_edges = []
        for u, v in _G.edges():
            nu, nv = _NODES[u], _NODES[v]
            midpoint_r = (nu["row"] + nv["row"]) / 2.0
            midpoint_c = (nu["col"] + nv["col"]) / 2.0
            if distance_to_segment(midpoint_r, midpoint_c, node_a["row"], node_a["col"], node_b["row"], node_b["col"]) <= 0.72:
                under_edges.append((u, v))
        link_edges[link["id"]] = under_edges
    return link_edges


_LINK_EDGES = _build_link_edges()


def get_flooded_nodes(flood_level: float) -> Set[int]:
    threshold = flood_level * FLOOD_RISE_PER_LEVEL
    return {node_id for node_id, data in _NODES.items() if data["elevation"] <= threshold}


def simulate_power_flow(failed_inputs: List[int]) -> Dict:
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
                weights.append(1.0 / (math.hypot(source["row"] - target["row"], source["col"] - target["col"]) + 0.5))
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
            ratio = (sub["current_load"] - sub["capacity_mw"]) / sub["capacity_mw"]
            center = _NODES[sub["node"]]
            radius = sub["radius"] * (1.0 + 0.6 * ratio)
            blackout_nodes.update(node_id for node_id, data in _NODES.items() if math.hypot(data["row"] - center["row"], data["col"] - center["col"]) <= radius)

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
            distance = math.hypot(node["row"] - center["row"], node["col"] - center["col"])
            radius = sub["radius"] * 1.5
            if distance <= radius:
                ratio = (sub["current_load"] - sub["capacity_mw"]) / sub["capacity_mw"]
                voltage -= max(0.0, 22.0 * ratio * (1.0 - distance / radius))
        voltages[node_id] = round(max(40.0, min(100.0, voltage)), 1)
    line_states: Dict[int, str] = {}
    for link in TRANSMISSION_LINKS:
        from_failed = link["from_sub"] in failed_set or link["from_sub"] in cascaded_set
        to_failed = link["to_sub"] in failed_set or link["to_sub"] in cascaded_set
        line_states[link["id"]] = "dead" if from_failed or to_failed else ("overloaded" if link["from_sub"] in overloaded or link["to_sub"] in overloaded else "active")
    return {"substation_loads": loads, "overloaded_substations": overloaded, "cascaded_substations": sorted(cascaded_set), "blackout_nodes": blackout_nodes, "voltage_readings": voltages, "grid_frequency": round(frequency, 2), "transmission_line_states": line_states}


def _road_bearing(a: Dict, b: Dict) -> str:
    d_row, d_col = b["row"] - a["row"], b["col"] - a["col"]
    if abs(d_col) > abs(d_row):
        return "eastbound" if d_col > 0 else "westbound"
    return "northbound" if d_row > 0 else "southbound"


def _build_route_steps(path: List[int], graph: nx.Graph) -> List[Dict]:
    if len(path) < 2:
        return []
    steps: List[Dict] = []
    current = None
    previous_bearing = None
    for from_node, to_node in zip(path, path[1:]):
        edge = graph.get_edge_data(from_node, to_node) or {}
        road_name = edge.get("road_name", "Unnamed road")
        bearing = _road_bearing(_NODES[from_node], _NODES[to_node])
        if current and current["road_name"] == road_name and current["bearing"] == bearing:
            current["distance_m"] += float(edge.get("distance_m", 0.0))
            current["duration_s"] += float(edge.get("weight", 0.0))
            current["to_node"] = to_node
        else:
            if current:
                steps.append(current)
            current = {"instruction": f"Depart on {road_name} {bearing}" if previous_bearing is None else f"Turn onto {road_name} and continue {bearing}", "road_name": road_name, "road_class": edge.get("road_class", "local"), "distance_m": float(edge.get("distance_m", 0.0)), "duration_s": float(edge.get("weight", 0.0)), "from_node": from_node, "to_node": to_node, "bearing": bearing}
        previous_bearing = bearing
    if current:
        steps.append(current)
    for step in steps:
        step.pop("bearing", None)
    return steps


def _failure(message: str, flooded: Set[int], blackout: Set[int], blocked_edges: List[List[int]], flow: Dict) -> Dict:
    return {"success": False, "path": [], "path_coords": [], "total_nodes": 0, "distance_m": 0.0, "eta_minutes": 0.0, "route_steps": [], "message": message, "flooded_nodes": sorted(flooded), "blackout_nodes": sorted(blackout), "blocked_edges": blocked_edges, "dest_node": -1, "power_flow": flow}


def compute_route(origin: int, flood_level: float, failed_substations: List[int]) -> Dict:
    flooded = get_flooded_nodes(flood_level)
    flow = simulate_power_flow(failed_substations)
    blackout = flow["blackout_nodes"]
    if origin not in _NODES:
        return _failure("Origin intersection is outside the operations district.", flooded, blackout, [], flow)
    if origin in flooded:
        return _failure("Starting intersection is flooded. Select a dry origin on higher ground.", flooded, blackout, [], flow)

    graph = _G.copy()
    blocked_edges: List[List[int]] = []
    dead_edges: Set[Tuple[int, int]] = set()
    overloaded_edges: Set[Tuple[int, int]] = set()
    for link_id, state in flow["transmission_line_states"].items():
        if state == "dead":
            dead_edges.update(_LINK_EDGES.get(link_id, []))
        elif state == "overloaded":
            overloaded_edges.update(_LINK_EDGES.get(link_id, []))
    for u, v, data in list(graph.edges(data=True)):
        if u in flooded and v in flooded:
            blocked_edges.append([u, v])
            graph.remove_edge(u, v)
            continue
        travel_seconds = float(data.get("base_weight", 60.0))
        if u in flooded or v in flooded:
            travel_seconds += PARTIAL_FLOOD_WEIGHT
        if u in blackout or v in blackout:
            travel_seconds *= BLACKOUT_MULT
        if (u, v) in dead_edges or (v, u) in dead_edges:
            travel_seconds += 240.0
        elif (u, v) in overloaded_edges or (v, u) in overloaded_edges:
            travel_seconds += 90.0
        if data.get("road_class") == "arterial":
            travel_seconds *= 0.94
        data["weight"] = travel_seconds

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

    path_coords = [{"lat": _NODES[node_id]["lat"], "lon": _NODES[node_id]["lon"], "elevation": round(_NODES[node_id]["elevation"] + 0.65, 2)} for node_id in best_path]
    route_steps = _build_route_steps(best_path, graph)
    distance_m = round(sum(float(graph.get_edge_data(u, v).get("distance_m", 0.0)) for u, v in zip(best_path, best_path[1:])), 1)
    exit_names = {7: "South Gate", 105: "West Gate", 119: "East Gate", 217: "North Gate"}
    return {"success": True, "path": best_path, "path_coords": path_coords, "total_nodes": len(best_path), "distance_m": distance_m, "eta_minutes": round(best_weight / 60.0, 1), "route_steps": route_steps, "message": f"Safest street corridor mapped to {exit_names.get(best_exit, f'Exit Node {best_exit}')} with {len(route_steps)} road segments.", "flooded_nodes": sorted(flooded), "blackout_nodes": sorted(blackout), "blocked_edges": blocked_edges, "dest_node": best_exit, "power_flow": flow}
