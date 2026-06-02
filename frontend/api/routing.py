"""
routing.py — NetworkX Weighted Pathfinding for Houston Evacuation
-----------------------------------------------------------------
Computes the optimal evacuation path on the Houston grid graph,
applying prohibitive edge weights for flood-intersecting segments
and heavy penalties inside CenterPoint substation blackout zones.

Weight rules
────────────
  • Normal edge                     : 1.0
  • Both endpoints flooded          : FLOOD_BLOCK (≈ ∞, impassable)
  • One endpoint flooded            : PARTIAL_FLOOD_WEIGHT (heavily penalised)
  • Edge inside a blackout zone     : weight × BLACKOUT_MULT
  • Combined partial-flood+blackout : both penalties stacked

Houston flood model
-------------------
  Flood threshold (m ASL) = flood_level × FLOOD_RISE_PER_LEVEL
  Any node with elevation ≤ threshold is considered flooded.
  Houston's flat terrain means even a moderate flood_level
  submerges a large area quickly (realistic for bayou flooding).
"""

import networkx as nx
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


def get_blackout_nodes(failed_substations: List[int]) -> Set[int]:
    """Return union of affected_nodes for all failed substations."""
    blackout: Set[int] = set()
    for sub in _SUBSTATIONS:
        if sub["id"] in failed_substations:
            blackout.update(sub["affected_nodes"])
    return blackout


# ── Route computation ──────────────────────────────────────────────────────────

def compute_route(
    origin: int,
    dest: int,
    flood_level: float,
    failed_substations: List[int],
) -> Dict:
    """
    Run weighted Dijkstra on a cloned graph with flood / blackout weights.

    Returns a dict with keys:
        success, path, path_coords, message,
        flooded_nodes, blackout_nodes, blocked_edges
    """
    flooded  = get_flooded_nodes(flood_level)
    blackout = get_blackout_nodes(failed_substations)

    # Guard: origin or dest flooded
    if origin in flooded:
        return _failure(
            "Origin intersection is flooded — choose a higher-ground start.",
            flooded, blackout, []
        )
    if dest in flooded:
        return _failure(
            "Destination is flooded — choose an alternative evacuation point.",
            flooded, blackout, []
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

        # Stack blackout penalty on top (if not already fully blocked)
        if G[u][v]["weight"] < FLOOD_BLOCK and (u_dark or v_dark):
            G[u][v]["weight"] *= BLACKOUT_MULT

    # Pathfinding
    try:
        path: List[int] = nx.shortest_path(G, source=origin, target=dest, weight="weight")
    except nx.NetworkXNoPath:
        return _failure(
            "No passable route found — flood and blackout zones have isolated this area.",
            flooded, blackout, blocked_edges,
        )
    except nx.NodeNotFound as exc:
        return _failure(f"Invalid node ID: {exc}", flooded, blackout, blocked_edges)

    # Build 3-D coordinate list (elevated for Cesium visibility)
    path_coords = [
        {
            "lat":       _NODES[nid]["lat"],
            "lon":       _NODES[nid]["lon"],
            "elevation": _NODES[nid]["elevation"] + 18.0,   # elevated above buildings
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
    }


def _failure(
    message: str,
    flooded: Set[int],
    blackout: Set[int],
    blocked_edges: List,
) -> Dict:
    return {
        "success":       False,
        "path":          [],
        "path_coords":   [],
        "message":       message,
        "flooded_nodes": list(flooded),
        "blackout_nodes":list(blackout),
        "blocked_edges": blocked_edges,
    }
