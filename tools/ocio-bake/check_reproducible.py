# SPDX-License-Identifier: Apache-2.0
"""Checks that a fresh bake matches the committed outputs within floating-point noise.

OCIO's CPU path is not bit-identical across platforms and compilers (FMA, libm, SIMD), so a
Linux bake differs from a macOS bake in the last bits. Run after `pnpm bake:luts`:

    uv run --with numpy python tools/ocio-bake/check_reproducible.py

It compares the working tree with HEAD:
- LUT .bin files (float16 RGBA): |a - b| <= 2e-3 * max(1, |b|), i.e. about 2 half-float ULPs.
- generated.ts and manifest.json: identical text once numbers are masked, and every number
  equal within a relative 1e-4 (generated.ts: matrices and curve constants) or 2e-2
  (manifest.json: its accuracy statistics move with 1-ULP LUT changes), or an absolute 1e-6.
"""
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
LUTS = ROOT / "packages/core/src/color/luts"
TEXT = [(ROOT / "packages/core/src/color/generated.ts", 1e-4), (LUTS / "manifest.json", 2e-2)]
NUM = re.compile(r"-?\d+\.?\d*(?:[eE][-+]?\d+)?")


def head(path: Path) -> bytes:
    rel = path.relative_to(ROOT).as_posix()
    return subprocess.run(["git", "show", f"HEAD:{rel}"], cwd=ROOT, check=True, capture_output=True).stdout


def main() -> int:
    bad = []
    for f in sorted(LUTS.glob("*.bin")):
        a = np.frombuffer(f.read_bytes(), dtype=np.float16).astype(np.float64)
        b = np.frombuffer(head(f), dtype=np.float16).astype(np.float64)
        if a.shape != b.shape:
            bad.append(f"{f.name}: size {a.size} != {b.size}")
            continue
        err = np.abs(a - b) / np.maximum(1.0, np.abs(b))
        worst = float(np.nanmax(err)) if err.size else 0.0
        print(f"{f.name:40s} max rel diff {worst:.2e}")
        if worst > 2e-3 or np.isnan(a).sum() != np.isnan(b).sum():
            bad.append(f"{f.name}: max rel diff {worst:.2e}")
    for f, tol in TEXT:
        new, old = f.read_text(), head(f).decode()
        if NUM.sub("#", new) != NUM.sub("#", old):
            bad.append(f"{f.name}: structure changed")
            continue
        worst = 0.0
        for x, y in zip(NUM.findall(new), NUM.findall(old)):
            x, y = float(x), float(y)
            d = abs(x - y)
            if d > 1e-6 and d > tol * max(abs(x), abs(y)):
                bad.append(f"{f.name}: {y} -> {x}")
            worst = max(worst, d / max(1e-12, abs(y)))
        print(f"{f.name:40s} max rel diff {worst:.2e}")
    if bad:
        print("\nNot reproducible:\n  " + "\n  ".join(bad[:30]))
        return 1
    print("\nBake reproducible within tolerance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
