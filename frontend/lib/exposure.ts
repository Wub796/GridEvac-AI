/**
 * Exposure summary: what the current scenario puts under water or in the
 * dark, estimated from the baked OpenStreetMap building footprints and the
 * terrain grid. Every figure is an estimate and the UI labels it as one.
 */
import { floodStage, waterSurfaceM } from './solver';
import { sample, type TerrainGrid } from './terrain';
import type { CityData, NodeData, RouteResponse, ShelterData } from './types';

/** Assumed daytime occupancy for downtown office and civic floor space. */
export const SQ_M_PER_OCCUPANT = 25;
const STOREY_HEIGHT_M = 3.5;

export interface ExposureSummary {
  buildings: number;
  buildingsFlooded: number;
  buildingsDark: number;
  floorAreaFloodedM2: number;
  occupantsFlooded: number;
  occupantsDark: number;
  floodedAreaKm2: number;
  maxDepthM: number;
  shelters: Array<{ shelter: ShelterData; flooded: boolean; dark: boolean }>;
  shelterCapacity: number;
  shelterCapacityUsable: number;
}

const indexes = new WeakMap<CityData, { cells: Map<string, NodeData[]>; size: number }>();

function nodeIndex(city: CityData) {
  let index = indexes.get(city);
  if (!index) {
    const size = 0.0015;
    const cells = new Map<string, NodeData[]>();
    city.nodes.forEach((node) => {
      const key = `${Math.floor(node.lat / size)}:${Math.floor(node.lon / size)}`;
      const list = cells.get(key);
      if (list) list.push(node); else cells.set(key, [node]);
    });
    index = { cells, size };
    indexes.set(city, index);
  }
  return index;
}

export function nearestNode(city: CityData, lat: number, lon: number): NodeData | null {
  const { cells, size } = nodeIndex(city);
  const row = Math.floor(lat / size);
  const col = Math.floor(lon / size);
  let best: NodeData | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      (cells.get(`${row + dr}:${col + dc}`) ?? []).forEach((node) => {
        const distance = (node.lat - lat) ** 2 + ((node.lon - lon) * 0.868) ** 2;
        if (distance < bestDistance) { best = node; bestDistance = distance; }
      });
    }
  }
  return best;
}

function footprintArea(points: [number, number][]) {
  if (points.length < 3) return 0;
  const lat0 = (points.reduce((sum, [lat]) => sum + lat, 0) / points.length) * Math.PI / 180;
  let area = 0;
  points.forEach(([lat, lon], index) => {
    const [lat2, lon2] = points[(index + 1) % points.length];
    area += lon * 111320 * Math.cos(lat0) * lat2 * 111320 - lon2 * 111320 * Math.cos(lat0) * lat * 111320;
  });
  return Math.abs(area) / 2;
}

export function computeExposure(city: CityData, terrain: TerrainGrid | null, route: RouteResponse | null, floodLevel: number): ExposureSummary {
  const surface = waterSurfaceM(city, floodLevel);
  const blackout = new Set(route?.blackout_nodes ?? []);
  let buildingsFlooded = 0;
  let buildingsDark = 0;
  let floorAreaFlooded = 0;
  let occupantsFlooded = 0;
  let occupantsDark = 0;
  let maxDepth = 0;

  city.blocks.forEach((block) => {
    if (block.footprint.length < 3) return;
    const lat = block.footprint.reduce((sum, [value]) => sum + value, 0) / block.footprint.length;
    const lon = block.footprint.reduce((sum, [, value]) => sum + value, 0) / block.footprint.length;
    const nearest = nearestNode(city, lat, lon);
    const stage = terrain ? sample(terrain, terrain.stage, lat, lon) : nearest ? floodStage(nearest) : Number.POSITIVE_INFINITY;
    const floorArea = footprintArea(block.footprint) * Math.max(1, Math.round(block.height_m / STOREY_HEIGHT_M));
    const occupants = floorArea / SQ_M_PER_OCCUPANT;
    if (stage <= surface) {
      buildingsFlooded += 1;
      floorAreaFlooded += floorArea;
      occupantsFlooded += occupants;
      if (terrain) maxDepth = Math.max(maxDepth, surface - sample(terrain, terrain.ground, lat, lon));
    }
    if (nearest && blackout.has(nearest.id)) {
      buildingsDark += 1;
      occupantsDark += occupants;
    }
  });

  // Area and depth count land only: cells already wet at the datum are the
  // bayou channel itself, whose bed would otherwise report as "12 m deep".
  const datum = city.flood_model?.datum_m ?? 0;
  let floodedCells = 0;
  if (terrain) {
    for (let i = 0; i < terrain.stage.length; i += 1) {
      if (terrain.stage[i] <= surface && terrain.stage[i] > datum) {
        floodedCells += 1;
        maxDepth = Math.max(maxDepth, surface - terrain.ground[i]);
      }
    }
  }
  const cellAreaKm2 = terrain ? (terrain.dx * 111.32 * Math.cos((terrain.north * Math.PI) / 180)) * (terrain.dy * 111.32) : 0;

  const nodesById = new Map(city.nodes.map((node) => [node.id, node]));
  const shelters = (city.shelters ?? []).map((shelter) => {
    const node = nodesById.get(shelter.node);
    return { shelter, flooded: node ? floodStage(node) <= surface : false, dark: blackout.has(shelter.node) };
  });

  return {
    buildings: city.blocks.length,
    buildingsFlooded,
    buildingsDark,
    floorAreaFloodedM2: Math.round(floorAreaFlooded),
    occupantsFlooded: Math.round(occupantsFlooded / 10) * 10,
    occupantsDark: Math.round(occupantsDark / 10) * 10,
    floodedAreaKm2: Math.round(floodedCells * cellAreaKm2 * 100) / 100,
    maxDepthM: Math.round(maxDepth * 10) / 10,
    shelters,
    shelterCapacity: shelters.reduce((sum, item) => sum + item.shelter.capacity, 0),
    shelterCapacityUsable: shelters.filter((item) => !item.flooded).reduce((sum, item) => sum + item.shelter.capacity, 0),
  };
}
