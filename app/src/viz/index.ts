/** Public API of the visualizer. */
export { HurricaneView, type HurricaneViewProps } from './HurricaneView.tsx';
export { SpectrumView, type SpectrumViewProps } from './SpectrumView.tsx';
export type { FrameSource } from './frameStore.ts';
export {
  computeVisualState,
  toUniforms,
  DEFAULT_VIZ_OPTIONS,
  type Bound,
  type VisualState,
  type HurricaneUniforms,
  type VizOptions,
} from './bindings.ts';
export {
  hitTest,
  partAt,
  readoutFor,
  listParts,
  describeState,
  chanceInWords,
  EXCESS_NOTE,
  type Readout,
  type AlignmentRow,
  type StormPart,
} from './readout.ts';
export { HurricaneRenderer } from './hurricane.ts';
export { themeFromCss } from './theme.ts';
export {
  VIZ_SMOOTHING,
  VIZ_MAPPING,
  VIZ_GEOMETRY,
  VIZ_QUALITY,
  VIZ_PHOTOSAFE,
  VIZ_REDUCED_MOTION,
  VIZ_THEME,
  VIZ_THEME_CSS,
  type Quality,
  type Motion,
  type ChanceDriver,
  type VizTheme,
} from './params.ts';
