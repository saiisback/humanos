#!/usr/bin/env bash
# Runs forge from PATH or the official foundryup install location, installing pinned deps first.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if ! command -v forge >/dev/null 2>&1; then
  if [ -x "$HOME/.foundry/bin/forge" ]; then
    export PATH="$HOME/.foundry/bin:$PATH"
  else
    echo "forge not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup" >&2
    exit 1
  fi
fi
[ -d lib/contracts-v2/contracts/src ] && [ -d lib/forge-std/src ] || ./script/install-deps.sh
exec forge "$@"
