# SPDX-License-Identifier: Apache-2.0
"""Checks that a fresh bake matches the committed outputs within floating-point noise.

OCIO's CPU path is not bit-identical across platforms (FMA, libm, SIMD), so a Linux x86 bake
differs from the committed macOS arm64 bake in the last bits. Run after `pnpm bake:luts`:

    pnpm bake:check

It compares the working tree with HEAD:

- LUT .bin files (float16 RGBA): |a - b| <= 2.5e-3 * max(1, |b|), about 2 half-float ULPs.
  Up to MAX_OUTLIERS isolated lattice points per LUT may differ more; they are listed.
  Known case (OCIO 2.6.0, x86_64 Linux): the SDR ACES 2.0 views return black at lattice point
  (r, g, b) = (45, 21, 32), a very bright red where every neighbour and OCIO on arm64 return
  white. The committed value (white) is the correct one.
- generated.ts: identical once numbers and whitespace are masked (number lengths change line
  wrapping), every number within a relative 1e-6.
- manifest.json: same keys and values, numbers within a relative 2e-2, except the `max`
  accuracy statistics, which follow the outliers above.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
LUTS = ROOT / "packages/core/src/color/luts"
GENERATED = ROOT / "packages/core/src/color/generated.ts"
NUM = re.compile(r"-?\d+\.?\d*(?:[eE][-+]?\d+)?")
LUT_TOL = 2.5e-3
MAX_OUTLIERS = 2


def head(path: Path) -> bytes:
    rel = path.relative_to(ROOT).as_posix()
    return subprocess.run(
        ["git", "show", f"HEAD:{rel}"], cwd=ROOT, check=True, capture_output=True
    ).stdout


def close(x: float, y: float, rel: float) -> bool:
    d = abs(x - y)
    return d <= 1e-6 or d <= rel * max(abs(x), abs(y))


def check_luts(bad: list[str]) -> None:
    for f in sorted(LUTS.glob("*.bin")):
        a = np.frombuffer(f.read_bytes(), dtype=np.float16).astype(np.float64)
        b = np.frombuffer(head(f), dtype=np.float16).astype(np.float64)
        if a.shape != b.shape:
            bad.append(f"{f.name}: size {a.size} != {b.size}")
            continue
        if np.isnan(a).sum() != np.isnan(b).sum():
            bad.append(f"{f.name}: NaN count changed")
            continue
        err = (np.abs(a - b) / np.maximum(1.0, np.abs(b))).reshape(-1, 4).max(axis=1)
        out = np.flatnonzero(err > LUT_TOL)
        n = round(len(err) ** (1 / 3))
        noise = float(np.max(np.delete(err, out))) if len(out) < len(err) else 0.0
        note = ""
        if len(out):
            pts = [(int(i % n), int(i // n % n), int(i // (n * n))) for i in out[:5]]
            note = f"  {len(out)} outlier point(s) (r,g,b) {pts}"
        print(f"{f.name:36s} noise {noise:.1e}{note}")
        if len(out) > MAX_OUTLIERS:
            bad.append(f"{f.name}: {len(out)} lattice points differ by more than {LUT_TOL}")


def check_generated(bad: list[str]) -> None:
    new, old = GENERATED.read_text(), head(GENERATED).decode()
    mask = lambda s: re.sub(r"\s+", "", NUM.sub("#", s))  # noqa: E731
    if mask(new) != mask(old):
        bad.append("generated.ts: structure changed")
        return
    worst = 0.0
    for x, y in zip(map(float, NUM.findall(new)), map(float, NUM.findall(old))):
        if not close(x, y, 1e-6):
            bad.append(f"generated.ts: {y} -> {x}")
        worst = max(worst, abs(x - y) / max(1e-12, abs(y)))
    print(f"{'generated.ts':36s} max rel diff {worst:.1e}")


def check_manifest(bad: list[str]) -> None:
    f = LUTS / "manifest.json"
    new, old = json.loads(f.read_text()), json.loads(head(f))

    def walk(x, y, path):
        if isinstance(y, dict):
            if not isinstance(x, dict) or x.keys() != y.keys():
                bad.append(f"manifest.json: keys differ at {path}")
                return
            for k in y:
                if k == "max":
                    continue
                walk(x[k], y[k], f"{path}.{k}")
        elif isinstance(y, list):
            if not isinstance(x, list) or len(x) != len(y):
                bad.append(f"manifest.json: list differs at {path}")
                return
            for i, (xi, yi) in enumerate(zip(x, y)):
                walk(xi, yi, f"{path}[{i}]")
        elif isinstance(y, (int, float)) and not isinstance(y, bool):
            if not isinstance(x, (int, float)) or not close(float(x), float(y), 2e-2):
                bad.append(f"manifest.json: {path} {y} -> {x}")
        elif x != y:
            bad.append(f"manifest.json: {path} {y!r} -> {x!r}")

    walk(new, old, "$")
    print(f"{'manifest.json':36s} checked")


def main() -> int:
    bad: list[str] = []
    check_luts(bad)
    check_generated(bad)
    check_manifest(bad)
    if bad:
        print("\nNot reproducible:\n  " + "\n  ".join(bad[:30]))
        return 1
    print("\nBake reproducible within tolerance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
