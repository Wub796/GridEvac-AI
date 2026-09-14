'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type * as CesiumType from 'cesium';
import Icon from '@/components/Icon';
import { useSimulationStore, type Basemap } from '@/hooks/useSimulation';
import { nearestNode } from '@/lib/exposure';
import { logicalJunctions } from '@/lib/network';
import { edgeKey, edgePoints, floodStage, waterSurfaceM } from '@/lib/solver';
import { loadTerrain, sample, terrainBounds, type TerrainGrid } from '@/lib/terrain';
import type { CityData, EdgeData, SubstationData } from '@/lib/types';
import { formatLatLon, toUsng } from '@/lib/usng';

declare const Cesium: typeof CesiumType;

/* ------------------------------------------------------------ constants */

const CESIUM_VERSION = '1.119.0';
// Two CDNs: an outage or a blocked host on one does not take the map down.
const CESIUM_CDNS = [
  `https://cdn.jsdelivr.net/npm/cesium@${CESIUM_VERSION}/Build/Cesium/`,
  `https://unpkg.com/cesium@${CESIUM_VERSION}/Build/Cesium/`,
];
const CESIUM_TOKEN = (process.env.NEXT_PUBLIC_CESIUM_TOKEN ?? '').trim();
// CARTO basemaps need a free key appended as `key`; attribution stays visible.
const CARTO_KEY = (process.env.NEXT_PUBLIC_CARTO_API_KEY ?? '').trim();
const cartoUrl = (style: string) => `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}.png${CARTO_KEY ? `?key=${encodeURIComponent(CARTO_KEY)}` : ''}`;

const COLOR = {
  ground: '#0a1115',
  ink: '#e9f0f2',
  signal: '#ff9a3c',
  water: '#52c5f5',
  safe: '#43d397',
  watch: '#f2b53f',
  critical: '#ff6a5c',
  utility: '#d8c56e',
  shelter: '#f3d58a',
  medical: '#ff9d8a',
  park: '#2f7d5b',
  // Periwinkle for "you": distinct from water cyan and route orange.
  user: '#8b96ff',
} as const;

// Street hierarchy per basemap: light strokes on dark ground, dark on light,
// translucent white over imagery so the photo stays readable.
const ROAD_PALETTE: Record<Basemap, Record<string, [string, number]>> = {
  dark: { arterial: ['#cfdade', 0.82], collector: ['#a9b8be', 0.7], local: ['#7d8d94', 0.62], service: ['#56646a', 0.55] },
  light: { arterial: ['#3d4a53', 0.85], collector: ['#5b6972', 0.75], local: ['#87939a', 0.7], service: ['#aeb8bd', 0.6] },
  aerial: { arterial: ['#ffffff', 0.7], collector: ['#f4f6f7', 0.55], local: ['#e8ecee', 0.42], service: ['#dde2e5', 0.3] },
};
const BUILDING_PALETTE: Record<Basemap, { base: string; flooded: string; dark: string; alpha: number }> = {
  dark: { base: '#233640', flooded: '#1f78aa', dark: '#141b1f', alpha: 0.94 },
  light: { base: '#cdd5d9', flooded: '#62b6e4', dark: '#8b9296', alpha: 0.95 },
  aerial: { base: '#e9eef0', flooded: '#43aee8', dark: '#4d5559', alpha: 0.55 },
};
// Cartographic generalization: minor streets drop out by camera distance.
// Widths are screen pixels and never change with zoom: restyling thousands of
// ground polylines on every camera move rebuilt their batches mid-frame.
const ROAD_TIERS: Record<string, { fade: number; base: number }> = {
  service: { fade: 1500, base: 1.25 },
  local: { fade: 3200, base: 2 },
  collector: { fade: 6500, base: 3 },
  arterial: { fade: Number.MAX_VALUE, base: 4 },
};
const STATE_COLORS: Record<string, [string, number, number]> = {
  closed: [COLOR.critical, 1, 7],
  blocked: [COLOR.water, 0.95, 5],
  // Streets under dead or overloaded lines are context, quieter than water and closures.
  dead: [COLOR.critical, 0.5, 3],
  overloaded: [COLOR.watch, 0.45, 3],
  search: [COLOR.signal, 1, 8],
};

type RoadRecord = { entity: any; edge: EdgeData; state: string | null; styled: string };
type BuildingRecord = { entity: any; lat: number; lon: number; tint: string };

interface Layers {
  roads: Map<string, RoadRecord>;
  nodes: Map<number, any>;
  pickNodes: any[];
  halos: any[];
  buildings: BuildingRecord[];
  parks: any[];
  labels: any[];
  waterways: any[];
  substations: Map<number, { entities: any[]; beacon: any; sub: SubstationData }>;
  transmission: any[];
  shelters: Map<string, { marker: any; halo: any }>;
  flood: any;
  floodCanvases: HTMLCanvasElement[];
  floodFlip: number;
  floodSurface: number;
  blackout: any[];
  isochrone: any[];
  route: any[];
  routeWidth: number;
  closures: any[];
  triggers: any[];
  highlight: any[];
  endpoints: any[];
  user: any[];
  rendered: boolean;
  visible: boolean;
  introPlayed: boolean;
  basemap: Basemap;
  fonts: { sans: string; mono: string };
}

/* -------------------------------------------------------------- loading */

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.appendChild(script);
  });
}

async function loadCesium() {
  if ((window as any).Cesium) return;
  for (const base of CESIUM_CDNS) {
    try {
      let link = document.getElementById('gridevac-cesium-css') as HTMLLinkElement | null;
      if (!link) {
        link = document.createElement('link');
        link.id = 'gridevac-cesium-css';
        link.rel = 'stylesheet';
        document.head.appendChild(link);
      }
      link.href = `${base}Widgets/widgets.css`;
      await loadScript(`${base}Cesium.js`);
      if ((window as any).Cesium) return;
    } catch {
      /* try the next CDN */
    }
  }
  throw new Error('CesiumJS unavailable');
}

const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const css = (value: string, alpha = 1) => Cesium.Color.fromCssColorString(value).withAlpha(alpha);
const requestFrame = (viewer: any) => { if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender(); };

function makeBaseLayer(basemap: Basemap) {
  if (basemap === 'aerial' && CESIUM_TOKEN) {
    return Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(2), {});
  }
  return new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
    url: cartoUrl(basemap === 'light' ? 'light_nolabels' : 'dark_nolabels'),
    subdomains: ['a', 'b', 'c', 'd'],
    credit: '© OpenStreetMap contributors, © CARTO',
    maximumLevel: 19,
  }), {});
}

/* -------------------------------------------------------------- styling */

const materialCache = new Map<string, any>();
/** Shared material instances: equal materials batch together instead of one batch per street. */
function colorMaterial(color: string, alpha: number) {
  const key = `${color}|${alpha}`;
  let material = materialCache.get(key);
  if (!material) {
    material = new Cesium.ColorMaterialProperty(css(color, alpha));
    materialCache.set(key, material);
  }
  return material;
}

function styleRoad(record: RoadRecord, basemap: Basemap) {
  const tier = ROAD_TIERS[record.edge.road_class] ?? ROAD_TIERS.local;
  let color: string;
  let alpha: number;
  let width = tier.base;
  let far = tier.fade;
  if (record.state && STATE_COLORS[record.state]) {
    [color, alpha, width] = STATE_COLORS[record.state];
    far = Number.MAX_VALUE;
  } else {
    [color, alpha] = ROAD_PALETTE[basemap][record.edge.road_class] ?? ROAD_PALETTE[basemap].local;
  }
  const key = `${color}|${alpha}|${width}|${far}`;
  if (key === record.styled) return;
  record.styled = key;
  const polyline = record.entity.polyline;
  polyline.material = colorMaterial(color, alpha);
  polyline.width = new Cesium.ConstantProperty(width);
  polyline.distanceDisplayCondition = new Cesium.ConstantProperty(new Cesium.DistanceDisplayCondition(0, far));
}

function paintFlood(grid: TerrainGrid, surface: number, canvas: HTMLCanvasElement) {
  // 2x upsampled bilinear field with a soft 30 cm shoreline, shaded by depth.
  const scale = 2;
  const width = grid.cols * scale;
  const height = grid.rows * scale;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(width, height);
  const data = image.data;
  const { cols, rows, stage, ground } = grid;
  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(Math.max((y + 0.5) / scale - 0.5, 0), rows - 1);
    const r0 = Math.floor(gy);
    const r1 = Math.min(r0 + 1, rows - 1);
    const fy = gy - r0;
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(Math.max((x + 0.5) / scale - 0.5, 0), cols - 1);
      const c0 = Math.floor(gx);
      const c1 = Math.min(c0 + 1, cols - 1);
      const fx = gx - c0;
      const i00 = r0 * cols + c0;
      const i01 = r0 * cols + c1;
      const i10 = r1 * cols + c0;
      const i11 = r1 * cols + c1;
      const s = (stage[i00] * (1 - fx) + stage[i01] * fx) * (1 - fy) + (stage[i10] * (1 - fx) + stage[i11] * fx) * fy;
      const wet = surface - s;
      if (wet < -0.15) continue;
      const g = (ground[i00] * (1 - fx) + ground[i01] * fx) * (1 - fy) + (ground[i10] * (1 - fx) + ground[i11] * fx) * fy;
      const edge = Math.min(1, (wet + 0.15) / 0.3);
      const t = Math.min(1, Math.max(0, (surface - g) / 3));
      const o = (y * width + x) * 4;
      data[o] = 120 - 98 * t;
      data[o + 1] = 212 - 110 * t;
      data[o + 2] = 250 - 92 * t;
      data[o + 3] = (0.38 + 0.4 * t) * edge * 255;
    }
  }
  context.putImageData(image, 0, 0);
}

/* ------------------------------------------------------------ component */

export default function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const terrainRef = useRef<TerrainGrid | null>(null);
  const tiltedRef = useRef(false);
  const scaleBarRef = useRef<HTMLElement>(null);
  const scaleLabelRef = useRef<HTMLElement>(null);
  const usngRef = useRef<HTMLSpanElement>(null);
  const latLonRef = useRef<HTMLSpanElement>(null);
  const groundRef = useRef<HTMLSpanElement>(null);
  const compassRef = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tilted, setTilted] = useState(false);
  const [terrain, setTerrain] = useState<TerrainGrid | null>(null);
  const layers = useRef<Layers>({
    roads: new Map(), nodes: new Map(), pickNodes: [], halos: [], buildings: [], parks: [], labels: [], waterways: [],
    substations: new Map(), transmission: [], shelters: new Map(), flood: null, floodCanvases: [], floodFlip: 0, floodSurface: Number.NaN,
    blackout: [], isochrone: [], route: [], routeWidth: 0, closures: [], triggers: [], highlight: [], endpoints: [], user: [],
    rendered: false, visible: true, introPlayed: false, basemap: 'dark', fonts: { sans: 'sans-serif', mono: 'monospace' },
  });

  const cityData = useSimulationStore((state) => state.cityData);
  const route = useSimulationStore((state) => state.route);
  const floodLevel = useSimulationStore((state) => state.floodLevel);
  const failedSubstations = useSimulationStore((state) => state.failedSubstations);
  const loadSignature = useSimulationStore((state) => Object.values(state.substationLoads).map((load) => Math.round(load / 5)).join(','));
  const showBuildings = useSimulationStore((state) => state.showBuildings);
  const showPowerLines = useSimulationStore((state) => state.showPowerLines);
  const showSubstations = useSimulationStore((state) => state.showSubstations);
  const showIntersections = useSimulationStore((state) => state.showIntersections);
  const showRoadNames = useSimulationStore((state) => state.showRoadNames);
  const showWaterways = useSimulationStore((state) => state.showWaterways);
  const basemap = useSimulationStore((state) => state.basemap);
  const originNode = useSimulationStore((state) => state.originNode);
  const destinationId = useSimulationStore((state) => state.destinationId);
  const closures = useSimulationStore((state) => state.closures);
  const closureMode = useSimulationStore((state) => state.closureMode);
  const isochrone = useSimulationStore((state) => state.isochrone);
  const isochroneVisible = useSimulationStore((state) => state.isochroneVisible);
  const triggerPoints = useSimulationStore((state) => state.triggerPoints);
  const highlightedStep = useSimulationStore((state) => state.highlightedStep);
  const flyToNodeId = useSimulationStore((state) => state.flyToNodeId);
  const flyToRoadKey = useSimulationStore((state) => state.flyToRoadKey);
  const flyToCoords = useSimulationStore((state) => state.flyToCoords);
  const isLoading = useSimulationStore((state) => state.isLoading);
  const setClosureMode = useSimulationStore((state) => state.setClosureMode);
  const userLocation = useSimulationStore((state) => state.userLocation);
  const locationStatus = useSimulationStore((state) => state.locationStatus);
  const locationMessage = useSimulationStore((state) => state.locationMessage);
  const locateUser = useSimulationStore((state) => state.locateUser);
  const dismissLocationMessage = useSimulationStore((state) => state.dismissLocationMessage);

  /* --------------------------------------------------------- viewer init */
  useEffect(() => {
    let disposed = false;
    let handler: any = null;
    let resizeObserver: ResizeObserver | null = null;
    let visibility: IntersectionObserver | null = null;
    const store = layers.current;
    void loadTerrain().then((grid) => {
      if (disposed) return;
      terrainRef.current = grid;
      setTerrain(grid);
    });

    (async () => {
      try {
        await loadCesium();
      } catch {
        if (!disposed) setError('The map engine could not load from its CDN. Routing, exports, and the audit still work.');
        return;
      }
      if (disposed || !containerRef.current) return;
      if (CESIUM_TOKEN) Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const rootStyle = getComputedStyle(document.documentElement);
      store.fonts = {
        sans: getComputedStyle(document.body).fontFamily || 'sans-serif',
        mono: rootStyle.getPropertyValue('--font-plex-mono').trim() || 'monospace',
      };

      const viewer = new Cesium.Viewer(containerRef.current, {
        baseLayer: makeBaseLayer('dark'),
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
        animation: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false,
        navigationHelpButton: false,
        // On-demand rendering: frames draw only when something changes.
        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
        shadows: false,
        msaaSamples: coarse ? 1 : 4,
      } as any);
      viewerRef.current = viewer;
      const scene = viewer.scene;
      scene.backgroundColor = css(COLOR.ground);
      scene.globe.baseColor = css(COLOR.ground);
      scene.globe.depthTestAgainstTerrain = false;
      scene.globe.showGroundAtmosphere = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      scene.fog.enabled = false;
      if (coarse && (window.devicePixelRatio || 1) > 2) viewer.useBrowserRecommendedResolution = false;

      // Late-afternoon sun from the south-west gives building volumes readable faces.
      const center = Cesium.Cartesian3.fromDegrees(-95.3698, 29.7604);
      const frame = Cesium.Transforms.eastNorthUpToFixedFrame(center);
      const direction = Cesium.Matrix4.multiplyByPointAsVector(frame, new Cesium.Cartesian3(0.5, 0.42, -0.76), new Cesium.Cartesian3());
      scene.light = new Cesium.DirectionalLight({ direction: Cesium.Cartesian3.normalize(direction, direction), intensity: 2.2 });

      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(-95.3698, 29.7604, 5600),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-89), roll: 0 },
      });
      if (CESIUM_TOKEN && (Cesium as any).Terrain?.fromWorldTerrain) {
        try { (scene as any).setTerrain((Cesium as any).Terrain.fromWorldTerrain()); } catch { /* ellipsoid fallback */ }
      }

      const globePick = (position: any) => {
        const ray = viewer.camera.getPickRay(position);
        return (ray && scene.globe.pick(ray, scene)) || viewer.camera.pickEllipsoid(position);
      };
      const pickWindow = coarse ? 36 : 12;
      const idsAt = (position: any): string[] => (scene.drillPick(position, 12, pickWindow, pickWindow) ?? [])
        .map((item: any) => item?.id?.id ?? item?.id)
        .filter((id: unknown): id is string => typeof id === 'string');

      handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
      handler.setInputAction((event: any) => {
        const state = useSimulationStore.getState();
        const city = state.cityData;
        if (!city) return;
        const ids = idsAt(event.position);
        if (state.closureMode) {
          const match = ids.map((id) => /^(?:road|closure)-(\d+)-(\d+)/.exec(id)).find(Boolean);
          if (match) state.toggleClosure(Number(match[1]), Number(match[2]));
          return;
        }
        const shelterId = ids.map((id) => /^shelter-(.+)$/.exec(id)?.[1]).find((id) => id && city.shelters?.some((shelter) => shelter.id === id));
        if (shelterId) {
          state.setDestination(state.destinationId === shelterId ? null : shelterId);
          return;
        }
        const exits = new Set(city.safe_exits);
        const nodeIds = ids.map((id) => /^(?:pick-)?node-(\d+)$/.exec(id)).filter((match): match is RegExpExecArray => Boolean(match)).map((match) => Number(match[1]));
        const target = nodeIds.find((id) => !exits.has(id)) ?? nodeIds[0];
        if (target === undefined) return;
        const node = city.nodes.find((item) => item.id === target);
        if (!node) return;
        if (exits.has(node.id)) {
          state.addLog(`${city.exit_names?.[String(node.id)] ?? 'That exit'} is a destination, not a starting point.`, 'warning');
        } else if (floodStage(node) <= waterSurfaceM(city, state.floodLevel)) {
          state.addLog(`${node.intersection_name} is under the modeled water; choose a dry junction.`, 'warning');
        } else {
          state.setOriginNode(node.id);
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      const hoverPin = viewer.entities.add({
        id: 'hover-pin',
        position: Cesium.Cartesian3.fromDegrees(0, 0),
        label: {
          text: '',
          font: `600 13px ${store.fonts.sans}`,
          fillColor: css(COLOR.ink),
          showBackground: true,
          backgroundColor: css(COLOR.ground, 0.94),
          backgroundPadding: new Cesium.Cartesian2(9, 6),
          pixelOffset: new Cesium.Cartesian2(0, -26),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: false,
        },
      });

      let hoverFrame = 0;
      let lastPosition: any = null;
      let hoverKey = '';
      const updateReadout = (position: any) => {
        const cartesian = globePick(position);
        if (!cartesian) return;
        const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
        const lat = Cesium.Math.toDegrees(cartographic.latitude);
        const lon = Cesium.Math.toDegrees(cartographic.longitude);
        if (usngRef.current) usngRef.current.textContent = `USNG ${toUsng(lat, lon)}`;
        if (latLonRef.current) latLonRef.current.textContent = formatLatLon(lat, lon);
        const grid = terrainRef.current;
        if (groundRef.current) {
          const bounds = grid && terrainBounds(grid);
          if (grid && bounds && lat < bounds.north && lat > bounds.south && lon > bounds.west && lon < bounds.east) {
            const groundHeight = sample(grid, grid.ground, lat, lon);
            const stage = sample(grid, grid.stage, lat, lon);
            groundRef.current.textContent = `Ground ${groundHeight.toFixed(1)} m, floods at ${stage >= 24 ? 'over 24' : stage.toFixed(1)} m`;
          } else {
            groundRef.current.textContent = '';
          }
        }
      };

      handler.setInputAction((movement: any) => {
        lastPosition = movement.endPosition;
        if (hoverFrame) return;
        hoverFrame = requestAnimationFrame(() => {
          hoverFrame = 0;
          if (viewer.isDestroyed() || !lastPosition) return;
          updateReadout(lastPosition);
          const state = useSimulationStore.getState();
          const city = state.cityData;
          if (!city) return;
          const picked = scene.pick(lastPosition);
          const id = picked?.id?.id ?? picked?.id;
          let text = '';
          let at: { lat: number; lon: number } | null = null;
          if (typeof id === 'string') {
            const road = /^(?:road|closure)-(\d+)-(\d+)/.exec(id);
            const node = /^(?:pick-)?node-(\d+)$/.exec(id);
            const shelter = /^shelter-(.+)$/.exec(id);
            if (state.closureMode && road) {
              const record = store.roads.get(edgeKey(Number(road[1]), Number(road[2])));
              if (record) {
                const nodes = new Map(city.nodes.map((item) => [item.id, item]));
                const points = edgePoints(nodes, record.edge.source, record.edge.target, record.edge);
                const [lat, lon] = points[Math.floor(points.length / 2)];
                const closed = state.closures.some(([u, v]) => edgeKey(u, v) === edgeKey(record.edge.source, record.edge.target));
                text = `${record.edge.road_name === 'Unnamed street' ? 'Street segment' : record.edge.road_name}: click to ${closed ? 'reopen' : 'close'}`;
                at = { lat, lon };
              }
            } else if (!state.closureMode && node) {
              const item = city.nodes.find((candidate) => candidate.id === Number(node[1]));
              if (item) {
                const exit = city.exit_names?.[String(item.id)];
                const underwater = floodStage(item) <= waterSurfaceM(city, state.floodLevel);
                text = exit ? `${exit}: ${item.intersection_name}` : `${item.intersection_name}${underwater ? ', under water' : ', click to start here'}`;
                at = item;
              }
            } else if (!state.closureMode && shelter) {
              const item = city.shelters?.find((candidate) => candidate.id === shelter[1]);
              if (item) {
                text = `${item.name}, ${item.capacity.toLocaleString()} capacity`;
                at = item;
              }
            }
          }
          const key = `${text}|${at?.lat}|${at?.lon}`;
          if (key !== hoverKey) {
            hoverKey = key;
            if (at && text) {
              hoverPin.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(at.lon, at.lat));
              hoverPin.label!.text = new Cesium.ConstantProperty(text);
              hoverPin.label!.show = new Cesium.ConstantProperty(true);
            } else {
              hoverPin.label!.show = new Cesium.ConstantProperty(false);
            }
            scene.canvas.style.cursor = text ? 'pointer' : state.closureMode ? 'crosshair' : 'default';
          }
          requestFrame(viewer);
        });
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

      const updateCamera = () => {
        if (viewer.isDestroyed()) return;
        const height = viewer.camera.positionCartographic.height;
        const routeWidth = height > 4200 ? 6 : height > 1800 ? 8 : 11;
        if (routeWidth !== store.routeWidth) {
          store.routeWidth = routeWidth;
          store.route.forEach((entity) => {
            if (!entity.polyline) return;
            const casing = entity.id === 'route-casing';
            entity.polyline.width = new Cesium.ConstantProperty(casing ? routeWidth + 6 : routeWidth);
          });
        }
        const canvas = scene.canvas;
        const a = globePick(new Cesium.Cartesian2(canvas.clientWidth / 2 - 50, canvas.clientHeight - 30));
        const b = globePick(new Cesium.Cartesian2(canvas.clientWidth / 2 + 50, canvas.clientHeight - 30));
        if (a && b && scaleBarRef.current && scaleLabelRef.current) {
          const meters = new Cesium.EllipsoidGeodesic(Cesium.Cartographic.fromCartesian(a), Cesium.Cartographic.fromCartesian(b)).surfaceDistance;
          const perPixel = meters / 100;
          const nice = [10000, 5000, 2000, 1000, 500, 250, 200, 100, 50, 20, 10, 5].find((value) => value / perPixel <= 110) ?? 5;
          scaleBarRef.current.style.width = `${Math.max(10, nice / perPixel)}px`;
          scaleLabelRef.current.textContent = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
        }
        if (compassRef.current) compassRef.current.style.transform = `rotate(${-Cesium.Math.toDegrees(viewer.camera.heading)}deg)`;
        const isTilted = viewer.camera.pitch > Cesium.Math.toRadians(-72);
        if (isTilted !== tiltedRef.current) {
          tiltedRef.current = isTilted;
          setTilted(isTilted);
        }
        requestFrame(viewer);
      };
      viewer.camera.percentageChanged = 0.015;
      viewer.camera.changed.addEventListener(updateCamera);
      (store as any).updateCamera = updateCamera;

      resizeObserver = new ResizeObserver(() => {
        if (viewer.isDestroyed()) return;
        viewer.resize();
        updateCamera();
      });
      resizeObserver.observe(containerRef.current);
      visibility = new IntersectionObserver(([entry]) => {
        store.visible = entry.isIntersecting;
        if (entry.isIntersecting && store.rendered && !store.introPlayed) {
          store.introPlayed = true;
          if (!prefersReducedMotion()) {
            viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(-95.3698, 29.705, 9000), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-38), roll: 0 } });
            viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(-95.3698, 29.7604, 5600), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-89), roll: 0 }, duration: 2.6, easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT });
          }
        }
      }, { root: document.querySelector('.content-scroll'), threshold: 0.35 });
      visibility.observe(containerRef.current);
      setReady(true);
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      visibility?.disconnect();
      if (handler && !handler.isDestroyed()) handler.destroy();
      const viewer = viewerRef.current;
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
      const fresh = store;
      fresh.roads.clear();
      fresh.nodes.clear();
      fresh.substations.clear();
      fresh.shelters.clear();
      Object.assign(fresh, { pickNodes: [], halos: [], buildings: [], parks: [], labels: [], waterways: [], transmission: [], flood: null, blackout: [], isochrone: [], route: [], closures: [], triggers: [], highlight: [], endpoints: [], user: [], rendered: false, introPlayed: false, floodSurface: Number.NaN });
      setReady(false);
    };
  }, []);

  /* ----------------------------------------------------- animation pump */
  useEffect(() => {
    // Exit beacons and the route pulse need frames; request them at 20 fps
    // only while the map is on screen. Touch devices stay fully on-demand.
    if (!ready || prefersReducedMotion() || window.matchMedia('(pointer: coarse)').matches) return;
    const viewer = viewerRef.current;
    let frame = 0;
    let last = 0;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      if (!layers.current.visible || document.visibilityState !== 'visible' || now - last < 50) return;
      last = now;
      requestFrame(viewer);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  /* -------------------------------------------------------- static city */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer || !cityData || store.rendered) return;
    store.rendered = true;
    renderCity(viewer, cityData, store);
    (store as any).updateCamera?.();
    requestFrame(viewer);
  }, [ready, cityData]);

  /* ---------------------------------------------------------- basemap */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer || store.basemap === basemap) return;
    store.basemap = basemap;
    const previous = viewer.imageryLayers.get(0);
    const next = makeBaseLayer(basemap);
    viewer.imageryLayers.add(next, 1);
    // Keep the old imagery until the new tiles have had a moment to arrive.
    window.setTimeout(() => {
      if (viewer.isDestroyed()) return;
      if (previous) viewer.imageryLayers.remove(previous, true);
      requestFrame(viewer);
    }, 900);
    const light = basemap !== 'dark';
    viewer.scene.globe.baseColor = css(light ? '#e4e9eb' : COLOR.ground);
    store.roads.forEach((record) => styleRoad(record, basemap));
    store.buildings.forEach((record) => { record.tint = ''; });
    (store as any).updateCamera?.();
    (store as any).retint?.();
  }, [ready, basemap]);

  /* ------------------------------------------------------ layer toggles */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer) return;
    // Only touch entities whose visibility actually changes: redundant show
    // writes queue batch updates that race with geometry rebuilds.
    const setShow = (entity: any, value: boolean) => { if (entity.show !== value) entity.show = value; };
    store.buildings.forEach(({ entity }) => setShow(entity, showBuildings));
    store.parks.forEach((entity) => setShow(entity, showBuildings));
    store.transmission.forEach((entity) => setShow(entity, showPowerLines));
    store.substations.forEach((group) => group.entities.forEach((entity) => setShow(entity, showSubstations)));
    store.nodes.forEach((entity) => setShow(entity, showIntersections));
    store.halos.forEach((entity) => setShow(entity, showIntersections));
    store.labels.forEach((entity) => setShow(entity, showRoadNames));
    store.waterways.forEach((entity) => setShow(entity, showWaterways));
    requestFrame(viewer);
  }, [ready, cityData, showBuildings, showPowerLines, showSubstations, showIntersections, showRoadNames, showWaterways]);

  /* ------------------------------------------------------ flood surface */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer || !terrain || !cityData) return;
    const target = waterSurfaceM(cityData, floodLevel);
    const from = Number.isFinite(store.floodSurface) ? store.floodSurface : target - 1.2;
    if (store.floodCanvases.length === 0) store.floodCanvases = [document.createElement('canvas'), document.createElement('canvas')];

    const upload = (surface: number) => {
      store.floodFlip = 1 - store.floodFlip;
      const canvas = store.floodCanvases[store.floodFlip];
      paintFlood(terrain, surface, canvas);
      store.floodSurface = surface;
      if (!store.flood) {
        const bounds = terrainBounds(terrain);
        store.flood = viewer.scene.primitives.add(new Cesium.GroundPrimitive({
          geometryInstances: new Cesium.GeometryInstance({
            geometry: new Cesium.RectangleGeometry({
              rectangle: Cesium.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north),
              vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
            }),
          }),
          appearance: new Cesium.EllipsoidSurfaceAppearance({
            aboveGround: false,
            material: Cesium.Material.fromType('Image', { image: canvas, repeat: new Cesium.Cartesian2(1, 1) }),
          }),
          classificationType: Cesium.ClassificationType.TERRAIN,
        }));
      } else {
        store.flood.appearance.material.uniforms.image = canvas;
      }
      requestFrame(viewer);
    };

    if (prefersReducedMotion() || Math.abs(target - from) < 0.01) {
      upload(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const duration = 700;
    let lastPaint = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      if (now - lastPaint > 60 || progress >= 1) {
        lastPaint = now;
        upload(from + (target - from) * (1 - (1 - progress) ** 3));
      }
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [ready, terrain, cityData, floodLevel]);

  /* ---------------------------------------------------- building tints */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer || !cityData || !store.buildings.length) return;
    const retint = () => {
      const surface = waterSurfaceM(cityData, useSimulationStore.getState().floodLevel);
      const blackout = new Set(useSimulationStore.getState().route?.blackout_nodes ?? []);
      const palette = BUILDING_PALETTE[store.basemap];
      const grid = terrainRef.current;
      store.buildings.forEach((record) => {
        const stage = grid ? sample(grid, grid.stage, record.lat, record.lon) : Number.POSITIVE_INFINITY;
        const nearest = nearestNode(cityData, record.lat, record.lon);
        const tint = stage <= surface ? 'flooded' : nearest && blackout.has(nearest.id) ? 'dark' : 'base';
        if (tint === record.tint) return;
        record.tint = tint;
        record.entity.polygon.material = new Cesium.ColorMaterialProperty(css(palette[tint as 'base'], palette.alpha));
      });
      requestFrame(viewer);
    };
    (store as any).retint = retint;
    const timer = window.setTimeout(retint, 260);
    return () => window.clearTimeout(timer);
  }, [ready, cityData, terrain, floodLevel, route]);

  /* --------------------------------------------------- blackout districts */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer || !cityData) return;
    store.blackout.forEach((entity) => viewer.entities.remove(entity));
    store.blackout = [];
    const offline = new Set([...failedSubstations, ...(route?.cascaded_substations ?? []), ...(route?.flooded_substations ?? [])]);
    offline.forEach((id) => {
      const sub = cityData.substations.find((item) => item.id === id);
      if (!sub) return;
      const radius = sub.radius * 150;
      store.blackout.push(
        viewer.entities.add({
          id: `blackout-${id}`,
          position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat),
          ellipse: { semiMajorAxis: radius, semiMinorAxis: radius, material: css(COLOR.critical, 0.07), outline: false, classificationType: Cesium.ClassificationType.TERRAIN },
        }),
        viewer.entities.add({
          id: `blackout-edge-${id}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(Array.from({ length: 65 }, (_, index) => {
              const angle = (index / 64) * Math.PI * 2;
              return [sub.lon + (radius * Math.sin(angle)) / (111320 * Math.cos((sub.lat * Math.PI) / 180)), sub.lat + (radius * Math.cos(angle)) / 111320];
            }).flat()),
            width: 2,
            clampToGround: true,
            material: new Cesium.PolylineDashMaterialProperty({ color: css(COLOR.critical, 0.8), dashLength: 14 }),
          },
        }),
        viewer.entities.add({
          id: `blackout-label-${id}`,
          position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat + radius / 111320),
          label: {
            text: `No power: ${sub.name.replace(' Substation', '')}`,
            font: `600 12px ${layers.current.fonts.sans}`,
            fillColor: css('#ffc2bb'),
            showBackground: true,
            backgroundColor: css(COLOR.ground, 0.9),
            backgroundPadding: new Cesium.Cartesian2(7, 4),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 7000),
          },
        }),
      );
    });
    requestFrame(viewer);
  }, [ready, cityData, failedSubstations, route]);

  /* -------------------------------------------------------- reachability */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer) return;
    store.isochrone.forEach((primitive) => viewer.scene.primitives.remove(primitive));
    store.isochrone = [];
    if (!cityData || !isochroneVisible || !isochrone?.rings.length) {
      requestFrame(viewer);
      return;
    }
    const ringOf = new Map<number, number>();
    isochrone.rings.forEach((ring, index) => ring.nodes.forEach((id) => { if (!ringOf.has(id)) ringOf.set(id, index); }));
    const colors = ['#b6ecff', '#6fd0f7', '#3aa3dc', '#2279b3'];
    const nodes = new Map(cityData.nodes.map((node) => [node.id, node]));
    const instances: any[][] = isochrone.rings.map(() => []);
    cityData.edges.forEach((edge) => {
      const a = ringOf.get(edge.source);
      const b = ringOf.get(edge.target);
      if (a === undefined || b === undefined) return;
      const ring = Math.max(a, b);
      instances[ring].push(new Cesium.GeometryInstance({
        geometry: new Cesium.GroundPolylineGeometry({
          positions: Cesium.Cartesian3.fromDegreesArray(edgePoints(nodes, edge.source, edge.target, edge).flatMap(([lat, lon]) => [lon, lat])),
          width: 5,
        }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(css(colors[ring] ?? colors[3], 0.9)) },
      }));
    });
    instances.forEach((list) => {
      if (!list.length) return;
      store.isochrone.push(viewer.scene.primitives.add(new Cesium.GroundPolylinePrimitive({ geometryInstances: list, appearance: new Cesium.PolylineColorAppearance() })));
    });
    requestFrame(viewer);
  }, [ready, cityData, isochrone, isochroneVisible]);

  /* ------------------------------------------------- road states + route */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer || !cityData || !store.rendered) return;
    const states = new Map<string, string>();
    Object.entries(route?.hazard_roads ?? {}).forEach(([key, state]) => {
      const [a, b] = key.split('-').map(Number);
      states.set(edgeKey(a, b), state);
    });
    (route?.blocked_edges ?? []).forEach(([a, b]) => states.set(edgeKey(a, b), 'blocked'));
    closures.forEach(([a, b]) => states.set(edgeKey(a, b), 'closed'));
    store.roads.forEach((record, key) => {
      const state = states.get(key) ?? null;
      if (state === record.state) return;
      record.state = state;
      styleRoad(record, store.basemap);
    });

    store.route.forEach((entity) => viewer.entities.remove(entity));
    store.route = [];
    if (route?.success && route.path_coords.length > 1) {
      const coordinates = route.path_coords.flatMap((coord) => [coord.lon, coord.lat]);
      const width = store.routeWidth || 8;
      store.route.push(
        viewer.entities.add({ id: 'route-casing', polyline: { positions: Cesium.Cartesian3.fromDegreesArray(coordinates), width: width + 6, clampToGround: true, zIndex: 3, material: css(COLOR.ground, 0.92) } }),
        viewer.entities.add({ id: 'route-core', polyline: { positions: Cesium.Cartesian3.fromDegreesArray(coordinates), width, clampToGround: true, zIndex: 4, material: css(COLOR.signal) } }),
      );
      if (!prefersReducedMotion()) {
        // Pulses travelling toward the exit show the direction of travel.
        const lengths = [0];
        for (let i = 1; i < route.path_coords.length; i += 1) {
          const a = route.path_coords[i - 1];
          const b = route.path_coords[i];
          lengths.push(lengths[i - 1] + Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180)));
        }
        const total = lengths[lengths.length - 1];
        const scratch = new Cesium.Cartesian3();
        const positionAt = (offset: number) => new Cesium.CallbackProperty(() => {
          const distance = (((performance.now() / Math.max(2600, total * 3.2)) + offset) % 1) * total;
          let index = 1;
          while (index < lengths.length - 1 && lengths[index] < distance) index += 1;
          const a = route.path_coords[index - 1];
          const b = route.path_coords[index];
          const t = (distance - lengths[index - 1]) / Math.max(0.001, lengths[index] - lengths[index - 1]);
          return Cesium.Cartesian3.fromDegrees(a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t, 0, undefined, scratch);
        }, false) as any;
        [0, 0.33, 0.66].forEach((offset) => {
          store.route.push(viewer.entities.add({
            id: `route-pulse-${offset}`,
            position: positionAt(offset),
            point: { pixelSize: 7, color: css('#fff1e0'), outlineColor: css(COLOR.signal), outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
          }));
        });
      }
    }
    requestFrame(viewer);
  }, [ready, cityData, route, closures, basemap]);

  /* ------------------------------------------------------------ closures */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer || !cityData) return;
    store.closures.forEach((entity) => viewer.entities.remove(entity));
    store.closures = [];
    const nodes = new Map(cityData.nodes.map((node) => [node.id, node]));
    closures.forEach(([u, v]) => {
      const record = store.roads.get(edgeKey(u, v));
      if (!record) return;
      const points = edgePoints(nodes, record.edge.source, record.edge.target, record.edge);
      const [lat, lon] = points[Math.floor(points.length / 2)];
      store.closures.push(
        viewer.entities.add({
          id: `closure-${record.edge.source}-${record.edge.target}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(points.flatMap(([pointLat, pointLon]) => [pointLon, pointLat])),
            width: 9,
            clampToGround: true,
            zIndex: 6,
            material: new Cesium.PolylineDashMaterialProperty({ color: css(COLOR.critical), gapColor: css(COLOR.ground, 0.9), dashLength: 10 }),
          },
        }),
        viewer.entities.add({
          id: `closure-marker-${record.edge.source}-${record.edge.target}`,
          position: Cesium.Cartesian3.fromDegrees(lon, lat),
          point: { pixelSize: 13, color: css(COLOR.critical), outlineColor: css(COLOR.ground), outlineWidth: 3, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
          label: {
            text: 'Closed',
            font: `700 12px ${store.fonts.sans}`,
            fillColor: css('#ffd3cd'),
            showBackground: true,
            backgroundColor: css(COLOR.ground, 0.92),
            backgroundPadding: new Cesium.Cartesian2(6, 3),
            pixelOffset: new Cesium.Cartesian2(0, -20),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3200),
          },
        }),
      );
    });
    requestFrame(viewer);
  }, [ready, cityData, closures]);

  /* ------------------------------------------------------ trigger points */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer || !cityData) return;
    store.triggers.forEach((entity) => viewer.entities.remove(entity));
    store.triggers = [];
    const surface = waterSurfaceM(cityData, floodLevel);
    const nodes = new Map(cityData.nodes.map((node) => [node.id, node]));
    const byNode = new Map<number, { names: string[]; threshold: number }>();
    (triggerPoints?.targets ?? []).filter((target) => target.limited_by === 'corridor').forEach((target) => {
      const group = byNode.get(target.bottleneck_node);
      if (group) group.names.push(target.name);
      else byNode.set(target.bottleneck_node, { names: [target.name], threshold: target.threshold_m });
    });
    byNode.forEach((group, nodeId) => {
      const node = nodes.get(nodeId);
      if (!node) return;
      const cutOff = group.threshold <= surface;
      store.triggers.push(viewer.entities.add({
        id: `trigger-${nodeId}`,
        position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat),
        billboard: {
          image: diamondImage(cutOff ? COLOR.critical : COLOR.watch),
          width: 16,
          height: 16,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${group.names.join(', ')}: cut off at ${group.threshold.toFixed(1)} m`,
          font: `600 12px ${store.fonts.sans}`,
          fillColor: css(cutOff ? '#ffd3cd' : '#ffe2a8'),
          showBackground: true,
          backgroundColor: css(COLOR.ground, 0.9),
          backgroundPadding: new Cesium.Cartesian2(7, 4),
          pixelOffset: new Cesium.Cartesian2(0, -20),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3000),
        },
      }));
    });
    requestFrame(viewer);
  }, [ready, cityData, triggerPoints, floodLevel]);

  /* ---------------------------------------------------------- endpoints */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer || !cityData) return;
    store.endpoints.forEach((entity) => viewer.entities.remove(entity));
    store.endpoints = [];
    const origin = cityData.nodes.find((node) => node.id === originNode);
    const marker = (id: string, lat: number, lon: number, color: string, text: string) => viewer.entities.add({
      id,
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: { pixelSize: 15, color: css(color), outlineColor: css(COLOR.ground), outlineWidth: 3, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: {
        text,
        font: `700 12px ${store.fonts.sans}`,
        fillColor: css(COLOR.ink),
        showBackground: true,
        backgroundColor: css(COLOR.ground, 0.92),
        backgroundPadding: new Cesium.Cartesian2(7, 4),
        pixelOffset: new Cesium.Cartesian2(0, -24),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    if (origin) store.endpoints.push(marker('operator-origin', origin.lat, origin.lon, COLOR.safe, 'Start'));
    if (route?.success) {
      const destination = cityData.nodes.find((node) => node.id === route.dest_node);
      if (destination) {
        store.endpoints.push(marker('operator-destination', destination.lat, destination.lon, COLOR.signal, route.destination_name || cityData.exit_names?.[String(route.dest_node)] || 'Exit'));
      }
    }
    requestFrame(viewer);
  }, [ready, cityData, originNode, route]);

  /* ----------------------------------------------------- device location */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer) return;
    store.user.forEach((entity) => viewer.entities.remove(entity));
    store.user = [];
    if (userLocation) {
      const { fix } = userLocation;
      const at = Cesium.Cartesian3.fromDegrees(fix.lon, fix.lat);
      const clamp = { heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY };
      store.user.push(viewer.entities.add({
        id: 'user-accuracy',
        position: at,
        ellipse: { semiMajorAxis: Math.max(4, fix.accuracy), semiMinorAxis: Math.max(4, fix.accuracy), material: css(COLOR.user, 0.14), classificationType: Cesium.ClassificationType.TERRAIN },
      }));
      if (userLocation.active && userLocation.accessPath.length >= 2) {
        // The short leg from where you stand, along the street, to the junction the route starts at.
        store.user.push(viewer.entities.add({
          id: 'user-access',
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(userLocation.accessPath.flatMap(([lat, lon]) => [lon, lat])),
            width: 4,
            clampToGround: true,
            zIndex: 5,
            material: new Cesium.PolylineDashMaterialProperty({ color: css(COLOR.user), gapColor: css(COLOR.ground, 0.55), dashLength: 8 }),
          },
        }));
      }
      const pulse = !prefersReducedMotion();
      store.user.push(viewer.entities.add({
        id: 'user-halo',
        position: at,
        point: {
          pixelSize: pulse ? new Cesium.CallbackProperty(() => 18 + 18 * ((performance.now() / 1800) % 1), false) as any : 26,
          color: pulse ? new Cesium.CallbackProperty(() => css(COLOR.user, 0.45 * (1 - ((performance.now() / 1800) % 1))), false) as any : css(COLOR.user, 0.25),
          ...clamp,
        },
      }));
      store.user.push(viewer.entities.add({
        id: 'user-position',
        position: at,
        point: { pixelSize: 14, color: css(COLOR.user), outlineColor: css('#ffffff'), outlineWidth: 3, ...clamp },
        label: {
          text: userLocation.active ? 'You' : 'You (start chosen by hand)',
          font: `700 12px ${store.fonts.sans}`,
          fillColor: css(COLOR.ink),
          showBackground: true,
          backgroundColor: css(COLOR.ground, 0.92),
          backgroundPadding: new Cesium.Cartesian2(7, 4),
          pixelOffset: new Cesium.Cartesian2(0, -24),
          ...clamp,
        },
      }));
    }
    requestFrame(viewer);
  }, [ready, userLocation]);

  /* ------------------------------------------------------ step highlight */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer || !cityData) return;
    store.highlight.forEach((entity) => viewer.entities.remove(entity));
    store.highlight = [];
    const step = highlightedStep !== null ? route?.route_steps[highlightedStep] : undefined;
    if (route?.success && step) {
      const start = route.path.indexOf(step.from_node);
      const end = route.path.indexOf(step.to_node, start + 1);
      if (start >= 0 && end > start) {
        const nodes = new Map(cityData.nodes.map((node) => [node.id, node]));
        const coordinates: number[] = [];
        for (let i = start; i < end; i += 1) {
          const a = route.path[i];
          const b = route.path[i + 1];
          const record = store.roads.get(edgeKey(a, b));
          if (!record) continue;
          edgePoints(nodes, a, b, record.edge).forEach(([lat, lon]) => coordinates.push(lon, lat));
        }
        if (coordinates.length >= 4) {
          const width = (store.routeWidth || 8) + 4;
          store.highlight.push(viewer.entities.add({ id: 'step-highlight', polyline: { positions: Cesium.Cartesian3.fromDegreesArray(coordinates), width, clampToGround: true, zIndex: 5, material: css('#fff6ea') } }));
        }
      }
    }
    requestFrame(viewer);
  }, [ready, cityData, route, highlightedStep]);

  /* ------------------------------------------------ shelters + substations */
  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer) return;
    store.shelters.forEach((group, id) => {
      const active = destinationId === id;
      group.marker.point.pixelSize = new Cesium.ConstantProperty(active ? 17 : 12);
      group.marker.point.outlineColor = new Cesium.ConstantProperty(css(active ? COLOR.ink : COLOR.ground));
    });
    requestFrame(viewer);
  }, [ready, cityData, destinationId]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer) return;
    const loads = useSimulationStore.getState().substationLoads;
    const offline = new Set([...failedSubstations, ...(route?.cascaded_substations ?? []), ...(route?.flooded_substations ?? [])]);
    store.substations.forEach((group) => {
      const load = loads[group.sub.id] ?? group.sub.base_load_mw;
      const color = offline.has(group.sub.id) ? COLOR.critical : load > group.sub.capacity_mw ? COLOR.watch : COLOR.safe;
      group.beacon.point.color = new Cesium.ConstantProperty(css(color));
    });
    requestFrame(viewer);
  }, [ready, cityData, failedSubstations, route, loadSignature]);

  /* --------------------------------------------------------------- flights */
  const flyToPoint = useCallback((lon: number, lat: number, range: number, pitchDegrees?: number, heading?: number) => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const pitch = pitchDegrees ?? (tiltedRef.current ? -42 : -86);
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat), 40), {
      offset: new Cesium.HeadingPitchRange(heading ?? viewer.camera.heading, Cesium.Math.toRadians(pitch), range),
      duration: prefersReducedMotion() ? 0 : 1.1,
    });
  }, []);

  useEffect(() => {
    if (!ready || flyToNodeId === null || !cityData) return;
    const node = cityData.nodes.find((item) => item.id === flyToNodeId);
    if (node) flyToPoint(node.lon, node.lat, 950);
    useSimulationStore.getState().setFlyToNodeId(null);
  }, [ready, cityData, flyToNodeId, flyToPoint]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const store = layers.current;
    if (!ready || !viewer || !flyToRoadKey || !cityData) return;
    useSimulationStore.getState().setFlyToRoadKey(null);
    const record = store.roads.get(flyToRoadKey);
    if (!record) return;
    const nodes = new Map(cityData.nodes.map((node) => [node.id, node]));
    const points = edgePoints(nodes, record.edge.source, record.edge.target, record.edge);
    const [lat, lon] = points[Math.floor(points.length / 2)];
    flyToPoint(lon, lat, 800);
    if (record.state === null) {
      record.state = 'search';
      styleRoad(record, store.basemap);
    }
    const timer = window.setTimeout(() => {
      if (viewer.isDestroyed() || record.state !== 'search') return;
      record.state = null;
      styleRoad(record, store.basemap);
      requestFrame(viewer);
    }, 4200);
    return () => window.clearTimeout(timer);
  }, [ready, cityData, flyToRoadKey, flyToPoint]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer || !flyToCoords) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(flyToCoords.lon, flyToCoords.lat, flyToCoords.elev),
      orientation: { heading: Cesium.Math.toRadians(flyToCoords.heading ?? 0), pitch: Cesium.Math.toRadians(flyToCoords.pitch ?? -60), roll: 0 },
      duration: prefersReducedMotion() ? 0 : 1.4,
    });
    useSimulationStore.getState().setFlyToCoords(null);
  }, [ready, flyToCoords]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer) return;
    viewer.scene.canvas.style.cursor = closureMode ? 'crosshair' : 'default';
  }, [ready, closureMode]);

  /* -------------------------------------------------------------- tools */
  const viewCenter = () => {
    const viewer = viewerRef.current;
    const canvas = viewer.scene.canvas;
    const position = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const ray = viewer.camera.getPickRay(position);
    return (ray && viewer.scene.globe.pick(ray, viewer.scene)) || viewer.camera.pickEllipsoid(position) || Cesium.Cartesian3.fromDegrees(-95.3698, 29.7604);
  };

  const orbit = (pitchDegrees: number, heading?: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const center = viewCenter();
    const range = Math.min(9000, Math.max(500, Cesium.Cartesian3.distance(viewer.camera.positionWC, center)));
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, 1), {
      offset: new Cesium.HeadingPitchRange(heading ?? viewer.camera.heading, Cesium.Math.toRadians(pitchDegrees), range),
      duration: prefersReducedMotion() ? 0 : 0.9,
    });
  };

  const toggleFullscreen = () => {
    const consoleElement = containerRef.current?.closest('.map-console') as HTMLElement | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void consoleElement?.requestFullscreen?.();
  };

  const flooded = route?.flooded_nodes.length ?? 0;

  return (
    <div className="map-surface">
      <div ref={containerRef} className={`cesium-map-surface ${closureMode ? 'is-closing' : ''}`} role="application" aria-label="Map of downtown Houston streets, flood surface, utilities, and the recommended corridor" />
      {!ready && !error && (
        <div className="map-loading" role="status">
          <span className="map-loading-rings" aria-hidden="true"><i /><i /><i /></span>
          <span>Loading the 3D map</span>
        </div>
      )}
      {error && <div className="map-error" role="alert">{error}</div>}

      <div className="map-overlay map-hud" aria-live="polite">
        <i className={isLoading ? 'is-busy' : ''} />
        {isLoading ? 'Solving' : cityData ? `${cityData.edges.length.toLocaleString()} streets, ${flooded.toLocaleString()} junctions under water` : 'Loading'}
      </div>

      <div className="map-overlay map-tools" role="toolbar" aria-label="Map tools">
        <button className={`map-tool map-tool--locate ${userLocation?.active ? 'is-active' : ''}`} aria-pressed={Boolean(userLocation?.active)} aria-busy={locationStatus === 'requesting'} onClick={() => void locateUser()} disabled={locationStatus === 'requesting'}>
          <Icon name="locate" size={18} /><span className="map-tool-label">{locationStatus === 'requesting' ? 'Finding your location…' : 'Use my location'}</span>
        </button>
        <button className={`map-tool ${closureMode ? 'is-active' : ''}`} aria-pressed={closureMode} aria-keyshortcuts="C" onClick={() => setClosureMode(!closureMode)}>
          <Icon name="barrier" size={18} /><span className="map-tool-label">Close streets (C)</span>
        </button>
        <button className={`map-tool ${tilted ? 'is-active' : ''}`} aria-pressed={tilted} onClick={() => orbit(tilted ? -89 : -40)} disabled={!ready}>
          <Icon name="cube" size={18} /><span className="map-tool-label">{tilted ? 'Top-down view' : '3D view'}</span>
        </button>
        <button className="map-tool" onClick={() => orbit(tiltedRef.current ? -40 : -89, 0)} disabled={!ready}>
          <span className="map-compass" ref={compassRef}><Icon name="arrowUp" size={18} /></span><span className="map-tool-label">North up</span>
        </button>
        <button className="map-tool" onClick={() => flyToPoint(cityData?.center_lon ?? -95.3698, cityData?.center_lat ?? 29.7604, 5600, -89, 0)} disabled={!ready}>
          <Icon name="compass" size={18} /><span className="map-tool-label">District overview</span>
        </button>
        <button className="map-tool" onClick={toggleFullscreen}>
          <Icon name="expand" size={18} /><span className="map-tool-label">Full screen</span>
        </button>
      </div>

      {closureMode ? (
        <div className="map-overlay map-hint" role="status">Click a street to close it, or a closure to reopen it. Press Esc when done.</div>
      ) : locationMessage && locationStatus !== 'located' ? (
        <div className="map-overlay map-hint map-hint--info" role="status">
          <span>{locationMessage}</span>
          <button className="map-hint-close" onClick={dismissLocationMessage} aria-label="Dismiss"><Icon name="close" size={14} /></button>
        </div>
      ) : null}

      <div className="map-overlay map-legend" aria-label="Legend">
        <span><i className="lg lg-route" />Route</span>
        <span><i className="lg lg-water" />Water</span>
        <span><i className="lg lg-closed" />Closed</span>
        <span><i className="lg lg-exit" />Exit</span>
        <span><i className="lg lg-shelter" />Shelter</span>
        <span><i className="lg lg-medical" />Medical</span>
        <span><i className="lg lg-trigger" />Trigger point</span>
        {userLocation && <span><i className="lg lg-you" />You</span>}
      </div>

      <div className="map-overlay map-statusbar">
        <span className="map-scale"><i ref={scaleBarRef as React.RefObject<HTMLElement>} /><b ref={scaleLabelRef as React.RefObject<HTMLElement>}>-</b></span>
        <span className="map-coord mono" ref={usngRef}>USNG: move the pointer over the map</span>
        <span className="map-coord mono" ref={latLonRef} />
        <span className="map-coord" ref={groundRef} />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- helpers */

const diamondCache = new Map<string, HTMLCanvasElement>();
function diamondImage(color: string) {
  let canvas = diamondCache.get(color);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d')!;
    context.translate(16, 16);
    context.rotate(Math.PI / 4);
    context.fillStyle = '#0a1115';
    context.fillRect(-11, -11, 22, 22);
    context.fillStyle = color;
    context.fillRect(-8, -8, 16, 16);
    diamondCache.set(color, canvas);
  }
  return canvas;
}

function renderCity(viewer: any, city: CityData, store: Layers) {
  const entities = viewer.entities;
  const nodes = new Map(city.nodes.map((node) => [node.id, node]));
  const fonts = store.fonts;
  entities.suspendEvents();
  try {
    // Parks and buildings: real OpenStreetMap footprints, extruded in place.
    (city.parks ?? []).forEach((park) => {
      if (park.footprint.length < 3) return;
      store.parks.push(entities.add({
        id: park.id,
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(park.footprint.flatMap(([lat, lon]) => [lon, lat])),
          material: css(COLOR.park, 0.24),
          classificationType: Cesium.ClassificationType.TERRAIN,
        },
      }));
    });
    const palette = BUILDING_PALETTE[store.basemap];
    city.blocks.forEach((block) => {
      if (block.footprint.length < 3) return;
      const lat = block.footprint.reduce((sum, [value]) => sum + value, 0) / block.footprint.length;
      const lon = block.footprint.reduce((sum, [, value]) => sum + value, 0) / block.footprint.length;
      store.buildings.push({
        lat,
        lon,
        tint: 'base',
        entity: entities.add({
          id: block.id,
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(block.footprint.flatMap(([pointLat, pointLon]) => [pointLon, pointLat])),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            extrudedHeight: block.height_m,
            extrudedHeightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            material: css(palette.base, palette.alpha),
          },
        }),
      });
    });

    (city.waterways ?? []).forEach((way) => {
      if (way.coords.length < 2) return;
      store.waterways.push(entities.add({
        id: way.id,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(way.coords.flatMap(([lat, lon]) => [lon, lat])),
          width: way.name === 'Buffalo Bayou' || way.name === 'White Oak Bayou' ? 4 : 2.5,
          clampToGround: true,
          zIndex: 1,
          material: css(COLOR.water, 0.8),
        },
      }));
    });

    const labelCounts = new Map<string, number>();
    city.edges.forEach((edge) => {
      const points = edgePoints(nodes, edge.source, edge.target, edge);
      const entity = entities.add({
        id: `road-${edge.source}-${edge.target}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(points.flatMap(([lat, lon]) => [lon, lat])),
          clampToGround: true,
          zIndex: 2,
        },
      });
      const record: RoadRecord = { entity, edge, state: null, styled: '' };
      styleRoad(record, store.basemap);
      store.roads.set(edgeKey(edge.source, edge.target), record);
      const named = edge.road_name !== 'Unnamed street' && !edge.road_name.startsWith('Freeway ramp') && !edge.road_name.startsWith('Connector ramp');
      if (named && (edge.road_class === 'arterial' || edge.road_class === 'collector') && edge.distance_m > 120 && (labelCounts.get(edge.road_name) ?? 0) < 3) {
        labelCounts.set(edge.road_name, (labelCounts.get(edge.road_name) ?? 0) + 1);
        const [lat, lon] = points[Math.floor(points.length / 2)];
        store.labels.push(entities.add({
          id: `road-label-${edge.source}-${edge.target}`,
          position: Cesium.Cartesian3.fromDegrees(lon, lat),
          show: false,
          label: {
            text: edge.road_name,
            font: `600 12px ${fonts.sans}`,
            fillColor: css(COLOR.ink),
            outlineColor: css(COLOR.ground),
            outlineWidth: 4,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2400),
          },
        }));
      }
    });

    // Real junctions only: degree >= 3, plus exits and shelter approaches.
    const exitNames = city.exit_names ?? {};
    const { ids, positions } = logicalJunctions(city, city.safe_exits);
    const pulse = !prefersReducedMotion();
    city.nodes.forEach((node) => {
      if (!ids.has(node.id)) return;
      const at = positions.get(node.id) ?? node;
      const exitName = exitNames[String(node.id)];
      if (exitName) {
        const halo = entities.add({
          id: `halo-${node.id}`,
          position: Cesium.Cartesian3.fromDegrees(at.lon, at.lat),
          point: {
            pixelSize: pulse ? new Cesium.CallbackProperty(() => 30 + 10 * ((performance.now() / 1600) % 1), false) as any : 32,
            color: pulse ? new Cesium.CallbackProperty(() => css(COLOR.safe, 0.32 * (1 - ((performance.now() / 1600) % 1))), false) as any : css(COLOR.safe, 0.18),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        store.halos.push(halo);
      }
      const entity = entities.add({
        id: `node-${node.id}`,
        position: Cesium.Cartesian3.fromDegrees(at.lon, at.lat),
        point: {
          pixelSize: exitName ? 13 : 5,
          color: css(exitName ? COLOR.safe : '#6e7f86'),
          outlineColor: css(COLOR.ground),
          outlineWidth: exitName ? 3 : 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: exitName ? undefined : new Cesium.DistanceDisplayCondition(0, 2600),
        },
        label: exitName ? {
          text: exitName,
          font: `700 12px ${fonts.sans}`,
          fillColor: css('#bff3da'),
          showBackground: true,
          backgroundColor: css(COLOR.ground, 0.9),
          backgroundPadding: new Cesium.Cartesian2(7, 4),
          pixelOffset: new Cesium.Cartesian2(0, -22),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        } : undefined,
      });
      store.nodes.set(node.id, entity);
      // Invisible twin keeps junctions clickable when the dots are hidden.
      store.pickNodes.push(entities.add({
        id: `pick-node-${node.id}`,
        position: Cesium.Cartesian3.fromDegrees(at.lon, at.lat),
        point: { pixelSize: 10, color: Cesium.Color.TRANSPARENT, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }));
    });

    city.substations.forEach((sub) => {
      const base = entities.add({
        id: `substation-pad-${sub.id}`,
        position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat),
        ellipse: { semiMajorAxis: 36, semiMinorAxis: 36, material: css(COLOR.utility, 0.25), classificationType: Cesium.ClassificationType.TERRAIN },
      });
      const beacon = entities.add({
        id: `substation-${sub.id}`,
        position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat),
        point: { pixelSize: 10, color: css(COLOR.safe), outlineColor: css(COLOR.ground), outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: sub.name,
          font: `600 12px ${fonts.sans}`,
          fillColor: css('#f1e5b8'),
          showBackground: true,
          backgroundColor: css(COLOR.ground, 0.88),
          backgroundPadding: new Cesium.Cartesian2(7, 4),
          pixelOffset: new Cesium.Cartesian2(0, -18),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3200),
        },
      });
      store.substations.set(sub.id, { entities: [base, beacon], beacon, sub });
    });

    city.transmission_links.forEach((link) => {
      const from = city.substations.find((sub) => sub.id === link.from_sub);
      const to = city.substations.find((sub) => sub.id === link.to_sub);
      if (!from || !to) return;
      store.transmission.push(entities.add({
        id: `transmission-${link.id}`,
        show: false,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray([from.lon, from.lat, to.lon, to.lat]),
          width: 2.5,
          clampToGround: true,
          zIndex: 1,
          material: new Cesium.PolylineDashMaterialProperty({ color: css(COLOR.utility, 0.75), dashLength: 16 }),
        },
      }));
    });

    // Destinations at their real facility coordinates, not the snapped junction.
    (city.shelters ?? []).forEach((shelter) => {
      const color = shelter.kind === 'medical' ? COLOR.medical : COLOR.shelter;
      const halo = entities.add({
        id: `shelter-halo-${shelter.id}`,
        position: Cesium.Cartesian3.fromDegrees(shelter.lon, shelter.lat),
        point: { pixelSize: 30, color: css(color, 0.18), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
      const marker = entities.add({
        id: `shelter-${shelter.id}`,
        position: Cesium.Cartesian3.fromDegrees(shelter.lon, shelter.lat),
        point: { pixelSize: 12, color: css(color), outlineColor: css(COLOR.ground), outlineWidth: 3, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: shelter.name,
          font: `700 12px ${fonts.sans}`,
          fillColor: css(color),
          showBackground: true,
          backgroundColor: css(COLOR.ground, 0.88),
          backgroundPadding: new Cesium.Cartesian2(7, 4),
          pixelOffset: new Cesium.Cartesian2(0, -22),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4200),
        },
      });
      store.shelters.set(shelter.id, { marker, halo });
    });
  } finally {
    entities.resumeEvents();
  }

  if (CESIUM_TOKEN) {
    // Cesium OSM Buildings add the rest of the skyline beyond the baked footprints.
    void Cesium.createOsmBuildingsAsync().then((tileset: any) => {
      if (viewer.isDestroyed()) return;
      tileset.style = new Cesium.Cesium3DTileStyle({ color: 'color("#5d7580", 0.35)' });
      tileset.show = useSimulationStore.getState().showBuildings;
      viewer.scene.primitives.add(tileset);
    }).catch(() => { /* baked footprints remain */ });
  }
}
