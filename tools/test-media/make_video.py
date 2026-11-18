"""Generates the video test media for the demo and the e2e tests.

  uv run --python 3.12 --with OpenEXR --with numpy python tools/test-media/make_video.py

Needs ffmpeg on PATH. Writes to apps/demo/public/media/generated/video/:
  chart_acescct_prores422hq.mov  ACEScg EXR sequence encoded to ACEScct, ProRes 422 HQ 10-bit (BT.709 matrix, limited)
  bars_prores4444xq_alpha.mov    ProRes 4444 XQ 12-bit with an animated alpha channel
  bars_prores422hq_uhd.mov       3840x2160 ProRes 422 HQ (decoder throughput test)
  bars_hevc10.mp4                HEVC Main10 (WebCodecs path)
  bars_h264_audio.mp4            H.264 + AAC 1 kHz tone (audio clock path)
  bars_av1_10bit.mp4             AV1 10-bit (software decode path, keeps 10-bit planes)
"""
import pathlib
import subprocess
import sys

import numpy as np
import OpenEXR

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "apps/demo/public/media/generated/video"
SEQ = ROOT / "apps/demo/public/media/generated/exr/seq"
OUT.mkdir(parents=True, exist_ok=True)

TAGS = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]


def acescct(lin: np.ndarray) -> np.ndarray:
    x = np.maximum(lin, -1e-6)
    return np.where(x <= 0.0078125, 10.5402377416545 * x + 0.0729055341958355, (np.log2(np.maximum(x, 1e-10)) + 9.72) / 17.52)


def run(args: list[str], stdin=None):
    print("ffmpeg", " ".join(args[-1:]))
    p = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args], input=stdin)
    if p.returncode:
        sys.exit(p.returncode)


def acescct_prores():
    frames = sorted(SEQ.glob("chart.*.exr"))
    if not frames:
        print("EXR sequence missing: run tools/test-media/make_exr.py first")
        return
    buf = []
    w = h = 0
    for f in frames:
        with OpenEXR.File(str(f)) as exr:
            ch = exr.channels()
            if "RGB" in ch:
                rgb = ch["RGB"].pixels
            elif "RGBA" in ch:
                rgb = ch["RGBA"].pixels[..., :3]
            else:
                rgb = np.stack([ch[c].pixels for c in "RGB"], axis=-1)
        rgb = rgb.astype(np.float32)
        h, w = rgb.shape[:2]
        cct = np.clip(acescct(rgb), 0, 1)
        buf.append((cct * 65535 + 0.5).astype("<u2").tobytes())
    run(
        ["-f", "rawvideo", "-pix_fmt", "rgb48le", "-s", f"{w}x{h}", "-r", "24", "-i", "-",
         "-vf", "scale=out_color_matrix=bt709:out_range=limited,format=yuv422p10le",
         "-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", *TAGS,
         "-metadata", "comment=ACEScct encoded (AP1) – choose Input: ACEScct",
         str(OUT / "chart_acescct_prores422hq.mov")],
        stdin=b"".join(buf),
    )


def bars():
    src = "testsrc2=size=1920x1080:rate=24:duration=4"
    # 4444 XQ with alpha: alpha is an animated radial gradient.
    run(["-f", "lavfi", "-i", src, "-f", "lavfi", "-i", "color=c=white:size=1920x1080:rate=24:d=4,geq=lum='255*clip(1.4-hypot(X-W/2,Y-H/2)/(H*(0.3+0.2*sin(T*2))),0,1)':cb=128:cr=128",
         "-filter_complex", "[0:v]format=rgba[c];[1:v]format=gray[a];[c][a]alphamerge,scale=out_color_matrix=bt709:out_range=limited,format=yuva444p12le",
         "-c:v", "prores_ks", "-profile:v", "5", "-vendor", "apl0", "-alpha_bits", "16", *TAGS,
         str(OUT / "bars_prores4444xq_alpha.mov")])
    run(["-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=24:duration=3", "-vf", "scale=out_color_matrix=bt709:out_range=limited,format=yuv422p10le",
         "-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", *TAGS, str(OUT / "bars_prores422hq_uhd.mov")])
    run(["-f", "lavfi", "-i", "smptehdbars=size=1920x1080:rate=24:duration=4", "-vf", "format=yuv420p10le",
         "-c:v", "libx265", "-tag:v", "hvc1", "-x265-params", "log-level=error", "-preset", "fast", *TAGS, str(OUT / "bars_hevc10.mp4")])
    run(["-f", "lavfi", "-i", src, "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=4",
         "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "fast", "-c:a", "aac", "-b:a", "128k", "-shortest", *TAGS,
         "-movflags", "+faststart", str(OUT / "bars_h264_audio.mp4")])
    run(["-f", "lavfi", "-i", "smptehdbars=size=1920x1080:rate=24:duration=2", "-vf", "format=yuv420p10le",
         "-c:v", "libsvtav1", "-preset", "10", "-svtav1-params", "log-level=0", *TAGS, str(OUT / "bars_av1_10bit.mp4")])


if __name__ == "__main__":
    acescct_prores()
    bars()
    for f in sorted(OUT.iterdir()):
        print(f"{f.name:40s} {f.stat().st_size / 1e6:7.1f} MB")
