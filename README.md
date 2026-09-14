# GridEvac: Houston evacuation routing

Evacuation routing for downtown Houston on the real OpenStreetMap street network and USGS 3DEP terrain. Operators raise the water, take substations offline, and close streets; GridEvac returns the safest passable corridor, turn-by-turn directions, the water level at which each way out is cut off, and exports for the incident log and GIS.

## What it does

**Scenario modeling**
- Water surface on a real elevation scale (metres NAVD88), with a hydrologically connected flood model seeded from Buffalo, White Oak, and Little White Oak bayous. Bridge decks stay dry above flooded ground.
- One-click sync to the live USGS Buffalo Bayou gage (08074000, datum 0.00 ft NAVD88).
- Substation outages with load redistribution and cascade trips; flooded substations trip on their own.
- Operator road closures drawn directly on the map and carried in shared links.
- Evacuation demand with BPR congestion, district clearance time, and shelter capacity against demand.

**Decisions**
- Start from your own location: the device fix is snapped to the nearest mapped street, and the route begins at whichever end of that street you can legally reach fastest (one-way rules for vehicles). The access leg is shown on the map and added to the total time. "Follow my location" re-plans as you move. The location stays in the browser; only the chosen junction reaches the API, and it never appears in shared links or exports.
- Least-cost route to the safest dry exit or to a named shelter or medical facility. Vehicles obey one-way streets; ETAs are real travel time, while penalties for flooded approaches, blackout districts, and energized lines only decide the order.
- Turn-by-turn directions with left/right maneuvers computed from street geometry.
- Exit corridors ranked safest first, with capacity and hazard counts.
- Trigger points: the exact water surface at which each exit and shelter becomes unreachable, and which street floods first (a widest-path solve over flood stages).
- Street-network reachability in minutes.
- Exposure estimate: buildings and daytime occupants in the flood extent or without power.

**Hand-off**
- Shareable scenario links (origin, water level, mode, outages, demand, destination, closures).
- Situation report laid out after the ICS-201 briefing, GeoJSON package for ArcGIS/QGIS, and a CSV operator event log with UTC and Houston local timestamps.
- U.S. National Grid (USNG) coordinates under the cursor, for origins, and in exports.
- Print stylesheet for the briefing and audit.

## Architecture

```
GridEvac/
├── backend/                     FastAPI service
│   ├── main.py                  Endpoints, cached city payload, live observations relay
│   ├── routing.py               Flood model, power flow, routing, corridors, isochrones, trigger points
│   ├── city_graph.py            Loads the baked network into NetworkX
│   ├── anomaly.py               IsolationForest risk score
│   ├── models.py                Pydantic schemas
│   └── data/houston_network.json
├── frontend/                    Next.js 14 app (deployed to Vercel)
│   ├── api/                     Vercel Python function: synced mirror of backend/ (index.py re-exports main.app)
│   ├── app/                     Page shell and global styles
│   ├── components/              Map (CesiumJS), control panel, briefing and audit panels
│   ├── hooks/useSimulation.ts   Zustand store: scenario state, solver orchestration, event log
│   ├── lib/solver.ts            Offline solver: a line-for-line mirror of backend/routing.py
│   ├── lib/terrain.ts           Terrain grid used to draw the flood surface
│   ├── lib/usng.ts              WGS84 to USNG conversion
│   ├── lib/exports.ts           Situation report, GeoJSON, CSV
│   └── public/data/             Baked network and terrain grid for offline mode
├── tools/                       Data bakes and the API mirror sync
└── scripts/api_smoke_test.py    Endpoint checks (runs in-process, no server needed)
```

The frontend works without the API: it loads the same baked network from `/data/houston_network.json` and runs `lib/solver.ts`, which returns the same routes, ETAs, corridors, isochrones, and trigger points as the Python backend.

## Run locally

```bash
bash start.sh
```

- Frontend: http://localhost:3000
- Backend: http://localhost:8000 (OpenAPI docs at `/docs`)

Optional environment (`frontend/.env.local`, and in Vercel project settings):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_CARTO_API_KEY` | CARTO basemap key (appended to tile URLs; keep attribution visible) |
| `NEXT_PUBLIC_CESIUM_TOKEN` | Cesium ion token: aerial imagery, world terrain, OSM 3D buildings |
| `NEXT_PUBLIC_API_URL` | API origin when it is not served from the same host |
| `GRIDEVAC_CORS_ORIGINS` | Backend: comma-separated allowed origins (default localhost:3000) |

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Service health and data provenance |
| `GET` | `/api/city` | Junctions with flood stages, curved streets with one-way rules, footprints, waterways, utilities, flood model |
| `POST` | `/api/calculate-route` | Scenario route, turn-by-turn steps, utility state, risk |
| `GET` | `/api/compare-corridors` | Every dry perimeter exit, safest first |
| `GET` | `/api/isochrone` | Junctions reachable within N minutes |
| `GET` | `/api/trigger-points` | Water surface at which each exit and shelter is cut off |
| `GET` | `/api/flood-zones` | Flooded junctions for a scenario level |
| `GET` | `/api/observations` | Live USGS gage, discharge, and air temperature (5-minute cache) |

Example:

```json
POST /api/calculate-route
{
  "flood_level": 8.0,
  "failed_substations": [2],
  "origin_node": 425,
  "travel_mode": "vehicle",
  "evacuees": 30000,
  "destination": "grb",
  "closed_edges": [[425, 426]]
}
```

Scenario level `L` maps to a water surface of `datum + L × rise` metres NAVD88 (published in `/api/city` as `flood_model`).

## Data pipeline

Run from the repository root with `numpy` and `tifffile` installed. Downloads are cached in `tools/.cache`.

1. `backend/tools/bake_city_network.py`: streets, junctions, footprints, substations, and exits from an OpenStreetMap export.
2. `tools/bake_street_attributes.py`: one-way rules, tagged lanes and speed limits, ramp names.
3. `tools/bake_terrain.py`: USGS 3DEP elevations, connected flood stages, bridge decks, bayou centerlines, and the rendering grid.
4. `tools/bake_shelters.py`: shelters snapped to junctions vehicles can reach and leave.
5. `tools/sync_api_mirror.py`: copies the backend and data into `frontend/api` and `frontend/public/data`.

## Verification

```bash
python3 scripts/api_smoke_test.py --inprocess
python3 tools/sync_api_mirror.py --check
cd frontend && npm ci && npm run lint && npm run typecheck && npm run build
```

CI runs the same checks on every push and pull request (`.github/workflows/ci.yml`).

## Limitations

- The flood model is a single water surface spreading over connected low ground. It does not model rainfall ponding, storm-drain backup, or the channel's downstream slope, and the upstream gage stands in for the whole reach.
- Substations, loads, service areas, and transmission links are illustrative, not CenterPoint Energy data.
- Occupancy estimates assume one person per 25 m² of floor area across the 1,400 largest mapped footprints.
- Congestion assumes demand loads onto the network within one hour and spreads across every dry exit corridor.
- GridEvac is a planning aid. Confirm conditions on the ground before directing people.

Street, building, and waterway data © OpenStreetMap contributors. Elevation: USGS 3DEP. Basemap © CARTO.
