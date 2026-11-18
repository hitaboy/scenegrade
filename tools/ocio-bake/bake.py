#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
scenelinear OCIO bake.

Generates, from the official built-in ACES OCIO studio configs:

  packages/core/src/color/luts/<id>.bin      3D LUTs (ACEScct shaper -> display signal), float16 RGBA
  packages/core/src/color/luts/manifest.json LUT metadata + measured accuracy
  packages/core/src/color/generated.ts       input-space decode stages + matrices extracted from OCIO
  tools/ocio-bake/fixtures/*.json            OCIO ground truth used by the vitest suite

Run (from the repo root):

  uv run --python 3.12 --with opencolorio --with numpy python tools/ocio-bake/bake.py

Options:  --size N (default 49)   --eval-only (no files written, only accuracy report)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import PyOpenColorIO as OCIO

ROOT = Path(__file__).resolve().parents[2]
COLOR_DIR = ROOT / "packages" / "core" / "src" / "color"
LUT_DIR = COLOR_DIR / "luts"
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"

MAIN_CONFIG_URI = "ocio://studio-config-latest"
LEGACY_CONFIG_URI = "ocio://studio-config-v2.2.0_aces-v1.3_ocio-v2.4"

# ---------------------------------------------------------------------------
# ACEScct shaper (LUT input domain). Values are ACEScct code values.
# min: ACEScct 0.0 (= linear -0.0069 in AP1); max: ACEScct(1024), which is where
# the ACES 2.0 SDR output transform clamps its AP0 input anyway (HDR clamps at
# 4096; the 1024..4096 range is visually flat at the tone-scale shoulder).
# ---------------------------------------------------------------------------
CCT_A = 10.5402377416545
CCT_B = 0.0729055341958355


def lin_to_acescct(x):
    x = np.asarray(x, dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        lg = (np.log2(np.maximum(x, 1e-30)) + 9.72) / 17.52
    return np.where(x <= 0.0078125, CCT_A * x + CCT_B, lg)


def acescct_to_lin(y):
    y = np.asarray(y, dtype=np.float64)
    brk = (math.log2(0.0078125) + 9.72) / 17.52
    return np.where(y <= brk, (y - CCT_B) / CCT_A, np.exp2(y * 17.52 - 9.72))


SHAPER_MIN = 0.0  # ACEScct 0.0 == linear -0.0069
SHAPER_MAX = float(lin_to_acescct(1024.0))  # 1.1256...

# ---------------------------------------------------------------------------
# Input spaces (id, label, family, OCIO name, isLog)
# ---------------------------------------------------------------------------
INPUT_SPACES = [
    ("acescg", "ACEScg", "ACES", "ACEScg", False),
    ("aces2065-1", "ACES2065-1", "ACES", "ACES2065-1", False),
    ("acescct", "ACEScct", "ACES", "ACEScct", True),
    ("acescc", "ACEScc", "ACES", "ACEScc", True),
    ("lin-rec709", "Linear Rec.709 (sRGB)", "Scene-linear", "Linear Rec.709 (sRGB)", False),
    ("lin-p3d65", "Linear P3-D65", "Scene-linear", "Linear P3-D65", False),
    ("lin-rec2020", "Linear Rec.2020", "Scene-linear", "Linear Rec.2020", False),
    ("srgb", "sRGB (Rec.709, sRGB transfer)", "Display", "sRGB Encoded Rec.709 (sRGB)", False),
    ("rec709", "Rec.709 (BT.1886 gamma 2.4)", "Display", "Gamma 2.4 Encoded Rec.709", False),
    ("rec709-camera", "Rec.709 camera OETF", "Display", "Camera Rec.709", False),
    ("gamma22-rec709", "Gamma 2.2 Rec.709", "Display", "Gamma 2.2 Encoded Rec.709", False),
    ("display-p3", "Display P3 (sRGB transfer, P3-D65)", "Display", "sRGB Encoded P3-D65", False),
    ("arri-logc3-ei800", "ARRI LogC3 (EI800) / AWG3", "Camera log", "ARRI LogC3 (EI800)", True),
    ("arri-logc4", "ARRI LogC4 / AWG4", "Camera log", "ARRI LogC4", True),
    ("sony-slog3-sgamut3", "Sony S-Log3 / S-Gamut3", "Camera log", "S-Log3 S-Gamut3", True),
    ("sony-slog3-sgamut3cine", "Sony S-Log3 / S-Gamut3.Cine", "Camera log", "S-Log3 S-Gamut3.Cine", True),
    ("sony-slog3-venice-sgamut3", "Sony S-Log3 / Venice S-Gamut3", "Camera log", "S-Log3 Venice S-Gamut3", True),
    ("sony-slog3-venice-sgamut3cine", "Sony S-Log3 / Venice S-Gamut3.Cine", "Camera log", "S-Log3 Venice S-Gamut3.Cine", True),
    ("red-log3g10-rwg", "RED Log3G10 / REDWideGamutRGB", "Camera log", "Log3G10 REDWideGamutRGB", True),
    ("canon-clog2-cgamut", "Canon Log 2 / Cinema Gamut (D55)", "Camera log", "CanonLog2 CinemaGamut D55", True),
    ("canon-clog3-cgamut", "Canon Log 3 / Cinema Gamut (D55)", "Camera log", "CanonLog3 CinemaGamut D55", True),
    ("panasonic-vlog-vgamut", "Panasonic V-Log / V-Gamut", "Camera log", "V-Log V-Gamut", True),
    ("bmd-film-wg-gen5", "Blackmagic Film Gen5 / BMD Wide Gamut Gen5", "Camera log", "BMDFilm WideGamut Gen5", True),
    ("davinci-intermediate-wg", "DaVinci Intermediate / DaVinci Wide Gamut", "Camera log", "DaVinci Intermediate WideGamut", True),
    ("apple-log", "Apple Log / Rec.2020", "Camera log", "Apple Log", True),
    ("apple-log-2", "Apple Log 2 / Apple Wide Gamut", "Camera log", "Apple Log 2", True),
    ("dji-dlog-dgamut", "DJI D-Log / D-Gamut", "Camera log", "D-Log D-Gamut", True),
]

# LUT-based OCIO builtins that we implement with the closed-form curve.
LUT1D_CURVES = {
    "ACEScc": "acescc",
    "Apple Log": "applelog",
    "Apple Log 2": "applelog",
    "CanonLog2 CinemaGamut D55": "clog2",
    "CanonLog3 CinemaGamut D55": "clog3",
}

# ---------------------------------------------------------------------------
# Views. (id, config, display, view, encoding, primaries, hdr, peakNits)
# ---------------------------------------------------------------------------
VIEWS = [
    ("srgb-aces2-sdr709", "main", "sRGB - Display", "ACES 2.0 - SDR 100 nits (Rec.709)", "srgb", "rec709", False, 100),
    ("rec1886-aces2-sdr709", "main", "Rec.1886 Rec.709 - Display", "ACES 2.0 - SDR 100 nits (Rec.709)", "bt1886", "rec709", False, 100),
    ("displayp3-aces2-sdrp3", "main", "Display P3 - Display", "ACES 2.0 - SDR 100 nits (P3 D65)", "srgb", "p3d65", False, 100),
    ("pq-aces2-hdr1000-p3", "main", "Rec.2100-PQ - Display", "ACES 2.0 - HDR 1000 nits (P3 D65)", "pq", "rec2020", True, 1000),
    ("pq-aces2-hdr1000-rec2020", "main", "Rec.2100-PQ - Display", "ACES 2.0 - HDR 1000 nits (Rec.2020)", "pq", "rec2020", True, 1000),
    ("displayp3hdr-aces2-hdr1000-p3", "main", "Display P3 HDR - Display", "ACES 2.0 - HDR 1000 nits (P3 D65)", "srgb", "p3d65", True, 1000),
    ("hlg-aces2-hdr1000-p3", "main", "Rec.2100-HLG - Display", "ACES 2.0 - HDR 1000 nits (P3 D65)", "hlg", "rec2020", True, 1000),
    ("srgb-aces1-sdrvideo", "legacy", "sRGB - Display", "ACES 1.0 - SDR Video", "srgb", "rec709", False, 100),
]

# Analytic views verified against OCIO (no LUT): (id, display, view, encoding, primaries)
ANALYTIC_VIEW_FIXTURES = [
    ("srgb-clamp", "sRGB - Display", "Un-tone-mapped", "srgb", "rec709"),
]

# Linear display decoding for each encoding, checked against OCIO display colourspaces.
DISPLAY_DECODE_FIXTURES = [
    ("srgb", "rec709", "sRGB - Display", "Linear Rec.709 (sRGB)"),
    ("bt1886", "rec709", "Rec.1886 Rec.709 - Display", "Linear Rec.709 (sRGB)"),
    ("gamma22", "rec709", "Gamma 2.2 Rec.709 - Display", "Linear Rec.709 (sRGB)"),
    ("gamma26", "p3d65", "Gamma 2.6 P3-D65 - Display", "Linear P3-D65"),
    ("srgb", "p3d65", "Display P3 HDR - Display", "Linear P3-D65"),
    ("pq", "rec2020", "Rec.2100-PQ - Display", "Linear Rec.2020"),
    ("hlg", "rec2020", "Rec.2100-HLG - Display", "Linear Rec.2020"),
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def load_config(uri: str) -> OCIO.Config:
    return OCIO.Config.CreateFromFile(uri)


def cpu(proc: OCIO.Processor):
    return proc.getOptimizedCPUProcessor(OCIO.OPTIMIZATION_LOSSLESS)


def apply(cpu_proc, rgb: np.ndarray) -> np.ndarray:
    a = np.ascontiguousarray(rgb, dtype=np.float32).copy()
    cpu_proc.applyRGB(a)
    return a.astype(np.float64)


def mat_of(cfg, src, dst) -> np.ndarray:
    """3x3 matrix of a purely linear conversion, measured on basis vectors."""
    p = cpu(cfg.getProcessor(src, dst))
    # Measure in float32 is not precise enough; compose the MatrixTransforms instead.
    g = cfg.getProcessor(src, dst).createGroupTransform()
    m = np.eye(3)
    for t in g:
        if isinstance(t, OCIO.MatrixTransform):
            m = mat3(t) @ m
        else:
            raise RuntimeError(f"non-matrix op in {src}->{dst}: {t}")
    chk = apply(p, np.eye(3)).T
    assert np.allclose(chk, m, atol=1e-6), (src, dst)
    return m


def mat3(t: OCIO.MatrixTransform) -> np.ndarray:
    m = np.array(t.getMatrix(), dtype=np.float64).reshape(4, 4)
    off = np.array(t.getOffset(), dtype=np.float64)
    assert np.allclose(off[:3], 0), "matrix offsets unsupported"
    if t.getDirection() == OCIO.TRANSFORM_DIR_INVERSE:
        m = np.linalg.inv(m)
    return m[:3, :3]


def rgb_to_xyz(prims, white=(0.3127, 0.3290)) -> np.ndarray:
    def xyz(x, y):
        return np.array([x / y, 1.0, (1 - x - y) / y])

    P = np.stack([xyz(*p) for p in prims], axis=1)
    S = np.linalg.solve(P, xyz(*white))
    return P * S


PRIMS = {
    "rec709": [(0.64, 0.33), (0.30, 0.60), (0.15, 0.06)],
    "p3d65": [(0.680, 0.320), (0.265, 0.690), (0.150, 0.060)],
    "rec2020": [(0.708, 0.292), (0.170, 0.797), (0.131, 0.046)],
}
RGB2XYZ = {k: rgb_to_xyz(v) for k, v in PRIMS.items()}
XYZ2RGB = {k: np.linalg.inv(v) for k, v in RGB2XYZ.items()}

# ---------------------------------------------------------------------------
# Input-space stage extraction
# ---------------------------------------------------------------------------


def extract_stages(cfg, ocio_name: str):
    g = cfg.getProcessor(ocio_name, "ACEScg").createGroupTransform()
    ops = list(g)
    stages = []
    i = 0
    special = LUT1D_CURVES.get(ocio_name)
    while i < len(ops):
        t = ops[i]
        if isinstance(t, OCIO.MatrixTransform):
            m = mat3(t)
            if stages and stages[-1]["op"] == "matrix":
                stages[-1]["_m"] = m @ stages[-1]["_m"]
            else:
                stages.append({"op": "matrix", "_m": m})
        elif isinstance(t, OCIO.LogCameraTransform):
            assert t.getDirection() == OCIO.TRANSFORM_DIR_INVERSE
            st = {
                "op": "logcam",
                "base": t.getBase(),
                "logSlope": t.getLogSideSlopeValue()[0],
                "logOffset": t.getLogSideOffsetValue()[0],
                "linSlope": t.getLinSideSlopeValue()[0],
                "linOffset": t.getLinSideOffsetValue()[0],
                "linBreak": t.getLinSideBreakValue()[0],
            }
            if t.isLinearSlopeValueSet():
                st["linearSlope"] = t.getLinearSlopeValue()[0]
            stages.append(st)
        elif isinstance(t, OCIO.ExponentWithLinearTransform):
            assert t.getDirection() == OCIO.TRANSFORM_DIR_FORWARD
            stages.append(
                {
                    "op": "explin",
                    "gamma": t.getGamma()[0],
                    "offset": t.getOffset()[0],
                    "mirror": t.getNegativeStyle() == OCIO.NEGATIVE_MIRROR,
                }
            )
        elif isinstance(t, OCIO.ExponentTransform):
            assert t.getDirection() == OCIO.TRANSFORM_DIR_FORWARD
            style = {
                OCIO.NEGATIVE_PASS_THRU: "pass_thru",
                OCIO.NEGATIVE_MIRROR: "mirror",
                OCIO.NEGATIVE_CLAMP: "clamp",
            }[t.getNegativeStyle()]
            stages.append({"op": "pow", "gamma": t.getValue()[0], "style": style})
        elif isinstance(t, OCIO.RangeTransform):
            if special == "acescc" and not stages:
                # Range [-0.36,1.5]->[0,1] (clamping) followed by the ACEScc LUT.
                assert isinstance(ops[i + 1], OCIO.Lut1DTransform)
                stages.append({"op": "acescc", "min": t.getMinInValue(), "max": t.getMaxInValue()})
                i += 2
                continue
            assert t.hasMinInValue() and not t.hasMaxInValue() and t.getMinInValue() == t.getMinOutValue()
            stages.append({"op": "clampMin", "v": t.getMinInValue()})
        elif isinstance(t, OCIO.Lut1DTransform):
            assert special and special != "acescc", ocio_name
            stages.append({"op": special})
        else:
            raise RuntimeError(f"unsupported op for {ocio_name}: {t}")
        i += 1
    for s in stages:
        if s["op"] == "matrix":
            s["m"] = [float(v) for v in s.pop("_m").reshape(-1)]
    return stages


# Reference implementation of the stage interpreter (mirrored in TypeScript).


def logcam_derived(s):
    b = s["base"]
    lin_at_break = s["linSlope"] * s["linBreak"] + s["linOffset"]
    log_break = s["logSlope"] * math.log(lin_at_break) / math.log(b) + s["logOffset"]
    lin_slope = s.get("linearSlope", s["logSlope"] * s["linSlope"] / (lin_at_break * math.log(b)))
    lin_off = log_break - lin_slope * s["linBreak"]
    return log_break, lin_slope, lin_off


def explin_derived(s):
    g, o = s["gamma"], s["offset"]
    brk = o / (g - 1.0)
    slope = ((brk + o) / (1.0 + o)) ** g / brk
    return brk, slope


APPLE = dict(R0=-0.05641088, Rt=0.01, c=47.28711236, b=0.00964052, g=0.08550479, beta=0.69336945)


def run_stages(stages, x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64).copy()
    for s in stages:
        op = s["op"]
        if op == "matrix":
            x = x @ np.array(s["m"]).reshape(3, 3).T
        elif op == "logcam":
            lb, ls, lo = logcam_derived(s)
            x = np.where(
                x <= lb,
                (x - lo) / ls,
                (np.power(s["base"], (x - s["logOffset"]) / s["logSlope"]) - s["linOffset"]) / s["linSlope"],
            )
        elif op == "explin":
            brk, slope = explin_derived(s)
            g, o = s["gamma"], s["offset"]
            a = np.abs(x) if s["mirror"] else x
            y = np.where(a >= brk, np.power(np.maximum((a + o) / (1 + o), 0), g), a * slope)
            x = np.sign(x) * y if s["mirror"] else y
        elif op == "pow":
            g = s["gamma"]
            if s["style"] == "mirror":
                x = np.sign(x) * np.power(np.abs(x), g)
            elif s["style"] == "clamp":
                x = np.power(np.maximum(x, 0), g)
            else:
                x = np.where(x < 0, x, np.power(np.maximum(x, 0), g))
        elif op == "clampMin":
            x = np.maximum(x, s["v"])
        elif op == "acescc":
            x = np.clip(x, s["min"], s["max"])
            # OCIO does not apply the 65504 cap of the ACES spec (input is clamped to 1.5 instead).
            lo = (9.72 - 15) / 17.52
            x = np.where(x < lo, (np.exp2(x * 17.52 - 9.72) - 2.0**-16) * 2.0, np.exp2(x * 17.52 - 9.72))
        elif op == "applelog":
            A = APPLE
            pt = A["c"] * (A["Rt"] - A["R0"]) ** 2
            x = np.where(
                x >= pt,
                np.exp2((x - A["beta"]) / A["g"]) - A["b"],
                np.where(x >= 0, np.sqrt(np.maximum(x, 0) / A["c"]) + A["R0"], A["R0"]),
            )
        elif op == "clog2":
            x = np.clip(x, 0, 1)
            x = 0.9 * np.where(
                x < 0.092864125,
                -(np.power(10, (0.092864125 - x) / 0.24136077) - 1) / 87.09937546,
                (np.power(10, (x - 0.092864125) / 0.24136077) - 1) / 87.09937546,
            )
        elif op == "clog3":
            x = np.clip(x, 0, 1)
            x = 0.9 * np.where(
                x < 0.097465473,
                -(np.power(10, (0.12783901 - x) / 0.36726845) - 1) / 14.98325,
                np.where(
                    x <= 0.15277891,
                    (x - 0.12512219) / 1.9754798,
                    (np.power(10, (x - 0.12240537) / 0.36726845) - 1) / 14.98325,
                ),
            )
        else:
            raise RuntimeError(op)
    return x


# ---------------------------------------------------------------------------
# Display decoding (signal -> absolute nits), mirrored in TS displayToNits()
# ---------------------------------------------------------------------------
PQ = dict(m1=2610 / 16384, m2=2523 / 4096 * 128, c1=3424 / 4096, c2=2413 / 4096 * 32, c3=2392 / 4096 * 32)
HLG = dict(a=0.17883277, b=1 - 4 * 0.17883277, c=0.5 - 0.17883277 * math.log(4 * 0.17883277))


def pq_eotf(e):  # signal -> nits
    e = np.asarray(e, dtype=np.float64)
    s = np.sign(e)
    ep = np.power(np.abs(e), 1 / PQ["m2"])
    y = np.power(np.maximum(ep - PQ["c1"], 0) / (PQ["c2"] - PQ["c3"] * ep), 1 / PQ["m1"])
    return s * 10000.0 * y


def pq_oetf(nits):
    y = np.abs(np.asarray(nits, dtype=np.float64)) / 10000.0
    yp = np.power(y, PQ["m1"])
    return np.sign(nits) * np.power((PQ["c1"] + PQ["c2"] * yp) / (1 + PQ["c3"] * yp), PQ["m2"])


def hlg_inv_oetf(e):
    e = np.asarray(e, dtype=np.float64)
    a = np.abs(e)
    y = np.where(a <= 0.5, a * a / 3.0, (np.exp((a - HLG["c"]) / HLG["a"]) + HLG["b"]) / 12.0)
    return np.sign(e) * y


SRGB_EXPLIN = {"gamma": 2.4, "offset": 0.055, "mirror": True}


def display_to_nits(enc: str, prim: str, sig: np.ndarray) -> np.ndarray:
    sig = np.asarray(sig, dtype=np.float64)
    if enc == "srgb":
        return 100.0 * run_stages([{"op": "explin", **SRGB_EXPLIN}], sig)
    if enc in ("bt1886", "gamma22", "gamma26"):
        g = {"bt1886": 2.4, "gamma22": 2.2, "gamma26": 2.6}[enc]
        return 100.0 * np.sign(sig) * np.power(np.abs(sig), g)
    if enc == "pq":
        return pq_eotf(sig)
    if enc == "hlg":
        # BT.2100 HLG reference OOTF, Lw = 1000 nits, gamma 1.2, Lb = 0. Luma on Rec.2020 primaries.
        e = hlg_inv_oetf(sig)
        w = RGB2XYZ["rec2020"][1]
        ys = np.maximum(e @ w, 1e-12)
        return 1000.0 * e * (ys ** 0.2)[..., None]
    raise ValueError(enc)


# ---------------------------------------------------------------------------
# Colour difference metrics
# ---------------------------------------------------------------------------


def xyz_to_lab(xyz, white):
    r = xyz / white
    d = 6 / 29
    f = np.where(r > d**3, np.cbrt(r), r / (3 * d * d) + 4 / 29)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], -1)


def de2000(lab1, lab2):
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cb**7 / (Cb**7 + 25.0**7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dLp = L2 - L1
    dCp = C2p - C1p
    dh = h2p - h1p
    dh = np.where(C1p * C2p == 0, 0, np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh)))
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2))
    Lbp = (L1 + L2) / 2
    Cbp = (C1p + C2p) / 2
    hs = h1p + h2p
    hbp = np.where(
        C1p * C2p == 0, hs, np.where(np.abs(h1p - h2p) <= 180, hs / 2, np.where(hs < 360, (hs + 360) / 2, (hs - 360) / 2))
    )
    T = (
        1
        - 0.17 * np.cos(np.radians(hbp - 30))
        + 0.24 * np.cos(np.radians(2 * hbp))
        + 0.32 * np.cos(np.radians(3 * hbp + 6))
        - 0.20 * np.cos(np.radians(4 * hbp - 63))
    )
    dth = 30 * np.exp(-(((hbp - 275) / 25) ** 2))
    Rc = 2 * np.sqrt(Cbp**7 / (Cbp**7 + 25.0**7))
    Sl = 1 + 0.015 * (Lbp - 50) ** 2 / np.sqrt(20 + (Lbp - 50) ** 2)
    Sc = 1 + 0.045 * Cbp
    Sh = 1 + 0.015 * Cbp * T
    Rt = -np.sin(np.radians(2 * dth)) * Rc
    return np.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))


LMS_FROM_2020 = np.array([[1688, 2146, 262], [683, 2951, 462], [99, 309, 3688]]) / 4096
ICTCP = np.array([[2048, 2048, 0], [6610, -13613, 7003], [17933, -17390, -543]]) / 4096


def ictcp(nits_2020):
    lms = np.maximum(nits_2020, 0) @ LMS_FROM_2020.T
    return pq_oetf(lms) @ ICTCP.T


def delta_e(view, sig_a, sig_b):
    """SDR: CIEDE2000 on display-referred CIELAB (D65, white = display white, signals clipped to [0,1]).
    HDR: Delta E ITP (ITU-R BT.2124) on absolute luminance (1 unit ~ 1 JND)."""
    enc, prim, hdr = view["encoding"], view["primaries"], view["hdr"]
    na = display_to_nits(enc, prim, sig_a)
    nb = display_to_nits(enc, prim, sig_b)
    if not hdr:
        M = RGB2XYZ[prim]
        white = M @ np.ones(3)
        la = xyz_to_lab(np.clip(na / 100.0, 0, 1) @ M.T, white)
        lb = xyz_to_lab(np.clip(nb / 100.0, 0, 1) @ M.T, white)
        return de2000(la, lb)
    to2020 = XYZ2RGB["rec2020"] @ RGB2XYZ[prim]
    ia = ictcp(na @ to2020.T)
    ib = ictcp(nb @ to2020.T)
    d = ia - ib
    return 720 * np.sqrt(d[..., 0] ** 2 + (0.5 * d[..., 1]) ** 2 + d[..., 2] ** 2)


def stats(d):
    return {"mean": round(float(np.mean(d)), 4), "p99": round(float(np.percentile(d, 99)), 4), "max": round(float(np.max(d)), 4)}


# ---------------------------------------------------------------------------
# LUT bake + trilinear reference (mirrors applyViewCPU in TS)
# ---------------------------------------------------------------------------


def bake_lut(cfg, display, view, n):
    t = OCIO.DisplayViewTransform(src="ACEScct", display=display, view=view)
    p = cpu(cfg.getProcessor(t))
    v = np.linspace(0, 1, n)
    cct = SHAPER_MIN + v * (SHAPER_MAX - SHAPER_MIN)
    b, g, r = np.meshgrid(cct, cct, cct, indexing="ij")  # r fastest in memory
    lat = np.stack([r, g, b], -1).reshape(-1, 3)
    out = apply(p, lat)
    return out.reshape(n, n, n, 3)  # [b][g][r][c]


def lut_sample(lut16, acescg):
    n = lut16.shape[0]
    cct = lin_to_acescct(acescg)
    u = np.clip((cct - SHAPER_MIN) / (SHAPER_MAX - SHAPER_MIN), 0, 1) * (n - 1)
    i0 = np.minimum(np.floor(u).astype(int), n - 2)
    f = u - i0
    out = np.zeros_like(acescg, dtype=np.float64)
    for db in (0, 1):
        wb = f[:, 2] if db else 1 - f[:, 2]
        for dg in (0, 1):
            wg = f[:, 1] if dg else 1 - f[:, 1]
            for dr in (0, 1):
                wr = f[:, 0] if dr else 1 - f[:, 0]
                out += (wr * wg * wb)[:, None] * lut16[i0[:, 2] + db, i0[:, 1] + dg, i0[:, 0] + dr]
    return out


def random_samples(rng, n, cfg):
    """Two accuracy sets: 'cube' = uniform in the ACEScct LUT domain (stress test incl. extreme AP1
    saturation), 'natural' = Rec.709-gamut colours at -8..+8 stops around 18% grey, in ACEScg."""
    cube = acescct_to_lin(SHAPER_MIN + rng.random((n, 3)) * (SHAPER_MAX - SHAPER_MIN))
    m709 = mat_of(cfg, "Linear Rec.709 (sRGB)", "ACEScg")
    col = rng.random((n, 3)) ** 2
    col /= np.maximum(col @ RGB2XYZ["rec709"][1], 1e-6)[:, None]
    sat = rng.random((n, 1))
    col = (1 - sat) + sat * col
    nat = 0.18 * np.exp2(rng.uniform(-8, 8, (n, 1))) * col
    return cube, nat @ m709.T


def view_fixture_samples(rng, cfg):
    s = []
    # grey ramp, -14 .. +12 stops around 18% grey and zero
    s += [[0, 0, 0]]
    s += [[0.18 * 2**e] * 3 for e in np.arange(-14, 12.5, 0.5)]
    # primaries / secondaries in AP1 and Rec.709 at several exposures
    m709 = mat_of(cfg, "Linear Rec.709 (sRGB)", "ACEScg")
    hues = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1], [1, 0.5, 0], [0.5, 0, 1]]
    for h in hues:
        for e in (-4, -2, 0, 2, 4, 6):
            v = np.array(h, dtype=np.float64) * 0.18 * 2**e
            s.append(list(v))
            s.append(list(m709 @ v))
    # skin-ish tones
    for e in (-2, -1, 0, 1, 2):
        s.append(list(m709 @ (np.array([0.45, 0.3, 0.22]) * 2**e)))
    # very bright
    for v in (100, 222, 500, 1000, 5000, 65504):
        s.append([v, v, v])
        s.append([v, v * 0.5, v * 0.1])
    # negatives (slightly outside AP1)
    for _ in range(20):
        v = rng.uniform(0, 1, 3)
        v[rng.integers(0, 3)] = -rng.uniform(0, 0.02)
        s.append(list(v))
    s.append([-0.1, -0.1, -0.1])
    cube, nat = random_samples(rng, 300, cfg)
    s += cube[:120].tolist() + nat[:300 - 120 + 60].tolist()
    return np.array(s, dtype=np.float64)


def r9(x):
    return [float(f"{v:.9g}") for v in x]


# ---------------------------------------------------------------------------
# generated.ts
# ---------------------------------------------------------------------------


def fmt_mat(m):
    return "[" + ", ".join(repr(float(v)) for v in np.asarray(m).reshape(-1)) + "]"


def write_generated_ts(cfg, info, specs):
    space_info = [{"id": a, "label": b, "family": c, "ocioName": d, "isLog": e} for a, b, c, d, e in INPUT_SPACES]
    mats = {
        "AP0_TO_AP1": mat_of(cfg, "ACES2065-1", "ACEScg"),
        "AP1_TO_AP0": mat_of(cfg, "ACEScg", "ACES2065-1"),
        "AP1_TO_REC709": mat_of(cfg, "ACEScg", "Linear Rec.709 (sRGB)"),
        "AP1_TO_P3D65": mat_of(cfg, "ACEScg", "Linear P3-D65"),
        "AP1_TO_REC2020": mat_of(cfg, "ACEScg", "Linear Rec.2020"),
        "REC709_TO_AP1": mat_of(cfg, "Linear Rec.709 (sRGB)", "ACEScg"),
        "P3D65_TO_AP1": mat_of(cfg, "Linear P3-D65", "ACEScg"),
        "REC2020_TO_AP1": mat_of(cfg, "Linear Rec.2020", "ACEScg"),
        "XYZ_TO_REC709": XYZ2RGB["rec709"],
        "XYZ_TO_P3D65": XYZ2RGB["p3d65"],
        "XYZ_TO_REC2020": XYZ2RGB["rec2020"],
        "REC709_TO_XYZ": RGB2XYZ["rec709"],
        "P3D65_TO_XYZ": RGB2XYZ["p3d65"],
        "REC2020_TO_XYZ": RGB2XYZ["rec2020"],
        "REC2020_TO_P3D65": XYZ2RGB["p3d65"] @ RGB2XYZ["rec2020"],
        "P3D65_TO_REC2020": XYZ2RGB["rec2020"] @ RGB2XYZ["p3d65"],
        "REC709_TO_REC2020": XYZ2RGB["rec2020"] @ RGB2XYZ["rec709"],
        "REC2020_TO_REC709": XYZ2RGB["rec709"] @ RGB2XYZ["rec2020"],
        "P3D65_TO_REC709": XYZ2RGB["rec709"] @ RGB2XYZ["p3d65"],
        "REC709_TO_P3D65": XYZ2RGB["p3d65"] @ RGB2XYZ["rec709"],
    }
    # ACEScg -> CIE XYZ (D65 adapted, the OCIO display reference space), via OCIO's own CAT.
    mats["AP1_TO_XYZ"] = RGB2XYZ["rec709"] @ mats["AP1_TO_REC709"]
    mats["XYZ_TO_AP1"] = np.linalg.inv(mats["AP1_TO_XYZ"])
    # Native (unadapted, D60) AP1 -> XYZ from the ACES primaries: row 1 = ACEScg luminance weights.
    ap1_native = rgb_to_xyz([(0.713, 0.293), (0.165, 0.830), (0.128, 0.044)], (0.32168, 0.33767))
    mats["AP1_TO_XYZ_D60"] = ap1_native
    lines = [
        "// AUTO-GENERATED by tools/ocio-bake/bake.py - do not edit by hand.",
        f"// Source: {info['ocioConfig']} (OpenColorIO {info['ocioVersion']}).",
        "// Matrices are row-major 3x3 (out = M * in). Input stages are the exact op chain OCIO uses",
        "// for <space> -> ACEScg, with LUT-based ops replaced by their closed-form curves.",
        "",
        "export type Stage =",
        "  | { op: 'matrix'; m: number[] }",
        "  | { op: 'logcam'; base: number; logSlope: number; logOffset: number; linSlope: number; linOffset: number; linBreak: number; linearSlope?: number }",
        "  | { op: 'explin'; gamma: number; offset: number; mirror: boolean }",
        "  | { op: 'pow'; gamma: number; style: 'pass_thru' | 'mirror' | 'clamp' }",
        "  | { op: 'clampMin'; v: number }",
        "  | { op: 'acescc'; min: number; max: number }",
        "  | { op: 'applelog' }",
        "  | { op: 'clog2' }",
        "  | { op: 'clog3' };",
        "",
        f"export const OCIO_CONFIG = {json.dumps(info['ocioConfig'])};",
        f"export const OCIO_VERSION = {json.dumps(info['ocioVersion'])};",
        f"export const SHAPER_MIN = {SHAPER_MIN!r};",
        f"export const SHAPER_MAX = {SHAPER_MAX!r};",
        "",
        "export const MATRICES = {",
    ]
    for k, v in mats.items():
        lines.append(f"  {k}: {fmt_mat(v)},")
    lines += ["} as const;", "", "export const INPUT_SPACE_INFO = ["]
    for si in space_info:
        lines.append(f"  {json.dumps(si)},")
    lines += ["] as const;", "", "export const INPUT_STAGES: Record<string, Stage[]> = {"]
    for sid, st in specs.items():
        lines.append(f"  {json.dumps(sid)}: {json.dumps(st)},")
    lines += ["};", ""]
    (COLOR_DIR / "generated.ts").write_text("\n".join(lines))


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=49)
    ap.add_argument("--eval-only", action="store_true")
    ap.add_argument("--samples", type=int, default=50000)
    args = ap.parse_args()

    cfgs = {"main": load_config(MAIN_CONFIG_URI), "legacy": load_config(LEGACY_CONFIG_URI)}
    main_cfg = cfgs["main"]
    info = {"ocioConfig": main_cfg.getName(), "ocioVersion": OCIO.__version__}
    print(f"OCIO {OCIO.__version__}  config {main_cfg.getName()}  legacy {cfgs['legacy'].getName()}")
    print(f"shaper ACEScct [{SHAPER_MIN:.6f}, {SHAPER_MAX:.6f}]  size {args.size}")
    rng = np.random.default_rng(20261118)

    # ---- input spaces ----------------------------------------------------
    specs = {}
    input_fix = {"ocioConfig": info["ocioConfig"], "ocioVersion": info["ocioVersion"], "spaces": []}
    edge = [-0.5, -0.1, -0.01, 0.0, 1e-4, 0.01, 0.0392857, 0.0625, 0.0729, 0.0912, 0.1, 0.18, 0.25, 0.4135,
            0.5, 0.75, 0.9, 1.0, 1.1, 1.5, 2.0]
    for sid, label, fam, name, is_log in INPUT_SPACES:
        st = extract_stages(main_cfg, name)
        specs[sid] = st
        p = cpu(main_cfg.getProcessor(name, "ACEScg"))
        x = [[e, e, e] for e in edge]
        x += [[a, b, c] for a, b, c in rng.choice(edge, (40, 3))]
        hi = 1.2 if (is_log or fam == "Display") else 4.0
        x += rng.uniform(-0.1, hi, (200 - len(x), 3)).tolist()
        if fam == "Scene-linear" or fam == "ACES" and not is_log:
            x += [[100.0, 50.0, 1.0], [1000.0, 1000.0, 1000.0], [-1.0, 0.5, 2.0]]
        x = np.array(x, dtype=np.float32).astype(np.float64)
        ref = apply(p, x)
        mine = run_stages(st, x)
        err = np.abs(mine - ref) / np.maximum(np.abs(ref), 1.0)
        print(f"  input {sid:32s} stages={[s['op'] for s in st]}  max rel err {err.max():.2e}")
        input_fix["spaces"].append({"id": sid, "ocioName": name, "input": [r9(v) for v in x], "acescg": [r9(v) for v in ref]})

    # ---- views ------------------------------------------------------------
    manifest = {"ocioConfig": info["ocioConfig"], "ocioVersion": info["ocioVersion"],
                "shaper": {"space": "acescct", "min": SHAPER_MIN, "max": SHAPER_MAX},
                "deltaEMetric": {"sdr": "CIEDE2000, display-referred CIELAB (D65, display white = L 100)",
                                 "hdr": "Delta E ITP (ITU-R BT.2124), absolute luminance"},
                "views": []}
    view_fix = {"ocioConfig": info["ocioConfig"], "ocioVersion": info["ocioVersion"], "views": []}
    fix_samples = view_fixture_samples(rng, main_cfg)
    total = 0
    for vid, ckey, display, view, enc, prim, hdr, peak in VIEWS:
        cfg = cfgs[ckey]
        assert display in cfg.getDisplays() and view in cfg.getViews(display), (display, view)
        n = args.size
        lut = bake_lut(cfg, display, view, n)
        lut16 = lut.astype(np.float16)
        assert np.all(np.isfinite(lut16)), vid
        vinfo = {"encoding": enc, "primaries": prim, "hdr": hdr}
        exact = cpu(cfg.getProcessor(OCIO.DisplayViewTransform(src="ACEScg", display=display, view=view)))
        cube, nat = random_samples(rng, args.samples, main_cfg)
        res = {}
        for nm, smp in (("cube", cube), ("natural", nat)):
            ref = apply(exact, smp)
            got = lut_sample(lut16.astype(np.float64), smp)
            res[nm] = stats(delta_e(vinfo, got, ref))
        fx_ref = apply(exact, fix_samples)
        fx_got = lut_sample(lut16.astype(np.float64), fix_samples)
        fx_de = delta_e(vinfo, fx_got, fx_ref)
        res["fixtures"] = stats(fx_de)
        print(f"  view {vid:32s} cube {res['cube']}  natural {res['natural']}  fixtures {res['fixtures']}")
        nbytes = n * n * n * 8
        total += nbytes
        cfg_name = cfg.getName()
        manifest["views"].append({
            "id": vid, "display": display, "view": view,
            "label": f"{display.removesuffix(' - Display')} · {view}",
            "size": n, "hdr": hdr, "peakNits": peak, "encoding": enc, "primaries": prim,
            "ocioConfig": cfg_name, "ocioVersion": OCIO.__version__, "file": f"{vid}.bin", "bytes": nbytes,
            "deltaE": res["natural"], "deltaECube": res["cube"],
        })
        view_fix["views"].append({"id": vid, "display": display, "view": view, "ocioConfig": cfg_name,
                                  "acescg": [r9(v) for v in fix_samples], "display_signal": [r9(v) for v in fx_ref]})
        if not args.eval_only:
            LUT_DIR.mkdir(parents=True, exist_ok=True)
            rgba = np.ones((n, n, n, 4), dtype="<f2")
            rgba[..., :3] = lut16
            (LUT_DIR / f"{vid}.bin").write_bytes(rgba.tobytes(order="C"))
    print(f"  total LUT bytes {total} ({total / 1e6:.2f} MB)")

    # ---- analytic views + display decoding ----------------------------------
    analytic_fix = []
    for aid, display, view, enc, prim in ANALYTIC_VIEW_FIXTURES:
        p = cpu(main_cfg.getProcessor(OCIO.DisplayViewTransform(src="ACEScg", display=display, view=view)))
        analytic_fix.append({"id": aid, "display": display, "view": view, "acescg": [r9(v) for v in fix_samples[:200]],
                             "display_signal": [r9(v) for v in apply(p, fix_samples[:200])]})
    decode_fix = []
    sig = np.concatenate([np.repeat(np.linspace(0, 1, 41)[:, None], 3, 1), rng.random((60, 3))])
    for enc, prim, display, lin in DISPLAY_DECODE_FIXTURES:
        p = cpu(main_cfg.getProcessor(display, lin))  # inverse display encoding (colorimetric)
        ref = apply(p, sig) * 100.0
        mine = display_to_nits(enc, prim, sig)
        err = np.abs(mine - ref) / np.maximum(np.abs(ref), 1.0)
        print(f"  decode {display:30s} {enc:8s} max rel err {err.max():.2e}")
        decode_fix.append({"encoding": enc, "primaries": prim, "display": display, "signal": [r9(v) for v in sig],
                           "nits": [r9(v) for v in ref]})
    cdl_fix = []
    for k in range(12):
        slope = rng.uniform(0.6, 1.6, 3) if k else np.ones(3)
        offset = rng.uniform(-0.1, 0.1, 3) if k else np.zeros(3)
        power = rng.uniform(0.6, 1.5, 3) if k else np.ones(3)
        sat = float(rng.uniform(0.0, 2.0)) if k else 1.0
        t = OCIO.CDLTransform(slope=slope.tolist(), offset=offset.tolist(), power=power.tolist(), sat=sat)
        t.setStyle(OCIO.CDL_NO_CLAMP)
        p = cpu(main_cfg.getProcessor(t))
        x = np.concatenate([rng.uniform(-0.1, 1.2, (40, 3)), [[0, 0, 0], [1, 1, 1], [-0.05, 0.2, 0.5]]])
        cdl_fix.append({"slope": r9(slope), "offset": r9(offset), "power": r9(power), "sat": sat,
                        "input": [r9(v) for v in x], "output": [r9(v) for v in apply(p, x)]})
    view_fix["cdl"] = cdl_fix
    view_fix["analytic"] = analytic_fix
    view_fix["decode"] = decode_fix

    if args.eval_only:
        return
    (LUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    (FIXTURE_DIR / "input-spaces.json").write_text(json.dumps(input_fix, separators=(",", ":")))
    (FIXTURE_DIR / "views.json").write_text(json.dumps(view_fix, separators=(",", ":")))
    write_generated_ts(main_cfg, info, specs)
    print("wrote", LUT_DIR, FIXTURE_DIR, COLOR_DIR / "generated.ts")


if __name__ == "__main__":
    sys.exit(main())
