'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type * as CesiumType from 'cesium';
import { useSimulationStore } from '@/hooks/useSimulation';
import type { CityData, EdgeData, NodeData, SubstationData } from '@/lib/types';

declare const Cesium: typeof CesiumType;

type RoadEntity = { entity: any; edge: EdgeData };
type SubstationEntities = { entities: any[]; beacon: any; sub: SubstationData };

type FlyCoordinates = {
  lon: number;
  lat: number;
  elev: number;
  heading?: number;
  pitch?: number;
};

const CENTER = { lat: 29.7604, lon: -95.3698 };
const SAFE_EXITS: Record<number, string> = {
  7: 'South exit',
  105: 'West exit',
  119: 'East exit',
  217: 'North exit',
};
const CESIUM_TOKEN = process.env.NEXT_PUBLIC_CESIUM_TOKEN ?? '';

export default function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const loadedRef = useRef(false);
  const [viewerReady, setViewerReady] = useState(false);

  const roadEntitiesRef = useRef<Map<string, RoadEntity>>(new Map());
  const nodeEntitiesRef = useRef<Map<number, any>>(new Map());
  const buildingEntitiesRef = useRef<any[]>([]);
  const buildingTilesRef = useRef<any>(null);
  const roadLabelEntitiesRef = useRef<any[]>([]);
  const substationEntitiesRef = useRef<Map<number, SubstationEntities>>(new Map());
  const transmissionEntitiesRef = useRef<any[]>([]);
  const floodEntitiesRef = useRef<any[]>([]);
  const blackoutEntitiesRef = useRef<any[]>([]);
  const routeEntitiesRef = useRef<any[]>([]);
  const staticRenderedRef = useRef(false);
  const clickHandlerRef = useRef<any>(null);

  const {
    cityData,
    route,
    floodLevel,
    failedSubstations,
    substationLoads,
    showBuildings,
    showPowerLines,
    showSubstations,
    showIntersections,
    showRoadNames,
    originNode,
    flyToNodeId,
    setFlyToNodeId,
    flyToCoords,
    setFlyToCoords,
    mapFilterMode,
  } = useSimulationStore();

  const loadCesiumScript = useCallback((): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (typeof window === 'undefined') {
        reject(new Error('Cesium cannot load during server rendering'));
        return;
      }
      if ((window as any).Cesium) {
        resolve();
        return;
      }

      const base = 'https://unpkg.com/cesium@1.119.0/Build/Cesium/';
      const cssId = 'gridevac-cesium-css';
      const scriptId = 'gridevac-cesium-js';
      let link = document.getElementById(cssId) as HTMLLinkElement | null;
      if (!link) {
        link = document.createElement('link');
        link.id = cssId;
        link.rel = 'stylesheet';
        document.head.appendChild(link);
      }
      link.href = `${base}Widgets/widgets.css`;

      const script = document.createElement('script');
      script.id = scriptId;
      script.src = `${base}Cesium.js`;
      script.onload = () => ((window as any).Cesium ? resolve() : reject(new Error('Cesium global was not created')));
      script.onerror = () => reject(new Error('CesiumJS failed to load'));
      document.head.appendChild(script);
    });
  }, []);

  useEffect(() => {
    if (loadedRef.current || !containerRef.current) return;
    loadedRef.current = true;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    const roadEntities = roadEntitiesRef.current;
    const nodeEntities = nodeEntitiesRef.current;
    const substationEntities = substationEntitiesRef.current;

    const initialise = async () => {
      try {
        await loadCesiumScript();
        if (disposed || !containerRef.current) return;

        if (CESIUM_TOKEN.trim()) {
          Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;
        }

        const viewer = new Cesium.Viewer(containerRef.current, {
          baseLayer: new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })),
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
          requestRenderMode: false,
          shadows: false,
        });
        viewerRef.current = viewer;

        const baseLayer = viewer.imageryLayers.get(0);
        if (baseLayer) {
          baseLayer.brightness = 0.82;
          baseLayer.contrast = 1.04;
          baseLayer.saturation = 0.3;
        }
        viewer.scene.globe.depthTestAgainstTerrain = false;
        viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#dbe5e1');
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(CENTER.lon, CENTER.lat, 4300),
          orientation: {
            heading: Cesium.Math.toRadians(8),
            pitch: Cesium.Math.toRadians(-62),
            roll: 0,
          },
        });

        // World terrain is optional: the street model remains fully usable without an Ion token.
        if (CESIUM_TOKEN.trim() && (Cesium as any).Terrain?.fromWorldTerrain && (viewer.scene as any).setTerrain) {
          try {
            (viewer.scene as any).setTerrain((Cesium as any).Terrain.fromWorldTerrain({ requestVertexNormals: true }));
          } catch {
            // The ellipsoid fallback is intentionally silent; synthetic elevations still render correctly.
          }
        }

        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        clickHandlerRef.current = handler;
        handler.setInputAction((movement: any) => {
          const picked = viewer.scene.pick(movement.position);
          const pickedId = picked?.id?.id ?? picked?.id;
          if (typeof pickedId !== 'string' || !pickedId.startsWith('node-')) return;
          const nodeId = Number(pickedId.replace('node-', ''));
          const current = useSimulationStore.getState();
          const node = current.cityData?.nodes.find((item) => item.id === nodeId);
          if (!node) return;
          if (node.elevation <= current.floodLevel * 1.7) {
            current.addLog(`Node ${nodeId} is below the modeled flood surface; choose a dry intersection.`);
            return;
          }
          current.setOriginNode(nodeId);
          current.addLog(`Map selection: ${node.intersection_name} set as route origin.`);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        resizeObserver = new ResizeObserver(() => {
          if (!viewer.isDestroyed()) viewer.resize();
        });
        resizeObserver.observe(containerRef.current);
        setViewerReady(true);
      } catch (error) {
        console.error('[GridEvac] Cesium initialisation failed:', error);
        setViewerReady(false);
      }
    };

    void initialise();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (clickHandlerRef.current && !clickHandlerRef.current.isDestroyed()) {
        clickHandlerRef.current.destroy();
      }
      clickHandlerRef.current = null;
      if (viewerRef.current && !viewerRef.current.isDestroyed()) viewerRef.current.destroy();
      viewerRef.current = null;
      roadEntities.clear();
      nodeEntities.clear();
      substationEntities.clear();
      buildingEntitiesRef.current = [];
      roadLabelEntitiesRef.current = [];
      transmissionEntitiesRef.current = [];
      floodEntitiesRef.current = [];
      blackoutEntitiesRef.current = [];
      routeEntitiesRef.current = [];
      buildingTilesRef.current = null;
      staticRenderedRef.current = false;
      loadedRef.current = false;
      setViewerReady(false);
    };
  }, [loadCesiumScript]);

  useEffect(() => {
    if (!viewerReady || !viewerRef.current || !cityData || staticRenderedRef.current) return;
    staticRenderedRef.current = true;
    renderStaticCity(viewerRef.current, cityData, {
      roadEntitiesRef,
      nodeEntitiesRef,
      buildingEntitiesRef,
      roadLabelEntitiesRef,
      substationEntitiesRef,
      transmissionEntitiesRef,
      buildingTilesRef,
    });
  }, [cityData, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    buildingEntitiesRef.current.forEach((entity) => { entity.show = showBuildings; });
    if (buildingTilesRef.current) buildingTilesRef.current.show = showBuildings;
  }, [showBuildings, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    transmissionEntitiesRef.current.forEach((entity) => { entity.show = showPowerLines; });
    substationEntitiesRef.current.forEach((group) => {
      group.entities.forEach((entity) => { entity.show = showSubstations; });
    });
    nodeEntitiesRef.current.forEach((entity) => { entity.show = showIntersections; });
    roadLabelEntitiesRef.current.forEach((entity) => { entity.show = showRoadNames; });
  }, [showPowerLines, showSubstations, showIntersections, showRoadNames, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cityData) return;
    clearEntities(viewer, floodEntitiesRef.current);
    floodEntitiesRef.current = [];

    const flooded = new Set(route?.flooded_nodes ?? cityData.nodes.filter((node) => node.elevation <= floodLevel * 1.7).map((node) => node.id));
    if (flooded.size === 0) return;

    flooded.forEach((nodeId) => {
      const node = cityData.nodes.find((item) => item.id === nodeId);
      if (!node) return;
      const entity = viewer.entities.add({
        id: `flood-node-${nodeId}`,
        position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat, 0),
        ellipse: {
          semiMajorAxis: 108,
          semiMinorAxis: 82,
          height: 0,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          material: Cesium.Color.fromCssColorString('#4c9fba').withAlpha(0.2),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#438ca9').withAlpha(0.55),
          outlineWidth: 1,
        },
      });
      floodEntitiesRef.current.push(entity);
    });
  }, [cityData, floodLevel, route, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cityData) return;
    clearEntities(viewer, blackoutEntitiesRef.current);
    blackoutEntitiesRef.current = [];

    const activeIds = new Set([...(failedSubstations ?? []), ...(route?.cascaded_substations ?? [])]);
    activeIds.forEach((subId) => {
      const sub = cityData.substations.find((item) => item.id === subId);
      if (!sub) return;
      const ellipse = viewer.entities.add({
        id: `blackout-zone-${subId}`,
        position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 0),
        ellipse: {
          semiMajorAxis: Math.max(130, sub.radius * 62),
          semiMinorAxis: Math.max(100, sub.radius * 48),
          height: 0,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          material: Cesium.Color.fromCssColorString('#c85a4d').withAlpha(0.11),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#bb4d44').withAlpha(0.75),
          outlineWidth: 2,
        },
      });
      const label = viewer.entities.add({
        id: `blackout-label-${subId}`,
        position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 28),
        label: {
          text: 'POWER OUTAGE',
          font: '600 10px DM Mono, monospace',
          fillColor: Cesium.Color.fromCssColorString('#a8403a'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: Cesium.Color.WHITE.withAlpha(0.86),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
        },
      });
      blackoutEntitiesRef.current.push(ellipse, label);
    });
  }, [cityData, failedSubstations, route, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    clearEntities(viewer, routeEntitiesRef.current);
    routeEntitiesRef.current = [];

    // Return roads to their base class colors before adding scenario overlays.
    roadEntitiesRef.current.forEach(({ entity, edge }) => styleRoad(entity, edge, null));
    if (!route) return;

    const hazardStates = new Map<string, string>();
    Object.entries(route.hazard_roads ?? {}).forEach(([key, state]) => hazardStates.set(normalizeEdgeKey(key), state));
    roadEntitiesRef.current.forEach(({ entity, edge }) => {
      const key = `${edge.source}-${edge.target}`;
      const reverse = `${edge.target}-${edge.source}`;
      const state = hazardStates.get(normalizeEdgeKey(key)) ?? hazardStates.get(normalizeEdgeKey(reverse));
      styleRoad(entity, edge, state ?? null);
    });
    route.blocked_edges.forEach(([source, target]) => {
      const road = roadEntitiesRef.current.get(normalizeEdgeKey(`${source}-${target}`));
      if (road) styleRoad(road.entity, road.edge, 'blocked');
    });

    if (!route.success || route.path_coords.length < 2) return;
    const positions = route.path_coords.flatMap((coord) => [coord.lon, coord.lat]);
    const underlay = viewer.entities.add({
      id: 'evacuation-route-underlay',
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(positions),
        width: 16,
        clampToGround: true,
        material: Cesium.Color.fromCssColorString('#193a38').withAlpha(0.62),
        depthFailMaterial: Cesium.Color.fromCssColorString('#193a38').withAlpha(0.42),
      },
    });
    const routeLine = viewer.entities.add({
      id: 'evacuation-route',
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(positions),
        width: 8,
        clampToGround: true,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.18,
          taperPower: 0.7,
          color: Cesium.Color.fromCssColorString('#f0a94a'),
        }),
        depthFailMaterial: Cesium.Color.fromCssColorString('#f0a94a').withAlpha(0.8),
      },
    });
    routeEntitiesRef.current.push(underlay, routeLine);

    route.path_coords.forEach((coord, index) => {
      if (index === 0 || index === route.path_coords.length - 1 || index % 3 === 0) {
        const marker = viewer.entities.add({
          id: `route-waypoint-${index}`,
          position: Cesium.Cartesian3.fromDegrees(coord.lon, coord.lat, 7),
          point: {
            pixelSize: index === 0 || index === route.path_coords.length - 1 ? 10 : 5,
            color: Cesium.Color.fromCssColorString(index === 0 ? '#1b8c68' : '#f0a94a'),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        routeEntitiesRef.current.push(marker);
      }
    });
  }, [route, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cityData) return;
    updateEndpointMarkers(viewer, cityData, route?.dest_node ?? -1, route?.success ?? false);
  }, [cityData, originNode, route?.dest_node, route?.success, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || flyToNodeId === null || !cityData) return;
    const entity = nodeEntitiesRef.current.get(flyToNodeId);
    if (!entity) return;
    viewer.flyTo(entity, {
      duration: 1.15,
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-63), 850),
    }).finally(() => setFlyToNodeId(null));
  }, [cityData, flyToNodeId, setFlyToNodeId, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !flyToCoords) return;
    const coords: FlyCoordinates = flyToCoords;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(coords.lon, coords.lat, coords.elev),
      orientation: {
        heading: Cesium.Math.toRadians(coords.heading ?? 0),
        pitch: Cesium.Math.toRadians(coords.pitch ?? -55),
        roll: 0,
      },
      duration: 1.4,
    });
    setFlyToCoords(null);
  }, [flyToCoords, setFlyToCoords, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const layer = viewer.imageryLayers.get(0);
    if (!layer) return;
    if (mapFilterMode === 'radar') {
      layer.brightness = 0.56;
      layer.contrast = 1.35;
      layer.saturation = 0.05;
    } else if (mapFilterMode === 'thermal') {
      layer.brightness = 0.68;
      layer.contrast = 1.16;
      layer.saturation = 0.15;
    } else {
      layer.brightness = 0.82;
      layer.contrast = 1.04;
      layer.saturation = 0.3;
    }
  }, [mapFilterMode, viewerReady]);

  // Keep substation beacons visually tied to live load without turning utility
  // structures into giant floating towers.
  useEffect(() => {
    substationEntitiesRef.current.forEach((group) => {
      const load = substationLoads[group.sub.id] ?? group.sub.base_load_mw;
      const failed = failedSubstations.includes(group.sub.id) || (route?.cascaded_substations ?? []).includes(group.sub.id);
      if (group.beacon?.point) {
        group.beacon.point.color = new Cesium.ConstantProperty(
          failed ? Cesium.Color.fromCssColorString('#c85a4d') : load > group.sub.capacity_mw ? Cesium.Color.fromCssColorString('#d18b32') : Cesium.Color.fromCssColorString('#2b9b73'),
        );
      }
    });
  }, [failedSubstations, route, substationLoads, viewerReady]);

  return <div ref={containerRef} className={`cesium-map-surface filter-${mapFilterMode}`} aria-label="Interactive Houston street and utility map" />;
}

function clearEntities(viewer: any, entities: any[]) {
  entities.forEach((entity) => viewer.entities.remove(entity));
}

function normalizeEdgeKey(key: string) {
  const [a, b] = key.split('-').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) ? `${Math.min(a, b)}-${Math.max(a, b)}` : key;
}

function styleRoad(entity: any, edge: EdgeData, state: string | null) {
  if (!entity?.polyline) return;
  let color = '#9aaea7';
  let width = 3;
  if (edge.road_class === 'arterial') {
    color = '#607d7a';
    width = 7;
  } else if (edge.road_class === 'collector') {
    color = '#819892';
    width = 5;
  }
  if (state === 'overloaded') {
    color = '#d18b32';
    width = 7;
  } else if (state === 'dead' || state === 'blocked') {
    color = '#bd5148';
    width = state === 'blocked' ? 8 : 6;
  }
  entity.polyline.material = new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString(color).withAlpha(0.9));
  entity.polyline.width = new Cesium.ConstantProperty(width);
}

function getNode(cityData: CityData, row: number, col: number): NodeData | undefined {
  return cityData.nodes.find((node) => node.row === row && node.col === col);
}

function blockFootprint(cityData: CityData, row: number, col: number) {
  const corners = [getNode(cityData, row, col), getNode(cityData, row + 1, col), getNode(cityData, row + 1, col + 1), getNode(cityData, row, col + 1)].filter(Boolean) as NodeData[];
  if (corners.length !== 4) return [];
  const center = {
    lat: corners.reduce((sum, node) => sum + node.lat, 0) / corners.length,
    lon: corners.reduce((sum, node) => sum + node.lon, 0) / corners.length,
  };
  // The inset leaves a visible road shoulder on all four sides of every block.
  return corners.map((corner) => ({
    lat: corner.lat + (center.lat - corner.lat) * 0.16,
    lon: corner.lon + (center.lon - corner.lon) * 0.16,
  }));
}

function renderStaticCity(
  viewer: any,
  cityData: CityData,
  refs: {
    roadEntitiesRef: MutableRefObject<Map<string, RoadEntity>>;
    nodeEntitiesRef: MutableRefObject<Map<number, any>>;
    buildingEntitiesRef: MutableRefObject<any[]>;
    roadLabelEntitiesRef: MutableRefObject<any[]>;
    substationEntitiesRef: MutableRefObject<Map<number, SubstationEntities>>;
    transmissionEntitiesRef: MutableRefObject<any[]>;
    buildingTilesRef: MutableRefObject<any>;
  },
) {
  // Blocks/buildings are rendered first and deliberately inset from their
  // surrounding road centerlines. This is the visual guarantee that routes do
  // not appear to cut through building footprints.
  cityData.blocks.forEach((block) => {
    const footprint = blockFootprint(cityData, block.row, block.col);
    if (footprint.length !== 4) return;
    const positions = Cesium.Cartesian3.fromDegreesArray(footprint.flatMap((point) => [point.lon, point.lat]));
    const isPark = block.kind === 'park';
    const building = viewer.entities.add({
      id: block.id,
      polygon: {
        hierarchy: positions,
        height: 0,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        extrudedHeight: isPark ? undefined : block.height_m,
        extrudedHeightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        material: isPark
          ? Cesium.Color.fromCssColorString('#8ebc9d').withAlpha(0.5)
          : Cesium.Color.fromCssColorString(block.kind === 'office' ? '#829aa0' : block.kind === 'retail' ? '#aa9d86' : '#8d9e95').withAlpha(0.72),
        outline: true,
        outlineColor: isPark ? Cesium.Color.fromCssColorString('#5f9b79') : Cesium.Color.fromCssColorString('#60736f').withAlpha(0.72),
        outlineWidth: 1,
      },
    });
    refs.buildingEntitiesRef.current.push(building);
    if (isPark) {
      const parkMarker = viewer.entities.add({
        id: `${block.id}-label`,
        position: Cesium.Cartesian3.fromDegrees(block.lon, block.lat, 3),
        label: {
          text: 'PARK',
          font: '600 9px DM Mono, monospace',
          fillColor: Cesium.Color.fromCssColorString('#467b60'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2500),
        },
      });
      refs.roadLabelEntitiesRef.current.push(parkMarker);
    }
  });

  cityData.edges.forEach((edge) => {
    const source = cityData.nodes.find((node) => node.id === edge.source);
    const target = cityData.nodes.find((node) => node.id === edge.target);
    if (!source || !target) return;
    const road = viewer.entities.add({
      id: `road-${edge.source}-${edge.target}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([source.lon, source.lat, target.lon, target.lat]),
        width: edge.road_class === 'arterial' ? 7 : edge.road_class === 'collector' ? 5 : 3,
        clampToGround: true,
        material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString(edge.road_class === 'arterial' ? '#607d7a' : edge.road_class === 'collector' ? '#819892' : '#9aaea7').withAlpha(0.9)),
      },
    });
    const key = normalizeEdgeKey(`${edge.source}-${edge.target}`);
    refs.roadEntitiesRef.current.set(key, { entity: road, edge });

    const shouldLabel = edge.road_class === 'arterial' || (edge.road_class === 'collector' && (source.row + source.col) % 3 === 0);
    if (shouldLabel) {
      const label = viewer.entities.add({
        id: `road-label-${edge.source}-${edge.target}`,
        position: Cesium.Cartesian3.fromDegrees((source.lon + target.lon) / 2, (source.lat + target.lat) / 2, 2),
        label: {
          text: edge.road_name,
          font: '600 9px DM Mono, monospace',
          fillColor: Cesium.Color.fromCssColorString('#536e69'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -6),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2100),
        },
      });
      refs.roadLabelEntitiesRef.current.push(label);
    }
  });

  cityData.nodes.forEach((node) => {
    const isExit = Boolean(SAFE_EXITS[node.id]);
    const entity = viewer.entities.add({
      id: `node-${node.id}`,
      position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat, 5),
      point: {
        pixelSize: isExit ? 8 : 4,
        color: Cesium.Color.fromCssColorString(isExit ? '#2b9b73' : '#668d86'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(300, 1, 5000, 0.4),
      },
      label: isExit ? {
        text: SAFE_EXITS[node.id],
        font: '700 10px DM Mono, monospace',
        fillColor: Cesium.Color.fromCssColorString('#23785a'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -15),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      } : undefined,
    });
    refs.nodeEntitiesRef.current.set(node.id, entity);
  });

  cityData.substations.forEach((sub) => {
    const node = cityData.nodes.find((item) => item.id === sub.node);
    if (!node) return;
    const group = renderSubstation(viewer, sub, node);
    refs.substationEntitiesRef.current.set(sub.id, group);
  });

  cityData.transmission_links.forEach((link) => {
    const from = cityData.substations.find((sub) => sub.id === link.from_sub);
    const to = cityData.substations.find((sub) => sub.id === link.to_sub);
    if (!from || !to) return;
    const fromNode = cityData.nodes.find((node) => node.id === from.node);
    const toNode = cityData.nodes.find((node) => node.id === to.node);
    if (!fromNode || !toNode) return;
    const positions: number[] = [];
    for (let index = 0; index <= 8; index += 1) {
      const t = index / 8;
      positions.push(
        from.lon + (to.lon - from.lon) * t,
        from.lat + (to.lat - from.lat) * t,
        18 + Math.max(fromNode.elevation, toNode.elevation) - 4 * Math.sin(Math.PI * t),
      );
    }
    const utility = viewer.entities.add({
      id: `transmission-${link.id}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(positions),
        width: 2.5,
        material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.12, color: Cesium.Color.fromCssColorString('#c18b3b').withAlpha(0.72) }),
        clampToGround: false,
      },
    });
    refs.transmissionEntitiesRef.current.push(utility);
  });

  if (CESIUM_TOKEN.trim()) {
    void Cesium.createOsmBuildingsAsync().then((tileset: any) => {
      if (!tileset || viewer.isDestroyed()) return;
      tileset.style = new Cesium.Cesium3DTileStyle({ color: 'color("#718c8d", 0.3)' });
      viewer.scene.primitives.add(tileset);
      refs.buildingTilesRef.current = tileset;
      tileset.show = useSimulationStore.getState().showBuildings;
    }).catch(() => {
      // Procedural inset footprints remain visible when the Ion building layer is unavailable.
    });
  }
}

function renderSubstation(viewer: any, sub: SubstationData, node: NodeData): SubstationEntities {
  const position = Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 5);
  const base = viewer.entities.add({
    id: `substation-base-${sub.id}`,
    position,
    ellipse: {
      semiMajorAxis: 32,
      semiMinorAxis: 22,
      height: 1,
      material: Cesium.Color.fromCssColorString('#c18b3b').withAlpha(0.2),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#b0782d').withAlpha(0.6),
      outlineWidth: 1,
    },
  });
  const transformer = viewer.entities.add({
    id: `substation-transformer-${sub.id}`,
    position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 10),
    box: {
      dimensions: new Cesium.Cartesian3(22, 16, 10),
      material: Cesium.Color.fromCssColorString('#b68135').withAlpha(0.78),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#7c5a2b'),
      outlineWidth: 1,
    },
  });
  const mast = viewer.entities.add({
    id: `substation-mast-${sub.id}`,
    position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 19),
    cylinder: {
      length: 18,
      topRadius: 1.5,
      bottomRadius: 2.8,
      material: Cesium.Color.fromCssColorString('#8a6d3b').withAlpha(0.8),
    },
  });
  const beacon = viewer.entities.add({
    id: `substation-beacon-${sub.id}`,
    position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 30),
    point: {
      pixelSize: 8,
      color: Cesium.Color.fromCssColorString('#2b9b73'),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: sub.name,
      font: '600 9px DM Mono, monospace',
      fillColor: Cesium.Color.fromCssColorString('#765824'),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -15),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      showBackground: true,
      backgroundColor: Cesium.Color.WHITE.withAlpha(0.82),
      backgroundPadding: new Cesium.Cartesian2(5, 3),
    },
  });
  return { entities: [base, transformer, mast, beacon], beacon, sub };
}

function updateEndpointMarkers(viewer: any, cityData: CityData, destination: number, routeSuccess: boolean) {
  const ids = ['operator-origin', 'operator-destination'];
  ids.forEach((id) => {
    const entity = viewer.entities.getById(id);
    if (entity) viewer.entities.remove(entity);
  });
  const origin = useSimulationStore.getState().originNode;
  const originNode = cityData.nodes.find((node) => node.id === origin);
  if (originNode) {
    viewer.entities.add({
      id: 'operator-origin',
      position: Cesium.Cartesian3.fromDegrees(originNode.lon, originNode.lat, 10),
      point: { pixelSize: 13, color: Cesium.Color.fromCssColorString('#1b8c68'), outlineColor: Cesium.Color.WHITE, outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: 'ORIGIN', font: '700 10px DM Mono, monospace', fillColor: Cesium.Color.fromCssColorString('#1b8c68'), outlineColor: Cesium.Color.WHITE, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -22), disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
  }
  if (!routeSuccess || destination < 0) return;
  const destinationNode = cityData.nodes.find((node) => node.id === destination);
  if (!destinationNode) return;
  viewer.entities.add({
    id: 'operator-destination',
    position: Cesium.Cartesian3.fromDegrees(destinationNode.lon, destinationNode.lat, 10),
    point: { pixelSize: 13, color: Cesium.Color.fromCssColorString('#f0a94a'), outlineColor: Cesium.Color.WHITE, outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: { text: `${SAFE_EXITS[destination] ?? 'EXIT'} ${destination}`, font: '700 10px DM Mono, monospace', fillColor: Cesium.Color.fromCssColorString('#a46c23'), outlineColor: Cesium.Color.WHITE, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -22), disableDepthTestDistance: Number.POSITIVE_INFINITY },
  });
}
