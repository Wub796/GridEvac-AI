"""
Houston street and utility graph used by GridEvac AI.

The graph is intentionally compact enough for local simulation, but its geometry
is street-oriented: intersections sit on named corridors, blocks sit between
those corridors, and buildings are kept inside block setbacks by the renderer.
"""

import math
from typing import Dict, List, Tuple

import networkx as nx
import numpy as np

# Geographic envelope: a compact downtown / Midtown operations district.
CENTER_LAT: float = 29.7604
CENTER_LON: float = -95.3698
GRID_ROWS: int = 15
GRID_COLS: int = 15
LAT_STEP: float = 0.00135  # roughly 150 m north/south
LON_STEP: float = 0.00165  # roughly 160 m east/west

BASE_ELEV: float = 8.5
ROW_RISE: float = 0.34
COL_RISE: float = 0.24
NOISE_AMP: float = 0.55

# Road names are ordered north -> south and west -> east in the local model.
EW_ROADS: List[str] = [
    "Allen Parkway", "Dallas Street", "Lamar Street", "McKinney Street",
    "Rusk Street", "Capitol Street", "Congress Street", "Preston Street",
    "Franklin Street", "Commerce Street", "Leeland Street", "Polk Street",
    "Jefferson Street", "Clay Street", "Bell Street",
]
NS_ROADS: List[str] = [
    "Bagby Street", "Smith Street", "Louisiana Street", "Milam Street",
    "Travis Street", "Main Street", "Fannin Street", "San Jacinto Street",
    "Caroline Street", "Austin Street", "La Branch Street", "Crawford Street",
    "St. Charles Street", "Chene Street", "Jensen Drive",
]

# Substations and utility links are positioned on the same intersection network.
SUBSTATION_DEFS: List[Dict] = [
    {"id": 0, "node": 32,  "name": "Third Ward Substation",    "radius": 2.8, "capacity_mw": 150.0, "base_load_mw": 90.0},
    {"id": 1, "node": 56,  "name": "River Oaks Substation",    "radius": 3.1, "capacity_mw": 120.0, "base_load_mw": 85.0},
    {"id": 2, "node": 112, "name": "Downtown Core Substation", "radius": 3.4, "capacity_mw": 250.0, "base_load_mw": 180.0},
    {"id": 3, "node": 168, "name": "Fifth Ward Substation",    "radius": 2.6, "capacity_mw": 110.0, "base_load_mw": 70.0},
    {"id": 4, "node": 192, "name": "Heights Substation",       "radius": 3.0, "capacity_mw": 130.0, "base_load_mw": 95.0},
]

TRANSMISSION_LINKS: List[Dict] = [
    {"id": 0, "from_sub": 0, "to_sub": 2},
    {"id": 1, "from_sub": 1, "to_sub": 2},
    {"id": 2, "from_sub": 2, "to_sub": 4},
    {"id": 3, "from_sub": 3, "to_sub": 4},
    {"id": 4, "from_sub": 0, "to_sub": 3},
]

MAJOR_EW_ROWS = {0, 3, 5, 8, 11, 14}
MAJOR_NS_COLS = {1, 4, 6, 8, 11, 14}


def node_id(row: int, col: int) -> int:
    return row * GRID_COLS + col


def node_position(row: int, col: int) -> Tuple[float, float, float]:
    """Return (latitude, longitude, synthetic elevation in metres)."""
    lat = CENTER_LAT + (row - (GRID_ROWS - 1) / 2.0) * LAT_STEP
    lon = CENTER_LON + (col - (GRID_COLS - 1) / 2.0) * LON_STEP
    elev = (
        BASE_ELEV
        + row * ROW_RISE
        + (GRID_COLS - 1 - col) * COL_RISE
        + NOISE_AMP * (math.sin(row * 1.4 + col * 0.9) + math.cos(row * 0.7 + col * 1.5)) * 0.5
    )
    return float(lat), float(lon), max(4.0, float(elev))


def _distance_m(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    """Approximate local WGS84 distance; sufficient for route ETA display."""
    lat_m = (lat_b - lat_a) * 111_320.0
    lon_m = (lon_b - lon_a) * 111_320.0 * math.cos(math.radians((lat_a + lat_b) / 2.0))
    return math.hypot(lat_m, lon_m)


def _road_attributes(row: int, col: int, horizontal: bool) -> Dict:
    if horizontal:
        road_name = EW_ROADS[row]
        major = row in MAJOR_EW_ROWS
    else:
        road_name = NS_ROADS[col]
        major = col in MAJOR_NS_COLS
    if major:
        return {
            "road_name": road_name,
            "road_class": "arterial",
            "lanes": 4,
            "speed_limit_mph": 35,
        }
    if (row + col) % 3 == 0:
        return {
            "road_name": road_name,
            "road_class": "collector",
            "lanes": 3,
            "speed_limit_mph": 30,
        }
    return {
        "road_name": road_name,
        "road_class": "local",
        "lanes": 2,
        "speed_limit_mph": 25,
    }


def _node_data(row: int, col: int) -> Dict:
    lat, lon, elev = node_position(row, col)
    return {
        "id": node_id(row, col),
        "lat": lat,
        "lon": lon,
        "elevation": elev,
        "row": row,
        "col": col,
        "intersection_name": f"{EW_ROADS[row]} / {NS_ROADS[col]}",
        "district": "Downtown" if 4 <= row <= 10 and 4 <= col <= 10 else "Houston operations district",
    }


def build_graph() -> Tuple[nx.Graph, Dict[int, Dict]]:
    """Build the named street graph and return (graph, node lookup)."""
    graph = nx.Graph()
    nodes: Dict[int, Dict] = {}

    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            data = _node_data(row, col)
            nodes[data["id"]] = data
            graph.add_node(data["id"], **data)

    for row in range(GRID_ROWS):
        for col in range(GRID_COLS - 1):
            u, v = node_id(row, col), node_id(row, col + 1)
            src, dst = nodes[u], nodes[v]
            attrs = _road_attributes(row, col, horizontal=True)
            distance = _distance_m(src["lat"], src["lon"], dst["lat"], dst["lon"])
            speed_mps = attrs["speed_limit_mph"] * 0.44704
            graph.add_edge(
                u, v,
                weight=distance / speed_mps,
                base_weight=distance / speed_mps,
                distance_m=round(distance, 1),
                **attrs,
            )

    for row in range(GRID_ROWS - 1):
        for col in range(GRID_COLS):
            u, v = node_id(row, col), node_id(row + 1, col)
            src, dst = nodes[u], nodes[v]
            attrs = _road_attributes(row, col, horizontal=False)
            distance = _distance_m(src["lat"], src["lon"], dst["lat"], dst["lon"])
            speed_mps = attrs["speed_limit_mph"] * 0.44704
            graph.add_edge(
                u, v,
                weight=distance / speed_mps,
                base_weight=distance / speed_mps,
                distance_m=round(distance, 1),
                **attrs,
            )

    return graph, nodes


def build_substations(nodes: Dict[int, Dict]) -> List[Dict]:
    """Expand substation definitions with affected node lists and coordinates."""
    result = []
    for sub in SUBSTATION_DEFS:
        center_node = sub["node"]
        center = nodes[center_node]
        cr, cc = center["row"], center["col"]
        affected = [
            node_id(row, col)
            for row in range(GRID_ROWS)
            for col in range(GRID_COLS)
            if math.hypot(row - cr, col - cc) <= sub["radius"]
        ]
        result.append({
            **sub,
            "lat": center["lat"],
            "lon": center["lon"],
            "affected_nodes": affected,
        })
    return result


def build_blocks(nodes: Dict[int, Dict]) -> List[Dict]:
    """Create block land-use metadata; footprints are inset by the Cesium renderer."""
    blocks: List[Dict] = []
    kinds = ["office", "residential", "retail", "civic"]
    for row in range(GRID_ROWS - 1):
        for col in range(GRID_COLS - 1):
            corners = [nodes[node_id(row, col)], nodes[node_id(row + 1, col)], nodes[node_id(row, col + 1)], nodes[node_id(row + 1, col + 1)]]
            lat = sum(point["lat"] for point in corners) / 4.0
            lon = sum(point["lon"] for point in corners) / 4.0
            is_park = (row * 7 + col * 11) % 19 == 0 or (row == 6 and col == 2)
            if is_park:
                kind = "park"
                height = 0.0
            else:
                kind = kinds[(row * 3 + col * 5) % len(kinds)]
                central_bonus = 28.0 if 4 <= row <= 9 and 4 <= col <= 9 else 0.0
                height = 22.0 + central_bonus + float(((row * 13 + col * 17) % 8) * 8)
            blocks.append({
                "id": f"block-{row}-{col}",
                "row": row,
                "col": col,
                "lat": round(lat, 7),
                "lon": round(lon, 7),
                "kind": kind,
                "height_m": round(height, 1),
            })
    return blocks


_G, _NODES = build_graph()
_SUBSTATIONS = build_substations(_NODES)
_BLOCKS = build_blocks(_NODES)
