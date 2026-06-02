'use client';

/**
 * CesiumViewer.tsx — Full-screen 3-D Cesium map for GridEvac AI Houston
 * -----------------------------------------------------------------------
 * Rendering layers (bottom → top):
 *   1. Cesium World Terrain  — real Houston elevation data
 *   2. OSM 3D Buildings      — Cesium Ion asset 96188
 *   3. Street grid           — polyline entities, colour-coded by status
 *   4. Substation markers    — amber cylinders with labels
 *   5. Flood plane           — rising translucent blue polygon
 *   6. Blackout zones        — dark red semi-transparent cylinders
 *   7. Evacuation route      — glowing green PolylineGlow tube
 *   8. Origin / Dest markers — pulsing coloured point entities
 *
 * Cesium is loaded as a pre-built global script from /public/cesium/Cesium.js
 * to avoid all webpack / SSR complexity.  TypeScript types are imported from
 * the cesium npm package (type-only import, never bundled).
 */

import { useEffect, useRef, useCallback } from 'react';
import type * as CesiumType from 'cesium';
import { useSimulationStore } from '@/hooks/useSimulation';
import type { CityData } from '@/lib/types';

// Declare global Cesium loaded via script tag
declare const Cesium: typeof CesiumType;

const CESIUM_TOKEN = process.env.NEXT_PUBLIC_CESIUM_TOKEN!;

// Houston downtown centre
const CENTER = { lat: 29.7604, lon: -95.3698 };

// Flood polygon covers the full city grid + margin
const FLOOD_BOUNDS_COORDS = [
  -95.3760, 29.7555,
  -95.3630, 29.7555,
  -95.3630, 29.7660,
  -95.3760, 29.7660,
];

// Flood height formula: metres of water rise per unit of flood_level
const FLOOD_M_PER_LEVEL = 1.7;

// ─────────────────────────────────────────────────────────────────────────────

export default function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef    = useRef<any>(null);
  const loadedRef    = useRef(false);

  // Entity refs for reactive updates (avoids recreating viewer on every render)
  const floodEntityRef     = useRef<any>(null);
  const routeEntityRef     = useRef<any>(null);
  const originEntityRef    = useRef<any>(null);
  const destEntityRef      = useRef<any>(null);
  const blackoutRefs       = useRef<Map<number, any>>(new Map());
  const edgeEntityMap      = useRef<Map<string, any>>(new Map());
  const staticRenderedRef  = useRef(false);

  const {
    floodLevel,
    failedSubstations,
    route,
    cityData,
    originNode,
    destNode,
  } = useSimulationStore();

  // ── Load Cesium script once ─────────────────────────────────────────────────
  const loadCesiumScript = useCallback((): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (typeof window === 'undefined') return reject('SSR');
      if ((window as any).Cesium) return resolve();

      // Set base URL for Cesium CDN assets
      (window as any).CESIUM_BASE_URL = 'https://cesium.com/downloads/cesiumjs/releases/1.119.0/Build/Cesium/';

      const link = document.createElement('link');
      link.rel  = 'stylesheet';
      link.href = 'https://cesium.com/downloads/cesiumjs/releases/1.119.0/Build/Cesium/Widgets/widgets.css';
      document.head.appendChild(link);

      const script  = document.createElement('script');
      script.src    = 'https://cesium.com/downloads/cesiumjs/releases/1.119.0/Build/Cesium/Cesium.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Cesium.js'));
      document.head.appendChild(script);
    });
  }, []);

  // ── Initialise Cesium Viewer ────────────────────────────────────────────────
  useEffect(() => {
    if (loadedRef.current || !containerRef.current) return;
    loadedRef.current = true;

    let destroyed = false;

    (async () => {
      try {
        await loadCesiumScript();
        if (destroyed) return;

        Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;

        const viewer = new Cesium.Viewer(containerRef.current!, {
          terrain:                       Cesium.Terrain.fromWorldTerrain({ requestVertexNormals: true }),
          animation:                     false,
          baseLayerPicker:               false,
          fullscreenButton:              false,
          geocoder:                      false,
          homeButton:                    false,
          infoBox:                       false,
          sceneModePicker:               false,
          selectionIndicator:            false,
          timeline:                      false,
          navigationHelpButton:          false,
          requestRenderMode:             false,
          shadows:                       true,
          terrainShadows:                Cesium.ShadowMode.ENABLED,
        });

        // Scene atmosphere for drama
        viewer.scene.skyAtmosphere.show       = true;
        viewer.scene.globe.enableLighting     = true;
        viewer.scene.fog.enabled              = true;
        viewer.scene.fog.density              = 0.00015;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        viewer.scene.postProcessStages.bloom.enabled = true;
        (viewer.scene.postProcessStages.bloom as any).uniforms.glowOnly  = false;
        (viewer.scene.postProcessStages.bloom as any).uniforms.brightness = -0.1;

        viewerRef.current = viewer;

        // 3-D OSM Buildings (Houston has excellent coverage)
        try {
          const buildings = await Cesium.createOsmBuildingsAsync();
          viewer.scene.primitives.add(buildings);
        } catch (e) {
          console.warn('[GridEvac] OSM Buildings unavailable:', e);
        }

        // Initial camera — bird's eye over downtown Houston
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(CENTER.lon, CENTER.lat, 1800),
          orientation: {
            heading: Cesium.Math.toRadians(15),
            pitch:   Cesium.Math.toRadians(-52),
            roll:    0.0,
          },
        });

        // Pre-create the flood polygon (starts invisible)
        floodEntityRef.current = viewer.entities.add({
          id: 'flood-plane',
          polygon: {
            hierarchy:      Cesium.Cartesian3.fromDegreesArray(FLOOD_BOUNDS_COORDS),
            material:       new Cesium.ColorMaterialProperty(
                              Cesium.Color.fromCssColorString('#0055dd').withAlpha(0.45)
                            ),
            height:         1.5,         // just above terrain
            extrudedHeight: 1.5,         // will be updated dynamically
            outline:        false,
            closeTop:       true,
            closeBottom:    false,
          },
          show: false,
        });

        // Tick: pulse origin / dest markers
        let tickT = 0;
        viewer.clock.onTick.addEventListener(() => {
          tickT += 0.04;
          const pulse = 14 + Math.sin(tickT) * 5;
          if (originEntityRef.current?.point) {
            originEntityRef.current.point.pixelSize = new Cesium.ConstantProperty(pulse);
          }
          if (destEntityRef.current?.point) {
            destEntityRef.current.point.pixelSize = new Cesium.ConstantProperty(pulse);
          }
        });

      } catch (err) {
        console.error('[GridEvac] Cesium init error:', err);
      }
    })();

    return () => {
      destroyed = true;
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render static city (streets + substations) once city data arrives ───────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cityData || staticRenderedRef.current) return;
    if (typeof Cesium === 'undefined') return;
    staticRenderedRef.current = true;

    const map = renderStaticCity(viewer, cityData);
    edgeEntityMap.current = map;
  }, [cityData]);

  // ── Update flood plane height ───────────────────────────────────────────────
  useEffect(() => {
    const entity = floodEntityRef.current;
    if (!entity) return;
    if (typeof Cesium === 'undefined') return;
    const height = floodLevel * FLOOD_M_PER_LEVEL;
    entity.show = floodLevel > 0.05;
    if (entity.polygon) {
      entity.polygon.extrudedHeight = new Cesium.ConstantProperty(height + 1.5);
    }
  }, [floodLevel]);

  // ── Update blackout zone cylinders ─────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cityData) return;
    if (typeof Cesium === 'undefined') return;

    // Remove old blackout entities
    blackoutRefs.current.forEach((e) => viewer.entities.remove(e));
    blackoutRefs.current.clear();

    for (const subId of failedSubstations) {
      const sub = cityData.substations.find((s) => s.id === subId);
      if (!sub) continue;

      const radiusM = sub.radius * 90; // grid-unit radius → approximate metres

      const entity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 80),
        cylinder: {
          length:        240,
          topRadius:     radiusM,
          bottomRadius:  radiusM,
          material:      Cesium.Color.fromCssColorString('#1a0500').withAlpha(0.58),
          outline:       true,
          outlineColor:  Cesium.Color.fromCssColorString('#ff4400').withAlpha(0.9),
          outlineWidth:  2,
          numberOfVerticalLines: 0,
        },
      });

      // Outer glow ring
      viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 3),
        ellipse: {
          semiMajorAxis: radiusM,
          semiMinorAxis: radiusM,
          material:      Cesium.Color.fromCssColorString('#ff4400').withAlpha(0.25),
          outline:       true,
          outlineColor:  Cesium.Color.fromCssColorString('#ff4400').withAlpha(0.9),
          outlineWidth:  3,
          height:        2,
        },
      });

      blackoutRefs.current.set(subId, entity);
    }
  }, [failedSubstations, cityData]);

  // ── Update route visualisation ─────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (typeof Cesium === 'undefined') return;

    // Clear old route
    if (routeEntityRef.current) {
      viewer.entities.remove(routeEntityRef.current);
      routeEntityRef.current = null;
    }

    // Reset all edge colours to default
    edgeEntityMap.current.forEach((entity) => {
      if (entity?.polyline) {
        entity.polyline.material = new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#1e4a8a').withAlpha(0.8)
        );
        entity.polyline.width = new Cesium.ConstantProperty(2.5);
      }
    });

    if (!route) return;

    // Colour blocked edges red
    for (const [u, v] of route.blocked_edges) {
      const key1 = `${u}-${v}`;
      const key2 = `${v}-${u}`;
      const entity = edgeEntityMap.current.get(key1) ?? edgeEntityMap.current.get(key2);
      if (entity?.polyline) {
        entity.polyline.material = new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#ff2222').withAlpha(0.9)
        );
        entity.polyline.width = new Cesium.ConstantProperty(4);
      }
    }

    if (!route.success || route.path_coords.length < 2) return;

    // Draw glowing green route
    const positions = route.path_coords.flatMap((c) => [c.lon, c.lat, c.elevation]);
    routeEntityRef.current = viewer.entities.add({
      polyline: {
        positions:        Cesium.Cartesian3.fromDegreesArrayHeights(positions),
        width:            12,
        material:         new Cesium.PolylineGlowMaterialProperty({
                            glowPower:  0.45,
                            taperPower: 1.0,
                            color:      Cesium.Color.fromCssColorString('#00ff88'),
                          }),
        clampToGround:    false,
        depthFailMaterial:new Cesium.PolylineGlowMaterialProperty({
                            glowPower: 0.25,
                            color:     Cesium.Color.fromCssColorString('#00ff88').withAlpha(0.4),
                          }),
      },
    });

    // Smooth camera flight to show the full route
    viewer.flyTo(routeEntityRef.current, {
      duration: 2.5,
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(20),
        Cesium.Math.toRadians(-45),
        1400,
      ),
    });
  }, [route]);

  // ── Update origin / destination markers ────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cityData) return;
    if (typeof Cesium === 'undefined') return;

    if (originEntityRef.current) viewer.entities.remove(originEntityRef.current);
    if (destEntityRef.current)   viewer.entities.remove(destEntityRef.current);

    const orig = cityData.nodes.find((n) => n.id === originNode);
    const dest = cityData.nodes.find((n) => n.id === destNode);

    if (orig) {
      originEntityRef.current = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(orig.lon, orig.lat, orig.elevation + 20),
        point: {
          pixelSize:    16,
          color:        Cesium.Color.fromCssColorString('#00e5ff'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text:            'ORIGIN',
          font:            'bold 13px Rajdhani, sans-serif',
          fillColor:       Cesium.Color.fromCssColorString('#00e5ff'),
          outlineColor:    Cesium.Color.BLACK,
          outlineWidth:    2,
          style:           Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:     new Cesium.Cartesian2(0, -28),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }

    if (dest) {
      destEntityRef.current = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(dest.lon, dest.lat, dest.elevation + 20),
        point: {
          pixelSize:    16,
          color:        Cesium.Color.fromCssColorString('#ff6b35'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text:            'DEST',
          font:            'bold 13px Rajdhani, sans-serif',
          fillColor:       Cesium.Color.fromCssColorString('#ff6b35'),
          outlineColor:    Cesium.Color.BLACK,
          outlineWidth:    2,
          style:           Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:     new Cesium.Cartesian2(0, -28),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }, [originNode, destNode, cityData]);

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function renderStaticCity(viewer: any, cityData: CityData): Map<string, any> {
  const entityMap = new Map<string, any>();

  // ── Street edges ───────────────────────────────────────────────────────────
  for (const edge of cityData.edges) {
    const src = cityData.nodes.find((n) => n.id === edge.source);
    const tgt = cityData.nodes.find((n) => n.id === edge.target);
    if (!src || !tgt) continue;

    const height = Math.min(src.elevation, tgt.elevation) + 2;

    const entity = viewer.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights([
          src.lon, src.lat, height,
          tgt.lon, tgt.lat, height,
        ]),
        width:    2.5,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#1e4a8a').withAlpha(0.8)
        ),
        clampToGround: false,
      },
    });

    entityMap.set(`${edge.source}-${edge.target}`, entity);
  }

  // ── Substation markers ─────────────────────────────────────────────────────
  for (const sub of cityData.substations) {
    // Glowing amber tower
    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 40),
      cylinder: {
        length:        80,
        topRadius:     6,
        bottomRadius:  10,
        material:      Cesium.Color.fromCssColorString('#ffc107').withAlpha(0.95),
        outline:       true,
        outlineColor:  Cesium.Color.fromCssColorString('#ff9800'),
        outlineWidth:  1,
      },
    });

    // Label
    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, 90),
      label: {
        text:            sub.name,
        font:            '600 11px Rajdhani, sans-serif',
        fillColor:       Cesium.Color.fromCssColorString('#ffc107'),
        outlineColor:    Cesium.Color.BLACK,
        outlineWidth:    2,
        style:           Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin:  Cesium.VerticalOrigin.BOTTOM,
        scale:           0.9,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  return entityMap;
}
