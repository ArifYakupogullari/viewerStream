#!/usr/bin/env python3
"""What would load-time cleaning remove from a 3DGS .ply?

    python splat_stats.py point_cloud.ply

Prints opacity / size / needle-shape percentiles and, per preset in
render_server.CLEAN_PRESETS, how many gaussians each rule would drop.
"""
import sys

import numpy as np

from render_server import CLEAN_PRESETS, cleaning_masks, read_ply_vertices

v = read_ply_vertices(sys.argv[1])
n = len(v)
opacity = 1.0 / (1.0 + np.exp(-np.asarray(v["opacity"], np.float32)))
scales = np.sort(np.exp(np.stack([np.asarray(v[f"scale_{i}"], np.float32) for i in range(3)], 1)), axis=1)
needle = scales[:, 2] / np.maximum(scales[:, 1], 1e-12)
q = [10, 50, 90, 99]
print(f"{n:,} gaussians")
print("opacity     p10/50/90/99:", np.round(np.percentile(opacity, q), 3))
print("needle ratio p10/50/90/99:", np.round(np.percentile(needle, q), 1))
print(f"opacity < 0.05: {(opacity < 0.05).mean():.1%}   needle ratio > 20: {(needle > 20).mean():.1%}")
for preset in CLEAN_PRESETS:
    masks = cleaning_masks(v, preset)
    drop = np.logical_or.reduce(list(masks.values()))
    print(f"{preset:7s} drops {drop.mean():6.1%} (" + ", ".join(f"{k} {m.mean():.1%}" for k, m in masks.items()) + ")")
