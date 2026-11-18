# SPDX-License-Identifier: Apache-2.0
"""
Generate synthetic scene-linear ACEScg OpenEXR test media for scenelinear.

Run from the repository root:

    uv run --python 3.12 --with OpenEXR --with numpy python tools/test-media/make_exr.py

Output: apps/demo/public/media/generated/exr/ (git-ignored) plus a
manifest.json describing every file and a set of known pixel samples
(output-buffer coordinates, i.e. relative to the data window, row 0 = yMin)
that packages/exr-wasm/test uses to validate decoding.

Notes on what the OpenEXR Python bindings (3.5.x) cannot write:
  * subsampled channels (Y/RY/BY): written by the tiny raw writer below
    (`write_raw_scanline_none`), uncompressed;
  * mipmapped / ripmapped tiled files: the bindings only write level 0 and
    produce a broken file, so no mip test file is generated.
"""

from __future__ import annotations

import argparse
import fractions
import json
import os
import struct
import sys
from pathlib import Path

import numpy as np
import OpenEXR

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "apps" / "demo" / "public" / "media" / "generated" / "exr"

# ACEScg (AP1 primaries, ACES white ~D60)
AP1_CHROMATICITIES = (0.713, 0.293, 0.165, 0.830, 0.128, 0.044, 0.32168, 0.33767)

COMPRESSIONS = [
    ("NONE", OpenEXR.NO_COMPRESSION, True),
    ("RLE", OpenEXR.RLE_COMPRESSION, True),
    ("ZIPS", OpenEXR.ZIPS_COMPRESSION, True),
    ("ZIP", OpenEXR.ZIP_COMPRESSION, True),
    ("PIZ", OpenEXR.PIZ_COMPRESSION, True),
    ("PXR24", OpenEXR.PXR24_COMPRESSION, True),  # lossless for half data
    ("B44", OpenEXR.B44_COMPRESSION, False),
    ("B44A", OpenEXR.B44A_COMPRESSION, False),
    ("DWAA", OpenEXR.DWAA_COMPRESSION, False),
    ("DWAB", OpenEXR.DWAB_COMPRESSION, False),
    ("HTJ2K256", OpenEXR.HTJ2K256_COMPRESSION, True),
    ("HTJ2K32", OpenEXR.HTJ2K32_COMPRESSION, True),
]

# Tolerances used by the tests (relative, absolute) per compression family.
TOL_LOSSLESS = (0.0, 0.0)
TOL_LOSSY = {"B44": (0.002, 1e-4), "B44A": (0.002, 1e-4), "DWAA": (0.03, 2e-3), "DWAB": (0.03, 2e-3)}
TOL_FLOAT_TO_HALF = (1e-3, 1e-7)


# --------------------------------------------------------------------------- helpers


def h(v) -> np.ndarray:
    return np.asarray(v, dtype=np.float32).astype(np.float16)


def enc(v: float):
    """JSON-safe float."""
    v = float(v)
    if np.isnan(v):
        return "NaN"
    if np.isinf(v):
        return "Inf" if v > 0 else "-Inf"
    return v


def base_header(compression, extra=None):
    hdr = {
        "compression": compression,
        "type": OpenEXR.scanlineimage,
        "chromaticities": AP1_CHROMATICITIES,
        "owner": "scenelinear synthetic test media (Apache-2.0)",
    }
    if extra:
        hdr.update(extra)
    return hdr


def samples_from(planes: dict, mapping, coords, part=0, layer=""):
    """Build expected samples by reading the written arrays.

    planes: channel name -> 2D array (as written)
    mapping: [r, g, b, a] channel names or None (a None -> 1.0, rgb None -> 0.0)
    """
    out = []
    for x, y in coords:
        rgba = []
        for i, name in enumerate(mapping):
            if name is None:
                rgba.append(1.0 if i == 3 else 0.0)
            else:
                rgba.append(enc(planes[name][y, x]))
        out.append({"part": part, "layer": layer, "x": int(x), "y": int(y), "rgba": rgba})
    return out


# --------------------------------------------------------------------------- 5x7 digits

DIGITS = {
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
}


def draw_text(img: np.ndarray, text: str, x0: int, y0: int, scale: int, value, bg=None):
    """Draw digits into img (H, W, C) in place. Returns one (x, y) sample point per glyph."""
    gw, gh, gap = 5 * scale, 7 * scale, scale
    if bg is not None:
        img[y0 - scale : y0 + gh + scale, x0 - scale : x0 + len(text) * (gw + gap) + scale] = bg
    on = []
    for i, ch in enumerate(text):
        glyph = DIGITS[ch]
        gx = x0 + i * (gw + gap)
        for r, row in enumerate(glyph):
            for c, bit in enumerate(row):
                if bit == "1":
                    img[y0 + r * scale : y0 + (r + 1) * scale, gx + c * scale : gx + (c + 1) * scale] = value
        # sample point at the glyph centre (lit or not, the manifest records the value)
        on.append((gx + 2 * scale + scale // 2, y0 + 3 * scale + scale // 2))
    return on


# --------------------------------------------------------------------------- chart


def make_chart(w=1920, h_=1080):
    """Colour / exposure chart in ACEScg, float32 (H, W, 3). Returns (img, sample coords)."""
    img = np.full((h_, w, 3), 0.05, dtype=np.float32)
    coords = []

    # band A: 17 grey patches, 0.18 * 2^k, k = -8..+8
    ya0, ya1 = 0, int(h_ * 0.30)
    pw = w // 17
    xo = (w - 17 * pw) // 2
    for i, k in enumerate(range(-8, 9)):
        v = 0.18 * 2.0**k
        x0 = xo + i * pw
        img[ya0 + 8 : ya1 - 8, x0 + 4 : x0 + pw - 4] = v
        coords.append((x0 + pw // 2, (ya0 + ya1) // 2))

    # band B: continuous log ramp -8..+8 stops around 0.18
    yb0, yb1 = ya1, int(h_ * 0.42)
    x = np.arange(w, dtype=np.float32)
    ramp = 0.18 * np.power(2.0, -8.0 + 16.0 * x / (w - 1))
    img[yb0:yb1, :, :] = ramp[None, :, None]
    coords.append((w // 2, (yb0 + yb1) // 2))

    # band C: saturated primaries / secondaries at 1.0 and 4.0 (values > 1)
    yc0, yc1 = yb1, int(h_ * 0.70)
    cols = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (0, 1, 1), (1, 0, 1), (1, 1, 0)]
    pw = w // 12
    for i, (c, s) in enumerate([(c, s) for s in (1.0, 4.0) for c in cols]):
        x0 = i * pw
        img[yc0 + 8 : yc1 - 8, x0 + 4 : x0 + pw - 4] = np.array(c, dtype=np.float32) * s
        coords.append((x0 + pw // 2, (yc0 + yc1) // 2))

    # band D: highlights + a few "memory" colours
    yd0, yd1 = yc1, h_
    vals = [
        (1.0, 1.0, 1.0),
        (2.0, 2.0, 2.0),
        (8.0, 8.0, 8.0),
        (16.0, 16.0, 16.0),
        (64.0, 64.0, 64.0),
        (256.0, 256.0, 256.0),
        (1000.0, 1000.0, 1000.0),
        (10000.0, 10000.0, 10000.0),
        (0.40, 0.25, 0.18),  # skin-ish
        (0.10, 0.20, 0.45),  # sky-ish
        (0.08, 0.18, 0.06),  # foliage-ish
        (0.18, 0.18, 0.18),  # mid grey
    ]
    pw = w // len(vals)
    for i, v in enumerate(vals):
        x0 = i * pw
        img[yd0 + 8 : yd1 - 8, x0 + 4 : x0 + pw - 4] = v
        coords.append((x0 + pw // 2, (yd0 + yd1) // 2))

    return img, coords


def rgb_planes(img: np.ndarray, dtype=np.float16):
    return {
        "R": np.ascontiguousarray(img[..., 0]).astype(dtype),
        "G": np.ascontiguousarray(img[..., 1]).astype(dtype),
        "B": np.ascontiguousarray(img[..., 2]).astype(dtype),
    }


# --------------------------------------------------------------------------- raw writer


def write_raw_scanline_none(path: Path, width, height, channels, attrs_extra=b""):
    """Minimal uncompressed single-part scanline writer supporting subsampling.

    channels: list of (name, np.float16 2D array of the *sampled* size, xs, ys)
    """

    def attr(name: str, typ: str, data: bytes) -> bytes:
        return name.encode() + b"\0" + typ.encode() + b"\0" + struct.pack("<i", len(data)) + data

    channels = sorted(channels, key=lambda c: c[0])
    chl = b""
    for name, _arr, xs, ys in channels:
        chl += name.encode() + b"\0" + struct.pack("<iB3xii", 1, 0, xs, ys)  # HALF
    chl += b"\0"
    box = struct.pack("<iiii", 0, 0, width - 1, height - 1)
    hdr = b""
    hdr += attr("channels", "chlist", chl)
    hdr += attr("compression", "compression", b"\0")
    hdr += attr("dataWindow", "box2i", box)
    hdr += attr("displayWindow", "box2i", box)
    hdr += attr("lineOrder", "lineOrder", b"\0")
    hdr += attr("pixelAspectRatio", "float", struct.pack("<f", 1.0))
    hdr += attr("screenWindowCenter", "v2f", struct.pack("<ff", 0, 0))
    hdr += attr("screenWindowWidth", "float", struct.pack("<f", 1.0))
    hdr += attr("chromaticities", "chromaticities", struct.pack("<8f", *AP1_CHROMATICITIES))
    hdr += attrs_extra
    hdr += b"\0"
    magic = struct.pack("<ii", 20000630, 2)
    table_pos = len(magic) + len(hdr)
    chunks = []
    for y in range(height):
        data = b""
        for _name, arr, xs, ys in channels:
            if y % ys:
                continue
            data += arr[y // ys].astype("<f2").tobytes()
        chunks.append(struct.pack("<ii", y, len(data)) + data)
    offsets = []
    pos = table_pos + 8 * height
    for c in chunks:
        offsets.append(pos)
        pos += len(c)
    with open(path, "wb") as f:
        f.write(magic + hdr + struct.pack(f"<{height}Q", *offsets) + b"".join(chunks))


# --------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--no-seq", action="store_true", help="skip the 48-frame sequence")
    args = ap.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    manifest = {"generator": "tools/test-media/make_exr.py", "files": []}

    def add(entry):
        manifest["files"].append(entry)
        print(f"  {entry['path']:<36} {(out / entry['path']).stat().st_size / 1e6:8.2f} MB")

    print(f"writing to {out}")
    chart, chart_coords = make_chart()
    H, W = chart.shape[:2]
    planes = rgb_planes(chart)

    # (1) + (2): the chart in every compression
    for name, comp, lossless in COMPRESSIONS:
        fn = f"chart_{name.lower()}.exr"
        hdr = base_header(comp, {"comments": f"colour/exposure chart, {name}"})
        OpenEXR.File(hdr, dict(planes)).write(str(out / fn))
        tol = TOL_LOSSLESS if lossless else TOL_LOSSY[name]
        add(
            {
                "path": fn,
                "kind": "chart",
                "compression": name,
                "lossless": lossless,
                "referenceGroup": "chart_half" if lossless else None,
                "tolRel": tol[0],
                "tolAbs": tol[1],
                "width": W,
                "height": H,
                "channels": ["B", "G", "R"],
                "chromaticities": list(AP1_CHROMATICITIES),
                "samples": samples_from(planes, ["R", "G", "B", None], chart_coords),
            }
        )

    # float32 variants (float -> half conversion in the decoder)
    fplanes = rgb_planes(chart, np.float32)
    for name, comp in (("ZIP", OpenEXR.ZIP_COMPRESSION), ("PXR24", OpenEXR.PXR24_COMPRESSION)):
        fn = f"chart_float_{name.lower()}.exr"
        OpenEXR.File(base_header(comp), dict(fplanes)).write(str(out / fn))
        add(
            {
                "path": fn,
                "kind": "chart-float",
                "compression": name,
                "lossless": name == "ZIP",
                "tolRel": TOL_FLOAT_TO_HALF[0] if name == "ZIP" else 2e-3,
                "tolAbs": TOL_FLOAT_TO_HALF[1],
                "width": W,
                "height": H,
                "samples": samples_from(fplanes, ["R", "G", "B", None], chart_coords),
            }
        )

    # (3) multi-layer AOV file
    w3, h3 = 960, 540
    small = chart[::2, ::2]
    yy, xx = np.mgrid[0:h3, 0:w3].astype(np.float32)
    alpha = (((xx - w3 / 2) / (w3 * 0.45)) ** 2 + ((yy - h3 / 2) / (h3 * 0.45)) ** 2 <= 1.0).astype(np.float32)
    beauty = small * alpha[..., None]
    ml = {
        "R": beauty[..., 0].astype(np.float16),
        "G": beauty[..., 1].astype(np.float16),
        "B": beauty[..., 2].astype(np.float16),
        "A": alpha.astype(np.float16),
        "diffuse.R": (beauty[..., 0] * 0.6).astype(np.float16),
        "diffuse.G": (beauty[..., 1] * 0.6).astype(np.float16),
        "diffuse.B": (beauty[..., 2] * 0.6).astype(np.float16),
        "specular.R": (beauty[..., 0] * 0.4).astype(np.float16),
        "specular.G": (beauty[..., 1] * 0.4).astype(np.float16),
        "specular.B": (beauty[..., 2] * 0.4).astype(np.float16),
        "lights.key.R": (beauty[..., 0] * 0.25).astype(np.float16),
        "lights.key.G": (beauty[..., 1] * 0.25).astype(np.float16),
        "lights.key.B": (beauty[..., 2] * 0.25).astype(np.float16),
        "N.X": ((xx / (w3 - 1)) * 2 - 1).astype(np.float16),
        "N.Y": ((yy / (h3 - 1)) * 2 - 1).astype(np.float16),
        "N.Z": np.full((h3, w3), 0.5, np.float16),
        "Z": (1.0 + yy / (h3 - 1) * 99.0 + xx * 1e-3).astype(np.float32),
        "objectId": ((xx // 96).astype(np.uint32) + 10 * (yy // 108).astype(np.uint32)),
    }
    fn = "multilayer.exr"
    OpenEXR.File(base_header(OpenEXR.ZIP_COMPRESSION), dict(ml)).write(str(out / fn))
    mc = [(w3 // 2, h3 // 2), (100, 270), (480, 100), (w3 // 2 + 37, h3 // 2 + 11)]
    add(
        {
            "path": fn,
            "kind": "multilayer",
            "compression": "ZIP",
            "lossless": True,
            "tolRel": 1e-3,
            "tolAbs": 1e-6,
            "width": w3,
            "height": h3,
            "expectedLayers": {
                "": ["R", "G", "B", "A"],
                "diffuse": ["diffuse.R", "diffuse.G", "diffuse.B", None],
                "specular": ["specular.R", "specular.G", "specular.B", None],
                "lights.key": ["lights.key.R", "lights.key.G", "lights.key.B", None],
                "N": ["N.X", "N.Y", "N.Z", None],
                "Z": ["Z", "Z", "Z", None],
                "objectId": ["objectId", "objectId", "objectId", None],
            },
            "samples": samples_from(ml, ["R", "G", "B", "A"], mc)
            + samples_from(ml, ["diffuse.R", "diffuse.G", "diffuse.B", None], mc, layer="diffuse")
            + samples_from(ml, ["specular.R", "specular.G", "specular.B", None], mc, layer="specular")
            + samples_from(ml, ["lights.key.R", "lights.key.G", "lights.key.B", None], mc, layer="lights.key")
            + samples_from(ml, ["N.X", "N.Y", "N.Z", None], mc, layer="N")
            + samples_from(ml, ["Z", "Z", "Z", None], mc, layer="Z")
            + samples_from(
                {"objectId": ml["objectId"].astype(np.float32)},
                ["objectId", "objectId", "objectId", None],
                mc,
                layer="objectId",
            ),
        }
    )

    # (4) multipart: beauty (scanline ZIP), depth (scanline PIZ, cropped dw), spec (tiled DWAB)
    p0 = {k: ml[k] for k in ("R", "G", "B", "A")}
    dwz = ((100, 50), (859, 489))
    zc = ml["Z"][50:490, 100:860].copy()
    p1 = {"Z": zc}
    p2 = {"specular.R": ml["specular.R"], "specular.G": ml["specular.G"], "specular.B": ml["specular.B"]}
    td = OpenEXR.TileDescription()
    td.xSize, td.ySize, td.mode = 64, 64, OpenEXR.ONE_LEVEL
    parts = [
        OpenEXR.Part(base_header(OpenEXR.ZIP_COMPRESSION), dict(p0), "beauty"),
        OpenEXR.Part(
            base_header(
                OpenEXR.PIZ_COMPRESSION,
                {"dataWindow": dwz, "displayWindow": ((0, 0), (w3 - 1, h3 - 1))},
            ),
            dict(p1),
            "depth",
        ),
        OpenEXR.Part(
            base_header(OpenEXR.ZIP_COMPRESSION, {"type": OpenEXR.tiledimage, "tiles": td}),
            dict(p2),
            "spec",
        ),
    ]
    fn = "multipart.exr"
    OpenEXR.File(parts).write(str(out / fn))
    add(
        {
            "path": fn,
            "kind": "multipart",
            "lossless": True,
            "tolRel": 1e-3,
            "tolAbs": 1e-6,
            "parts": [
                {"name": "beauty", "type": "scanline", "compression": "ZIP", "width": w3, "height": h3},
                {"name": "depth", "type": "scanline", "compression": "PIZ", "width": 760, "height": 440,
                 "dataWindow": {"xMin": 100, "yMin": 50, "xMax": 859, "yMax": 489}},
                {"name": "spec", "type": "tiled", "compression": "ZIP", "width": w3, "height": h3},
            ],
            "samples": samples_from(p0, ["R", "G", "B", "A"], mc, part=0)
            + samples_from(p1, ["Z", "Z", "Z", None], [(10, 10), (380, 220), (759, 439)], part=1, layer="Z")
            + samples_from(p2, ["specular.R", "specular.G", "specular.B", None], mc, part=2, layer="specular"),
        }
    )

    # (5) tiled files (1080 is not a multiple of 64 -> partial edge tiles)
    alpha_ramp = np.tile(np.linspace(0, 1, W, dtype=np.float32), (H, 1))
    tplanes = dict(planes)
    tplanes["A"] = alpha_ramp.astype(np.float16)
    tcoords = chart_coords + [(W - 1, H - 1), (0, 0), (1919, 1079 - 13)]
    for comp_name, comp, tsize, lossless in (
        ("ZIP", OpenEXR.ZIP_COMPRESSION, 64, True),
        ("PIZ", OpenEXR.PIZ_COMPRESSION, 128, True),
        ("DWAA", OpenEXR.DWAA_COMPRESSION, 256, False),
    ):
        td = OpenEXR.TileDescription()
        td.xSize, td.ySize, td.mode = tsize, tsize, OpenEXR.ONE_LEVEL
        fn = f"tiled_{comp_name.lower()}_{tsize}.exr"
        OpenEXR.File(base_header(comp, {"type": OpenEXR.tiledimage, "tiles": td}), dict(tplanes)).write(str(out / fn))
        tol = TOL_LOSSLESS if lossless else TOL_LOSSY[comp_name]
        add(
            {
                "path": fn,
                "kind": "tiled",
                "compression": comp_name,
                "lossless": lossless,
                "referenceGroup": "tiled_rgba" if lossless else None,
                "tolRel": tol[0],
                "tolAbs": tol[1],
                "width": W,
                "height": H,
                "tileSize": tsize,
                # lossy: only check flat patch centres
                "samples": samples_from(tplanes, ["R", "G", "B", "A"], tcoords if lossless else chart_coords),
            }
        )

    # (7) NaN / Inf / negative values
    specials = [np.nan, np.inf, -np.inf, -1.0, -0.001, 65504.0, 2.0**-24, 0.0, -0.0, -100.0, 0.18, 1e5]
    w7, h7 = 64 * len(specials), 64
    nimg = np.zeros((h7, w7), np.float32)
    for i, v in enumerate(specials):
        nimg[:, i * 64 : (i + 1) * 64] = v
    ncoords = [(i * 64 + 32, 32) for i in range(len(specials))]
    for dt_name, dt in (("half", np.float16), ("float", np.float32)):
        with np.errstate(over="ignore", invalid="ignore"):  # 1e5 -> +Inf in half is intended
            np_ = {"R": nimg.astype(dt), "G": (-nimg).astype(dt), "B": np.full((h7, w7), -0.5, dt)}
        fn = f"nan_inf_{dt_name}.exr"
        OpenEXR.File(base_header(OpenEXR.ZIP_COMPRESSION), dict(np_)).write(str(out / fn))
        add(
            {
                "path": fn,
                "kind": "nan-inf",
                "compression": "ZIP",
                "lossless": True,
                "tolRel": 0.0 if dt_name == "half" else 1e-3,
                "tolAbs": 0.0 if dt_name == "half" else 1e-7,
                "pixelType": dt_name,
                "width": w7,
                "height": h7,
                # expected values in the file's own precision (float32 test uses format:'float')
                "samples": samples_from(np_, ["R", "G", "B", None], ncoords),
            }
        )

    # (8a) crop: data window inside the display window, with alpha
    dw8 = ((480, 270), (1439, 809))
    w8, h8 = 960, 540
    yy8, xx8 = np.mgrid[0:h8, 0:w8].astype(np.float32)
    a8 = np.clip(1.0 - np.hypot(xx8 - w8 / 2, yy8 - h8 / 2) / (h8 / 2), 0, 1)
    crop = chart[270:810, 480:1440] * a8[..., None]
    cp = rgb_planes(crop)
    cp["A"] = a8.astype(np.float16)
    fn = "crop_alpha.exr"
    OpenEXR.File(
        base_header(OpenEXR.ZIP_COMPRESSION, {"dataWindow": dw8, "displayWindow": ((0, 0), (1919, 1079))}),
        dict(cp),
    ).write(str(out / fn))
    cc = [(480, 270), (0, 0), (959, 539), (600, 300), (200, 100)]
    add(
        {
            "path": fn,
            "kind": "crop",
            "compression": "ZIP",
            "lossless": True,
            "tolRel": 0.0,
            "tolAbs": 0.0,
            "width": w8,
            "height": h8,
            "dataWindow": {"xMin": 480, "yMin": 270, "xMax": 1439, "yMax": 809},
            "displayWindow": {"xMin": 0, "yMin": 0, "xMax": 1919, "yMax": 1079},
            "samples": samples_from(cp, ["R", "G", "B", "A"], cc),
        }
    )

    # (8b) overscan: data window larger than the display window, negative origin
    ow, oh = W + 128, H + 72
    over = np.full((oh, ow, 3), 0.02, np.float32)
    over[36 : 36 + H, 64 : 64 + W] = chart
    over[:36, :] = (0.5, 0.0, 0.0)  # red top overscan strip
    op = rgb_planes(over)
    fn = "overscan.exr"
    OpenEXR.File(
        base_header(
            OpenEXR.PIZ_COMPRESSION,
            {"dataWindow": ((-64, -36), (W + 63, H + 35)), "displayWindow": ((0, 0), (W - 1, H - 1))},
        ),
        dict(op),
    ).write(str(out / fn))
    oc = [(0, 0), (10, 10), (64, 36), (ow - 1, oh - 1)] + [(x + 64, y + 36) for x, y in chart_coords[:5]]
    add(
        {
            "path": fn,
            "kind": "overscan",
            "compression": "PIZ",
            "lossless": True,
            "tolRel": 0.0,
            "tolAbs": 0.0,
            "width": ow,
            "height": oh,
            "dataWindow": {"xMin": -64, "yMin": -36, "xMax": W + 63, "yMax": H + 35},
            "displayWindow": {"xMin": 0, "yMin": 0, "xMax": W - 1, "yMax": H - 1},
            "samples": samples_from(op, ["R", "G", "B", None], oc),
        }
    )

    # luminance / chroma with 2x2 subsampled RY, BY (raw writer, NONE)
    lw, lh = 256, 128
    Y = np.tile(np.linspace(0, 2, lw, dtype=np.float32), (lh, 1)).astype(np.float16)
    sy, sx = np.mgrid[0 : lh // 2, 0 : lw // 2]
    RY = np.where((sx + sy) % 2 == 0, 0.25, -0.25).astype(np.float16)
    BY = (sx / (lw // 2 - 1)).astype(np.float16)
    fn = "luma_chroma.exr"
    write_raw_scanline_none(out / fn, lw, lh, [("Y", Y, 1, 1), ("RY", RY, 2, 2), ("BY", BY, 2, 2)])
    lc = [(0, 0), (1, 1), (2, 0), (3, 1), (100, 50), (255, 127)]
    up = lambda a: np.repeat(np.repeat(a, 2, axis=0), 2, axis=1)  # noqa: E731
    lp = {"Y": Y, "RY": up(RY), "BY": up(BY)}
    add(
        {
            "path": fn,
            "kind": "luma-chroma",
            "compression": "NONE",
            "lossless": True,
            "tolRel": 0.0,
            "tolAbs": 0.0,
            "width": lw,
            "height": lh,
            "samples": samples_from(lp, ["Y", "Y", "Y", None], lc)
            + samples_from(lp, ["RY", "RY", "RY", None], lc, layer="RY")
            + samples_from(lp, ["BY", "BY", "BY", None], lc, layer="BY"),
        }
    )

    # deep scanline (must be reported as unsupported)
    dwd = ((0, 0), (15, 15))
    Zd = np.empty((16, 16), dtype=object)
    for yy_ in range(16):
        for xx_ in range(16):
            Zd[yy_, xx_] = np.array([1.0 + xx_, 2.0 + yy_][: 1 + (xx_ + yy_) % 2], dtype=np.float32)
    fn = "deep.exr"
    OpenEXR.File(
        {"compression": OpenEXR.ZIPS_COMPRESSION, "type": OpenEXR.deepscanline, "dataWindow": dwd},
        {"Z": Zd},
    ).write(str(out / fn))
    add({"path": fn, "kind": "deep", "width": 16, "height": 16, "samples": []})

    # benchmark plates: the chart with photographic-like grain and texture, so that
    # compressed sizes / decode times are representative (flat synthetic charts
    # compress unrealistically well)
    rng = np.random.default_rng(1234)
    yyb, xxb = np.mgrid[0:H, 0:W].astype(np.float32)
    texture = 1.0 + 0.15 * np.sin(xxb / 37.0) * np.cos(yyb / 23.0)
    grain = rng.normal(1.0, 0.03, size=(H, W, 3)).astype(np.float32)
    bimg = chart * texture[..., None] * grain
    bplanes = rgb_planes(bimg)
    bplanes["A"] = np.ones((H, W), np.float16)
    for name, comp in (
        ("ZIP", OpenEXR.ZIP_COMPRESSION),
        ("PIZ", OpenEXR.PIZ_COMPRESSION),
        ("DWAA", OpenEXR.DWAA_COMPRESSION),
        ("DWAB", OpenEXR.DWAB_COMPRESSION),
        ("HTJ2K256", OpenEXR.HTJ2K256_COMPRESSION),
    ):
        fn = f"bench_{name.lower()}.exr"
        OpenEXR.File(base_header(comp), dict(bplanes)).write(str(out / fn))
        add({"path": fn, "kind": "bench", "compression": name, "width": W, "height": H, "samples": []})

    # (6) 48-frame sequence with a moving square and burnt-in frame number
    if not args.no_seq:
        (out / "seq").mkdir(exist_ok=True)
        seq_entries = []
        for frame in range(1001, 1049):
            img = chart.copy()
            sx0 = 40 + (frame - 1001) * 36
            sy0 = int(H * 0.70) + 40
            img[sy0 : sy0 + 120, sx0 : sx0 + 120] = (1.0, 0.5, 0.1)
            on = draw_text(img, str(frame), W - 4 * 72 - 40, 40, 12, (1.0, 1.0, 1.0), bg=(0.0, 0.0, 0.0))
            sp = rgb_planes(img)
            fn = f"seq/chart.{frame}.exr"
            hdr = base_header(
                OpenEXR.PIZ_COMPRESSION,
                {"framesPerSecond": fractions.Fraction(24, 1), "comments": f"frame {frame}"},
            )
            OpenEXR.File(hdr, dict(sp)).write(str(out / fn))
            coords = [(sx0 + 60, sy0 + 60), (W - 4 * 72 - 40 - 6, 40 + 42)] + on
            seq_entries.append(
                {
                    "path": fn,
                    "frame": frame,
                    "samples": samples_from(sp, ["R", "G", "B", None], coords),
                }
            )
        manifest["sequence"] = {
            "pattern": "seq/chart.####.exr",
            "first": 1001,
            "last": 1048,
            "fps": 24,
            "compression": "PIZ",
            "width": W,
            "height": H,
            "frames": seq_entries,
        }
        total = sum((out / e["path"]).stat().st_size for e in seq_entries)
        print(f"  seq/chart.####.exr (48 frames)      {total / 1e6:8.2f} MB")

    with open(out / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=1)
    print("done")


if __name__ == "__main__":
    sys.exit(main())
