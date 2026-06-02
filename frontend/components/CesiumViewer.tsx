'use client';

/**
 * CesiumViewer.tsx — Full-screen 3-D Cesium map for GridEvac AI Houston
 * -----------------------------------------------------------------------
 * Rendering layers (bottom → top):
 *   1. Cesium World Terrain  — real Houston elevation data
 *   2. OSM 3D Buildings      — Cesium Ion asset 96188
 *   3. Street grid           — polyline entities, color-coded by status
 *   4. Substation structures — dynamic 3D composite structures (vaults, pylons, arms, beacons)
 *   5. Flood plane           — rising translucent blue polygon
 *   6. Blackout zones        — dark red semi-transparent cylinders (includes cascades)
 *   7. Evacuation route      — glowing green PolylineGlow tube
 *   8. Origin / Dest markers — pulsing colored point entities
 *   9. 3D Beacons            — 3D Pyramids sitting on intersections
 *  10. 3D Exit Portals       — 3D Ellipsoid Protective Domes sitting over gates
 *  11. Floating Markers      — Double-cones and spinning rings hovering over alerts
 */

import { useEffect, useRef, useCallback } from 'react';
import type * as CesiumType from 'cesium';
import { useSimulationStore } from '@/hooks/useSimulation';
import type { CityData } from '@/lib/types';

// Declare global Cesium loaded via script tag
declare const Cesium: typeof CesiumType;

const CESIUM_TOKEN = process.env.NEXT_PUBLIC_CESIUM_TOKEN!;

// Center of expanded HISD / TX-18 grid
const CENTER = { lat: 29.7700, lon: -95.3800 };

// Flood polygon covers a very large area (out of viewport) so edges are invisible
const FLOOD_BOUNDS_COORDS = [
  -96.2000, 29.2000,
  -94.5000, 29.2000,
  -94.5000, 30.3000,
  -96.2000, 30.3000,
];

// Flood height formula: metres of water rise per unit of flood_level
const FLOOD_M_PER_LEVEL = 1.7;

// ─────────────────────────────────────────────────────────────────────────────

export default function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef    = useRef<any>(null);
  const loadedRef    = useRef(false);

  // Entity refs for reactive updates
  const floodEntityRef      = useRef<any>(null);
  const routeEntityRef      = useRef<any>(null);
  const originEntityRef     = useRef<any>(null);
  const destEntityRef       = useRef<any>(null);
  const blackoutRefs        = useRef<Map<number, any>>(new Map());
  const edgeEntityMap       = useRef<Map<string, any>>(new Map());
  const substationEntityMap = useRef<Map<number, any>>(new Map());
  const staticRenderedRef   = useRef(false);
  const transmissionEntityMap = useRef<Map<number, any>>(new Map());
  const buildingsRef        = useRef<any>(null);

  // Dynamic 3D holographic indicators
  const originIndicatorRef  = useRef<any>(null);
  const destIndicatorRef    = useRef<any>(null);
  const subIndicatorsRef     = useRef<Map<number, any>>(new Map());
  const exitIndicatorsRef    = useRef<Map<number, any>>(new Map());

  const {
    floodLevel,
    failedSubstations,
    route,
    cityData,
    originNode,
    destNode,
    showBuildings,
    showPowerLines,
    showSubstations,
    showIntersections,
    flyToNodeId,
    setFlyToNodeId,
    activeSection,
    mapFilterMode,
    flyToCoords,
    setFlyToCoords,
    substationLoads,
  } = useSimulationStore();

  // ── Load Cesium script once with dynamic multi-CDN fallback ─────────────────
  const loadCesiumScript = useCallback((): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (typeof window === 'undefined') return reject('SSR');
      if ((window as any).Cesium) return resolve();

      const cdns = [
        {
          base: 'https://unpkg.com/cesium@1.119.0/Build/Cesium/',
          js: 'https://unpkg.com/cesium@1.119.0/Build/Cesium/Cesium.js',
          css: 'https://unpkg.com/cesium@1.119.0/Build/Cesium/Widgets/widgets.css'
        },
        {
          base: 'https://cdnjs.cloudflare.com/ajax/libs/cesium/1.119.0/Build/Cesium/',
          js: 'https://cdnjs.cloudflare.com/ajax/libs/cesium/1.119.0/Build/Cesium/Cesium.js',
          css: 'https://cdnjs.cloudflare.com/ajax/libs/cesium/1.119.0/Build/Cesium/Widgets/widgets.css'
        },
        {
          base: 'https://cesium.com/downloads/cesiumjs/releases/1.119.0/Build/Cesium/',
          js: 'https://cesium.com/downloads/cesiumjs/releases/1.119.0/Build/Cesium/Cesium.js',
          css: 'https://cesium.com/downloads/cesiumjs/releases/1.119.0/Build/Cesium/Widgets/widgets.css'
        }
      ];

      let attempt = 0;

      const tryNext = () => {
        if (attempt >= cdns.length) {
          return reject(new Error('Failed to load CesiumJS from all CDNs'));
        }

        const cdn = cdns[attempt];
        attempt++;

        // Set base URL for active CDN
        (window as any).CESIUM_BASE_URL = cdn.base;

        // Load stylesheet
        let link = document.getElementById('cesium-css') as HTMLLinkElement;
        if (!link) {
          link = document.createElement('link');
          link.id = 'cesium-css';
          link.rel = 'stylesheet';
          document.head.appendChild(link);
        }
        link.href = cdn.css;

        // Load JS script
        const scriptId = 'cesium-js-script';
        let script = document.getElementById(scriptId) as HTMLScriptElement;
        if (script) {
          document.head.removeChild(script);
        }

        script = document.createElement('script');
        script.id = scriptId;
        script.src = cdn.js;
        script.onload = () => {
          if ((window as any).Cesium) {
            resolve();
          } else {
            tryNext();
          }
        };
        script.onerror = () => {
          console.warn(`[GridEvac] Failed to load Cesium.js from CDN attempt ${attempt}: ${cdn.js}`);
          tryNext();
        };
        document.head.appendChild(script);
      };

      tryNext();
    });
  }, []);

  // ── Initialise Cesium Viewer ────────────────────────────────────────────────
  useEffect(() => {
    if (loadedRef.current || !containerRef.current) return;
    loadedRef.current = true;

    let destroyed = false;
    let handleResize: (() => void) | undefined;

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
        if (viewer.scene.skyAtmosphere) {
          viewer.scene.skyAtmosphere.show = true;
        }
        if (viewer.scene.globe) {
          viewer.scene.globe.enableLighting = true;
          viewer.scene.globe.depthTestAgainstTerrain = true;
        }
        if (viewer.scene.fog) {
          viewer.scene.fog.enabled = true;
          viewer.scene.fog.density = 0.00015;
        }
        if (viewer.scene.postProcessStages?.bloom) {
          viewer.scene.postProcessStages.bloom.enabled = true;
          (viewer.scene.postProcessStages.bloom as any).uniforms.glowOnly  = false;
          (viewer.scene.postProcessStages.bloom as any).uniforms.brightness = -0.1;
        }

        // Dark desaturated base imagery to match the high-tech sci-fi blueprint aesthetic
        try {
          if (viewer.imageryLayers && viewer.imageryLayers.length > 0) {
            const baseLayer = viewer.imageryLayers.get(0);
            if (baseLayer) {
              baseLayer.brightness = 0.55;
              baseLayer.contrast = 1.25;
              baseLayer.saturation = 0.12;
            }
          }
        } catch (e) {
          console.warn('[GridEvac] Failed to apply base imagery filters:', e);
        }

        viewerRef.current = viewer;

        handleResize = () => {
          if (viewer && !viewer.isDestroyed()) {
            viewer.resize();
          }
        };
        window.addEventListener('resize', handleResize);

        // 3-D OSM Buildings (Houston has excellent coverage)
        try {
          const buildings = await Cesium.createOsmBuildingsAsync();
          if (buildings) {
            buildings.style = new Cesium.Cesium3DTileStyle({
              color: 'color("#3a7bb8", 0.50)' // lighter blueprint blue for better visibility
            });
            viewer.scene.primitives.add(buildings);
            buildingsRef.current = buildings;
            buildings.show = useSimulationStore.getState().showBuildings;
          }
        } catch (e) {
          console.warn('[GridEvac] OSM Buildings unavailable:', e);
        }

        // Initial camera — bird's eye over downtown Houston
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(CENTER.lon, CENTER.lat, 20000),
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
                              Cesium.Color.fromCssColorString('#0088ff').withAlpha(0.18)
                            ),
            height:         9.0,         // start at base elevation
            outline:        false,
          },
          show: false,
        });

        // Tick: pulse origin / dest markers & overloaded substations
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

          // Pulse overloaded substation beacons (real-time telemetry)
          substationEntityMap.current.forEach((subStruct, subId) => {
            const currentRoute = useSimulationStore.getState().route;
            const liveLoads = useSimulationStore.getState().substationLoads;
            const sub = cityData?.substations.find((s) => s.id === subId);
            const currentLoad = liveLoads[subId] ?? (sub ? sub.base_load_mw : 0);
            const capacity = sub ? sub.capacity_mw : 100;
            const isOverloaded = currentLoad > capacity;
            
            if (isOverloaded && subStruct.beacon?.point) {
              const pulseSize = 10 + Math.sin(tickT * 4.0) * 4;
              subStruct.beacon.point.pixelSize = new Cesium.ConstantProperty(pulseSize);
            } else if (subStruct.beacon?.point) {
              subStruct.beacon.point.pixelSize = new Cesium.ConstantProperty(6);
            }
          });

          // Pulse overloaded transmission line widths
          transmissionEntityMap.current.forEach((entity, linkId) => {
            const currentRoute = useSimulationStore.getState().route;
            const lineStates = currentRoute?.transmission_line_states ?? {};
            const state = lineStates[linkId] ?? 'active';
            
            if (state === 'overloaded' && entity.polyline) {
              const pulseWidth = 7 + Math.sin(tickT * 4.0) * 3;
              entity.polyline.width = new Cesium.ConstantProperty(pulseWidth);
            }
          });

          // --- Animated 3D Holographic Indicators ---
          const hoverOffset = Math.sin(tickT * 2.2) * 6.0; // hover up and down ±6m (scaled down)
          const rotAngleA = tickT * 1.5; // rotate clockwise
          const rotAngleB = -tickT * 1.0; // rotate counter-clockwise

          const updateIndicatorAnimation = (ind: any) => {
            if (!ind) return;
            const newHeight = ind.baseHeight + hoverOffset;

            // Update positions
            const posLower = Cesium.Cartesian3.fromDegrees(ind.lon, ind.lat, newHeight - 6.0);
            const posUpper = Cesium.Cartesian3.fromDegrees(ind.lon, ind.lat, newHeight + 6.0);
            const posCenter = Cesium.Cartesian3.fromDegrees(ind.lon, ind.lat, newHeight);

            if (ind.lowerCone) ind.lowerCone.position = new Cesium.ConstantProperty(posLower);
            if (ind.upperCone) ind.upperCone.position = new Cesium.ConstantProperty(posUpper);
            if (ind.innerRing) {
              ind.innerRing.position = new Cesium.ConstantProperty(posCenter);
              ind.innerRing.ellipse.rotation = new Cesium.ConstantProperty(rotAngleA);
            }
            if (ind.outerRing) {
              ind.outerRing.position = new Cesium.ConstantProperty(posCenter);
              ind.outerRing.ellipse.rotation = new Cesium.ConstantProperty(rotAngleB);
            }
          };

          if (originIndicatorRef.current) updateIndicatorAnimation(originIndicatorRef.current);
          if (destIndicatorRef.current)   updateIndicatorAnimation(destIndicatorRef.current);
          exitIndicatorsRef.current.forEach(updateIndicatorAnimation);
          subIndicatorsRef.current.forEach(updateIndicatorAnimation);
        });

        // Register interactive grid picking and hover effects
        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        
        handler.setInputAction((click: any) => {
          const pickedObject = viewer.scene.pick(click.position);
          if (Cesium.defined(pickedObject) && pickedObject.id && typeof pickedObject.id.id === 'string' && pickedObject.id.id.startsWith('node-')) {
            const nodeId = parseInt(pickedObject.id.id.split('-')[1], 10);
            
            // Prevent placing origin on flooded nodes
            const store = useSimulationStore.getState();
            const node = store.cityData?.nodes.find(n => n.id === nodeId);
            const isFlooded = node ? node.elevation <= store.floodLevel * 1.7 : false;
            
            if (isFlooded) {
              store.addLog(`Navigation Alert: Cannot set origin at Node #${nodeId} — intersection is submerged!`);
              return;
            }
            
            useSimulationStore.getState().setOriginNode(nodeId);
          }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        let lastHoveredNodeId: number | null = null;

        handler.setInputAction((movement: any) => {
          const pickedObject = viewer.scene.pick(movement.endPosition);
          
          let pickedNodeId: number | null = null;
          if (Cesium.defined(pickedObject) && pickedObject.id && typeof pickedObject.id.id === 'string' && pickedObject.id.id.startsWith('node-')) {
            pickedNodeId = parseInt(pickedObject.id.id.split('-')[1], 10);
          }

          if (pickedNodeId !== null) {
            viewer.scene.canvas.style.cursor = 'pointer';
            if (pickedNodeId !== lastHoveredNodeId) {
              const state = useSimulationStore.getState();
              if (lastHoveredNodeId !== null && state.cityData) {
                resetNodeOrSubstationHighlight(
                  viewer,
                  lastHoveredNodeId,
                  state.cityData,
                  substationEntityMap.current,
                  state.substationLoads,
                  state.failedSubstations,
                  state.route
                );
              }
              if (state.cityData) {
                highlightNodeOrSubstation(viewer, pickedNodeId, state.cityData, substationEntityMap.current);
              }
              lastHoveredNodeId = pickedNodeId;
            }
          } else {
            viewer.scene.canvas.style.cursor = 'default';
            if (lastHoveredNodeId !== null) {
              const state = useSimulationStore.getState();
              if (state.cityData) {
                resetNodeOrSubstationHighlight(
                  viewer,
                  lastHoveredNodeId,
                  state.cityData,
                  substationEntityMap.current,
                  state.substationLoads,
                  state.failedSubstations,
                  state.route
                );
              }
              lastHoveredNodeId = null;
            }
          }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

      } catch (err) {
        console.error('[GridEvac] Cesium init error:', err);
      }
    })();

    const currentExitIndicators = exitIndicatorsRef.current;
    const currentSubIndicators = subIndicatorsRef.current;
    const currentOriginIndicator = originIndicatorRef.current;
    const currentDestIndicator = destIndicatorRef.current;

    return () => {
      destroyed = true;
      
      // Clean up indicators on unmount
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        if (currentOriginIndicator) removeHolographicIndicator(viewerRef.current, currentOriginIndicator);
        if (currentDestIndicator) removeHolographicIndicator(viewerRef.current, currentDestIndicator);
        currentExitIndicators.forEach((ind) => removeHolographicIndicator(viewerRef.current, ind));
        currentSubIndicators.forEach((ind) => removeHolographicIndicator(viewerRef.current, ind));
        
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
      loadedRef.current = false;
      staticRenderedRef.current = false;
      if (handleResize) {
        window.removeEventListener('resize', handleResize);
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

    const maps = renderStaticCity(viewer, cityData);
    edgeEntityMap.current = maps.edgeEntityMap;
    substationEntityMap.current = maps.substationEntityMap;
    transmissionEntityMap.current = maps.transmissionEntityMap;
  }, [cityData]);

  // ── Toggle OSM Buildings visibility ─────────────────────────────────────────
  useEffect(() => {
    if (buildingsRef.current) {
      buildingsRef.current.show = showBuildings;
    }
  }, [showBuildings]);

  // ── Toggle GIS Map Layers visibility ────────────────────────────────────────
  useEffect(() => {
    if (typeof Cesium === 'undefined') return;

    // Toggle transmission links
    transmissionEntityMap.current.forEach((entity) => {
      entity.show = showPowerLines;
    });

    // Toggle substations
    substationEntityMap.current.forEach((subStruct) => {
      subStruct.transformer.show = showSubstations;
      subStruct.crossArm.show = showSubstations;
      if (subStruct.beacon) subStruct.beacon.show = showSubstations;
      subStruct.insulators.forEach((ins: any) => { ins.show = showSubstations; });
      subStruct.legs.forEach((leg: any) => { leg.show = showSubstations; });
    });

    // Toggle substation labels & grid node intersections
    const viewer = viewerRef.current;
    if (viewer) {
      viewer.entities.values.forEach((entity: any) => {
        if (entity.id && entity.id.startsWith('sub-label-')) {
          entity.show = showSubstations;
        } else if (entity.id && entity.id.startsWith('node-') && !entity.id.includes('-part-')) {
          entity.show = showIntersections;
        }
      });
    }
  }, [showPowerLines, showSubstations, showIntersections]);

  // ── Fly to selected node ────────────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || flyToNodeId === null || !cityData) return;
    if (typeof Cesium === 'undefined') return;

    const node = cityData.nodes.find(n => n.id === flyToNodeId);
    if (node) {
      const entity = viewer.entities.getById(`node-${flyToNodeId}`);
      if (entity) {
        viewer.flyTo(entity, {
          duration: 1.5,
          offset: new Cesium.HeadingPitchRange(
            Cesium.Math.toRadians(0),
            Cesium.Math.toRadians(-60),
            800
          )
        }).then(() => {
          setFlyToNodeId(null);
        });
      }
    }
  }, [flyToNodeId, cityData, setFlyToNodeId]);

  // ── Cinematic fly-to camera trigger when switching sections ─────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || typeof Cesium === 'undefined') return;

    if (activeSection === 'map') {
      // Cinematic zoom-in directly to the Houston grid center
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(CENTER.lon, CENTER.lat - 0.045, 5500),
        orientation: {
          heading: Cesium.Math.toRadians(0),
          pitch:   Cesium.Math.toRadians(-38),
          roll:    0.0,
        },
        duration: 2.5,
      });
    } else if (activeSection === 'briefing' || activeSection === 'audit') {
      // Reset back to zoomed-out orbital bird's eye view
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(CENTER.lon, CENTER.lat, 18000),
        orientation: {
          heading: Cesium.Math.toRadians(15),
          pitch:   Cesium.Math.toRadians(-52),
          roll:    0.0,
        },
        duration: 2.5,
      });
    }
  }, [activeSection]);

  // ── Fly to selected preset coordinates ──────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || flyToCoords === null) return;
    if (typeof Cesium === 'undefined') return;

    const { lon, lat, elev, heading, pitch } = flyToCoords;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, elev),
      orientation: {
        heading: Cesium.Math.toRadians(heading ?? 0),
        pitch:   Cesium.Math.toRadians(pitch ?? -45),
        roll:    0.0,
      },
      duration: 2.0,
    });
    setFlyToCoords(null); // Reset preset
  }, [flyToCoords, setFlyToCoords]);

  // ── Update transmission line wire styles dynamically ───────────────────────
  useEffect(() => {
    if (typeof Cesium === 'undefined' || !cityData) return;

    const lineStates = route?.transmission_line_states ?? {};
    
    transmissionEntityMap.current.forEach((entity, linkId) => {
      const state = lineStates[linkId] ?? 'active'; // 'active' | 'overloaded' | 'dead'
      
      if (entity.polyline) {
        if (state === 'dead') {
          entity.polyline.material = new Cesium.ColorMaterialProperty(
            Cesium.Color.fromCssColorString('#3a3a3a').withAlpha(0.8)
          );
          entity.polyline.width = new Cesium.ConstantProperty(2.0);
        } else if (state === 'overloaded') {
          entity.polyline.material = new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.55,
            color: Cesium.Color.fromCssColorString('#ff2200'),
          });
          entity.polyline.width = new Cesium.ConstantProperty(8.0);
        } else { // active / nominal
          entity.polyline.material = new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.25,
            color: Cesium.Color.fromCssColorString('#ff9800'),
          });
          entity.polyline.width = new Cesium.ConstantProperty(5.0);
        }
      }
    });
  }, [route, cityData]);

  // ── Update flood plane height ───────────────────────────────────────────────
  useEffect(() => {
    const entity = floodEntityRef.current;
    if (!entity) return;
    if (typeof Cesium === 'undefined') return;
    const waterHeight = 9.0 + (floodLevel * FLOOD_M_PER_LEVEL);
    entity.show = floodLevel > 0.05;
    if (entity.polygon) {
      entity.polygon.height = new Cesium.ConstantProperty(waterHeight);
    }
  }, [floodLevel]);

  // ── Update substation marker colors (real-time loads version) ──
  useEffect(() => {
    if (typeof Cesium === 'undefined' || !cityData) return;

    substationEntityMap.current.forEach((subStruct, subId) => {
      const isManualFailed = failedSubstations.includes(subId);
      const isCascaded = route?.cascaded_substations?.includes(subId) ?? false;
      const isFailed = isManualFailed || isCascaded;

      const sub = cityData.substations.find((s) => s.id === subId);
      const currentLoad = substationLoads[subId] ?? (sub ? sub.base_load_mw : 0);
      const capacity = sub ? sub.capacity_mw : 100;
      const isOverloaded = !isFailed && currentLoad > capacity;

      let color = Cesium.Color.fromCssColorString('#ffc107');
      let outlineColor = Cesium.Color.fromCssColorString('#ff9800');

      if (isFailed) {
        color = Cesium.Color.fromCssColorString('#ff3d3d');
        outlineColor = Cesium.Color.fromCssColorString('#555555').withAlpha(0.5);
      } else if (isOverloaded) {
        color = Cesium.Color.fromCssColorString('#ff9100');
        outlineColor = Cesium.Color.WHITE;
      }

      if (subStruct.transformer.box) {
        subStruct.transformer.box.material = new Cesium.ColorMaterialProperty(color.withAlpha(isFailed ? 0.12 : 0.25));
        subStruct.transformer.box.outlineColor = new Cesium.ConstantProperty(outlineColor);
      }
      subStruct.legs.forEach((leg: any) => {
        if (leg.cylinder) {
          leg.cylinder.material = new Cesium.ColorMaterialProperty(color.withAlpha(isFailed ? 0.08 : 0.35));
          leg.cylinder.outlineColor = new Cesium.ConstantProperty(outlineColor);
        }
      });
      if (subStruct.crossArm.box) {
        subStruct.crossArm.box.material = new Cesium.ColorMaterialProperty(color.withAlpha(isFailed ? 0.12 : 0.5));
        subStruct.crossArm.box.outlineColor = new Cesium.ConstantProperty(outlineColor);
      }
      subStruct.insulators.forEach((ins: any) => {
        if (ins.cylinder) {
          ins.cylinder.material = new Cesium.ColorMaterialProperty(color.withAlpha(isFailed ? 0.12 : 0.55));
          ins.cylinder.outlineColor = new Cesium.ConstantProperty(outlineColor);
        }
      });
      if (subStruct.beacon && subStruct.beacon.point) {
        subStruct.beacon.point.color = new Cesium.ConstantProperty(isFailed ? Cesium.Color.RED : (isOverloaded ? Cesium.Color.WHITE : color));
      }
    });
  }, [failedSubstations, route, cityData, substationLoads]);

  // ── Update blackout zone cylinders (manual + cascades) ─────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cityData) return;
    if (typeof Cesium === 'undefined') return;

    // Remove old blackout entities
    blackoutRefs.current.forEach((e) => viewer.entities.remove(e));
    blackoutRefs.current.clear();

    const activeBlackoutIds = [
      ...failedSubstations,
      ...(route?.cascaded_substations ?? [])
    ];

    for (const subId of activeBlackoutIds) {
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
  }, [failedSubstations, route, cityData]);

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

    // Colour hazard roads (streets under compromised transmission lines)
    if (route.hazard_roads) {
      for (const [key, state] of Object.entries(route.hazard_roads)) {
        const [uStr, vStr] = key.split('-');
        const u = parseInt(uStr, 10);
        const v = parseInt(vStr, 10);
        const key1 = `${u}-${v}`;
        const key2 = `${v}-${u}`;
        const entity = edgeEntityMap.current.get(key1) ?? edgeEntityMap.current.get(key2);
        if (entity?.polyline) {
          if (state === 'dead') {
            entity.polyline.material = new Cesium.ColorMaterialProperty(
              Cesium.Color.fromCssColorString('#ff6600').withAlpha(0.85)
            );
            entity.polyline.width = new Cesium.ConstantProperty(4.5);
          } else if (state === 'overloaded') {
            entity.polyline.material = new Cesium.ColorMaterialProperty(
              Cesium.Color.fromCssColorString('#ffea00').withAlpha(0.85)
            );
            entity.polyline.width = new Cesium.ConstantProperty(3.5);
          }
        }
      }
    }

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
    const positions: number[] = [];
    for (const c of route.path_coords) {
      if (c && typeof c.lon === 'number' && !isNaN(c.lon) &&
          typeof c.lat === 'number' && !isNaN(c.lat) &&
          typeof c.elevation === 'number' && !isNaN(c.elevation)) {
        positions.push(c.lon, c.lat, c.elevation);
      }
    }
    if (positions.length < 6) return;

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
        6000,
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

  // ── Render exits holographic indicators ──
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cityData) return;
    if (typeof Cesium === 'undefined') return;

    exitIndicatorsRef.current.forEach((ind) => removeHolographicIndicator(viewer, ind));
    exitIndicatorsRef.current.clear();

    const SAFE_EXITS = [14, 120, 164, 210];
    for (const exitId of SAFE_EXITS) {
      const exitNode = cityData.nodes.find(n => n.id === exitId);
      if (!exitNode) continue;
      
      const indicator = createHolographicIndicator(viewer, exitNode.lon, exitNode.lat, exitNode.elevation, '#00ff88');
      exitIndicatorsRef.current.set(exitId, indicator);
    }
  }, [cityData]);

  // ── Update origin/dest holographic indicators ──
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cityData) return;
    if (typeof Cesium === 'undefined') return;

    if (originIndicatorRef.current) {
      removeHolographicIndicator(viewer, originIndicatorRef.current);
      originIndicatorRef.current = null;
    }
    if (destIndicatorRef.current) {
      removeHolographicIndicator(viewer, destIndicatorRef.current);
      destIndicatorRef.current = null;
    }

    const orig = cityData.nodes.find((n) => n.id === originNode);
    const dest = cityData.nodes.find((n) => n.id === destNode);

    if (orig) {
      originIndicatorRef.current = createHolographicIndicator(viewer, orig.lon, orig.lat, orig.elevation, '#00e5ff');
    }
    if (dest && destNode !== -1) {
      destIndicatorRef.current = createHolographicIndicator(viewer, dest.lon, dest.lat, dest.elevation, '#ff6b35');
    }
  }, [originNode, destNode, cityData]);

  // ── Update substation holographic indicators (real-time loads version) ──
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cityData) return;
    if (typeof Cesium === 'undefined') return;

    const manualFailedIds = failedSubstations ?? [];
    const activeCascadedIds = route?.cascaded_substations ?? [];

    const activeOverloadedIds: number[] = [];
    cityData.substations.forEach((sub) => {
      const isFailed = manualFailedIds.includes(sub.id) || activeCascadedIds.includes(sub.id);
      const currentLoad = substationLoads[sub.id] ?? sub.base_load_mw;
      if (!isFailed && currentLoad > sub.capacity_mw) {
        activeOverloadedIds.push(sub.id);
      }
    });

    const criticalSubIds = new Set([
      ...activeOverloadedIds,
      ...activeCascadedIds,
      ...manualFailedIds
    ]);

    // 1. Remove indicators that are no longer critical
    subIndicatorsRef.current.forEach((ind, subId) => {
      if (!criticalSubIds.has(subId)) {
        removeHolographicIndicator(viewer, ind);
        subIndicatorsRef.current.delete(subId);
      }
    });

    // 2. Add or update indicators for critical substations
    criticalSubIds.forEach((subId) => {
      const sub = cityData.substations.find((s) => s.id === subId);
      if (!sub) return;

      const isFailed = manualFailedIds.includes(subId) || activeCascadedIds.includes(subId);
      const colorHex = isFailed ? '#ff3d3d' : '#ff9100';

      const existing = subIndicatorsRef.current.get(subId);
      if (existing) {
        const color = Cesium.Color.fromCssColorString(colorHex);
        const material = new Cesium.ColorMaterialProperty(color.withAlpha(0.65));
        const ringMaterialInner = new Cesium.ColorMaterialProperty(color.withAlpha(0.08));
        const ringMaterialOuter = new Cesium.ColorMaterialProperty(color.withAlpha(0.03));
        const outlineColor = new Cesium.ConstantProperty(color);

        if (existing.lowerCone?.cylinder) {
          existing.lowerCone.cylinder.material = material;
        }
        if (existing.upperCone?.cylinder) {
          existing.upperCone.cylinder.material = material;
        }
        if (existing.innerRing?.ellipse) {
          existing.innerRing.ellipse.material = ringMaterialInner;
          existing.innerRing.ellipse.outlineColor = outlineColor;
        }
        if (existing.outerRing?.ellipse) {
          existing.outerRing.ellipse.material = ringMaterialOuter;
          existing.outerRing.ellipse.outlineColor = new Cesium.ConstantProperty(color.withAlpha(0.6));
        }
      } else {
        const node = cityData.nodes.find((n) => n.id === sub.node);
        const elev = node?.elevation ?? 10.0;
        const indicator = createHolographicIndicator(viewer, sub.lon, sub.lat, elev, colorHex);
        subIndicatorsRef.current.set(subId, indicator);
      }
    });
  }, [failedSubstations, route, cityData, substationLoads]);

  const isMapActive = activeSection === 'map';

  let activeFilter = 'none';
  if (!isMapActive) {
    activeFilter = 'blur(10px) brightness(0.35)';
  } else {
    if (mapFilterMode === 'radar') {
      activeFilter = 'hue-rotate(90deg) saturate(1.8) brightness(0.85) contrast(1.1)'; // green radar HUD
    } else if (mapFilterMode === 'thermal') {
      activeFilter = 'sepia(0.65) saturate(2.2) hue-rotate(320deg) contrast(1.1) brightness(0.9)'; // amber thermal strain
    }
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 1,
        filter: activeFilter,
        pointerEvents: isMapActive ? 'auto' : 'none',
        transition: 'filter 0.6s cubic-bezier(0.16, 1, 0.3, 1), brightness 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateCatenaryPoints(subA: any, subB: any, cityData: CityData): number[] {
  const points: number[] = [];
  const segments = 10;
  const sag = 6.0; // 6 metres sag in the middle
  
  const nodeA = cityData.nodes.find(n => n.id === subA.node);
  const nodeB = cityData.nodes.find(n => n.id === subB.node);
  if (!nodeA || !nodeB) return [];
  const elevA = nodeA.elevation ?? 10.0;
  const elevB = nodeB.elevation ?? 10.0;
  
  const heightA = elevA + 35.0; // Adjusted top arm height for catenary
  const heightB = elevB + 35.0;
  
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const lon = subA.lon + t * (subB.lon - subA.lon);
    const lat = subA.lat + t * (subB.lat - subA.lat);
    const elevation = (1 - t) * heightA + t * heightB - sag * Math.sin(Math.PI * t);
    if (!isNaN(lon) && !isNaN(lat) && !isNaN(elevation)) {
      points.push(lon, lat, elevation);
    }
  }
  return points;
}

function renderStaticCity(viewer: any, cityData: CityData): { 
  edgeEntityMap: Map<string, any>; 
  substationEntityMap: Map<number, any>;
  transmissionEntityMap: Map<number, any>;
} {
  const edgeEntityMap = new Map<string, any>();
  const substationEntityMap = new Map<number, any>();
  const transmissionEntityMap = new Map<number, any>();

  // ── Street edges ───────────────────────────────────────────────────────────
  for (const edge of cityData.edges) {
    const src = cityData.nodes.find((n) => n.id === edge.source);
    const tgt = cityData.nodes.find((n) => n.id === edge.target);
    if (!src || !tgt) continue;

    const height = Math.min(src.elevation, tgt.elevation) + 2;
    if (isNaN(src.lon) || isNaN(src.lat) || isNaN(tgt.lon) || isNaN(tgt.lat) || isNaN(height)) {
      continue;
    }

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

    edgeEntityMap.set(`${edge.source}-${edge.target}`, entity);
  }

  // ── Substation markers (composite towers version) ──────────────────────────
  for (const sub of cityData.substations) {
    if (isNaN(sub.lon) || isNaN(sub.lat)) continue;

    const node = cityData.nodes.find(n => n.id === sub.node);
    const elev = node?.elevation ?? 10.0;

    const subStruct = renderSubstationStructure(viewer, sub, '#ffc107', elev);
    substationEntityMap.set(sub.id, subStruct);

    // Label
    viewer.entities.add({
      id: `sub-label-${sub.id}`,
      position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat, elev + 48),
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

  // ── Transmission lines (hanging power lines) ──────────────────────────────
  for (const link of cityData.transmission_links) {
    const subA = cityData.substations.find(s => s.id === link.from_sub);
    const subB = cityData.substations.find(s => s.id === link.to_sub);
    if (!subA || !subB) continue;
    
    const positions = generateCatenaryPoints(subA, subB, cityData);
    if (positions.length < 6) continue;
    
    const entity = viewer.entities.add({
      id: `transmission-link-${link.id}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(positions),
        width: 5,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.25,
          color: Cesium.Color.fromCssColorString('#ff9800'), // default amber
        }),
        clampToGround: false,
      }
    });
    
    transmissionEntityMap.set(link.id, entity);
  }

  // ── Safe exits protective dome shields ─────────────────────────────────────
  const SAFE_EXITS = [14, 120, 164, 210];
  for (const exitId of SAFE_EXITS) {
    const exitNode = cityData.nodes.find(n => n.id === exitId);
    if (!exitNode || isNaN(exitNode.lon) || isNaN(exitNode.lat) || isNaN(exitNode.elevation)) continue;
    
    // Glowing green protective shield dome sitting on the terrain (scaled down)
    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(exitNode.lon, exitNode.lat, exitNode.elevation),
      ellipsoid: {
        radii: new Cesium.Cartesian3(30.0, 30.0, 20.0), // 30m radius, 20m height
        slicePartitions: 12,
        stackPartitions: 12,
        material: Cesium.Color.fromCssColorString('#00ff88').withAlpha(0.12),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#00ff88').withAlpha(0.5),
        outlineWidth: 1.5,
      }
    });
  }

  // ── Interactive Neon Grid Pyramid Beacons (scaled down) ────────────────────
  for (const node of cityData.nodes) {
    const isExit = SAFE_EXITS.includes(node.id);
    if (isNaN(node.lon) || isNaN(node.lat) || isNaN(node.elevation)) continue;
    
    const color = isExit ? Cesium.Color.fromCssColorString('#00ff88') : Cesium.Color.fromCssColorString('#00e5ff');

    viewer.entities.add({
      id: `node-${node.id}`,
      position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat, node.elevation + 2.5),
      cylinder: {
        length: 5.0,
        topRadius: 0.0,
        bottomRadius: 1.5,
        material: new Cesium.ColorMaterialProperty(color.withAlpha(0.65)),
        outline: true,
        outlineColor: new Cesium.ConstantProperty(color),
        outlineWidth: 1.2,
      },
      label: {
        text: `Node ${node.id}`,
        font: '600 10px Rajdhani, sans-serif',
        fillColor: isExit ? Cesium.Color.fromCssColorString('#00ff88') : Cesium.Color.fromCssColorString('#00e5ff'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1.5,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -10),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 1000.0),
      }
    });
  }

  return { edgeEntityMap, substationEntityMap, transmissionEntityMap };
}

function renderSubstationStructure(viewer: any, sub: any, colorHex: string, elev: number = 10.0) {
  const color = Cesium.Color.fromCssColorString(colorHex);
  const lon = sub.lon;
  const lat = sub.lat;
  
  // 1. Central transformer vault (glow box) sitting on ground
  const transformer = viewer.entities.add({
    id: `node-${sub.node}-part-transformer`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, elev + 4.0),
    box: {
      dimensions: new Cesium.Cartesian3(8.0, 8.0, 8.0),
      material: new Cesium.ColorMaterialProperty(color.withAlpha(0.25)),
      outline: true,
      outlineColor: new Cesium.ConstantProperty(color.withAlpha(0.8)),
      outlineWidth: 1.5,
    }
  });

  // 2. Structural pylon legs (4 corner columns slanting up)
  const offset = 0.00006; // approx 5-6 meters offset
  const legOffsets = [
    { x: -offset, y: -offset },
    { x: offset, y: -offset },
    { x: offset, y: offset },
    { x: -offset, y: offset }
  ];
  const legs = legOffsets.map((off, idx) => {
    return viewer.entities.add({
      id: `node-${sub.node}-part-leg-${idx}`,
      position: Cesium.Cartesian3.fromDegrees(lon + off.x, lat + off.y, elev + 17.5),
      cylinder: {
        length: 35.0,
        topRadius: 0.5,
        bottomRadius: 1.2,
        material: new Cesium.ColorMaterialProperty(color.withAlpha(0.35)),
        outline: true,
        outlineColor: new Cesium.ConstantProperty(color.withAlpha(0.7)),
        outlineWidth: 1.0,
      }
    });
  });

  // 3. High-voltage bushings (insulator cones on top of transformer box)
  const insulatorOffsets = [-2.5, 0, 2.5];
  const insulators = insulatorOffsets.map((offX, idx) => {
    return viewer.entities.add({
      id: `node-${sub.node}-part-insulator-${idx}`,
      position: Cesium.Cartesian3.fromDegrees(lon + offX * 0.00003, lat, elev + 10.5),
      cylinder: {
        length: 5.0,
        topRadius: 0.2,
        bottomRadius: 0.8,
        material: new Cesium.ColorMaterialProperty(color.withAlpha(0.55)),
        outline: true,
        outlineColor: new Cesium.ConstantProperty(color.withAlpha(0.8)),
        outlineWidth: 1.0,
      }
    });
  });

  // 4. Structural cross-arm support beam at top (35 meters high)
  const crossArm = viewer.entities.add({
    id: `node-${sub.node}-part-crossArm`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, elev + 35.0),
    box: {
      dimensions: new Cesium.Cartesian3(16.0, 1.2, 1.0),
      material: new Cesium.ColorMaterialProperty(color.withAlpha(0.5)),
      outline: true,
      outlineColor: new Cesium.ConstantProperty(color.withAlpha(0.8)),
      outlineWidth: 1.5,
    }
  });

  // 5. Warning indicator beacon at the very top center of the cross-arm
  const beacon = viewer.entities.add({
    id: `node-${sub.node}-part-beacon`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, elev + 36.0),
    point: {
      pixelSize: 6,
      color: color,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 1.5,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    }
  });

  return {
    transformer,
    legs,
    insulators,
    crossArm,
    beacon
  };
}

function createHolographicIndicator(viewer: any, lon: number, lat: number, elev: number, colorHex: string) {
  const color = Cesium.Color.fromCssColorString(colorHex);
  const baseHeight = elev + 60.0; // Float 60 meters above base (24m above top cross-arm)

  // Lower cone pointing up (apex at bottom, base at top)
  const lowerCone = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, baseHeight - 6.0),
    cylinder: {
      length: 12.0,
      topRadius: 4.0,
      bottomRadius: 0.0,
      material: new Cesium.ColorMaterialProperty(color.withAlpha(0.65)),
      outline: true,
      outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(0.85)),
      outlineWidth: 1.5,
    }
  });

  // Upper cone pointing down (apex at top, base at bottom)
  const upperCone = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, baseHeight + 6.0),
    cylinder: {
      length: 12.0,
      topRadius: 0.0,
      bottomRadius: 4.0,
      material: new Cesium.ColorMaterialProperty(color.withAlpha(0.65)),
      outline: true,
      outlineColor: new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(0.85)),
      outlineWidth: 1.5,
    }
  });

  // Inner ring rotating clockwise
  const innerRing = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, baseHeight),
    ellipse: {
      semiMajorAxis: 10.0,
      semiMinorAxis: 5.0,
      material: new Cesium.ColorMaterialProperty(color.withAlpha(0.08)),
      outline: true,
      outlineColor: new Cesium.ConstantProperty(color),
      outlineWidth: 2.0,
      height: 0.0,
    }
  });

  // Outer ring rotating counter-clockwise
  const outerRing = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, baseHeight),
    ellipse: {
      semiMajorAxis: 14.0,
      semiMinorAxis: 8.0,
      material: new Cesium.ColorMaterialProperty(color.withAlpha(0.03)),
      outline: true,
      outlineColor: new Cesium.ConstantProperty(color.withAlpha(0.6)),
      outlineWidth: 1.5,
      height: 0.0,
    }
  });

  return {
    lowerCone,
    upperCone,
    innerRing,
    outerRing,
    baseHeight,
    lon,
    lat,
  };
}

function removeHolographicIndicator(viewer: any, indicator: any) {
  if (!indicator) return;
  if (indicator.lowerCone) viewer.entities.remove(indicator.lowerCone);
  if (indicator.upperCone) viewer.entities.remove(indicator.upperCone);
  if (indicator.innerRing) viewer.entities.remove(indicator.innerRing);
  if (indicator.outerRing) viewer.entities.remove(indicator.outerRing);
}

function highlightNodeOrSubstation(viewer: any, nodeId: number, cityData: CityData, substationEntityMap: Map<number, any>) {
  // 1. Highlight the node pyramid itself
  const nodeEntity = viewer.entities.getById(`node-${nodeId}`);
  if (nodeEntity && nodeEntity.cylinder) {
    nodeEntity.cylinder.outlineColor = new Cesium.ConstantProperty(Cesium.Color.WHITE);
    nodeEntity.cylinder.outlineWidth = new Cesium.ConstantProperty(2.5);
  }

  // 2. Highlight substation structure if it exists at this node
  const sub = cityData.substations.find(s => s.node === nodeId);
  if (sub) {
    const subStruct = substationEntityMap.get(sub.id);
    if (subStruct) {
      const whiteOutline = new Cesium.ConstantProperty(Cesium.Color.WHITE);
      const thickWidth = new Cesium.ConstantProperty(2.5);

      if (subStruct.transformer.box) {
        subStruct.transformer.box.outlineColor = whiteOutline;
        subStruct.transformer.box.outlineWidth = thickWidth;
      }
      subStruct.legs.forEach((leg: any) => {
        if (leg.cylinder) {
          leg.cylinder.outlineColor = whiteOutline;
          leg.cylinder.outlineWidth = new Cesium.ConstantProperty(2.0);
        }
      });
      if (subStruct.crossArm.box) {
        subStruct.crossArm.box.outlineColor = whiteOutline;
        subStruct.crossArm.box.outlineWidth = thickWidth;
      }
      subStruct.insulators.forEach((ins: any) => {
        if (ins.cylinder) {
          ins.cylinder.outlineColor = whiteOutline;
          ins.cylinder.outlineWidth = new Cesium.ConstantProperty(2.0);
        }
      });
    }
  }
}

function resetNodeOrSubstationHighlight(
  viewer: any,
  nodeId: number,
  cityData: CityData,
  substationEntityMap: Map<number, any>,
  substationLoads: Record<number, number>,
  failedSubstations: number[],
  route: any
) {
  // 1. Reset regular node pyramid outline
  const nodeEntity = viewer.entities.getById(`node-${nodeId}`);
  if (nodeEntity && nodeEntity.cylinder) {
    const isExit = [14, 120, 164, 210].includes(nodeId);
    const color = isExit ? Cesium.Color.fromCssColorString('#00ff88') : Cesium.Color.fromCssColorString('#00e5ff');
    nodeEntity.cylinder.outlineColor = new Cesium.ConstantProperty(color);
    nodeEntity.cylinder.outlineWidth = new Cesium.ConstantProperty(1.2);
  }

  // 2. Reset substation structure outlines and materials
  const sub = cityData.substations.find(s => s.node === nodeId);
  if (sub) {
    const subStruct = substationEntityMap.get(sub.id);
    if (subStruct) {
      const isManualFailed = failedSubstations.includes(sub.id);
      const isCascaded = route?.cascaded_substations?.includes(sub.id) ?? false;
      const isFailed = isManualFailed || isCascaded;

      const currentLoad = substationLoads[sub.id] ?? sub.base_load_mw;
      const capacity = sub.capacity_mw;
      const isOverloaded = !isFailed && currentLoad > capacity;

      let color = Cesium.Color.fromCssColorString('#ffc107');
      let outlineColor = Cesium.Color.fromCssColorString('#ff9800');

      if (isFailed) {
        color = Cesium.Color.fromCssColorString('#ff3d3d');
        outlineColor = Cesium.Color.fromCssColorString('#555555').withAlpha(0.5);
      } else if (isOverloaded) {
        color = Cesium.Color.fromCssColorString('#ff9100');
        outlineColor = Cesium.Color.WHITE;
      }

      if (subStruct.transformer.box) {
        subStruct.transformer.box.outlineColor = new Cesium.ConstantProperty(outlineColor);
        subStruct.transformer.box.outlineWidth = new Cesium.ConstantProperty(1.5);
      }
      subStruct.legs.forEach((leg: any) => {
        if (leg.cylinder) {
          leg.cylinder.outlineColor = new Cesium.ConstantProperty(outlineColor);
          leg.cylinder.outlineWidth = new Cesium.ConstantProperty(1.0);
        }
      });
      if (subStruct.crossArm.box) {
        subStruct.crossArm.box.outlineColor = new Cesium.ConstantProperty(outlineColor);
        subStruct.crossArm.box.outlineWidth = new Cesium.ConstantProperty(1.5);
      }
      subStruct.insulators.forEach((ins: any) => {
        if (ins.cylinder) {
          ins.cylinder.outlineColor = new Cesium.ConstantProperty(outlineColor);
          ins.cylinder.outlineWidth = new Cesium.ConstantProperty(1.0);
        }
      });
    }
  }
}
