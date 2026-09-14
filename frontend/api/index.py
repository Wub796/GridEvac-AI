"""Vercel serverless entrypoint.

The FastAPI app lives in main.py, a byte-for-byte mirror of backend/main.py
maintained by tools/sync_api_mirror.py. Re-exporting it here means the
deployed API can never drift from the local backend again.
"""

from main import app  # noqa: F401
