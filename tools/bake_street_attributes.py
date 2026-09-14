"""Bake OpenStreetMap street attributes the original network bake dropped.

The first bake kept road names and class defaults only. Downtown Houston is a
grid of one-way streets and divided freeways, so an undirected graph sent
vehicles the wrong way down Main Street. This step matches every baked
segment back to its OSM way and records:

* oneway   0 = both directions, 1 = source -> target only, -1 = target -> source only
           (explicit oneway tags, plus the OSM implications for motorways,
           motorway links, and roundabouts)
* lanes    the tagged lane count when present, otherwise the class default
* speed_limit_mph  the posted maxspeed when tagged, otherwise the class default
* road_name        ramps without a name take their signed destination

Run from the repo root after tools/bake_city_network.py:
  python3 tools/bake_street_attributes.py
The Overpass download is cached in tools/.cache/streets.json.
"""

import json
import os
import re
import ssl
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tools", ".cache", "streets.json")
NETWORK_COPIES = [
    os.path.join(ROOT, "backend", "data", "houston_network.json"),
    os.path.join(ROOT, "frontend", "api", "data", "houston_network.json"),
    os.path.join(ROOT, "frontend", "public", "data", "houston_network.json"),
]
HIGHWAYS = "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street|service"
QUERY = f'[out:json][timeout:180];way["highway"~"^({HIGHWAYS})$"](29.735,-95.395,29.786,-95.345);out body;'
IMPLIED_ONEWAY_HIGHWAYS = {"motorway", "motorway_link"}
CLASS_RANK = {"service": 0, "local": 1, "collector": 2, "arterial": 3}
HIGHWAY_CLASS = {
    "motorway": "arterial", "motorway_link": "arterial", "trunk": "arterial", "trunk_link": "arterial",
    "primary": "arterial", "primary_link": "arterial", "secondary": "arterial", "secondary_link": "arterial",
    "tertiary": "collector", "tertiary_link": "collector",
    "residential": "local", "unclassified": "local", "living_street": "local", "service": "service",
}


def load_ways():
    if not os.path.exists(CACHE):
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        context = None
        try:
            import certifi
            context = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            pass
        request = urllib.request.Request(
            "https://overpass-api.de/api/interpreter",
            data=urllib.parse.urlencode({"data": QUERY}).encode(),
            headers={"User-Agent": "GridEvac-street-bake"},
        )
        with urllib.request.urlopen(request, timeout=240, context=context) as response, open(CACHE, "wb") as handle:
            handle.write(response.read())
    with open(CACHE) as handle:
        return [element for element in json.load(handle)["elements"] if element["type"] == "way"]


def parse_maxspeed(value):
    """'35 mph' -> 35; '50' (OSM default unit km/h) -> 31; anything else -> None."""
    if not value:
        return None
    match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(mph|km/h|kmh)?\s*$", value)
    if not match:
        return None
    speed = float(match.group(1))
    if match.group(2) != "mph":
        speed *= 0.621371
    return int(round(speed)) if 5 <= speed <= 85 else None


def parse_lanes(value):
    try:
        lanes = int(float(str(value).split(";")[0]))
    except (TypeError, ValueError):
        return None
    return lanes if 1 <= lanes <= 12 else None


def way_direction(tags):
    """+1 forward-only, -1 reverse-only, 0 both."""
    oneway = tags.get("oneway")
    if oneway in ("yes", "true", "1"):
        return 1
    if oneway in ("-1", "reverse"):
        return -1
    if oneway in ("no", "false", "0", "reversible", "alternating"):
        return 0
    if tags.get("junction") in ("roundabout", "circular") or tags.get("highway") in IMPLIED_ONEWAY_HIGHWAYS:
        return 1
    return 0


def ramp_name(tags):
    destination = tags.get("destination:ref") or tags.get("destination:street") or tags.get("destination")
    if destination:
        return f"Ramp to {destination.replace(';', ' / ')}"
    if tags.get("highway", "").endswith("_link"):
        return "Freeway ramp" if tags["highway"].startswith("motorway") else "Connector ramp"
    return None


def main():
    ways = load_ways()
    positions = defaultdict(list)  # osm node -> [(way index, position)]
    for way_index, way in enumerate(ways):
        for position, osm_id in enumerate(way.get("nodes", [])):
            positions[osm_id].append((way_index, position))

    with open(NETWORK_COPIES[0]) as handle:
        network = json.load(handle)
    osm_of = {node["id"]: node.get("osm") for node in network["nodes"]}

    stats = Counter()
    for edge in network["edges"]:
        source_osm, target_osm = osm_of.get(edge["source"]), osm_of.get(edge["target"])
        in_source = defaultdict(list)
        for way_index, position in positions.get(source_osm, []):
            in_source[way_index].append(position)
        best = None
        for way_index, target_position in positions.get(target_osm, []):
            if way_index not in in_source:
                continue
            way = ways[way_index]
            nodes = way["nodes"]
            closed = len(nodes) > 2 and nodes[0] == nodes[-1]
            for source_position in in_source[way_index]:
                gap = target_position - source_position
                if closed:
                    period = len(nodes) - 1
                    forward_gap = gap % period
                    backward_gap = (-gap) % period
                    gap = forward_gap if forward_gap <= backward_gap else -backward_gap
                if gap == 0:
                    continue
                way_class = HIGHWAY_CLASS.get(way["tags"].get("highway"), "local")
                # Prefer the way whose class matches the baked segment, then the tightest span.
                score = (way_class != edge["road_class"], abs(gap))
                if best is None or score < best[0]:
                    best = (score, way, gap > 0)
        if best is None:
            edge["oneway"] = 0
            stats["unmatched"] += 1
            continue
        _, way, forward = best
        tags = way["tags"]
        direction = way_direction(tags)
        edge["oneway"] = 0 if direction == 0 else (direction if forward else -direction)
        stats["oneway" if edge["oneway"] else "two-way"] += 1

        lanes = parse_lanes(tags.get("lanes"))
        if lanes:
            edge["lanes"] = lanes
            stats["lanes tagged"] += 1
        speed = parse_maxspeed(tags.get("maxspeed"))
        if speed:
            edge["speed_limit_mph"] = speed
            stats["maxspeed tagged"] += 1
        if edge["road_name"] == "Unnamed street":
            name = tags.get("name") or tags.get("ref") or ramp_name(tags)
            if name:
                edge["road_name"] = name
                stats["named"] += 1
        edge["weight"] = round(edge["distance_m"] / (edge["speed_limit_mph"] * 0.44704), 2)

    # Junctions that only carried a placeholder name pick up newly named streets.
    names = defaultdict(set)
    for edge in network["edges"]:
        if edge["road_name"] != "Unnamed street":
            names[edge["source"]].add(edge["road_name"])
            names[edge["target"]].add(edge["road_name"])
    for node in network["nodes"]:
        if node.get("intersection_name", "").startswith("Node ") and names[node["id"]]:
            streets = sorted(names[node["id"]])
            node["intersection_name"] = " / ".join(streets[:2])
            stats["junctions renamed"] += 1

    for path in NETWORK_COPIES:
        with open(path, "w") as handle:
            json.dump(network, handle, separators=(",", ":"))
    print(dict(stats))


if __name__ == "__main__":
    main()
