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
        fov_y = math.degrees(2 * math.atan(cam["height"] / (2 * cam["fy"])))
        return {"position": pos.tolist(), "target": (pos + forward).tolist(),
                "up": up.tolist(), "fovY": fov_y}
    except Exception as e:  # malformed file: fall back to bounds-based default
        print(f"[render] ignoring {cams_path}: {e}", flush=True)
        return None


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------
class GsplatBackend:
    name = "gsplat"

    def __init__(self, ply_path, background):
        import torch
        from gsplat import rasterization

        self.torch, self.rasterization = torch, rasterization
        t0 = time.time()
        v = read_ply_vertices(ply_path)
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
        self.num_gaussians = n
        lo, hi = np.percentile(means, [2, 98], axis=0)
        self.bounds = [lo.tolist(), hi.tolist()]
        self.default_camera = default_camera_from_cameras_json(ply_path) or self._bounds_camera(lo, hi)
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

    def render_rgbd(self, viewmat_cv, fx, fy, cx, cy, width, height):
        """Colour (0..1) and camera z-depth as numpy arrays; depth is inf where
        the splat is mostly transparent (nothing there to occlude BIM)."""
        torch = self.torch
        with torch.no_grad():
            dev = self.means.device
            viewmats = torch.tensor(viewmat_cv, dtype=torch.float32, device=dev)[None]
            ks = torch.tensor([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=torch.float32, device=dev)[None]
            background = torch.cat([self.background, torch.zeros(1, 1, device=dev)], dim=-1)
            out, alphas, _meta = self.rasterization(
                self.means, self.quats, self.scales, self.opacities, self.sh,
                viewmats, ks, width, height, sh_degree=self.sh_degree, near_plane=0.01, far_plane=1e6,
                backgrounds=background, render_mode="RGB+ED",
            )
            rgb = out[0, ..., :3].clamp(0, 1)
            depth = torch.where(alphas[0, ..., 0] > 0.5, out[0, ..., 3], torch.full_like(out[0, ..., 3], float("inf")))
            return rgb.cpu().numpy(), depth.cpu().numpy()


class FakeBackend:
    """GPU-free stand-in: a checkered ground plane (y = 0) under a sky gradient,
    ray-cast for the requested camera, so motion and axis conventions can be
    checked without CUDA. Red line = +X axis, blue line = +Z axis."""
    name = "fake"

    def __init__(self, background):
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
        ground = np.where(checker[..., None] > 0, 0.85, 0.35) * np.ones(3, np.float32)
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

    MODES = ("merged", "xray", "splat")

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
        d = float(np.median(ahead)) if ahead.size else 3.0
        self.d = d
        axes = np.stack([r, u, f]).astype(np.float32)
        self.boxes = [  # (centre, axes as rows, half sizes along them, colour)
            (eye + f * 0.55 * d - r * 0.28 * d, axes, np.array([0.05, 0.6, 0.05]) * d, (0.95, 0.55, 0.10)),
            (eye + f * 1.00 * d + r * 0.30 * d, axes, np.array([0.22, 0.30, 0.12]) * d, (0.20, 0.50, 0.95)),
            (eye + f * 0.75 * d + u * 0.32 * d, axes, np.array([0.90, 0.035, 0.035]) * d, (0.25, 0.80, 0.40)),
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
class RenderService:
    def __init__(self, backend, args):
        self.backend = backend
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
        self.bim = BimDemo(backend) if args.bim_demo else None
        self.modes = BimDemo.MODES if self.bim else ("splat",)

    def warm_up(self):
        """The first gsplat call loads the CUDA kernels (~1 s). Pay that before
        anyone connects, then reset the stats so they reflect real frames."""
        cam = self.backend.default_camera
        view = look_at_view(cam["position"], cam["target"], cam["up"]).T.flatten().tolist()
        t0 = time.perf_counter()
        for _ in range(2):
            self.render_jpeg(self.parse_camera({"view": view, "fovY": cam["fovY"], "width": 640, "height": 360}))
        print(f"[render] warm-up done in {time.perf_counter() - t0:.1f}s", flush=True)
        self.frames, self.fps, self.render_ms = 0, 0.0, 0.0
        self._fps_window, self._render_times = [], deque(maxlen=30)

    def info(self):
        return {"type": "info", "backend": self.backend.name, "numGaussians": self.backend.num_gaussians,
                "shDegree": self.backend.sh_degree, "bounds": self.backend.bounds,
                "defaultCamera": self.backend.default_camera, "maxSide": self.args.max_side,
                "modes": list(self.modes)}

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
        return GL_TO_CV @ m, fy, fy, width / 2, height / 2, width, height, quality, mode

    def render_jpeg(self, cam):
        viewmat, fx, fy, cx, cy, w, h, quality, mode = cam
        t0 = time.perf_counter()
        if self.bim is not None and mode != "splat":
            rgb, depth = self.backend.render_rgbd(viewmat, fx, fy, cx, cy, w, h)
            bim_rgb, bim_depth = self.bim.render(viewmat, fx, fy, cx, cy, w, h)
            front = bim_depth < depth  # BIM surface nearer than the scan: it wins
            alpha = np.where(front, 0.92, 0.0)
            if mode == "xray":  # also ghost the BIM parts the scan hides
                alpha = np.where(np.isfinite(bim_depth) & ~front, 0.35, alpha)
            img = ((rgb * (1 - alpha[..., None]) + bim_rgb * alpha[..., None]) * 255).astype(np.uint8)
        else:
            img = self.backend.render(viewmat, fx, fy, cx, cy, w, h)
        jpeg = encode_jpeg(img, quality)
        dt = time.perf_counter() - t0
        now = time.time()
        self.frames += 1
        self._render_times.append(dt * 1000)
        self.render_ms = sum(self._render_times) / len(self._render_times)
        self._fps_window = [t for t in self._fps_window if now - t < 2.0] + [now]
        self.fps = len(self._fps_window) / 2.0
        return jpeg

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
                                  "numGaussians": self.backend.num_gaussians, "frames": self.frames,
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
    ap.add_argument("--ply", help="3DGS point_cloud.ply (required for the gsplat backend)")
    ap.add_argument("--backend", choices=["gsplat", "fake"], default="gsplat")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--prefix", default="/", help="URL prefix the proxy passes through (/node/<host>/<port>/ on Vera, '/' locally)")
    ap.add_argument("--secret", default=os.environ.get("VIEWERSTREAM_SECRET"),
                    help="session secret (prefer the VIEWERSTREAM_SECRET env var: argv is visible in ps)")
    ap.add_argument("--allowed-origin", action="append", default=None,
                    help="Origin allowed to open /ws (default: https://vera.c3se.chalmers.se)")
    ap.add_argument("--widget-origin", action="append", default=None,
                    help="widget origin the /relay popup will talk to (default: GitHub Pages + local dev)")
    ap.add_argument("--dev", action="store_true", help="also allow http://localhost / 127.0.0.1 origins on /ws")
    ap.add_argument("--allow-open-proxy-port", action="store_true",
                    help="permit ports 8888-8988 (publicly exposed by proxy.c3se.chalmers.se)")
    ap.add_argument("--idle-timeout", type=int, default=1800, help="exit after N s with no clients")
    ap.add_argument("--max-side", type=int, default=1920)
    ap.add_argument("--quality", type=int, default=80)
    ap.add_argument("--background", default="0,0,0", help="r,g,b in 0..1")
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
    args.widget_origin = args.widget_origin or [
        "https://arifyakupogullari.github.io", "http://localhost:5173", "http://127.0.0.1:5173"]
    background = [float(x) for x in args.background.split(",")]
    prefix = "/" + args.prefix.strip("/") + "/" if args.prefix.strip("/") else "/"

    if args.backend == "fake":
        backend = FakeBackend(background)
    else:
        if not args.ply:
            sys.exit("--ply is required for the gsplat backend")
        backend = GsplatBackend(args.ply, background)

    service = RenderService(backend, args)
    service.warm_up()
    app = web.Application()
    app.router.add_get(prefix, service.page)
    app.router.add_get(prefix + "{page:relay}", service.page)
    app.router.add_get(prefix + "health", service.health)
    app.router.add_get(prefix + "ws", service.ws_handler)
    app.router.add_static(prefix + "static/", STATIC_DIR)

    async def start_watchdog(app):
        app["watchdog"] = asyncio.create_task(service.idle_watchdog())

    app.on_startup.append(start_watchdog)
    print(f"[render] {backend.name} backend listening on {args.host}:{args.port}{prefix}", flush=True)
    web.run_app(app, host=args.host, port=args.port, print=None, access_log=None)


if __name__ == "__main__":
    main()
