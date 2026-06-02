"""
city_graph.py — Houston Downtown Street Grid, Substation, & Transmission Lines
-------------------------------------------------------------------------------
Generates a synthetic 15×15 intersection grid centred on Houston's
downtown district.

Coordinates
-----------
  Center : 29.7604 °N  95.3698 °W   (Harris County, TX)
  Lat step: 0.0006 ° ≈ 67 m  (N–S block spacing, scaled for 15x15)
  Lon step: 0.0007 ° ≈ 64 m  (E–W block spacing, scaled for 15x15)

Elevation model (synthetic, metres ASL)
---------------------------------------
Houston is flat. Range ~10–18 m. south-west is lowest (bayou-adjacent).

Substations & Transmission Wires
---------------------------------
Five substations placed across the 15x15 grid, connected by transmission wires.
"""

import networkx as nx
import numpy as np
from typing import Dict, List, Tuple

# ── Geographic parameters ──────────────────────────────────────────────────────
CENTER_LAT: float = 29.7700      # Center of expanded HISD / TX-18 grid
CENTER_LON: float = -95.3800

GRID_ROWS: int = 15
GRID_COLS: int = 15

LAT_STEP: float = 0.0070        # ≈ 780 m per row (covers inner Loop 610)
LON_STEP: float = 0.0080        # ≈ 770 m per col (covers 77019/Montrose to East Loop)

# ── Elevation parameters ───────────────────────────────────────────────────────
BASE_ELEV: float  = 9.0         # metres ASL
ROW_RISE:  float  = 0.5         # m gained per row going north
COL_RISE:  float  = 0.6         # m gained per col going west
NOISE_AMP: float  = 0.8         # sinusoidal noise amplitude

# ── Substation definitions ─────────────────────────────────────────────────────
#   node  = row*GRID_COLS + col
SUBSTATION_DEFS: List[Dict] = [
    {"id": 0, "node": 32,  "name": "Third Ward Substation",     "radius": 2.8, "capacity_mw": 150.0, "base_load_mw": 90.0},
    {"id": 1, "node": 56,  "name": "River Oaks Substation",     "radius": 3.1, "capacity_mw": 120.0, "base_load_mw": 85.0},
    {"id": 2, "node": 112, "name": "Downtown Core Substation",  "radius": 3.4, "capacity_mw": 250.0, "base_load_mw": 180.0},
    {"id": 3, "node": 168, "name": "Fifth Ward Substation",     "radius": 2.6, "capacity_mw": 110.0, "base_load_mw": 70.0},
    {"id": 4, "node": 192, "name": "Heights Substation",        "radius": 3.0, "capacity_mw": 130.0, "base_load_mw": 95.0},
]

# ── Transmission lines (power lines) mesh ──────────────────────────────────────
TRANSMISSION_LINKS: List[Dict] = [
    {"id": 0, "from_sub": 0, "to_sub": 2}, # Main St <-> Downtown Core
    {"id": 1, "from_sub": 1, "to_sub": 2}, # Midtown <-> Downtown Core
    {"id": 2, "from_sub": 2, "to_sub": 4}, # Downtown Core <-> Montrose
    {"id": 3, "from_sub": 3, "to_sub": 4}, # Heights <-> Montrose
    {"id": 4, "from_sub": 0, "to_sub": 3}, # Main St <-> Heights
]


# ── Helper functions ───────────────────────────────────────────────────────────

def node_id(row: int, col: int) -> int:
    return row * GRID_COLS + col


def node_position(row: int, col: int) -> Tuple[float, float, float]:
    """Return (lat, lon, elevation_m) for a grid intersection."""
    # Offset from centre so node (7,7) ≈ CENTER in 15x15
    lat = CENTER_LAT + (row - GRID_ROWS / 2) * LAT_STEP
    lon = CENTER_LON + (col - GRID_COLS / 2) * LON_STEP

    # Elevation
    elev = (
        BASE_ELEV
        + row * ROW_RISE
        + (GRID_COLS - 1 - col) * COL_RISE
        + NOISE_AMP * (np.sin(row * 1.4 + col * 0.9)
                       + np.cos(row * 0.7 + col * 1.5)) * 0.5
    )
    return float(lat), float(lon), max(4.0, float(elev))


# ── Graph construction ─────────────────────────────────────────────────────────

def build_graph() -> Tuple[nx.Graph, Dict[int, Dict]]:
    """Build the NetworkX city graph and return (G, nodes_dict)."""
    G = nx.Graph()
    nodes: Dict[int, Dict] = {}

    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            nid = node_id(row, col)
            lat, lon, elev = node_position(row, col)
            data = {
                "id": nid,
                "lat": lat,
                "lon": lon,
                "elevation": elev,
                "row": row,
                "col": col,
            }
            nodes[nid] = data
            G.add_node(nid, **data)

    # Horizontal edges (east–west streets)
    for row in range(GRID_ROWS):
        for col in range(GRID_COLS - 1):
            u, v = node_id(row, col), node_id(row, col + 1)
            G.add_edge(u, v, weight=1.0, base_weight=1.0)

    # Vertical edges (north–south streets)
    for row in range(GRID_ROWS - 1):
        for col in range(GRID_COLS):
            u, v = node_id(row, col), node_id(row + 1, col)
            G.add_edge(u, v, weight=1.0, base_weight=1.0)

    return G, nodes


def build_substations(nodes: Dict[int, Dict]) -> List[Dict]:
    """Expand substation definitions with affected node lists."""
    result = []
    for sub in SUBSTATION_DEFS:
        center_node = sub["node"]
        cr = center_node // GRID_COLS
        cc = center_node % GRID_COLS
        radius = sub["radius"]

        affected = [
            node_id(row, col)
            for row in range(GRID_ROWS)
            for col in range(GRID_COLS)
            if ((row - cr) ** 2 + (col - cc) ** 2) ** 0.5 <= radius
        ]

        nd = nodes[center_node]
        result.append({
            "id":             sub["id"],
            "node":           center_node,
            "name":           sub["name"],
            "radius":         radius,
            "lat":            nd["lat"],
            "lon":            nd["lon"],
            "capacity_mw":    sub["capacity_mw"],
            "base_load_mw":   sub["base_load_mw"],
            "affected_nodes": affected,
        })
    return result


# ── Pre-built singletons ───────────────────────────────────────────────────────
_G, _NODES = build_graph()
_SUBSTATIONS = build_substations(_NODES)
