#!/bin/sh
# publish-release.sh <dir>: make <dir> (a checkout of the release branch) hold exactly the files
# the plugin needs at runtime, plus the README and changelog. Everything else in this repo (notes,
# e2e harness, demo apps, the Figma plugin) stays off customers' machines.
set -eu
dest=$1
src=$(cd "$(dirname "$0")/.." && pwd)
find "$dest" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
for part in .claude-plugin .mcp.json agents browser hooks scripts skills README.md CHANGELOG.md; do
  cp -R "$src/$part" "$dest/"
done
find "$dest" -name __pycache__ -type d -prune -exec rm -rf {} +
