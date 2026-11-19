/**
 * WGSL sources for the three GPU stages:
 *
 *  1. decode  : source pixels (RGBA half/float/8-bit, planar Y'CbCr, external frame) -> scene-linear ACEScg
 *               (runs once per frame / input-space change, result cached in an rgba16float texture)
 *  2. display : scene texture -> exposure, CDL, look LUT, ACES view transform (3D LUT), overlays -> canvas
 *  3. scopes  : compute shader building histogram / waveform / vectorscope from the same display chain
 *
 * Colour-space specific code (input transform, ACEScct shaper, CDL, false colour) is injected from the
 * colour module so the CPU reference implementation and the GPU agree.
 */

/** Uniform block shared by display + scopes. Keep in sync with `packDisplayUniforms` in renderer.ts. */
import { GRADE_BINDINGS_WGSL, GRADE_WGSL } from '../grade/wgsl.js';

export const DISPLAY_UNIFORMS_WGSL = /* wgsl */ `
struct U {
  canvas   : vec4f, // w, h, 1/w, 1/h (device pixels)
  xform    : vec4f, // zoom, panX, panY, pixelAspect
  imgA     : vec4f, // data window w, h, offset x, offset y (relative to display window)
  imgB     : vec4f,
  dispWin  : vec4f, // display window w, h, outline (0/1), outside dim
  grade    : vec4f, // exposure gain, display gamma, saturation, time (s)
  modes0   : vec4u, // channel, viewMode, outputMode, background
  modes1   : vec4u, // falseColor, zebra flags, clip flags, peaking
  modes2   : vec4u, // compareMode, userLutMode, cdlOn, nearest (1 = nearest filtering)
  zebra    : vec4f, // hi %, lo %, stripe px, lo band %
  compare  : vec4f, // wipe pos (0..1), wipe angle (rad), diff gain, blend
  cdlSlope : vec4f,
  cdlOffset: vec4f,
  cdlPower : vec4f, // w = saturation
  hdr      : vec4f, // reference white nits, view peak nits, 0, 0
  lut      : vec4f, // view LUT size, user LUT size, B ungraded (1 = compare with original), 0
  peakCol  : vec4f, // rgb, threshold
  bgCol    : vec4f, // viewer background (outside image)
  outM0    : vec4f, // display primaries -> canvas primaries (linear), rows
  outM1    : vec4f,
  outM2    : vec4f,
  rawM0    : vec4f, // AP1 -> Rec.709 linear (for "un-tone-mapped" view), rows
  rawM1    : vec4f,
  rawM2    : vec4f,
  dispB    : vec4f, // B display window w, h (B is scaled to A's display window)
};
`;

const HELPERS_WGSL = /* wgsl */ `
const R_LUMA_AP1 = vec3f(0.2722287168, 0.6740817658, 0.0536895174);
const R_LUMA_709 = vec3f(0.2126, 0.7152, 0.0722);

fn r_bad(x: f32) -> bool {
  // WGSL may assume no NaN/Inf; inspect the bit pattern instead of x != x.
  return (bitcast<u32>(x) & 0x7f800000u) == 0x7f800000u;
}
fn r_bad3(c: vec3f) -> bool { return r_bad(c.x) || r_bad(c.y) || r_bad(c.z); }
fn r_sanitize(c: vec3f) -> vec3f {
  return vec3f(select(c.x, 0.0, r_bad(c.x)), select(c.y, 0.0, r_bad(c.y)), select(c.z, 0.0, r_bad(c.z)));
}
fn r_srgb_oetf1(x: f32) -> f32 {
  let a = abs(x);
  let v = select(1.055 * pow(a, 1.0 / 2.4) - 0.055, a * 12.92, a <= 0.0031308);
  return sign(x) * v;
}
fn r_srgb_oetf(c: vec3f) -> vec3f { return vec3f(r_srgb_oetf1(c.x), r_srgb_oetf1(c.y), r_srgb_oetf1(c.z)); }
fn r_pq_eotf1(e: f32) -> f32 {
  let m1 = 0.1593017578125; let m2 = 78.84375; let c1 = 0.8359375; let c2 = 18.8515625; let c3 = 18.6875;
  let p = pow(clamp(e, 0.0, 1.0), 1.0 / m2);
  return 10000.0 * pow(max(p - c1, 0.0) / (c2 - c3 * p), 1.0 / m1);
}
fn r_pq_eotf(c: vec3f) -> vec3f { return vec3f(r_pq_eotf1(c.x), r_pq_eotf1(c.y), r_pq_eotf1(c.z)); }
fn r_mat(r0: vec4f, r1: vec4f, r2: vec4f, c: vec3f) -> vec3f {
  return vec3f(dot(r0.xyz, c), dot(r1.xyz, c), dot(r2.xyz, c));
}
`;

// ---------------------------------------------------------------------------------------------
// 1. Decode pass
// ---------------------------------------------------------------------------------------------

export type DecodeKind = 'rgba' | 'yuv' | 'external';

export function decodeShader(kind: DecodeKind, inputWGSL: string): string {
  const common = /* wgsl */ `
struct DU {
  size   : vec4f, // out w, h, 0, 0
  yuv    : vec4f, // bitDepth, fullRange, chroma (0=444,1=422,2=420), hasAlpha
  matrix : vec4f, // Kr, Kb, isRgb (1 = planes are G,B,R like 'rgb' matrix), applyInput
};
@group(0) @binding(0) var<uniform> du : DU;

struct VOut { @builtin(position) pos : vec4f };
@vertex fn vs(@builtin(vertex_index) i : u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o : VOut; o.pos = vec4f(p[i], 0.0, 1.0); return o;
}
${inputWGSL}
fn finish(rgb: vec3f, a: f32) -> vec4f {
  if (du.matrix.w > 0.5) { return vec4f(sl_input(rgb), a); }
  return vec4f(rgb, a);
}
`;
  if (kind === 'rgba') {
    return (
      common +
      /* wgsl */ `
@group(0) @binding(1) var src : texture_2d<f32>;
@fragment fn fs(v : VOut) -> @location(0) vec4f {
  let p = vec2i(v.pos.xy);
  let c = textureLoad(src, p, 0);
  return finish(c.rgb, c.a);
}`
    );
  }
  if (kind === 'external') {
    return (
      common +
      /* wgsl */ `
@group(0) @binding(1) var src : texture_external;
@group(0) @binding(2) var smp : sampler;
@fragment fn fs(v : VOut) -> @location(0) vec4f {
  let uv = v.pos.xy / du.size.xy;
  let c = textureSampleBaseClampToEdge(src, smp, uv);
  return finish(c.rgb, c.a);
}`
    );
  }
  // Planar Y'CbCr (8-bit planes uploaded as r8uint, 10/12-bit as r16uint).
  return (
    common +
    /* wgsl */ `
@group(0) @binding(1) var tY : texture_2d<u32>;
@group(0) @binding(2) var tU : texture_2d<u32>;
@group(0) @binding(3) var tV : texture_2d<u32>;
@group(0) @binding(4) var tA : texture_2d<u32>;

fn chromaAt(t: texture_2d<u32>, p: vec2i) -> f32 {
  let d = vec2i(textureDimensions(t));
  let chroma = u32(du.yuv.z);
  // Horizontal: co-sited (left) siting for 4:2:2 / 4:2:0. Vertical (4:2:0): centred siting.
  var fx = f32(p.x);
  var fy = f32(p.y);
  if (chroma >= 1u) { fx = f32(p.x) * 0.5; }
  if (chroma == 2u) { fy = (f32(p.y) + 0.5) * 0.5 - 0.5; }
  let x0 = i32(floor(fx)); let y0 = i32(floor(fy));
  let tx = fx - floor(fx); let ty = fy - floor(fy);
  let x1 = min(x0 + 1, d.x - 1); let y1 = min(y0 + 1, d.y - 1);
  let xa = clamp(x0, 0, d.x - 1); let ya = clamp(y0, 0, d.y - 1);
  let a = f32(textureLoad(t, vec2i(xa, ya), 0).r);
  let b = f32(textureLoad(t, vec2i(x1, ya), 0).r);
  let c = f32(textureLoad(t, vec2i(xa, max(y1, 0)), 0).r);
  let e = f32(textureLoad(t, vec2i(x1, max(y1, 0)), 0).r);
  return mix(mix(a, b, tx), mix(c, e, tx), ty);
}

@fragment fn fs(v : VOut) -> @location(0) vec4f {
  let p = vec2i(v.pos.xy);
  let bits = du.yuv.x;
  let scale = exp2(bits - 8.0);
  let maxCode = exp2(bits) - 1.0;
  let yc = f32(textureLoad(tY, p, 0).r);
  let uc = chromaAt(tU, p);
  let vc = chromaAt(tV, p);
  var Y : f32; var Cb : f32; var Cr : f32;
  if (du.yuv.y > 0.5) {
    Y = yc / maxCode; Cb = (uc - 128.0 * scale) / maxCode; Cr = (vc - 128.0 * scale) / maxCode;
  } else {
    Y = (yc - 16.0 * scale) / (219.0 * scale);
    Cb = (uc - 128.0 * scale) / (224.0 * scale);
    Cr = (vc - 128.0 * scale) / (224.0 * scale);
  }
  var rgb : vec3f;
  if (du.matrix.z > 0.5) {
    rgb = vec3f(Cr + 0.5, Y, Cb + 0.5); // planar GBR stored as Y=G, U=B, V=R
  } else {
    let kr = du.matrix.x; let kb = du.matrix.y; let kg = 1.0 - kr - kb;
    let r = Y + 2.0 * (1.0 - kr) * Cr;
    let b = Y + 2.0 * (1.0 - kb) * Cb;
    let g = (Y - kr * r - kb * b) / kg;
    rgb = vec3f(r, g, b);
  }
  var a = 1.0;
  if (du.yuv.w > 0.5) {
    let ac = f32(textureLoad(tA, p, 0).r);
    a = select((ac - 16.0 * scale) / (219.0 * scale), ac / maxCode, du.yuv.y > 0.5);
    a = clamp(a, 0.0, 1.0);
  }
  return finish(rgb, a);
}`
  );
}

// ---------------------------------------------------------------------------------------------
// 2. Display chain (shared by the display pass and the scopes)
// ---------------------------------------------------------------------------------------------

export interface ColorWgsl {
  /** COMMON_WGSL from the colour module (sl_acescg_to_acescct, sl_acescct_to_acescg, ...). */
  common: string;
  /** CDL helper (sl_cdl). */
  cdl: string;
  /** False colour helpers (sl_false_color(stops), sl_false_color_ire(ire)). */
  falseColor: string;
}

const BINDINGS_WGSL =
  /* wgsl */ `
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var sceneA : texture_2d<f32>;
@group(0) @binding(2) var sceneB : texture_2d<f32>;
@group(0) @binding(3) var viewLut : texture_3d<f32>;
@group(0) @binding(4) var userLut : texture_3d<f32>;
@group(0) @binding(5) var linSmp : sampler;
@group(0) @binding(6) var nearSmp : sampler;
` +
  GRADE_BINDINGS_WGSL +
  GRADE_WGSL;

const CHAIN_WGSL = /* wgsl */ `
fn lutCoord(c: vec3f, n: f32) -> vec3f {
  return clamp(c, vec3f(0.0), vec3f(1.0)) * ((n - 1.0) / n) + vec3f(0.5 / n);
}

/** False while shading the B side of a "compare with original" split (grade bypassed there). */
var<private> sl_gradeOn: bool = true;

/** Scene-referred grading applied before the view transform. Input/output: linear ACEScg. */
fn gradeScene(s: vec3f) -> vec3f {
  var c = s * u.grade.x;
  let sat = u.grade.z;
  if (sat != 1.0) {
    let y = dot(c, R_LUMA_AP1);
    c = vec3f(y) + (c - vec3f(y)) * sat;
  }
  if (sl_gradeOn) { c = sl_grade(c); }
  if (u.modes2.z == 1u || u.modes2.y == 1u) {
    var cct = sl_acescg_to_acescct(c);
    if (u.modes2.z == 1u) {
      cct = sl_cdl(cct, u.cdlSlope.xyz, u.cdlOffset.xyz, u.cdlPower.xyz, u.cdlPower.w);
    }
    if (u.modes2.y == 1u) {
      cct = textureSampleLevel(userLut, linSmp, lutCoord(cct, u.lut.y), 0.0).rgb;
    }
    c = sl_acescct_to_acescg(cct);
  }
  return c;
}

fn isolate(c: vec3f) -> vec3f {
  switch (u.modes0.x) {
    case 1u: { return vec3f(c.r); }
    case 2u: { return vec3f(c.g); }
    case 3u: { return vec3f(c.b); }
    case 5u: { return vec3f(dot(c, R_LUMA_AP1)); }
    default: { return c; }
  }
}

/** ACES view transform. Output: display signal (SDR 0..1 code values, or PQ signal for HDR views). */
fn viewTransform(c: vec3f) -> vec3f {
  switch (u.modes0.y) {
    case 1u: { return c; }                                   // raw
    case 2u: { return sl_acescg_to_acescct(c); }             // log (ACEScct)
    case 3u: { return sl_view_srgb_clamp(c); }                // un-tone-mapped (OCIO-matched matrix)
    default: {
      // Manual trilinear (textureLoad): hardware filtering quantises weights to ~8 bits.
      return sl_lut_trilinear(viewLut, c);
    }
  }
}

fn displayChain(scene: vec3f) -> vec3f {
  var d = viewTransform(isolate(gradeScene(r_sanitize(scene))));
  if (u.modes2.y == 2u) {
    d = textureSampleLevel(userLut, linSmp, lutCoord(d, u.lut.y), 0.0).rgb;
  }
  if (u.grade.y != 1.0) {
    d = pow(max(d, vec3f(0.0)), vec3f(1.0 / u.grade.y));
  }
  return d;
}
`;

export function displayShader(color: ColorWgsl): string {
  return (
    DISPLAY_UNIFORMS_WGSL +
    HELPERS_WGSL +
    color.common +
    color.cdl +
    color.falseColor +
    BINDINGS_WGSL +
    CHAIN_WGSL +
    /* wgsl */ `
struct VOut { @builtin(position) pos : vec4f };
@vertex fn vs(@builtin(vertex_index) i : u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o : VOut; o.pos = vec4f(p[i], 0.0, 1.0); return o;
}

/** Display signal -> canvas value. HDR views are decoded to linear and expressed relative to SDR white. */
fn toCanvas(d: vec3f) -> vec3f {
  if (u.modes0.z == 1u) {
    let lin = r_pq_eotf(d) / u.hdr.x;
    return r_srgb_oetf(r_mat(u.outM0, u.outM1, u.outM2, lin));
  }
  if (u.modes0.z == 2u) {
    let lin = sl_hlg_to_nits(d) / u.hdr.x;
    return r_srgb_oetf(r_mat(u.outM0, u.outM1, u.outM2, lin));
  }
  return d;
}

fn sampleScene(t: texture_2d<f32>, img: vec4f, p: vec2f) -> vec4f {
  // p: display-window pixel coordinates. Returns alpha = -1 outside the data window.
  let q = p - img.zw;
  if (q.x < 0.0 || q.y < 0.0 || q.x >= img.x || q.y >= img.y) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let uv = q / img.xy;
  if (u.modes2.w == 1u) {
    return textureLoad(t, vec2i(q), 0);
  }
  return textureSampleLevel(t, linSmp, uv, 0.0);
}

fn checker(p: vec2f) -> f32 {
  let c = floor(p / 12.0);
  return select(0.32, 0.42, (i32(c.x + c.y) & 1) == 0);
}

fn displayLuma(p: vec2f, which: u32) -> f32 {
  var s : vec4f;
  if (which == 0u) { s = sampleScene(sceneA, u.imgA, p); } else { s = sampleScene(sceneB, u.imgB, p * u.dispB.xy / u.dispWin.xy); }
  return dot(clamp(displayChain(s.rgb), vec3f(0.0), vec3f(1.0)), R_LUMA_709);
}

@fragment fn fs(v : VOut) -> @location(0) vec4f {
  let frag = v.pos.xy;
  let zoom = u.xform.x;
  // Canvas pixel -> display-window pixel.
  var p = vec2f((frag.x - u.xform.y) / (zoom * u.xform.w), (frag.y - u.xform.z) / zoom);
  let W = u.dispWin.x; let H = u.dispWin.y;

  var which = 0u;
  let cmp = u.modes2.x;
  if (cmp == 2u && p.x >= W) { which = 1u; p.x = p.x - W; }  // side by side: B to the right of A
  if (cmp == 1u) {
    // Wipe: oriented line through (wipe * W, H/2).
    let n = vec2f(cos(u.compare.y), sin(u.compare.y));
    let o = vec2f(u.compare.x * W, 0.5 * H);
    if (dot(p - o, n) > 0.0) { which = 1u; }
    let dist = abs(dot(p - o, n)) * zoom;
    if (dist < 1.0 && p.x >= 0.0 && p.y >= 0.0 && p.x < W && p.y < H) { return vec4f(1.0, 1.0, 1.0, 1.0); }
  }

  sl_gradeOn = !(which == 1u && u.lut.z > 0.5);
  let insideDisp = p.x >= 0.0 && p.y >= 0.0 && p.x < W && p.y < H;
  var s : vec4f;
  let pB = p * u.dispB.xy / vec2f(W, H);
  if (which == 0u) { s = sampleScene(sceneA, u.imgA, p); } else { s = sampleScene(sceneB, u.imgB, pB); }

  // Display window outline (1 device px).
  if (u.dispWin.z > 0.5) {
    let e = min(min(abs(p.x), abs(p.x - W)), min(abs(p.y), abs(p.y - H))) * zoom;
    let onEdge = e < 1.0 && p.x > -1.0 / zoom && p.y > -1.0 / zoom && p.x < W + 1.0 / zoom && p.y < H + 1.0 / zoom;
    if (onEdge) { return vec4f(0.55, 0.55, 0.55, 1.0); }
  }

  if (s.a < -0.5) {
    // Outside the data window.
    if (insideDisp) { return vec4f(u.bgCol.rgb * u.dispWin.w, 1.0); }
    return vec4f(u.bgCol.rgb, 1.0);
  }

  var scene = s.rgb;
  var alpha = s.a;
  let bad = r_bad3(scene);

  if (cmp == 3u) {
    // Difference A - B (raw, scaled).
    let sb = sampleScene(sceneB, u.imgB, pB);
    let diff = abs(r_sanitize(scene) - r_sanitize(sb.rgb)) * u.compare.z;
    return vec4f(clamp(diff, vec3f(0.0), vec3f(1.0)), 1.0);
  }
  if (cmp == 4u) {
    let sb = sampleScene(sceneB, u.imgB, pB);
    scene = mix(r_sanitize(scene), r_sanitize(sb.rgb), u.compare.w);
  }

  // Alpha channel view bypasses the colour pipeline.
  if (u.modes0.x == 4u) { return vec4f(vec3f(clamp(alpha, 0.0, 1.0)), 1.0); }

  let d = displayChain(scene);
  var out = toCanvas(d);

  // --- Analysis overlays -------------------------------------------------------------------
  let fc = u.modes1.x;
  if (fc == 1u) {
    let y = dot(r_sanitize(scene) * u.grade.x, R_LUMA_AP1);
    out = sl_false_color(log2(max(y, 1e-10) / 0.18));
  } else if (fc == 2u) {
    out = sl_false_color_ire(dot(clamp(d, vec3f(-0.1), vec3f(1.2)), R_LUMA_709) * 100.0);
  }

  let zf = u.modes1.y;
  if (zf != 0u) {
    let sig = max(d.r, max(d.g, d.b)) * 100.0;
    let luma = dot(d, R_LUMA_709) * 100.0;
    let w = u.zebra.z;
    let t = u.grade.w * 20.0;
    if ((zf & 1u) != 0u && sig >= u.zebra.x) {
      if (((frag.x + frag.y + t) % (2.0 * w)) < w) { out = vec3f(1.0); } else { out = vec3f(0.0); }
    } else if ((zf & 2u) != 0u && abs(luma - u.zebra.y) <= u.zebra.w) {
      if (((frag.x - frag.y + 4096.0 - t) % (2.0 * w)) < w * 0.6) { out = vec3f(0.85); }
    }
  }

  let cf = u.modes1.z;
  if ((cf & 1u) != 0u) {
    let over = vec3f(select(0.0, 1.0, d.r >= 0.999), select(0.0, 1.0, d.g >= 0.999), select(0.0, 1.0, d.b >= 0.999));
    if (any(over > vec3f(0.5))) { out = vec3f(1.0, 0.0, 0.0) * 0.0 + over; }
  }
  if ((cf & 2u) != 0u && all(d <= vec3f(0.0005))) { out = vec3f(0.0, 0.15, 1.0); }
  if ((cf & 4u) != 0u && bad) {
    let blink = select(vec3f(1.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), fract(u.grade.w * 2.0) < 0.5);
    out = blink;
  }

  if (u.modes1.w == 1u) {
    let px = 1.0 / zoom;
    let gx = displayLuma(p + vec2f(px, 0.0), which) - displayLuma(p - vec2f(px, 0.0), which);
    let gy = displayLuma(p + vec2f(0.0, px), which) - displayLuma(p - vec2f(0.0, px), which);
    if (sqrt(gx * gx + gy * gy) > u.peakCol.w) { out = u.peakCol.rgb; }
  }

  // --- Alpha / background --------------------------------------------------------------------
  let bgm = u.modes0.w;
  if (bgm == 1u) {
    let a = clamp(alpha, 0.0, 1.0);
    out = out + vec3f(checker(frag)) * (1.0 - a);
  } else if (bgm == 2u) {
    let a = clamp(alpha, 0.0, 1.0);
    out = out + u.bgCol.rgb * (1.0 - a);
  }
  return vec4f(out, 1.0);
}
`
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Scopes
// ---------------------------------------------------------------------------------------------

export const SCOPE_BINS = 256;
export const WAVEFORM_COLUMNS = 512;
export const VECTOR_BINS = 256;

export const SCOPE_UNIFORMS_WGSL = /* wgsl */ `
struct SU {
  grid  : vec4u, // grid w, grid h, histogram mode (0 display, 1 scene stops), waveform mode (0 luma, 1 rgb)
  range : vec4f, // waveform min, waveform max, stops min, stops max
};
`;

export function scopeComputeShader(color: ColorWgsl): string {
  return (
    DISPLAY_UNIFORMS_WGSL +
    SCOPE_UNIFORMS_WGSL +
    HELPERS_WGSL +
    color.common +
    color.cdl +
    BINDINGS_WGSL +
    CHAIN_WGSL +
    /* wgsl */ `
@group(1) @binding(0) var<uniform> su : SU;
@group(1) @binding(1) var<storage, read_write> hist : array<atomic<u32>>;   // 4 * 256 (R,G,B,Y)
@group(1) @binding(2) var<storage, read_write> wave : array<atomic<u32>>;   // 3 * 512 * 256
@group(1) @binding(3) var<storage, read_write> vect : array<atomic<u32>>;   // 256 * 256
@group(1) @binding(4) var<storage, read_write> stats : array<atomic<u32>>;  // max hist, max wave, max vect, samples

var<workgroup> lh : array<atomic<u32>, 1024>;

fn bin(v: f32, lo: f32, hi: f32, n: u32) -> u32 {
  let t = (v - lo) / (hi - lo);
  return u32(clamp(t * f32(n), 0.0, f32(n - 1u)));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3u, @builtin(local_invocation_index) li : u32) {
  for (var i = li; i < 1024u; i = i + 256u) { atomicStore(&lh[i], 0u); }
  workgroupBarrier();

  let inside = gid.x < su.grid.x && gid.y < su.grid.y;
  if (inside) {
    let dims = vec2f(textureDimensions(sceneA));
    let uv = (vec2f(gid.xy) + 0.5) / vec2f(su.grid.xy);
    let s = textureLoad(sceneA, vec2i(uv * dims), 0);
    let d = displayChain(s.rgb);
    let y709 = dot(d, R_LUMA_709);

    // Histogram (display signal or scene stops).
    if (su.grid.z == 0u) {
      atomicAdd(&lh[bin(d.r, 0.0, 1.0, 256u)], 1u);
      atomicAdd(&lh[256u + bin(d.g, 0.0, 1.0, 256u)], 1u);
      atomicAdd(&lh[512u + bin(d.b, 0.0, 1.0, 256u)], 1u);
      atomicAdd(&lh[768u + bin(y709, 0.0, 1.0, 256u)], 1u);
    } else {
      let c = max(gradeScene(r_sanitize(s.rgb)), vec3f(1e-10)) / 0.18;
      let st = log2(c);
      let ys = log2(max(dot(c, R_LUMA_AP1), 1e-10));
      atomicAdd(&lh[bin(st.r, su.range.z, su.range.w, 256u)], 1u);
      atomicAdd(&lh[256u + bin(st.g, su.range.z, su.range.w, 256u)], 1u);
      atomicAdd(&lh[512u + bin(st.b, su.range.z, su.range.w, 256u)], 1u);
      atomicAdd(&lh[768u + bin(ys, su.range.z, su.range.w, 256u)], 1u);
    }

    // Waveform: column from x position, row from signal level.
    let col = min(u32(uv.x * 512.0), 511u);
    let lo = su.range.x; let hi = su.range.y;
    if (su.grid.w == 0u) {
      let r = bin(y709, lo, hi, 256u);
      let m = atomicAdd(&wave[(col * 256u + r)], 1u);
      atomicMax(&stats[1], m + 1u);
    } else {
      let rr = bin(d.r, lo, hi, 256u); let rg = bin(d.g, lo, hi, 256u); let rb = bin(d.b, lo, hi, 256u);
      let a = atomicAdd(&wave[(col * 256u + rr)], 1u);
      let b = atomicAdd(&wave[131072u + (col * 256u + rg)], 1u);
      let c = atomicAdd(&wave[262144u + (col * 256u + rb)], 1u);
      atomicMax(&stats[1], max(a, max(b, c)) + 1u);
    }

    // Vectorscope (Rec.709 Cb/Cr of the display signal).
    let dc = clamp(d, vec3f(0.0), vec3f(1.0));
    let yy = dot(dc, R_LUMA_709);
    let cb = (dc.b - yy) / 1.8556;
    let cr = (dc.r - yy) / 1.5748;
    let vx = bin(cb, -0.5, 0.5, 256u);
    let vy = bin(-cr, -0.5, 0.5, 256u);
    let vm = atomicAdd(&vect[vy * 256u + vx], 1u);
    atomicMax(&stats[2], vm + 1u);
  }
  workgroupBarrier();
  for (var i = li; i < 1024u; i = i + 256u) {
    let n = atomicLoad(&lh[i]);
    if (n > 0u) {
      let t = atomicAdd(&hist[i], n) + n;
      if (i < 768u) { atomicMax(&stats[0], t); }
    }
  }
}
`
  );
}

/** Renders one scope buffer into its own canvas. Graticules/labels are drawn by the UI on top (SVG). */
export const SCOPE_RENDER_WGSL = /* wgsl */ `
struct RU {
  size  : vec4f, // canvas w, h, gain, kind (0 hist, 1 wave luma, 2 wave rgb overlay, 3 parade, 4 vector)
  extra : vec4f, // log scale (0/1), histogram channel mask bits, 0, 0
};
@group(0) @binding(0) var<uniform> ru : RU;
@group(0) @binding(1) var<storage, read> hist : array<u32>;
@group(0) @binding(2) var<storage, read> wave : array<u32>;
@group(0) @binding(3) var<storage, read> vect : array<u32>;
@group(0) @binding(4) var<storage, read> stats : array<u32>;

struct VOut { @builtin(position) pos : vec4f };
@vertex fn vs(@builtin(vertex_index) i : u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o : VOut; o.pos = vec4f(p[i], 0.0, 1.0); return o;
}

fn intensity(n: u32, mx: u32) -> f32 {
  if (n == 0u) { return 0.0; }
  let g = ru.size.z;
  let x = f32(n) / max(f32(mx), 1.0);
  return clamp(log2(1.0 + x * 255.0 * g) / 8.0, 0.0, 1.0);
}

@fragment fn fs(v : VOut) -> @location(0) vec4f {
  let uv = v.pos.xy / ru.size.xy;
  let kind = u32(ru.size.w);
  if (kind == 0u) {
    let b = min(u32(uv.x * 256.0), 255u);
    let h = 1.0 - uv.y;
    let mx = f32(max(stats[0], 1u));
    var c = vec3f(0.0);
    let mask = u32(ru.extra.y);
    for (var ch = 0u; ch < 4u; ch = ch + 1u) {
      if ((mask & (1u << ch)) == 0u) { continue; }
      var val = f32(hist[ch * 256u + b]) / mx;
      if (ru.extra.x > 0.5) { val = log2(1.0 + val * 1023.0) / 10.0; }
      if (h <= val) {
        if (ch == 0u) { c = c + vec3f(0.85, 0.2, 0.2); }
        if (ch == 1u) { c = c + vec3f(0.2, 0.8, 0.25); }
        if (ch == 2u) { c = c + vec3f(0.25, 0.4, 0.95); }
        if (ch == 3u) { c = c + vec3f(0.6, 0.6, 0.6); }
      }
    }
    return vec4f(min(c, vec3f(1.0)), 1.0);
  }
  if (kind == 4u) {
    let x = min(u32(uv.x * 256.0), 255u);
    let y = min(u32(uv.y * 256.0), 255u);
    // 3x3 max dilation so flat patches (one bin) stay visible.
    var n = 0u;
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      for (var dx = -1; dx <= 1; dx = dx + 1) {
        let xx = u32(clamp(i32(x) + dx, 0, 255));
        let yy = u32(clamp(i32(y) + dy, 0, 255));
        n = max(n, vect[yy * 256u + xx]);
      }
    }
    let i = intensity(n, stats[2]);
    // Tint each bin with the hue it represents (desaturated) for readability.
    let cb = (f32(x) + 0.5) / 256.0 - 0.5;
    let cr = -((f32(y) + 0.5) / 256.0 - 0.5);
    let rgb = clamp(vec3f(0.5 + 1.5748 * cr, 0.5 - 0.1873 * cb - 0.4681 * cr, 0.5 + 1.8556 * cb), vec3f(0.0), vec3f(1.0));
    return vec4f(mix(vec3f(0.75, 1.0, 0.75), rgb, 0.45) * i, 1.0);
  }
  // Waveforms
  let row = min(u32((1.0 - uv.y) * 256.0), 255u);
  if (kind == 3u) {
    // RGB parade: three side-by-side panels.
    let panel = min(u32(uv.x * 3.0), 2u);
    let lx = fract(uv.x * 3.0);
    let col = min(u32(lx * 512.0), 511u);
    let n = wave[panel * 131072u + col * 256u + row];
    let i = intensity(n, stats[1]);
    var tint = vec3f(1.0, 0.3, 0.3);
    if (panel == 1u) { tint = vec3f(0.3, 1.0, 0.35); }
    if (panel == 2u) { tint = vec3f(0.35, 0.5, 1.0); }
    return vec4f(tint * i, 1.0);
  }
  let col = min(u32(uv.x * 512.0), 511u);
  if (kind == 2u) {
    let r = intensity(wave[col * 256u + row], stats[1]);
    let g = intensity(wave[131072u + col * 256u + row], stats[1]);
    let b = intensity(wave[262144u + col * 256u + row], stats[1]);
    return vec4f(r, g, b, 1.0);
  }
  let i = intensity(wave[col * 256u + row], stats[1]);
  return vec4f(vec3f(0.55, 1.0, 0.6) * i, 1.0);
}
`;
