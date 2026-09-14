"""
Houston street network for GridEvac AI.

The graph is a real street network baked from OpenStreetMap (see
tools/bake_city_network.py and data/houston_network.json). Intersections sit
on actual named corridors, edges carry the road's true curve geometry, and
building/park footprints are real shapes instead of procedural tiles.

Ground elevations come from the USGS 3DEP bare-earth DEM and every junction
carries a flood stage from a hydrologically connected flood model (see
tools/bake_terrain.py): the water surface elevation, in metres NAVD88, at
which bayou water first reaches it.
"""

import json
import os
from typing import Dict, List

import networkx as nx

_DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "houston_network.json")

with open(_DATA_PATH) as _handle:
    NETWORK: Dict = json.load(_handle)

META: Dict = NETWORK["meta"]
CENTER_LAT: float = META["center_lat"]
CENTER_LON: float = META["center_lon"]

NODES: List[Dict] = NETWORK["nodes"]
EDGES: List[Dict] = NETWORK["edges"]
BLOCKS: List[Dict] = NETWORK["blocks"]
PARKS: List[Dict] = NETWORK.get("parks", [])
SUBSTATIONS: List[Dict] = NETWORK["substations"]
TRANSMISSION_LINKS: List[Dict] = NETWORK["transmission_links"]
SAFE_EXITS: List[int] = NETWORK["safe_exits"]
EXIT_NAMES: Dict[str, str] = NETWORK.get("exit_names", {})
# Real evacuation destinations (shelters / medical), snapped to the nearest
# network junction by tools/bake_shelters.py. Each carries its snap distance
# so callers can flag placements that drifted off the street network.
SHELTERS: List[Dict] = NETWORK.get("shelters", [])
WATERWAYS: List[Dict] = NETWORK.get("waterways", [])

# Scenario level (0-10) -> water surface elevation, metres NAVD88.
FLOOD_MODEL: Dict = META.get("flood_model", {})
FLOOD_DATUM_M: float = float(FLOOD_MODEL.get("datum_m", 0.0))
FLOOD_RISE_PER_LEVEL_M: float = float(FLOOD_MODEL.get("rise_per_level_m", 1.7))

_NODES: Dict[int, Dict] = {node["id"]: node for node in NODES}


def water_surface_m(flood_level: float) -> float:
    """Modeled water surface elevation (m NAVD88) for a scenario level."""
    return FLOOD_DATUM_M + flood_level * FLOOD_RISE_PER_LEVEL_M


def level_for_water_surface(water_surface: float) -> float:
    """Inverse of water_surface_m: the scenario level for an elevation."""
    return (water_surface - FLOOD_DATUM_M) / FLOOD_RISE_PER_LEVEL_M


def flood_stage(node: Dict) -> float:
    """Water surface at which a junction floods (falls back to ground height)."""
    return float(node.get("flood_stage_m", node["elevation"]))


def build_graph() -> nx.Graph:
    """Build the weighted street graph from the baked network.

    `source` records the baked edge direction so traversals that run
    target -> source can reverse the curve geometry.
    """
    graph = nx.Graph()
    for node in NODES:
        graph.add_node(node["id"], **node)
    for edge in EDGES:
        graph.add_edge(edge["source"], edge["target"], **{
            "source": edge["source"],
            "weight": edge["weight"],
            "base_weight": edge["weight"],
            "distance_m": edge["distance_m"],
            "road_name": edge["road_name"],
            "road_class": edge["road_class"],
            "lanes": edge["lanes"],
            "speed_limit_mph": edge["speed_limit_mph"],
            "oneway": int(edge.get("oneway", 0)),
            "geometry": edge.get("geometry", []),
        })
    return graph


def build_substations() -> List[Dict]:
    return [dict(sub) for sub in SUBSTATIONS]


def build_blocks() -> List[Dict]:
    """Blocks are real building footprints; the renderer extrudes them directly."""
    return [dict(block) for block in BLOCKS]


_G = build_graph()
_SUBSTATIONS = build_substations()
_BLOCKS = build_blocks()
