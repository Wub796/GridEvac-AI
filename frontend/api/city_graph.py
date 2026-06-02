"""
city_graph.py — Houston Downtown Street Grid & Substation Model
---------------------------------------------------------------
Generates a synthetic 10×10 intersection grid centred on Houston's
downtown district (near Minute Maid Park / Discovery Green corridor).

Coordinates
-----------
  Center : 29.7604 °N  95.3698 °W   (Harris County, TX)
  Lat step: 0.0008 ° ≈ 89 m  (N–S block spacing)
  Lon step: 0.0009 ° ≈ 82 m  (E–W block spacing)

Elevation model (synthetic, metres ASL)
---------------------------------------
Houston is famously flat. Real elevations downtown range ~10–18 m.
We mimic the Buffalo Bayou corridor by making the south-west corner
lowest (bayou-adjacent) and raising ground as we move north and west.

  elevation(row, col) = BASE
                       + row  × ROW_RISE          (south→north rise)
                       + (GRID_COLS-1-col) × COL_RISE  (east→west rise)
                       + sinusoidal noise

Substations (CenterPoint Energy-inspired)
-----------------------------------------
Five substations placed at realistic downtown positions.
Each has a blackout radius expressed in grid-unit distance.
"""

import networkx as nx
import numpy as np
from typing import Dict, List, Tuple

# ── Geographic parameters ──────────────────────────────────────────────────────
CENTER_LAT: float = 29.7604      # Downtown Houston
CENTER_LON: float = -95.3698

GRID_ROWS: int = 10
GRID_COLS: int = 10

LAT_STEP: float = 0.0008        # ≈ 89 m per row (N–S)
LON_STEP: float = 0.0009        # ≈ 82 m per col (E–W)

# ── Elevation parameters ───────────────────────────────────────────────────────
BASE_ELEV: float  = 9.0         # metres ASL (Houston downtown baseline)
ROW_RISE:  float  = 0.6         # m gained per row going north
COL_RISE:  float  = 0.4         # m gained per col going west (away from bay)
NOISE_AMP: float  = 0.8         # sinusoidal noise amplitude

# ── Substation definitions ─────────────────────────────────────────────────────
#   node  = row*GRID_COLS + col
#   radius expressed in grid-unit distance (Euclidean on row/col space)
SUBSTATION_DEFS: List[Dict] = [
    {"id": 0, "node": 11, "name": "Main Street Substation",    "radius": 1.9},
    {"id": 1, "node": 18, "name": "Midtown Substation",        "radius": 2.1},
    {"id": 2, "node": 44, "name": "Downtown Core Substation",  "radius": 2.3},
    {"id": 3, "node": 73, "name": "Heights Substation",        "radius": 1.8},
    {"id": 4, "node": 86, "name": "Montrose Substation",       "radius": 2.0},
]


# ── Helper functions ───────────────────────────────────────────────────────────

def node_id(row: int, col: int) -> int:
    return row * GRID_COLS + col


def node_position(row: int, col: int) -> Tuple[float, float, float]:
    """Return (lat, lon, elevation_m) for a grid intersection."""
    # Offset from centre so node (5,5) ≈ CENTER
    lat = CENTER_LAT + (row - GRID_ROWS / 2) * LAT_STEP
    lon = CENTER_LON + (col - GRID_COLS / 2) * LON_STEP

    # Elevation — south-west corner is lowest (Buffalo Bayou corridor)
    elev = (
        BASE_ELEV
        + row * ROW_RISE                        # north is higher
        + (GRID_COLS - 1 - col) * COL_RISE      # west is higher
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
            "affected_nodes": affected,
        })
    return result


# ── Pre-built singletons (imported by other modules) ──────────────────────────
_G, _NODES = build_graph()
_SUBSTATIONS = build_substations(_NODES)
