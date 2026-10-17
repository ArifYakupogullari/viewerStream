#!/usr/bin/env python3
"""Remote Gaussian-splat renderer for the viewerStream widget.

Loads a 3DGS .ply (graphdeco/INRIA layout, as written by final_hope.sh) onto
the GPU and renders it with gsplat for whatever camera a client sends, then
streams the result back as JPEG over a WebSocket.

Access model on Vera (see README "Remote rendering on Vera"):
  * The server is reached through Open OnDemand's authenticated proxy,
    https://vera.c3se.chalmers.se/node/<host>/<port>/, so every viewer has
    logged in with Chalmers credentials.
  * It must NOT listen on 8888-8988: C3SE's unauthenticated public proxy
    (proxy.c3se.chalmers.se) forwards exactly that range.
  * Other cluster users can still reach <host>:<port> directly, so every
    socket must present the per-session secret (?s=... in the link the
    launcher prints, passed here via VIEWERSTREAM_SECRET) and come from an
    allowed Origin.

Endpoints (relative to --prefix; Vera's portal proxies /node/<host>/<port>/...
with the full path, so launch.py passes --prefix /node/<host>/<port>/):
  GET  /         standalone viewer (mouse + touch navigation)
  GET  /relay    popup that bridges a StreamBIM-embedded widget to /ws
  GET  /health   liveness + stats for the launcher (no secrets)
  WS   /ws       {"type":"auth","secret"} then {"type":"camera",...} ->
                 binary frames: uint32 LE seq + JPEG bytes

Camera messages carry the Three.js view matrix (camera.matrixWorldInverse,
column-major, camera looking down -Z with +Y up) plus vertical FOV and the
pixel size wanted; see static/protocol.js.
"""
import argparse
import asyncio
import hmac
import io
import json
import math
import os
import secrets
import signal
import struct
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
from aiohttp import WSMsgType, web

STATIC_DIR = Path(__file__).resolve().parent / "static"
OPEN_PROXY_PORTS = range(8888, 8989)
# Three.js camera space (+Y up, looking -Z) -> OpenCV/COLMAP (+Y down, +Z forward)
GL_TO_CV = np.diag([1.0, -1.0, -1.0, 1.0])


# ---------------------------------------------------------------------------
# PLY
# ---------------------------------------------------------------------------
PLY_TYPES = {
    "float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8",
    "uchar": "u1", "uint8": "u1", "char": "i1", "int8": "i1",
    "ushort": "<u2", "uint16": "<u2", "short": "<i2", "int16": "<i2",
    "uint": "<u4", "uint32": "<u4", "int": "<i4", "int32": "<i4",
}


def read_ply_vertices(path):
    """Vertex table of a binary little-endian PLY as a numpy structured array."""
    with open(path, "rb") as f:
        if f.readline().strip() != b"ply":
            raise ValueError(f"{path} is not a PLY file")
        fmt, count, props, in_vertex, seen_vertex = None, None, [], False, False
        while True:
            line = f.readline()
            if not line:
                raise ValueError("PLY header has no end_header")
            tok = line.decode("ascii", "replace").split()
            if not tok:
                continue
            if tok[0] == "end_header":
                break
            if tok[0] == "format":
                fmt = tok[1]
            elif tok[0] == "element":
                in_vertex = tok[1] == "vertex"
                if in_vertex:
                    if props:
                        raise ValueError("vertex element must come first")
                    count, seen_vertex = int(tok[2]), True
                elif not seen_vertex:
                    raise ValueError("vertex element must come first")
            elif tok[0] == "property" and in_vertex:
                if tok[1] == "list":
                    raise ValueError("list properties in the vertex element are not supported")
                props.append((tok[2], PLY_TYPES[tok[1]]))
        header_end = f.tell()
    if fmt != "binary_little_endian":
        raise ValueError(f"only binary_little_endian PLY is supported, got {fmt}")
    if count is None:
        raise ValueError("PLY has no vertex element")
    # the vertex block is the first element, starting right after end_header
    return np.fromfile(path, dtype=np.dtype(props), count=count, offset=header_end)


def look_at_view(eye, target, up):
    """Three.js-convention world->camera matrix (camera looks down -Z), row-major."""
    eye, target, up = (np.asarray(v, float) for v in (eye, target, up))
    z = eye - target
    z /= np.linalg.norm(z)
    x = np.cross(up, z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    m = np.eye(4)
    m[0, :3], m[1, :3], m[2, :3] = x, y, z
    m[:3, 3] = [-x @ eye, -y @ eye, -z @ eye]
    return m


# Load-time cleanup presets. "extent" = 95th-percentile distance from the
# scene centre, so thresholds follow the scene's (arbitrary COLMAP) units.
CLEAN_PRESETS = {
    "light": dict(min_opacity=0.02, max_needle=50, max_size=0.20, max_dist=3.0),
    "medium": dict(min_opacity=0.05, max_needle=20, max_size=0.10, max_dist=2.5),
    "strong": dict(min_opacity=0.10, max_needle=10, max_size=0.05, max_dist=2.0),
}


def cleaning_masks(v, preset):
    """Per-rule 'remove' masks for a graphdeco vertex table:
    transparent  barely visible (low opacity) - floaters, fog
    needle       long along one axis only (longest / middle axis), the spiky
                 'iron needle' artefacts; flat surface discs are kept
    oversized    huge blobs relative to the scene
    outlier      far outside the scene"""
    p = CLEAN_PRESETS[preset]
    opacity = 1.0 / (1.0 + np.exp(-np.asarray(v["opacity"], np.float32)))
    scales = np.sort(np.exp(np.stack([np.asarray(v[f"scale_{i}"], np.float32) for i in range(3)], 1)), axis=1)
    xyz = np.stack([np.asarray(v[k], np.float32) for k in "xyz"], 1)
    dist = np.linalg.norm(xyz - np.median(xyz, axis=0), axis=1)
    extent = float(np.percentile(dist, 95))
    return {
        "transparent": opacity < p["min_opacity"],
        "needle": scales[:, 2] / np.maximum(scales[:, 1], 1e-12) > p["max_needle"],
        "oversized": scales[:, 2] > p["max_size"] * extent,
        "outlier": dist > p["max_dist"] * extent,
    }


def default_camera_from_cameras_json(ply_path):
    """First training camera from graphdeco's cameras.json (model_dir/cameras.json,
    two levels above point_cloud/iteration_N/point_cloud.ply), in Three.js terms."""
    cams_path = Path(ply_path).resolve().parent.parent.parent / "cameras.json"
    if not cams_path.is_file():
        return None
    try:
        cams = json.loads(cams_path.read_text())
        cam = min(cams, key=lambda c: c.get("id", 0))
        pos = np.asarray(cam["position"], float)
        rot = np.asarray(cam["rotation"], float)  # camera-to-world; columns = OpenCV axes
        forward, up = rot[:, 2], -rot[:, 1]
        if "up" in cam:  # optional world up, for a camera that looks down at the scene
            up = np.asarray(cam["up"], float)
        fov_y = math.degrees(2 * math.atan(cam["height"] / (2 * cam["fy"])))
        return {"position": pos.tolist(), "target": (pos + forward).tolist(),
                "up": up.tolist(), "fovY": fov_y}
    except Exception as e:  # malformed file: fall back to bounds-based default
        print(f"[render] ignoring {cams_path}: {e}", flush=True)
        return None


def ifc_offset_from_transform_json(ply_path):
    """IFC offset of a splat trained in a local IFC frame: model_dir/transform.json
    {"offset": [x, y, z]} with X_ifc = X_local + offset (Kaj16: ifc_apply.py). The widget
    uses it to bring StreamBIM's camera (IFC world, y down) into the splat's frame."""
    path = Path(ply_path).resolve().parent.parent.parent / "transform.json"
    try:
        off = json.loads(path.read_text()).get("offset")
        return [float(x) for x in off] if off and len(off) == 3 else None
    except (OSError, ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------
class GsplatBackend:
    name = "gsplat"

    def __init__(self, ply_path, background, clean=None):
        import torch
        from gsplat import rasterization

        self.torch, self.rasterization = torch, rasterization
        t0 = time.time()
        v = read_ply_vertices(ply_path)
        if clean:
            masks = cleaning_masks(v, clean)
            drop = np.logical_or.reduce(list(masks.values()))
            print(f"[render] clean={clean}: dropping {drop.sum():,} of {len(v):,} gaussians ("
                  + ", ".join(f"{k} {m.sum():,}" for k, m in masks.items()) + ")", flush=True)
            v = v[~drop]
        names = v.dtype.names
        n = len(v)

        def cols(keys):
            return np.stack([np.asarray(v[k], np.float32) for k in keys], axis=1)

        means = cols(["x", "y", "z"])
        f_dc = cols(["f_dc_0", "f_dc_1", "f_dc_2"])
        rest_keys = sorted((k for k in names if k.startswith("f_rest_")), key=lambda k: int(k[7:]))
        k_coeffs = len(rest_keys) // 3 + 1
        self.sh_degree = int(round(math.sqrt(k_coeffs))) - 1
        if (self.sh_degree + 1) ** 2 != k_coeffs:
            raise ValueError(f"unexpected f_rest count {len(rest_keys)}")
        sh = np.empty((n, k_coeffs, 3), np.float32)
        sh[:, 0, :] = f_dc
        if rest_keys:
            # graphdeco stores f_rest channel-major: (N, 3, K-1) flattened
            sh[:, 1:, :] = cols(rest_keys).reshape(n, 3, k_coeffs - 1).transpose(0, 2, 1)
        opacity = 1.0 / (1.0 + np.exp(-np.asarray(v["opacity"], np.float32)))
        scales = np.exp(cols(["scale_0", "scale_1", "scale_2"]))
        quats = cols(["rot_0", "rot_1", "rot_2", "rot_3"])  # wxyz, as gsplat expects
        quats /= np.maximum(np.linalg.norm(quats, axis=1, keepdims=True), 1e-12)

        dev = torch.device("cuda")
        self.means = torch.from_numpy(means).to(dev)
        self.quats = torch.from_numpy(quats).to(dev)
        self.scales = torch.from_numpy(scales).to(dev)
        self.opacities = torch.from_numpy(opacity).to(dev)
        self.sh = torch.from_numpy(sh).to(dev)
        self.background = torch.tensor(background, dtype=torch.float32, device=dev)[None]
        # occlusion for the BIM merge uses only fairly opaque gaussians, so faint
        # floaters don't punch holes in BIM geometry
        self.solid = torch.from_numpy(opacity > 0.6).to(dev)
        self.num_gaussians = n
        lo, hi = np.percentile(means, [2, 98], axis=0)
        self.bounds = [lo.tolist(), hi.tolist()]
        self.default_camera = default_camera_from_cameras_json(ply_path) or self._bounds_camera(lo, hi)
        self.ifc_offset = ifc_offset_from_transform_json(ply_path)
        print(f"[render] loaded {n:,} gaussians (sh_degree {self.sh_degree}) from {ply_path} "
              f"in {time.time() - t0:.1f}s; GPU {torch.cuda.get_device_name(0)}", flush=True)

    @staticmethod
    def _bounds_camera(lo, hi):
        center = (lo + hi) / 2
        extent = float(np.max(hi - lo))
        pos = center + np.array([0.0, 0.0, extent])
        return {"position": pos.tolist(), "target": center.tolist(), "up": [0, 1, 0], "fovY": 60.0}

    def render_tensor(self, viewmat_cv, fx, fy, cx, cy, width, height, **raster_opts):
        """HxWx3 uint8 image, still on the GPU. raster_opts override gsplat's
        rasterization() defaults (bench_render.py uses this to compare)."""
        torch = self.torch
        with torch.no_grad():
            dev = self.means.device
            viewmats = torch.tensor(viewmat_cv, dtype=torch.float32, device=dev)[None]
            ks = torch.tensor([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=torch.float32, device=dev)[None]
            opts = dict(sh_degree=self.sh_degree, near_plane=0.01, far_plane=1e6, backgrounds=self.background)
            opts.update(raster_opts)
            colors, _alphas, _meta = self.rasterization(
                self.means, self.quats, self.scales, self.opacities, self.sh,
                viewmats, ks, width, height, **opts,
            )
            return (colors[0, ..., :3].clamp(0, 1) * 255).to(torch.uint8)

    def render(self, viewmat_cv, fx, fy, cx, cy, width, height):
        return self.render_tensor(viewmat_cv, fx, fy, cx, cy, width, height).cpu().numpy()

    def render_rgbd(self, viewmat_cv, fx, fy, cx, cy, width, height, as_numpy=True):
        """Colour (0..1) and camera z-depth (numpy, or GPU tensors with
        as_numpy=False); depth is inf where the splat is mostly transparent
        (nothing there to occlude BIM)."""
        torch = self.torch
        with torch.no_grad():
            dev = self.means.device
            viewmats = torch.tensor(viewmat_cv, dtype=torch.float32, device=dev)[None]
            ks = torch.tensor([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=torch.float32, device=dev)[None]
            common = dict(sh_degree=self.sh_degree, near_plane=0.01, far_plane=1e6)
            colors, _, _ = self.rasterization(
                self.means, self.quats, self.scales, self.opacities, self.sh,
                viewmats, ks, width, height, backgrounds=self.background, **common,
            )
            m = self.solid
            out, alphas, _ = self.rasterization(
                self.means[m], self.quats[m], self.scales[m], self.opacities[m], self.sh[m],
                viewmats, ks, width, height, render_mode="RGB+ED", **common,
            )
            rgb = colors[0, ..., :3].clamp(0, 1)
            depth = torch.where(alphas[0, ..., 0] > 0.5, out[0, ..., 3], torch.full_like(out[0, ..., 3], float("inf")))
            return (rgb.cpu().numpy(), depth.cpu().numpy()) if as_numpy else (rgb, depth)


class FakeBackend:
    """GPU-free stand-in: a checkered ground plane (y = 0) under a sky gradient,
    ray-cast for the requested camera, so motion and axis conventions can be
    checked without CUDA. Red line = +X axis, blue line = +Z axis."""
    name = "fake"

    def __init__(self, background, tint=0):
        self.tint = tint
        self.num_gaussians = 0
        self.sh_degree = 0
        self.bounds = [[-10, 0, -10], [10, 3, 10]]
        self.default_camera = {"position": [0, 1.6, 6], "target": [0, 1, 0], "up": [0, 1, 0], "fovY": 60.0}
        self.background = np.asarray(background, np.float32)

    def render(self, viewmat_cv, fx, fy, cx, cy, width, height):
        rgb, _depth = self.render_rgbd(viewmat_cv, fx, fy, cx, cy, width, height)
        return (rgb * 255).astype(np.uint8)

    def render_rgbd(self, viewmat_cv, fx, fy, cx, cy, width, height):
        r, t = viewmat_cv[:3, :3], viewmat_cv[:3, 3]
        origin = -r.T @ t
        jj, ii = np.mgrid[0:height, 0:width].astype(np.float32)
        d_cam = np.stack([(ii + 0.5 - cx) / fx, (jj + 0.5 - cy) / fy, np.ones_like(ii)], axis=-1)
        d = d_cam @ r.astype(np.float32)  # world = R^T cam, as row vectors
        ray_len = np.linalg.norm(d, axis=-1)
        d /= ray_len[..., None]
        sky = np.clip(d[..., 1:2], 0, 1)
        img = (1 - sky) * np.array([0.75, 0.82, 0.92], np.float32) + sky * np.array([0.25, 0.45, 0.8], np.float32)
        with np.errstate(divide="ignore", invalid="ignore"):
            hit_t = -origin[1] / d[..., 1]
        hit = (d[..., 1] < 0) & (hit_t > 0) if origin[1] > 0 else (d[..., 1] > 0) & (hit_t > 0)
        px = origin[0] + hit_t * d[..., 0]
        pz = origin[2] + hit_t * d[..., 2]
        checker = (np.floor(px) + np.floor(pz)) % 2
        light = np.array([[0.85, 0.85, 0.85], [0.95, 0.80, 0.55], [0.60, 0.85, 0.65], [0.75, 0.70, 0.95]][self.tint % 4], np.float32)
        ground = np.where(checker[..., None] > 0, light, 0.35 * light)
        ground = np.where((np.abs(pz) < 0.04)[..., None], np.array([0.9, 0.1, 0.1], np.float32), ground)
        ground = np.where((np.abs(px) < 0.04)[..., None], np.array([0.1, 0.2, 0.9], np.float32), ground)
        fade = np.exp(-np.nan_to_num(hit_t, posinf=1e3) / 60.0)[..., None]
        ground = ground * fade + img * (1 - fade)
        img = np.where(hit[..., None], ground, img)
        depth = np.where(hit, hit_t / ray_len, np.inf).astype(np.float32)  # distance -> camera z
        return np.clip(img, 0, 1), depth


class BimDemo:
    """Proof of concept for the merged BIM + splat view. A few BIM-like boxes
    (a column, a wall segment, a duct) are placed relative to the scene's
    default camera, using the splat's own depth so one stands clear of the
    surface ahead and another sinks into it. They are ray-cast exactly and
    depth-merged with the splat on the server, so the stream carries one
    combined image (no lag between layers). Real IFC geometry + a splat->BIM
    alignment would replace the boxes."""

    MODES = ("splat", "merged", "xray")  # starts on the plain scan; M cycles

    def __init__(self, backend):
        cam = backend.default_camera
        eye = np.asarray(cam["position"], float)
        f = np.asarray(cam["target"], float) - eye
        f /= np.linalg.norm(f)
        r = np.cross(f, np.asarray(cam["up"], float))
        r /= np.linalg.norm(r)
        u = np.cross(r, f)
        w, h = 160, 90
        fy = 0.5 * h / math.tan(math.radians(cam["fovY"]) / 2)
        _, depth = backend.render_rgbd(GL_TO_CV @ look_at_view(eye, eye + f, u), fy, fy, w / 2, h / 2, w, h)
        ahead = depth[h // 3: 2 * h // 3, w // 3: 2 * w // 3]
        ahead = ahead[np.isfinite(ahead)]
        # 80th percentile: the deeper surfaces ahead, not a floater near the lens
        d = float(np.percentile(ahead, 80)) if ahead.size else 3.0
        self.d = d
        axes = np.stack([r, u, f]).astype(np.float32)
        self.boxes = [  # (centre, axes as rows, half sizes along them, colour)
            (eye + f * 0.50 * d - r * 0.30 * d, axes, np.array([0.04, 0.6, 0.04]) * d, (0.95, 0.55, 0.10)),
            (eye + f * 1.00 * d + r * 0.12 * d, axes, np.array([0.18, 0.22, 0.15]) * d, (0.20, 0.50, 0.95)),
            (eye + f * 0.70 * d + u * 0.40 * d, axes, np.array([0.90, 0.03, 0.03]) * d, (0.25, 0.80, 0.40)),
        ]
        print(f"[render] BIM demo: 3 boxes placed around the surface {d:.2f} units ahead of the default camera",
              flush=True)

    def render(self, viewmat_cv, fx, fy, cx, cy, width, height):
        rot, t = viewmat_cv[:3, :3], viewmat_cv[:3, 3]
        o = -rot.T @ t
        jj, ii = np.mgrid[0:height, 0:width].astype(np.float32)
        # camera-z component 1, so the ray parameter equals the splat's z-depth
        d = np.stack([(ii + 0.5 - cx) / fx, (jj + 0.5 - cy) / fy, np.ones_like(ii)], axis=-1) @ rot.astype(np.float32)
        dn = d / np.linalg.norm(d, axis=-1, keepdims=True)
        depth = np.full((height, width), np.inf, np.float32)
        color = np.zeros((height, width, 3), np.float32)
        edge_eps = 0.012 * self.d
        for centre, axes, half, col in self.boxes:
            ol = (o - centre) @ axes.T
            dl = d @ axes.T
            with np.errstate(divide="ignore", invalid="ignore"):
                t1 = (-half - ol) / dl
                t2 = (half - ol) / dl
            tmin, tmax = np.minimum(t1, t2), np.maximum(t1, t2)
            tnear, tfar = tmin.max(-1), tmax.min(-1)
            hit = (tnear <= tfar) & (tnear > 0) & (tnear < depth)
            normal = axes[tmin.argmax(-1)]
            shade = 0.35 + 0.65 * np.abs((normal * dn).sum(-1))
            p = ol + np.nan_to_num(tnear)[..., None] * dl
            edge = (np.abs(np.abs(p) - half) < edge_eps).sum(-1) >= 2
            shade = np.where(edge, 0.15, shade)
            depth = np.where(hit, tnear, depth)
            color = np.where(hit[..., None], np.asarray(col, np.float32) * shade[..., None], color)
        return color, depth

    def render_torch(self, torch, dev, viewmat_cv, fx, fy, cx, cy, width, height):
        """Same ray cast as render(), as tensors on `dev` (the GPU path)."""
        f32 = dict(dtype=torch.float32, device=dev)
        rot = torch.tensor(viewmat_cv[:3, :3], **f32)
        o = -rot.T @ torch.tensor(viewmat_cv[:3, 3], **f32)
        jj, ii = torch.meshgrid(torch.arange(height, **f32), torch.arange(width, **f32), indexing="ij")
        d = torch.stack([(ii + 0.5 - cx) / fx, (jj + 0.5 - cy) / fy, torch.ones_like(ii)], dim=-1) @ rot
        dn = d / d.norm(dim=-1, keepdim=True)
        depth = torch.full((height, width), float("inf"), **f32)
        color = torch.zeros((height, width, 3), **f32)
        edge_eps = 0.012 * self.d
        for centre, axes, half, col in self.boxes:
            centre, axes, half, col = (torch.tensor(np.asarray(v), **f32) for v in (centre, axes, half, col))
            ol = (o - centre) @ axes.T
            dl = d @ axes.T
            t1 = (-half - ol) / dl
            t2 = (half - ol) / dl
            tmin, tmax = torch.minimum(t1, t2), torch.maximum(t1, t2)
            tnear, tfar = tmin.max(dim=-1).values, tmax.min(dim=-1).values
            hit = (tnear <= tfar) & (tnear > 0) & (tnear < depth)
            normal = axes[tmin.argmax(dim=-1)]
            shade = 0.35 + 0.65 * (normal * dn).sum(-1).abs()
            p = ol + torch.nan_to_num(tnear)[..., None] * dl
            edge = ((p.abs() - half).abs() < edge_eps).sum(-1) >= 2
            shade = torch.where(edge, torch.full_like(shade, 0.15), shade)
            depth = torch.where(hit, tnear, depth)
            color = torch.where(hit[..., None], col * shade[..., None], color)
        return color, depth


class BimSplat:
    """Real BIM layer: IFC elements sampled into flat, opaque surfels (a gaussian
    PLY in the same frame as the scan, made by Kaj16's bim_surfels.py), rendered
    with gsplat for colour + depth and depth-merged with the scan like BimDemo.
    The frame is metric, so BIM within `tol` of the scanned surface counts as
    coincident (built as designed) and is tinted rather than z-fighting."""

    MODES = ("splat", "merged", "xray", "bim")
    tol = 0.12  # metres

    def __init__(self, ply_path):
        self.layer = GsplatBackend(ply_path, background=(0.0, 0.0, 0.0))

    def render_torch(self, torch, dev, viewmat_cv, fx, fy, cx, cy, width, height):
        L = self.layer
        with torch.no_grad():
            viewmats = torch.tensor(viewmat_cv, dtype=torch.float32, device=dev)[None]
            ks = torch.tensor([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=torch.float32, device=dev)[None]
            out, alphas, _ = L.rasterization(
                L.means, L.quats, L.scales, L.opacities, L.sh, viewmats, ks, width, height,
                sh_degree=L.sh_degree, near_plane=0.01, far_plane=1e6, render_mode="RGB+ED")
            a = alphas[0, ..., 0]
            rgb = (out[0, ..., :3] / a.clamp(min=1e-4)[..., None]).clamp(0, 1)  # un-premultiply
            depth = torch.where(a > 0.5, out[0, ..., 3], torch.full_like(a, float("inf")))
            return rgb, depth


def raster_triangles(torch, tris_cam, width, height, fx, fy, cx, cy, near=0.05, chunk=25_000_000):
    """Exact z-buffer of camera-space triangles (OpenCV axes: x right, y down, z forward) for
    a pinhole camera - the same camera model gsplat uses for the scan, so the two images share
    one pixel grid. Pure torch (no extra packages): every triangle's bounding-box pixels are
    tested with barycentrics, perspective-correct depth, and the nearest (depth, triangle) per
    pixel is kept with one int64 scatter-min. Returns view-space z (inf = empty) and triangle
    index (-1) per pixel."""
    dev = tris_cam.device
    W, H = width, height
    z = tris_cam[..., 2]
    ok = (z > near).all(1)
    idx_all = torch.nonzero(ok).squeeze(1)
    t = tris_cam[ok]
    u = fx * t[..., 0] / t[..., 2] + cx
    v = fy * t[..., 1] / t[..., 2] + cy
    x0 = torch.ceil(u.min(1).values - 0.5).clamp(0, W - 1).long()
    x1 = torch.floor(u.max(1).values - 0.5).clamp(0, W - 1).long()
    y0 = torch.ceil(v.min(1).values - 0.5).clamp(0, H - 1).long()
    y1 = torch.floor(v.max(1).values - 0.5).clamp(0, H - 1).long()
    a2 = (u[:, 1] - u[:, 0]) * (v[:, 2] - v[:, 0]) - (u[:, 2] - u[:, 0]) * (v[:, 1] - v[:, 0])
    vis = ((u.max(1).values >= 0) & (u.min(1).values < W) & (v.max(1).values >= 0) & (v.min(1).values < H)
           & (x1 >= x0) & (y1 >= y0) & (a2.abs() > 1e-9))
    sel = torch.nonzero(vis).squeeze(1)
    u, v, t, x0, x1, y0, y1, a2, idx_all = u[sel], v[sel], t[sel], x0[sel], x1[sel], y0[sel], y1[sel], a2[sel], idx_all[sel]
    w = x1 - x0 + 1
    area = w * (y1 - y0 + 1)
    empty = torch.iinfo(torch.int64).max
    key = torch.full((W * H,), empty, dtype=torch.int64, device=dev)
    csum = torch.cumsum(area, 0)
    start, n_tri = 0, len(area)
    while start < n_tri:
        base = int(csum[start - 1]) if start else 0
        end = max(int(torch.searchsorted(csum, torch.tensor(base + chunk, device=dev), right=True)), start + 1)
        ar = area[start:end]
        n = int(ar.sum())
        ti = torch.repeat_interleave(torch.arange(end - start, device=dev), ar)
        loc = torch.arange(n, device=dev) - (torch.cumsum(ar, 0) - ar)[ti]
        ww = w[start:end][ti]
        px = x0[start:end][ti] + loc % ww
        py = y0[start:end][ti] + torch.div(loc, ww, rounding_mode="floor")
        pcx, pcy = px.float() + 0.5, py.float() + 0.5
        U, V, Z, A = u[start:end][ti], v[start:end][ti], t[start:end][ti][..., 2], a2[start:end][ti]
        b0 = ((U[:, 1] - pcx) * (V[:, 2] - pcy) - (U[:, 2] - pcx) * (V[:, 1] - pcy)) / A
        b1 = ((U[:, 2] - pcx) * (V[:, 0] - pcy) - (U[:, 0] - pcx) * (V[:, 2] - pcy)) / A
        b2 = 1 - b0 - b1
        zp = 1.0 / (b0 / Z[:, 0] + b1 / Z[:, 1] + b2 / Z[:, 2])
        m = (b0 >= -1e-6) & (b1 >= -1e-6) & (b2 >= -1e-6) & (zp > near)
        k = ((zp[m] * 1e4).long().clamp(max=(1 << 31) - 1) << 31) | idx_all[start:end][ti][m]
        key.scatter_reduce_(0, (py * W + px)[m], k, reduce="amin")
        start = end
    filled = key != empty
    depth = torch.full((W * H,), float("inf"), device=dev)
    tri = torch.full((W * H,), -1, dtype=torch.int64, device=dev)
    depth[filled] = (key[filled] >> 31).float() / 1e4
    tri[filled] = key[filled] & ((1 << 31) - 1)
    return depth.view(H, W), tri.view(H, W)


class BimMesh:
    """Real BIM layer as triangles (Kaj16 bim_surfels.py --mesh-out .npz, in the scenes'
    frame), rasterised with the scan's exact camera: the merge with the splat is a per-pixel
    depth comparison in screen space, with crisp edges and solid thin pipes (no surfels).
    Same interface as BimSplat, plus per pixel: `last_weight` (an element group's blend
    weight, e.g. concrete lighter so the scanned ceiling stays readable) and `last_elem`
    (element index; npz `guids` / `keys` name it). `zclip` cuts the storey per pixel."""

    MODES = ("splat", "merged", "xray", "bim")
    tol = 0.12  # metres
    LIGHT = np.array([0.35, 0.25, 0.9]) / np.linalg.norm([0.35, 0.25, 0.9])  # as the surfels

    STATUS_COLORS = {"built": (0.20, 0.80, 0.30), "not built": (0.92, 0.20, 0.20), "cannot tell": (1.00, 0.70, 0.00),
                     "no view": (0.55, 0.55, 0.62)}

    def __init__(self, npz_path, zclip=None, weights=None, status=None):
        import torch
        d = np.load(npz_path)
        tris = d["tris"].astype(np.float32)
        n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        shade = 0.55 + 0.45 * np.abs(n @ self.LIGHT)
        dev = torch.device("cuda") if torch.cuda.is_available() else torch.device("cpu")
        self.keys, self.guids = d["keys"], d["guids"]
        weights = weights or {}
        ew = np.array([next((v for k, v in weights.items() if k in str(key)), 1.0) for key in self.keys], np.float32)
        elem = d["elem"].astype(np.int64)
        self.tris = torch.from_numpy(tris).to(dev)
        self.rgb = torch.from_numpy((d["color"] / 255.0 * shade[:, None]).astype(np.float32)).to(dev)
        self.elem = torch.from_numpy(elem).to(dev)
        self.weight = torch.from_numpy(ew[elem]).to(dev)
        self.zclip = zclip
        self.last_weight = self.last_elem = None
        self.rgb_status = self.weight_status = None
        if status:  # verification result per element (GUID): built / not built / cannot tell / no view
            st = [(status.get(str(g)) or {}).get("status", "no view") for g in self.guids]
            pal = self.STATUS_COLORS
            ec = np.array([pal.get(x, pal["no view"]) for x in st], np.float32)
            ws = np.array([0.15 if x == "no view" else 1.0 for x in st], np.float32)
            self.rgb_status = torch.from_numpy((ec[elem] * shade[:, None]).astype(np.float32)).to(dev)
            self.weight_status = torch.from_numpy(ws[elem]).to(dev)
            from collections import Counter
            print(f"[render] BIM status colours: {dict(Counter(st))}", flush=True)
        print(f"[render] BIM mesh: {len(tris):,} triangles of {len(self.keys)} elements from {npz_path}", flush=True)

    def render_torch(self, torch, dev, viewmat_cv, fx, fy, cx, cy, width, height, colors="model"):
        use_status = colors == "status" and self.rgb_status is not None
        with torch.no_grad():
            Vm = torch.as_tensor(np.asarray(viewmat_cv), dtype=torch.float32, device=self.tris.device)
            tc = self.tris @ Vm[:3, :3].T + Vm[:3, 3]
            depth, tri = raster_triangles(torch, tc, width, height, fx, fy, cx, cy)
            has = tri >= 0
            if self.zclip is not None and has.any():
                # cut the storey exactly: world z of every BIM pixel
                ys, xs = torch.nonzero(has, as_tuple=True)
                zc = depth[ys, xs]
                pc = torch.stack([(xs.float() + 0.5 - cx) / fx * zc, (ys.float() + 0.5 - cy) / fy * zc, zc], 1)
                wz = ((pc - Vm[:3, 3]) @ Vm[:3, :3])[:, 2]
                out = (wz < self.zclip[0] - 0.02) | (wz > self.zclip[1] + 0.02)
                depth[ys[out], xs[out]] = float("inf")
                tri[ys[out], xs[out]] = -1
                has = tri >= 0
            rgb = torch.zeros(height, width, 3, device=self.tris.device)
            rgb[has] = (self.rgb_status if use_status else self.rgb)[tri[has]]
            self.last_weight = torch.ones(height, width, device=self.tris.device)
            self.last_weight[has] = (self.weight_status if use_status else self.weight)[tri[has]]
            self.last_elem = torch.full((height, width), -1, dtype=torch.int64, device=self.tris.device)
            self.last_elem[has] = self.elem[tri[has]]
            return rgb.to(dev), depth.to(dev)

    def pick(self, torch, viewmat_cv, fx, fy, cx, cy, width, height, x, y, r=6):
        """element index under pixel (x, y), or the nearest within r pixels (thin pipes); -1 if none."""
        self.render_torch(torch, self.tris.device, viewmat_cv, fx, fy, cx, cy, width, height)
        el = self.last_elem
        x, y = int(round(x)), int(round(y))
        y0, y1, x0, x1 = max(0, y - r), min(height, y + r + 1), max(0, x - r), min(width, x + r + 1)
        win = el[y0:y1, x0:x1]
        hit = win >= 0
        if not bool(hit.any()):
            return -1
        ys, xs = torch.nonzero(hit, as_tuple=True)
        k = int(torch.argmin((ys + y0 - y) ** 2 + (xs + x0 - x) ** 2))
        return int(win[ys[k], xs[k]])


# ---------------------------------------------------------------------------
# JPEG
# ---------------------------------------------------------------------------
try:
    import simplejpeg

    def encode_jpeg(img, quality):
        return simplejpeg.encode_jpeg(np.ascontiguousarray(img), quality=quality, colorspace="RGB", fastdct=True)
except ImportError:  # pragma: no cover - fallback path
    from PIL import Image

    def encode_jpeg(img, quality):
        buf = io.BytesIO()
        Image.fromarray(img).save(buf, "JPEG", quality=quality)
        return buf.getvalue()


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
def scene_name(ply_path):
    """'gs-room it 50000' from .../gs-room/point_cloud/iteration_50000/point_cloud.ply"""
    p = Path(ply_path)
    if p.parent.name.startswith("iteration_") and len(p.parents) >= 3:
        return f"{p.parents[2].name} it {p.parent.name[len('iteration_'):]}"
    return p.stem


class RenderService:
    def __init__(self, scenes, args):
        """scenes: list of (name, backend); scene 0 is the default."""
        self.status = {}
        if getattr(args, "bim_status", None):
            self.status = json.loads(Path(args.bim_status).read_text())
            print(f"[render] verification status for {len(self.status)} elements from {args.bim_status}", flush=True)
        if getattr(args, "bim_mesh", None):
            layer = BimMesh(args.bim_mesh, zclip=args.bim_zclip, weights={"concrete": 0.45}, status=self.status or None)
        else:
            layer = BimSplat(args.bim_ply) if getattr(args, "bim_ply", None) else None
        self.scenes = [{"name": name, "backend": b, "bim": layer or (BimDemo(b) if args.bim_demo else None)}
                       for name, b in scenes]
        self.backend = self.scenes[0]["backend"]
        self.args = args
        self.secret = args.secret
        # one GPU, one render at a time; the event loop stays responsive
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.clients = 0
        self.last_activity = time.time()
        self.frames = 0
        self.fps = 0.0
        self.render_ms = 0.0
        self._fps_window = []
        self._render_times = deque(maxlen=30)
        self.modes = (BimSplat.MODES if layer else BimDemo.MODES if args.bim_demo else ("splat",))
        if self.status and isinstance(layer, BimMesh):
            self.modes = ("status",) + tuple(self.modes)   # verification colours first

    def warm_up(self):
        """The first gsplat call loads the CUDA kernels (~1 s). Pay that before
        anyone connects, then reset the stats so they reflect real frames."""
        t0 = time.perf_counter()
        for i, scene in enumerate(self.scenes):
            cam = scene["backend"].default_camera
            view = look_at_view(cam["position"], cam["target"], cam["up"]).T.flatten().tolist()
            for _ in range(2):
                self.render_jpeg(self.parse_camera(
                    {"view": view, "fovY": cam["fovY"], "width": 640, "height": 360, "scene": i}))
        print(f"[render] warm-up done in {time.perf_counter() - t0:.1f}s", flush=True)
        self.frames, self.fps, self.render_ms = 0, 0.0, 0.0
        self._fps_window, self._render_times = [], deque(maxlen=30)

    def info(self):
        return {"type": "info", "backend": self.backend.name, "numGaussians": self.backend.num_gaussians,
                "shDegree": self.backend.sh_degree, "bounds": self.backend.bounds,
                "defaultCamera": self.backend.default_camera, "maxSide": self.args.max_side,
                "ifcOffset": getattr(self.backend, "ifc_offset", None),
                "modes": list(self.modes),
                "scenes": [{"name": sc["name"], "numGaussians": sc["backend"].num_gaussians,
                            "shDegree": sc["backend"].sh_degree, "bounds": sc["backend"].bounds,
                            "defaultCamera": sc["backend"].default_camera,
                            "ifcOffset": getattr(sc["backend"], "ifc_offset", None)} for sc in self.scenes]}

    def parse_camera(self, msg):
        view = msg.get("view")
        if not (isinstance(view, list) and len(view) == 16):
            raise ValueError("view must be 16 numbers")
        m = np.asarray(view, np.float64).reshape(4, 4).T  # column-major -> row-major
        fov_y = float(msg.get("fovY", 60))
        width, height = int(msg.get("width", 0)), int(msg.get("height", 0))
        if not (np.all(np.isfinite(m)) and 1 <= fov_y <= 170 and width >= 16 and height >= 16):
            raise ValueError("bad camera")
        scale = min(1.0, self.args.max_side / max(width, height))
        width, height = max(16, int(width * scale)), max(16, int(height * scale))
        quality = int(min(95, max(30, msg.get("quality", self.args.quality))))
        fy = 0.5 * height / math.tan(math.radians(fov_y) / 2)
        mode = msg.get("mode") or self.modes[0]
        if mode not in self.modes:
            raise ValueError(f"mode must be one of {self.modes}")
        scene = int(msg.get("scene") or 0)
        if not 0 <= scene < len(self.scenes):
            raise ValueError(f"scene must be 0..{len(self.scenes) - 1}")
        return GL_TO_CV @ m, fy, fy, width / 2, height / 2, width, height, quality, mode, scene

    def render_jpeg(self, cam):
        viewmat, fx, fy, cx, cy, w, h, quality, mode, scene = cam
        backend, bim = self.scenes[scene]["backend"], self.scenes[scene]["bim"]
        t0 = time.perf_counter()
        if bim is not None and mode != "splat" and backend.name == "gsplat":
            torch = backend.torch
            rgb, depth = backend.render_rgbd(viewmat, fx, fy, cx, cy, w, h, as_numpy=False)
            bim_rgb, bim_depth = bim.render_torch(torch, rgb.device, viewmat, fx, fy, cx, cy, w, h,
                                                  colors="status" if mode == "status" else "model")
            tol = getattr(bim, "tol", 0.0)
            front = bim_depth < depth - tol  # BIM surface nearer than the scan: it wins
            alpha = front.float() * 0.92
            if tol > 0:  # on the scanned surface (built as designed): tint
                same = torch.isfinite(bim_depth) & ((bim_depth - depth).abs() <= tol)
                alpha = torch.where(same, torch.full_like(alpha, 0.5), alpha)
            if mode in ("xray", "status"):  # also ghost the BIM parts the scan hides
                hidden = torch.isfinite(bim_depth) & (bim_depth > depth + tol)
                alpha = torch.where(hidden, torch.full_like(alpha, 0.35), alpha)
            if mode == "bim":  # the BIM layer alone, over a dark background
                alpha = torch.isfinite(bim_depth).float()
                rgb = torch.full_like(rgb, 0.08)
            elif getattr(bim, "last_weight", None) is not None:  # per element group (BimMesh)
                alpha = alpha * bim.last_weight.to(alpha.device)
            out = rgb * (1 - alpha[..., None]) + bim_rgb * alpha[..., None]
            img = (out.clamp(0, 1) * 255).to(torch.uint8).cpu().numpy()
        elif bim is not None and mode != "splat":
            rgb, depth = backend.render_rgbd(viewmat, fx, fy, cx, cy, w, h)
            bim_rgb, bim_depth = bim.render(viewmat, fx, fy, cx, cy, w, h)
            front = bim_depth < depth  # BIM surface nearer than the scan: it wins
            alpha = np.where(front, 0.92, 0.0)
            if mode == "xray":  # also ghost the BIM parts the scan hides
                alpha = np.where(np.isfinite(bim_depth) & ~front, 0.35, alpha)
            img = ((rgb * (1 - alpha[..., None]) + bim_rgb * alpha[..., None]) * 255).astype(np.uint8)
        else:
            img = backend.render(viewmat, fx, fy, cx, cy, w, h)
        jpeg = encode_jpeg(img, quality)
        dt = time.perf_counter() - t0
        now = time.time()
        self.frames += 1
        self._render_times.append(dt * 1000)
        self.render_ms = sum(self._render_times) / len(self._render_times)
        self._fps_window = [t for t in self._fps_window if now - t < 2.0] + [now]
        self.fps = len(self._fps_window) / 2.0
        return jpeg

    def pick(self, cam, x, y):
        """the BIM element under normalised canvas position (x, y) and its verification record"""
        viewmat, fx, fy, cx, cy, w, h, _q, _mode, scene = cam
        bim, backend = self.scenes[scene]["bim"], self.scenes[scene]["backend"]
        if not isinstance(bim, BimMesh) or backend.name != "gsplat":
            return {"type": "pick", "found": False, "message": "no BIM mesh layer"}
        e = bim.pick(backend.torch, viewmat, fx, fy, cx, cy, w, h, x * w, y * h)
        if e < 0:
            return {"type": "pick", "found": False}
        g = str(bim.guids[e])
        rec = dict(self.status.get(g) or {"status": "no view"})
        rec["evidence"] = ["evidence/" + Path(v).name for v in rec.get("views", [])]
        return {"type": "pick", "found": True, "elem": e, "guid": g, "key": str(bim.keys[e]), **rec}

    def origin_ok(self, origin):
        if origin in self.args.allowed_origin:
            return True
        return self.args.dev and urlparse(origin).hostname in ("localhost", "127.0.0.1")

    async def ws_handler(self, request):
        origin = request.headers.get("Origin", "")
        if not self.origin_ok(origin):
            print(f"[render] rejected WS from origin {origin!r}", flush=True)
            raise web.HTTPForbidden(text="origin not allowed")
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=64 * 1024)
        await ws.prepare(request)
        try:
            first = await asyncio.wait_for(ws.receive(), timeout=10)
            auth = json.loads(first.data) if first.type == WSMsgType.TEXT else {}
            given = str(auth.get("secret", "")) if auth.get("type") == "auth" else ""
            if not hmac.compare_digest(given.encode(), self.secret.encode()):
                await ws.send_json({"type": "error", "message": "bad or missing session secret"})
                await ws.close(code=4401, message=b"unauthorized")
                return ws
        except (asyncio.TimeoutError, ValueError):
            await ws.close(code=4401, message=b"unauthorized")
            return ws

        self.clients += 1
        self.last_activity = time.time()
        print(f"[render] client connected ({self.clients} total) from {origin}", flush=True)
        await ws.send_json(self.info())
        latest = {"cam": None}
        wake = asyncio.Event()

        async def reader():
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                    if data.get("type") == "camera":
                        latest["cam"] = (int(data.get("seq", 0)) & 0xFFFFFFFF, self.parse_camera(data))
                        wake.set()
                    elif data.get("type") == "pick":
                        res = await asyncio.get_running_loop().run_in_executor(
                            self.pool, self.pick, self.parse_camera(data), float(data.get("x", 0)), float(data.get("y", 0)))
                        await ws.send_json(res)
                except (ValueError, TypeError, KeyError) as e:
                    await ws.send_json({"type": "error", "message": str(e)})
            wake.set()

        reader_task = asyncio.create_task(reader())
        loop = asyncio.get_running_loop()
        try:
            while not ws.closed:
                await wake.wait()
                wake.clear()
                item, latest["cam"] = latest["cam"], None  # newest camera wins
                if item is None:
                    continue
                seq, cam = item
                jpeg = await loop.run_in_executor(self.pool, self.render_jpeg, cam)
                self.last_activity = time.time()
                if not ws.closed:
                    await ws.send_bytes(struct.pack("<I", seq) + jpeg)
        except ConnectionResetError:
            pass
        finally:
            reader_task.cancel()
            self.clients -= 1
            self.last_activity = time.time()
            print(f"[render] client disconnected ({self.clients} left)", flush=True)
        return ws

    async def health(self, request):
        return web.json_response({"ok": True, "backend": self.backend.name, "clients": self.clients,
                                  "numGaussians": self.backend.num_gaussians, "scenes": len(self.scenes),
                                  "frames": self.frames,
                                  "fps": round(self.fps, 1), "renderMs": round(self.render_ms, 1)})

    async def page(self, request):
        name = request.match_info.get("page") or "index"
        html = (STATIC_DIR / f"{name}.html").read_text()
        config = json.dumps({"widgetOrigins": self.args.widget_origin})
        html = html.replace("__VIEWERSTREAM_CONFIG__", config)
        return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-store"})

    async def idle_watchdog(self):
        while True:
            await asyncio.sleep(30)
            if self.clients == 0 and time.time() - self.last_activity > self.args.idle_timeout:
                print(f"[render] idle for {self.args.idle_timeout}s with no clients, shutting down", flush=True)
                os.kill(os.getpid(), signal.SIGINT)
                return


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ply", action="append", default=[],
                    help="3DGS point_cloud.ply, repeat for several scenes the viewer can switch between; "
                         "'name=path' sets the scene's display name")
    ap.add_argument("--backend", choices=["gsplat", "fake"], default="gsplat")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--prefix", default="/", help="URL prefix the proxy passes through (/node/<host>/<port>/ on Vera, '/' locally)")
    ap.add_argument("--secret", default=os.environ.get("VIEWERSTREAM_SECRET"),
                    help="session secret (prefer the VIEWERSTREAM_SECRET env var: argv is visible in ps)")
    ap.add_argument("--allowed-origin", action="append", default=None,
                    help="Origin allowed to open /ws (default: https://vera.c3se.chalmers.se)")
    ap.add_argument("--widget-origin", action="append", default=None,
                    help="widget origin the /relay popup will talk to (default: the GitHub Pages widget; --dev adds localhost:5173)")
    ap.add_argument("--dev", action="store_true",
                    help="local development: allow localhost origins on /ws and the local widget dev server in /relay")
    ap.add_argument("--allow-open-proxy-port", action="store_true",
                    help="permit ports 8888-8988 (publicly exposed by proxy.c3se.chalmers.se)")
    ap.add_argument("--idle-timeout", type=int, default=1800, help="exit after N s with no clients")
    ap.add_argument("--max-side", type=int, default=1920)
    ap.add_argument("--quality", type=int, default=80)
    ap.add_argument("--background", default="0,0,0", help="r,g,b in 0..1")
    ap.add_argument("--clean", choices=sorted(CLEAN_PRESETS),
                    help="drop floaters / needles / outliers at load (see CLEAN_PRESETS)")
    ap.add_argument("--bim-mesh", help="real BIM layer as triangles (bim_surfels.py --mesh-out .npz, scenes' frame); "
                    "rasterised with the scan's camera and merged per pixel - crisper than --bim-ply")
    ap.add_argument("--bim-zclip", type=float, nargs=2, help="keep BIM pixels with scene-frame z in this range (storey cut)")
    ap.add_argument("--bim-status", help="verification result per element (json {guid: {status, ...}}): adds the 'status' "
                    "view (built / not built / cannot tell / no view) and click-to-inspect")
    ap.add_argument("--evidence-dir", help="folder of the evidence crops named in --bim-status, served under evidence/")
    ap.add_argument("--bim-ply", help="real BIM layer: gaussian PLY of IFC surfels in the scenes' frame "
                    "(merged / xray / bim modes)")
    ap.add_argument("--bim-demo", action="store_true",
                    help="proof of concept: depth-merge a few BIM-like boxes into the stream (M cycles modes)")
    args = ap.parse_args()

    if args.port in OPEN_PROXY_PORTS and not args.allow_open_proxy_port:
        sys.exit(f"port {args.port} is in 8888-8988, which proxy.c3se.chalmers.se exposes to the "
                 "internet without login; pick another port (or pass --allow-open-proxy-port)")
    if not args.secret:
        args.secret = secrets.token_urlsafe(24)
        print(f"[render] no secret given, generated one: {args.secret}", flush=True)
    args.allowed_origin = args.allowed_origin or ["https://vera.c3se.chalmers.se"]
    args.widget_origin = args.widget_origin or ["https://arifyakupogullari.github.io"]
    if args.dev:  # the local Vite dev server / fake StreamBIM host
        args.widget_origin += ["http://localhost:5173", "http://127.0.0.1:5173"]
    background = [float(x) for x in args.background.split(",")]
    prefix = "/" + args.prefix.strip("/") + "/" if args.prefix.strip("/") else "/"

    specs = []
    for item in args.ply:
        name, sep, path = item.partition("=")
        specs.append((name, path) if sep and "/" not in name else (scene_name(item), item))
    if args.backend == "fake":
        # --ply values only name the test-pattern scenes (tinted per scene)
        scenes = [(n, FakeBackend(background, tint=i)) for i, (n, _p) in enumerate(specs)] \
            or [("test pattern", FakeBackend(background))]
    else:
        if not specs:
            sys.exit("--ply is required for the gsplat backend")
        scenes = [(n, GsplatBackend(path, background, clean=args.clean)) for n, path in specs]

    service = RenderService(scenes, args)
    service.warm_up()
    app = web.Application()
    app.router.add_get(prefix, service.page)
    app.router.add_get(prefix + "{page:relay}", service.page)
    app.router.add_get(prefix + "health", service.health)
    app.router.add_get(prefix + "ws", service.ws_handler)
    app.router.add_static(prefix + "static/", STATIC_DIR)
    if args.evidence_dir:
        app.router.add_static(prefix + "evidence/", args.evidence_dir)

    async def start_watchdog(app):
        app["watchdog"] = asyncio.create_task(service.idle_watchdog())

    app.on_startup.append(start_watchdog)
    print(f"[render] {service.backend.name} backend, {len(service.scenes)} scene(s), listening on "
          f"{args.host}:{args.port}{prefix}", flush=True)
    web.run_app(app, host=args.host, port=args.port, print=None, access_log=None)


if __name__ == "__main__":
    main()
