# GridEvac AI — Task Tracker (Houston, TX)

## Backend (Standalone)
- [x] `backend/requirements.txt`
- [x] `backend/models.py`
- [x] `backend/city_graph.py` (Houston downtown grid, CenterPoint substations)
- [x] `backend/anomaly.py` (IsolationForest)
- [x] `backend/routing.py` (NetworkX Dijkstra)
- [x] `backend/main.py` (FastAPI server)

## Frontend & Serverless Setup
- [x] Scaffold Next.js app
- [x] `frontend/package.json` (Move `cesium` to devDependencies, remove postinstall asset copy script for CDN loading)
- [x] `frontend/vercel.json` (Vercel Serverless routing & Python function configuration)
- [x] `frontend/.env.local`
- [x] `frontend/.eslintrc.json`
- [x] `frontend/tsconfig.json`

## Frontend Files & Vercel Python API
- [x] `frontend/lib/types.ts`
- [x] `frontend/lib/api.ts` (Modified BASE_URL to support relative routing on Vercel)
- [x] `frontend/hooks/useSimulation.ts`
- [x] `frontend/app/globals.css`
- [x] `frontend/app/layout.tsx`
- [x] `frontend/app/page.tsx`
- [x] `frontend/components/CesiumViewer.tsx` (Modified to load Cesium from CDN, optimizing Vercel slugs)
- [x] `frontend/components/ControlPanel.tsx`
- [x] `frontend/components/ControlPanel.module.css`
- [x] `frontend/api/requirements.txt` (FastAPI and other backend packages)
- [x] `frontend/api/index.py` (Vercel Python serverless entrypoint)
- [x] `frontend/api/models.py` (Pydantic models)
- [x] `frontend/api/city_graph.py` (Houston grid layout)
- [x] `frontend/api/routing.py` (Dijkstra algorithm)
- [x] `frontend/api/anomaly.py` (IsolationForest ML telemetry)

## Finalization & Verification
- [x] `start.sh`
- [x] `README.md` (Updated with Vercel deployment guides)
- [x] Backend pip install
- [ ] Frontend npm install (User will run this)
- [x] Python module imports smoke test (Verified successfully)
- [x] Vercel integration and API path compatibility verified

## Usability Suite Expansion
- [x] Update Zustand store state and actions in `useSimulation.ts`
- [x] Update Cesium viewer visibility and camera fly-to bindings in `CesiumViewer.tsx`
- [x] Add Preset panel, GIS checkboxes, Node search, and detailed routing display in `ControlPanel.tsx`
- [x] Style the new ControlPanel elements in `ControlPanel.module.css`
