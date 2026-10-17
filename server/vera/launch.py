#!/usr/bin/env python3
"""Start / check / stop the viewerStream renderer on a Vera compute node.

Stdlib only: it runs in whatever Python the OnDemand Jupyter kernel (or a
batch job) has. The renderer itself runs inside gs.sif with the venv that
setup_env.sh built.

Notebook (inside a Vera OnDemand Jupyter session with an A100):

    import sys; sys.path.insert(0, "<repo>/server/vera")
    import launch
    session = launch.start(ply="/path/to/point_cloud.ply")   # or backend="fake"
    session.show()      # links + QR code
    session.status()
    session.stop()

Batch job: see render_server.sh (calls `python3 launch.py --foreground ...`).

Access: the printed link goes through the Vera portal,
https://vera.c3se.chalmers.se/node/<host>/<port>/?s=<secret>, so opening it
requires a Chalmers login; the ?s= secret additionally keeps other cluster
users (who can reach <host>:<port> directly) out. Ports are chosen outside
8888-8988, the range C3SE's unauthenticated public proxy forwards.
"""
import argparse
import html
import json
import os
import random
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PORTAL = "https://vera.c3se.chalmers.se"
REPO = Path(__file__).resolve().parents[2]
DEFAULT_SIF = os.environ.get("VIEWERSTREAM_SIF", "/cephyr/users/ahmetari/Vera/gaussian/gs.sif")
DEFAULT_VENV = os.environ.get("VIEWERSTREAM_VENV", "/cephyr/NOBACKUP/groups/c3se2026-1-14/viewerstream/venv")
APPTAINER = os.environ.get("APPTAINER", "apptainer")
LOG_DIR = Path.home() / "viewerstream-logs"
PORT_RANGE = (20000, 29999)  # well clear of the public proxy's 8888-8988


def pick_port():
    for _ in range(200):
        port = random.randint(*PORT_RANGE)
        with socket.socket() as s:
            try:
                s.bind(("0.0.0.0", port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free port found")


class Session:
    def __init__(self, proc, host, port, secret, log_path):
        self.proc, self.host, self.port, self.secret, self.log_path = proc, host, port, secret, log_path
        # Vera's portal proxies /node/<host>/<port>/... with the full path,
        # so the server's routes live under that prefix
        self.prefix = f"/node/{host}/{port}/"

    @property
    def link(self):
        """Standalone viewer link, also the session link to paste into the widget."""
        return f"{PORTAL}{self.prefix}?s={self.secret}"

    def health(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{self.prefix}health", timeout=3) as r:
            return json.loads(r.read())

    def status(self):
        if self.proc.poll() is not None:
            print(f"renderer exited with code {self.proc.returncode}; last log lines:")
            print(self.log_tail())
            return None
        h = self.health()
        print(f"{h['backend']} renderer on {self.host}:{self.port} - {h['clients']} client(s), "
              f"{h['fps']} fps, {h['renderMs']} ms/frame, {h['frames']} frames so far")
        return h

    def log_tail(self, n=20):
        try:
            return "\n".join(self.log_path.read_text().splitlines()[-n:])
        except OSError:
            return "(no log)"

    def stop(self):
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
        print("renderer stopped")

    def qr_svg(self):
        try:
            import segno
        except ImportError:
            return None
        return segno.make(self.link, error="m").svg_inline(scale=4, dark="#000", light="#fff")

    def show(self):
        """Links (+ QR code when segno is importable) in a notebook, plain text otherwise."""
        try:
            from IPython.display import HTML, display
        except ImportError:
            print(self.text())
            return
        qr = self.qr_svg()
        qr_html = qr if qr else "<i>(pip install --user segno for a QR code)</i>"
        link = html.escape(self.link)
        display(HTML(
            f"<p><b>Renderer running</b> on {html.escape(self.host)}:{self.port}.</p>"
            f"<p>Open in a browser (log in with your Chalmers account if asked):<br>"
            f"<a href='{link}' target='_blank'>{link}</a></p>"
            f"<p>StreamBIM widget: click <i>Remote</i>, paste the same link, press <i>Connect</i>.</p>"
            f"<p>Phone (eduroam / Chalmers VPN):<br>{qr_html}</p>"
            f"<p style='opacity:.7'>The link only works while this renderer runs. "
            f"Stop it with <code>session.stop()</code>; ending the OnDemand session frees the GPU.</p>"
        ))

    def text(self):
        return (f"Renderer running on {self.host}:{self.port}\n"
                f"  open / paste into the widget: {self.link}\n"
                f"  (Chalmers login via the Vera portal; link valid while the renderer runs)")


def start(ply=None, backend="gsplat", sif=DEFAULT_SIF, venv=DEFAULT_VENV, idle_timeout=1800,
          extra_args=(), wait=900):
    """Launch the renderer in the background and wait until it answers /health."""
    # one path, or several (the viewer can switch between them); "name=path" names a scene
    plies = [ply] if isinstance(ply, str) else list(ply or [])
    for item in plies:
        name, sep, path = item.partition("=")
        path = path if sep and "/" not in name else item
        if backend == "gsplat" and not Path(path).is_file():
            raise FileNotFoundError(f"PLY not found: {path!r}")
    if backend == "gsplat" and not plies:
        raise FileNotFoundError("no PLY given (pass ply=..., or backend='fake' for a test pattern)")
    if not Path(sif).is_file():
        raise FileNotFoundError(f"container not found: {sif} (set VIEWERSTREAM_SIF)")
    # lexists: bin/python links to the container's interpreter, absent on the host
    if not os.path.lexists(Path(venv, "bin", "python")):
        raise FileNotFoundError(f"venv not found: {venv} - run server/vera/setup_env.sh once")

    host = socket.gethostname()
    port = pick_port()
    secret = secrets.token_urlsafe(24)
    LOG_DIR.mkdir(exist_ok=True)
    log_path = LOG_DIR / f"{host}-{port}.log"
    cmd = [APPTAINER, "exec", "--nv", "--bind", "/cephyr", sif,
           f"{venv}/bin/python", str(REPO / "server" / "render_server.py"),
           "--backend", backend, "--port", str(port), "--idle-timeout", str(idle_timeout),
           "--prefix", f"/node/{host}/{port}/", *extra_args]
    for item in plies:
        cmd += ["--ply", str(item)]
    # the secret goes through the environment, not argv (argv is visible in ps);
    # gsplat's JIT build/load needs the venv's ninja on PATH, and the same arch
    # list setup_env.sh compiled with so the cached kernels are reused
    env = dict(os.environ, APPTAINERENV_VIEWERSTREAM_SECRET=secret,
               APPTAINERENV_PREPEND_PATH=f"{venv}/bin", APPTAINERENV_TORCH_CUDA_ARCH_LIST="8.0;9.0")
    with open(log_path, "w") as log:
        proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
    session = Session(proc, host, port, secret, log_path)

    print(f"starting {backend} renderer on {host}:{port} (log: {log_path}) ...", flush=True)
    deadline = time.time() + wait
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"renderer exited with code {proc.returncode}:\n{session.log_tail()}")
        try:
            if session.health().get("ok"):
                return session
        except OSError:
            pass
        time.sleep(2)
    session.stop()
    raise TimeoutError(f"renderer did not come up within {wait}s:\n{session.log_tail()}")


def main():
    ap = argparse.ArgumentParser(description="Run the viewerStream renderer in the foreground (batch jobs).")
    ap.add_argument("--ply", action="append", default=[], help="repeat for several switchable scenes; name=path to name one")
    ap.add_argument("--backend", choices=["gsplat", "fake"], default="gsplat")
    ap.add_argument("--idle-timeout", type=int, default=1800)
    ap.add_argument("--bim-demo", action="store_true", help="merged BIM + splat proof of concept")
    ap.add_argument("--bim-ply", help="real BIM layer (gaussian PLY of IFC surfels, same frame as the scenes)")
    ap.add_argument("--bim-mesh", help="real BIM layer as triangles (.npz from bim_surfels.py --mesh-out), crisper")
    ap.add_argument("--bim-zclip", type=float, nargs=2, help="storey cut for --bim-mesh: scene-frame z range")
    ap.add_argument("--bim-status", help="verification result per element (json): status view + click-to-inspect")
    ap.add_argument("--evidence-dir", help="folder of the evidence crops named in --bim-status")
    ap.add_argument("--clean", choices=["light", "medium", "strong"], help="drop floaters/needles at load")
    ap.add_argument("--foreground", action="store_true", help="block until the renderer exits")
    a = ap.parse_args()
    session = start(ply=a.ply, backend=a.backend, idle_timeout=a.idle_timeout,
                    extra_args=(("--bim-demo",) if a.bim_demo else ()) + (("--clean", a.clean) if a.clean else ())
                    + (("--bim-ply", a.bim_ply) if a.bim_ply else ())
                    + (("--bim-mesh", a.bim_mesh) if a.bim_mesh else ())
                    + (("--bim-zclip", *map(str, a.bim_zclip)) if a.bim_zclip else ())
                    + (("--bim-status", a.bim_status) if a.bim_status else ())
                    + (("--evidence-dir", a.evidence_dir) if a.evidence_dir else ()))
    # The link carries the session secret: keep it out of the (possibly
    # group-readable) Slurm .out file and in a user-only file instead.
    link_file = LOG_DIR / f"session-{session.host}-{session.port}.txt"
    link_file.touch(mode=0o600)
    link_file.write_text(session.text() + "\n")
    print(f"renderer up on {session.host}:{session.port}; link in {link_file} (cat it)", flush=True)
    if a.foreground:
        # the link dies with the renderer: remove it so it can't be reused stale
        def forward(signum, _frame):
            session.stop()
            link_file.unlink(missing_ok=True)
            sys.exit(0)
        signal.signal(signal.SIGTERM, forward)
        signal.signal(signal.SIGINT, forward)
        code = session.proc.wait()
        link_file.unlink(missing_ok=True)
        sys.exit(code)


if __name__ == "__main__":
    main()
