/**
 * Operator exports: a plain-text situation report laid out after the ICS-201
 * incident briefing, a GeoJSON package for GIS teams (ArcGIS, QGIS), and a
 * CSV of the operator event log for after-action review.
 */
import type { ExposureSummary } from './exposure';
import { edgePoints } from './solver';
import type { CityData, CorridorComparisonResponse, NodeData, RouteResponse, TravelMode, TriggerPointsResponse, TriggerTarget } from './types';
import { toUsng } from './usng';

export interface OperatorEvent {
  id: number;
  at: string;
  kind: 'system' | 'action' | 'result' | 'warning';
  message: string;
}

export interface ExportState {
  cityData: CityData;
  route: RouteResponse | null;
  originNode: number;
  floodLevel: number;
  failedSubstations: number[];
  travelMode: TravelMode;
  evacuees: number;
  destinationId: string | null;
  closures: Array<[number, number]>;
  corridorComparison: CorridorComparisonResponse | null;
  triggerPoints: TriggerPointsResponse | null;
  exposure: ExposureSummary | null;
  events: OperatorEvent[];
  backendOnline: boolean;
  /** Device location summary only; raw coordinates are never exported. */
  userLocation?: { active: boolean; accessM: number; streetName: string; fix: { accuracy: number } } | null;
  scenarioUrl: string;
}

const MODE_LABELS: Record<TravelMode, string> = { vehicle: 'Response vehicle', foot: 'On foot', ems: 'EMS priority' };

/** Houston local time with the correct CST/CDT abbreviation. */
export function centralTime(date: Date | string, withDate = true): string {
  const value = typeof date === 'string' ? new Date(date) : date;
  return value.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    ...(withDate ? { year: 'numeric', month: 'short', day: '2-digit' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: withDate ? undefined : '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
}

export function formatDistance(meters: number): string {
  if (!meters) return '-';
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

const feet = (meters: number) => (meters * 3.28084).toFixed(1);

/** "Sawyer Street near Sawyer Street / Summer Street", without repeating a single-street junction name. */
export function triggerCause(target: TriggerTarget): string {
  const road = target.bottleneck_road;
  const place = target.bottleneck_name;
  return !place || place === road || place.startsWith('Node ') ? road : `${road} near ${place}`;
}

function nodeLine(node: NodeData | undefined, fallback: string) {
  if (!node) return fallback;
  return `${node.intersection_name} (USNG ${toUsng(node.lat, node.lon)})`;
}

export function buildSituationReport(state: ExportState): string {
  const { cityData: city, route } = state;
  const nodes = new Map(city.nodes.map((node) => [node.id, node]));
  const origin = nodes.get(state.originNode);
  const destination = route ? nodes.get(route.dest_node) : undefined;
  const model = city.flood_model;
  const surface = route?.water_surface_m ?? (model ? model.datum_m + state.floodLevel * model.rise_per_level_m : 0);
  const eta = route?.success ? (state.evacuees > 0 ? route.congested_eta_minutes : route.eta_minutes) : 0;
  const substationName = (id: number) => city.substations.find((sub) => sub.id === id)?.name ?? `Substation ${id}`;
  const rule = '-'.repeat(64);
  const lines: string[] = [
    'GRIDEVAC SITUATION REPORT',
    `Prepared ${centralTime(new Date())}`,
    `Operations district: downtown Houston, TX (${city.nodes.length} junctions, ${city.edges.length} street segments)`,
    `Solver: ${state.backendOnline ? 'routing API' : 'local offline solver'}`,
    rule,
    '1. SITUATION',
    `Modeled water surface: ${surface.toFixed(2)} m / ${feet(surface)} ft ${model?.vertical_datum ?? 'NAVD88'} (scenario level ${state.floodLevel.toFixed(1)} of 10)`,
    `Flooded junctions: ${route?.flooded_nodes.length ?? 0}; street segments impassable: ${route?.blocked_edges.length ?? 0}`,
    `Utility status: ${state.failedSubstations.length ? `manual outage at ${state.failedSubstations.map(substationName).join(', ')}` : 'no manual outages'}`
      + (route?.flooded_substations.length ? `; flooded: ${route.flooded_substations.map(substationName).join(', ')}` : '')
      + (route?.cascaded_substations.length ? `; cascade: ${route.cascaded_substations.map(substationName).join(', ')}` : ''),
    `Grid: ${!route ? '-' : route.grid_frequency > 0 ? `${route.grid_frequency.toFixed(2)} Hz` : 'down, no substation in service'}; risk ${route?.risk_level ?? '-'} (score ${route ? route.anomaly_score.toFixed(2) : '-'})`,
    `Operator road closures: ${state.closures.length || 'none'}`,
  ];
  if (state.exposure) {
    const x = state.exposure;
    lines.push(
      `Estimated exposure: ${x.buildingsFlooded} of ${x.buildings} mapped buildings in the flood extent (~${x.occupantsFlooded.toLocaleString()} daytime occupants), ${x.buildingsDark} without power; flooded area ${x.floodedAreaKm2} km², max depth ${x.maxDepthM} m`,
    );
  }
  lines.push(
    rule,
    '2. RECOMMENDATION',
    `Origin: ${nodeLine(origin, `Node ${state.originNode}`)}${state.userLocation?.active
      ? `, set from device location (accuracy ±${Math.round(state.userLocation.fix.accuracy)} m, ${Math.round(state.userLocation.accessM)} m along ${state.userLocation.streetName})`
      : ''}`,
    `Travel mode: ${MODE_LABELS[state.travelMode]}${state.evacuees ? `; evacuating population ${state.evacuees.toLocaleString()}` : ''}`,
  );
  if (route?.success) {
    lines.push(
      `Destination: ${route.destination_name
        ? `${route.destination_name} (${route.destination_kind === 'medical' ? 'medical facility' : 'shelter'}) via ${nodeLine(destination, `Node ${route.dest_node}`)}`
        : `${city.exit_names?.[String(route.dest_node)] ?? 'Exit'} at ${nodeLine(destination, `Node ${route.dest_node}`)}`}`,
      `ETA ${eta.toFixed(1)} min${state.evacuees > 0 ? ` under demand (${route.eta_minutes.toFixed(1)} min free flow, congestion x${route.congestion_factor.toFixed(2)})` : ''} over ${formatDistance(route.distance_m)}`,
      route.corridor_capacity ? `Corridor capacity ${route.corridor_capacity.people_per_hour.toLocaleString()} people/hour, bottleneck ${route.corridor_capacity.limiting_road}${route.corridor_capacity.clearance_minutes ? `, district clearance ~${route.corridor_capacity.clearance_minutes.toFixed(0)} min` : ''}` : '',
      '',
      'Directions:',
      ...route.route_steps.map((step, index) => `  ${String(index + 1).padStart(2, ' ')}. ${step.instruction} - ${formatDistance(step.distance_m)}, ${(step.duration_s / 60).toFixed(1)} min`),
    );
  } else {
    lines.push(`NO PASSABLE CORRIDOR: ${route?.message ?? 'no assessment yet'}`);
  }
  if (state.corridorComparison?.corridors.length) {
    lines.push('', 'Exit corridors (safest first):');
    state.corridorComparison.corridors.forEach((corridor, index) => {
      lines.push(`  ${index + 1}. ${corridor.exit_name}: ${(state.evacuees > 0 ? corridor.congested_eta_minutes : corridor.eta_minutes).toFixed(1)} min, ${formatDistance(corridor.distance_m)}, ${corridor.hazard_count} hazard segment(s)`);
    });
  }
  if (state.triggerPoints?.targets.length) {
    lines.push(rule, '3. TRIGGER POINTS (water surface at which each target is cut off from this origin)');
    state.triggerPoints.targets.forEach((target) => {
      const reason = target.limited_by === 'origin' ? 'origin floods' : target.limited_by === 'destination' ? 'destination approach floods' : `${triggerCause(target)} floods`;
      lines.push(`  ${target.name}: ${target.threshold_m.toFixed(2)} m / ${feet(target.threshold_m)} ft (level ${target.threshold_level.toFixed(1)}) - ${reason}`);
    });
  }
  if (state.exposure?.shelters.length) {
    lines.push(rule, '4. SHELTERS');
    state.exposure.shelters.forEach(({ shelter, flooded, dark }) => {
      lines.push(`  ${shelter.name} (${shelter.kind}, capacity ${shelter.capacity.toLocaleString()}): ${flooded ? 'APPROACH FLOODED' : 'approach dry'}${dark ? ', no grid power' : ''}`);
    });
    lines.push(`  Usable capacity ${state.exposure.shelterCapacityUsable.toLocaleString()} of ${state.exposure.shelterCapacity.toLocaleString()}${state.evacuees > state.exposure.shelterCapacityUsable ? `; SHORTFALL ${(state.evacuees - state.exposure.shelterCapacityUsable).toLocaleString()} people` : ''}`);
  }
  lines.push(
    rule,
    '5. DATA AND LIMITATIONS',
    `Streets, buildings, waterways: OpenStreetMap contributors. Elevation: ${model?.elevation_source || 'baked terrain'}.`,
    `Flood model: ${model?.method || 'bathtub'}. Single water surface; no rainfall ponding, storm-drain backup, or channel slope.`,
    'Utility network and loads are illustrative, not CenterPoint Energy data. Occupancy is an estimate.',
    `Scenario link: ${state.scenarioUrl}`,
    rule,
    '6. RECENT OPERATOR EVENTS',
    ...state.events.slice(0, 12).map((event) => `  ${centralTime(event.at, false)}  ${event.message}`),
  );
  return lines.filter((line) => line !== '').join('\n').replace(/\n(Directions:|Alternate exits)/g, '\n\n$1');
}

export function buildGeoJson(state: ExportState) {
  const { cityData: city, route } = state;
  const nodes = new Map(city.nodes.map((node) => [node.id, node]));
  const edges = new Map(city.edges.map((edge) => [`${Math.min(edge.source, edge.target)}-${Math.max(edge.source, edge.target)}`, edge]));
  const lineFor = (u: number, v: number) => {
    const edge = edges.get(`${Math.min(u, v)}-${Math.max(u, v)}`);
    return edge ? edgePoints(nodes, u, v, edge).map(([lat, lon]) => [lon, lat]) : null;
  };
  const point = (node: NodeData) => ({ type: 'Point', coordinates: [node.lon, node.lat] });
  const features: object[] = [];
  const origin = nodes.get(state.originNode);
  if (origin) features.push({ type: 'Feature', geometry: point(origin), properties: { layer: 'origin', name: origin.intersection_name, usng: toUsng(origin.lat, origin.lon), ground_m: origin.elevation, flood_stage_m: origin.flood_stage_m } });
  if (route?.success) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.path_coords.map((coord) => [coord.lon, coord.lat]) },
      properties: {
        layer: 'recommended_route',
        travel_mode: state.travelMode,
        eta_minutes: route.eta_minutes,
        congested_eta_minutes: route.congested_eta_minutes,
        distance_m: route.distance_m,
        destination: route.destination_name || nodes.get(route.dest_node)?.intersection_name,
        risk_level: route.risk_level,
        water_surface_m: route.water_surface_m,
        steps: route.route_steps.map((step) => step.instruction),
      },
    });
    const destination = nodes.get(route.dest_node);
    if (destination) features.push({ type: 'Feature', geometry: point(destination), properties: { layer: 'destination', name: route.destination_name || destination.intersection_name, usng: toUsng(destination.lat, destination.lon) } });
  }
  state.closures.forEach(([u, v]) => {
    const coordinates = lineFor(u, v);
    const edge = edges.get(`${Math.min(u, v)}-${Math.max(u, v)}`);
    if (coordinates) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { layer: 'operator_closure', road: edge?.road_name } });
  });
  const blocked = (route?.blocked_edges ?? []).map(([u, v]) => lineFor(u, v)).filter(Boolean);
  if (blocked.length) features.push({ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: blocked }, properties: { layer: 'flooded_segments', count: blocked.length } });
  const flooded = (route?.flooded_nodes ?? []).map((id) => nodes.get(id)).filter((node): node is NodeData => Boolean(node));
  if (flooded.length) features.push({ type: 'Feature', geometry: { type: 'MultiPoint', coordinates: flooded.map((node) => [node.lon, node.lat]) }, properties: { layer: 'flooded_junctions', count: flooded.length } });
  (city.shelters ?? []).forEach((shelter) => features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [shelter.lon, shelter.lat] },
    properties: { layer: 'shelter', name: shelter.name, kind: shelter.kind, capacity: shelter.capacity, usng: toUsng(shelter.lat, shelter.lon) },
  }));
  state.triggerPoints?.targets.forEach((target) => {
    const node = nodes.get(target.bottleneck_node);
    if (node && target.limited_by === 'corridor') {
      features.push({ type: 'Feature', geometry: point(node), properties: { layer: 'trigger_point', target: target.name, threshold_m: target.threshold_m, road: target.bottleneck_road } });
    }
  });
  return {
    type: 'FeatureCollection',
    name: 'gridevac_scenario',
    metadata: {
      generated: new Date().toISOString(),
      flood_level: state.floodLevel,
      water_surface_m_navd88: route?.water_surface_m,
      failed_substations: state.failedSubstations,
      evacuees: state.evacuees,
      scenario_url: state.scenarioUrl,
      attribution: 'Streets and buildings (c) OpenStreetMap contributors; elevation USGS 3DEP',
    },
    features,
  };
}

export function buildEventCsv(events: OperatorEvent[]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return ['timestamp_utc,houston_local,kind,message', ...events.slice().reverse().map((event) => [event.at, escape(centralTime(event.at)), event.kind, escape(event.message)].join(','))].join('\n');
}

export function downloadFile(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileStamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
}
