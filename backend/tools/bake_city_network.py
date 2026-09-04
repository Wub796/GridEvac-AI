"""
Bake the real downtown Houston street network from OpenStreetMap exports.

Inputs (fetched from Overpass API, see README):
  /tmp/houston_streets.json  - highway ways + nodes
  /tmp/houston_features.json - building / park / waterway ways + nodes

Output:
  backend/data/houston_network.json - compact, self-contained network consumed
  by backend/city_graph.py, frontend/api (serverless mirror), and the offline
  frontend solver.

Run from the backend directory:
  python3 tools/bake_city_network.py /tmp/houston_streets.json /tmp/houston_features.json
"""

import json
import math
import os
import sys
from collections import defaultdict

BOUNDING_BOX = (29.7450, -95.3830, 29.7760, -95.3560)

HIGHWAY_CLASS = {
    "motorway": "arterial", "motorway_link": "arterial",
    "trunk": "arterial", "trunk_link": "arterial",
    "primary": "arterial", "primary_link": "arterial",
    "secondary": "arterial", "secondary_link": "arterial",
    "tertiary": "collector", "tertiary_link": "collector",
    "residential": "local", "unclassified": "local", "living_street": "local",
    # Alleys and freeway frontage roads are real drivable streets and belong in
    # the map; parking-lot aisles and drive-through lanes do not.
    "service": "service",
}

SERVICE_EXCLUDED = {"parking_aisle", "drive-through"}

# OSM node tags that force a graph vertex: stop/sign nodes that split ways,
# turning circles, and crossing breakpoints where geometry must bend.
STRUCTURAL_NODE_TAGS = {"traffic_signals", "stop", "give_way", "turning_circle", "turning_loop", "motorway_junction", "mini_roundabout"}

CLASS_LANES = {"arterial": 4, "collector": 3, "local": 2, "service": 1}
CLASS_SPEED_MPH = {"arterial": 35, "collector": 30, "local": 25, "service": 15}

# Intersections shortlisted as evacuation exits: perimeter nodes far from the
# center that keep maximum road connectivity. Final picks are computed below.
CENTER_LAT = 29.7604
CENTER_LON = -95.3698

# Synthetic terrain: real Houston is flat, but flash-flood modeling needs
# gradient. Buffalo Bayou is the real low corridor, so elevation rises with
# distance from the nearest waterway segment (4.2 m at the bank to ~16 m on
# the ridges), giving the flood slider a meaningful wet/dry gradient.
BAYOU_LOW = 4.2
ELEV_RANGE = 11.5
ELEV_FALLOFF_M = 780.0


def haversine_m(lat_a, lon_a, lat_b, lon_b):
    """Accurate WGS84 surface distance for measured street lengths."""
    lat_a_r, lon_a_r, lat_b_r, lon_b_r = map(math.radians, (lat_a, lon_a, lat_b, lon_b))
    d_lat = lat_b_r - lat_a_r
    d_lon = lon_b_r - lon_a_r
    a = math.sin(d_lat / 2) ** 2 + math.cos(lat_a_r) * math.cos(lat_b_r) * math.sin(d_lon / 2) ** 2
    return 6371000.0 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def load_elements(path):
    with open(path) as handle:
        data = json.load(handle)
    nodes = {}
    node_tags = {}
    ways = []
    for element in data["elements"]:
        if element["type"] == "node":
            nodes[element["id"]] = (element["lat"], element["lon"])
            if element.get("tags"):
                node_tags[element["id"]] = element["tags"]
        elif element["type"] == "way":
            ways.append(element)
    return nodes, ways, node_tags


def perpendicular_distance_m(point, start, end):
    """Distance in metres from point to segment start-end in local planar coords."""
    lat0 = math.radians((start[0] + end[0] + point[0]) / 3.0)
    to_xy = lambda lat, lon: (math.radians(lon) * math.cos(lat0) * 6371000.0, math.radians(lat) * 6371000.0)
    px, py = to_xy(*point)
    ax, ay = to_xy(*start)
    bx, by = to_xy(*end)
    length_sq = (bx - ax) ** 2 + (by - ay) ** 2
    if length_sq == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / length_sq))
    return math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)))


def polygon_area_m(points):
    """Shoelace area in square metres using a local equirectangular projection."""
    if len(points) < 3:
        return 0.0
    lat0 = math.radians(sum(p[0] for p in points) / len(points))
    projected = [(math.radians(lon) * math.cos(lat0) * 6371000.0, math.radians(lat) * 6371000.0) for lat, lon in points]
    area = 0.0
    for index in range(len(projected)):
        x1, y1 = projected[index]
        x2, y2 = projected[(index + 1) % len(projected)]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0


def main(streets_path, features_path, output_path):
    street_nodes, street_ways, street_node_tags = load_elements(streets_path)
    feature_nodes, feature_ways, _feature_node_tags = load_elements(features_path)

    # ------------------------------------------------------------------ roads
    # Only true junction nodes become graph vertices; every other OSM node
    # survives as curve geometry on its edge, so drawn roads bend exactly as
    # they do on the ground instead of collapsing into straight chords.
    usage = defaultdict(int)
    for way in street_ways:
        for node_id in way["nodes"]:
            usage[node_id] += 1

    road_ways = []
    for way in street_ways:
        tags = way.get("tags", {})
        highway = tags.get("highway", "")
        if highway not in HIGHWAY_CLASS:
            continue
        if highway == "service" and tags.get("service") in SERVICE_EXCLUDED:
            continue
        coords = []
        for node_id in way["nodes"]:
            if node_id in street_nodes:
                coords.append((node_id, street_nodes[node_id]))
        if len(coords) < 2:
            continue
        road_ways.append((way, tags, coords))

    # A node is a junction when ways physically meet there, or when the node
    # itself carries structural tags (turn restrictions, traffic signals that
    # split ways, access changes) - both must break the road into graph edges.
    junction_ids = {node_id for node_id, count in usage.items() if count >= 2}
    for _way, tags, coords in road_ways:
        for node_id, _coord in coords:
            node_tags = street_node_tags.get(node_id, {})
            if "highway" in node_tags and node_tags.get("highway") in STRUCTURAL_NODE_TAGS:
                junction_ids.add(node_id)
            if tags.get("junction") or node_tags.get("junction"):
                junction_ids.add(node_id)

    # Rough graph pass to identify connected components and drop scraps.
    adjacency = defaultdict(list)
    for _way, _tags, coords in road_ways:
        for (a, _), (b, _) in zip(coords, coords[1:]):
            adjacency[a].append(b)
            adjacency[b].append(a)

    seen = set()
    components = []
    for start in adjacency:
        if start in seen:
            continue
        stack, component = [start], set()
        while stack:
            current = stack.pop()
            if current in component:
                continue
            component.add(current)
            seen.add(current)
            stack.extend(adjacency[current])
        components.append(component)

    components.sort(key=len, reverse=True)
    keep_nodes = components[0]
    # Keep any secondary component with real size so the network covers the
    # full bounding box rather than one clique.
    for component in components[1:]:
        if len(component) >= 60:
            keep_nodes |= component

    # Vertex ids: junction OSM nodes become sequential graph ids. Non-junction
    # street nodes remain available to edges as curve geometry.
    vertices = {}
    for node_id in sorted(keep_nodes):
        if node_id in junction_ids:
            vertices[node_id] = len(vertices)

    # Elevation model: distance to the real Buffalo Bayou centerline drives the
    # synthetic flood surface, so floodwater appears in the actual low corridor.
    water_lines = []
    for way in feature_ways:
        if "waterway" in way.get("tags", {}):
            line = [feature_nodes[n] for n in way["nodes"] if n in feature_nodes]
            if len(line) >= 2:
                water_lines.append(line)

    def elevation_at(lat, lon):
        if not water_lines:
            return BAYOU_LOW + ELEV_RANGE * 0.5
        best = min(
            perpendicular_distance_m((lat, lon), water_lines[i][j], water_lines[i][j + 1])
            for i in range(len(water_lines))
            for j in range(len(water_lines[i]) - 1)
        )
        t = min(1.0, best / ELEV_FALLOFF_M) ** 0.75
        # Gentle noise keeps neighbouring intersections distinguishable.
        noise = 0.35 * math.sin(lat * 5200.0) * math.cos(lon * 4300.0)
        return BAYOU_LOW + ELEV_RANGE * t + noise

    nodes_out = []
    for osm_id, vertex_id in sorted(vertices.items(), key=lambda item: item[1]):
        lat, lon = street_nodes[osm_id]
        nodes_out.append({
            "id": vertex_id,
            "osm": osm_id,
            "lat": round(lat, 7),
            "lon": round(lon, 7),
            "elevation": round(max(2.5, elevation_at(lat, lon)), 2),
        })

    node_by_osm = {node["osm"]: node for node in nodes_out}
    coord_by_osm = {osm_id: street_nodes[osm_id] for osm_id in keep_nodes if osm_id in street_nodes}

    # Edges: one graph edge per pair of consecutive junctions along a way,
    # preserving the way's curve geometry between them.
    edge_map = {}

    def add_edge(source_osm, target_osm, geometry_osm, tags):
        if source_osm not in node_by_osm or target_osm not in node_by_osm:
            return
        key = (min(source_osm, target_osm), max(source_osm, target_osm))
        highway = tags.get("highway", "residential")
        road_class = HIGHWAY_CLASS.get(highway, "local")
        if key in edge_map:
            # Keep the highest-class representation of a duplicated segment.
            existing_class = edge_map[key]["road_class"]
            rank = {"service": 0, "local": 1, "collector": 2, "arterial": 3}
            if rank.get(road_class, 1) <= rank.get(existing_class, 1):
                return
        name = tags.get("name") or tags.get("ref") or "Unnamed street"
        source = node_by_osm[source_osm]
        target = node_by_osm[target_osm]
        # Curve points look up raw OSM coordinates, not graph vertices, so the
        # full street shape survives even where geometry nodes are not junctions.
        full_geometry = [(source["lat"], source["lon"])] + [
            coord_by_osm[g] for g in geometry_osm if g in coord_by_osm and g not in (source_osm, target_osm)
        ] + [(target["lat"], target["lon"])]
        distance = sum(
            haversine_m(p[0], p[1], q[0], q[1])
            for p, q in zip(full_geometry, full_geometry[1:])
        )
        # Skip degenerate edges created when duplicate ways share endpoints.
        if distance < 1.0:
            return
        speed_mps = CLASS_SPEED_MPH[road_class] * 0.44704
        edge_map[key] = {
            "source": source["id"],
            "target": target["id"],
            "road_name": name,
            "road_class": road_class,
            "lanes": CLASS_LANES[road_class],
            "speed_limit_mph": CLASS_SPEED_MPH[road_class],
            "distance_m": round(distance, 1),
            "weight": round(distance / speed_mps, 2),
            "geometry": [[round(p[0], 7), round(p[1], 7)] for p in full_geometry[1:-1]],
        }

    for _way, tags, coords in road_ways:
        junction_positions = [index for index, (node_id, _coord) in enumerate(coords) if node_id in vertices]
        for start_index, end_index in zip(junction_positions, junction_positions[1:]):
            segment = coords[start_index:end_index + 1]
            add_edge(segment[0][0], segment[-1][0], [node_id for node_id, _ in segment[1:-1]], tags)

    edges_out = sorted(edge_map.values(), key=lambda edge: (edge["source"], edge["target"]))

    # ------------------------------------------------------------- intersections
    street_count = defaultdict(int)
    for edge in edges_out:
        street_count[edge["road_name"]] += 1
    for node in nodes_out:
        node["intersection_name"] = "Intersection"
    incoming = defaultdict(set)
    outgoing = defaultdict(set)
    for edge in edges_out:
        outgoing[edge["source"]].add(edge["road_name"])
        incoming[edge["target"]].add(edge["road_name"])
    for node in nodes_out:
        streets = sorted(name for name in (incoming[node["id"]] | outgoing[node["id"]]) if name != "Unnamed street")
        if len(streets) >= 2:
            node["intersection_name"] = f"{streets[0]} / {streets[1]}"
        elif streets:
            node["intersection_name"] = streets[0]
        else:
            node["intersection_name"] = f"Node {node['id']}"

    # ------------------------------------------------------------- substations
    # Anchor utility infrastructure to high-connectivity intersections so
    # outage polygons align with the real street network.
    connectivity = sorted(nodes_out, key=lambda node: -len(incoming[node["id"]] | outgoing[node["id"]]))
    anchors = []
    used = set()
    for node in connectivity:
        if any(haversine_m(node["lat"], node["lon"], other["lat"], other["lon"]) < 420 for other in anchors):
            continue
        anchors.append(node)
        if len(anchors) == 5:
            break

    substation_names = [
        ("Downtown Core Substation", 3.4, 250.0, 180.0),
        ("Third Ward Substation", 2.8, 150.0, 90.0),
        ("Heights Substation", 3.0, 130.0, 95.0),
        ("Fifth Ward Substation", 2.6, 110.0, 70.0),
        ("Northside Substation", 3.0, 120.0, 85.0),
    ]
    # Prefer a central anchor for the downtown facility so its service area
    # covers the district instead of being pushed to the network's edge.
    anchors.sort(key=lambda node: haversine_m(node["lat"], node["lon"], CENTER_LAT, CENTER_LON))
    anchors = anchors[:1] + sorted(anchors[1:], key=lambda node: node["lat"])[::-1]
    # radius is expressed in city blocks (~150 m), matching the original model.
    BLOCK_METERS = 150.0
    substations_out = []
    for index, (node, (name, radius, capacity, load)) in enumerate(zip(anchors, substation_names)):
        affected = [
            other["id"] for other in nodes_out
            if haversine_m(node["lat"], node["lon"], other["lat"], other["lon"]) <= radius * BLOCK_METERS
        ]
        substations_out.append({
            "id": index,
            "node": node["id"],
            "name": name,
            "radius": radius,
            "lat": node["lat"],
            "lon": node["lon"],
            "capacity_mw": capacity,
            "base_load_mw": load,
            "affected_nodes": affected,
        })

    links_out = [
        {"id": 0, "from_sub": 0, "to_sub": 1},
        {"id": 1, "from_sub": 0, "to_sub": 2},
        {"id": 2, "from_sub": 0, "to_sub": 4},
        {"id": 3, "from_sub": 1, "to_sub": 3},
        {"id": 4, "from_sub": 3, "to_sub": 4},
    ]

    # ---------------------------------------------------------------- exits
    # One perimeter exit per compass quadrant (N/E/S/W) so evacuation targets
    # spread across the district instead of clustering on the nearest boundary.
    QUADRANTS = [("North", 0.0), ("East", 90.0), ("South", 180.0), ("West", 270.0)]

    def bearing_from_center(node):
        d_lat = node["lat"] - CENTER_LAT
        d_lon = (node["lon"] - CENTER_LON) * math.cos(math.radians(CENTER_LAT))
        return math.degrees(math.atan2(d_lon, d_lat)) % 360.0

    exits: List[Dict] = []
    exit_names: Dict[int, str] = {}
    for label, quadrant_bearing in QUADRANTS:
        in_quadrant = [
            node for node in nodes_out
            if min(abs(bearing_from_center(node) - quadrant_bearing), 360.0 - abs(bearing_from_center(node) - quadrant_bearing)) <= 60.0
            and haversine_m(node["lat"], node["lon"], CENTER_LAT, CENTER_LON) >= 900.0
            and len(incoming[node["id"]] | outgoing[node["id"]]) >= 2
        ]
        in_quadrant.sort(
            key=lambda node: (
                -haversine_m(node["lat"], node["lon"], CENTER_LAT, CENTER_LON),
                -(len(incoming[node["id"]] | outgoing[node["id"]])),
            )
        )
        chosen = next(
            (node for node in in_quadrant if all(haversine_m(node["lat"], node["lon"], other["lat"], other["lon"]) >= 900.0 for other in exits)),
            in_quadrant[0] if in_quadrant else None,
        )
        if chosen:
            exits.append(chosen)
            exit_names[chosen["id"]] = f"{label} exit"

    # ------------------------------------------------------------- buildings
    buildings_out = []
    parks_out = []
    for way in feature_ways:
        tags = way.get("tags", {})
        coords = [feature_nodes[n] for n in way["nodes"] if n in feature_nodes]
        if len(coords) < 3 or coords[0] != coords[-1]:
            continue
        area = polygon_area_m(coords)
        if area < 120:
            continue
        lats = [p[0] for p in coords]
        lons = [p[1] for p in coords]
        footprint = [[round(lat, 7), round(lon, 7)] for lat, lon in coords[:-1]]
        if "building" in tags:
            levels = tags.get("building:levels")
            try:
                height = min(180.0, max(6.0, float(levels) * 3.4)) if levels else 12.0
            except (TypeError, ValueError):
                height = 12.0
            if area > 4000:
                height = max(height, 30.0)
            buildings_out.append({
                "id": f"bldg-{way['id']}",
                "footprint": footprint,
                "height_m": round(height, 1),
            })
        elif tags.get("leisure") == "park" and area > 800:
            parks_out.append({
                "id": f"park-{way['id']}",
                "footprint": footprint,
            })

    # Cap buildings for payload size: keep the largest footprints downtown.
    buildings_out.sort(key=lambda item: -polygon_area_m([(p[0], p[1]) for p in item["footprint"]]))
    buildings_out = buildings_out[:1400]

    network = {
        "meta": {
            "name": "Downtown Houston street network",
            "source": "OpenStreetMap via Overpass API",
            "bbox": list(BOUNDING_BOX),
            "center_lat": CENTER_LAT,
            "center_lon": CENTER_LON,
        },
        "nodes": nodes_out,
        "edges": edges_out,
        "blocks": buildings_out,
        "parks": parks_out,
        "substations": substations_out,
        "transmission_links": links_out,
        "safe_exits": [node["id"] for node in exits],
        "exit_names": exit_names,
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as handle:
        json.dump(network, handle, separators=(",", ":"))

    size_kb = os.path.getsize(output_path) // 1024
    print(f"nodes={len(nodes_out)} edges={len(edges_out)} buildings={len(buildings_out)} parks={len(parks_out)} curve_pts={sum(len(e['geometry']) for e in edges_out)} exits={network['safe_exits']} size={size_kb}KB")


if __name__ == "__main__":
    streets = sys.argv[1] if len(sys.argv) > 1 else "/tmp/houston_streets.json"
    features = sys.argv[2] if len(sys.argv) > 2 else "/tmp/houston_features.json"
    output = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), "..", "data", "houston_network.json")
    main(streets, features, os.path.abspath(output))
