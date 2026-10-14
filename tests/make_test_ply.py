#!/usr/bin/env python3
"""Write a small graphdeco-style 3DGS .ply for tests: a ring of coloured
gaussians around the origin (the fake StreamBIM host serves it as a
"StreamBIM document").

    python tests/make_test_ply.py public/test-scenes/test-scene.ply
"""
import sys
from pathlib import Path

import numpy as np

out = Path(sys.argv[1] if len(sys.argv) > 1 else "public/test-scenes/test-scene.ply")
n = 4000
rng = np.random.default_rng(0)
a = rng.uniform(0, 2 * np.pi, n)
xyz = np.stack([3 * np.cos(a), rng.uniform(0, 2, n), 3 * np.sin(a)], 1)
rgb = np.stack([0.5 + 0.5 * np.cos(a), 0.5 + 0.5 * np.sin(a), np.full(n, 0.6)], 1)
fields = {
    "x": xyz[:, 0], "y": xyz[:, 1], "z": xyz[:, 2],
    "nx": np.zeros(n), "ny": np.zeros(n), "nz": np.zeros(n),
    **{f"f_dc_{i}": (rgb[:, i] - 0.5) / 0.28209479 for i in range(3)},
    "opacity": np.full(n, 4.0),                      # logit -> ~0.98
    **{f"scale_{i}": np.full(n, np.log(0.04)) for i in range(3)},
    "rot_0": np.ones(n), "rot_1": np.zeros(n), "rot_2": np.zeros(n), "rot_3": np.zeros(n),
}
data = np.stack([np.asarray(v, np.float32) for v in fields.values()], 1)
header = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n%send_header\n" % (
    n, "".join(f"property float {k}\n" for k in fields))
out.parent.mkdir(parents=True, exist_ok=True)
out.write_bytes(header.encode() + data.tobytes())
print(f"wrote {n} gaussians to {out}")
