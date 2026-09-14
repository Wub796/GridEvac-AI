/**
 * Offline route solver: a line-for-line mirror of backend/routing.py so the
 * workspace gives the same answers when the API is unreachable.
 *
 * Travel time (what a stopwatch reads) and routing cost (time adjusted by
 * road-class preference plus safety penalties) are tracked separately. The
 * solver minimizes cost; ETAs, step durations, and reachability use time.
 */
import type {
  CityData,
  CorridorCapacity,
  CorridorComparisonResponse,
  CorridorInfo,
  EdgeData,
  IsochroneResponse,
  NodeData,
  RiskLevel,
  RouteCoord,
  RouteResponse,
  RouteStep,
  ShelterData,
  TravelMode,
  TriggerPointsResponse,
  TriggerTarget,
} from './types';

/* ------------------------------------------------------------ constants */

const BPR_ALPHA = 0.15;
const BPR_BETA = 4;
const EVACUATION_WINDOW_H = 1;
const VEHICLE_SATURATION_VPHPL: Record<string, number> = { arterial: 1900, collector: 1700, local: 1000, service: 300 };
const PEOPLE_PER_VEHICLE = 2.5;
const PEDESTRIAN_FLOW_PPHPM = 4500;
const WALKWAY_WIDTH_M: Record<string, number> = { arterial: 6, collector: 4, local: 3, service: 1.5 };
const DEAD_LINE_PENALTY_S = 240;
const OVERLOADED_LINE_PENALTY_S = 90;
const FEET_PER_METER = 3.28084;
const CLASS_LABELS: Record<string, string> = { arterial: 'arterial', collector: 'collector', local: 'local street', service: 'service road' };
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

interface ModeConfig {
  mph: (limit: number) => number;
  preference: Record<string, number>;
  floodPenaltyS: number;
  floodDelayS: number;
  blackoutCostMult: number;
  blackoutDelayS: number;
  capacity: 'vehicle' | 'foot';
  directed: boolean;
}

export const TRAVEL_MODES: Record<TravelMode, ModeConfig> = {
  vehicle: { mph: (limit) => Math.min(70, limit), preference: { arterial: 0.94, collector: 1, local: 1, service: 1.35 }, floodPenaltyS: 180, floodDelayS: 40, blackoutCostMult: 4.5, blackoutDelayS: 12, capacity: 'vehicle', directed: true },
  foot: { mph: () => 3.1, preference: { arterial: 1.6, collector: 1.2, local: 1, service: 1 }, floodPenaltyS: 450, floodDelayS: 60, blackoutCostMult: 1.6, blackoutDelayS: 4, capacity: 'foot', directed: false },
  ems: { mph: (limit) => Math.min(65, limit * 1.3), preference: { arterial: 0.8, collector: 0.9, local: 1.05, service: 1.9 }, floodPenaltyS: 240, floodDelayS: 40, blackoutCostMult: 2, blackoutDelayS: 6, capacity: 'vehicle', directed: true },
};

export const ISOCHRONE_MINUTES: Record<TravelMode, number[]> = {
  vehicle: [3, 6, 9, 12],
  foot: [5, 10, 15, 20],
  ems: [2, 4, 6, 8],
};

function modeConfig(mode: TravelMode): ModeConfig {
  return TRAVEL_MODES[mode] ?? TRAVEL_MODES.vehicle;
}

/* ---------------------------------------------------------- flood model */

export function waterSurfaceM(city: Pick<CityData, 'flood_model'> | null | undefined, level: number): number {
  const model = city?.flood_model;
  return (model?.datum_m ?? 0) + level * (model?.rise_per_level_m ?? 1.7);
}

export function levelForWaterSurface(city: Pick<CityData, 'flood_model'> | null | undefined, surface: number): number {
  const model = city?.flood_model;
  return (surface - (model?.datum_m ?? 0)) / (model?.rise_per_level_m ?? 1.7);
}

export function floodStage(node: NodeData): number {
  return node.flood_stage_m ?? node.elevation;
}

export function isNodeFlooded(city: CityData, node: NodeData, level: number): boolean {
  return floodStage(node) <= waterSurfaceM(city, Math.round(level * 100) / 100);
}

export function bprMultiplier(volumePerHour: number, capacityPerHour: number): number {
  if (volumePerHour <= 0) return 1;
  if (capacityPerHour <= 0) return 50;
  return 1 + BPR_ALPHA * (volumePerHour / capacityPerHour) ** BPR_BETA;
}

export const edgeKey = (u: number, v: number) => (u < v ? `${u}-${v}` : `${v}-${u}`);

/* ------------------------------------------------------------- context */

interface Neighbor { to: number; edge: EdgeData }

interface Context {
  nodesById: Map<number, NodeData>;
  edgeByKey: Map<string, EdgeData>;
  /** Edges in networkx iteration order, so ties break the way the API does. */
  graphEdges: Array<[number, number, EdgeData]>;
  arcs: { directed: Map<number, number[]>; undirected: Map<number, number[]> };
  linkEdges: Map<number, Array<[number, number]>>;
  exitNames: Record<string, string>;
  floodCache: Map<number, Set<number>>;
  scenarioCache: Map<string, Scenario>;
}

const contexts = new WeakMap<CityData, Context>();

function context(city: CityData): Context {
  const cached = contexts.get(city);
  if (cached) return cached;
  const nodesById = new Map(city.nodes.map((node) => [node.id, node]));
  const edgeByKey = new Map<string, EdgeData>();
  const neighborOrder = new Map<number, Neighbor[]>();
  city.nodes.forEach((node) => neighborOrder.set(node.id, []));
  city.edges.forEach((edge) => {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) return;
    edgeByKey.set(edgeKey(edge.source, edge.target), edge);
    neighborOrder.get(edge.source)!.push({ to: edge.target, edge });
    neighborOrder.get(edge.target)!.push({ to: edge.source, edge });
  });
  const graphEdges: Array<[number, number, EdgeData]> = [];
  const seen = new Set<number>();
  city.nodes.forEach((node) => {
    neighborOrder.get(node.id)!.forEach(({ to, edge }) => {
      if (!seen.has(to)) graphEdges.push([node.id, to, edge]);
    });
    seen.add(node.id);
  });
  const directed = new Map<number, number[]>();
  const undirected = new Map<number, number[]>();
  const push = (map: Map<number, number[]>, a: number, b: number) => {
    const list = map.get(a);
    if (list) list.push(b); else map.set(a, [b]);
  };
  graphEdges.forEach(([u, v, edge]) => {
    push(undirected, u, v);
    push(undirected, v, u);
    allowedArcs(u, v, edge).forEach(([a, b]) => push(directed, a, b));
  });
  const ctx: Context = {
    nodesById,
    edgeByKey,
    graphEdges,
    arcs: { directed, undirected },
    linkEdges: linkStreetEdges(city, nodesById, graphEdges),
    exitNames: city.exit_names ?? {},
    floodCache: new Map(),
    scenarioCache: new Map(),
  };
  contexts.set(city, ctx);
  return ctx;
}

export function allowedArcs(u: number, v: number, edge: EdgeData): Array<[number, number]> {
  const oneway = edge.oneway ?? 0;
  const target = edge.source === u ? v : u;
  if (oneway === 1) return [[edge.source, target]];
  if (oneway === -1) return [[target, edge.source]];
  return [[u, v], [v, u]];
}

function linkStreetEdges(city: CityData, nodesById: Map<number, NodeData>, graphEdges: Array<[number, number, EdgeData]>) {
  const mapped = new Map<number, Array<[number, number]>>();
  city.transmission_links.forEach((link) => {
    const subA = city.substations.find((sub) => sub.id === link.from_sub);
    const subB = city.substations.find((sub) => sub.id === link.to_sub);
    const a = subA && nodesById.get(subA.node);
    const b = subB && nodesById.get(subB.node);
    if (!a || !b) { mapped.set(link.id, []); return; }
    const lat0 = ((a.lat + b.lat) / 2) * Math.PI / 180;
    const project = (lat: number, lon: number) => [lon * Math.PI / 180 * Math.cos(lat0) * 6371000, lat * Math.PI / 180 * 6371000];
    const [ax, ay] = project(a.lat, a.lon);
    const [bx, by] = project(b.lat, b.lon);
    const lengthSq = (bx - ax) ** 2 + (by - ay) ** 2;
    const under: Array<[number, number]> = [];
    graphEdges.forEach(([u, v]) => {
      const nu = nodesById.get(u)!;
      const nv = nodesById.get(v)!;
      const [px, py] = project((nu.lat + nv.lat) / 2, (nu.lon + nv.lon) / 2);
      let distance: number;
      if (lengthSq === 0) {
        distance = Math.hypot(px - ax, py - ay);
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSq));
        distance = Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
      }
      if (distance <= 90) under.push([u, v]);
    });
    mapped.set(link.id, under);
  });
  return mapped;
}

const cores = new WeakMap<CityData, Set<number>>();

/**
 * Junctions a vehicle can both reach and leave: the largest strongly
 * connected component of the one-way graph (iterative Kosaraju).
 */
export function vehicleCore(city: CityData): Set<number> {
  const cached = cores.get(city);
  if (cached) return cached;
  const forward = context(city).arcs.directed;
  const backward = new Map<number, number[]>();
  forward.forEach((targets, from) => targets.forEach((to) => {
    const list = backward.get(to);
    if (list) list.push(from); else backward.set(to, [from]);
  }));
  const order: number[] = [];
  const visited = new Set<number>();
  city.nodes.forEach(({ id: start }) => {
    if (visited.has(start)) return;
    visited.add(start);
    const stack: Array<[number, number]> = [[start, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const successors = forward.get(top[0]) ?? [];
      if (top[1] < successors.length) {
        const next = successors[top[1]++];
        if (!visited.has(next)) { visited.add(next); stack.push([next, 0]); }
      } else {
        stack.pop();
        order.push(top[0]);
      }
    }
  });
  const assigned = new Set<number>();
  let largest: number[] = [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const start = order[i];
    if (assigned.has(start)) continue;
    assigned.add(start);
    const members = [start];
    const stack = [start];
    while (stack.length) {
      const node = stack.pop()!;
      (backward.get(node) ?? []).forEach((previous) => {
        if (!assigned.has(previous)) { assigned.add(previous); members.push(previous); stack.push(previous); }
      });
    }
    if (members.length > largest.length) largest = members;
  }
  const core = new Set(largest);
  cores.set(city, core);
  return core;
}

export function floodedNodeIds(city: CityData, level: number): Set<number> {
  const ctx = context(city);
  const key = Math.round(level * 100) / 100;
  let flooded = ctx.floodCache.get(key);
  if (!flooded) {
    const surface = waterSurfaceM(city, key);
    flooded = new Set(city.nodes.filter((node) => floodStage(node) <= surface).map((node) => node.id));
    ctx.floodCache.set(key, flooded);
  }
  return flooded;
}

/* ---------------------------------------------------------- power flow */

export function simulatePowerFlow(city: CityData, failedInputs: number[], flooded: Set<number>) {
  const { nodesById } = context(city);
  const manual = new Set(failedInputs);
  const floodedSubs = city.substations.filter((sub) => flooded.has(sub.node) && !manual.has(sub.id)).map((sub) => sub.id).sort((a, b) => a - b);
  const failed = new Set([...manual, ...floodedSubs]);
  const cascaded = new Set<number>();
  const subs = city.substations.map((sub) => ({ ...sub, current: sub.base_load_mw }));

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const active = subs.filter((sub) => !failed.has(sub.id) && !cascaded.has(sub.id));
    const offline = subs.filter((sub) => failed.has(sub.id) || cascaded.has(sub.id));
    active.forEach((sub) => { sub.current = sub.base_load_mw; });
    if (!active.length) break;
    offline.forEach((offlineSub) => {
      const source = nodesById.get(offlineSub.node);
      if (!source) return;
      const weights = active.map((activeSub) => {
        const target = nodesById.get(activeSub.node);
        if (!target) return 0;
        const distance = Math.hypot(source.lat - target.lat, (source.lon - target.lon) * Math.cos(source.lat * Math.PI / 180));
        return 1 / (distance + 0.001);
      });
      const total = weights.reduce((sum, value) => sum + value, 0) || 1;
      active.forEach((activeSub, index) => { activeSub.current += (weights[index] / total) * offlineSub.base_load_mw; });
    });
    let added = false;
    active.forEach((sub) => { if (sub.current > sub.capacity_mw * 1.25) { cascaded.add(sub.id); added = true; } });
    if (!added) break;
  }

  const down = new Set([...failed, ...cascaded]);
  const overloaded: number[] = [];
  const blackout = new Set<number>();
  const loads: Record<number, number> = {};
  let capacity = 0;
  let load = 0;
  subs.forEach((sub) => {
    if (down.has(sub.id)) {
      loads[sub.id] = 0;
      sub.affected_nodes.forEach((id) => blackout.add(id));
      return;
    }
    loads[sub.id] = Number(sub.current.toFixed(1));
    capacity += sub.capacity_mw;
    load += sub.current;
    if (sub.current > sub.capacity_mw) {
      overloaded.push(sub.id);
      const radiusMeters = sub.radius * 150 * (1 + 0.6 * ((sub.current - sub.capacity_mw) / sub.capacity_mw));
      const center = nodesById.get(sub.node);
      if (center) {
        city.nodes.forEach((node) => {
          const distance = Math.hypot(node.lat - center.lat, (node.lon - center.lon) * Math.cos(center.lat * Math.PI / 180));
          if (distance * 111320 <= radiusMeters) blackout.add(node.id);
        });
      }
    }
  });

  let frequency = 0;
  if (capacity) {
    const ratio = load / capacity;
    frequency = Math.max(45, Math.min(60.05, 60 - (ratio > 1 ? 1.4 * (ratio - 1) : 0.06 * down.size)));
  }
  const voltages: Record<number, number> = {};
  city.nodes.forEach((node) => {
    if (blackout.has(node.id)) { voltages[node.id] = 0; return; }
    let voltage = 100;
    overloaded.forEach((subId) => {
      const sub = subs.find((item) => item.id === subId)!;
      const center = nodesById.get(sub.node);
      if (!center) return;
      const distance = Math.hypot(node.lat - center.lat, (node.lon - center.lon) * Math.cos(center.lat * Math.PI / 180));
      const radiusDeg = sub.radius * 1.5 * 150 / 111320;
      if (distance <= radiusDeg) voltage -= Math.max(0, 22 * ((sub.current - sub.capacity_mw) / sub.capacity_mw) * (1 - distance / radiusDeg));
    });
    voltages[node.id] = Number(Math.max(40, Math.min(100, voltage)).toFixed(1));
  });
  const lineStates: Record<number, string> = {};
  city.transmission_links.forEach((link) => {
    lineStates[link.id] = down.has(link.from_sub) || down.has(link.to_sub)
      ? 'dead'
      : overloaded.includes(link.from_sub) || overloaded.includes(link.to_sub) ? 'overloaded' : 'active';
  });
  return {
    substation_loads: loads,
    overloaded_substations: overloaded,
    cascaded_substations: Array.from(cascaded).sort((a, b) => a - b),
    flooded_substations: floodedSubs,
    offline_substations: Array.from(down).sort((a, b) => a - b),
    blackout_nodes: blackout,
    voltage_readings: voltages,
    grid_frequency: Number(frequency.toFixed(2)),
    transmission_line_states: lineStates,
  };
}

type PowerFlow = ReturnType<typeof simulatePowerFlow>;

/* ------------------------------------------------------ weighted graph */

interface Arc { to: number; time: number; cost: number; edge: EdgeData }

interface Scenario {
  flooded: Set<number>;
  flow: PowerFlow;
  mode: ModeConfig;
  adjacency: Map<number, Arc[]>;
  blockedEdges: Array<[number, number]>;
  closedEdges: Array<[number, number]>;
  deadEdges: Set<string>;
  waterSurface: number;
}

export interface ScenarioInput {
  floodLevel: number;
  failedSubstations: number[];
  travelMode: TravelMode;
  closures: Array<[number, number]>;
}

function scenario(city: CityData, input: ScenarioInput): Scenario {
  const ctx = context(city);
  const closures = new Set(input.closures.filter(([u, v]) => ctx.edgeByKey.has(edgeKey(u, v))).map(([u, v]) => edgeKey(u, v)));
  const cacheKey = [input.floodLevel.toFixed(2), [...input.failedSubstations].sort().join(','), input.travelMode, [...closures].sort().join(',')].join('|');
  const cached = ctx.scenarioCache.get(cacheKey);
  if (cached) return cached;

  const flooded = floodedNodeIds(city, input.floodLevel);
  const flow = simulatePowerFlow(city, input.failedSubstations, flooded);
  const mode = modeConfig(input.travelMode);
  const deadEdges = new Set<string>();
  const overloadedEdges = new Set<string>();
  Object.entries(flow.transmission_line_states).forEach(([linkId, state]) => {
    const target = state === 'dead' ? deadEdges : state === 'overloaded' ? overloadedEdges : null;
    ctx.linkEdges.get(Number(linkId))?.forEach(([u, v]) => target?.add(edgeKey(u, v)));
  });

  const adjacency = new Map<number, Arc[]>();
  const blockedEdges: Array<[number, number]> = [];
  const closedEdges: Array<[number, number]> = [];
  const addArc = (from: number, arc: Arc) => {
    const list = adjacency.get(from);
    if (list) list.push(arc); else adjacency.set(from, [arc]);
  };
  ctx.graphEdges.forEach(([u, v, edge]) => {
    const key = edgeKey(u, v);
    if (closures.has(key)) { closedEdges.push([u, v]); return; }
    if (flooded.has(u) && flooded.has(v)) { blockedEdges.push([u, v]); return; }
    let time = edge.distance_m * 2.23694 / Math.max(1, mode.mph(edge.speed_limit_mph));
    let cost = time * (mode.preference[edge.road_class] ?? 1);
    if (flooded.has(u) || flooded.has(v)) { time += mode.floodDelayS; cost += mode.floodPenaltyS; }
    if (flow.blackout_nodes.has(u) || flow.blackout_nodes.has(v)) { time += mode.blackoutDelayS; cost *= mode.blackoutCostMult; }
    if (deadEdges.has(key)) cost += DEAD_LINE_PENALTY_S;
    else if (overloadedEdges.has(key)) cost += OVERLOADED_LINE_PENALTY_S;
    const arcs: Array<[number, number]> = mode.directed ? allowedArcs(u, v, edge) : [[u, v], [v, u]];
    arcs.forEach(([a, b]) => addArc(a, { to: b, time, cost, edge }));
  });

  const result: Scenario = {
    flooded,
    flow,
    mode,
    adjacency,
    blockedEdges,
    closedEdges,
    deadEdges,
    waterSurface: Number(waterSurfaceM(city, Math.round(input.floodLevel * 100) / 100).toFixed(2)),
  };
  // Route, corridor ranking, and reachability solve the same scenario back to back.
  if (ctx.scenarioCache.size >= 6) ctx.scenarioCache.delete(ctx.scenarioCache.keys().next().value as string);
  ctx.scenarioCache.set(cacheKey, result);
  return result;
}

/* ------------------------------------------------------------ dijkstra */

class Heap<T> {
  private items: Array<{ key: number; order: number; value: T }> = [];
  private counter = 0;
  constructor(private readonly less: (a: { key: number; order: number }, b: { key: number; order: number }) => boolean) {}
  get size() { return this.items.length; }
  push(key: number, value: T) {
    const items = this.items;
    items.push({ key, order: this.counter++, value });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(items[i], items[parent])) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let best = i;
        if (left < items.length && this.less(items[left], items[best])) best = left;
        if (right < items.length && this.less(items[right], items[best])) best = right;
        if (best === i) break;
        [items[best], items[i]] = [items[i], items[best]];
        i = best;
      }
    }
    return top;
  }
}

const minFirst = (a: { key: number; order: number }, b: { key: number; order: number }) => a.key < b.key || (a.key === b.key && a.order < b.order);

function dijkstra(adjacency: Map<number, Arc[]>, origin: number, weight: 'cost' | 'time', cutoff = Number.POSITIVE_INFINITY) {
  const distances = new Map<number, number>();
  const previous = new Map<number, number>();
  const tentative = new Map<number, number>([[origin, 0]]);
  const heap = new Heap<number>(minFirst);
  heap.push(0, origin);
  while (heap.size) {
    const { key: distance, value: node } = heap.pop();
    if (distances.has(node)) continue;
    distances.set(node, distance);
    for (const arc of adjacency.get(node) ?? []) {
      const candidate = distance + arc[weight];
      if (candidate > cutoff) continue;
      if (distances.has(arc.to)) continue;
      const known = tentative.get(arc.to);
      if (known === undefined || candidate < known) {
        tentative.set(arc.to, candidate);
        previous.set(arc.to, node);
        heap.push(candidate, arc.to);
      }
    }
  }
  return { distances, previous };
}

function pathTo(previous: Map<number, number>, origin: number, target: number): number[] {
  const path = [target];
  let cursor = target;
  while (cursor !== origin) {
    const parent = previous.get(cursor);
    if (parent === undefined) return [];
    path.push(parent);
    cursor = parent;
  }
  return path.reverse();
}

function arcBetween(sc: Scenario, u: number, v: number): Arc | undefined {
  return sc.adjacency.get(u)?.find((arc) => arc.to === v);
}

/* ------------------------------------------------------------ geometry */

export function displayName(edge: Pick<EdgeData, 'road_name' | 'road_class'>): string {
  const name = edge.road_name || 'Unnamed street';
  return name !== 'Unnamed street' ? name : `unnamed ${CLASS_LABELS[edge.road_class] ?? 'street'}`;
}

/** Curve points u -> v, reversing baked geometry when traversed backwards. */
export function edgePoints(nodesById: Map<number, NodeData>, u: number, v: number, edge: EdgeData): Array<[number, number]> {
  const geometry = (edge.geometry ?? []).map((point) => [point[0], point[1]] as [number, number]);
  if (edge.source !== u) geometry.reverse();
  const a = nodesById.get(u)!;
  const b = nodesById.get(v)!;
  return [[a.lat, a.lon], ...geometry, [b.lat, b.lon]];
}

function planar(a: [number, number], b: [number, number]): [number, number] {
  const cosLat = Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
  return [(b[1] - a[1]) * 111320 * cosLat, (b[0] - a[0]) * 111320];
}

function heading(a: [number, number], b: [number, number]) {
  const [dx, dy] = planar(a, b);
  return ((Math.atan2(dx, dy) * 180 / Math.PI) % 360 + 360) % 360;
}

function headingLeaving(points: Array<[number, number]>, reach = 12) {
  for (const point of points.slice(1)) if (Math.hypot(...planar(points[0], point)) >= reach) return heading(points[0], point);
  return heading(points[0], points[points.length - 1]);
}

function headingArriving(points: Array<[number, number]>, reach = 12) {
  const last = points[points.length - 1];
  for (const point of points.slice(0, -1).reverse()) if (Math.hypot(...planar(point, last)) >= reach) return heading(point, last);
  return heading(points[0], last);
}

function maneuver(turn: number): [string, string] {
  const side = turn > 0 ? 'right' : 'left';
  const angle = Math.abs(turn);
  if (angle < 20) return ['continue', 'Continue onto'];
  if (angle < 45) return [`slight-${side}`, `Bear ${side} onto`];
  if (angle < 135) return [`turn-${side}`, `Turn ${side} onto`];
  if (angle < 165) return [`sharp-${side}`, `Turn sharp ${side} onto`];
  return ['uturn', 'Make a U-turn onto'];
}

function buildRouteSteps(city: CityData, sc: Scenario, path: number[]): RouteStep[] {
  const { nodesById } = context(city);
  const steps: RouteStep[] = [];
  let arriving: number | null = null;
  path.slice(0, -1).forEach((from, index) => {
    const to = path[index + 1];
    const arc = arcBetween(sc, from, to)!;
    const points = edgePoints(nodesById, from, to, arc.edge);
    const name = displayName(arc.edge);
    const leaving = headingLeaving(points);
    const current = steps[steps.length - 1];
    if (current && current.road_name === name) {
      current.distance_m += arc.edge.distance_m;
      current.duration_s += arc.time;
      current.to_node = to;
    } else {
      let id = 'depart';
      let instruction = `Head ${COMPASS[Math.floor((leaving + 22.5) / 45) % 8]} on ${name}`;
      if (current) {
        const turn = ((leaving - (arriving ?? leaving) + 540) % 360) - 180;
        const [maneuverId, verb] = maneuver(turn);
        id = maneuverId;
        instruction = `${verb} ${name}`;
      }
      steps.push({
        instruction,
        road_name: name,
        road_class: arc.edge.road_class,
        distance_m: arc.edge.distance_m,
        duration_s: arc.time,
        from_node: from,
        to_node: to,
        maneuver: id,
        bearing: Math.round(leaving) % 360,
      });
    }
    arriving = headingArriving(points);
  });
  return steps.map((step) => ({ ...step, distance_m: round(step.distance_m, 1), duration_s: round(step.duration_s, 1) }));
}

function pathCoords(city: CityData, sc: Scenario, path: number[]): RouteCoord[] {
  const { nodesById } = context(city);
  const coords: RouteCoord[] = [];
  path.slice(0, -1).forEach((from, index) => {
    const to = path[index + 1];
    const points = edgePoints(nodesById, from, to, arcBetween(sc, from, to)!.edge);
    const start = nodesById.get(from)!.elevation;
    const end = nodesById.get(to)!.elevation;
    points.slice(0, -1).forEach(([lat, lon], i) => {
      const t = i / Math.max(1, points.length - 1);
      coords.push({ lat, lon, elevation: round(start + (end - start) * t, 2) });
    });
  });
  const last = nodesById.get(path[path.length - 1]);
  if (last) coords.push({ lat: last.lat, lon: last.lon, elevation: round(last.elevation, 2) });
  return coords;
}

/* ------------------------------------------------------------ capacity */

function edgeCapacityPph(edge: EdgeData, mode: ModeConfig) {
  if (mode.capacity === 'foot') return (WALKWAY_WIDTH_M[edge.road_class] ?? 3) * PEDESTRIAN_FLOW_PPHPM;
  return Math.max(1, Math.trunc(edge.lanes || 2)) * (VEHICLE_SATURATION_VPHPL[edge.road_class] ?? 1000) * PEOPLE_PER_VEHICLE;
}

function corridorCapacity(sc: Scenario, path: number[]): CorridorCapacity {
  if (path.length < 2) return { people_per_hour: 0, clearance_minutes: 0, limiting_road: '-' };
  let bottleneck: [number, string] | null = null;
  path.slice(0, -1).forEach((from, index) => {
    const edge = arcBetween(sc, from, path[index + 1])!.edge;
    const perHour = edgeCapacityPph(edge, sc.mode);
    if (!bottleneck || perHour < bottleneck[0]) bottleneck = [perHour, displayName(edge)];
  });
  const [pph, road] = bottleneck as unknown as [number, string];
  return { people_per_hour: Math.trunc(pph), clearance_minutes: 0, limiting_road: road };
}

function districtThroughput(sc: Scenario, previous: Map<number, number>, origin: number, dryExits: number[], reached: Map<number, number>) {
  return dryExits.reduce((sum, exit) => {
    if (!reached.has(exit)) return sum;
    const path = pathTo(previous, origin, exit);
    return path.length >= 2 ? sum + corridorCapacity(sc, path).people_per_hour : sum;
  }, 0);
}

const pathSum = (sc: Scenario, path: number[], pick: (arc: Arc) => number) =>
  path.slice(0, -1).reduce((sum, from, index) => sum + pick(arcBetween(sc, from, path[index + 1])!), 0);

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* ---------------------------------------------------------------- risk */

/** Mirror of backend/anomaly.py rule_severity: the offline risk band. */
export function ruleSeverity(floodedFraction: number, offlineSubstations: number, overloadedSubstations: number, cascadeProbability: number): number {
  let score = 0.05;
  if (floodedFraction >= 0.25) score = Math.max(score, 0.82);
  else if (floodedFraction >= 0.1) score = Math.max(score, 0.62);
  else if (floodedFraction >= 0.02) score = Math.max(score, 0.36);
  if (offlineSubstations >= 3) score = Math.max(score, 0.8);
  else if (offlineSubstations === 2) score = Math.max(score, 0.6);
  else if (offlineSubstations === 1) score = Math.max(score, 0.34);
  if (overloadedSubstations >= 2) score = Math.max(score, 0.62);
  else if (overloadedSubstations === 1) score = Math.max(score, 0.36);
  if (cascadeProbability > 0.4) score = Math.max(score, 0.88);
  return score;
}

export function riskLevel(score: number): RiskLevel {
  return score < 0.3 ? 'LOW' : score < 0.55 ? 'MEDIUM' : score < 0.78 ? 'HIGH' : 'CRITICAL';
}

/* --------------------------------------------------------------- route */

export interface RouteInput extends ScenarioInput {
  origin: number;
  evacuees: number;
  destination: string | null;
}

export function solveRoute(city: CityData, input: RouteInput): RouteResponse {
  const ctx = context(city);
  const sc = scenario(city, input);
  const offlineCount = sc.flow.offline_substations.length;
  const anomaly = round(ruleSeverity(sc.flooded.size / Math.max(1, city.nodes.length), offlineCount, sc.flow.overloaded_substations.length, 0), 4);
  const risk = riskLevel(anomaly);
  const hazardRoads: Record<string, string> = {};
  Object.entries(sc.flow.transmission_line_states).forEach(([linkId, state]) => {
    if (state === 'dead' || state === 'overloaded') ctx.linkEdges.get(Number(linkId))?.forEach(([u, v]) => { hazardRoads[`${u}-${v}`] = state; });
  });
  const base = {
    flooded_nodes: Array.from(sc.flooded).sort((a, b) => a - b),
    blackout_nodes: Array.from(sc.flow.blackout_nodes).sort((a, b) => a - b),
    blocked_edges: sc.blockedEdges,
    closed_edges: sc.closedEdges,
    substation_loads: sc.flow.substation_loads,
    overloaded_substations: sc.flow.overloaded_substations,
    cascaded_substations: sc.flow.cascaded_substations,
    flooded_substations: sc.flow.flooded_substations,
    grid_frequency: sc.flow.grid_frequency,
    voltage_readings: sc.flow.voltage_readings,
    transmission_line_states: sc.flow.transmission_line_states,
    water_surface_m: sc.waterSurface,
    usgs_gage_height: round(sc.waterSurface * FEET_PER_METER, 2),
    surface_temp: round(85 - input.floodLevel * 0.8 - offlineCount * 0.45, 1),
    hazard_roads: hazardRoads,
    anomaly_score: anomaly,
    risk_level: risk,
  };
  const failure = (message: string): RouteResponse => ({
    ...base,
    success: false,
    path: [],
    path_coords: [],
    total_nodes: 0,
    distance_m: 0,
    eta_minutes: 0,
    route_steps: [],
    message,
    dest_node: -1,
    congested_eta_minutes: 0,
    congestion_factor: 1,
    destination_name: '',
    destination_kind: '',
    risk_level: 'CRITICAL',
    anomaly_score: Math.max(anomaly, 0.78),
  });

  if (!ctx.nodesById.has(input.origin)) return failure('Origin intersection is outside the operations district.');
  if (sc.flooded.has(input.origin)) return failure('Starting intersection is flooded. Select a dry origin on higher ground.');
  let shelter: ShelterData | null = null;
  if (input.destination) {
    shelter = city.shelters?.find((item) => item.id === input.destination) ?? null;
    if (!shelter) return failure(`Destination "${input.destination}" is not a known shelter or medical facility.`);
    if (sc.flooded.has(shelter.node)) return failure(`No passable route to ${shelter.name}: its street approach is flooded.`);
  }

  const { distances, previous } = dijkstra(sc.adjacency, input.origin, 'cost');
  const dryExits = city.safe_exits.filter((exit) => ctx.nodesById.has(exit) && !sc.flooded.has(exit));
  let bestExit = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  if (shelter) {
    if (distances.has(shelter.node)) { bestExit = shelter.node; bestCost = distances.get(shelter.node)!; }
  } else {
    dryExits.forEach((exit) => {
      const cost = distances.get(exit);
      if (cost !== undefined && cost < bestCost) { bestExit = exit; bestCost = cost; }
    });
  }
  if (bestExit < 0) {
    if (sc.mode.directed && !vehicleCore(city).has(input.origin)) {
      return failure('This junction sits in a one-way pocket (a ramp, garage, or loop) with no legal vehicle path out. Start from a nearby through street, or switch to on-foot routing.');
    }
    return failure(`No passable route to ${shelter ? shelter.name : 'any dry perimeter exit'}. Floodwater, closures, and utility hazards have isolated this start point.`);
  }

  const path = pathTo(previous, input.origin, bestExit);
  const steps = buildRouteSteps(city, sc, path);
  const etaMinutes = pathSum(sc, path, (arc) => arc.time) / 60;
  const capacity = corridorCapacity(sc, path);
  const throughput = districtThroughput(sc, previous, input.origin, dryExits, distances);
  const factor = bprMultiplier(input.evacuees / EVACUATION_WINDOW_H, throughput);
  if (input.evacuees > 0 && throughput > 0) capacity.clearance_minutes = round(input.evacuees / throughput * 60, 1);
  const node = ctx.nodesById.get(bestExit)!;
  const label = shelter
    ? shelter.name
    : `${ctx.exitNames[String(bestExit)] ?? 'Exit'} (${node.intersection_name || `Node ${bestExit}`})`;

  return {
    ...base,
    success: true,
    path,
    path_coords: pathCoords(city, sc, path),
    total_nodes: path.length,
    distance_m: round(pathSum(sc, path, (arc) => arc.edge.distance_m), 1),
    eta_minutes: round(etaMinutes, 1),
    route_steps: steps,
    corridor_capacity: capacity,
    congested_eta_minutes: round(etaMinutes * factor, 1),
    congestion_factor: round(factor, 3),
    destination_name: shelter?.name ?? '',
    destination_kind: shelter ? (shelter.kind === 'medical' ? 'medical' : 'shelter') : '',
    message: `Safest street corridor mapped to ${label} in ${steps.length} road segments.`,
    dest_node: bestExit,
  };
}

/* ----------------------------------------------------------- corridors */

export function compareCorridors(city: CityData, input: RouteInput): CorridorComparisonResponse {
  const ctx = context(city);
  const sc = scenario(city, input);
  const corridors: CorridorInfo[] = [];
  if (ctx.nodesById.has(input.origin) && !sc.flooded.has(input.origin)) {
    const { distances, previous } = dijkstra(sc.adjacency, input.origin, 'cost');
    city.safe_exits.filter((exit) => ctx.nodesById.has(exit) && !sc.flooded.has(exit)).forEach((exit) => {
      const cost = distances.get(exit);
      if (cost === undefined) return;
      const path = pathTo(previous, input.origin, exit);
      const hazards = path.slice(0, -1).filter((u, index) => {
        const v = path[index + 1];
        return sc.deadEdges.has(edgeKey(u, v)) || sc.flow.blackout_nodes.has(u) || sc.flow.blackout_nodes.has(v) || sc.flooded.has(u) || sc.flooded.has(v);
      }).length;
      corridors.push({
        exit_node: exit,
        exit_name: `${ctx.exitNames[String(exit)] ?? 'Exit'} at ${ctx.nodesById.get(exit)!.intersection_name || `node ${exit}`}`,
        eta_minutes: round(pathSum(sc, path, (arc) => arc.time) / 60, 1),
        cost_minutes: round(cost / 60, 1),
        distance_m: round(pathSum(sc, path, (arc) => arc.edge.distance_m), 1),
        hazard_count: hazards,
        path_length: path.length,
        people_per_hour: corridorCapacity(sc, path).people_per_hour,
        congested_eta_minutes: 0,
      });
    });
  }
  corridors.sort((a, b) => a.cost_minutes - b.cost_minutes || a.eta_minutes - b.eta_minutes);
  const factor = bprMultiplier(input.evacuees / EVACUATION_WINDOW_H, corridors.reduce((sum, corridor) => sum + corridor.people_per_hour, 0));
  corridors.forEach((corridor) => { corridor.congested_eta_minutes = round(corridor.eta_minutes * factor, 1); });
  return {
    origin: input.origin,
    travel_mode: input.travelMode,
    corridors,
    flooded_nodes: Array.from(sc.flooded).sort((a, b) => a - b),
    blackout_nodes: Array.from(sc.flow.blackout_nodes).sort((a, b) => a - b),
  };
}

/* ----------------------------------------------------------- isochrone */

export function solveIsochrone(city: CityData, input: RouteInput & { minutes: number[] }): IsochroneResponse {
  const ctx = context(city);
  const sc = scenario(city, input);
  const minutes = (input.minutes.length ? input.minutes : ISOCHRONE_MINUTES[input.travelMode]).slice().sort((a, b) => a - b);
  const flooded = Array.from(sc.flooded).sort((a, b) => a - b);
  const blackout = Array.from(sc.flow.blackout_nodes).sort((a, b) => a - b);
  if (!ctx.nodesById.has(input.origin) || sc.flooded.has(input.origin)) {
    return { origin: input.origin, travel_mode: input.travelMode, rings: [], flooded_nodes: flooded, blackout_nodes: blackout, congestion_factor: 1 };
  }
  const dryExits = city.safe_exits.filter((exit) => ctx.nodesById.has(exit) && !sc.flooded.has(exit));
  const byCost = dijkstra(sc.adjacency, input.origin, 'cost');
  const factor = bprMultiplier(input.evacuees / EVACUATION_WINDOW_H, districtThroughput(sc, byCost.previous, input.origin, dryExits, byCost.distances));
  const limits = minutes.map((m) => m * 60 / factor);
  const reach = dijkstra(sc.adjacency, input.origin, 'time', Math.max(...limits)).distances;
  const rings = minutes.map((label, index) => {
    const nodes = Array.from(reach.entries()).filter(([, seconds]) => seconds <= limits[index]).map(([id]) => id).sort((a, b) => a - b);
    return { minutes: round(label, 1), node_count: nodes.length, nodes };
  });
  return { origin: input.origin, travel_mode: input.travelMode, rings, flooded_nodes: flooded, blackout_nodes: blackout, congestion_factor: round(factor, 2) };
}

/* ------------------------------------------------------ trigger points */

export function solveTriggerPoints(city: CityData, origin: number, travelMode: TravelMode, closuresInput: Array<[number, number]>): TriggerPointsResponse {
  const ctx = context(city);
  const node = ctx.nodesById.get(origin);
  if (!node) return { origin, origin_stage_m: 0, origin_level: 0, targets: [] };
  const closures = new Set(closuresInput.map(([u, v]) => edgeKey(u, v)));
  const adjacency = modeConfig(travelMode).directed ? ctx.arcs.directed : ctx.arcs.undirected;
  const stage = (id: number) => floodStage(ctx.nodesById.get(id)!);
  const capacity = (u: number, v: number) => Math.max(stage(u), stage(v));

  const best = new Map<number, number>([[origin, Number.POSITIVE_INFINITY]]);
  const previous = new Map<number, number>();
  // Max-heap on bottleneck; equal bottlenecks pop lowest node id first, like Python's tuple heap.
  const heap = new Heap<number>((a, b) => a.key > b.key || (a.key === b.key && a.order < b.order));
  heap.push(Number.POSITIVE_INFINITY, origin);
  while (heap.size) {
    const { key: bottleneck, value: current } = heap.pop();
    if (bottleneck < (best.get(current) ?? Number.NEGATIVE_INFINITY)) continue;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (closures.has(edgeKey(current, neighbor))) continue;
      const candidate = Math.min(bottleneck, capacity(current, neighbor));
      if (candidate > (best.get(neighbor) ?? Number.NEGATIVE_INFINITY)) {
        best.set(neighbor, candidate);
        previous.set(neighbor, current);
        heap.push(candidate, neighbor);
      }
    }
  }

  const originStage = stage(origin);
  const level = (elevation: number) => round(levelForWaterSurface(city, elevation), 2);
  const candidates: Array<[string, string, number, string]> = [
    ...city.safe_exits.filter((exit) => ctx.nodesById.has(exit)).map((exit) => ['exit', String(exit), exit, ctx.exitNames[String(exit)] ?? `Exit ${exit}`] as [string, string, number, string]),
    ...(city.shelters ?? []).filter((shelter) => ctx.nodesById.has(shelter.node)).map((shelter) => [shelter.kind, shelter.id, shelter.node, shelter.name] as [string, string, number, string]),
  ];
  const targets: TriggerTarget[] = [];
  candidates.forEach(([kind, id, target, name]) => {
    const corridor = best.get(target);
    if (corridor === undefined) return;
    let bottleneckRoad = '-';
    let bottleneckNode = target;
    let lowest = Number.POSITIVE_INFINITY;
    let cursor = target;
    while (cursor !== origin && previous.has(cursor)) {
      const parent = previous.get(cursor)!;
      const cap = capacity(parent, cursor);
      if (cap < lowest) {
        lowest = cap;
        bottleneckNode = stage(parent) >= stage(cursor) ? parent : cursor;
        bottleneckRoad = displayName(ctx.edgeByKey.get(edgeKey(parent, cursor))!);
      }
      cursor = parent;
    }
    const targetStage = stage(target);
    const threshold = Math.min(originStage, targetStage, corridor);
    targets.push({
      kind,
      id,
      node: target,
      name,
      threshold_m: round(threshold, 2),
      threshold_level: level(threshold),
      limited_by: threshold === originStage ? 'origin' : threshold === targetStage ? 'destination' : 'corridor',
      bottleneck_road: bottleneckRoad,
      bottleneck_node: bottleneckNode,
      bottleneck_name: ctx.nodesById.get(bottleneckNode)?.intersection_name || `Node ${bottleneckNode}`,
    });
  });
  targets.sort((a, b) => b.threshold_m - a.threshold_m);
  return { origin, origin_stage_m: round(originStage, 2), origin_level: level(originStage), targets };
}
