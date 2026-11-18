#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Reproducible build of dist-wasm/openexr.{mjs,wasm} using the official
# emscripten/emsdk Docker image. Requires only Docker on the host.
#
#   packages/exr-wasm/scripts/build-wasm.sh            # build
#   CLEAN=1 packages/exr-wasm/scripts/build-wasm.sh    # wipe build/ first
#
# Pinned inputs (change deliberately):
EMSDK_IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:6.0.13}"
OPENEXR_TAG="v3.4.9"
OPENEXR_COMMIT="b5fa98ac6b5fc660c0295123c1d02bbf687dbec3"
IMATH_TAG="v3.2.2" # header-only use (ImathConfig.h / half); fetched by OpenEXR's CMake

set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${INSIDE_EMSDK:-}" != "1" ]]; then
  command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
  [[ "${CLEAN:-}" == "1" ]] && rm -rf "$PKG_DIR/build"
  mkdir -p "$PKG_DIR/build" "$PKG_DIR/dist-wasm"
  exec docker run --rm \
    -v "$PKG_DIR":/work \
    -w /work \
    -u "$(id -u):$(id -g)" \
    -e HOME=/work/build/home \
    -e EM_CACHE=/work/build/emcache \
    -e INSIDE_EMSDK=1 \
    -e EXTRA_FLAGS="${EXTRA_FLAGS:-}" \
    "$EMSDK_IMAGE" \
    bash /work/scripts/build-wasm.sh
fi

# ---------------------------------------------------------------- in container
cd /work
mkdir -p build/home build/emcache
emcc --version | head -1

SRC=build/openexr-src
if [[ ! -d "$SRC/.git" ]]; then
  rm -rf "$SRC"
  git clone --quiet --depth 1 --branch "$OPENEXR_TAG" \
    https://github.com/AcademySoftwareFoundation/openexr.git "$SRC"
fi
actual="$(git -C "$SRC" rev-parse HEAD)"
if [[ "$actual" != "$OPENEXR_COMMIT" ]]; then
  echo "OpenEXR checkout is $actual, expected $OPENEXR_COMMIT ($OPENEXR_TAG)" >&2
  exit 1
fi

FLAGS="-O3 -msimd128 -fwasm-exceptions -DNDEBUG ${EXTRA_FLAGS:-}"

emcmake cmake -S src-c -B build/cmake -G "Unix Makefiles" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$FLAGS" \
  -DCMAKE_CXX_FLAGS="$FLAGS" \
  -DOPENEXR_SOURCE_DIR="/work/$SRC" \
  -DOPENEXR_IMATH_TAG="$IMATH_TAG" \
  -DCMAKE_EXE_LINKER_FLAGS="${EXTRA_FLAGS:-}" \
  -DFETCHCONTENT_QUIET=ON

cmake --build build/cmake --target openexr_wasm -j"$(nproc)"

cp build/cmake/openexr.mjs build/cmake/openexr.wasm dist-wasm/

# The Node branch of the Emscripten glue does `import("node:module")`. Make the
# specifier non-literal so browser bundlers (Vite/Rollup) do not try to resolve
# or externalize it (it only runs under Node).
sed -i 's|import("node:module")|import(/* @vite-ignore */ "node:" + "module")|g' dist-wasm/openexr.mjs
grep -q '"node:" + "module"' dist-wasm/openexr.mjs
# third-party license texts travel with the binary
mkdir -p dist-wasm/licenses
cp "$SRC/LICENSE.md" dist-wasm/licenses/OpenEXR-LICENSE.md
cp "$SRC/external/deflate/COPYING" dist-wasm/licenses/libdeflate-COPYING
cp "$SRC/external/OpenJPH/LICENSE" dist-wasm/licenses/OpenJPH-LICENSE
cp build/cmake/_deps/imath-src/LICENSE.md dist-wasm/licenses/Imath-LICENSE.md

ls -l dist-wasm/ dist-wasm/licenses/
