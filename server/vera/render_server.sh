#!/usr/bin/env bash
#SBATCH -A C3SE2026-1-13 -p vera
#SBATCH -J viewerstream
#SBATCH -t 04:00:00
#SBATCH --gpus-per-node=A100:1
#SBATCH -n 1 -c 8
#SBATCH -o viewerstream_%j.out
#SBATCH -e viewerstream_%j.err

# Batch alternative to the notebook: run the renderer as a plain job.
# Submit from the repo root:
#     sbatch server/vera/render_server.sh /path/to/point_cloud.ply
#     sbatch server/vera/render_server.sh fake        # GPU-free test pattern
# The session link (with its secret) goes to ~/viewerstream-logs/session-*.txt
# (user-only), not to this job's .out file. Open it while logged in to
# https://vera.c3se.chalmers.se. The job ends on scancel, at the time limit,
# or after 30 min with no viewer connected.

REPO=${VIEWERSTREAM_REPO:-$SLURM_SUBMIT_DIR}
if [ ! -f "$REPO/server/render_server.py" ]; then
    echo "ERROR: submit from the viewerStream repo root (or set VIEWERSTREAM_REPO)"
    exit 1
fi

if [ "${1:-}" = "fake" ]; then
    exec python3 "$REPO/server/vera/launch.py" --foreground --backend fake
fi
exec python3 "$REPO/server/vera/launch.py" --foreground --ply "${1:?usage: sbatch render_server.sh <point_cloud.ply | fake>}"
