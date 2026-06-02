"""
anomaly.py — IsolationForest Anomaly Detection
-----------------------------------------------
Pre-trains a scikit-learn IsolationForest on synthetic *normal*
Houston power-grid / flood telemetry data, then exposes
`detect_anomaly()` for real-time scoring.

Feature vector (5 dimensions)
──────────────────────────────
  [0] flood_level       0–10   raw slider value
  [1] failed_count      0–5    number of offline substations
  [2] affected_fraction 0–1    fraction of nodes in a blackout zone
  [3] concurrent        0 | 1  flood AND failure happening together
  [4] composite_stress  0–1    weighted severity index

Normal training envelope
─────────────────────────
  • flood ≤ 2.5  (light rain / minor bayou rise)
  • failures ≤ 1  (routine maintenance outage)
  • mostly non-concurrent events
"""

import numpy as np
from sklearn.ensemble import IsolationForest
from typing import Tuple

# ── Training data generation ───────────────────────────────────────────────────
_RNG = np.random.default_rng(42)


def _generate_normal_telemetry(n: int = 800) -> np.ndarray:
    flood       = _RNG.uniform(0.0, 2.5, n)
    failures    = _RNG.integers(0, 2, n).astype(float)
    affected    = failures * _RNG.uniform(0.02, 0.12, n)
    concurrent  = ((flood > 1.5) & (failures > 0)).astype(float)
    stress      = (flood / 10.0) * 0.45 + (failures / 5.0) * 0.35 + affected * 0.20
    return np.column_stack([flood, failures, affected, concurrent, stress])


_TRAINING_DATA = _generate_normal_telemetry()
_MODEL = IsolationForest(
    n_estimators=300,
    contamination=0.04,
    random_state=42,
    n_jobs=-1,
)
_MODEL.fit(_TRAINING_DATA)

# ── Public API ─────────────────────────────────────────────────────────────────

def detect_anomaly(
    flood_level: float,
    failed_count: int,
    affected_fraction: float,
) -> Tuple[float, str]:
    """
    Score incoming telemetry against the trained normal distribution.

    Returns
    -------
    (anomaly_score, risk_level)
        anomaly_score : float  0.0 = completely normal → 1.0 = maximum anomaly
        risk_level    : str    "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
    """
    concurrent = 1.0 if (flood_level > 1.8 and failed_count > 0) else 0.0
    stress     = (
        (flood_level / 10.0) * 0.45
        + (failed_count / 5.0) * 0.35
        + affected_fraction * 0.20
    )

    features = np.array([[
        flood_level,
        float(failed_count),
        affected_fraction,
        concurrent,
        stress,
    ]])

    # IsolationForest: higher (less negative) = more normal
    # Typical range: roughly −0.7 (anomaly) to +0.2 (normal)
    raw = float(_MODEL.score_samples(features)[0])

    # Map to [0, 1] where 1 = most anomalous
    score = float(np.clip((-raw - 0.08) / 0.65, 0.0, 1.0))

    if score < 0.30:
        risk = "LOW"
    elif score < 0.55:
        risk = "MEDIUM"
    elif score < 0.75:
        risk = "HIGH"
    else:
        risk = "CRITICAL"

    return score, risk
