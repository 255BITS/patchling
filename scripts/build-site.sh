#!/usr/bin/env bash
# Build the patchling.app Cloudflare Pages output into dist/:
#   dist/      landing/ as-is (the demo page)
#   dist/py/   patchling-py docs (mkdocs), fetched from 255BITS/patchling-py
#   dist/js/   this repo's README, CHANGELOG and docs/ rendered with mkdocs
#   dist/_redirects  /docs/* -> /py/*
#   dist/build-info.json  commit SHAs of both repos used for this build
# Build tooling (mkdocs-material in a throwaway venv) lives only here and in
# .site-build/; nothing is added to package.json or the npm package.
# Public clone, no token. Env:
#   PATCHLING_PY_REF   branch/tag of patchling-py to build (default main)
#   MKDOCS_MATERIAL    pip spec (default mkdocs-material==9.6.22, same pin as
#                      patchling-py's Deploy Documentation workflow)
#   PYTHON             interpreter (default python3)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
out="$root/dist"
work="$root/.site-build"
ref="${PATCHLING_PY_REF:-main}"
py="${PYTHON:-python3}"

rm -rf "$out" "$work"
mkdir -p "$work"
cp -R landing "$out"

echo "== fetch 255BITS/patchling-py@$ref"
git clone --quiet --depth 1 --branch "$ref" https://github.com/255BITS/patchling-py.git "$work/patchling-py"
py_sha=$(git -C "$work/patchling-py" rev-parse HEAD)
self_sha=$(git -C "$root" rev-parse HEAD 2>/dev/null || echo "${CF_PAGES_COMMIT_SHA:-unknown}")
echo "patchling commit:    $self_sha"
echo "patchling-py commit: $py_sha (ref $ref)"

echo "== mkdocs (${MKDOCS_MATERIAL:-mkdocs-material==9.6.22})"
"$py" -m venv "$work/venv"
"$work/venv/bin/python" -m pip install --quiet --disable-pip-version-check "${MKDOCS_MATERIAL:-mkdocs-material==9.6.22}"
mkdocs="$work/venv/bin/mkdocs"

echo "== /py/"
# Same source and nav as gptdiff.255labs.xyz; only site_url changes.
cat > "$work/patchling-py/mkdocs.patchling-app.yml" <<YML
INHERIT: mkdocs.yml
site_url: https://patchling.app/py/
YML
"$mkdocs" build --strict --quiet -f "$work/patchling-py/mkdocs.patchling-app.yml" -d "$out/py"

echo "== /js/"
js="$work/js"
mkdir -p "$js/docs"
# README links docs/x.md and the root-level infographic; flatten for the site.
sed -e 's#](docs/#](#g' README.md > "$js/docs/index.md"
cp infographic.svg "$js/docs/"
cp CHANGELOG.md docs/*.md "$js/docs/"
cp scripts/site/mkdocs.js.yml "$js/mkdocs.yml"
"$mkdocs" build --strict --quiet -f "$js/mkdocs.yml" -d "$out/js"

cp scripts/site/_redirects "$out/_redirects"
# Record exactly what went into this build (served at /build-info.json).
cat > "$out/build-info.json" <<JSON
{
  "patchling": {"repo": "255BITS/patchling", "commit": "$self_sha"},
  "patchling_py": {"repo": "255BITS/patchling-py", "ref": "$ref", "commit": "$py_sha"},
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
echo "== build-info.json: patchling $self_sha, patchling-py $py_sha"
echo "== done: $(find "$out" -type f | wc -l) files in dist/"
