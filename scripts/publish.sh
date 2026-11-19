#!/usr/bin/env bash
# Publishes every package in packages/ whose current version is not on npm yet.
# Runs in CI with npm Trusted Publishing (OIDC): no NPM_TOKEN. `pnpm pack` resolves
# `workspace:` ranges and publishConfig; `npm publish` (>= 11.5.1) authenticates via OIDC.
set -euo pipefail
out="$(mktemp -d)"
for dir in packages/*/; do
  name=$(node -p "require('./${dir}package.json').name")
  version=$(node -p "require('./${dir}package.json').version")
  if [ "$(node -p "require('./${dir}package.json').private || false")" = "true" ]; then continue; fi
  if npm view "${name}@${version}" version >/dev/null 2>&1; then
    echo "skip ${name}@${version} (already published)"
    continue
  fi
  tgz=$(cd "$dir" && pnpm pack --pack-destination "$out" | tail -1)
  npm publish "$tgz" --access public --provenance
  # changesets/action parses these lines to create git tags and GitHub releases.
  echo "New tag: ${name}@${version}"
done
