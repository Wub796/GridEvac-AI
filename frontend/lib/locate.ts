/**
 * Device location to a routable start.
 *
 * A GPS fix rarely sits on a junction. The fix is projected onto the nearest
 * street centreline, then the traveller starts from whichever end of that
 * street they can legally reach (one-way rules for vehicles) with the lowest
 * total time: the trip along the street to the junction plus the route from
 * there. The fix never leaves the browser; only the chosen junction id does.
 */
import {
  TRAVEL_MODES,
  allowedArcs,
  displayName,
  edgePoints,
  floodedNodeIds,
  solveRoute,
  vehicleCore,
  type RouteInput,
} from './solver';
import type { CityData, EdgeData, NodeData } from './types';

const METERS_PER_DEGREE = 111320;
/** Fixes vaguer than this (IP or cell-tower location) are not snapped to a street. */
export const MAX_ACCURACY_M = 1000;
/** Farther than this from every mapped street, the fix is not on the network. */
const SEARCH_RADIUS_M = 500;
/** Fixes within this distance outside the network bounds still count as in the district. */
const DISTRICT_MARGIN_M = 250;
/** Someone under an overpass is on the street below it, not on the deck. */
const BRIDGE_DECK_PENALTY_M = 30;
const CELL_DEGREES = 0.002;

export interface DeviceFix {
  lat: number;
  lon: number;
  /** 68% confidence radius reported by the device, metres. */
  accuracy: number;
  timestamp: number;
}

export interface SnapResult {
  status: 'snapped' | 'outside' | 'imprecise' | 'unreachable';
  distanceToDistrictM: number;
  originNode: number | null;
  streetName: string;
  snapped: { lat: number; lon: number } | null;
  /** Straight-line distance from the fix to the nearest street centreline. */
  distanceToStreetM: number;
  /** Distance along that street to the starting junction. */
  accessM: number;
  accessSeconds: number;
  /** Fix, then the street point, then along the street to the junction: [lat, lon] pairs. */
  accessPath: Array<[number, number]>;
}

interface Index {
  cells: Map<string, EdgeData[]>;
  nodes: Map<number, NodeData>;
  bounds: { south: number; north: number; west: number; east: number };
}

const indexes = new WeakMap<CityData, Index>();

function networkIndex(city: CityData): Index {
  const cached = indexes.get(city);
  if (cached) return cached;
  const nodes = new Map(city.nodes.map((node) => [node.id, node]));
  const bounds = { south: Infinity, north: -Infinity, west: Infinity, east: -Infinity };
  city.nodes.forEach((node) => {
    bounds.south = Math.min(bounds.south, node.lat);
    bounds.north = Math.max(bounds.north, node.lat);
    bounds.west = Math.min(bounds.west, node.lon);
    bounds.east = Math.max(bounds.east, node.lon);
  });
  const cells = new Map<string, EdgeData[]>();
  city.edges.forEach((edge) => {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) return;
    const points = edgePoints(nodes, edge.source, edge.target, edge);
    const lats = points.map(([lat]) => lat);
    const lons = points.map(([, lon]) => lon);
    for (let row = Math.floor(Math.min(...lats) / CELL_DEGREES); row <= Math.floor(Math.max(...lats) / CELL_DEGREES); row += 1) {
      for (let col = Math.floor(Math.min(...lons) / CELL_DEGREES); col <= Math.floor(Math.max(...lons) / CELL_DEGREES); col += 1) {
        const key = `${row}:${col}`;
        const list = cells.get(key);
        if (list) list.push(edge); else cells.set(key, [edge]);
      }
    }
  });
  const index = { cells, nodes, bounds };
  indexes.set(city, index);
  return index;
}

export function distanceToDistrictM(city: CityData, lat: number, lon: number): number {
  const { bounds } = networkIndex(city);
  const dLat = lat < bounds.south ? bounds.south - lat : lat > bounds.north ? lat - bounds.north : 0;
  const dLon = lon < bounds.west ? bounds.west - lon : lon > bounds.east ? lon - bounds.east : 0;
  return Math.hypot(dLat * METERS_PER_DEGREE, dLon * METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
}

/** Nearest point on a [lat, lon] polyline, with the distance walked along it to get there. */
function project(points: Array<[number, number]>, lat: number, lon: number) {
  const cos = Math.cos((lat * Math.PI) / 180);
  let best = { distance: Infinity, segment: 0, point: points[0], along: 0 };
  let walked = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [aLat, aLon] = points[i];
    const [bLat, bLon] = points[i + 1];
    const ax = (aLon - lon) * METERS_PER_DEGREE * cos;
    const ay = (aLat - lat) * METERS_PER_DEGREE;
    const dx = (bLon - aLon) * METERS_PER_DEGREE * cos;
    const dy = (bLat - aLat) * METERS_PER_DEGREE;
    const lengthSq = dx * dx + dy * dy;
    const length = Math.sqrt(lengthSq);
    const t = lengthSq ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq)) : 0;
    const distance = Math.hypot(ax + t * dx, ay + t * dy);
    if (distance < best.distance) {
      best = { distance, segment: i, point: [aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t], along: walked + length * t };
    }
    walked += length;
  }
  return { ...best, length: walked };
}

export function snapToNetwork(city: CityData, fix: DeviceFix, scenario: Omit<RouteInput, 'origin'>): SnapResult {
  const empty = { originNode: null, streetName: '', snapped: null, distanceToStreetM: 0, accessM: 0, accessSeconds: 0, accessPath: [] };
  const outside = distanceToDistrictM(city, fix.lat, fix.lon);
  if (outside > DISTRICT_MARGIN_M) return { ...empty, status: 'outside', distanceToDistrictM: outside };
  if (!Number.isFinite(fix.accuracy) || fix.accuracy > MAX_ACCURACY_M) return { ...empty, status: 'imprecise', distanceToDistrictM: 0 };

  const index = networkIndex(city);
  const row = Math.floor(fix.lat / CELL_DEGREES);
  const col = Math.floor(fix.lon / CELL_DEGREES);
  const reach = Math.ceil(SEARCH_RADIUS_M / (CELL_DEGREES * METERS_PER_DEGREE * 0.86));
  const seen = new Set<EdgeData>();
  let best: { edge: EdgeData; points: Array<[number, number]>; hit: ReturnType<typeof project>; score: number } | null = null;
  for (let dr = -reach; dr <= reach; dr += 1) {
    for (let dc = -reach; dc <= reach; dc += 1) {
      for (const edge of index.cells.get(`${row + dr}:${col + dc}`) ?? []) {
        if (seen.has(edge)) continue;
        seen.add(edge);
        const points = edgePoints(index.nodes, edge.source, edge.target, edge);
        const hit = project(points, fix.lat, fix.lon);
        const deck = index.nodes.get(edge.source)?.elevated && index.nodes.get(edge.target)?.elevated;
        const score = hit.distance + (deck ? BRIDGE_DECK_PENALTY_M : 0);
        if (!best || score < best.score) best = { edge, points, hit, score };
      }
    }
  }
  if (!best || best.hit.distance > SEARCH_RADIUS_M) {
    return { ...empty, status: 'unreachable', distanceToDistrictM: 0 };
  }

  const { edge, points, hit } = best;
  const mode = TRAVEL_MODES[scenario.travelMode] ?? TRAVEL_MODES.vehicle;
  const flooded = floodedNodeIds(city, scenario.floodLevel);
  const core = mode.directed ? vehicleCore(city) : null;
  // A driver on a one-way street can only continue toward its downstream end.
  const ends = mode.directed ? allowedArcs(edge.source, edge.target, edge).map(([, to]) => to) : [edge.source, edge.target];
  const mph = Math.max(1, mode.mph(edge.speed_limit_mph));

  const candidates = Array.from(new Set(ends))
    .filter((id) => !flooded.has(id) && (!core || core.has(id)))
    .map((id) => {
      const towardTarget = id === edge.target;
      const accessM = towardTarget ? hit.length - hit.along : hit.along;
      const accessSeconds = (accessM * 2.23694) / mph;
      const route = solveRoute(city, { ...scenario, origin: id });
      const along = towardTarget ? points.slice(hit.segment + 1) : points.slice(0, hit.segment + 1).reverse();
      return { id, accessM, accessSeconds, score: route.success ? accessSeconds + route.eta_minutes * 60 : Infinity, path: [hit.point, ...along] };
    })
    .sort((a, b) => a.score - b.score || a.accessM - b.accessM);

  if (candidates.length) {
    const chosen = candidates[0];
    return {
      status: 'snapped',
      distanceToDistrictM: 0,
      originNode: chosen.id,
      streetName: displayName(edge),
      snapped: { lat: hit.point[0], lon: hit.point[1] },
      distanceToStreetM: hit.distance,
      accessM: chosen.accessM,
      accessSeconds: chosen.accessSeconds,
      accessPath: [[fix.lat, fix.lon], ...chosen.path],
    };
  }

  // Both ends of the nearest street are under water or one-way dead ends:
  // start from the nearest junction that is dry and (for vehicles) drivable.
  let node: NodeData | null = null;
  let fallbackDistance = SEARCH_RADIUS_M;
  const cos = Math.cos((fix.lat * Math.PI) / 180);
  for (const candidate of index.nodes.values()) {
    if (flooded.has(candidate.id) || (core && !core.has(candidate.id)) || candidate.elevated) continue;
    const distance = Math.hypot((candidate.lat - fix.lat) * METERS_PER_DEGREE, (candidate.lon - fix.lon) * METERS_PER_DEGREE * cos);
    if (distance < fallbackDistance) {
      node = candidate;
      fallbackDistance = distance;
    }
  }
  if (!node) return { ...empty, status: 'unreachable', distanceToDistrictM: 0 };
  const start = node;
  // Name the approach after a street that meets the junction, not a placeholder id.
  const street = city.edges.find((item) => (item.source === start.id || item.target === start.id) && item.road_name !== 'Unnamed street');
  return {
    status: 'snapped',
    distanceToDistrictM: 0,
    originNode: node.id,
    streetName: street ? displayName(street) : node.intersection_name,
    snapped: { lat: node.lat, lon: node.lon },
    distanceToStreetM: fallbackDistance,
    accessM: fallbackDistance,
    accessSeconds: (fallbackDistance * 2.23694) / 3.1,
    accessPath: [[fix.lat, fix.lon], [node.lat, node.lon]],
  };
}
