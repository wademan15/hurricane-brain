/**
 * Child profiles (spec 5.4 and 15). One place for everything that differs for a child.
 *
 * - `CHILD_ENGINE_PARAMS`: the engine's "child" preset (`Params::preset("child")` in
 *   crates/hb-engine/src/params.rs), by parameter name. `EngineConfig.params` accepts individual
 *   names only, not a preset name, so the documented values are copied here and nowhere else.
 *   It raises the plausibility limit on amplitude to 200 microvolts (provisional, spec 5.4) and
 *   combines with any response speed. If the engine's preset changes, change it here too.
 * - The individual alpha frequency must be set before band-based programs or the chance level are
 *   relied on (spec 5.4): `needsIaf`.
 */
import type { Program, UserProfile } from '../../training';
import type { AgeGroup, Appearance } from '../../storage';

export const CHILD_ENGINE_PARAMS: Record<string, number> = { quality_sd_max_uv: 200 };

export const isChild = (ageGroup: AgeGroup | null | undefined): boolean => ageGroup === 'child';

/** The individual alpha frequency from the most recent calibration, or null when none has measured one. */
export function profileIaf(profile: UserProfile | null | undefined): number | null {
  const cal = profile?.calibrations.at(-1);
  return cal && cal.iafHz !== null && Number.isFinite(cal.iafHz) ? cal.iafHz : null;
}

/** Programs that read the headset to train (everything but the calibration and profiling programs that find the IAF). */
export function readsBandsOrChance(p: Program): boolean {
  return p.requires.eeg && p.family !== 'calibration' && p.family !== 'profiling';
}

/** True when this child must run the calibration first for this program. */
export function needsIaf(p: Program, ageGroup: AgeGroup | null | undefined, profile: UserProfile | null | undefined): boolean {
  return isChild(ageGroup) && readsBandsOrChance(p) && profileIaf(profile) === null;
}

export const NEEDS_IAF_TEXT = 'For a child, run the Calibration program first. It finds the alpha rhythm that the bands and the chance level are tuned to.';

/** Whether the simple live view is on, from the setting and the person. */
export function simpleViewOn(appearance: Pick<Appearance, 'kidView'>, ageGroup: AgeGroup | null | undefined): boolean {
  return appearance.kidView === 'on' || (appearance.kidView === 'auto' && isChild(ageGroup));
}
