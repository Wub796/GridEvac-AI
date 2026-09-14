"""Bake real terrain into the baked Houston street network.

Replaces the synthetic "distance from the bayou" elevations with measured
ground heights and a hydrologically connected flood model:

* Ground elevation: USGS 3DEP bare-earth DEM (1 m source, resampled by the
  3DEP ImageServer to a 6.25e-5 degree grid, ~6 m), metres NAVD88.
* Flood stage: priority-flood from the real bayou channels (OpenStreetMap
  river/stream centerlines). A cell's stage is the lowest water surface at
  which water from the channel can reach it without crossing higher ground,
  so a low parking lot behind a ridge stays dry until the ridge overtops.
  This is the "connected bathtub" model used for rapid flood-extent mapping.
* Bridge decks: street junctions whose every incident segment lies on an OSM
  bridge way are elevated; their stage is the surrounding bank height plus a
  deck clearance, so an overpass does not flood because the ground under it
  does.

Outputs:
  backend/data/houston_network.json            (+ the two mirror copies)
      nodes[].elevation      ground, m NAVD88
      nodes[].flood_stage_m  water surface at which the junction floods
      nodes[].elevated       true for bridge-deck junctions
      meta.flood_model       datum and rise per scenario level
      waterways[]            simplified bayou centerlines for the map
  frontend/public/data/houston_terrain.json
      2x2-block ground and stage grids (uint8 decimetres, base64) used by the
      map to draw a depth-shaded flood surface that matches the solver.

Run from the repo root (needs numpy + tifffile):
  python3 tools/bake_terrain.py
Source downloads are cached in tools/.cache; delete it to refetch.
"""

import base64
import heapq
import json
import math
import os
import ssl
import urllib.parse
import urllib.request

import numpy as np
import tifffile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tools", ".cache")
NETWORK_COPIES = [
    os.path.join(ROOT, "backend", "data", "houston_network.json"),
    os.path.join(ROOT, "frontend", "api", "data", "houston_network.json"),
    os.path.join(ROOT, "frontend", "public", "data", "houston_network.json"),
]
TERRAIN_OUT = os.path.join(ROOT, "frontend", "public", "data", "houston_terrain.json")

# DEM window: the street network bbox plus a margin so channel seeds and bank
# heights outside the district still shape flooding inside it.
DEM_BBOX = (-95.395, 29.736, -95.347, 29.784)  # west, south, east, north
DEM_SIZE = (768, 768)  # columns, rows -> 6.25e-5 degree (~6 x 7 m) cells
DEM_URL = (
    "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?"
    + urllib.parse.urlencode({
        "bbox": ",".join(str(v) for v in DEM_BBOX),
        "bboxSR": 4326,
        "imageSR": 4326,
        "size": f"{DEM_SIZE[0]},{DEM_SIZE[1]}",
        "format": "tiff",
        "pixelType": "F32",
        "noDataInterpretation": "esriNoDataMatchAny",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    })
)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_BBOX = "29.735,-95.395,29.786,-95.345"
WATERWAY_QUERY = f'[out:json][timeout:90];way["waterway"~"^(river|stream|canal)$"]({OVERPASS_BBOX});out body geom;'
BRIDGE_QUERY = f'[out:json][timeout:120];way["highway"]["bridge"]["bridge"!="no"]({OVERPASS_BBOX});out body geom;'

# Scenario level 0-10 maps to a water surface elevation (m NAVD88):
#   WSE = FLOOD_DATUM_M + level * FLOOD_RISE_PER_LEVEL_M
# The datum sits at the normal downtown channel surface; level 10 overtops
# most of the downtown street grid. USGS gage 08074000 (Buffalo Bayou at
# Houston, Shepherd Dr) reports gage height on a 0.00 ft NAVD88 datum, so a
# live reading converts directly to this scale.
FLOOD_DATUM_M = 1.0
FLOOD_RISE_PER_LEVEL_M = 1.5
GAGE = {
    "site": "08074000",
    "name": "Buffalo Bayou at Houston, TX",
    "lat": 29.76022829,
    "lon": -95.4085505,
    "datum_navd88_ft": 0.0,
}
DECK_CLEARANCE_M = 1.5


def fetch(url, path, data=None):
    """Download once into the cache; later runs reuse the file."""
    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = urllib.parse.urlencode({"data": data}).encode() if data else None
    request = urllib.request.Request(url, data=body, headers={"User-Agent": "GridEvac-terrain-bake"})
    context = None
    try:
        # Some Python builds ship without a CA bundle; certifi fills the gap.
        import certifi
        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    with urllib.request.urlopen(request, timeout=180, context=context) as response, open(path, "wb") as handle:
        handle.write(response.read())
    return path


def load_dem():
    path = fetch(DEM_URL, os.path.join(CACHE, "dem_3dep.tif"))
    with tifffile.TiffFile(path) as tif:
        page = tif.pages[0]
        grid = page.asarray().astype(np.float64)
        scale_x, scale_y, _ = page.tags["ModelPixelScaleTag"].value
        _, _, _, west, north, _ = page.tags["ModelTiepointTag"].value
    grid[grid < -100] = np.nan
    if np.isnan(grid).any():
        # Isolated no-data cells take the mean of valid neighbours.
        mean = np.nanmean(grid)
        grid = np.where(np.isnan(grid), mean, grid)
    return grid, west, north, scale_x, scale_y


def cell_of(lat, lon, west, north, dx, dy):
    """Fractional (row, col) of a coordinate, cell centres at integer values."""
    return (north - lat) / dy - 0.5, (lon - west) / dx - 0.5


def bilinear(grid, row, col):
    rows, cols = grid.shape
    row = min(max(row, 0.0), rows - 1.0)
    col = min(max(col, 0.0), cols - 1.0)
    r0, c0 = int(math.floor(row)), int(math.floor(col))
    r1, c1 = min(r0 + 1, rows - 1), min(c0 + 1, cols - 1)
    fr, fc = row - r0, col - c0
    top = grid[r0, c0] * (1 - fc) + grid[r0, c1] * fc
    bottom = grid[r1, c0] * (1 - fc) + grid[r1, c1] * fc
    return float(top * (1 - fr) + bottom * fr)


def priority_flood(ground, seeds):
    """Minimum water surface at which each cell connects to a seed (4-neighbour)."""
    rows, cols = ground.shape
    stage = np.full(ground.shape, np.inf)
    heap = []
    for r, c in seeds:
        if stage[r, c] > ground[r, c]:
            stage[r, c] = ground[r, c]
            heapq.heappush(heap, (ground[r, c], r, c))
    while heap:
        level, r, c = heapq.heappop(heap)
        if level > stage[r, c]:
            continue
        for nr, nc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
            if 0 <= nr < rows and 0 <= nc < cols:
                candidate = max(ground[nr, nc], level)
                if candidate < stage[nr, nc]:
                    stage[nr, nc] = candidate
                    heapq.heappush(heap, (candidate, nr, nc))
    return stage


def simplify(points, tolerance_m):
    """Douglas-Peucker on [lat, lon] pairs with a local metric projection."""
    if len(points) < 3:
        return points
    lat0 = math.radians(points[0][0])
    xy = [(math.radians(lon) * math.cos(lat0) * 6371000.0, math.radians(lat) * 6371000.0) for lat, lon in points]

    def distance(i, a, b):
        (px, py), (ax, ay), (bx, by) = xy[i], xy[a], xy[b]
        length_sq = (bx - ax) ** 2 + (by - ay) ** 2
        if length_sq == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / length_sq))
        return math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)))

    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        index, worst = -1, tolerance_m
        for i in range(a + 1, b):
            d = distance(i, a, b)
            if d > worst:
                index, worst = i, d
        if index >= 0:
            keep.add(index)
            stack.extend([(a, index), (index, b)])
    return [points[i] for i in sorted(keep)]


def main():
    with open(NETWORK_COPIES[0]) as handle:
        network = json.load(handle)

    ground, west, north, dx, dy = load_dem()
    rows, cols = ground.shape
    print(f"DEM {cols}x{rows} cells, {dx * 111320 * math.cos(math.radians(29.76)):.1f} x {dy * 111320:.1f} m, "
          f"ground {np.min(ground):.2f}..{np.max(ground):.2f} m NAVD88")

    waterways = json.load(open(fetch(OVERPASS_URL, os.path.join(CACHE, "waterways.json"), WATERWAY_QUERY)))["elements"]
    bridges = json.load(open(fetch(OVERPASS_URL, os.path.join(CACHE, "bridges.json"), BRIDGE_QUERY)))["elements"]

    # Seed the flood from every channel cell under a river or stream centerline,
    # sampled every ~2 m so no cell along the channel is skipped.
    seeds = set()
    waterways_out = []
    for way in waterways:
        geometry = [(point["lat"], point["lon"]) for point in way.get("geometry", [])]
        for (lat_a, lon_a), (lat_b, lon_b) in zip(geometry, geometry[1:]):
            length = math.hypot((lat_b - lat_a) * 111320.0, (lon_b - lon_a) * 111320.0 * math.cos(math.radians(lat_a)))
            steps = max(1, int(length / 2.0))
            for step in range(steps + 1):
                t = step / steps
                row, col = cell_of(lat_a + (lat_b - lat_a) * t, lon_a + (lon_b - lon_a) * t, west, north, dx, dy)
                r, c = int(round(row)), int(round(col))
                if 0 <= r < rows and 0 <= c < cols:
                    seeds.add((r, c))
        name = way.get("tags", {}).get("name")
        if name and len(geometry) >= 2:
            waterways_out.append({
                "id": f"waterway-{way['id']}",
                "name": name,
                "kind": way["tags"].get("waterway", "river"),
                "coords": [[round(lat, 6), round(lon, 6)] for lat, lon in simplify(geometry, 3.0)],
            })
    print(f"channel seed cells: {len(seeds)} from {len(waterways)} waterways")
    stage = priority_flood(ground, seeds)

    # Bridge edges: both endpoint OSM nodes belong to the same bridge way.
    bridge_membership = {}
    bridge_layer = {}
    for way in bridges:
        layer = way.get("tags", {}).get("layer", "1")
        try:
            layer_value = max(1, int(float(layer)))
        except ValueError:
            layer_value = 1
        for osm_id in way.get("nodes", []):
            bridge_membership.setdefault(osm_id, set()).add(way["id"])
            bridge_layer[osm_id] = max(bridge_layer.get(osm_id, 1), layer_value)
    osm_of = {node["id"]: node.get("osm") for node in network["nodes"]}
    incident = {}
    for edge in network["edges"]:
        a, b = osm_of.get(edge["source"]), osm_of.get(edge["target"])
        on_bridge = bool(bridge_membership.get(a, set()) & bridge_membership.get(b, set()))
        incident.setdefault(edge["source"], []).append(on_bridge)
        incident.setdefault(edge["target"], []).append(on_bridge)

    # Bank height around a deck: highest ground within ~60 m.
    radius_rows = max(1, int(round(60.0 / (dy * 111320.0))))
    radius_cols = max(1, int(round(60.0 / (dx * 111320.0 * math.cos(math.radians(29.76))))))

    elevated_count = 0
    for node in network["nodes"]:
        row, col = cell_of(node["lat"], node["lon"], west, north, dx, dy)
        node_ground = bilinear(ground, row, col)
        node_stage = max(node_ground, bilinear(stage, row, col))
        flags = incident.get(node["id"], [])
        if flags and all(flags):
            r = min(max(int(round(row)), 0), rows - 1)
            c = min(max(int(round(col)), 0), cols - 1)
            window = ground[max(0, r - radius_rows):r + radius_rows + 1, max(0, c - radius_cols):c + radius_cols + 1]
            layer = bridge_layer.get(node.get("osm"), 1)
            node_stage = max(node_stage, float(np.max(window)) + DECK_CLEARANCE_M * layer)
            node["elevated"] = True
            elevated_count += 1
        else:
            node.pop("elevated", None)
        node["elevation"] = round(node_ground, 2)
        node["flood_stage_m"] = round(node_stage, 2)

    stages = np.array([node["flood_stage_m"] for node in network["nodes"]])
    print(f"elevated junctions: {elevated_count}")
    print("node stage percentiles (5/25/50/75/95):", np.round(np.percentile(stages, [5, 25, 50, 75, 95]), 2))
    for level in (0, 2, 4, 5, 6, 7.2, 8, 10):
        wse = FLOOD_DATUM_M + level * FLOOD_RISE_PER_LEVEL_M
        print(f"  level {level:>4}: WSE {wse:5.2f} m -> {int(np.sum(stages <= wse)):>4} flooded junctions")
    for exit_id in network["safe_exits"]:
        node = next(n for n in network["nodes"] if n["id"] == exit_id)
        print(f"  exit {exit_id}: ground {node['elevation']} m, stage {node['flood_stage_m']} m")

    network["meta"].update({
        "elevation_source": "USGS 3DEP bare-earth DEM via 3DEPElevation ImageServer",
        "vertical_datum": "NAVD88",
        "flood_model": {
            "method": "connected bathtub (priority-flood from OSM bayou centerlines)",
            "datum_m": FLOOD_DATUM_M,
            "rise_per_level_m": FLOOD_RISE_PER_LEVEL_M,
            "gage": GAGE,
        },
    })
    network["waterways"] = waterways_out

    for path in NETWORK_COPIES:
        with open(path, "w") as handle:
            json.dump(network, handle, separators=(",", ":"))
        print(f"wrote {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)")

    # Rendering grid: 2x2 block means, uint8 decimetres offset by -1 m
    # (range -1.0 .. 24.5 m). Stage above the range clamps to 255 (never floods
    # within the 0-10 scenario scale).
    block_rows, block_cols = rows // 2, cols // 2
    def pack(grid):
        coarse = grid[:block_rows * 2, :block_cols * 2].reshape(block_rows, 2, block_cols, 2).mean(axis=(1, 3))
        encoded = np.clip(np.round((coarse + 1.0) * 10.0), 0, 255).astype(np.uint8)
        return base64.b64encode(encoded.tobytes()).decode()

    terrain = {
        "west": west,
        "north": north,
        "dx": dx * 2,
        "dy": dy * 2,
        "rows": block_rows,
        "cols": block_cols,
        "encoding": "uint8 decimetres, value / 10 - 1 = metres NAVD88, row-major from the north-west corner",
        "ground": pack(ground),
        "stage": pack(np.minimum(stage, 24.5)),
    }
    with open(TERRAIN_OUT, "w") as handle:
        json.dump(terrain, handle, separators=(",", ":"))
    print(f"wrote {os.path.relpath(TERRAIN_OUT, ROOT)} ({os.path.getsize(TERRAIN_OUT) // 1024} KB)")


if __name__ == "__main__":
    main()
