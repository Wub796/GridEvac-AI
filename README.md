# GridEvac AI - Houston, TX

> A street-aware emergency operations workspace for comparing flood exposure, utility interruptions, and safer evacuation corridors across a real downtown Houston street network.

## What changed

GridEvac AI now treats the map as an operator tool rather than a decorative 3-D scene:

- The street graph is baked from OpenStreetMap: real downtown intersections, true road curvature, actual street names, road class, lane count, speed assumptions, and measured segment lengths (see `backend/tools/bake_city_network.py` and `backend/data/houston_network.json`).
- Ground-level Dijkstra routing that follows road centerlines and street curves instead of elevated synthetic tubes.
- Route distance, ETA, grouped road instructions, closures, flood exposure, and utility hazard penalties.
- Real OpenStreetMap building and park footprints extruded in place, aligned with the surrounding streets.
- Terrain rises away from the real Buffalo Bayou channel, so modeled floodwater appears in the actual low corridor.
- One evacuation exit per compass quadrant (North / East / South / West) selected from perimeter junctions.
- Clickable dry intersections for changing the origin directly on the map.
- Scenario presets for normal operations, Buffalo Bayou flooding, feeder cascade, and heat strain.
- Layer controls for blocks, road labels, intersections, substations, utility links, and map treatments.
- A scroll-revealed workflow for briefing, live map operations, and transparent route audit.
- Live telemetry, substation load state, anomaly scoring, and an operator event stream.

## Architecture

```
GridEvac/
├── backend/                   FastAPI standalone backend
│   ├── main.py                API endpoints and live telemetry adapters
│   ├── city_graph.py          Loader for the baked OpenStreetMap street network
│   ├── routing.py             Hazard-aware, distance-weighted Dijkstra routing
│   ├── anomaly.py             IsolationForest anomaly detection
│   ├── models.py              Pydantic API schemas
│   ├── data/houston_network.json  Baked network (nodes, curves, footprints, utility)
│   └── tools/bake_city_network.py  OSM-to-network bake script
├── frontend/
│   ├── api/                   Vercel-compatible Python API mirror
│   ├── app/page.tsx           Scroll-based operations workspace
│   ├── app/globals.css        Responsive command-room visual system
│   ├── components/CesiumViewer.tsx
│   │                           Ground-referenced Cesium map and data layers
│   ├── components/ControlPanel.tsx
│   │                           Scenario, route, outage, and layer controls
│   ├── hooks/useSimulation.ts  Zustand state and offline route solver
│   └── lib/types.ts            Shared city and route contracts
└── start.sh                   Local backend + frontend launcher
```

## Run locally

```bash
bash start.sh
```

- Frontend: http://localhost:3000
- Backend: http://localhost:8000
- API docs: http://localhost:8000/docs

The frontend falls back to the same baked OpenStreetMap network (served from `/data/houston_network.json`) and identical route weighting when the FastAPI service is unavailable. Set `NEXT_PUBLIC_CESIUM_TOKEN` for Cesium World Buildings; the map remains fully usable with the CARTO basemap and baked footprints without a token.

## Map layers

| Layer | Purpose |
|---|---|
| CARTO Positron basemap | Light, low-noise real-world street context |
| OpenStreetMap building footprints | Actual footprint shapes extruded in place |
| Park polygons | Real green space from OpenStreetMap |
| Street network | Arterial, collector, and local hierarchy from OSM classification |
| Flood cells | Low-lying intersections along the real bayou channel responding to water level |
| Substation zones | Utility service areas and outage state |
| Transmission links | Overhead utility relationships and hazard roads |
| Recommended route | Ground-clamped evacuation corridor following street curves |

## Route model

The weighted solver evaluates every street edge using:

- Measured local distance and road speed assumptions.
- A large penalty for one-sided flood exposure and impassable weight for flooded-to-flooded edges.
- Blackout service-area penalties from failed or cascaded substations.
- Additional penalties for streets beneath dead or overloaded transmission links.
- A modest preference for arterials when safety conditions are comparable.

The response includes the selected exit, route coordinates, street distance, estimated minutes, grouped road instructions, flooded nodes, blackout nodes, blocked edges, utility state, and anomaly risk.

## API reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Backend health check |
| `GET` | `/api/city` | Nodes, named edges, blocks, substations, and utility links |
| `GET` | `/api/flood-zones?flood_level=5` | Flooded intersection IDs and threshold |
| `POST` | `/api/calculate-route` | Scenario-aware route, telemetry, risk, and route steps |

Example request:

```json
{
  "flood_level": 2.5,
  "failed_substations": [1],
  "origin_node": 112
}
```

## Verification

From `frontend/`:

```bash
npm ci
npm run lint
npm run build
```

The client-side route solver mirrors the backend contract so scenario exploration continues in local fallback mode. The application uses Next.js 14, React 18, Zustand, Axios, CesiumJS 1.119, FastAPI, NetworkX, and scikit-learn.
