#!/usr/bin/env bash
# One-time setup: build the Python env the renderer runs in, inside gs.sif
# (the PyTorch 2.2.1 / CUDA 12.1 container final_hope.sh trains in).
#
# Run it on a GPU node, e.g. from a terminal inside a Vera OnDemand Jupyter
# session with an A100, so gsplat's CUDA kernels get built and smoke-tested:
#     bash server/vera/setup_env.sh
#
# Override paths with VIEWERSTREAM_SIF / VIEWERSTREAM_VENV / APPTAINER.
set -euo pipefail

SIF=${VIEWERSTREAM_SIF:-/cephyr/users/ahmetari/Vera/gaussian/gs.sif}
VENV=${VIEWERSTREAM_VENV:-/cephyr/NOBACKUP/groups/c3se2026-1-14/viewerstream/venv}
APPTAINER=${APPTAINER:-apptainer}

if [ ! -f "$SIF" ]; then
    echo "ERROR: container not found: $SIF (set VIEWERSTREAM_SIF)"
    exit 1
fi
mkdir -p "$(dirname "$VENV")"

"$APPTAINER" exec --nv --bind /cephyr "$SIF" bash -s "$VENV" <<'IN_CONTAINER'
set -euo pipefail
VENV=$1
python3 -m venv --system-site-packages "$VENV"

# Same guard as final_hope.sh: pip must never swap the container's NumPy 1.x
# or its CUDA-matched torch build for something else.
python3 -c "import numpy, torch; print(f'numpy=={numpy.__version__}'); print('torch==' + torch.__version__.split('+')[0])" \
    > "$VENV/constraints.txt"
export PIP_CONSTRAINT="$VENV/constraints.txt"
echo "pinned: $(tr '\n' ' ' < "$VENV/constraints.txt")"

# gsplat compiles its CUDA kernels on first use (via ninja, which pip puts in
# the venv's bin/ - so that has to be on PATH); build them for both A100 (8.0)
# and H100 (9.0) nodes. launch.py sets the same two variables at runtime.
export PATH="$VENV/bin:$PATH"
export TORCH_CUDA_ARCH_LIST="8.0;9.0"
"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install "gsplat==1.4.0" aiohttp simplejpeg segno

echo "smoke test (first run compiles gsplat, can take several minutes)..."
"$VENV/bin/python" - <<'PY'
import torch
from gsplat import rasterization
assert torch.cuda.is_available(), "no GPU visible - run this on a GPU node"
n = 1000
dev = "cuda"
means = torch.randn(n, 3, device=dev) + torch.tensor([0, 0, 5.0], device=dev)
quats = torch.nn.functional.normalize(torch.randn(n, 4, device=dev), dim=-1)
scales = torch.full((n, 3), 0.05, device=dev)
opac = torch.full((n,), 0.8, device=dev)
sh = torch.rand(n, 1, 3, device=dev)
K = torch.tensor([[[100.0, 0, 64], [0, 100.0, 64], [0, 0, 1]]], device=dev)
img, _, _ = rasterization(means, quats, scales, opac, sh, torch.eye(4, device=dev)[None], K, 128, 128, sh_degree=0)
print("gsplat OK:", tuple(img.shape), "on", torch.cuda.get_device_name(0))
PY
IN_CONTAINER

echo "done: venv at $VENV"
