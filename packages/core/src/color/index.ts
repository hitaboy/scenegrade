// SPDX-License-Identifier: Apache-2.0
// @scenegrade/core/color — ACES colour management (analytic inputs, OCIO-baked ACES 2.0 views).
export type { Vec3, Mat3 } from './math.js';
export { halfToFloat, floatToHalf } from './half.js';
export {
  type InputSpace,
  INPUT_SPACES,
  findInputSpace,
  inputToACEScg,
  inputTransformWGSL,
} from './inputs.js';
export {
  COMMON_WGSL,
  linToACEScct,
  acesCctToLin,
  acescgToACEScct,
  acescctToACEScg,
  srgbEotf,
  srgbOetf,
  pqEotf,
  pqOetf,
  hlgOetf,
  hlgInvOetf,
  hlgToNits,
  LUMA_AP1,
  LUMA_709,
  LUMA_2020,
} from './transfer.js';
export {
  type ViewInfo,
  type ViewLut,
  type DisplayEncoding,
  type DisplayPrimaries,
  VIEWS,
  VIEW_SHAPER,
  VIEWS_OCIO_CONFIG,
  ANALYTIC_VIEWS,
  findView,
  loadViewLut,
  applyViewCPU,
  applyAnalyticViewCPU,
  displayToNits,
} from './views.js';
export { MATRICES, OCIO_CONFIG, OCIO_VERSION } from './generated.js';
export {
  type CDL,
  CDL_IDENTITY,
  applyCDL,
  CDL_WGSL,
  type CubeLut,
  parseCubeLut,
  applyCubeCPU,
} from './grade.js';
export {
  type FalseColorBand,
  type IreBand,
  type FalseColorPreset,
  FALSE_COLOR_PRESETS,
  IRE_FALSE_COLOR,
  falseColorWGSL,
  falseColorCPU,
} from './falsecolor.js';
