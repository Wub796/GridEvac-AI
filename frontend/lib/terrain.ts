/**
 * Rendering terrain: the 2x2-block ground and flood-stage grids baked by
 * tools/bake_terrain.py from the USGS 3DEP DEM. The map draws the flood
 * surface from the same stages the solver floods junctions with, so what the
 * operator sees under water is what the route avoids.
 */

export interface TerrainGrid {
  west: number;
  north: number;
  dx: number;
  dy: number;
  rows: number;
  cols: number;
  /** Ground elevation per cell, m NAVD88. */
  ground: Float32Array;
  /** Water surface at which each cell floods, m NAVD88. */
  stage: Float32Array;
}

type TerrainFile = Omit<TerrainGrid, 'ground' | 'stage'> & { ground: string; stage: string };

let pending: Promise<TerrainGrid | null> | null = null;

function decode(encoded: string): Float32Array {
  const binary = atob(encoded);
  const values = new Float32Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) values[i] = binary.charCodeAt(i) / 10 - 1;
  return values;
}

export function loadTerrain(): Promise<TerrainGrid | null> {
  if (!pending) {
    pending = fetch('/data/houston_terrain.json', { cache: 'force-cache' })
      .then((response) => (response.ok ? (response.json() as Promise<TerrainFile>) : null))
      .then((file) => file && { ...file, ground: decode(file.ground), stage: decode(file.stage) })
      .catch(() => {
        pending = null;
        return null;
      });
  }
  return pending;
}

export function terrainBounds(grid: TerrainGrid) {
  return { west: grid.west, east: grid.west + grid.cols * grid.dx, north: grid.north, south: grid.north - grid.rows * grid.dy };
}

/** Bilinear sample of a grid at a coordinate (cell centres on half-cell offsets). */
export function sample(grid: TerrainGrid, values: Float32Array, lat: number, lon: number): number {
  const row = Math.min(Math.max((grid.north - lat) / grid.dy - 0.5, 0), grid.rows - 1);
  const col = Math.min(Math.max((lon - grid.west) / grid.dx - 0.5, 0), grid.cols - 1);
  const r0 = Math.floor(row);
  const c0 = Math.floor(col);
  const r1 = Math.min(r0 + 1, grid.rows - 1);
  const c1 = Math.min(c0 + 1, grid.cols - 1);
  const fr = row - r0;
  const fc = col - c0;
  const at = (r: number, c: number) => values[r * grid.cols + c];
  const top = at(r0, c0) * (1 - fc) + at(r0, c1) * fc;
  const bottom = at(r1, c0) * (1 - fc) + at(r1, c1) * fc;
  return top * (1 - fr) + bottom * fr;
}
