import { describe, expect, it } from 'vitest';
import type { Frame } from '../../engine/frames.ts';
import { computeVisualState, toUniforms, type VisualState } from '../bindings.ts';
import { applyFrame, EMPTY_SNAPSHOT, type FrameSnapshot } from '../frameStore.ts';
import {
  brightnessFromDb,
  eyeClarityFromHeld,
  symmetryOffsetFromMatch,
  windingFromExcess,
} from '../geometry.ts';
import { VIZ_MAPPING, VIZ_SMOOTHING } from '../params.ts';
import { hitTest } from '../readout.ts';
import {
  allNullSlow,
  bandsOnly,
  heartFrame,
  nullHeart,
  octaveCascadeFrame,
  phiCascadeFrame,
} from './fixtures.ts';

const MIN = VIZ_SMOOTHING.PULSE_MIN_INTERVAL_S;
const T = VIZ_SMOOTHING.RAMP_S;

/** Feed frames at wall times and step the bindings at 60 fps up to `until`. */
function run(schedule: { at: number; frame: Frame }[], until: number, start = 0): VisualState {
  let snap: FrameSnapshot = EMPTY_SNAPSHOT;
  let s: VisualState | null = null;
  let k = 0;
  const sorted = [...schedule].sort((a, b) => a.at - b.at);
  const times: number[] = [];
  for (let i = 0; start + i / 60 < until; i++) times.push(start + i / 60);
  times.push(until);
  for (const now of times) {
    while (k < sorted.length && sorted[k].at <= now) {
      snap = applyFrame(snap, sorted[k].frame, sorted[k].at, MIN);
      k++;
    }
    s = computeVisualState(s, snap, now);
  }
  return s!;
}

/** The same frame delivered every 250 ms from 0 to `until`. */
function steady(make: (t: number) => Frame, until: number): { at: number; frame: Frame }[] {
  const out = [];
  for (let at = 0; at <= until; at += 0.25) out.push({ at, frame: make(at) });
  return out;
}

describe('binding table: each visual parameter equals its bound field', () => {
  const s = run(steady((t) => phiCascadeFrame(t), 3), 3);
  const f = phiCascadeFrame(0);
  const tr = (id: number) => f.tracks.find((x) => x.id === id)!;

  it('forms a storm', () => {
    expect(s.mode).toBe('storm');
    expect(s.message).toBeNull();
  });

  it('rotation speed <- frequency of the dominant confirmed track', () => {
    expect(s.rotation.field).toBe('slow.tracks[id=3].freq');
    expect(s.rotation.measured).toBe(tr(3).freq.v);
    expect(s.rotation.value).toBe(tr(3).freq.v);
    expect(s.rotation.se).toBe(tr(3).freq.se);
  });

  it('number of arms <- number of tracks in cascades.phi', () => {
    expect(s.armCount.field).toBe('slow.cascades.phi.tracks.length');
    expect(s.armCount.value).toBe(f.cascades.phi.tracks.length);
    expect(toUniforms(s).armCount).toBe(4);
  });

  it('winding <- cascades.phi.excess_a', () => {
    expect(s.winding.field).toBe('slow.cascades.phi.excess_a');
    expect(s.winding.value).toBe(f.cascades.phi.excess_a.v);
    expect(toUniforms(s).winding).toBeCloseTo(windingFromExcess(0.8), 12);
  });

  it('ring <- cascades.octave.excess_a', () => {
    expect(s.ring.field).toBe('slow.cascades.octave.excess_a');
    expect(s.ring.value).toBe(f.cascades.octave.excess_a.v);
  });

  it('brightness of each arm <- that track height_db', () => {
    const u = toUniforms(s);
    f.cascades.phi.tracks.forEach((id, i) => {
      expect(s.arms[i].field).toBe(`slow.tracks[id=${id}].height_db`);
      expect(s.armTracks[i]).toBe(id);
      expect(s.arms[i].value).toBe(tr(id).height_db.v);
      expect(u.armBrightness[i]).toBeCloseTo(brightnessFromDb(tr(id).height_db.v!), 12);
    });
    for (let i = 4; i < s.arms.length; i++) expect(u.armBrightness[i]).toBe(0);
  });

  it('eye clarity <- cascades.phi.held_s', () => {
    expect(s.eye.field).toBe('slow.cascades.phi.held_s');
    expect(s.eye.value).toBe(40);
    expect(toUniforms(s).eye).toBeCloseTo(eyeClarityFromHeld(40), 12);
  });

  it('left/right symmetry <- hemispheres[track=dominant].match', () => {
    expect(s.symmetry.field).toBe('slow.hemispheres[track=3].match');
    expect(s.symmetry.value).toBe(0.85);
    expect(toUniforms(s).symmetry).toBeCloseTo(symmetryOffsetFromMatch(0.85), 12);
  });

  it('cascade members are arms, so no band duplicates them', () => {
    expect(s.bandCount.value).toBe(0);
  });
});

describe('heart bindings', () => {
  it('a measured Beat pulses the eye wall, then the pulse ends exactly at 0', () => {
    const sched = [
      { at: 0, frame: phiCascadeFrame(0) as Frame },
      { at: 0.5, frame: heartFrame(0.5, [{ t: 0.45, ibi: 980 }], 1.0) },
    ];
    const during = run(sched, 0.5 + VIZ_SMOOTHING.PULSE_S * 0.25);
    expect(during.pulse.value).toBeGreaterThan(0.5);
    expect(during.pulse.measured).toBe(980);
    expect(during.pulse.field).toBe('heart.beats[t=0.450]');
    const after = run(sched, 0.5 + VIZ_SMOOTHING.PULSE_S + 0.05);
    expect(after.pulse.value).toBe(0);
  });

  it('a repeated heart frame does not pulse again', () => {
    const hf = heartFrame(0.5, [{ t: 0.45, ibi: 980 }], 1.0);
    const sched = [
      { at: 0.5, frame: hf as Frame },
      { at: 1.5, frame: hf as Frame },
    ];
    expect(run(sched, 1.6).pulse.value).toBe(0);
  });

  it('beats faster than 3 per second cannot restart the pulse sooner than the minimum interval', () => {
    let snap = EMPTY_SNAPSHOT;
    snap = applyFrame(snap, heartFrame(1, [{ t: 1, ibi: 300 }], 0), 1, MIN);
    snap = applyFrame(snap, heartFrame(1.2, [{ t: 1.2, ibi: 200 }], 0), 1.2, MIN);
    expect(snap.lastBeat!.receivedAt).toBe(1);
    expect(snap.lastBeat!.beat.t).toBe(1.2);
  });

  it('slow swell <- breath_phase', () => {
    const s = run([{ at: 0, frame: heartFrame(0, [], 1.2) }], 1);
    expect(s.swell.field).toBe('heart.breath_phase');
    expect(s.swell.value).toBeCloseTo(1.2, 12);
    expect(toUniforms(s).swell).toBeCloseTo(1 + VIZ_MAPPING.SWELL_AMPLITUDE * Math.cos(1.2), 12);
  });
});

describe('null in -> calm out', () => {
  it('all-null frames give calm water with the reason', () => {
    const s = run([...steady((t) => allNullSlow(t), 2), { at: 0, frame: nullHeart(0) }, { at: 1, frame: nullHeart(1) }], 2);
    expect(s.mode).toBe('calm');
    expect(s.message).toBe('Calm water: poor sensor contact');
    for (const b of [s.rotation, s.armCount, s.winding, s.ring, s.eye, s.symmetry, s.swell, ...s.arms, ...s.bands]) {
      expect(b.measured).toBeNull();
      expect(b.value).toBeNull();
    }
    expect(s.rotation.why).toBe('bad_contact');
    const u = toUniforms(s);
    expect(u.armCount).toBe(0);
    expect(u.bandCount).toBe(0);
    expect(u.ring).toBe(0);
    expect(u.eye).toBe(0);
    expect(u.pulse).toBe(0);
    expect(u.swell).toBe(1);
    expect(u.armBrightness.every((x) => x === 0)).toBe(true);
  });

  it('confirmed tracks without a cascade: bands of cloud, no spiral, brightness bound to heights', () => {
    const s = run(steady((t) => bandsOnly(t), 2), 2);
    const f = bandsOnly(0);
    expect(s.mode).toBe('bands');
    expect(s.armCount.value).toBeNull();
    expect(s.armCount.why).toBe('no_cascade');
    expect(toUniforms(s).armCount).toBe(0);
    expect(s.bandCount.value).toBe(3);
    f.tracks.forEach((t, j) => {
      expect(s.bands[j].field).toBe(`slow.tracks[id=${t.id}].height_db`);
      expect(s.bands[j].value).toBe(t.height_db.v);
    });
  });

  it('dominant = null: rotation stops at once, no coasting', () => {
    const sched = [
      ...steady((t) => phiCascadeFrame(t, 3), 2),
      { at: 2.2, frame: phiCascadeFrame(2.2, null) as Frame },
    ];
    const before = run(sched, 2.15);
    expect(before.rotation.value).toBeCloseTo(9.95);
    const atNull = run(sched, 2.21);
    expect(atNull.rotation.value).toBeNull();
    const later = run(sched, 2.9);
    expect(later.rotation.value).toBeNull();
    expect(later.rotationPhase).toBe(atNull.rotationPhase);
  });

  it('stale frames dissolve the storm to calm and say "no data"', () => {
    const sched = steady((t) => phiCascadeFrame(t), 2);
    const live = run(sched, 2);
    expect(live.mode).toBe('storm');
    const stale = run(sched, 2 + VIZ_SMOOTHING.SLOW_STALE_S + 0.05);
    expect(stale.mode).toBe('calm');
    expect(stale.message).toBe('No data');
    expect(stale.rotation.value).toBeNull();
    expect(stale.armCount.why).toBe('stale');
    // Mid-dissolve: still ramping down, not jumping.
    const mid = toUniforms(stale);
    expect(mid.armCount).toBeGreaterThan(0);
    expect(mid.armCount).toBeLessThan(4);
    const gone = run(sched, 2 + VIZ_SMOOTHING.SLOW_STALE_S + T + 0.05);
    const u = toUniforms(gone);
    expect(u.armCount).toBe(0);
    expect(u.eye).toBe(0);
    expect(u.armBrightness.every((x) => x === 0)).toBe(true);
  });
});

describe('time rules', () => {
  it('no parameter changes when frames do not change (rotation null)', () => {
    const sched = steady((t) => ({ ...phiCascadeFrame(0, null), t }), 5);
    // Same content every frame. Only `t` differs, which nothing is bound to.
    const a = toUniforms(run(sched, 3));
    const b = toUniforms(run(sched, 4.1));
    expect(b).toEqual(a);
  });

  it('with a measured dominant frequency, rotation advances at a rate proportional to it', () => {
    const sched = steady(() => phiCascadeFrame(0, 3), 6);
    const a = run(sched, 3);
    const b = run(sched, 4);
    const dphi = (b.rotationPhase - a.rotationPhase + 2 * Math.PI) % (2 * Math.PI);
    expect(dphi).toBeCloseTo(2 * Math.PI * VIZ_MAPPING.ROT_REV_PER_S_PER_HZ * 9.95, 3);
    // Everything else is identical.
    const ua = toUniforms(a);
    const ub = toUniforms(b);
    expect({ ...ub, rotation: 0 }).toEqual({ ...ua, rotation: 0 });
  });

  it('interpolates between frames and never passes the latest value', () => {
    const lo = phiCascadeFrame(0);
    const hi = phiCascadeFrame(0.25);
    hi.cascades.phi.excess_a = { v: 0.4, se: 0.04, why: 'ok' };
    const sched = [
      ...steady((t) => ({ ...lo, t }), 2),
      { at: 2.1, frame: { ...hi, t: 2.1 } as Frame },
    ];
    const vals: number[] = [];
    for (let now = 2.1; now <= 2.1 + T + 0.2; now += 0.05) vals.push(run(sched, now).winding.value!);
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1] + 1e-12);
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(0.4 - 1e-12);
    expect(vals[vals.length - 1]).toBe(0.4);
  });

  it('is deterministic', () => {
    const sched = steady((t) => octaveCascadeFrame(t), 3);
    expect(toUniforms(run(sched, 2.5))).toEqual(toUniforms(run(sched, 2.5)));
  });
});

describe('golden ratio and octave look different', () => {
  it('phi cascade -> arms, no ring; octave cascade -> ring, no arms', () => {
    const p = toUniforms(run(steady((t) => phiCascadeFrame(t), 2), 2));
    const o = toUniforms(run(steady((t) => octaveCascadeFrame(t), 2), 2));
    expect(p.armCount).toBe(4);
    expect(p.ring).toBe(0);
    expect(o.armCount).toBe(0);
    expect(o.ring).toBe(0.85);
  });
});

describe('tap to inspect', () => {
  const s = run(steady((t) => phiCascadeFrame(t, null), 2), 2);
  it('the eye reports held_s', () => {
    const r = hitTest(s, 0, 0);
    expect(r.element).toMatch(/eye/i);
    expect(r.bindings.some((b) => b.field === 'slow.cascades.phi.held_s')).toBe(true);
  });
  it('an arm reports its track height, winding, and golden ratio, octave and chance side by side', () => {
    // Arm 0 sits at angle b ln r (rotation phase 0, symmetric halves offset applies left only).
    const u = toUniforms(s);
    const r0 = 0.35;
    const th = u.winding * Math.log(r0);
    const r = hitTest(s, r0 * Math.cos(th) + 0, r0 * Math.sin(th));
    expect(r.element).toMatch(/arm/i);
    expect(r.alignment).not.toBeNull();
    expect(r.alignment!.map((row) => row.label)).toEqual(['Golden ratio', 'Octave']);
    expect(r.bindings.some((b) => b.field.endsWith('.height_db'))).toBe(true);
  });
  it('calm water reports the reason', () => {
    const c = run(steady((t) => allNullSlow(t), 1), 1);
    const r = hitTest(c, 0.2, 0.2);
    expect(r.element).toMatch(/calm/i);
    expect(r.summary).toMatch(/poor sensor contact/);
  });
});
