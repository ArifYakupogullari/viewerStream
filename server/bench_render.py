#!/usr/bin/env python3
"""Time the renderer's stages on a real splat, without the web layer.

    python bench_render.py --ply point_cloud.ply [--sizes 1280x720,1920x1080]

Prints per-stage milliseconds (rasterize on GPU, copy to CPU, JPEG encode)
from the scene's default camera, for each size and option set.
"""
import argparse
import math
import time

from render_server import GL_TO_CV, GsplatBackend, encode_jpeg, look_at_view


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ply", required=True)
    ap.add_argument("--sizes", default="1280x720,1920x1080")
    ap.add_argument("--iters", type=int, default=10)
    a = ap.parse_args()

    backend = GsplatBackend(a.ply, [0, 0, 0])
    torch = backend.torch
    cam = backend.default_camera
    viewmat = GL_TO_CV @ look_at_view(cam["position"], cam["target"], cam["up"])

    variants = {"default": {}, "packed=False": {"packed": False},
                "radius_clip=1px": {"radius_clip": 1.0}, "radius_clip=3px": {"radius_clip": 3.0}}
    for size in a.sizes.split(","):
        w, h = (int(v) for v in size.split("x"))
        f = 0.5 * h / math.tan(math.radians(cam["fovY"]) / 2)
        for label, opts in variants.items():
            for _ in range(2):  # warm-up
                backend.render_tensor(viewmat, f, f, w / 2, h / 2, w, h, **opts)
            t_r = t_c = t_j = 0.0
            for _ in range(a.iters):
                torch.cuda.synchronize()
                t0 = time.perf_counter()
                img_gpu = backend.render_tensor(viewmat, f, f, w / 2, h / 2, w, h, **opts)
                torch.cuda.synchronize()
                t1 = time.perf_counter()
                img = img_gpu.cpu().numpy()
                t2 = time.perf_counter()
                encode_jpeg(img, 80)
                t3 = time.perf_counter()
                t_r += t1 - t0
                t_c += t2 - t1
                t_j += t3 - t2
            n = a.iters / 1000
            print(f"{w}x{h} {label:16s} rasterize {t_r / n:7.1f} ms | to CPU {t_c / n:5.1f} ms | "
                  f"JPEG {t_j / n:5.1f} ms | total {(t_r + t_c + t_j) / n:7.1f} ms", flush=True)
        print(f"peak GPU memory {torch.cuda.max_memory_allocated() / 1e9:.1f} GB", flush=True)


if __name__ == "__main__":
    main()
