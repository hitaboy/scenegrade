import type { PlayerController } from './controller.svelte.js';

export interface Shortcut {
  keys: string;
  label: string;
  group: 'Playback' | 'View' | 'Analysis' | 'Panels';
}

export const SHORTCUTS: Shortcut[] = [
  { keys: 'Space', label: 'Play / pause', group: 'Playback' },
  { keys: 'J / K / L', label: 'Reverse / stop / forward (repeat to speed up)', group: 'Playback' },
  { keys: '← / →', label: 'Previous / next frame (Shift: 10 frames)', group: 'Playback' },
  { keys: 'Home / End', label: 'Go to in / out point', group: 'Playback' },
  { keys: 'I / O', label: 'Set in / out point (Alt: clear)', group: 'Playback' },
  { keys: 'M', label: 'Mute', group: 'Playback' },
  { keys: '0 / F', label: 'Fit image', group: 'View' },
  { keys: '1 / 2 / 4', label: 'Zoom 100% / 200% / 400%', group: 'View' },
  { keys: '+ / -', label: 'Zoom in / out', group: 'View' },
  { keys: '[ / ]', label: 'Exposure −/+ ½ stop (Shift: reset)', group: 'View' },
  {
    keys: 'R G B A Y',
    label: 'Show red / green / blue / alpha / luminance (again: RGB)',
    group: 'View',
  },
  { keys: 'B', label: 'Alpha background: black / checker / solid', group: 'View' },
  { keys: 'Tab', label: 'Clean view (hide UI)', group: 'View' },
  { keys: 'Shift+F', label: 'Fullscreen', group: 'View' },
  { keys: 'P', label: 'Pixel probe (Alt+click pins a sample)', group: 'Analysis' },
  { keys: 'X', label: 'False colour: off / stops / IRE', group: 'Analysis' },
  { keys: 'Z', label: 'Zebra', group: 'Analysis' },
  { keys: 'C', label: 'Clipping / crushed / NaN', group: 'Analysis' },
  { keys: 'Shift+P', label: 'Focus peaking', group: 'Analysis' },
  { keys: 'Shift+G', label: 'Safe areas & centre', group: 'Analysis' },
  { keys: 'W', label: 'Compare mode: wipe / side by side / difference / blend', group: 'Analysis' },
  { keys: 'S', label: 'Scopes panel', group: 'Panels' },
  { keys: '?', label: 'This help', group: 'Panels' },
];

/** Handles a keydown for the player. Returns true when handled. */
export function handleKey(
  ctl: PlayerController,
  e: KeyboardEvent,
  extra: { fullscreen?: () => void },
): boolean {
  const t = e.target as HTMLElement | null;
  if (
    t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'SELECT' ||
      t.tagName === 'TEXTAREA' ||
      t.isContentEditable)
  )
    return false;
  if (e.metaKey || e.ctrlKey) return false;
  const p = ctl.player;
  const s = ctl.settings;
  const k = e.key;
  const channel = (c: 'r' | 'g' | 'b' | 'a' | 'luma') =>
    ctl.update({ channel: s.channel === c ? 'rgb' : c });
  switch (k) {
    case ' ':
      p.toggle();
      break;
    case 'k':
    case 'K':
      p.pause();
      p.setSpeed(1);
      break;
    case 'l':
    case 'L': {
      const sp = ctl.state.playing && ctl.state.speed > 0 ? Math.min(8, ctl.state.speed * 2) : 1;
      p.setSpeed(sp);
      p.play();
      break;
    }
    case 'j':
    case 'J': {
      const sp = ctl.state.playing && ctl.state.speed < 0 ? Math.max(-8, ctl.state.speed * 2) : -1;
      p.setSpeed(sp);
      p.play();
      break;
    }
    case 'ArrowRight':
      p.step(e.shiftKey ? 10 : 1);
      break;
    case 'ArrowLeft':
      p.step(e.shiftKey ? -10 : -1);
      break;
    case 'Home':
      p.seek(ctl.state.inPoint);
      break;
    case 'End':
      p.seek(ctl.state.outPoint);
      break;
    case 'i':
    case 'I':
      p.setInOut(e.altKey ? null : ctl.state.frame, ctl.state.outPoint);
      break;
    case 'o':
    case 'O':
      p.setInOut(ctl.state.inPoint, e.altKey ? null : ctl.state.frame);
      break;
    case 'm':
    case 'M':
      p.setMuted(!ctl.state.muted);
      break;
    case '0':
      p.fit();
      break;
    case 'f':
      p.fit();
      break;
    case 'F':
      extra.fullscreen?.();
      break;
    case '1':
    case '2':
    case '4':
      p.zoomTo(parseInt(k, 10) * p.canvasDevicePixelRatio);
      break;
    case '+':
    case '=':
      p.zoomBy(1.25);
      break;
    case '-':
    case '_':
      p.zoomBy(0.8);
      break;
    case '[':
      ctl.update({ exposure: s.exposure - 0.5 });
      break;
    case ']':
      ctl.update({ exposure: s.exposure + 0.5 });
      break;
    case '{':
    case '}':
      ctl.update({ exposure: 0 });
      break;
    case 'r':
      channel('r');
      break;
    case 'g':
      channel('g');
      break;
    case 'b':
      channel('b');
      break;
    case 'a':
      channel('a');
      break;
    case 'y':
      channel('luma');
      break;
    case 'R':
    case 'Y':
      break;
    case 'B': {
      const next = { black: 'checker', checker: 'solid', solid: 'black' } as const;
      ctl.update({ background: next[s.background] });
      break;
    }
    case 'G':
      ctl.ui.guides = {
        ...ctl.ui.guides,
        safeAreas: !ctl.ui.guides.safeAreas,
        center: !ctl.ui.guides.safeAreas,
      };
      break;
    case 'A':
      return false;
    case 'p':
      ctl.ui.tool = ctl.ui.tool === 'probe' ? 'none' : 'probe';
      if (ctl.ui.tool === 'probe') ctl.ui.panelTab = 'info';
      break;
    case 'P':
      ctl.update({ peaking: { ...s.peaking, enabled: !s.peaking.enabled } });
      break;
    case 'x':
    case 'X': {
      const next = { off: 'stops', stops: 'ire', ire: 'off' } as const;
      ctl.update({ falseColor: next[s.falseColor] });
      break;
    }
    case 'z':
    case 'Z':
      ctl.update({ zebra: { ...s.zebra, high: !s.zebra.high } });
      break;
    case 'c':
    case 'C': {
      const on = !(s.clipping.over || s.clipping.under || s.clipping.nan);
      ctl.update({ clipping: { over: on, under: on, nan: on } });
      break;
    }
    case 'w':
    case 'W': {
      const order = ['wipe', 'side-by-side', 'difference', 'blend'] as const;
      const i = order.indexOf(s.compare.mode as (typeof order)[number]);
      ctl.update({ compare: { ...s.compare, mode: order[(i + 1) % order.length] } });
      p.fit();
      break;
    }
    case 's':
    case 'S':
      if (ctl.ui.panelOpen && ctl.ui.panelTab === 'scopes') ctl.ui.panelOpen = false;
      else {
        ctl.ui.panelOpen = true;
        ctl.ui.panelTab = 'scopes';
      }
      break;
    case 'Tab':
      ctl.ui.clean = !ctl.ui.clean;
      break;
    case '?':
      ctl.ui.help = !ctl.ui.help;
      break;
    case 'Escape':
      if (ctl.ui.help) ctl.ui.help = false;
      else if (ctl.ui.clean) ctl.ui.clean = false;
      else return false;
      break;
    default:
      return false;
  }
  return true;
}
