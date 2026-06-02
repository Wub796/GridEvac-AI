# GridEvac AI — Houston, TX

> Real-time emergency evacuation routing with immersive 3-D geospatial visualisation, ML anomaly detection, and flood/blackout-aware pathfinding — focused on Houston's downtown street grid and CenterPoint Energy substation infrastructure.

---

## Architecture

GridEvac AI is designed for seamless local execution and instant deployment to Vercel (using Next.js + Python serverless functions).

```
GridEvac/
├── backend/                   FastAPI Standalone Backend (Local / Docker)
│   ├── main.py                API server (routes + CORS)
│   ├── city_graph.py          Houston 10×10 grid (NetworkX)
│   ├── routing.py             Weighted Dijkstra pathfinding
│   ├── anomaly.py             IsolationForest anomaly detection
│   ├── models.py              Pydantic request / response schemas
│   └── requirements.txt
│
├── frontend/                  Next.js App & Serverless API (Vercel-native)
│   ├── api/                   Python Serverless Functions (for Vercel)
│   │   ├── index.py           FastAPI handler entrypoint
│   │   ├── city_graph.py      Houston 10×10 grid (copied for serverless)
│   │   ├── routing.py         Pathfinding logic (copied for serverless)
│   │   ├── anomaly.py         Anomaly ML logic (copied for serverless)
│   │   ├── models.py          Pydantic schemas (copied for serverless)
│   │   └── requirements.txt   Python packages for Vercel
│   ├── app/
│   │   ├── page.tsx           Main shell (HUD, legend, layout)
│   │   ├── layout.tsx         SEO metadata
│   │   └── globals.css        Dark sci-fi theme
│   ├── components/
│   │   ├── CesiumViewer.tsx   Full-screen 3-D map (CDN loaded)
│   │   ├── ControlPanel.tsx   Glass sidebar (sliders, toggles)
│   │   └── ControlPanel.module.css
│   ├── hooks/useSimulation.ts Zustand store
│   ├── lib/api.ts             Axios API client
│   ├── lib/types.ts           Shared TypeScript types
│   ├── vercel.json            Vercel Serverless Routing Config
│   └── package.json
│
└── start.sh                   One-command launcher (Local Development)
```

---

## Setup & Running

### Option A — Local Development (FastAPI + Next.js)

To run the application locally with a separate FastAPI backend server and Next.js frontend:

```bash
bash start.sh
```

This script will:
1. Create a Python virtual environment in `backend/.venv`
2. Install all Python dependencies
3. Start the FastAPI server on **http://localhost:8000**
4. Start the Next.js dev server on **http://localhost:3000**

### Option B — Vercel Deployment

GridEvac AI is pre-configured to build and run serverless on Vercel without requiring a separate backend host. Vercel automatically deploys the Next.js frontend and compiles the Python serverless API functions inside `frontend/api/`.

#### Deployment Steps:
1. Push the repository to GitHub/GitLab/Bitbucket.
2. In the Vercel dashboard, click **Add New Project**.
3. Select your repository.
4. Configure the **Root Directory** as `frontend`.
5. Under **Environment Variables**, add:
   - `NEXT_PUBLIC_CESIUM_TOKEN` = *your_cesium_ion_token*
6. Click **Deploy**. Vercel will install the JavaScript and Python dependencies, build the Next.js pages, compile the serverless functions, and deploy the application.

#### Local Vercel CLI Development:
If you have the Vercel CLI installed, you can run the entire serverless application locally:
```bash
cd frontend
vercel dev
```
This runs both the frontend and the Python serverless functions on a single port (usually `http://localhost:3000`).

---

## Features

### 3-D Map (CesiumJS)
| Layer | Description |
|---|---|
| **Terrain** | Cesium World Terrain — real Houston elevation |
| **3-D Buildings** | OpenStreetMap buildings via Cesium Ion |
| **Street grid** | 10×10 synthetic intersection network |
| **Flood plane** | Rising translucent blue volume (1.7 m/level) |
| **Blackout zones** | Dark red cylinders over failed substations |
| **Safe route** | Glowing green PolylineGlow tube |
| **Blocked streets** | Red-highlighted impassable edges |
| **Markers** | Pulsing cyan (origin) and orange (destination) |

### Control Panel
- **Flood level slider** — 0–10 scale, 1.7 m water rise per unit
- **Substation toggles** — individually fail any of the 5 CenterPoint substations
- **Node selectors** — pick origin and destination from 100 intersection nodes
- **Calculate Route** — triggers ML scan + Dijkstra pathfinding

### Backend ML / Routing
- **IsolationForest** (300 estimators) pre-trained on Houston normal telemetry
- **NetworkX Dijkstra** with layered weights:
  - Flooded edge (both ends): `999,999` (impassable)
  - Partially flooded edge: `60`
  - Blackout zone edge multiplier: `×8`
- **Anomaly score** 0–100% with `LOW / MEDIUM / HIGH / CRITICAL` classification

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/city` | Full city graph (nodes, edges, substations) |
| `GET` | `/api/flood-zones?flood_level=5` | Flooded node IDs at given level |
| `POST` | `/api/calculate-route` | Compute evacuation route + anomaly score |

---

## City Grid — Houston Downtown

- **Centre**: 29.7604°N, 95.3698°W (Discovery Green / Minute Maid corridor)
- **Grid**: 10 rows × 10 cols = 100 intersection nodes
- **Spacing**: ~89 m N–S, ~82 m E–W
- **Elevation**: 9–22 m ASL (south-east lowest — Buffalo Bayou corridor)
- **Substations**: Main Street · Midtown · Downtown Core · Heights · Montrose

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), CesiumJS 1.119 (CDN Loaded), Zustand, Axios |
| 3-D Engine | CesiumJS — World Terrain + OSM 3-D Buildings (Ion) |
| Backend | Python 3.9+, FastAPI, scikit-learn `IsolationForest`, NetworkX `shortest_path` (Dijkstra) |
| Data | Synthetic Houston grid + real Cesium Ion imagery |
