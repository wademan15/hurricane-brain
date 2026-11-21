/**
 * Tap-to-inspect: which part of the storm is under a point, and which frame fields drive it.
 * Uses the same geometry as the shader (geometry.ts).
 */
import type { Cascade, Measured } from '../engine/frames.ts';
import { toUniforms, type Bound, type VisualState } from './bindings.ts';
import { armMaskAt, bandRadius, sideWeight } from './geometry.ts';
import { VIZ_GEOMETRY } from './params.ts';
import { reasonText } from './reasons.ts';

/**
 * What an excess value means (spec 8.5 as revised after the fake test): 0 unless fewer than 5 in
 * 100 chance draws score as well; 1 = exact alignment. It is not a probability.
 */
export const EXCESS_NOTE = '0 unless fewer than 5 in 100 chance draws do as well, 1 = exact; not a probability';

export const DESIGN_NOTE =
  'The spiral form is a design choice. What is measured: whether it forms, how many arms, ' +
  'how tightly they wind, how bright each one is, the ring, the eye, whether golden ratio and ' +
  'octave occur together, and the motion.';

export interface AlignmentRow {
  label: 'Golden ratio' | 'Octave';
  /** Field path prefix, e.g. slow.cascades.phi */
  field: string;
  steps: number;
  closeness: Measured;
  /** Chance A: the same number of peaks placed at random. Typical closeness under chance. */
  chanceA: Measured;
  /** Fraction of chance-A surrogates scoring at least as well as observed. */
  chanceAp: Measured;
  /** Chance B: each track's own history, shifted in time. */
  chanceB: Measured;
  chanceBp: Measured;
  excessA: Measured;
  excessB: Measured;
  heldS: number;
  active: boolean;
}

export interface Readout {
  /** Stable id of the element, e.g. 'arm:1', 'eye', 'ring', 'calm', 'combined-wall'. */
  key: string;
  element: string;
  summary: string;
  /**
   * Plain-words chance comparison for golden ratio and octave, led by "as often as this by
   * chance", one line each. Empty when there is no slow frame.
   */
  chanceLines: string[];
  bindings: Bound[];
  /** Golden ratio, octave and chance side by side (CLAUDE.md rule 3), or null if not relevant. */
  alignment: AlignmentRow[] | null;
  /** The combined state (slow.states.both), or null when there is no slow frame. */
  both: { active: boolean; forS: number } | null;
  designNote: string;
}

function row(label: AlignmentRow['label'], field: string, c: Cascade, active: boolean): AlignmentRow {
  return {
    label, field, steps: c.steps, closeness: c.closeness,
    chanceA: c.chance.a.closeness, chanceAp: c.chance.a.p,
    chanceB: c.chance.b.closeness, chanceBp: c.chance.b.p,
    excessA: c.excess_a, excessB: c.excess_b, heldS: c.held_s, active,
  };
}

export function alignmentRows(s: VisualState): AlignmentRow[] | null {
  if (!s.slow) return null;
  return [
    row('Golden ratio', 'slow.cascades.phi', s.slow.cascades.phi, s.slow.states.phi.active),
    row('Octave', 'slow.cascades.octave', s.slow.cascades.octave, s.slow.states.octave.active),
  ];
}

/**
 * A p-value in plain words: how often chance scores at least this well. Never phrased as the
 * probability that the alignment is real.
 */
export function chanceInWords(p: Measured): string {
  if (p.v === null) return p.why === 'ok' ? 'not measured' : `not measured (${reasonText(p.why)})`;
  const pct = p.v * 100;
  if (pct < 0.5) return 'fewer than 1 in 100';
  if (pct > 99.5) return '100 in 100';
  return `${Math.round(pct)} in 100`;
}

/** One line per target: the chance comparison first, the alignment value beside it. */
export function chanceLines(s: VisualState): string[] {
  const rows = alignmentRows(s);
  if (!rows) return [];
  const drv = s.options.chance;
  return rows.map((r) => {
    const p = drv === 'a' ? r.chanceAp : r.chanceBp;
    const which = drv === 'a' ? 'random peaks (chance A)' : 'own wandering (chance B)';
    return `${r.label}: as often as this by chance: ${chanceInWords(p)}, by ${which}. ` +
      `Alignment ${fmtMeasured(r.closeness)}, typical by chance ${fmtMeasured(drv === 'a' ? r.chanceA : r.chanceB)}.`;
  });
}

function bothInfo(s: VisualState): Readout['both'] {
  return s.slow ? { active: s.slow.states.both.active, forS: s.slow.states.both.for_s } : null;
}

const SYMMETRY_NOTE =
  'Left and right match combines frequency, amplitude balance and phase locking between TP9 and TP10. ' +
  'All channels share one reference electrode (the shared reference), which inflates the locking part, so this is not a measure ' +
  'of synchrony between the hemispheres.';

function hasStructure(s: VisualState): boolean {
  const u = toUniforms(s);
  return u.armCount > 0.01 || u.bandCount > 0.01 || u.ring > 0.01 || u.eye > 0.01 || u.both > 0.01;
}

/**
 * Which part of the storm is under a point in storm space (origin at the centre, unit = storm
 * radius, y up, swell already divided out). Returns a part key for `readoutFor`.
 */
export function partAt(s: VisualState, x: number, y: number): string {
  const u = toUniforms(s);
  const r = Math.hypot(x, y);
  const G = VIZ_GEOMETRY;
  if (!hasStructure(s)) return 'calm';
  if (r < G.EYE_R * 0.9 && u.eye > 0.01) return 'eye';
  if (Math.abs(r - G.EYE_WALL_R) < 0.05) return u.both > 0.01 ? 'combined-wall' : 'eyewall';

  // Rotating frame, as in the shader.
  const c = Math.cos(s.rotationPhase);
  const sn = Math.sin(s.rotationPhase);
  const qx = c * x + sn * y;
  const qy = -sn * x + c * y;
  const theta = Math.atan2(qy, qx) + 0.5 * sideWeight(x) * u.symmetry;
  const arm = armMaskAt(r, theta, u.armCount, u.winding);
  const onRing = G.RING_RADII.some((rr) => Math.abs(r - rr) < G.RING_WIDTH * 1.6);
  if (u.both > 0.01 && onRing && arm && arm.mask > 0.25) return 'bead';
  if (u.ring > 0.01 && onRing) return 'ring';
  if (arm && arm.mask > 0.25) return `arm:${arm.index}`;
  if (u.bandCount > 0.01) {
    const n = Math.ceil(u.bandCount);
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      const d = Math.abs(r - bandRadius(j, u.bandCount));
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best >= 0 && bestD < 0.08) return `band:${best}`;
  }
  return r <= G.STORM_OUTER_R ? 'storm' : 'water';
}

/** The readout for a part key. Re-run it on newer states to keep an open readout live. */
export function readoutFor(s: VisualState, key: string): Readout {
  const base = { key, designNote: DESIGN_NOTE, chanceLines: chanceLines(s), both: bothInfo(s) };
  const combinedBindings = [s.combined, s.combinedStrength, s.combinedHeld];
  const [kind, idxRaw] = key.split(':');
  const idx = Number(idxRaw ?? 0);
  switch (kind) {
    case 'eye':
      return {
        ...base, element: 'The eye',
        summary: 'The eye clears the longer the golden ratio cascade has held.',
        bindings: [s.eye], alignment: alignmentRows(s),
      };
    case 'combined-wall':
      return {
        ...base, element: 'Shared eye wall (both at once)',
        summary: 'Golden ratio and octave alignment are both active. The eye wall becomes one shared warm ring; ' +
          'it grows clearer the longer both hold together. It also carries the heartbeat pulse.',
        bindings: [...combinedBindings, s.pulse], alignment: alignmentRows(s),
      };
    case 'eyewall':
      return {
        ...base, element: 'The eye wall',
        summary: 'A pulse runs through the eye wall on each detected heartbeat.',
        bindings: [s.pulse, s.eye], alignment: null,
      };
    case 'bead':
      return {
        ...base, element: 'Where an arm crosses a ring (both at once)',
        summary: 'With golden ratio and octave alignment both active, the spiral arms and the octave rings interlock: ' +
          'these bright points are where they cross. Their brightness is the weaker of the two alignments beyond chance.',
        bindings: [...combinedBindings, s.winding, s.ring], alignment: alignmentRows(s),
      };
    case 'ring':
      return {
        ...base, element: 'Octave rings',
        summary: 'The rings show octave alignment beyond chance. Golden ratio alignment winds the arms instead.',
        bindings: [s.ring], alignment: alignmentRows(s),
      };
    case 'arm': {
      const id = s.armTracks[idx] ?? null;
      return {
        ...base, element: `Spiral arm ${idx + 1}${id !== null ? ` (track ${id})` : ''}`,
        summary: 'One arm per track in the golden ratio cascade. Brightness is that track\'s height above background.',
        bindings: [s.arms[idx], s.armCount, s.winding, s.rotation, s.symmetry],
        alignment: alignmentRows(s),
      };
    }
    case 'band': {
      const id = s.bandTracks[idx] ?? null;
      return {
        ...base, element: `Cloud band ${idx + 1}${id !== null ? ` (track ${id})` : ''}`,
        summary: 'A confirmed rhythm that is not part of a golden ratio cascade: cloud with no spiral structure.',
        bindings: [s.bands[idx], s.bandCount, s.rotation],
        alignment: alignmentRows(s),
      };
    }
    case 'storm':
      return {
        ...base, element: 'The storm as a whole',
        summary: `Rotation follows the strongest confirmed rhythm. ${SYMMETRY_NOTE}`,
        bindings: [s.rotation, s.symmetry, s.armCount, s.combined, s.swell], alignment: alignmentRows(s),
      };
    case 'water':
      return {
        ...base, element: 'Water around the storm',
        summary: 'The whole picture swells gently with the measured breathing rhythm.',
        bindings: [s.swell, s.rotation], alignment: null,
      };
    default:
      return {
        ...base, key: 'calm', element: 'Calm water',
        summary: s.message ?? 'No structure is measured.',
        bindings: [s.rotation, s.armCount, s.ring, s.combined, s.pulse, s.swell],
        alignment: alignmentRows(s),
      };
  }
}

/** Tap-to-inspect: the readout for whatever is under the point. */
export function hitTest(s: VisualState, x: number, y: number): Readout {
  return readoutFor(s, partAt(s, x, y));
}

export interface StormPart {
  key: string;
  /** Accessible name: the part and the measurement bound to it. */
  name: string;
}

function short(b: Bound): string {
  if (b.measured === null) return 'not measured';
  if (b.unit === 'on/off') return b.measured ? 'on' : 'off';
  if (b.field.includes('excess')) return `${b.measured.toFixed(2)} beyond chance`;
  return fmtNumber(b.measured, b.se, b.unit);
}

/**
 * The parts present now, for keyboard access. Each opens the same readout as tapping it.
 * Names carry the bound measurement.
 */
export function listParts(s: VisualState): StormPart[] {
  if (!hasStructure(s)) return [{ key: 'calm', name: `Calm water: ${s.message ?? 'no structure measured'}` }];
  const u = toUniforms(s);
  const out: StormPart[] = [];
  if (u.eye > 0.01) out.push({ key: 'eye', name: `Eye: golden ratio cascade held ${short(s.eye)}` });
  if (u.both > 0.01) {
    out.push({ key: 'combined-wall', name: `Shared eye wall, both at once: for ${short(s.combinedHeld)}` });
    out.push({ key: 'bead', name: `Arms crossing rings, both at once: strength ${short(s.combinedStrength)}` });
  } else {
    out.push({ key: 'eyewall', name: `Eye wall: heartbeat ${s.pulse.measured === null ? 'not measured' : `interval ${s.pulse.measured} ms`}` });
  }
  const nArms = Math.round(u.armCount);
  for (let i = 0; i < nArms; i++) {
    const id = s.armTracks[i];
    out.push({ key: `arm:${i}`, name: `Spiral arm ${i + 1}${id !== null ? `, track ${id}` : ''}: ${short(s.arms[i])} above background` });
  }
  if (u.ring > 0.01) out.push({ key: 'ring', name: `Octave rings: ${short(s.ring)}` });
  const nBands = Math.round(u.bandCount);
  for (let j = 0; j < nBands; j++) {
    const id = s.bandTracks[j];
    out.push({ key: `band:${j}`, name: `Cloud band ${j + 1}${id !== null ? `, track ${id}` : ''}: ${short(s.bands[j])} above background` });
  }
  out.push({ key: 'storm', name: `Whole storm: rotation ${short(s.rotation)}, left and right match ${short(s.symmetry)}` });
  if (s.swell.measured !== null) out.push({ key: 'water', name: 'Swell: measured breathing rhythm' });
  return out;
}

/**
 * One sentence for the picture's text alternative and the polite live region. Built from
 * structure only (counts and states, no fast-changing numbers), so it changes only when the
 * measured state changes.
 */
export function describeState(s: VisualState): string {
  if (s.mode === 'calm' && !s.slow?.states.both.active) {
    return s.message === 'No data' ? 'Hurricane: no data.' : `Hurricane: ${s.message ?? 'calm water'}.`;
  }
  const slow = s.slow;
  const phiN = slow ? slow.cascades.phi.tracks.length : 0;
  const octN = slow ? slow.cascades.octave.tracks.length : 0;
  const phiPart = s.mode === 'storm'
    ? `golden ratio chain of ${phiN} peaks, ${slow?.states.phi.active ? 'holding' : 'not holding'}`
    : 'golden ratio: none';
  const octPart = octN >= 2 && (s.ring.measured ?? 0) > 0
    ? `octave chain of ${octN} peaks, ${slow?.states.octave.active ? 'holding' : 'not holding'}`
    : 'octave: none';
  const both = slow?.states.both.active ? '; both at once' : '';
  const nBands = Math.round(s.bandCount.measured ?? 0);
  const others = nBands > 0 ? `; ${nBands} rhythm${nBands === 1 ? '' : 's'} outside the golden ratio chain` : '';
  const sentence = `${phiPart}; ${octPart}${both}${others}.`;
  return `Hurricane: ${sentence}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function digits(x: number): number {
  const a = Math.abs(x);
  return a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
}

export function fmtNumber(v: number, se: number | null | undefined, unit: string): string {
  const d = se != null && se > 0
    ? Math.max(0, Math.min(4, 1 - Math.floor(Math.log10(se))))
    : Number.isInteger(v) ? 0 : digits(v);
  const val = v.toFixed(d);
  const pm = se != null && se > 0 ? ` ± ${se.toFixed(d)}` : '';
  const un = unit && unit !== '0..1' ? ` ${unit}` : '';
  return `${val}${pm}${un}`;
}

export function fmtMeasured(m: Measured, unit = ''): string {
  if (m.v === null) return m.why === 'ok' ? 'not measured' : `not measured (${reasonText(m.why)})`;
  return fmtNumber(m.v, m.se, unit);
}

export function fmtBound(b: Bound): string {
  if (b.measured === null) return b.why === 'ok' ? 'not measured' : `not measured (${reasonText(b.why)})`;
  if (b.unit === 'on/off') return b.measured ? 'on' : 'off';
  if (b.unit === '0..1' && b.field.includes('excess')) {
    // Excess is a rescaled score, not a probability: say so wherever it appears.
    return `${fmtNumber(b.measured, b.se, '')} beyond chance (${EXCESS_NOTE})`;
  }
  return fmtNumber(b.measured, b.se, b.unit);
}
