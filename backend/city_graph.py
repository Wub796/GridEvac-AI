"""
Houston street network for GridEvac AI.

The graph is a real street network baked from OpenStreetMap (see
tools/bake_city_network.py and data/houston_network.json). Intersections sit
on actual named corridors, edges carry the road's true curve geometry, and
building/park footprints are real shapes instead of procedural tiles.
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

_NODES: Dict[int, Dict] = {node["id"]: node for node in NODES}


def build_graph() -> nx.Graph:
    """Build the weighted street graph from the baked network."""
    graph = nx.Graph()
    for node in NODES:
        graph.add_node(node["id"], **node)
    for edge in EDGES:
        graph.add_edge(edge["source"], edge["target"], **{
            "weight": edge["weight"],
            "base_weight": edge["weight"],
            "distance_m": edge["distance_m"],
            "road_name": edge["road_name"],
            "road_class": edge["road_class"],
            "lanes": edge["lanes"],
            "speed_limit_mph": edge["speed_limit_mph"],
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
