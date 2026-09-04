"""
anomaly.py - Upgraded 9-D IsolationForest Anomaly Detection
------------------------------------------------------------
Pre-trains a scikit-learn IsolationForest on 9-dimensional
normal grid telemetry (loads, stability indexes, rates, threats,
USGS gage heights, and micro-climate temperatures).
"""

import numpy as np
from sklearn.ensemble import IsolationForest
from typing import Tuple

# ── Training data generation ───────────────────────────────────────────────────
_RNG = np.random.default_rng(42)


def _generate_normal_telemetry(n: int = 1000) -> np.ndarray:
    flood        = _RNG.uniform(0.0, 2.5, n)
    failures     = _RNG.choice([0.0, 1.0], size=n, p=[0.8, 0.2])
    overloads    = np.zeros(n)
    
    # Average load ratio fluctuates under normal levels (60-85%)
    load_ratio   = _RNG.uniform(0.60, 0.75, n) + failures * _RNG.uniform(0.05, 0.12, n)
    
    # Voltages stay highly stable under normal conditions (95-100%)
    voltage      = 100.0 - failures * _RNG.uniform(1.0, 4.0, n) - _RNG.uniform(0.0, 1.5, n)
    
    cascade_prob = np.zeros(n)
    concurrent   = np.zeros(n)
    
    # USGS water gage height in feet (normal range 3.0 to 8.0)
    usgs_gage    = _RNG.uniform(3.0, 8.0, n) + flood * 1.5
    
    # Micro-climate surface temp in Fahrenheit (normal range 78 to 92)
    surface_temp = _RNG.uniform(78.0, 92.0, n) - flood * 0.8
    
    return np.column_stack([
        flood,
        failures,
        overloads,
        load_ratio,
        voltage,
        cascade_prob,
        concurrent,
        usgs_gage,
        surface_temp
    ])


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
    overload_count: int,
    average_grid_load_ratio: float,
    voltage_stability_index: float,
    cascade_probability: float,
    usgs_gage_height: float,
    surface_temp: float,
) -> Tuple[float, str]:
    """
    Score incoming dynamic 9-D telemetry against the normal grid training envelope.
    """
    concurrent = 1.0 if (flood_level > 1.8 and (failed_count > 0 or overload_count > 0)) else 0.0

    features = np.array([[
        flood_level,
        float(failed_count),
        float(overload_count),
        average_grid_load_ratio,
        voltage_stability_index,
        cascade_probability,
        concurrent,
        usgs_gage_height,
        surface_temp,
    ]])

    raw = float(_MODEL.score_samples(features)[0])
    score = float(np.clip((-raw - 0.08) / 0.65, 0.0, 1.0))

    # Safety override for critical cascading states or major outages
    if cascade_probability > 0.4 or overload_count >= 2:
        score = max(score, 0.88)
    elif failed_count >= 3:
        score = max(score, 0.78)

    if score < 0.30:
        risk = "LOW"
    elif score < 0.55:
        risk = "MEDIUM"
    elif score < 0.78:
        risk = "HIGH"
    else:
        risk = "CRITICAL"

    return score, risk
