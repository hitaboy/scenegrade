/** SMPTE timecode helpers (non-drop and drop-frame for 29.97 / 59.94). */

export function isDropFrame(fps: number): boolean {
  return Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01;
}

export function nominalFps(fps: number): number {
  return Math.round(fps);
}

/** Frame count (from 00:00:00:00) -> "HH:MM:SS:FF" (";" before frames for drop-frame). */
export function framesToTimecode(frames: number, fps: number): string {
  const nom = nominalFps(fps) || 24;
  let f = Math.max(0, Math.floor(frames));
  const drop = isDropFrame(fps);
  if (drop) {
    const dropFrames = nom === 60 ? 4 : 2;
    const perMin = nom * 60 - dropFrames;
    const per10 = perMin * 10 + dropFrames;
    const d = Math.floor(f / per10);
    const m = f % per10;
    f +=
      dropFrames * 9 * d +
      (m > dropFrames ? dropFrames * Math.floor((m - dropFrames) / perMin) : 0);
  }
  const ff = f % nom;
  const s = Math.floor(f / nom) % 60;
  const mi = Math.floor(f / (nom * 60)) % 60;
  const h = Math.floor(f / (nom * 3600)) % 24;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(mi)}:${p(s)}${drop ? ';' : ':'}${p(ff)}`;
}

/** Parses "HH:MM:SS:FF" (or ";" drop-frame) or a plain frame number. Returns frames or null. */
export function timecodeToFrames(tc: string, fps: number): number | null {
  const t = tc.trim();
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  const m = /^(\d{1,2})[:;.](\d{1,2})[:;.](\d{1,2})[:;.](\d{1,3})$/.exec(t);
  if (!m) return null;
  const [h, mi, s, f] = m.slice(1).map(Number);
  const nom = nominalFps(fps) || 24;
  let total = ((h * 60 + mi) * 60 + s) * nom + f;
  if (isDropFrame(fps)) {
    const dropFrames = nom === 60 ? 4 : 2;
    const totalMinutes = h * 60 + mi;
    total -= dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return total;
}
