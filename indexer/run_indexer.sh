#!/usr/bin/env bash
set -euo pipefail
cd /home/ogma/ogma/indexer
source /home/ogma/ogma/indexer/.venv/bin/activate
export PYTHONUNBUFFERED=1
exec python /home/ogma/ogma/indexer/index_new.py
