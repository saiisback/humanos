#!/usr/bin/env bash
# Installs the pinned official ENSv2 contracts (ensdomains/contracts-v2) into lib/.
#
# The pin is the exact commit the official ENS docs build their Sepolia ENSv2
# deployment table from (ensdomains/docs scripts/ensv2-deployments.ts
# CONTRACTS_V2_COMMIT). Submodules are checked out at the commits recorded in
# that tree, so every transitive dependency is pinned too.
set -euo pipefail

CONTRACTS_V2_REPO="https://github.com/ensdomains/contracts-v2.git"
CONTRACTS_V2_COMMIT="71a3b7339dbc55ab47667abdfe8303bac4f4c24e"
FORGE_STD_REPO="https://github.com/foundry-rs/forge-std.git"
FORGE_STD_COMMIT="77041d2ce690e692d6e03cc812b57d1ddaa4d505"

# Only the submodules needed by the registry, resolver, factory, and resolution
# code paths used here. Account-abstraction/HCA submodules are intentionally skipped.
SUBMODULES=(
  contracts/lib/openzeppelin-contracts
  contracts/lib/openzeppelin-contracts-upgradeable
  contracts/lib/openzeppelin-contracts-v4
  contracts/lib/verifiable-factory
  contracts/lib/ens-contracts
  contracts/lib/buffer
  contracts/lib/solsha1
  contracts/lib/unruggable-gateways
  contracts/lib/solady
)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/lib"
DEST="$LIB/contracts-v2"
mkdir -p "$LIB"

checkout_pinned() {
  local repo="$1" commit="$2" dest="$3"
  if [ -d "$dest/.git" ] && [ "$(git -C "$dest" rev-parse HEAD)" = "$commit" ]; then
    return 0
  fi
  rm -rf "$dest"
  git init -q "$dest"
  git -C "$dest" remote add origin "$repo"
  git -C "$dest" fetch -q --depth 1 origin "$commit"
  git -C "$dest" -c advice.detachedHead=false checkout -q FETCH_HEAD
}

checkout_pinned "$CONTRACTS_V2_REPO" "$CONTRACTS_V2_COMMIT" "$DEST"
git -C "$DEST" submodule update --init --depth 1 -- "${SUBMODULES[@]}"
# verifiable-factory carries its own OpenZeppelin submodules.
git -C "$DEST/contracts/lib/verifiable-factory" submodule update --init --depth 1 --recursive

checkout_pinned "$FORGE_STD_REPO" "$FORGE_STD_COMMIT" "$LIB/forge-std"

actual="$(git -C "$DEST" rev-parse HEAD)"
if [ "$actual" != "$CONTRACTS_V2_COMMIT" ]; then
  echo "contracts-v2 pin mismatch: expected $CONTRACTS_V2_COMMIT got $actual" >&2
  exit 1
fi
echo "ensdomains/contracts-v2 @ $actual"
git -C "$DEST" submodule status -- "${SUBMODULES[@]}"
