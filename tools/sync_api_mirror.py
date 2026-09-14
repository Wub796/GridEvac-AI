"""Keep the Vercel Python API (frontend/api) identical to backend/.

Vercel deploys only the frontend directory, so the FastAPI modules and the
baked network are mirrored there. Drift between the copies previously left
production without shelters, congestion, or destination routing.

  python3 tools/sync_api_mirror.py          # copy backend -> frontend/api
  python3 tools/sync_api_mirror.py --check  # exit 1 if the mirror is stale (CI)
"""

import filecmp
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, "backend")
MIRROR = os.path.join(ROOT, "frontend", "api")
MIRRORED = ["main.py", "models.py", "routing.py", "city_graph.py", "anomaly.py", os.path.join("data", "houston_network.json")]
PUBLIC_NETWORK = os.path.join(ROOT, "frontend", "public", "data", "houston_network.json")


def pairs():
    for name in MIRRORED:
        yield os.path.join(BACKEND, name), os.path.join(MIRROR, name)
    yield os.path.join(BACKEND, "data", "houston_network.json"), PUBLIC_NETWORK


def main() -> int:
    check = "--check" in sys.argv
    stale = []
    for source, target in pairs():
        if os.path.exists(target) and filecmp.cmp(source, target, shallow=False):
            continue
        stale.append(os.path.relpath(target, ROOT))
        if not check:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copyfile(source, target)
    if check:
        if stale:
            print("Stale API mirror files (run python3 tools/sync_api_mirror.py):")
            for path in stale:
                print(f"  {path}")
            return 1
        print("API mirror is in sync with backend/.")
        return 0
    print(f"Synced {len(stale)} file(s)." if stale else "Mirror already in sync.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
