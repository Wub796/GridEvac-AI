# GridEvac AI - Houston, TX

> A street-aware emergency operations workspace for comparing flood exposure, utility interruptions, and safer evacuation corridors across a compact Houston operations district.

## What changed

GridEvac AI now treats the map as an operator tool rather than a decorative 3-D scene:

- Named Houston street corridors with road class, lane count, speed assumptions, and measured distance.
- Ground-level Dijkstra routing that follows road centerlines instead of elevated synthetic tubes.
- Route distance, ETA, grouped road instructions, closures, flood exposure, and utility hazard penalties.
- Inset procedural block footprints and low-rise / mid-rise massing that leave visible road shoulders.
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
│   ├── city_graph.py          Named street graph, blocks, substations, utility links
│   ├── routing.py             Hazard-aware, distance-weighted Dijkstra routing
│   ├── anomaly.py             IsolationForest anomaly detection
│   └── models.py              Pydantic API schemas
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

The frontend falls back to the same named-road graph and route weighting when the FastAPI service is unavailable. Set `NEXT_PUBLIC_CESIUM_TOKEN` for Cesium World Buildings; the map remains usable with OpenStreetMap imagery and procedural block footprints without a token.

## Map layers

| Layer | Purpose |
|---|---|
| OpenStreetMap imagery | Familiar Houston street context |
| Procedural block footprints | Inset massing that preserves road shoulders |
| Named road network | Arterial, collector, and local corridor hierarchy |
| Flood cells | Low-lying modeled intersections responding to water level |
| Substation zones | Utility service areas and outage state |
| Transmission links | Overhead utility relationships and hazard roads |
| Recommended route | Ground-clamped, road-centered evacuation corridor |

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
