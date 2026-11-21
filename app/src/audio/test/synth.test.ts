/**
 * Numeric tests of the sound layer. Every test renders through the same path as live:
 * frames -> FrameBinder -> SynthCore.render, at 48 kHz, 128-sample blocks.
 */

import { describe, expect, it } from 'vitest';
import type { Frame } from '../../engine/frames.ts';
import { anchorFromSeed, neutralControlFor } from '../anchors.ts';
import { DEFAULT_AUDIO_SETTINGS } from '../settings.ts';
import { FrameBinder } from '../bindings.ts';
import { SynthCore, softClip } from '../synth-core.ts';
import {
  SR,
  centroid,
  cents,
  diff,
  energyAbove,
  fastFrame,
  heartFrame,
  maxAbs,
  maxDiff,
  renderSession,
  rms,
  slice,
  slowFrame,
  spectrum,
  type Script,
  type SlowSpec,
  type TrackSpec,
  zeroCrossFreq,
} from './helpers.ts';

const TAU = DEFAULT_AUDIO_SETTINGS.pitchTauS;
/** A confirmed alpha track in the slow frame only (no fast track, so no tone): lets the bed sound alone. */
const ALPHA_ONLY: TrackSpec[] = [{ id: 9, freq: 10 }];

/** A session where `tracks(t)` gives the fast tracks and slow frames confirm the same ids. */
function session(tracks: (t: number) => TrackSpec[], slow: (t: number) => SlowSpec = () => ({}), artifact: (t: number) => boolean = () => false): Script {
  return (t, tick) => {
    const tr = tracks(t);
    const out: Frame[] = [];
    if (tick % 8 === 0) {
      const s = slow(t);
      out.push(slowFrame(t, { ...s, tracks: s.tracks ?? tr.map((k) => ({ ...k, freq: k.freq ?? 10 })) }));
    }
    out.push(fastFrame(t, tr, artifact(t)));
    return out;
  };
}

const allZero = (x: Float32Array) => x.every((v) => v === 0);
const firstNonZero = (x: Float32Array) => x.findIndex((v) => v !== 0);

describe('tracking tone pitch', () => {
  it('equals frame frequency x 32 within 1 cent after the declared smoothing', () => {
    const results: string[] = [];
    for (const [f0, f1] of [
      [10, 10.37],
      [4.3, 6.1],
      [16.18, 12.5],
      [2.2, 2.6],
      [23.5, 28.9],
    ]) {
      const r = renderSession(session((t) => [{ id: 1, freq: t < 2 ? f0 : f1, height: 15 }]), 4);
      // Settled before the step, and 7 time constants after it.
      const before = zeroCrossFreq(slice(r.left, 1.2, 2.0));
      const after = zeroCrossFreq(slice(r.left, 2 + 7 * TAU + 0.05, 3.9));
      const e0 = cents(before, f0 * 32);
      const e1 = cents(after, f1 * 32);
      results.push(`${f0}->${f1} Hz: ${e0.toFixed(4)} / ${e1.toFixed(4)} cents`);
      expect(Math.abs(e0)).toBeLessThan(1);
      expect(Math.abs(e1)).toBeLessThan(1);
    }
    console.log('pitch error (before/after step):\n  ' + results.join('\n  '));
  });

  it('glides across a frequency step without a discontinuity', () => {
    const r = renderSession(session((t) => [{ id: 1, freq: t < 2 ? 8 : 12, height: 15 }]), 4);
    const glide = maxDiff(slice(r.left, 1.9, 2.6));
    const steadyHigh = maxDiff(slice(r.left, 3.2, 3.9));
    console.log(`glide max |dx| ${glide.toExponential(3)} vs steady at the higher pitch ${steadyHigh.toExponential(3)}`);
    expect(glide).toBeLessThanOrEqual(steadyHigh * 1.01);
    // The glide is monotone in pitch: halfway through 1 tau the pitch is between the two.
    const mid = zeroCrossFreq(slice(r.left, 2.05, 2.25));
    expect(mid).toBeGreaterThan(8 * 32);
    expect(mid).toBeLessThan(12 * 32);
  });

  it('rolls off gently above 700 Hz', () => {
    const lo = renderSession(session(() => [{ id: 1, freq: 20, height: 15 }]), 3, { toneHarmonic2: 0 });
    const hi = renderSession(session(() => [{ id: 1, freq: 28, height: 15 }]), 3, { toneHarmonic2: 0 });
    const dB = 20 * Math.log10(rms(slice(hi.left, 2, 3)) / rms(slice(lo.left, 2, 3)));
    const expected = -6 * Math.log2((28 * 32) / 700);
    console.log(`896 Hz vs 640 Hz: ${dB.toFixed(2)} dB (expected ${expected.toFixed(2)})`);
    expect(Math.abs(dB - expected)).toBeLessThan(0.1);
  });

  it('loudness follows height above background', () => {
    const a = renderSession(session(() => [{ id: 1, freq: 10, height: 5 }]), 3);
    const b = renderSession(session(() => [{ id: 1, freq: 10, height: 10 }]), 3);
    const ratio = rms(slice(b.left, 2, 3)) / rms(slice(a.left, 2, 3));
    expect(ratio).toBeCloseTo(2, 2);
  });
});

describe('null, gating and silence', () => {
  it('null input: fades over >= 1 s at the last measured pitch, then exact silence that stays', () => {
    const r = renderSession(session((t) => [{ id: 1, freq: t < 3 ? 10 : null, height: 15 }]), 10);
    const pre = rms(slice(r.left, 2.5, 3));
    const at09 = rms(slice(r.left, 3.85, 3.95));
    const fadeEnd = 3 + DEFAULT_AUDIO_SETTINGS.toneFadeS + 0.05;
    console.log(`fade: rms before ${pre.toExponential(3)}, 0.9 s after null ${at09.toExponential(3)}; silent from ${fadeEnd.toFixed(2)} s`);
    expect(at09).toBeGreaterThan(pre * 0.01); // still fading at 0.9 s: the fade lasts >= 1 s
    // While fading the pitch does not move (never glides to a default).
    expect(Math.abs(cents(zeroCrossFreq(slice(r.left, 3.05, 3.7)), 320))).toBeLessThan(1);
    expect(allZero(slice(r.left, fadeEnd, 10))).toBe(true);
    expect(allZero(slice(r.right, fadeEnd, 10))).toBe(true);
    expect(r.core.status().voices.length).toBe(0); // slot released, pitch forgotten
  });

  it('on return the tone fades in at the new measured pitch, without a glide from the old one', () => {
    const r = renderSession(session((t) => [{ id: 1, freq: t < 1 ? 10 : t < 4 ? null : 13, height: 15 }]), 7);
    const onset = firstNonZero(slice(r.left, 3, 7));
    expect(onset).toBeGreaterThan(0);
    const start = 3 + onset / SR;
    expect(Math.abs(cents(zeroCrossFreq(slice(r.left, start, start + 0.3)), 13 * 32))).toBeLessThan(1);
    expect(maxAbs(slice(r.left, start, start + 0.05))).toBeLessThan(0.01 * maxAbs(slice(r.left, 6, 7)) + 1e-9);
  });

  it('all-null frames from the start: exact silence', () => {
    const script: Script = (t, tick) => {
      const out: Frame[] = [];
      if (tick % 8 === 0) out.push(slowFrame(t, { alphaDb: null, tracks: [{ id: 1, freq: null }] }));
      out.push(fastFrame(t, [{ id: 1, freq: null, height: null }, { id: 2, freq: 10, height: null }], tick % 64 < 10));
      if (tick % 32 === 0) out.push(heartFrame(t, []));
      return out;
    };
    const r = renderSession(script, 10);
    expect(allZero(r.left)).toBe(true);
    expect(allZero(r.right)).toBe(true);
    const r2 = renderSession(() => [], 5);
    expect(allZero(r2.left) && allZero(r2.right)).toBe(true);
  });

  it('no tone without a confirmed, locked track and no artifact', () => {
    for (const k of [
      { id: 1, freq: 10, height: 15, state: 'new' as const },
      { id: 1, freq: 10, height: 15, state: 'fading' as const },
      { id: 1, freq: 10, height: 15, locked: false },
    ]) {
      const r = renderSession((t, tick) => [...(tick % 8 === 0 ? [slowFrame(t, { tracks: [k] })] : []), fastFrame(t, [k])], 3);
      expect(allZero(r.left)).toBe(true);
    }
    const art = renderSession(session(() => [{ id: 1, freq: 10, height: 15 }], undefined, () => true), 3);
    expect(allZero(art.left)).toBe(true);
    // Fast track with no slow frame at all: unconfirmed, silent.
    const noSlow = renderSession((t) => [fastFrame(t, [{ id: 1, freq: 10, height: 15 }])], 3);
    expect(allZero(noSlow.left)).toBe(true);
  });

  it('artifact mid-session thins: tones fade, the bed thins, both come back gently', () => {
    const r = renderSession(
      session(
        () => [{ id: 1, freq: 10, height: 15 }],
        () => ({ alphaDb: 3 }),
        (t) => t >= 4 && t < 7,
      ),
      10,
    );
    const before = rms(slice(r.left, 3, 4));
    const during = rms(slice(r.left, 6, 7));
    expect(during).toBeLessThan(before * 0.5);
    expect(during).toBeGreaterThan(0); // bed thinned, not cut
    expect(maxDiff(slice(r.left, 3.9, 5.6))).toBeLessThanOrEqual(maxDiff(slice(r.left, 3, 3.9)) * 1.05);
  });

  it('watchdog: if frames stop, every measured layer fades to silence', () => {
    // Includes a golden ratio bloom, so the room tail must also reach exact zero.
    const two: TrackSpec[] = [{ id: 1, freq: 10, height: 15 }, { id: 2, freq: 16.18, height: 15 }];
    const live = session(() => two, () => ({ alphaDb: 4, phi: { tracks: [1, 2], excess: 1, active: true } }));
    const r = renderSession((t, tick) => (t < 6 ? live(t, tick) : []), 16);
    expect(rms(slice(r.left, 5.5, 6))).toBeGreaterThan(0);
    const last = r.left.findLastIndex((v) => v !== 0) / SR;
    // Watchdog 0.5 s, then the bloom presence lands on zero within 2.4 x bloomFollowTauS, then the room tail (< 4 s).
    const bound = 6 + 0.5 + 2.4 * DEFAULT_AUDIO_SETTINGS.bloomFollowTauS + 4;
    console.log(`frames stop at 6 s; last non-zero sample at ${last.toFixed(3)} s (bound ${bound.toFixed(1)} s)`);
    expect(last).toBeLessThan(bound);
    expect(allZero(slice(r.right, bound, 16))).toBe(true);
    expect(r.core.status().watchdog).toBe(true);
  });
});

describe('ceiling and limiter', () => {
  it('never exceeds the ceiling under worst-case input', () => {
    for (const ceilingDb of [-6, -1, -20]) {
      const ceiling = Math.pow(10, ceilingDb / 20);
      const tracks: TrackSpec[] = [1.5, 3, 6, 10, 16.18, 20, 26, 29].map((f, i) => ({ id: i, freq: f, height: 60 }));
      const ids = tracks.map((k) => k.id);
      const script: Script = (t, tick) => {
        const out = session(
          () => tracks,
          () => ({ alphaDb: 40, phi: { tracks: ids, excess: 1, active: true }, octave: { tracks: ids, excess: 1, active: true } }),
        )(t, tick);
        if (tick % 4 === 0) out.push(heartFrame(t, [{ t }]));
        return out;
      };
      const r = renderSession(
        script,
        12,
        { ceilingDb, masterDb: 6, maxVoices: 8, gains: { tones: 2, bed: 2, bloom: 2, heart: 2, breath: 2, anchor: 2 }, breathGuide: { enabled: true }, heightFullDb: 1, heightFloorDb: 0 },
        (c) => c.playAnchor({ ...anchorFromSeed(9), level: 1, sustainS: 30 }),
      );
      const peak = Math.max(maxAbs(r.left), maxAbs(r.right));
      console.log(`ceiling ${ceilingDb} dBFS (${ceiling.toFixed(5)}): worst-case peak ${peak.toFixed(5)}, leveller ${r.core.status().limiterDb.toFixed(1)} dB`);
      expect(peak).toBeLessThanOrEqual(ceiling);
    }
  }, 60_000);

  it('soft clip never reaches the ceiling, even for huge input', () => {
    for (const x of [0, 0.1, 0.4, 0.49, 1, 10, 1e6, -1e9]) expect(Math.abs(softClip(x, 0.3, 0.5))).toBeLessThanOrEqual(0.5);
    expect(softClip(0.2, 0.3, 0.5)).toBe(0.2);
  });
});

describe('attacks: no layer starts with a step', () => {
  const onsetCheck = (name: string, x: Float32Array, windowS: number) => {
    const i0 = firstNonZero(x);
    expect(i0).toBeGreaterThanOrEqual(0);
    const head = x.subarray(i0, i0 + Math.round(windowS * SR));
    const peak = maxAbs(x);
    const firstSample = Math.abs(x[i0]);
    console.log(`${name}: first sample ${firstSample.toExponential(2)}, max in first ${windowS * 1000} ms = ${(maxAbs(head) / peak * 100).toFixed(2)}% of peak, max |dx| head ${maxDiff(head).toExponential(2)}`);
    expect(firstSample).toBeLessThan(peak * 1e-3);
    expect(maxAbs(head)).toBeLessThan(peak * 0.05);
  };
  it('tone', () => onsetCheck('tone', renderSession(session(() => [{ id: 1, freq: 10, height: 15 }]), 3).left, 0.05));
  it('bed', () => onsetCheck('bed', renderSession(session(() => [], () => ({ alphaDb: 4, tracks: ALPHA_ONLY })), 4).left, 0.05));
  it('heartbeat', () => onsetCheck('heart', renderSession((t, k) => (k === 16 ? [heartFrame(t, [{ t }])] : [fastFrame(t, [])]), 2).left, 0.005));
  it('breath guide', () => onsetCheck('breath', renderSession(() => [], 6, { breathGuide: { enabled: true } }).left, 0.05));
  it('anchor', () => onsetCheck('anchor', renderSession(() => [], 4, {}, (c) => c.playAnchor(anchorFromSeed(5))).left, 0.05));
  it('blooms', () => {
    const two: TrackSpec[] = [{ id: 1, freq: 10, height: 15 }, { id: 2, freq: 16.18, height: 15 }];
    for (const which of ['phi', 'octave'] as const) {
      const base = renderSession(session(() => two), 10);
      const bloom = renderSession(session(() => two, (t) => (t >= 3 ? { [which]: { tracks: [1, 2], excess: 0.8, active: true } } : {})), 10);
      onsetCheck(`bloom ${which}`, diff(bloom.left, base.left), 0.05);
    }
  });
});

describe('blooms', () => {
  const two: TrackSpec[] = [{ id: 1, freq: 10, height: 15 }, { id: 2, freq: 16.18, height: 15 }];
  const render = (slow: SlowSpec) => renderSession(session(() => two, (t) => (t >= 2 ? slow : {})), 14);
  const base = render({});
  const phi = render({ phi: { tracks: [1, 2], excess: 1, active: true } });
  const oct = render({ octave: { tracks: [1, 2], excess: 1, active: true } });
  const phiPart = diff(phi.left, base.left);
  const octPart = diff(oct.left, base.left);

  it('golden ratio and octave blooms are spectrally different', () => {
    const a = slice(phiPart, 10, 14);
    const b = slice(octPart, 10, 14);
    const ca = centroid(a);
    const cb = centroid(b);
    const sa = spectrum(a).mag;
    const sb = spectrum(b).mag;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < sa.length; i++) {
      dot += sa[i] * sb[i];
      na += sa[i] * sa[i];
      nb += sb[i] * sb[i];
    }
    const cos = dot / Math.sqrt(na * nb);
    console.log(`bloom centroid: golden ratio ${ca.toFixed(0)} Hz, octave ${cb.toFixed(0)} Hz; spectral cosine similarity ${cos.toFixed(3)}`);
    expect(cb).toBeGreaterThan(ca * 2);
    expect(cos).toBeLessThan(0.2);
  });

  it('the golden ratio bloom is built from the measured tones (sub-octaves of 320 and 517.8 Hz)', () => {
    const { mag, df } = spectrum(slice(phiPart, 10, 14));
    const at = (hz: number) => Math.max(...Array.from(mag.subarray(Math.round(hz / df) - 2, Math.round(hz / df) + 3)));
    const strong = Math.max(...mag);
    for (const hz of [160, 258.9, 320, 517.8]) expect(at(hz)).toBeGreaterThan(strong * 0.1);
    expect(at(230)).toBeLessThan(strong * 0.01); // nothing invented between them
  });

  it('blooms over several seconds and follows excess_a', () => {
    const l1 = rms(slice(phiPart, 2.5, 3));
    const l8 = rms(slice(phiPart, 12, 14));
    console.log(`golden ratio bloom: rms 0.5-1 s after entry is ${(l1 / l8 * 100).toFixed(1)}% of settled`);
    expect(l1).toBeLessThan(0.5 * l8);
    const half = renderSession(session(() => two, (t) => (t >= 2 ? { phi: { tracks: [1, 2], excess: 0.5, active: true } } : {})), 14);
    expect(rms(slice(diff(half.left, base.left), 12, 14)) / l8).toBeCloseTo(0.5, 1);
  });

  it('leaving the state is a gentle thinning (no step), not a cut', () => {
    const r = renderSession(session(() => two, (t) => (t >= 2 && t < 10 ? { phi: { tracks: [1, 2], excess: 1, active: true } } : {})), 16);
    const part = diff(r.left, renderSession(session(() => two), 16).left);
    const at = rms(slice(part, 9.5, 10));
    const after1 = rms(slice(part, 10.8, 11.2));
    const after6 = rms(slice(part, 15.5, 16));
    expect(after1).toBeGreaterThan(0.2 * at);
    expect(after6).toBeLessThan(0.15 * at);
  });

  it('inactive state or non-member tracks: no bloom', () => {
    const inactive = render({ phi: { tracks: [1, 2], excess: 1, active: false } });
    expect(maxAbs(diff(inactive.left, base.left))).toBe(0);
    const other = render({ phi: { tracks: [7, 8], excess: 1, active: true } });
    expect(maxAbs(diff(other.left, base.left))).toBe(0);
  });
});

describe('state bed', () => {
  it('warms as alpha above background rises relative to baseline (lower spectral centroid)', () => {
    const at = (db: number) => renderSession(session(() => [], () => ({ alphaDb: db, tracks: ALPHA_ONLY })), 30, {}, (_c, b) => b.setBaseline({ alphaAboveBgDbMean: 2 }));
    const cool = at(2);
    const warm = at(8);
    const cc = centroid(slice(cool.left, 26, 30));
    const cw = centroid(slice(warm.left, 26, 30));
    console.log(`bed centroid: at baseline ${cc.toFixed(0)} Hz, +6 dB over baseline ${cw.toFixed(0)} Hz`);
    expect(cw).toBeLessThan(cc * 0.7);
    // Steadiness (the hold integrator) keeps growing after warmth has settled.
    expect(warm.core.status().bed.steadiness).toBeGreaterThan(0.95);
    expect(rms(slice(warm.left, 26, 30))).toBeGreaterThan(rms(slice(warm.left, 6, 10)));
  });

  it('the bed fades in over >= 1 s and out to exact silence when alpha becomes null', () => {
    const r = renderSession(session(() => [], (t) => ({ alphaDb: t < 5 ? 4 : null, tracks: ALPHA_ONLY })), 12);
    const full = rms(slice(r.left, 4, 5));
    expect(rms(slice(r.left, 0.2, 0.5))).toBeLessThan(full * 0.25);
    expect(allZero(slice(r.left, 5.25 + DEFAULT_AUDIO_SETTINGS.bedFadeS + 0.05, 12))).toBe(true);
  });
});

describe('heartbeat', () => {
  const beats = renderSession((t, k) => (k % 32 === 16 ? [heartFrame(t, [{ t }])] : [fastFrame(t, [])]), 6);
  it('is low and rounded: centroid < 150 Hz, no broadband click', () => {
    const x = slice(beats.left, 1, 5);
    const c = centroid(x);
    const hi = energyAbove(x, 1000);
    const mid = energyAbove(x, 300);
    console.log(`heartbeat centroid ${c.toFixed(1)} Hz; energy above 300 Hz ${(10 * Math.log10(mid)).toFixed(1)} dB, above 1 kHz ${(10 * Math.log10(hi)).toFixed(1)} dB`);
    expect(c).toBeLessThan(150);
    expect(hi).toBeLessThan(1e-5);
  });
  it('plays at Beat.t + the declared latency, and drops beats that arrive too late', () => {
    const r = renderSession((t, k) => (k === 32 ? [heartFrame(t, [{ t: 1.0 }])] : [fastFrame(t, [])]), 3);
    const onset = firstNonZero(r.left) / SR;
    console.log(`beat at t=1.000 s sounds at ${onset.toFixed(4)} s (latency ${DEFAULT_AUDIO_SETTINGS.heartLatencyS} s)`);
    expect(Math.abs(onset - 1.3)).toBeLessThan(2 / SR);
    const late = renderSession((t, k) => (k === 64 ? [heartFrame(t, [{ t: 1.0 }])] : [fastFrame(t, [])]), 3);
    expect(allZero(late.left)).toBe(true);
    expect(late.binder.droppedLateBeats).toBe(1);
  });
  it('makes no sound without beats', () => {
    const r = renderSession((t, k) => (k % 32 === 0 ? [heartFrame(t, [])] : []), 3);
    expect(allZero(r.left)).toBe(true);
  });
});

describe('breath guide', () => {
  it('is off by default and labelled as a guide when on', () => {
    expect(DEFAULT_AUDIO_SETTINGS.breathGuide.enabled).toBe(false);
    const r = renderSession(() => [fastFrame(0, [])], 4);
    expect(allZero(r.left)).toBe(true);
    const on = renderSession((t) => [fastFrame(t, [])], 20, { breathGuide: { enabled: true, bpm: 6 } });
    expect(rms(on.left)).toBeGreaterThan(0);
    const trace = on.binder.traceAll().find((x) => x.element === 'breath_guide');
    expect(trace?.mapping).toMatch(/NOT A MEASUREMENT/);
    // Swell period = 10 s at 6 breaths per minute: quietest near the cycle start, loudest mid-cycle.
    const quiet = rms(slice(on.left, 9.8, 10.2));
    const loud = rms(slice(on.left, 14.8, 15.2));
    expect(loud).toBeGreaterThan(quiet * 5);
  });
});

describe('anchors', () => {
  it('plays with slow fades and ends in exact silence', () => {
    const p = { ...anchorFromSeed(11), attackS: 2, sustainS: 1, releaseS: 2 };
    const r = renderSession(() => [], 10, {}, (c) => c.playAnchor(p));
    expect(rms(slice(r.left, 0, 0.3))).toBeLessThan(0.1 * rms(slice(r.left, 2, 3)));
    // attack 2 + sustain 1 + release 2 = 5 s, then the room tail decays to exact zero (< 4 s).
    expect(rms(slice(r.left, 5.05, 5.2))).toBeLessThan(0.05 * rms(slice(r.left, 2, 3)));
    expect(allZero(slice(r.left, 9, 10))).toBe(true);
  });
  it('stopAnchor releases smoothly', () => {
    const core = new SynthCore(SR);
    core.playAnchor({ ...anchorFromSeed(2), sustainS: 30, releaseS: 2 });
    const a = new Float32Array(SR * 11);
    core.render(a, null, 0, SR * 4);
    core.stopAnchor();
    core.render(a, null, SR * 4, SR * 7);
    expect(maxDiff(slice(a, 3.9, 4.5))).toBeLessThanOrEqual(maxDiff(slice(a, 3, 3.9)) * 1.05);
    expect(allZero(slice(a, 10, 11))).toBe(true);
  });
  it('the neutral control matches loudness within 3 dB', () => {
    const p = anchorFromSeed(3);
    const a = renderSession(() => [], 6, {}, (c) => c.playAnchor(p));
    const n = renderSession(() => [], 6, {}, (c) => c.playAnchor(neutralControlFor(p)));
    const dB = 20 * Math.log10(rms(slice(n.left, p.attackS, p.attackS + 2)) / rms(slice(a.left, p.attackS, p.attackS + 2)));
    console.log(`neutral control vs anchor: ${dB.toFixed(2)} dB`);
    expect(Math.abs(dB)).toBeLessThan(3);
  });
});

describe('determinism', () => {
  it('the same session renders bit-identical audio', () => {
    const script: Script = (t, tick) => {
      const tr: TrackSpec[] = [
        { id: 1, freq: 10 + 0.3 * Math.sin(t), height: 12 },
        { id: 2, freq: t > 3 && t < 5 ? null : 16.2, height: 10 },
      ];
      const out = session(() => tr, (tt) => ({ alphaDb: 2 + tt / 4, phi: tt > 4 ? { tracks: [1, 2], excess: 0.7, active: true } : undefined }))(t, tick);
      if (tick % 30 === 0) out.push(heartFrame(t, [{ t: t - 0.05 }]));
      return out;
    };
    const opts = { breathGuide: { enabled: true } };
    const a = renderSession(script, 8, opts, (c) => c.playAnchor(anchorFromSeed(4)));
    const b = renderSession(script, 8, opts, (c) => c.playAnchor(anchorFromSeed(4)));
    let same = true;
    for (let i = 0; i < a.left.length; i++) if (a.left[i] !== b.left[i] || a.right[i] !== b.right[i]) same = false;
    expect(same).toBe(true);
    expect(rms(a.left)).toBeGreaterThan(0);
  });
});

describe('no entrainment', () => {
  it('both channels carry the same dry signal (no binaural difference) when no room send is active', () => {
    const r = renderSession(session(() => [{ id: 1, freq: 10, height: 15 }], () => ({ alphaDb: 4 })), 4);
    expect(maxAbs(diff(r.left, r.right))).toBe(0);
  });
});

describe('noise-only input is silent (fake test failure 4)', () => {
  it('background-only frames (alpha above background small but measured, no tracks): exact zeros', () => {
    const script: Script = (t, tick) => {
      const out: Frame[] = [];
      if (tick % 8 === 0) out.push(slowFrame(t, { alphaDb: 0.4 + 0.2 * Math.sin(t), tracks: [] }));
      out.push(fastFrame(t, []));
      return out;
    };
    const r = renderSession(script, 12);
    expect(allZero(r.left) && allZero(r.right)).toBe(true);
    const bed = r.binder.traceAll().find((x) => x.element === 'bed');
    expect(bed?.on).toBe(false);
    expect(bed?.why).toBe('not_confirmed');
  });

  it('the bed needs a confirmed alpha-band peak: a theta-only peak leaves it silent', () => {
    const theta = renderSession(session(() => [], () => ({ alphaDb: 5, tracks: [{ id: 4, freq: 6 }] })), 6);
    expect(allZero(theta.left)).toBe(true);
    const unconfirmed = renderSession(session(() => [], () => ({ alphaDb: 5, tracks: [{ id: 4, freq: 10, state: 'new' }] })), 6);
    expect(allZero(unconfirmed.left)).toBe(true);
    const wrongSite = renderSession(session(() => [], () => ({ alphaDb: 5, tracks: [{ id: 4, freq: 10, site: 'AF7' }] })), 6);
    expect(allZero(wrongSite.left)).toBe(true);
    const channel = renderSession(session(() => [], () => ({ alphaDb: 5, tracks: [{ id: 4, freq: 10, site: 'TP10' }] })), 6);
    expect(rms(slice(channel.left, 4, 6))).toBeGreaterThan(0);
  });

  it('the bed fades out over its declared fade when the alpha peak goes, then exact zero', () => {
    const r = renderSession(session(() => [], (t) => ({ alphaDb: 4, tracks: t < 5 ? ALPHA_ONLY : [] })), 12);
    expect(rms(slice(r.left, 5.3, 5.6))).toBeGreaterThan(0);
    expect(maxDiff(slice(r.left, 4.5, 7.5))).toBeLessThanOrEqual(maxDiff(slice(r.left, 3, 4.5)) * 1.05);
    expect(allZero(slice(r.left, 5.25 + DEFAULT_AUDIO_SETTINGS.bedFadeS + 0.05, 12))).toBe(true);
  });
});

describe('consecutive sessions in one page load (fake test failure 5)', () => {
  /** Session A for 6 s (10 Hz), then session B whose clock restarts at 0 (12 Hz, same track id). */
  function twoSessions(explicit: boolean) {
    const core = new SynthCore(SR);
    const binder = new FrameBinder();
    const total = 16 * SR;
    const left = new Float32Array(total);
    let tick = 0;
    let resets = 0;
    for (let pos = 0; pos < total; pos += 128) {
      const coreT = pos / SR;
      while (tick / 32 <= coreT) {
        const ct = tick / 32;
        const inB = ct >= 6;
        if (inB && explicit && ct - 1 / 32 < 6) {
          binder.reset();
          core.newSession();
        }
        const t = inB ? ct - 6 : ct;
        const tr: TrackSpec[] = [{ id: 1, freq: inB ? 12 : 10, height: 15 }];
        const frames: Frame[] = [];
        if (tick % 8 === 0) frames.push(slowFrame(t, { tracks: tr }));
        frames.push(fastFrame(t, tr));
        if (tick % 32 === 0 && t >= 1) frames.push(heartFrame(t, [{ t }]));
        for (const f of frames) {
          const out = binder.handleFrame(f, core.timeS);
          if (out.reset) {
            resets++;
            core.newSession();
          }
          core.setControl(out.control);
          for (const b of out.beats) core.scheduleBeat(b.atS, b.flagged);
        }
        tick++;
      }
      core.render(left, null, pos, Math.min(128, total - pos));
    }
    return { left, core, resets };
  }

  for (const explicit of [false, true]) {
    it(`${explicit ? 'explicit reset' : 'automatic detection'}: the second session sounds, at its own pitch, with heartbeats, no click`, () => {
      const { left, core, resets } = twoSessions(explicit);
      expect(resets).toBe(explicit ? 0 : 1);
      // Between beats of session B (beat at B-time 6 s sounds at core 12.3 s, ends 12.72 s).
      const pitchB = zeroCrossFreq(slice(left, 12.75, 13.25));
      const pitchA = zeroCrossFreq(slice(left, 4.75, 5.25));
      console.log(`${explicit ? 'explicit' : 'auto'}: session A ${pitchA.toFixed(3)} Hz, session B ${pitchB.toFixed(3)} Hz, beats played ${core.status().heart.played}`);
      expect(Math.abs(cents(pitchA, 320))).toBeLessThan(1);
      expect(Math.abs(cents(pitchB, 384))).toBeLessThan(1);
      // 5 beats in A (t = 1..5), 9 in B (t = 1..9; t=10 would sound after the render ends).
      expect(core.status().heart.played).toBe(5 + 9);
      // The changeover: the old tone fades out and the new one fades in; never a step.
      const steady = Math.max(maxDiff(slice(left, 4, 5.9)), maxDiff(slice(left, 13, 15)));
      const change = maxDiff(slice(left, 5.9, 9));
      console.log(`changeover max |dx| ${change.toExponential(3)} vs steady ${steady.toExponential(3)}`);
      expect(change).toBeLessThanOrEqual(steady * 1.05);
    });
  }
});

describe('combined state bloom and bloom settings', () => {
  const two: TrackSpec[] = [{ id: 1, freq: 10, height: 15 }, { id: 2, freq: 16.18, height: 15 }];
  const PHI = { tracks: [1, 2], excess: 1, active: true };
  const OCT = { tracks: [1, 2], excess: 1, active: true };
  const MUTE_PO = { blooms: { phi: { on: false }, octave: { on: false } } };
  const run = (slow: SlowSpec, settings = {}, secs = 22) => renderSession(session(() => two, (t) => (t >= 2 ? slow : {})), secs, settings);
  const base = run({});
  const part = (r: { left: Float32Array }) => diff(r.left, base.left);

  it('golden ratio, octave and combined blooms are mutually spectrally distinct', () => {
    const phi = slice(part(run({ phi: PHI })), 16, 22);
    const oct = slice(part(run({ octave: OCT })), 16, 22);
    const both = slice(part(run({ phi: PHI, octave: OCT }, MUTE_PO)), 16, 22);
    const spec = [phi, oct, both].map((x) => spectrum(x).mag);
    const cos = (a: Float64Array, b: Float64Array) => {
      let d = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        d += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      return d / Math.sqrt(na * nb);
    };
    const c = [cos(spec[0], spec[1]), cos(spec[0], spec[2]), cos(spec[1], spec[2])];
    console.log(`centroids: golden ratio ${centroid(phi).toFixed(0)} Hz, octave ${centroid(oct).toFixed(0)} Hz, combined ${centroid(both).toFixed(0)} Hz; cosine phi/oct ${c[0].toFixed(3)}, phi/both ${c[1].toFixed(3)}, oct/both ${c[2].toFixed(3)}`);
    for (const x of c) expect(x).toBeLessThan(0.2);
    expect(rms(both)).toBeGreaterThan(0);
  });

  it('the combined bloom never sounds unless states.both is active', () => {
    const noBoth = run({ phi: PHI, octave: OCT, both: false }, MUTE_PO, 10);
    expect(maxAbs(part(noBoth).subarray(0, noBoth.left.length))).toBe(0);
    const phiOnlyFlag = run({ phi: PHI, both: true }, MUTE_PO, 10); // octave excess missing: min() is null
    expect(maxAbs(part(phiOnlyFlag))).toBe(0);
    const nonMembers = run({ phi: { ...PHI, tracks: [7, 8] }, octave: { ...OCT, tracks: [7, 9] } }, MUTE_PO, 10);
    expect(maxAbs(part(nonMembers))).toBe(0);
  });

  it('the combined bloom gathers slowly, follows min(excess) and its level setting, and is mutable', () => {
    const full = part(run({ phi: PHI, octave: OCT }, MUTE_PO));
    const settled = rms(slice(full, 18, 22));
    const at1 = rms(slice(full, 2.5, 3));
    console.log(`combined bloom 0.5-1 s after entry: ${(at1 / settled * 100).toFixed(1)}% of settled`);
    expect(at1).toBeLessThan(0.2 * settled);
    const minEx = part(run({ phi: { ...PHI, excess: 0.9 }, octave: { ...OCT, excess: 0.5 } }, MUTE_PO));
    expect(rms(slice(minEx, 18, 22)) / settled).toBeCloseTo(0.5, 1);
    const half = part(run({ phi: PHI, octave: OCT }, { blooms: { ...MUTE_PO.blooms, both: { level: 0.5 } } }));
    expect(rms(slice(half, 18, 22)) / settled).toBeCloseTo(0.5, 1);
    const muted = run({ phi: PHI, octave: OCT }, { blooms: { phi: { on: false }, octave: { on: false }, both: { on: false } } });
    expect(maxAbs(part(muted))).toBe(0);
  });

  it('bloomChance "b" scales the blooms by excess_b', () => {
    const a = part(run({ phi: PHI, excessB: { phi: 0.5 } }));
    const b = part(run({ phi: PHI, excessB: { phi: 0.5 } }, { bloomChance: 'b' }));
    expect(rms(slice(b, 18, 22)) / rms(slice(a, 18, 22))).toBeCloseTo(0.5, 1);
  });
});
