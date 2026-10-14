#!/usr/bin/env bash
# Print a renderer job's session link once it is up (run from the repo root,
# where the job's viewerstream_<jobid>.out lands):
#     bash server/vera/link.sh <jobid>
job=${1:?usage: bash server/vera/link.sh <jobid>}
out="viewerstream_${job}.out"
until grep -q "renderer up" "$out" 2>/dev/null; do
    if [ -z "$(squeue -h -j "$job" -o %T 2>/dev/null)" ]; then
        echo "job $job is not running any more - see viewerstream_${job}.err"
        exit 1
    fi
    sleep 5
done
cat "$(grep -o '/[^ ]*session-[^ ]*\.txt' "$out" | tail -1)"
