"""
routing.py — NetworkX Weighted Pathfinding for Houston Evacuation (Safe Exits & Wires)
-------------------------------------------------------------------------------------
Computes the optimal evacuation path from origin to the safest peripheral Exit Node,
applying flood penalties, blackout zones, and power line hazard sags.
"""

import networkx as nx
import random
from typing import List, Dict, Set, Tuple

from city_graph import _G, _NODES, _SUBSTATIONS, GRID_COLS, TRANSMISSION_LINKS

# ── Weight constants ───────────────────────────────────────────────────────────
FLOOD_BLOCK:          float = 999_999.0   # effectively impassable
PARTIAL_FLOOD_WEIGHT: float = 60.0        # one end flooded — very dangerous
BLACKOUT_MULT:        float = 8.0         # inside a dark zone

# Houston-specific: rapid rise due to flat terrain
FLOOD_RISE_PER_LEVEL: float = 1.7        # metres per flood-level unit

# Evacuation Exit Gate nodes (peripheral high-elevation nodes)
SAFE_EXITS: List[int] = [14, 120, 164, 210]


# ── Transmission Line Hazard Geometry mapping ───────────────────────────────────

def distance_to_segment(pr: float, pc: float, ar: float, ac: float, br: float, bc: float) -> float:
    """Calculate perpendicular distance from point P to line segment AB in grid-units."""
    lab2 = (br - ar)**2 + (bc - ac)**2
    if lab2 == 0:
        return ((pr - ar)**2 + (pc - ac)**2)**0.5
    t = ((pr - ar) * (br - ar) + (pc - ac) * (bc - ac)) / lab2
    t = max(0.0, min(1.0, t))
    cr = ar + t * (br - ar)
    cc = ac + t * (bc - ac)
    return ((pr - cr)**2 + (pc - cc)**2)**0.5


# Map street edges running directly underneath power lines
_LINK_EDGES: Dict[int, List[Tuple[int, int]]] = {}
for link in TRANSMISSION_LINKS:
    l_id = link["id"]
    sub_a = next(s for s in _SUBSTATIONS if s["id"] == link["from_sub"])
    sub_b = next(s for s in _SUBSTATIONS if s["id"] == link["to_sub"])
    
    node_a = _NODES[sub_a["node"]]
    node_b = _NODES[sub_b["node"]]
    
    ar, ac = node_a["row"], node_a["col"]
    br, bc = node_b["row"], node_b["col"]
    
    under_edges = []
    for u, v in _G.edges():
        nu, nv = _NODES[u], _NODES[v]
        mr = (nu["row"] + nv["row"]) / 2.0
        mc = (nu["col"] + nv["col"]) / 2.0
        
        dist = distance_to_segment(mr, mc, ar, ac, br, bc)
        if dist <= 1.25:
            under_edges.append((u, v))
    _LINK_EDGES[l_id] = under_edges


# ── Zone helpers ───────────────────────────────────────────────────────────────

def get_flooded_nodes(flood_level: float) -> Set[int]:
    """Return set of node IDs whose elevation is below the flood threshold."""
    threshold = flood_level * FLOOD_RISE_PER_LEVEL
    return {nid for nid, d in _NODES.items() if d["elevation"] <= threshold}


def simulate_power_flow(failed_inputs: List[int]) -> Dict:
    """
    Simulate load redistribution and cascading failures when substations offline.
    """
    failed_set = set(failed_inputs)
    cascaded_set = set()
    
    substations = [dict(sub) for sub in _SUBSTATIONS]
    
    for _ in range(5):
        active_subs = [s for s in substations if s["id"] not in failed_set and s["id"] not in cascaded_set]
        failed_subs = [s for s in substations if s["id"] in failed_set or s["id"] in cascaded_set]
        
        for s in active_subs:
            s["current_load"] = s["base_load_mw"]
            
        if not active_subs:
            for s in substations:
                s["current_load"] = 0.0
            break
            
        new_cascade = False
        for f_sub in failed_subs:
            f_load = f_sub["base_load_mw"]
            f_node = _NODES[f_sub["node"]]
            fr, fc = f_node["row"], f_node["col"]
            
            weights = []
            total_weight = 0.0
            for a_sub in active_subs:
                a_node = _NODES[a_sub["node"]]
                ar, ac = a_node["row"], a_node["col"]
                dist = ((fr - ar) ** 2 + (fc - ac) ** 2) ** 0.5
                weight = 1.0 / (dist + 0.5)
                weights.append(weight)
                total_weight += weight
                
            for a_sub, w in zip(active_subs, weights):
                share = (w / total_weight) * f_load
                a_sub["current_load"] += share
                
        for a_sub in active_subs:
            if a_sub["current_load"] > a_sub["capacity_mw"] * 1.25:
                cascaded_set.add(a_sub["id"])
                new_cascade = True
                
        if not new_cascade:
            break
            
    overloaded_ids = []
    blackout_nodes = set()
    substation_loads = {}
    
    total_capacity = 0.0
    total_load = 0.0
    
    for s in substations:
        s_id = s["id"]
        is_failed = s_id in failed_set or s_id in cascaded_set
        
        if is_failed:
            s["current_load"] = 0.0
            substation_loads[s_id] = 0.0
            blackout_nodes.update(s["affected_nodes"])
        else:
            current_load = s["current_load"]
            substation_loads[s_id] = round(current_load, 1)
            total_capacity += s["capacity_mw"]
            total_load += current_load
            
            if current_load > s["capacity_mw"]:
                overloaded_ids.append(s_id)
                overload_pct = (current_load - s["capacity_mw"]) / s["capacity_mw"]
                effective_radius = s["radius"] * (1.0 + 0.6 * overload_pct)
                
                cr = s["node"] // GRID_COLS
                cc = s["node"] % GRID_COLS
                expanded_nodes = [
                    nid for nid, nd in _NODES.items()
                    if ((nd["row"] - cr) ** 2 + (nd["col"] - cc) ** 2) ** 0.5 <= effective_radius
                ]
                blackout_nodes.update(expanded_nodes)
                
    noise = random.uniform(-0.012, 0.012)
    if total_capacity > 0:
        overload_ratio = total_load / total_capacity
        if overload_ratio > 1.00:
            freq = 60.0 - 1.4 * (overload_ratio - 1.0) - 0.08 * (len(failed_set) + len(cascaded_set))
        else:
            freq = 60.0 - 0.06 * (len(failed_set) + len(cascaded_set))
    else:
        freq = 0.0
        noise = 0.0
        
    grid_frequency = max(45.0, min(60.1, freq + noise)) if freq > 0 else 0.0
    
    # Calculate local node voltages
    voltage_readings = {}
    for nid in _NODES.keys():
        if nid in blackout_nodes:
            voltage_readings[nid] = 0.0
        else:
            voltage = 100.0
            n_data = _NODES[nid]
            nr, nc = n_data["row"], n_data["col"]
            
            for s in substations:
                s_id = s["id"]
                if s_id in overloaded_ids:
                    s_node = _NODES[s["node"]]
                    sr, sc = s_node["row"], s_node["col"]
                    dist = ((nr - sr) ** 2 + (nc - sc) ** 2) ** 0.5
                    
                    overload_pct = (s["current_load"] - s["capacity_mw"]) / s["capacity_mw"]
                    if dist <= s["radius"] * 1.5:
                        drop = 22.0 * overload_pct * (1.0 - (dist / (s["radius"] * 1.5)))
                        voltage -= max(0.0, drop)
            voltage_readings[nid] = round(max(40.0, min(100.0, voltage)), 1)
            
    # Calculate transmission line states
    transmission_line_states = {}
    for link in TRANSMISSION_LINKS:
        l_id = link["id"]
        from_failed = link["from_sub"] in failed_set or link["from_sub"] in cascaded_set
        to_failed = link["to_sub"] in failed_set or link["to_sub"] in cascaded_set
        
        if from_failed or to_failed:
            transmission_line_states[l_id] = "dead"
        else:
            from_overloaded = link["from_sub"] in overloaded_ids
            to_overloaded = link["to_sub"] in overloaded_ids
            if from_overloaded or to_overloaded:
                transmission_line_states[l_id] = "overloaded"
            else:
                transmission_line_states[l_id] = "active"
                
    return {
        "substation_loads": substation_loads,
        "overloaded_substations": overloaded_ids,
        "cascaded_substations": list(cascaded_set),
        "blackout_nodes": blackout_nodes,
        "voltage_readings": voltage_readings,
        "grid_frequency": round(grid_frequency, 2),
        "transmission_line_states": transmission_line_states,
    }


# ── Route computation ──────────────────────────────────────────────────────────

def compute_route(
    origin: int,
    flood_level: float,
    failed_substations: List[int],
) -> Dict:
    """
    Run weighted Dijkstra from origin to the safest Exit Node.
    """
    flooded  = get_flooded_nodes(flood_level)
    flow = simulate_power_flow(failed_substations)
    blackout = flow["blackout_nodes"]

    # Guard: origin flooded
    if origin in flooded:
        return _failure(
            "Starting intersection is flooded — choose a higher-ground origin node.",
            flooded, blackout, [], flow
        )

    # Clone graph and apply dynamic weights
    G = _G.copy()
    blocked_edges: List[List[int]] = []

    # Map power line hazards to edges
    dead_edges = set()
    overloaded_edges = set()
    for link_id, state in flow["transmission_line_states"].items():
        edges = _LINK_EDGES.get(link_id, [])
        if state == "dead":
            dead_edges.update(edges)
        elif state == "overloaded":
            overloaded_edges.update(edges)

    for u, v in list(G.edges()):
        u_flooded = u in flooded
        v_flooded = v in flooded
        u_dark    = u in blackout
        v_dark    = v in blackout

        if u_flooded and v_flooded:
            G[u][v]["weight"] = FLOOD_BLOCK
            blocked_edges.append([u, v])
        elif u_flooded or v_flooded:
            G[u][v]["weight"] = PARTIAL_FLOOD_WEIGHT
        else:
            G[u][v]["weight"] = 1.0

        # Stack blackout penalty
        if G[u][v]["weight"] < FLOOD_BLOCK and (u_dark or v_dark):
            G[u][v]["weight"] *= BLACKOUT_MULT

        # Apply overhead transmission line hazard penalties
        if G[u][v]["weight"] < FLOOD_BLOCK:
            edge_key = (u, v)
            edge_key_rev = (v, u)
            if edge_key in dead_edges or edge_key_rev in dead_edges:
                G[u][v]["weight"] += 25.0  # Fallen power line risk / blockages
            elif edge_key in overloaded_edges or edge_key_rev in overloaded_edges:
                G[u][v]["weight"] += 10.0  # Sagging wire utility crew warning

    # Multi-exit solver: compute routes to all active Exits
    best_path: List[int] = []
    best_weight: float = float('inf')
    best_exit: int = -1

    for exit_node in SAFE_EXITS:
        if exit_node in flooded:
            continue
        try:
            path = nx.shortest_path(G, source=origin, target=exit_node, weight="weight")
            weight = nx.path_weight(G, path, weight="weight")
            if weight < best_weight:
                best_weight = weight
                best_path = path
                best_exit = exit_node
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            continue

    if not best_path:
        return _failure(
            "No passable route found — floodwaters, wire hazards, and blackouts have isolated this start point.",
            flooded, blackout, blocked_edges, flow
        )

    # Build 3-D coordinate list
    path_coords = [
        {
            "lat":       _NODES[nid]["lat"],
            "lon":       _NODES[nid]["lon"],
            "elevation": _NODES[nid]["elevation"] + 18.0,
        }
        for nid in best_path
    ]

    # Convert node exit index to direction label
    exit_dirs = {14: "East Gate (Node 14)", 120: "West Gate (Node 120)", 164: "South Gate (Node 164)", 210: "North Gate (Node 210)"}
    exit_name = exit_dirs.get(best_exit, f"Exit Node {best_exit}")

    return {
        "success":       True,
        "path":          best_path,
        "path_coords":   path_coords,
        "message":       f"Safest corridor mapped to {exit_name} — {len(best_path)} waypoints.",
        "flooded_nodes": list(flooded),
        "blackout_nodes":list(blackout),
        "blocked_edges": blocked_edges,
        "dest_node":     best_exit,
        "power_flow":    flow,
    }


def _failure(
    message: str,
    flooded: Set[int],
    blackout: Set[int],
    blocked_edges: List,
    flow: Dict,
) -> Dict:
    return {
        "success":       False,
        "path":          [],
        "path_coords":   [],
        "message":       message,
        "flooded_nodes": list(flooded),
        "blackout_nodes":list(blackout),
        "blocked_edges": blocked_edges,
        "dest_node":     -1,
        "power_flow":    flow,
    }
