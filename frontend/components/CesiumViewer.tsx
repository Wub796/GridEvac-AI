'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type * as CesiumType from 'cesium';
import { useSimulationStore } from '@/hooks/useSimulation';
import type { BlockData, CityData, EdgeData, NodeData, ParkData, SubstationData } from '@/lib/types';

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
// Fallback labels for pre-data renders; the live labels come from the baked
// network's exit_names so they always match the current street graph.
const SAFE_EXITS: Record<number, string> = {};
const CESIUM_TOKEN = process.env.NEXT_PUBLIC_CESIUM_TOKEN ?? '';

export default function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const loadedRef = useRef(false);
  const [viewerReady, setViewerReady] = useState(false);

  const roadEntitiesRef = useRef<Map<string, RoadEntity>>(new Map());
  const nodeEntitiesRef = useRef<Map<number, any>>(new Map());
  const haloEntitiesRef = useRef<Map<number, any>>(new Map());
  // Invisible, always-pickable dots: click/hover targeting is decoupled from
  // whether intersections are visually shown, so the map stays clickable at
  // every zoom even with the dots hidden.
  const pickNodeEntitiesRef = useRef<Map<number, any>>(new Map());
  const buildingEntitiesRef = useRef<any[]>([]);
  const buildingTilesRef = useRef<any>(null);
  const roadLabelEntitiesRef = useRef<any[]>([]);
  const substationEntitiesRef = useRef<Map<number, SubstationEntities>>(new Map());
  const transmissionEntitiesRef = useRef<any[]>([]);
  const floodEntitiesRef = useRef<any[]>([]);
  const floodSettleTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const searchHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blackoutEntitiesRef = useRef<any[]>([]);
  const isochroneEntitiesRef = useRef<any[]>([]);
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
    flyToRoadKey,
    isochrone,
    isochroneVisible,
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
    const haloEntities = haloEntitiesRef.current;
    const pickNodeEntities = pickNodeEntitiesRef.current;

    const initialise = async () => {
      try {
        await loadCesiumScript();
        if (disposed || !containerRef.current) return;

        if (CESIUM_TOKEN.trim()) {
          Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;
        }

        // CARTO dark cartography: the light route corridor, hazard tints, and
        // glass overlays are the loudest elements on the deep basemap.
        const viewer = new Cesium.Viewer(containerRef.current, {
          baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
            url: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
            subdomains: ['a', 'b', 'c', 'd'],
            credit: '© OpenStreetMap contributors, © CARTO',
            maximumLevel: 19,
          })),
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
          // On-demand rendering: with requestRenderMode the scene only draws
          // when something changes (camera moves, entity edits, tiles load)
          // instead of redrawing 60 times a second while idle. Continuous
          // animations (marker pulses, flood rise-in) request their own frames
          // via viewer.clock.shouldAnimate, pumped in the render loop below.
          requestRenderMode: true,
          maximumRenderTimeChange: Infinity,
          shadows: false,
        });
        viewerRef.current = viewer;

        const baseLayer = viewer.imageryLayers.get(0);
        if (baseLayer) {
          baseLayer.brightness = 1.04;
          baseLayer.contrast = 1.05;
          baseLayer.saturation = 1.08;
        }
        viewer.scene.globe.depthTestAgainstTerrain = false;
        viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#050d0b');
        // Near-nadir camera: operational situational awareness reads best close to
        // top-down; the previous tilt hid streets behind building volumes.
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(CENTER.lon, CENTER.lat, 5200),
          orientation: {
            heading: 0,
            pitch: Cesium.Math.toRadians(-88),
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
        // Pick through overlapping geometry in a forgiving 12px window so a
        // click near a junction lands on the intersection, not the road under it.
        handler.setInputAction((movement: any) => {
          const current = useSimulationStore.getState();
          const exits = new Set(current.cityData?.safe_exits ?? []);
          const drills = viewer.scene.drillPick(movement.position, 8, 12, 12) ?? [];
          // Entity ids are `node-<id>` for visible dots and `pick-node-<id>`
          // for the invisible always-pickable dots.
          const nodeIdFromEntityId = (id: any): number | null => {
            if (typeof id !== 'string') return null;
            const match = /^(?:pick-)?node-(\d+)$/.exec(id);
            return match ? Number(match[1]) : null;
          };
          const pickedNodes = drills
            .map((item: any) => nodeIdFromEntityId(item?.id?.id ?? item?.id))
            .filter((id: any): id is number => id !== null);
          // Prefer a regular selectable intersection; exits are endpoints, not origins.
          const targetId = pickedNodes.find((id) => !exits.has(id)) ?? pickedNodes[0];
          if (targetId === undefined) return;
          const node = current.cityData?.nodes.find((item) => item.id === targetId);
          if (!node) return;
          if (node.elevation <= current.floodLevel * 1.7) {
            current.addLog(`${node.intersection_name} is below the modeled flood surface; choose a dry intersection.`);
            return;
          }
          current.setOriginNode(node.id);
          current.addLog(`Map selection: ${node.intersection_name} set as route origin.`);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // Hover affordance: pointer cursor plus a highlight tint on the
        // intersection under the cursor, so clickable targets announce themselves.
        let hoveredNodeId: number | null = null;
        let hoveredRestore: any = null;
        handler.setInputAction((movement: any) => {
          const picked = viewer.scene.pick(movement.position);
          const pickedId = picked?.id?.id ?? picked?.id;
          const match = typeof pickedId === 'string' ? /^(?:pick-)?node-(\d+)$/.exec(pickedId) : null;
          const hit = match ? Number(match[1]) : null;
          if (hit === hoveredNodeId) return;
          if (hoveredNodeId !== null) {
            const previous = nodeEntities.get(hoveredNodeId);
            if (previous?.point?.color && hoveredRestore) previous.point.color = hoveredRestore;
          }
          hoveredNodeId = hit;
          hoveredRestore = null;
          if (hit !== null) {
            const entity = nodeEntities.get(hit);
            if (entity?.point) {
              hoveredRestore = entity.point.color;
              entity.point.color = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString('#a5f3d0'));
            }
          }
          viewer.canvas.style.cursor = hit !== null ? 'pointer' : 'default';
          requestFrame(viewer);
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

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
      haloEntities.clear();
      pickNodeEntities.clear();
      buildingEntitiesRef.current = [];
      roadLabelEntitiesRef.current = [];
      transmissionEntitiesRef.current = [];
      floodEntitiesRef.current = [];
      isochroneEntitiesRef.current = [];
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
    // Under requestRenderMode the first paint needs an explicit render after
    // entity creation, even when the intro flight is skipped by reduced motion.
    renderStaticCity(viewerRef.current, cityData, {
      roadEntitiesRef,
      nodeEntitiesRef,
      buildingEntitiesRef,
      roadLabelEntitiesRef,
      substationEntitiesRef,
      transmissionEntitiesRef,
      buildingTilesRef,
      haloEntitiesRef,
      pickNodeEntitiesRef,
    });
    playIntroFlight(viewerRef.current);
    requestFrame(viewerRef.current);
  }, [cityData, viewerReady]);

  // Re-tier + redraw after route/scenario restyles the road entities, so
  // styleRoad's full widths/visibility don't bypass the zoom generalization.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !viewerReady || viewer.isDestroyed()) return;
    applyRoadTiers(roadEntitiesRef.current, viewer.camera.positionCartographic.height);
    requestFrame(viewer);
  }, [route, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    buildingEntitiesRef.current.forEach((entity) => { entity.show = showBuildings; });
    if (buildingTilesRef.current) buildingTilesRef.current.show = showBuildings;
    requestFrame(viewer);
  }, [showBuildings, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    transmissionEntitiesRef.current.forEach((entity) => { entity.show = showPowerLines; });
    substationEntitiesRef.current.forEach((group) => {
      group.entities.forEach((entity) => { entity.show = showSubstations; });
    });
    nodeEntitiesRef.current.forEach((entity) => { entity.show = showIntersections; });
    haloEntitiesRef.current.forEach((entity) => { entity.show = showIntersections; });
    roadLabelEntitiesRef.current.forEach((entity) => { entity.show = showRoadNames; });
    requestFrame(viewer);
  }, [showPowerLines, showSubstations, showIntersections, showRoadNames, viewerReady, cityData]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cityData) return;
    // Debounced: dragging the flood slider must not rebuild ~1,500 entities
    // on every pixel of movement - only after the value settles.
    const debounce = setTimeout(() => {
    clearEntities(viewer, floodEntitiesRef.current);
    floodEntitiesRef.current = [];

    const flooded = new Set(route?.flooded_nodes ?? cityData.nodes.filter((node) => node.elevation <= floodLevel * 1.7).map((node) => node.id));
    if (flooded.size === 0) return;
    const nodesById = new Map(cityData.nodes.map((node) => [node.id, node]));

    const floodColor = Cesium.Color.fromCssColorString('#5bc0ea');
    const floodOutline = Cesium.Color.fromCssColorString('#5bc0ea');
    const animate = !prefersReducedMotion();
    const startedAt = performance.now();
    let index = 0;
    const settleTimers: ReturnType<typeof setTimeout>[] = [];
    flooded.forEach((nodeId) => {
      const node = nodesById.get(nodeId);
      if (!node) return;
      // Cells rise in with a small per-cell stagger so the water appears to
      // spread rather than pop. Callbacks are capped: the first 400 cells
      // animate, the rest start settled - a runaway callback list was one of
      // the main frame drops in severe scenarios.
      const delay = Math.min(index * 6, 480);
      const duration = 620;
      const doAnimate = animate && index < 400;
      const growth = doAnimate
        ? new Cesium.CallbackProperty(() => {
            const p = Math.min(1, Math.max(0, (performance.now() - startedAt - delay) / duration));
            const eased = 1 - (1 - p) ** 3;
            return 108 * (0.35 + 0.65 * eased);
          }, false)
        : 108;
      const growthMinor = doAnimate
        ? new Cesium.CallbackProperty(() => {
            const p = Math.min(1, Math.max(0, (performance.now() - startedAt - delay) / duration));
            const eased = 1 - (1 - p) ** 3;
            return 82 * (0.35 + 0.65 * eased);
          }, false)
        : 82;
      const alpha = doAnimate
        ? new Cesium.CallbackProperty(() => {
            const p = Math.min(1, Math.max(0, (performance.now() - startedAt - delay) / duration));
            return floodColor.withAlpha(0.2 * (0.25 + 0.75 * p));
          }, false)
        : floodColor.withAlpha(0.2);
      const entity = viewer.entities.add({
        id: `flood-node-${nodeId}`,
        position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat, 0),
        ellipse: {
          semiMajorAxis: growth,
          semiMinorAxis: growthMinor,
          height: 0,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          material: new Cesium.ColorMaterialProperty(alpha),
          outline: true,
          outlineColor: floodOutline.withAlpha(0.55),
          outlineWidth: 1,
        },
      });
      floodEntitiesRef.current.push(entity);
      if (doAnimate) {
        // After the rise-in finishes, bake the final static values so Cesium
        // stops re-evaluating properties for settled cells every frame.
        settleTimers.push(setTimeout(() => {
          if (viewer.isDestroyed() || !floodEntitiesRef.current.includes(entity)) return;
          entity.ellipse.semiMajorAxis = new Cesium.ConstantProperty(108);
          entity.ellipse.semiMinorAxis = new Cesium.ConstantProperty(82);
          entity.ellipse.material = new Cesium.ColorMaterialProperty(floodColor.withAlpha(0.2));
        }, delay + duration + 60));
      }
      index += 1;
    });
    floodSettleTimersRef.current = settleTimers;
    }, 180);
    return () => {
      clearTimeout(debounce);
      floodSettleTimersRef.current.forEach((timer) => clearTimeout(timer));
      floodSettleTimersRef.current = [];
      if (viewerReady) requestFrame(viewer);
    };
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
          material: Cesium.Color.fromCssColorString('#ff7a6e').withAlpha(0.1),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#ff7a6e').withAlpha(0.5),
          outlineWidth: 2,
        },
      });
      const label = viewer.entities.add({
        id: `blackout-label-${subId}`,
        position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 28),
        label: {
          text: 'POWER OUTAGE',
          font: '600 10px DM Mono, monospace',
          fillColor: Cesium.Color.fromCssColorString('#ffb3aa'),
          outlineColor: Cesium.Color.fromCssColorString('#0b1a15'),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#0b1a15').withAlpha(0.85),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
        },
      });
      blackoutEntitiesRef.current.push(ellipse, label);
    });
    requestFrame(viewer);
  }, [cityData, failedSubstations, route, viewerReady]);

  // Reachability rings: translucent discs at each isochrone cutoff, drawn to
  // scale from actual street-network travel times (not straight-line radius).
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    clearEntities(viewer, isochroneEntitiesRef.current);
    isochroneEntitiesRef.current = [];
    if (!cityData || !isochroneVisible || !isochrone) return;
    const originNode = cityData.nodes.find((node) => node.id === isochrone.origin);
    if (!originNode) return;
    const ringColors = [
      'rgba(91, 192, 234, 0.10)',
      'rgba(91, 192, 234, 0.16)',
      'rgba(91, 192, 234, 0.23)',
      'rgba(91, 192, 234, 0.32)',
    ];
    // Measure the effective radius of each ring from the farthest member node
    // so the disc reflects the street network's true anisotropic reach.
    isochrone.rings.forEach((ring, index) => {
      let maxMeters = 0;
      ring.nodes.forEach((nodeId) => {
        const node = cityData.nodes.find((item) => item.id === nodeId);
        if (!node) return;
        const dx = (node.lon - originNode.lon) * 111320 * Math.cos(originNode.lat * Math.PI / 180);
        const dy = (node.lat - originNode.lat) * 111320;
        maxMeters = Math.max(maxMeters, Math.hypot(dx, dy));
      });
      if (maxMeters <= 0) return;
      const ringEntity = viewer.entities.add({
        id: `isochrone-ring-${ring.minutes}`,
        position: Cesium.Cartesian3.fromDegrees(originNode.lon, originNode.lat, 0),
        ellipse: {
          semiMajorAxis: Math.max(120, maxMeters),
          semiMinorAxis: Math.max(120, maxMeters),
          height: 0,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          material: Cesium.Color.fromCssColorString('#5bc0ea').withAlpha(0.1 + 0.08 * index),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#5bc0ea').withAlpha(0.45),
          outlineWidth: 1,
        },
      });
      const ringLabel = viewer.entities.add({
        id: `isochrone-label-${ring.minutes}`,
        position: Cesium.Cartesian3.fromDegrees(originNode.lon, originNode.lat, 14),
        label: {
          text: `${ring.minutes} min reach`,
          font: '600 10px DM Mono, monospace',
          fillColor: Cesium.Color.fromCssColorString('#bfe4f5'),
          outlineColor: Cesium.Color.fromCssColorString('#0b1a15'),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14 - index * 2),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      isochroneEntitiesRef.current.push(ringEntity, ringLabel);
    });
    requestFrame(viewer);
  }, [cityData, isochrone, isochroneVisible, viewerReady]);

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
    // Navigation-style casing: an opaque light casing separates the route from
    // every road beneath it, then a solid saturated line sits on top.
    const casingColor = Cesium.Color.fromCssColorString('#0b1a15').withAlpha(0.94);
    const routeColor = Cesium.Color.fromCssColorString('#ff8c42');
    // Draw-on reveal: while animating, the corridor is a cheap non-clamped
    // polyline (position buffer updates only); on completion it swaps to the
    // final clamped geometry so the resting state matches the static city.
    const DRAW_MS = prefersReducedMotion() ? 0 : 1700;
    const startedAt = performance.now();
    let finished = false;
    let frame = 0;
    const markers: Array<{ entity: any; fraction: number }> = [];
    let animatedUnderlay: any = null;
    let animatedRoute: any = null;

    const finalize = () => {
      finished = true;
      if (animatedUnderlay) viewer.entities.remove(animatedUnderlay);
      if (animatedRoute) viewer.entities.remove(animatedRoute);
      const underlay = viewer.entities.add({
        id: 'evacuation-route-underlay',
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(positions),
          width: 15,
          clampToGround: true,
          material: casingColor,
        },
      });
      const routeLine = viewer.entities.add({
        id: 'evacuation-route',
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(positions),
          width: 9,
          clampToGround: true,
          material: routeColor,
        },
      });
      routeEntitiesRef.current.push(underlay, routeLine);
      markers.forEach(({ entity }) => { entity.show = true; });
    };

    if (DRAW_MS === 0) {
      finalize();
    } else {
      const cartesians = Cesium.Cartesian3.fromDegreesArrayHeights(
        route.path_coords.flatMap((coord) => [coord.lon, coord.lat, coord.elevation + 1.2]),
      );
      let revealed = cartesians.slice(0, 2);
      const revealProperty = new Cesium.CallbackProperty(() => revealed, false);
      animatedUnderlay = viewer.entities.add({
        id: 'evacuation-route-underlay-anim',
        polyline: { positions: revealProperty, width: 15, clampToGround: false, material: casingColor },
      });
      animatedRoute = viewer.entities.add({
        id: 'evacuation-route-anim',
        polyline: { positions: revealProperty, width: 9, clampToGround: false, material: routeColor },
      });
      routeEntitiesRef.current.push(animatedUnderlay, animatedRoute);
      const step = () => {
        if (finished || viewer.isDestroyed()) return;
        const p = Math.min(1, (performance.now() - startedAt) / DRAW_MS);
        const eased = 1 - (1 - p) ** 3;
        revealed = cartesians.slice(0, Math.max(2, Math.ceil(eased * cartesians.length)));
        markers.forEach(({ entity, fraction }) => { entity.show = eased >= fraction; });
        if (p >= 1) {
          finalize();
          return;
        }
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    }

    route.path_coords.forEach((coord, index) => {
      const isEndpoint = index === 0 || index === route.path_coords.length - 1;
      if (!isEndpoint && index % 3 !== 0) return;
      const marker = viewer.entities.add({
        id: `route-waypoint-${index}`,
        position: Cesium.Cartesian3.fromDegrees(coord.lon, coord.lat, 7),
        show: DRAW_MS === 0,
        point: {
          pixelSize: isEndpoint ? 10 : 5,
          color: Cesium.Color.fromCssColorString(index === 0 ? '#2ec98a' : '#ff8c42'),
          outlineColor: Cesium.Color.fromCssColorString('#0b1a15'),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      markers.push({ entity: marker, fraction: index / Math.max(1, route.path_coords.length - 1) });
      routeEntitiesRef.current.push(marker);
    });
    if (DRAW_MS === 0) requestFrame(viewer);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (DRAW_MS > 0) requestFrame(viewer);
    };
  }, [route, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cityData) return;
    updateEndpointMarkers(viewer, cityData, route?.dest_node ?? -1, route?.success ?? false);
    requestFrame(viewer);
  }, [cityData, originNode, route?.dest_node, route?.success, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || flyToNodeId === null || !cityData) return;
    const entity = nodeEntitiesRef.current.get(flyToNodeId);
    if (!entity) return;
    viewer.flyTo(entity, {
      duration: 1.15,
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-80), 950),
    }).finally(() => setFlyToNodeId(null));
  }, [cityData, flyToNodeId, setFlyToNodeId, viewerReady]);

  // Street-search landing: spotlight the matched corridor, fly to it, then
  // hand the corridor back to its normal tier styling.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !flyToRoadKey || !cityData) return;
    const { setFlyToRoadKey } = useSimulationStore.getState();
    if (searchHighlightTimerRef.current) {
      clearTimeout(searchHighlightTimerRef.current);
      searchHighlightTimerRef.current = null;
    }
    const road = roadEntitiesRef.current.get(flyToRoadKey);
    if (road) {
      const { entity, edge } = road;
      entity.polyline.show = new Cesium.ConstantProperty(true);
      entity.polyline.width = new Cesium.ConstantProperty(Math.max(styleRoadWidth(edge.road_class), 12));
      entity.polyline.material = new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString('#ff8c42').withAlpha(0.95));
      const mid = entity.polyline.positions?.getValue(viewer.clock.currentTime);
      if (mid && mid.length > 0) {
        const carto = viewer.camera.positionCartographic;
        viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(mid[Math.floor(mid.length / 2)], 420), {
          duration: 1.2,
          offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(carto.height > 2600 ? -88 : -80), 900),
        });
      }
      searchHighlightTimerRef.current = setTimeout(() => {
        if (viewer.isDestroyed()) return;
        styleRoad(entity, edge, null);
        requestFrame(viewer);
      }, 5200);
    }
    requestFrame(viewer);
    setFlyToRoadKey(null);
  }, [flyToRoadKey, cityData, viewerReady]);

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
    // Treatments adjust only the basemap layer, so vector overlays (route,
    // hazards, labels) keep full legibility instead of being hue-rotated too.
    if (mapFilterMode === 'radar') {
      layer.brightness = 1.18;
      layer.contrast = 1.14;
      layer.saturation = 0;
    } else if (mapFilterMode === 'thermal') {
      layer.brightness = 0.86;
      layer.contrast = 1.1;
      layer.saturation = 1.4;
    } else {
      layer.brightness = 1.04;
      layer.contrast = 1.05;
      layer.saturation = 1.08;
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
          failed ? Cesium.Color.fromCssColorString('#ff7a6e') : load > group.sub.capacity_mw ? Cesium.Color.fromCssColorString('#e2a33c') : Cesium.Color.fromCssColorString('#2ec98a'),
        );
      }
    });
  }, [failedSubstations, route, substationLoads, viewerReady]);

  return <div ref={containerRef} className="cesium-map-surface" aria-label="Interactive Houston street and utility map" />;
}

function clearEntities(viewer: any, entities: any[]) {
  entities.forEach((entity) => viewer.entities.remove(entity));
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Nudge the on-demand render loop (requestRenderMode) after entity edits. */
function requestFrame(viewer: any) {
  if (!viewer || viewer.isDestroyed() || typeof viewer.scene?.requestRender !== 'function') return;
  viewer.scene.requestRender();
}

/** Cinematic descent into the operational view on first data render. Camera-only, so it is cheap. */
function playIntroFlight(viewer: any) {
  if (!viewer || viewer.isDestroyed() || prefersReducedMotion()) return;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(CENTER.lon, CENTER.lat, 10400),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-64), roll: 0 },
  });
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(CENTER.lon, CENTER.lat, 5200),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-88), roll: 0 },
    duration: 3.1,
    easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
  });
}

function styleRoadColor(roadClass: string) {
  // Luminous asphalt tiers on the dark basemap: brighter as roads gain importance.
  if (roadClass === 'arterial') return '#d9d2c7';
  if (roadClass === 'collector') return '#b8b1a6';
  if (roadClass === 'service') return '#5d594f';
  return '#8b8578';
}

function styleRoadWidth(roadClass: string) {
  if (roadClass === 'arterial') return 10;
  if (roadClass === 'collector') return 6.5;
  if (roadClass === 'service') return 2;
  return 4;
}

function normalizeEdgeKey(key: string) {
  const [a, b] = key.split('-').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) ? `${Math.min(a, b)}-${Math.max(a, b)}` : key;
}

// Cartographic generalization: minor tiers vanish as the camera zooms out so
// the map reads as a district overview instead of a wireframe mat.
const ROAD_TIERS = {
  service: { near: 0, fade: 1100, base: 2, hidden: 2 },
  local: { near: 0, fade: 1800, base: 4, hidden: 1.5 },
  collector: { near: 0, fade: 3000, base: 6.5, hidden: 2 },
  arterial: { near: 0, fade: 7000, base: 10, hidden: 3.5 },
} as const;

/** Re-apply zoom-dependent road tiers across all road entities. Cheap enough
 * to run after any restyle; the tierOnce path wires it to camera changes. */
function applyRoadTiers(roadEntities: Map<string, RoadEntity>, height: number) {
  roadEntities.forEach(({ entity, edge }: { entity: any; edge: EdgeData }) => {
    if (!entity?.polyline) return;
    const tier = ROAD_TIERS[(edge.road_class as keyof typeof ROAD_TIERS) ?? 'local'] ?? ROAD_TIERS.local;
    if (height > tier.fade) {
      entity.polyline.show = new Cesium.ConstantProperty(false);
    } else {
      const width = height <= tier.near ? tier.base : Math.max(tier.hidden, tier.base * (1 - (height - tier.near) / (tier.fade - tier.near)));
      entity.polyline.show = new Cesium.ConstantProperty(true);
      entity.polyline.width = new Cesium.ConstantProperty(Math.max(tier.hidden, Math.min(tier.base, width)));
    }
  });
}

function exitLabelMap(cityData: CityData): Record<number, string> {
  const names: Record<number, string> = { ...SAFE_EXITS };
  Object.entries(cityData.exit_names ?? {}).forEach(([id, name]) => {
    const key = Number(id);
    if (Number.isFinite(key)) names[key] = name;
  });
  return names;
}

function styleRoad(entity: any, edge: EdgeData, state: string | null) {
  if (!entity?.polyline) return;
  // Asphalt hierarchy: darker + wider as roads get more important, so the
  // network reads like a real street map instead of a uniform wireframe.
  let color = styleRoadColor(edge.road_class);
  let width = styleRoadWidth(edge.road_class);
  if (state === 'overloaded') {
    color = '#e2a33c';
    width = Math.max(width, 8);
  } else if (state === 'dead' || state === 'blocked') {
    color = '#ff7a6e';
    width = state === 'blocked' ? 10 : 7;
  }
  entity.polyline.material = new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString(color).withAlpha(0.95));
  entity.polyline.width = new Cesium.ConstantProperty(width);
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
    haloEntitiesRef: MutableRefObject<Map<number, any>>;
    pickNodeEntitiesRef: MutableRefObject<Map<number, any>>;
  },
) {
  const EXIT_LABELS = exitLabelMap(cityData);
  // Junction index: O(1) lookups instead of scanning all 4,000 nodes per edge.
  const nodesById = new Map(cityData.nodes.map((node) => [node.id, node]));
  // Cap road-name labels per street (2 repeats max): the same name repeating
  // across many blocks wastes entities and adds noise without aiding navigation.
  const labelCounts = new Map<string, number>();
  // Cartographic generalization runs only when the camera actually moves
  // (percentageChanged), never per frame - the old per-frame pass touched
  // 5,000 entities 60x per second.
  const tierRoads = () => {
    if (viewer.isDestroyed()) return;
    applyRoadTiers(refs.roadEntitiesRef.current, viewer.camera.positionCartographic.height);
    requestFrame(viewer);
  };
  const tierOnce = () => {
    tierRoads();
    viewer.scene.postRender.removeEventListener(tierOnce);
  };
  viewer.scene.postRender.addEventListener(tierOnce);
  viewer.camera.percentageChanged = 0.02;
  viewer.camera.changed.addEventListener(tierRoads);
  // Buildings and parks are real OpenStreetMap footprints extruded in place,
  // so they align exactly with the street corridors that surround them.
  const parkPolygons: ParkData[] = cityData.parks ?? [];
  parkPolygons.forEach((park) => {
    if (!park.footprint || park.footprint.length < 3) return;
    const positions = Cesium.Cartesian3.fromDegreesArray(park.footprint.flatMap((point) => [point[1], point[0]]));
    const parkEntity = viewer.entities.add({
      id: park.id,
      polygon: {
        hierarchy: positions,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        material: Cesium.Color.fromCssColorString('#2ec98a').withAlpha(0.16),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#2ec98a').withAlpha(0.3),
        outlineWidth: 1,
      },
    });
    refs.buildingEntitiesRef.current.push(parkEntity);
  });

  cityData.blocks.forEach((block: BlockData) => {
    if (!block.footprint || block.footprint.length < 3) return;
    const positions = Cesium.Cartesian3.fromDegreesArray(block.footprint.flatMap((point) => [point[1], point[0]]));
    const building = viewer.entities.add({
      id: block.id,
      polygon: {
        hierarchy: positions,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        extrudedHeight: block.height_m,
        extrudedHeightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        material: Cesium.Color.fromCssColorString('#1a2a26').withAlpha(0.9),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#3d5c52').withAlpha(0.5),
        outlineWidth: 1,
      },
    });
    refs.buildingEntitiesRef.current.push(building);
  });

  cityData.edges.forEach((edge) => {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) return;
    // Interleave the edge's baked street-curve coordinates so roads bend
    // exactly as they do on the ground.
    const coords: number[] = [source.lon, source.lat];
    (edge.geometry ?? []).forEach((point) => coords.push(point[1], point[0]));
    coords.push(target.lon, target.lat);
    const road = viewer.entities.add({
      id: `road-${edge.source}-${edge.target}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(coords),
        width: styleRoadWidth(edge.road_class),
        clampToGround: true,
        material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString(styleRoadColor(edge.road_class)).withAlpha(0.95)),
      },
    });
    const key = normalizeEdgeKey(`${edge.source}-${edge.target}`);
    refs.roadEntitiesRef.current.set(key, { entity: road, edge });

    const shouldLabel = (edge.road_class === 'arterial' || (edge.road_class === 'collector' && edge.distance_m > 200)) && edge.road_name !== 'Unnamed street';
    if (shouldLabel && (labelCounts.get(edge.road_name) ?? 0) < 2) {
      labelCounts.set(edge.road_name, (labelCounts.get(edge.road_name) ?? 0) + 1);
      const label = viewer.entities.add({
        id: `road-label-${edge.source}-${edge.target}`,
        position: Cesium.Cartesian3.fromDegrees((source.lon + target.lon) / 2, (source.lat + target.lat) / 2, 2),
        label: {
          text: edge.road_name,
          font: '600 10px DM Mono, monospace',
          fillColor: Cesium.Color.fromCssColorString('#c8d6ce'),
          outlineColor: Cesium.Color.fromCssColorString('#0b1a15'),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -6),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2400),
        },
      });
      refs.roadLabelEntitiesRef.current.push(label);
    }
  });

  cityData.nodes.forEach((node) => {
    const isExit = Boolean(EXIT_LABELS[node.id]);
    // Only exits are persistent visual targets. Regular intersections appear
    // as small quiet dots at street level (DistanceDisplayCondition ~2.6 km).
    // Clickability is decoupled from visibility: every node also gets an
    // invisible always-pickable dot, because Cesium's drillPick ignores
    // show:false entities, so hiding the visible dots would otherwise make
    // the map unclickable at district zoom.
    const pulse = isExit && !prefersReducedMotion();
    const beaconSize = pulse
      ? new Cesium.CallbackProperty(() => 9 + 1.6 * Math.sin(performance.now() / 420), false)
      : isExit ? 9 : 3;
    if (isExit) {
      const haloSize = pulse
        ? new Cesium.CallbackProperty(() => 20 + 5 * Math.sin(performance.now() / 420), false)
        : 20;
      viewer.entities.add({
        id: `halo-${node.id}`,
        position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat, 4),
        point: {
          pixelSize: haloSize,
          color: Cesium.Color.fromCssColorString('#2ec98a').withAlpha(0.14),
          outlineColor: Cesium.Color.TRANSPARENT,
          outlineWidth: 0,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    const entity = viewer.entities.add({
      id: `node-${node.id}`,
      position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat, 5),
      point: {
        pixelSize: beaconSize,
        color: Cesium.Color.fromCssColorString(isExit ? '#2ec98a' : '#5d6f66'),
        outlineColor: Cesium.Color.fromCssColorString('#0b1a15'),
        outlineWidth: isExit ? 2 : 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: isExit ? undefined : new Cesium.DistanceDisplayCondition(0, 2600),
        scaleByDistance: isExit ? undefined : new Cesium.NearFarScalar(600, 1, 2600, 0.55),
      },
      label: isExit ? {
        text: EXIT_LABELS[node.id],
        font: '700 10px DM Mono, monospace',
        fillColor: Cesium.Color.fromCssColorString('#7fe0b6'),
        outlineColor: Cesium.Color.fromCssColorString('#0b1a15'),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      } : undefined,
    });
    refs.nodeEntitiesRef.current.set(node.id, entity);
    // Invisible always-pickable dot: keeps every intersection clickable even
    // when its visible dot is hidden (drillPick ignores show:false entities).
    const pickDot = viewer.entities.add({
      id: `pick-node-${node.id}`,
      position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat, 5),
      point: {
        pixelSize: 8,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: Cesium.Color.TRANSPARENT,
        outlineWidth: 0,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    refs.pickNodeEntitiesRef.current.set(node.id, pickDot);
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
        width: 2,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#e2c76e').withAlpha(0.4),
          dashLength: 12,
        }),
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
  // Facilities render as flat ground pads with a status point, matching how
  // infrastructure appears on operational maps rather than as toy buildings.
  const base = viewer.entities.add({
    id: `substation-base-${sub.id}`,
    position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 0),
    ellipse: {
      semiMajorAxis: 34,
      semiMinorAxis: 24,
      height: 0,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      material: Cesium.Color.fromCssColorString('#e2c76e').withAlpha(0.28),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#e2c76e').withAlpha(0.55),
      outlineWidth: 1,
    },
  });
  const beacon = viewer.entities.add({
    id: `substation-beacon-${sub.id}`,
    position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 6),
    point: {
      pixelSize: 9,
      color: Cesium.Color.fromCssColorString('#e2c76e'),
      outlineColor: Cesium.Color.fromCssColorString('#0b1a15'),
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: sub.name,
      font: '600 10px DM Mono, monospace',
      fillColor: Cesium.Color.fromCssColorString('#efe0ac'),
      outlineColor: Cesium.Color.fromCssColorString('#0b1a15'),
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -16),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#0b1a15').withAlpha(0.85),
      backgroundPadding: new Cesium.Cartesian2(6, 4),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3200),
    },
  });
  return { entities: [base, beacon], beacon, sub };
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
    // The origin point gently scales so the eye lands on the response start.
    const originPulse = prefersReducedMotion()
      ? 13
      : new Cesium.CallbackProperty(() => 13 + 1.8 * Math.sin(performance.now() / 380), false);
    viewer.entities.add({
      id: 'operator-origin',
      position: Cesium.Cartesian3.fromDegrees(originNode.lon, originNode.lat, 10),
      point: { pixelSize: originPulse, color: Cesium.Color.fromCssColorString('#2ec98a'), outlineColor: Cesium.Color.fromCssColorString('#0b1a15'), outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: 'ORIGIN', font: '700 10px DM Mono, monospace', fillColor: Cesium.Color.fromCssColorString('#7fe0b6'), outlineColor: Cesium.Color.fromCssColorString('#0b1a15'), outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -22), disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
  }
  if (!routeSuccess || destination < 0) return;
  const destinationNode = cityData.nodes.find((node) => node.id === destination);
  if (!destinationNode) return;
  const EXIT_LABELS = exitLabelMap(cityData);
  viewer.entities.add({
    id: 'operator-destination',
    position: Cesium.Cartesian3.fromDegrees(destinationNode.lon, destinationNode.lat, 10),
    point: { pixelSize: 13, color: Cesium.Color.fromCssColorString('#ff8c42'), outlineColor: Cesium.Color.fromCssColorString('#0b1a15'), outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: { text: `${EXIT_LABELS[destination] ?? 'EXIT'} ${destination}`, font: '700 10px DM Mono, monospace', fillColor: Cesium.Color.fromCssColorString('#ffc49b'), outlineColor: Cesium.Color.fromCssColorString('#0b1a15'), outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -22), disableDepthTestDistance: Number.POSITIVE_INFINITY },
  });
}
