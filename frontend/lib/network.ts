import type { CityData } from './types';

const METERS_PER_DEG_LAT = 111320;

/**
 * The set of nodes that deserve a clickable dot: real street junctions
 * (degree >= 3), plus perimeter exits and shelter junctions regardless of
 * degree. Pure shape points (degree 2, mid-block) and dead ends (degree 1)
 * are routing geometry, not places anyone would pick as an origin.
 *
 * Corners that exist multiple times in the OSM export (a four-corner
 * intersection can be four nodes a few meters apart) are clustered within
 * 15 m into one logical junction. The surviving node is the highest-priority
 * one - exits, then shelter junctions, then higher degree, then lower id -
 * and the returned position is the cluster centroid so the dot sits in the
 * middle of the intersection rather than on one corner.
 */
type LogicalJunctions = {
  ids: Set<number>;
  /** Winner node id -> centroid position of its corner cluster. */
  positions: Map<number, { lat: number; lon: number }>;
};

const junctionCache = new WeakMap<CityData, Map<string, LogicalJunctions>>();

/** Cached: clustering is quadratic in candidates and many views ask for it. */
export function logicalJunctions(cityData: CityData, extraExitIds: Iterable<number> = []): LogicalJunctions {
  const extras = Array.from(extraExitIds).sort((a, b) => a - b);
  const key = extras.join(',');
  let perCity = junctionCache.get(cityData);
  if (!perCity) {
    perCity = new Map();
    junctionCache.set(cityData, perCity);
  }
  const cached = perCity.get(key);
  if (cached) return cached;
  const result = computeLogicalJunctions(cityData, extras);
  perCity.set(key, result);
  return result;
}

function computeLogicalJunctions(cityData: CityData, extraExitIds: number[]): LogicalJunctions {
  const junctionDegrees = new Map<number, number>();
  cityData.edges.forEach((edge) => {
    junctionDegrees.set(edge.source, (junctionDegrees.get(edge.source) ?? 0) + 1);
    junctionDegrees.set(edge.target, (junctionDegrees.get(edge.target) ?? 0) + 1);
  });
  const exitSet = new Set(cityData.safe_exits ?? []);
  Array.from(extraExitIds).forEach((id) => exitSet.add(id));
  const shelterJunctionIds = new Set((cityData.shelters ?? []).map((shelter) => shelter.node));

  const junctionPrio = (id: number) =>
    (exitSet.has(id) ? 2 : 0) + (shelterJunctionIds.has(id) ? 1 : 0);

  const candidates = cityData.nodes.filter(
    (node) => (junctionDegrees.get(node.id) ?? 0) >= 3 || exitSet.has(node.id) || shelterJunctionIds.has(node.id)
  );

  const ids = new Set<number>();
  const positions = new Map<number, { lat: number; lon: number }>();
  const unclustered = [...candidates];
  while (unclustered.length > 0) {
    const seed = unclustered.pop()!;
    const cluster: typeof candidates = [seed];
    for (let i = unclustered.length - 1; i >= 0; i--) {
      const other = unclustered[i];
      const dLat = (seed.lat - other.lat) * METERS_PER_DEG_LAT;
      const dLon = (seed.lon - other.lon) * METERS_PER_DEG_LAT * Math.cos((seed.lat * Math.PI) / 180);
      if (Math.sqrt(dLat * dLat + dLon * dLon) <= 15) {
        cluster.push(other);
        unclustered.splice(i, 1);
      }
    }
    cluster.sort((a, b) => {
      if (junctionPrio(a.id) !== junctionPrio(b.id)) return junctionPrio(b.id) - junctionPrio(a.id);
      if ((junctionDegrees.get(a.id) ?? 0) !== (junctionDegrees.get(b.id) ?? 0)) {
        return (junctionDegrees.get(b.id) ?? 0) - (junctionDegrees.get(a.id) ?? 0);
      }
      return a.id - b.id;
    });
    const winner = cluster[0];
    ids.add(winner.id);
    if (cluster.length > 1) {
      positions.set(winner.id, {
        lat: cluster.reduce((sum, node) => sum + node.lat, 0) / cluster.length,
        lon: cluster.reduce((sum, node) => sum + node.lon, 0) / cluster.length,
      });
    }
  }

  return { ids, positions };
}