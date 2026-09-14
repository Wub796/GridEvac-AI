'use client';

import { useEffect, useRef } from 'react';
import { useSimulationStore, type UserLocation } from '@/hooks/useSimulation';
import { useScrollProgress } from '@/hooks/useScrollProgress';
import { waterSurfaceM } from '@/lib/solver';
import { loadTerrain, terrainBounds, type TerrainGrid } from '@/lib/terrain';
import type { CityData, RouteResponse } from '@/lib/types';

const STREET_STYLE: Record<string, [number, number]> = {
  arterial: [1.5, 0.62],
  collector: [1.1, 0.46],
  local: [0.75, 0.32],
  service: [0.5, 0.18],
};

type Projection = { toX: (lon: number) => number; toY: (lat: number) => number };

/**
 * The hero: the district drawn from the real street network at true scale.
 * Streets draw outward from the centre on arrival, water from the terrain
 * model fills the low ground, and the recommended corridor traces itself with
 * a pulse travelling toward the exit. It redraws whenever the scenario does.
 */
export default function NetworkCanvas() {
  const figureRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useScrollProgress(figureRef);
  const cityData = useSimulationStore((state) => state.cityData);
  const route = useSimulationStore((state) => state.route);
  const floodLevel = useSimulationStore((state) => state.floodLevel);
  const originNode = useSimulationStore((state) => state.originNode);
  const userLocation = useSimulationStore((state) => state.userLocation);

  const engine = useRef({
    terrain: null as TerrainGrid | null,
    streets: null as HTMLCanvasElement | null,
    water: null as HTMLCanvasElement | null,
    waterSurface: Number.NaN,
    waterFrom: 0,
    waterTo: 0,
    waterStart: 0,
    bootStart: 0,
    drawnEdges: 0,
    order: [] as number[],
    routeStart: 0,
    routePoints: [] as Array<[number, number]>,
    routeLengths: [] as number[],
    frame: 0,
    visible: true,
    reduced: false,
    projection: null as Projection | null,
    city: null as CityData | null,
    route: null as RouteResponse | null,
    origin: 0,
    user: null as UserLocation | null,
    width: 0,
    height: 0,
    dpr: 1,
    kick: () => {},
    rebuild: () => {},
    routeReady: () => {},
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const figure = figureRef.current;
    if (!canvas || !figure) return;
    const state = engine.current;
    state.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const context = canvas.getContext('2d');
    if (!context) return;

    const layer = () => {
      const element = document.createElement('canvas');
      element.width = canvas.width;
      element.height = canvas.height;
      return element;
    };

    const project = (city: CityData) => {
      let south = Infinity; let north = -Infinity; let west = Infinity; let east = -Infinity;
      city.nodes.forEach((node) => {
        south = Math.min(south, node.lat); north = Math.max(north, node.lat);
        west = Math.min(west, node.lon); east = Math.max(east, node.lon);
      });
      const cos = Math.cos(((south + north) / 2) * Math.PI / 180);
      const spanX = (east - west) * cos;
      const spanY = north - south;
      const pad = 18 * state.dpr;
      const scale = Math.min((state.width - pad * 2) / spanX, (state.height - pad * 2) / spanY);
      const offsetX = (state.width - spanX * scale) / 2;
      const offsetY = (state.height - spanY * scale) / 2;
      state.projection = {
        toX: (lon) => offsetX + (lon - west) * cos * scale,
        toY: (lat) => offsetY + (north - lat) * scale,
      };
    };

    const drawStreets = (city: CityData, upTo: number) => {
      const { projection, streets } = state;
      if (!projection || !streets) return;
      const ctx = streets.getContext('2d')!;
      const nodes = new Map(city.nodes.map((node) => [node.id, node]));
      ctx.lineCap = 'round';
      for (let i = state.drawnEdges; i < upTo; i += 1) {
        const edge = city.edges[state.order[i]];
        const a = nodes.get(edge.source);
        const b = nodes.get(edge.target);
        if (!a || !b) continue;
        const [width, alpha] = STREET_STYLE[edge.road_class] ?? STREET_STYLE.local;
        ctx.strokeStyle = `rgba(206, 222, 228, ${alpha})`;
        ctx.lineWidth = width * state.dpr;
        ctx.beginPath();
        ctx.moveTo(projection.toX(a.lon), projection.toY(a.lat));
        (edge.geometry ?? []).forEach(([lat, lon]) => ctx.lineTo(projection.toX(lon), projection.toY(lat)));
        ctx.lineTo(projection.toX(b.lon), projection.toY(b.lat));
        ctx.stroke();
      }
      state.drawnEdges = upTo;
    };

    const drawWater = (surface: number) => {
      const { terrain, projection } = state;
      if (!terrain || !projection) return;
      if (!state.water) state.water = document.createElement('canvas');
      const water = state.water;
      water.width = terrain.cols;
      water.height = terrain.rows;
      const ctx = water.getContext('2d')!;
      const image = ctx.createImageData(terrain.cols, terrain.rows);
      for (let i = 0; i < terrain.stage.length; i += 1) {
        if (terrain.stage[i] > surface) continue;
        const depth = surface - terrain.ground[i];
        const t = Math.min(1, Math.max(0, depth / 4));
        const o = i * 4;
        image.data[o] = 82 - 58 * t;
        image.data[o + 1] = 197 - 86 * t;
        image.data[o + 2] = 245 - 80 * t;
        image.data[o + 3] = 90 + 110 * t;
      }
      ctx.putImageData(image, 0, 0);
      state.waterSurface = surface;
    };

    const prepareRoute = () => {
      const { projection, route: current } = state;
      state.routePoints = [];
      state.routeLengths = [];
      if (!projection || !current?.success) return;
      let total = 0;
      current.path_coords.forEach((coord, index) => {
        const point: [number, number] = [projection.toX(coord.lon), projection.toY(coord.lat)];
        if (index > 0) {
          const [px, py] = state.routePoints[index - 1];
          total += Math.hypot(point[0] - px, point[1] - py);
        }
        state.routePoints.push(point);
        state.routeLengths.push(total);
      });
    };

    const pointAt = (distance: number): [number, number] | null => {
      const { routePoints: points, routeLengths: lengths } = state;
      if (points.length < 2) return null;
      const target = Math.max(0, Math.min(distance, lengths[lengths.length - 1]));
      let index = 1;
      while (index < lengths.length - 1 && lengths[index] < target) index += 1;
      const span = lengths[index] - lengths[index - 1] || 1;
      const t = (target - lengths[index - 1]) / span;
      return [points[index - 1][0] + (points[index][0] - points[index - 1][0]) * t, points[index - 1][1] + (points[index][1] - points[index - 1][1]) * t];
    };

    const render = (now: number) => {
      state.frame = 0;
      const city = state.city;
      if (!city || !state.projection) return;
      // Finite work (street boot, water tween, route trace) always runs to
      // completion; only the looping pulse pauses while the hero is off screen.
      let busy = false;
      let pulsing = false;

      // Streets: outward from the centre over 1.6 s on first arrival.
      if (state.drawnEdges < city.edges.length) {
        if (!state.bootStart) state.bootStart = now;
        const progress = state.reduced ? 1 : Math.min(1, (now - state.bootStart) / 1600);
        drawStreets(city, Math.floor((1 - (1 - progress) ** 3) * city.edges.length));
        busy = progress < 1;
        if (!busy && state.drawnEdges < city.edges.length) drawStreets(city, city.edges.length);
      }
      const booted = state.drawnEdges >= city.edges.length;

      // Water: tween the surface so a change reads as water rising or falling.
      if (state.terrain && booted) {
        const progress = state.reduced ? 1 : Math.min(1, (now - state.waterStart) / 900);
        const surface = state.waterFrom + (state.waterTo - state.waterFrom) * (1 - (1 - progress) ** 3);
        if (Math.abs(surface - state.waterSurface) > 0.004 || Number.isNaN(state.waterSurface)) drawWater(surface);
        busy = busy || progress < 1;
      }

      context.clearRect(0, 0, state.width, state.height);
      if (state.streets) context.drawImage(state.streets, 0, 0);
      if (state.water && state.terrain && booted) {
        const bounds = terrainBounds(state.terrain);
        const x0 = state.projection.toX(bounds.west);
        const y0 = state.projection.toY(bounds.north);
        context.imageSmoothingEnabled = true;
        context.globalCompositeOperation = 'lighter';
        context.globalAlpha = 0.85;
        context.drawImage(state.water, x0, y0, state.projection.toX(bounds.east) - x0, state.projection.toY(bounds.south) - y0);
        context.globalAlpha = 1;
        context.globalCompositeOperation = 'source-over';
      }

      // Waterways sit on top of the fill as crisp centerlines.
      if (booted) {
        context.strokeStyle = 'rgba(120, 212, 250, 0.75)';
        context.lineWidth = 1.6 * state.dpr;
        (city.waterways ?? []).forEach((way) => {
          context.beginPath();
          way.coords.forEach(([lat, lon], index) => {
            const x = state.projection!.toX(lon);
            const y = state.projection!.toY(lat);
            if (index) context.lineTo(x, y); else context.moveTo(x, y);
          });
          context.stroke();
        });
      }

      // Corridor: trace, then a pulse travelling toward the exit.
      const total = state.routeLengths[state.routeLengths.length - 1] ?? 0;
      if (booted && total > 0) {
        const traced = state.reduced ? 1 : Math.min(1, (now - state.routeStart) / 1100);
        const end = (1 - (1 - traced) ** 3) * total;
        context.lineJoin = 'round';
        context.lineCap = 'round';
        const stroke = (width: number, color: string) => {
          context.strokeStyle = color;
          context.lineWidth = width * state.dpr;
          context.beginPath();
          state.routePoints.forEach(([x, y], index) => {
            if (state.routeLengths[index] > end) return;
            if (index) context.lineTo(x, y); else context.moveTo(x, y);
          });
          const head = pointAt(end);
          if (head) context.lineTo(head[0], head[1]);
          context.stroke();
        };
        stroke(9, 'rgba(255, 154, 60, 0.16)');
        stroke(4.5, 'rgba(10, 17, 21, 0.9)');
        stroke(2.6, '#ff9a3c');
        busy = busy || traced < 1;
        if (traced >= 1 && !state.reduced && state.visible) {
          pulsing = true;
          const cycle = ((now - state.routeStart) % 3400) / 3400;
          for (let k = 0; k < 4; k += 1) {
            const at = pointAt((cycle - k * 0.018) * total);
            if (!at || cycle - k * 0.018 < 0) continue;
            context.fillStyle = `rgba(255, 226, 190, ${0.9 - k * 0.22})`;
            context.beginPath();
            context.arc(at[0], at[1], (3.2 - k * 0.6) * state.dpr, 0, Math.PI * 2);
            context.fill();
          }
        }
        const last = state.routePoints[state.routePoints.length - 1];
        if (traced >= 1 && last) {
          context.strokeStyle = '#ff9a3c';
          context.lineWidth = 2 * state.dpr;
          context.beginPath();
          context.arc(last[0], last[1], 6 * state.dpr, 0, Math.PI * 2);
          context.stroke();
        }
      }

      const origin = city.nodes.find((node) => node.id === state.origin);
      if (origin && booted) {
        const x = state.projection.toX(origin.lon);
        const y = state.projection.toY(origin.lat);
        context.fillStyle = '#43d397';
        context.beginPath();
        context.arc(x, y, 4.5 * state.dpr, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = 'rgba(10, 17, 21, 0.95)';
        context.lineWidth = 2 * state.dpr;
        context.stroke();
      }

      const user = state.user;
      if (user && booted) {
        const x = state.projection.toX(user.fix.lon);
        const y = state.projection.toY(user.fix.lat);
        const radius = Math.abs(state.projection.toY(user.fix.lat + user.fix.accuracy / 111320) - y);
        context.fillStyle = 'rgba(139, 150, 255, 0.18)';
        context.beginPath();
        context.arc(x, y, Math.max(7 * state.dpr, radius), 0, Math.PI * 2);
        context.fill();
        context.fillStyle = '#8b96ff';
        context.strokeStyle = '#ffffff';
        context.lineWidth = 2 * state.dpr;
        context.beginPath();
        context.arc(x, y, 4.5 * state.dpr, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }

      if (busy || pulsing) state.frame = requestAnimationFrame(render);
    };

    state.kick = () => {
      if (!state.frame) state.frame = requestAnimationFrame(render);
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      state.dpr = Math.min(2, window.devicePixelRatio || 1);
      state.width = Math.max(1, Math.round(rect.width * state.dpr));
      state.height = Math.max(1, Math.round(rect.height * state.dpr));
      canvas.width = state.width;
      canvas.height = state.height;
      state.streets = layer();
      const booted = state.city && state.drawnEdges >= state.city.edges.length;
      state.drawnEdges = 0;
      if (state.city) {
        project(state.city);
        if (booted) drawStreets(state.city, state.city.edges.length);
        prepareRoute();
      }
      state.waterSurface = Number.NaN;
      state.kick();
    };
    state.rebuild = resize;
    state.routeReady = () => {
      prepareRoute();
      state.kick();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const visibility = new IntersectionObserver(([entry]) => {
      state.visible = entry.isIntersecting;
      if (state.visible) state.kick();
    }, { root: document.querySelector('.content-scroll'), threshold: 0 });
    visibility.observe(figure);
    void loadTerrain().then((terrain) => {
      state.terrain = terrain;
      state.waterStart = performance.now();
      state.kick();
    });
    return () => {
      observer.disconnect();
      visibility.disconnect();
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    };
  }, []);

  useEffect(() => {
    const state = engine.current;
    if (!cityData || state.city === cityData) return;
    state.city = cityData;
    state.order = cityData.edges.map((_, index) => index);
    const nodes = new Map(cityData.nodes.map((node) => [node.id, node]));
    const distance = (index: number) => {
      const edge = cityData.edges[index];
      const a = nodes.get(edge.source);
      return a ? Math.hypot(a.lat - cityData.center_lat, (a.lon - cityData.center_lon) * 0.87) : 1;
    };
    state.order.sort((a, b) => distance(a) - distance(b));
    state.drawnEdges = 0;
    state.bootStart = 0;
    // Recompute the projection for the new bounds; streets then boot in.
    state.rebuild();
  }, [cityData]);

  useEffect(() => {
    const state = engine.current;
    if (!cityData) return;
    const target = waterSurfaceM(cityData, floodLevel);
    const current = Number.isNaN(state.waterSurface) ? target : state.waterSurface;
    state.waterFrom = current;
    state.waterTo = target;
    state.waterStart = performance.now();
    state.kick();
  }, [cityData, floodLevel]);

  useEffect(() => {
    const state = engine.current;
    state.route = route;
    state.origin = originNode;
    state.routeStart = performance.now();
    state.routeReady();
  }, [route, originNode]);

  useEffect(() => {
    engine.current.user = userLocation;
    engine.current.kick();
  }, [userLocation]);

  const flooded = route?.flooded_nodes.length ?? 0;
  const surface = waterSurfaceM(cityData, floodLevel);
  return (
    <figure className="nc" ref={figureRef}>
      <div className="nc-frame">
        <canvas ref={canvasRef} className="nc-canvas" role="img" aria-label={`Downtown Houston street network with water at ${surface.toFixed(1)} metres and the recommended corridor`} />
      </div>
      <figcaption className="nc-caption">
        {cityData
          ? `${cityData.edges.length.toLocaleString()} street segments at true scale. Water at ${surface.toFixed(1)} m NAVD88 reaches ${flooded.toLocaleString()} junctions.`
          : 'Loading the street network.'}
      </figcaption>
    </figure>
  );
}
