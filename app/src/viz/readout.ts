/**
 * Tap-to-inspect: which part of the storm is under a point, and which frame fields drive it.
 * Uses the same geometry as the shader (geometry.ts).
 */
import type { Cascade, Measured } from '../engine/frames.ts';
import { toUniforms, type Bound, type VisualState } from './bindings.ts';
import { armMaskAt, bandRadius, sideWeight } from './geometry.ts';
import { VIZ_GEOMETRY } from './params.ts';
import { reasonText } from './reasons.ts';

export const DESIGN_NOTE =
  'The spiral form is a design choice. What is measured: whether it forms, how many arms, ' +
  'how tightly they wind, how bright each one is, the ring, the eye, and the motion.';

export interface AlignmentRow {
  label: 'Golden ratio' | 'Octave';
  /** Field path prefix, e.g. slow.cascades.phi */
  field: string;
  steps: number;
  closeness: Measured;
  /** Chance A: the same number of peaks placed at random. */
  chanceA: Measured;
  chanceAp: Measured;
  /** Chance B: each track's own history, shifted in time. */
  chanceB: Measured;
  excessA: Measured;
  excessB: Measured;
  heldS: number;
  active: boolean;
}

export interface Readout {
  /** Stable id of the element, e.g. 'arm:1', 'eye', 'ring', 'calm'. */
  key: string;
  element: string;
  summary: string;
  bindings: Bound[];
  /** Golden ratio, octave and chance side by side (CLAUDE.md rule 3), or null if not relevant. */
  alignment: AlignmentRow[] | null;
  designNote: string;
}

function row(label: AlignmentRow['label'], field: string, c: Cascade, active: boolean): AlignmentRow {
  return {
    label, field, steps: c.steps, closeness: c.closeness, chanceA: c.chance.a.closeness, chanceAp: c.chance.a.p,
    chanceB: c.chance.b.closeness, excessA: c.excess_a, excessB: c.excess_b, heldS: c.held_s, active,
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
 * Hit-test a point in storm space (origin at the centre, unit = storm radius, y up, swell
 * already divided out).
 */
export function hitTest(s: VisualState, x: number, y: number): Readout {
  const u = toUniforms(s);
  const r = Math.hypot(x, y);
  const G = VIZ_GEOMETRY;
  const base = { designNote: DESIGN_NOTE };
  const anyStructure = u.armCount > 0.01 || u.bandCount > 0.01 || u.ring > 0.01 || u.eye > 0.01;

  if (!anyStructure) {
    return {
      ...base,
      key: 'calm',
      element: 'Calm water',
      summary: s.message ?? 'No structure is measured.',
      bindings: [s.rotation, s.armCount, s.ring, s.pulse, s.swell],
      alignment: alignmentRows(s),
    };
  }

  if (r < G.EYE_R * 0.9 && u.eye > 0.01) {
    return {
      ...base, key: 'eye', element: 'The eye',
      summary: 'The eye clears the longer the golden ratio cascade has held.',
      bindings: [s.eye], alignment: alignmentRows(s),
    };
  }
  if (Math.abs(r - G.EYE_WALL_R) < 0.05) {
    return {
      ...base, key: 'eyewall', element: 'The eye wall',
      summary: 'A pulse runs through the eye wall on each detected heartbeat.',
      bindings: [s.pulse, s.eye], alignment: null,
    };
  }
  if (u.ring > 0.01 && G.RING_RADII.some((rr) => Math.abs(r - rr) < G.RING_WIDTH * 1.6)) {
    return {
      ...base, key: 'ring', element: 'Octave ring',
      summary: 'The rings show octave alignment beyond chance. Golden ratio alignment winds the arms instead.',
      bindings: [s.ring], alignment: alignmentRows(s),
    };
  }

  // Rotating frame, as in the shader.
  const c = Math.cos(s.rotationPhase);
  const sn = Math.sin(s.rotationPhase);
  const qx = c * x + sn * y;
  const qy = -sn * x + c * y;
  const theta = Math.atan2(qy, qx) + 0.5 * sideWeight(x) * u.symmetry;
  const arm = armMaskAt(r, theta, u.armCount, u.winding);
  if (arm && arm.mask > 0.25) {
    const i = arm.index;
    const id = s.armTracks[i];
    return {
      ...base, key: `arm:${i}`,
      element: `Spiral arm ${i + 1}${id !== null ? ` (track ${id})` : ''}`,
      summary: 'One arm per track in the golden ratio cascade. Brightness is that track\'s height above background.',
      bindings: [s.arms[i], s.armCount, s.winding, s.rotation, s.symmetry],
      alignment: alignmentRows(s),
    };
  }

  if (u.bandCount > 0.01) {
    const n = Math.ceil(u.bandCount);
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      const d = Math.abs(r - bandRadius(j, u.bandCount));
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best >= 0 && bestD < 0.08) {
      const id = s.bandTracks[best];
      return {
        ...base, key: `band:${best}`,
        element: `Cloud band ${best + 1}${id !== null ? ` (track ${id})` : ''}`,
        summary: 'A confirmed rhythm that is not part of a golden ratio cascade: cloud with no spiral structure.',
        bindings: [s.bands[best], s.bandCount, s.rotation],
        alignment: alignmentRows(s),
      };
    }
  }

  if (r <= G.STORM_OUTER_R) {
    return {
      ...base, key: 'storm', element: 'The storm',
      summary: 'Rotation follows the strongest confirmed rhythm. The halves line up when the hemispheres match.',
      bindings: [s.rotation, s.symmetry, s.armCount, s.swell], alignment: alignmentRows(s),
    };
  }
  return {
    ...base, key: 'water', element: 'Water around the storm',
    summary: 'The whole picture swells gently with the measured breathing rhythm.',
    bindings: [s.swell, s.rotation], alignment: null,
  };
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
  return fmtNumber(b.measured, b.se, b.unit);
}
