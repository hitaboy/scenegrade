# SPDX-License-Identifier: Apache-2.0
#
# Builds OpenEXRCore (+ vendored libdeflate and OpenJPH, fetched Imath headers)
# and links the scenegrade wrapper into an ES module + .wasm with Emscripten.
# Invoked by ../scripts/build-wasm.sh inside the emscripten/emsdk container.

cmake_minimum_required(VERSION 3.16)
project(scenegrade_exr_wasm C CXX)

set(OPENEXR_SOURCE_DIR "" CACHE PATH "Path to the OpenEXR source tree")
if(NOT EXISTS "${OPENEXR_SOURCE_DIR}/src/lib/OpenEXRCore/openexr.h")
  message(FATAL_ERROR "OPENEXR_SOURCE_DIR does not point to an OpenEXR checkout")
endif()

# --- OpenEXR configuration: only the Core C library, no threads ------------
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPENEXR_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(OPENEXR_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(OPENEXR_BUILD_PYTHON OFF CACHE BOOL "" FORCE)
set(OPENEXR_INSTALL OFF CACHE BOOL "" FORCE)
set(OPENEXR_INSTALL_TOOLS OFF CACHE BOOL "" FORCE)
set(OPENEXR_INSTALL_PKG_CONFIG OFF CACHE BOOL "" FORCE)
set(OPENEXR_ENABLE_THREADING OFF CACHE BOOL "" FORCE)
set(OPENEXR_FORCE_INTERNAL_DEFLATE ON CACHE BOOL "" FORCE)
set(OPENEXR_FORCE_INTERNAL_OPENJPH ON CACHE BOOL "" FORCE)
set(OPENEXR_FORCE_INTERNAL_IMATH ON CACHE BOOL "" FORCE)
set(IMATH_INSTALL OFF CACHE BOOL "" FORCE)
set(IMATH_INSTALL_PKG_CONFIG OFF CACHE BOOL "" FORCE)
set(OJPH_BUILD_EXECUTABLES OFF CACHE BOOL "" FORCE)
set(OJPH_ENABLE_TIFF_SUPPORT OFF CACHE BOOL "" FORCE)

# Emscripten's toolchain reports CMAKE_SYSTEM_PROCESSOR=x86, which makes
# OpenEXR add "-msse2 -mfpmath=sse" (unsupported by wasm clang).
set(CMAKE_SYSTEM_PROCESSOR wasm32)

add_subdirectory("${OPENEXR_SOURCE_DIR}" openexr EXCLUDE_FROM_ALL)

# --- the wasm module ---------------------------------------------------------
add_executable(openexr_wasm exr_wrapper.c)
target_link_libraries(openexr_wasm PRIVATE OpenEXRCore)
set_target_properties(openexr_wasm PROPERTIES
  OUTPUT_NAME "openexr"
  SUFFIX ".mjs"
  LINKER_LANGUAGE CXX)

set(EXRW_EXPORTS
  "_malloc,_free,_exrw_open,_exrw_close,_exrw_header_json,_exrw_decode,_exrw_result_ptr,_exrw_result_size,_exrw_result_failed_chunks,_exrw_free_result,_exrw_last_error")

target_link_options(openexr_wasm PRIVATE
  "-O3"
  "-msimd128"
  "-fwasm-exceptions"
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sEXPORT_NAME=createOpenEXRModule"
  "-sENVIRONMENT=web,worker,node"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sINITIAL_MEMORY=64MB"
  "-sMAXIMUM_MEMORY=4GB"
  "-sSTACK_SIZE=1MB"
  "-sFILESYSTEM=0"
  "-sEXPORTED_FUNCTIONS=${EXRW_EXPORTS}"
  "-sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8"
  "-sINCOMING_MODULE_JS_API=wasmBinary,locateFile,instantiateWasm,print,printErr"
)
