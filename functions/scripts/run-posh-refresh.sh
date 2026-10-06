#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [[ -n "${HTTPS_PROXY:-}" || -n "${HTTP_PROXY:-}" ]]; then
  export NODE_USE_ENV_PROXY=1
fi
ENV_FILE="$HOME/Library/Application Support/Pulse/posh-ingest.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

SCRIPT_DIR="${0:A:h}"
exec node "$SCRIPT_DIR/refresh-posh.mjs"
