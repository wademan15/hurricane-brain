/**
 * The cascade event log. A stretch in which the golden ratio state, the octave state, or both at
 * once, was active becomes one event with its start, duration, member bands and frequencies,
 * the measured ratios between neighbouring members, and the chance levels alongside.
 *
 * Everything in an event is copied from slow frames. Nothing is averaged or invented: the
 * snapshot is the last frame in which the state was active, and a value that frame did not
 * measure is stored as null with its reason. A gap in the frames ends an open event at the last
 * frame that showed it active.
 */
import type { Cascade, Measured, SlowFrame } from '../../engine/frames';
import type { CascadeEvent, CascadeMember, CascadeSnapshot, KeyCell } from '../../storage/types';

/** A slow frame is expected four times a second. Longer than this without one is a gap. */
const GAP_S = 2;

type Kind = 'phi' | 'octave' | 'both';

const cell = (m: Measured | null | undefined): KeyCell => (m ? { v: m.v, why: m.v === null && m.why === 'ok' ? 'no_data' : m.why } : { v: null, why: 'no_data' });

function member(f: SlowFrame, id: number): CascadeMember {
  const tr = f.tracks.find((t) => t.id === id);
  return { id, band: tr?.band ?? 'unknown', freqHz: cell(tr?.freq_integrated) };
}

/** Measured frequency ratio of one step: hi over lo, from the members' integrated frequencies. */
function stepRatio(lo: CascadeMember, hi: CascadeMember): KeyCell {
  if (lo.freqHz.v === null || hi.freqHz.v === null || lo.freqHz.v <= 0) return { v: null, why: lo.freqHz.v === null ? lo.freqHz.why : hi.freqHz.why };
  return { v: hi.freqHz.v / lo.freqHz.v, why: 'ok' };
}

function snapshot(f: SlowFrame, c: Cascade, maxSteps: number): CascadeSnapshot {
  const members = c.tracks.map((id) => member(f, id));
  const ratios: KeyCell[] = [];
  for (let i = 1; i < members.length; i++) ratios.push(stepRatio(members[i - 1], members[i]));
  return {
    target: c.target, members, steps: c.steps, maxSteps, ratios,
    closeness: cell(c.closeness), chanceA: cell(c.chance.a.closeness), chanceB: cell(c.chance.b.closeness), pA: cell(c.chance.a.p),
    excessA: cell(c.excess_a), excessB: cell(c.excess_b),
  };
}

interface Open {
  kind: Kind;
  tStart: number;
  lastActiveT: number;
  parts: CascadeSnapshot[];
  maxSteps: { phi: number; octave: number };
}

export class CascadeLogger {
  readonly events: CascadeEvent[] = [];
  private open: Partial<Record<Kind, Open>> = {};
  private lastT: number | null = null;

  push(f: SlowFrame): void {
    if (this.lastT !== null && f.t - this.lastT > GAP_S) this.closeAll(this.lastT);
    if (this.lastT !== null && f.t < this.lastT) return;
    this.lastT = f.t;
    const active: Record<Kind, boolean> = { phi: f.states.phi.active, octave: f.states.octave.active, both: f.states.both.active };
    for (const kind of ['phi', 'octave', 'both'] as const) {
      const o = this.open[kind];
      if (active[kind]) {
        const cur = o ?? { kind, tStart: f.t, lastActiveT: f.t, parts: [], maxSteps: { phi: 0, octave: 0 } };
        cur.lastActiveT = f.t;
        cur.maxSteps.phi = Math.max(cur.maxSteps.phi, f.cascades.phi.steps);
        cur.maxSteps.octave = Math.max(cur.maxSteps.octave, f.cascades.octave.steps);
        cur.parts = kind === 'phi'
          ? [snapshot(f, f.cascades.phi, cur.maxSteps.phi)]
          : kind === 'octave'
            ? [snapshot(f, f.cascades.octave, cur.maxSteps.octave)]
            : [snapshot(f, f.cascades.phi, cur.maxSteps.phi), snapshot(f, f.cascades.octave, cur.maxSteps.octave)];
        this.open[kind] = cur;
      } else if (o) {
        this.close(kind, o.lastActiveT);
      }
    }
  }

  /** End every open event (the session ended). The event ends at its last active frame. */
  finish(): CascadeEvent[] {
    this.closeAll(this.lastT ?? 0);
    return this.events;
  }

  private closeAll(_t: number): void {
    for (const kind of ['phi', 'octave', 'both'] as const) {
      const o = this.open[kind];
      if (o) this.close(kind, o.lastActiveT);
    }
  }

  private close(kind: Kind, tEnd: number): void {
    const o = this.open[kind];
    if (!o) return;
    delete this.open[kind];
    this.events.push({ kind, tStart: o.tStart, tEnd, durationS: tEnd - o.tStart, parts: o.parts });
    this.events.sort((a, b) => a.tStart - b.tStart);
  }
}
