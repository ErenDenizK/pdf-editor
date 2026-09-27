#!/usr/bin/env bash
# Builds qpdf to WebAssembly from pinned upstream sources (ADR-0008).
#
#   packages/engine/qpdf/build.sh [workdir]
#
# Needs an activated emsdk (`source emsdk_env.sh`), cmake >= 3.16, ninja and git. Every
# source is fetched with `git clone` at a pinned tag (no tarballs, no CDN). Output:
# packages/engine/qpdf/dist/qpdf.mjs + qpdf.wasm (ES module factory `createQpdf`, MEMFS,
# `callMain`, single-threaded). The output is deterministic for a given emsdk version.
set -euo pipefail

QPDF_TAG=v12.4.2
ZLIB_TAG=v1.3.1
LIBJPEG_TURBO_TAG=3.1.2

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="${1:-$here/.build}"
prefix="$work/prefix"
out="$here/dist"
mkdir -p "$work" "$prefix" "$out"

command -v emcmake >/dev/null || { echo "emsdk is not activated (emcmake missing)" >&2; exit 1; }

clone() { # repo tag dir
  if [ ! -d "$work/$3" ]; then
    git -c advice.detachedHead=false clone --depth 1 --branch "$2" "$1" "$work/$3"
  fi
}

clone https://github.com/madler/zlib "$ZLIB_TAG" zlib
clone https://github.com/libjpeg-turbo/libjpeg-turbo "$LIBJPEG_TURBO_TAG" libjpeg-turbo
clone https://github.com/qpdf/qpdf "$QPDF_TAG" qpdf

common=(-G Ninja -DCMAKE_BUILD_TYPE=Release "-DCMAKE_INSTALL_PREFIX=$prefix"
  "-DCMAKE_C_FLAGS=-O3" "-DCMAKE_CXX_FLAGS=-O3")

emcmake cmake -S "$work/zlib" -B "$work/zlib/build" "${common[@]}" -DZLIB_BUILD_EXAMPLES=OFF
cmake --build "$work/zlib/build" --target zlibstatic
install -D "$work/zlib/build/libz.a" "$prefix/lib/libz.a"
install -D "$work/zlib/zlib.h" "$prefix/include/zlib.h"
install -D "$work/zlib/build/zconf.h" "$prefix/include/zconf.h"

emcmake cmake -S "$work/libjpeg-turbo" -B "$work/libjpeg-turbo/build" "${common[@]}" \
  -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DWITH_SIMD=OFF -DWITH_TURBOJPEG=OFF \
  -DWITH_TOOLS=OFF -DWITH_TESTS=OFF
cmake --build "$work/libjpeg-turbo/build" --target jpeg-static
install -D "$work/libjpeg-turbo/build/libjpeg.a" "$prefix/lib/libjpeg.a"
for h in jpeglib.h jmorecfg.h jerror.h; do install -D "$work/libjpeg-turbo/src/$h" "$prefix/include/$h" 2>/dev/null \
  || install -D "$work/libjpeg-turbo/$h" "$prefix/include/$h"; done
install -D "$work/libjpeg-turbo/build/jconfig.h" "$prefix/include/jconfig.h"

# MEMFS in and out, called once per module instance (the wrapper instantiates a fresh
# instance per job from one compiled WebAssembly.Module, so no state leaks between jobs).
link_flags=(-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createQpdf -sINVOKE_RUN=0
  -sEXIT_RUNTIME=0 -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB
  -sSTACK_SIZE=1MB -sENVIRONMENT=web,worker -sEXPORTED_RUNTIME_METHODS=callMain,FS
  -sFILESYSTEM=1 -sDISABLE_EXCEPTION_CATCHING=0 -fexceptions)

emcmake cmake -S "$work/qpdf" -B "$work/qpdf/build" "${common[@]}" \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON -DBUILD_DOC=OFF \
  -DUSE_IMPLICIT_CRYPTO=OFF -DREQUIRE_CRYPTO_NATIVE=ON -DINSTALL_EXAMPLES=OFF \
  "-DZLIB_H_PATH=$prefix/include" "-DZLIB_LIB_PATH=$prefix/lib/libz.a" \
  "-DLIBJPEG_H_PATH=$prefix/include" "-DLIBJPEG_LIB_PATH=$prefix/lib/libjpeg.a" \
  "-DCMAKE_CXX_FLAGS=-O3 -fexceptions" \
  "-DCMAKE_EXE_LINKER_FLAGS=${link_flags[*]}"
cmake --build "$work/qpdf/build" --target qpdf

built="$work/qpdf/build/qpdf"
cp "$built/qpdf.js" "$out/qpdf.mjs"
cp "$built/qpdf.wasm" "$out/qpdf.wasm"
{
  echo "qpdf $QPDF_TAG, zlib $ZLIB_TAG, libjpeg-turbo $LIBJPEG_TURBO_TAG"
  emcc --version | head -1
  sha256sum "$out/qpdf.mjs" "$out/qpdf.wasm" | sed "s#$out/##"
} > "$out/BUILD-INFO.txt"
cat "$out/BUILD-INFO.txt"
