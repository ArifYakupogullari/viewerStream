#!/usr/bin/env bash
# Time the renderer's stages on a real splat (run on a GPU node, e.g. via ssh
# into a running OnDemand job's node):
#     bash server/vera/bench.sh /path/to/point_cloud.ply [--sizes 1280x720]
set -euo pipefail
SIF=${VIEWERSTREAM_SIF:-/cephyr/users/ahmetari/Vera/gaussian/gs.sif}
VENV=${VIEWERSTREAM_VENV:-/cephyr/NOBACKUP/groups/c3se2026-1-14/viewerstream/venv}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
# same runtime environment launch.py gives the renderer
export APPTAINERENV_PREPEND_PATH="$VENV/bin"
export APPTAINERENV_TORCH_CUDA_ARCH_LIST="8.0;9.0"
exec "${APPTAINER:-apptainer}" exec --nv --bind /cephyr "$SIF" \
    "$VENV/bin/python" "$REPO/server/bench_render.py" --ply "$1" "${@:2}"
