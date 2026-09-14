"""Street-aware evacuation routing over the real Houston network.

Two quantities are kept apart on every street segment:

* travel time - what a stopwatch would read: measured length at the mode's
  speed plus physical delays (dark traffic signals, slowing through water on
  a flooded approach). ETAs, step durations, and reachability use it.
* routing cost - travel time adjusted by mode preferences for road classes
  plus safety penalties (flooded approaches, blackout districts, energized
  lines overhead). The solver minimizes cost so it prefers the safer
  corridor, but a penalty is never reported to the operator as minutes.

Every function here is deterministic: identical inputs give identical
outputs, so a saved scenario can be re-run and audited later.
"""

import heapq
import math
from typing import Dict, Iterable, List, Optional, Set, Tuple

import networkx as nx

from city_graph import (
    _G,
    _NODES,
    _SUBSTATIONS,
    FLOOD_DATUM_M,
    FLOOD_RISE_PER_LEVEL_M,
    SAFE_EXITS,
    SHELTERS,
    TRANSMISSION_LINKS,
    EXIT_NAMES,
    flood_stage,
    water_surface_m,
)

# Bureau of Public Roads congestion curve (standard traffic theory):
# t = t0 * (1 + alpha * (V/C)^beta), V = evacuating demand per hour, C =
# district corridor throughput per hour. At V/C = 1 travel time inflates 15%;
# at V/C = 2 it rises by a factor of 3.4. Demand is assumed to load onto the
# network within EVACUATION_WINDOW_H of the order to leave.
BPR_ALPHA = 0.15
BPR_BETA = 4.0
EVACUATION_WINDOW_H = 1.0

# Vehicle capacity: per-lane saturation flow by road class (HCM planning
# values; local streets are stop-controlled) times evacuation occupancy.
VEHICLE_SATURATION_VPHPL = {"arterial": 1900.0, "collector": 1700.0, "local": 1000.0, "service": 300.0}
PEOPLE_PER_VEHICLE = 2.5
# Pedestrian capacity: ~4,500 people/hour per metre of walkway (HCM LOS E
# boundary) across both sidewalks of a street.
PEDESTRIAN_FLOW_PPHPM = 4500.0
WALKWAY_WIDTH_M = {"arterial": 6.0, "collector": 4.0, "local": 3.0, "service": 1.5}

DEAD_LINE_PENALTY_S = 240.0
OVERLOADED_LINE_PENALTY_S = 90.0

# Travel-mode profiles. `preference` and the penalties shape routing cost;
# `flood_delay_s` and `blackout_delay_s` are real added seconds per segment.
TRAVEL_MODES: Dict[str, Dict] = {
    "vehicle": {
        "mph": lambda limit: min(70.0, float(limit)),
        "preference": {"arterial": 0.94, "collector": 1.0, "local": 1.0, "service": 1.35},
        "flood_penalty_s": 180.0,
        "flood_delay_s": 40.0,
        "blackout_cost_mult": 4.5,
        "blackout_delay_s": 12.0,
        "capacity": "vehicle",
        "directed": True,
    },
    "foot": {
        "mph": lambda _limit: 3.1,
        "preference": {"arterial": 1.6, "collector": 1.2, "local": 1.0, "service": 1.0},
        "flood_penalty_s": 450.0,
        "flood_delay_s": 60.0,
        "blackout_cost_mult": 1.6,
        "blackout_delay_s": 4.0,
        "capacity": "foot",
        # Pedestrians use sidewalks in both directions of a one-way street.
        "directed": False,
    },
    "ems": {
        "mph": lambda limit: min(65.0, float(limit) * 1.3),
        "preference": {"arterial": 0.8, "collector": 0.9, "local": 1.05, "service": 1.9},
        "flood_penalty_s": 240.0,
        "flood_delay_s": 40.0,
        "blackout_cost_mult": 2.0,
        "blackout_delay_s": 6.0,
        "capacity": "vehicle",
        "directed": True,
    },
}

CLASS_LABELS = {"arterial": "arterial", "collector": "collector", "local": "local street", "service": "service road"}
COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]


def mode_config(travel_mode: str) -> Dict:
    return TRAVEL_MODES.get(travel_mode, TRAVEL_MODES["vehicle"])


def bpr_multiplier(volume_per_hour: float, capacity_per_hour: float) -> float:
    """Congestion factor from hourly demand against district throughput."""
    if volume_per_hour <= 0:
        return 1.0
    if capacity_per_hour <= 0:
        return 50.0
    ratio = volume_per_hour / capacity_per_hour
    return 1.0 + BPR_ALPHA * (ratio ** BPR_BETA)


def edge_key(u: int, v: int) -> Tuple[int, int]:
    return (u, v) if u < v else (v, u)


def normalize_closures(closed_edges: Optional[Iterable[Iterable[int]]]) -> Set[Tuple[int, int]]:
    """Operator road closures as undirected keys; unknown segments are ignored."""
    closures: Set[Tuple[int, int]] = set()
    for pair in closed_edges or []:
        values = list(pair)
        if len(values) != 2:
            continue
        u, v = int(values[0]), int(values[1])
        if _G.has_edge(u, v):
            closures.add(edge_key(u, v))
    return closures


def _base_seconds(data: Dict, mode_cfg: Dict) -> float:
    """Free-flow seconds for one segment: distance_m * 2.23694 / mph."""
    mph = max(1.0, mode_cfg["mph"](data.get("speed_limit_mph", 25)))
    return float(data.get("distance_m", 0.0)) * 2.23694 / mph


def display_name(data: Dict) -> str:
    name = data.get("road_name") or "Unnamed street"
    if name != "Unnamed street":
        return name
    return f"unnamed {CLASS_LABELS.get(data.get('road_class', 'local'), 'street')}"


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
        lat0 = math.radians((node_a["lat"] + node_b["lat"]) / 2.0)

        def project(lat: float, lon: float) -> Tuple[float, float]:
            return math.radians(lon) * math.cos(lat0) * 6_371_000.0, math.radians(lat) * 6_371_000.0

        ax, ay = project(node_a["lat"], node_a["lon"])
        bx, by = project(node_b["lat"], node_b["lon"])
        length_sq = (bx - ax) ** 2 + (by - ay) ** 2
        under_edges: List[Tuple[int, int]] = []
        for u, v in _G.edges():
            px, py = project((_NODES[u]["lat"] + _NODES[v]["lat"]) / 2.0, (_NODES[u]["lon"] + _NODES[v]["lon"]) / 2.0)
            if length_sq == 0:
                distance = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / length_sq))
                distance = math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)))
            if distance <= 90.0:
                under_edges.append((u, v))
        link_edges[link["id"]] = under_edges
    return link_edges


_LINK_EDGES = _link_street_edges()
_FLOOD_CACHE: Dict[float, frozenset] = {}


def _arc_adjacency() -> Dict[str, Dict[int, List[int]]]:
    directed: Dict[int, List[int]] = {}
    undirected: Dict[int, List[int]] = {}
    for u, v, data in _G.edges(data=True):
        undirected.setdefault(u, []).append(v)
        undirected.setdefault(v, []).append(u)
        for a, b in allowed_arcs(u, v, data):
            directed.setdefault(a, []).append(b)
    return {"directed": directed, "undirected": undirected}


def get_flooded_nodes(flood_level: float) -> frozenset:
    """Junctions whose flood stage is at or below the scenario water surface.

    Cached per 0.01 level: the set is identical for every request at the
    same slider step, and building it scans every junction.
    """
    key = round(flood_level, 2)
    cached = _FLOOD_CACHE.get(key)
    if cached is None:
        surface = water_surface_m(key)
        cached = frozenset(node_id for node_id, data in _NODES.items() if flood_stage(data) <= surface)
        _FLOOD_CACHE[key] = cached
    return cached


def simulate_power_flow(failed_inputs: List[int], flooded: Iterable[int] = ()) -> Dict:
    """Redistribute load across active substations and model cascade risk.

    A substation whose junction is under water trips offline on its own
    (flood-induced outage) before load is redistributed.
    """
    flooded_set = set(flooded)
    manual = set(failed_inputs)
    flooded_subs = sorted(s["id"] for s in _SUBSTATIONS if s["node"] in flooded_set and s["id"] not in manual)
    failed_set = manual | set(flooded_subs)
    cascaded_set: Set[int] = set()
    substations = [dict(sub) for sub in _SUBSTATIONS]

    for _ in range(5):
        active = [s for s in substations if s["id"] not in failed_set and s["id"] not in cascaded_set]
        offline = [s for s in substations if s["id"] in failed_set or s["id"] in cascaded_set]
        for sub in active:
            sub["current_load"] = sub["base_load_mw"]
        if not active:
            break
        for offline_sub in offline:
            source = _NODES[offline_sub["node"]]
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
                active_sub["current_load"] += (weight / total_weight) * offline_sub["base_load_mw"]
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
        if sub_id in failed_set or sub_id in cascaded_set:
            loads[sub_id] = 0.0
            blackout_nodes.update(sub["affected_nodes"])
            continue
        current = sub.get("current_load", sub["base_load_mw"])
        loads[sub_id] = round(current, 1)
        total_capacity += sub["capacity_mw"]
        total_load += current
        if current > sub["capacity_mw"]:
            overloaded.append(sub_id)
            overload_ratio = (current - sub["capacity_mw"]) / sub["capacity_mw"]
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

    offline_count = len(failed_set | cascaded_set)
    if total_capacity:
        ratio = total_load / total_capacity
        frequency = 60.0 - (1.4 * (ratio - 1.0) if ratio > 1.0 else 0.06 * offline_count)
        frequency = max(45.0, min(60.05, frequency))
    else:
        frequency = 0.0

    voltages: Dict[int, float] = {}
    loads_by_id = {sub["id"]: sub for sub in substations}
    for node_id, node in _NODES.items():
        if node_id in blackout_nodes:
            voltages[node_id] = 0.0
            continue
        voltage = 100.0
        for sub_id in overloaded:
            sub = loads_by_id[sub_id]
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
        down = failed_set | cascaded_set
        if link["from_sub"] in down or link["to_sub"] in down:
            line_states[link["id"]] = "dead"
        elif link["from_sub"] in overloaded or link["to_sub"] in overloaded:
            line_states[link["id"]] = "overloaded"
        else:
            line_states[link["id"]] = "active"

    return {
        "substation_loads": loads,
        "overloaded_substations": overloaded,
        "cascaded_substations": sorted(cascaded_set),
        "flooded_substations": flooded_subs,
        "offline_substations": sorted(failed_set | cascaded_set),
        "blackout_nodes": blackout_nodes,
        "voltage_readings": voltages,
        "grid_frequency": round(frequency, 2),
        "transmission_line_states": line_states,
    }


def _hazard_edge_sets(flow: Dict) -> Tuple[Set[Tuple[int, int]], Set[Tuple[int, int]]]:
    dead_edges: Set[Tuple[int, int]] = set()
    overloaded_edges: Set[Tuple[int, int]] = set()
    for link_id, state in flow["transmission_line_states"].items():
        if state == "dead":
            dead_edges.update(edge_key(u, v) for u, v in _LINK_EDGES.get(link_id, []))
        elif state == "overloaded":
            overloaded_edges.update(edge_key(u, v) for u, v in _LINK_EDGES.get(link_id, []))
    return dead_edges, overloaded_edges


def _build_weighted_graph(
    flooded: Set[int],
    blackout: Set[int],
    dead_edges: Set[Tuple[int, int]],
    overloaded_edges: Set[Tuple[int, int]],
    mode_cfg: Dict,
    closures: Set[Tuple[int, int]],
) -> Tuple[nx.Graph, List[List[int]], List[List[int]]]:
    """Weighted street graph with `time_s` (travel time) and `weight` (cost).

    Vehicle modes get a directed graph that honours one-way streets; on foot
    every segment is walkable both ways. Segments with both ends under
    water, and operator closures, are left out.
    """
    directed = mode_cfg.get("directed", False)
    graph: nx.Graph = nx.DiGraph() if directed else nx.Graph()
    graph.add_nodes_from(_G.nodes)
    blocked_edges: List[List[int]] = []
    closed_edges: List[List[int]] = []
    for u, v, base in _G.edges(data=True):
        key = edge_key(u, v)
        if key in closures:
            closed_edges.append([u, v])
            continue
        if u in flooded and v in flooded:
            blocked_edges.append([u, v])
            continue
        data = dict(base)
        seconds = _base_seconds(data, mode_cfg)
        cost = seconds * mode_cfg["preference"].get(data.get("road_class", "local"), 1.0)
        if u in flooded or v in flooded:
            seconds += mode_cfg["flood_delay_s"]
            cost += mode_cfg["flood_penalty_s"]
        if u in blackout or v in blackout:
            seconds += mode_cfg["blackout_delay_s"]
            cost *= mode_cfg["blackout_cost_mult"]
        if key in dead_edges:
            cost += DEAD_LINE_PENALTY_S
        elif key in overloaded_edges:
            cost += OVERLOADED_LINE_PENALTY_S
        data["time_s"] = seconds
        data["weight"] = cost
        for a, b in (allowed_arcs(u, v, base) if directed else [(u, v)]):
            graph.add_edge(a, b, **data)
    return graph, blocked_edges, closed_edges


def allowed_arcs(u: int, v: int, data: Dict) -> List[Tuple[int, int]]:
    """Directions a vehicle may drive a segment (baked `oneway` is relative to `source`)."""
    oneway = int(data.get("oneway", 0) or 0)
    source = data.get("source", u)
    target = v if source == u else u
    if oneway == 1:
        return [(source, target)]
    if oneway == -1:
        return [(target, source)]
    return [(u, v), (v, u)]


_ARCS = _arc_adjacency()


def _vehicle_core() -> Set[int]:
    """Junctions a vehicle can both reach and leave: the largest strongly
    connected component of the one-way graph. The rest are one-way pockets
    (ramps, garages, loops) clipped by the district boundary."""
    graph = nx.DiGraph()
    graph.add_nodes_from(_G.nodes)
    for u, targets in _ARCS["directed"].items():
        graph.add_edges_from((u, v) for v in targets)
    return set(max(nx.strongly_connected_components(graph), key=len))


_VEHICLE_CORE = _vehicle_core()
ONE_WAY_POCKET_MESSAGE = (
    "This junction sits in a one-way pocket (a ramp, garage, or loop) with no legal vehicle path out. "
    "Start from a nearby through street, or switch to on-foot routing."
)


def edge_points(u: int, v: int, data: Dict) -> List[Tuple[float, float]]:
    """Curve points from u to v, reversing baked geometry when traversed backwards."""
    geometry = [tuple(point) for point in data.get("geometry", [])]
    if data.get("source", u) != u:
        geometry.reverse()
    return [(_NODES[u]["lat"], _NODES[u]["lon"]), *geometry, (_NODES[v]["lat"], _NODES[v]["lon"])]


def _planar_m(a: Tuple[float, float], b: Tuple[float, float]) -> Tuple[float, float]:
    cos_lat = math.cos(math.radians((a[0] + b[0]) / 2.0))
    return (b[1] - a[1]) * 111_320.0 * cos_lat, (b[0] - a[0]) * 111_320.0


def _heading(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    dx, dy = _planar_m(a, b)
    return math.degrees(math.atan2(dx, dy)) % 360.0


def _heading_leaving(points: List[Tuple[float, float]], reach_m: float = 12.0) -> float:
    """Heading out of the first point, looking far enough ahead to skip jitter."""
    for point in points[1:]:
        if math.hypot(*_planar_m(points[0], point)) >= reach_m:
            return _heading(points[0], point)
    return _heading(points[0], points[-1])


def _heading_arriving(points: List[Tuple[float, float]], reach_m: float = 12.0) -> float:
    for point in reversed(points[:-1]):
        if math.hypot(*_planar_m(point, points[-1])) >= reach_m:
            return _heading(point, points[-1])
    return _heading(points[0], points[-1])


def _maneuver(turn: float) -> Tuple[str, str]:
    """(maneuver id, verb phrase) for a signed turn angle, positive = right."""
    side = "right" if turn > 0 else "left"
    angle = abs(turn)
    if angle < 20:
        return "continue", "Continue onto"
    if angle < 45:
        return f"slight-{side}", f"Bear {side} onto"
    if angle < 135:
        return f"turn-{side}", f"Turn {side} onto"
    if angle < 165:
        return f"sharp-{side}", f"Turn sharp {side} onto"
    return "uturn", "Make a U-turn onto"


def build_route_steps(path: List[int], graph: nx.Graph) -> List[Dict]:
    """Group same-street segments into turn-by-turn instructions.

    Consecutive segments merge while the displayed street name stays the
    same (unnamed segments merge by road class). Each new step's maneuver is
    the signed angle between the heading arriving at the junction and the
    heading leaving it.
    """
    steps: List[Dict] = []
    arriving_heading: Optional[float] = None
    for from_node, to_node in zip(path, path[1:]):
        data = graph.get_edge_data(from_node, to_node) or {}
        points = edge_points(from_node, to_node, data)
        name = display_name(data)
        leaving = _heading_leaving(points)
        current = steps[-1] if steps else None
        if current and current["road_name"] == name:
            current["distance_m"] += float(data.get("distance_m", 0.0))
            current["duration_s"] += float(data.get("time_s", 0.0))
            current["to_node"] = to_node
        else:
            if current is None:
                maneuver = "depart"
                instruction = f"Head {COMPASS[int((leaving + 22.5) // 45) % 8]} on {name}"
            else:
                turn = (leaving - (arriving_heading or leaving) + 540.0) % 360.0 - 180.0
                maneuver, verb = _maneuver(turn)
                instruction = f"{verb} {name}"
            steps.append({
                "instruction": instruction,
                "road_name": name,
                "road_class": data.get("road_class", "local"),
                "distance_m": float(data.get("distance_m", 0.0)),
                "duration_s": float(data.get("time_s", 0.0)),
                "from_node": from_node,
                "to_node": to_node,
                "maneuver": maneuver,
                "bearing": int(round(leaving)) % 360,
            })
        arriving_heading = _heading_arriving(points)
    for step in steps:
        step["distance_m"] = round(step["distance_m"], 1)
        step["duration_s"] = round(step["duration_s"], 1)
    return steps


def _path_coords(path: List[int], graph: nx.Graph) -> List[Dict]:
    coords: List[Dict] = []
    for from_node, to_node in zip(path, path[1:]):
        points = edge_points(from_node, to_node, graph.get_edge_data(from_node, to_node) or {})
        start = _NODES[from_node]["elevation"]
        end = _NODES[to_node]["elevation"]
        # Drop the shared junction so consecutive segments do not duplicate it.
        for index, (lat, lon) in enumerate(points[:-1]):
            t = index / max(1, len(points) - 1)
            coords.append({"lat": lat, "lon": lon, "elevation": round(start + (end - start) * t, 2)})
    if path:
        last = _NODES[path[-1]]
        coords.append({"lat": last["lat"], "lon": last["lon"], "elevation": round(last["elevation"], 2)})
    return coords


def edge_capacity_pph(data: Dict, mode_cfg: Dict) -> float:
    road_class = data.get("road_class", "local")
    if mode_cfg["capacity"] == "foot":
        return WALKWAY_WIDTH_M.get(road_class, 3.0) * PEDESTRIAN_FLOW_PPHPM
    lanes = max(1, int(data.get("lanes", 2)))
    return lanes * VEHICLE_SATURATION_VPHPL.get(road_class, 1000.0) * PEOPLE_PER_VEHICLE


def corridor_capacity(path: List[int], graph: nx.Graph, mode_cfg: Dict) -> Dict:
    """Bottleneck people-per-hour throughput along a corridor."""
    if len(path) < 2:
        return {"people_per_hour": 0, "clearance_minutes": 0.0, "limiting_road": "-"}
    bottleneck: Optional[Tuple[float, str]] = None
    for u, v in zip(path, path[1:]):
        data = graph.get_edge_data(u, v) or {}
        per_hour = edge_capacity_pph(data, mode_cfg)
        if bottleneck is None or per_hour < bottleneck[0]:
            bottleneck = (per_hour, display_name(data))
    return {"people_per_hour": int(bottleneck[0]), "clearance_minutes": 0.0, "limiting_road": bottleneck[1]}


def _district_throughput(paths: Dict[int, List[int]], graph: nx.Graph, dry_exits: List[int], mode_cfg: Dict) -> float:
    """People/hour across every reachable dry exit corridor.

    Demand spreads across all usable corridors, so the congestion
    denominator is the district's total throughput, not one corridor's.
    """
    return float(sum(
        corridor_capacity(paths[exit_node], graph, mode_cfg)["people_per_hour"]
        for exit_node in dry_exits
        if len(paths.get(exit_node, [])) >= 2
    ))


def _path_time_s(path: List[int], graph: nx.Graph) -> float:
    return sum(float(graph.get_edge_data(u, v).get("time_s", 0.0)) for u, v in zip(path, path[1:]))


def _path_distance_m(path: List[int], graph: nx.Graph) -> float:
    return sum(float(graph.get_edge_data(u, v).get("distance_m", 0.0)) for u, v in zip(path, path[1:]))


def _scenario(flood_level: float, failed_substations: List[int], travel_mode: str, closed_edges) -> Dict:
    flooded = get_flooded_nodes(flood_level)
    flow = simulate_power_flow(failed_substations, flooded)
    mode_cfg = mode_config(travel_mode)
    closures = normalize_closures(closed_edges)
    dead_edges, overloaded_edges = _hazard_edge_sets(flow)
    graph, blocked, closed = _build_weighted_graph(flooded, flow["blackout_nodes"], dead_edges, overloaded_edges, mode_cfg, closures)
    return {
        "flooded": flooded,
        "flow": flow,
        "mode_cfg": mode_cfg,
        "graph": graph,
        "blocked_edges": blocked,
        "closed_edges": closed,
        "dead_edges": dead_edges,
        "water_surface_m": round(water_surface_m(flood_level), 2),
    }


def _failure(message: str, scenario: Dict) -> Dict:
    return {
        "success": False,
        "path": [],
        "path_coords": [],
        "total_nodes": 0,
        "distance_m": 0.0,
        "eta_minutes": 0.0,
        "route_steps": [],
        "message": message,
        "flooded_nodes": sorted(scenario["flooded"]),
        "blackout_nodes": sorted(scenario["flow"]["blackout_nodes"]),
        "blocked_edges": scenario["blocked_edges"],
        "closed_edges": scenario["closed_edges"],
        "dest_node": -1,
        "power_flow": scenario["flow"],
        "water_surface_m": scenario["water_surface_m"],
    }


def compute_route(
    origin: int,
    flood_level: float,
    failed_substations: List[int],
    travel_mode: str = "vehicle",
    evacuees: int = 0,
    destination: Optional[str] = None,
    closed_edges: Optional[Iterable[Iterable[int]]] = None,
) -> Dict:
    """Least-cost route to the best dry perimeter exit, or to a named
    shelter / medical destination when one is requested.

    When evacuees > 0 the free-flow ETA is inflated with the BPR congestion
    curve against the district's total corridor throughput, so the operator
    sees the difference between "one car" and "everyone leaving at once".
    """
    scenario = _scenario(flood_level, failed_substations, travel_mode, closed_edges)
    flooded, graph, mode_cfg = scenario["flooded"], scenario["graph"], scenario["mode_cfg"]

    if origin not in _NODES:
        return _failure("Origin intersection is outside the operations district.", scenario)
    if origin in flooded:
        return _failure("Starting intersection is flooded. Select a dry origin on higher ground.", scenario)

    shelter = None
    if destination:
        shelter = next((s for s in SHELTERS if s["id"] == destination), None)
        if shelter is None:
            return _failure(f"Destination \"{destination}\" is not a known shelter or medical facility.", scenario)
        if shelter["node"] in flooded:
            return _failure(f"No passable route to {shelter['name']}: its street approach is flooded.", scenario)

    # One single-source Dijkstra prices every junction; exits and shelters
    # are then read off the same result.
    distances, paths = nx.single_source_dijkstra(graph, source=origin, weight="weight")
    dry_exits = [e for e in SAFE_EXITS if e in _NODES and e not in flooded]
    best_exit, best_cost = -1, math.inf
    if shelter is not None:
        if shelter["node"] in distances:
            best_exit, best_cost = shelter["node"], distances[shelter["node"]]
    else:
        for exit_node in dry_exits:
            cost = distances.get(exit_node)
            if cost is not None and cost < best_cost:
                best_exit, best_cost = exit_node, cost

    if best_exit < 0:
        if mode_cfg.get("directed") and origin not in _VEHICLE_CORE:
            return _failure(ONE_WAY_POCKET_MESSAGE, scenario)
        target = shelter["name"] if shelter is not None else "any dry perimeter exit"
        return _failure(f"No passable route to {target}. Floodwater, closures, and utility hazards have isolated this start point.", scenario)

    best_path = paths[best_exit]
    route_steps = build_route_steps(best_path, graph)
    eta_minutes = _path_time_s(best_path, graph) / 60.0
    capacity = corridor_capacity(best_path, graph, mode_cfg)

    throughput = _district_throughput(paths, graph, dry_exits, mode_cfg)
    factor = bpr_multiplier(evacuees / EVACUATION_WINDOW_H, throughput)
    if evacuees > 0 and throughput > 0:
        capacity["clearance_minutes"] = round(evacuees / throughput * 60.0, 1)

    if shelter is not None:
        destination_label = shelter["name"]
    else:
        quadrant = EXIT_NAMES.get(str(best_exit), "Exit")
        intersection = _NODES[best_exit].get("intersection_name") or f"Node {best_exit}"
        destination_label = f"{quadrant} ({intersection})"

    return {
        "success": True,
        "path": best_path,
        "path_coords": _path_coords(best_path, graph),
        "total_nodes": len(best_path),
        "distance_m": round(_path_distance_m(best_path, graph), 1),
        "eta_minutes": round(eta_minutes, 1),
        "route_steps": route_steps,
        "corridor_capacity": capacity,
        "congested_eta_minutes": round(eta_minutes * factor, 1),
        "congestion_factor": round(factor, 3),
        "destination_name": shelter["name"] if shelter is not None else "",
        "destination_kind": shelter["kind"] if shelter is not None else "",
        "message": f"Safest street corridor mapped to {destination_label} in {len(route_steps)} road segments.",
        "flooded_nodes": sorted(flooded),
        "blackout_nodes": sorted(scenario["flow"]["blackout_nodes"]),
        "blocked_edges": scenario["blocked_edges"],
        "closed_edges": scenario["closed_edges"],
        "dest_node": best_exit,
        "power_flow": scenario["flow"],
        "water_surface_m": scenario["water_surface_m"],
    }


def compare_exit_corridors(
    origin: int,
    flood_level: float,
    failed_substations: List[int],
    travel_mode: str = "vehicle",
    evacuees: int = 0,
    closed_edges: Optional[Iterable[Iterable[int]]] = None,
) -> Dict:
    """Rank every dry perimeter exit from one origin, safest first.

    Operators rarely care about the single best exit; they want to know how
    much worse the second-best is. Corridors are ordered by routing cost (the
    same order the recommendation uses) and report real travel time.
    """
    scenario = _scenario(flood_level, failed_substations, travel_mode, closed_edges)
    flooded, graph, mode_cfg = scenario["flooded"], scenario["graph"], scenario["mode_cfg"]
    blackout, dead_edges = scenario["flow"]["blackout_nodes"], scenario["dead_edges"]
    corridors: List[Dict] = []
    if origin in _NODES and origin not in flooded:
        distances, paths = nx.single_source_dijkstra(graph, source=origin, weight="weight")
        for exit_node in (e for e in SAFE_EXITS if e in _NODES and e not in flooded):
            if exit_node not in distances:
                continue
            path = paths[exit_node]
            corridors.append({
                "exit_node": exit_node,
                "exit_name": f"{EXIT_NAMES.get(str(exit_node), 'Exit')} at {_NODES[exit_node].get('intersection_name') or f'node {exit_node}'}",
                "eta_minutes": round(_path_time_s(path, graph) / 60.0, 1),
                "cost_minutes": round(distances[exit_node] / 60.0, 1),
                "distance_m": round(_path_distance_m(path, graph), 1),
                "hazard_count": sum(
                    1 for u, v in zip(path, path[1:])
                    if edge_key(u, v) in dead_edges or u in blackout or v in blackout or u in flooded or v in flooded
                ),
                "path_length": len(path),
                "people_per_hour": corridor_capacity(path, graph, mode_cfg)["people_per_hour"],
            })
    corridors.sort(key=lambda corridor: (corridor["cost_minutes"], corridor["eta_minutes"]))

    # Demand spreads across the district's total throughput, so every
    # corridor inflates by the same BPR factor and the ranking stays honest.
    factor = bpr_multiplier(evacuees / EVACUATION_WINDOW_H, sum(c["people_per_hour"] for c in corridors))
    for corridor in corridors:
        corridor["congested_eta_minutes"] = round(corridor["eta_minutes"] * factor, 1)
    return {"corridors": corridors, "flooded_nodes": sorted(flooded), "blackout_nodes": sorted(blackout)}


def compute_isochrone(
    origin: int,
    flood_level: float,
    failed_substations: List[int],
    travel_mode: str = "vehicle",
    minutes: Optional[List[float]] = None,
    evacuees: int = 0,
    closed_edges: Optional[Iterable[Iterable[int]]] = None,
) -> Dict:
    """Street-network reachability: junctions reachable within N minutes.

    Uses real travel time over passable streets, so "5 minutes on foot"
    means the same thing as a 5-minute foot ETA. Under evacuation demand
    every segment slows by the BPR factor, so the rings shrink.
    """
    minutes = sorted(minutes or [2, 4, 6, 8])
    scenario = _scenario(flood_level, failed_substations, travel_mode, closed_edges)
    flooded, graph, mode_cfg = scenario["flooded"], scenario["graph"], scenario["mode_cfg"]
    blackout = scenario["flow"]["blackout_nodes"]
    if origin not in _NODES or origin in flooded:
        return {"origin": origin, "rings": [], "flooded_nodes": sorted(flooded), "blackout_nodes": sorted(blackout), "congestion_factor": 1.0}

    dry_exits = [e for e in SAFE_EXITS if e in _NODES and e not in flooded]
    _, paths = nx.single_source_dijkstra(graph, source=origin, weight="weight")
    factor = bpr_multiplier(evacuees / EVACUATION_WINDOW_H, _district_throughput(paths, graph, dry_exits, mode_cfg))
    limits = [m * 60.0 / factor for m in minutes]
    reach = nx.single_source_dijkstra_path_length(graph, origin, cutoff=max(limits), weight="time_s")
    rings = []
    for label, limit in zip(minutes, limits):
        nodes = sorted(node_id for node_id, seconds in reach.items() if seconds <= limit)
        rings.append({"minutes": round(float(label), 1), "node_count": len(nodes), "nodes": nodes})
    return {"origin": origin, "rings": rings, "flooded_nodes": sorted(flooded), "blackout_nodes": sorted(blackout), "congestion_factor": round(factor, 2)}


def compute_trigger_points(origin: int, travel_mode: str = "vehicle", closed_edges: Optional[Iterable[Iterable[int]]] = None) -> Dict:
    """Water surface at which each evacuation target becomes unreachable.

    A segment is impassable once both of its junctions flood, i.e. when the
    water surface reaches the higher of their two flood stages. The highest
    water a corridor can survive is therefore a widest-path (maximin) problem:
    one modified Dijkstra from the origin gives the exact trigger elevation
    for every exit and shelter, plus the segment that closes first.

    Blackouts and energized lines slow a route but never block it, so trigger
    points depend only on the flood model, one-way rules for the travel mode,
    and operator closures.
    """
    closures = normalize_closures(closed_edges)
    if origin not in _NODES:
        return {"origin": origin, "origin_stage_m": 0.0, "origin_level": 0.0, "targets": []}
    adjacency = _ARCS["directed" if mode_config(travel_mode).get("directed") else "undirected"]

    def capacity(u: int, v: int) -> float:
        return max(flood_stage(_NODES[u]), flood_stage(_NODES[v]))

    best: Dict[int, float] = {origin: math.inf}
    previous: Dict[int, int] = {}
    heap: List[Tuple[float, int]] = [(-math.inf, origin)]
    while heap:
        negative, node = heapq.heappop(heap)
        bottleneck = -negative
        if bottleneck < best.get(node, -math.inf):
            continue
        for neighbor in adjacency.get(node, ()):
            if edge_key(node, neighbor) in closures:
                continue
            candidate = min(bottleneck, capacity(node, neighbor))
            if candidate > best.get(neighbor, -math.inf):
                best[neighbor] = candidate
                previous[neighbor] = node
                heapq.heappush(heap, (-candidate, neighbor))

    origin_stage = flood_stage(_NODES[origin])

    def level(elevation: float) -> float:
        return round((elevation - FLOOD_DATUM_M) / FLOOD_RISE_PER_LEVEL_M, 2)

    targets: List[Dict] = []
    candidates = [("exit", str(e), e, EXIT_NAMES.get(str(e), f"Exit {e}")) for e in SAFE_EXITS if e in _NODES]
    candidates += [(s["kind"], s["id"], s["node"], s["name"]) for s in SHELTERS if s["node"] in _NODES]
    for kind, target_id, node, name in candidates:
        if node not in best:
            continue
        corridor = best[node]
        target_stage = flood_stage(_NODES[node])
        bottleneck_road, bottleneck_node = "-", node
        cursor, lowest = node, math.inf
        while cursor != origin and cursor in previous:
            parent = previous[cursor]
            cap = capacity(parent, cursor)
            if cap < lowest:
                lowest = cap
                higher = parent if flood_stage(_NODES[parent]) >= flood_stage(_NODES[cursor]) else cursor
                bottleneck_road, bottleneck_node = display_name(_G.get_edge_data(parent, cursor)), higher
            cursor = parent
        threshold = min(origin_stage, target_stage, corridor)
        if threshold == origin_stage:
            limited_by = "origin"
        elif threshold == target_stage:
            limited_by = "destination"
        else:
            limited_by = "corridor"
        targets.append({
            "kind": kind,
            "id": target_id,
            "node": node,
            "name": name,
            "threshold_m": round(threshold, 2),
            "threshold_level": level(threshold),
            "limited_by": limited_by,
            "bottleneck_road": bottleneck_road,
            "bottleneck_node": bottleneck_node,
            "bottleneck_name": _NODES[bottleneck_node].get("intersection_name") or f"Node {bottleneck_node}",
        })
    targets.sort(key=lambda target: -target["threshold_m"])
    return {"origin": origin, "origin_stage_m": round(origin_stage, 2), "origin_level": level(origin_stage), "targets": targets}
