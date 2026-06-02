"""
routing.py — NetworkX Weighted Pathfinding for Houston Evacuation
-----------------------------------------------------------------
Computes the optimal evacuation path on the Houston grid graph,
applying prohibitive edge weights for flood-intersecting segments
and heavy penalties inside CenterPoint substation blackout zones.

Power Flow & Cascading Failures
--------------------------------
  • Normal edge                     : 1.0
  • Both endpoints flooded          : FLOOD_BLOCK (≈ ∞, impassable)
  • One endpoint flooded            : PARTIAL_FLOOD_WEIGHT (heavily penalised)
  • Edge inside a blackout zone     : weight × BLACKOUT_MULT
  • Combined partial-flood+blackout : both penalties stacked
"""

import networkx as nx
import random
from typing import List, Dict, Set, Tuple

from city_graph import _G, _NODES, _SUBSTATIONS, GRID_COLS

# ── Weight constants ───────────────────────────────────────────────────────────
FLOOD_BLOCK:          float = 999_999.0   # effectively impassable
PARTIAL_FLOOD_WEIGHT: float = 60.0        # one end flooded — very dangerous
BLACKOUT_MULT:        float = 8.0         # inside a dark zone

# Houston-specific: rapid rise due to impervious surfaces and flat terrain
FLOOD_RISE_PER_LEVEL: float = 1.7        # metres per flood-level unit


# ── Zone helpers ───────────────────────────────────────────────────────────────

def get_flooded_nodes(flood_level: float) -> Set[int]:
    """Return set of node IDs whose elevation is below the flood threshold."""
    threshold = flood_level * FLOOD_RISE_PER_LEVEL
    return {nid for nid, d in _NODES.items() if d["elevation"] <= threshold}


def simulate_power_flow(failed_inputs: List[int]) -> Dict:
    """
    Simulate load redistribution and cascading failures when substations offline.
    Returns:
        substation_loads: Dict[int, float]
        overloaded_substations: List[int]
        cascaded_substations: List[int]
        blackout_nodes: Set[int]
        voltage_readings: Dict[int, float]
        grid_frequency: float
    """
    failed_set = set(failed_inputs)
    cascaded_set = set()
    
    # Copy substations list to edit loads dynamically
    substations = [dict(sub) for sub in _SUBSTATIONS]
    
    # Redistribution loop (max 5 iterations for cascaded ripples)
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
            
            # Calculate distance weights
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
                
        # Check for cascading overloads (> 125% capacity)
        for a_sub in active_subs:
            if a_sub["current_load"] > a_sub["capacity_mw"] * 1.25:
                cascaded_set.add(a_sub["id"])
                new_cascade = True
                
        if not new_cascade:
            break
            
    # Calculate final overload states and blackout areas
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
            
            # If overloaded, expand blackout radius to simulate sags / rolling blackouts
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
                
    # Calculate grid frequency
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
    
    # Calculate local voltage stability readings for nodes
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
            
    return {
        "substation_loads": substation_loads,
        "overloaded_substations": overloaded_ids,
        "cascaded_substations": list(cascaded_set),
        "blackout_nodes": blackout_nodes,
        "voltage_readings": voltage_readings,
        "grid_frequency": round(grid_frequency, 2),
    }


# ── Route computation ──────────────────────────────────────────────────────────

def compute_route(
    origin: int,
    dest: int,
    flood_level: float,
    failed_substations: List[int],
) -> Dict:
    """
    Run weighted Dijkstra on a cloned graph with flood / blackout weights.
    """
    flooded  = get_flooded_nodes(flood_level)
    
    # Simulate power flow to get active blackout nodes
    flow = simulate_power_flow(failed_substations)
    blackout = flow["blackout_nodes"]

    # Guard: origin or dest flooded
    if origin in flooded:
        return _failure(
            "Origin intersection is flooded — choose a higher-ground start.",
            flooded, blackout, [], flow
        )
    if dest in flooded:
        return _failure(
            "Destination is flooded — choose an alternative evacuation point.",
            flooded, blackout, [], flow
        )

    # Clone graph and apply dynamic weights
    G = _G.copy()
    blocked_edges: List[List[int]] = []

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

        # Stack blackout penalty on top
        if G[u][v]["weight"] < FLOOD_BLOCK and (u_dark or v_dark):
            G[u][v]["weight"] *= BLACKOUT_MULT

    # Pathfinding
    try:
        path: List[int] = nx.shortest_path(G, source=origin, target=dest, weight="weight")
    except nx.NetworkXNoPath:
        return _failure(
            "No passable route found — flood and blackout zones have isolated this area.",
            flooded, blackout, blocked_edges, flow
        )
    except nx.NodeNotFound as exc:
        return _failure(f"Invalid node ID: {exc}", flooded, blackout, blocked_edges, flow)

    # Build 3-D coordinate list (elevated for Cesium visibility)
    path_coords = [
        {
            "lat":       _NODES[nid]["lat"],
            "lon":       _NODES[nid]["lon"],
            "elevation": _NODES[nid]["elevation"] + 18.0,
        }
        for nid in path
    ]

    return {
        "success":       True,
        "path":          path,
        "path_coords":   path_coords,
        "message":       f"Safe corridor found — {len(path)} waypoints, {len(path)-1} segments.",
        "flooded_nodes": list(flooded),
        "blackout_nodes":list(blackout),
        "blocked_edges": blocked_edges,
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
        "power_flow":    flow,
    }
