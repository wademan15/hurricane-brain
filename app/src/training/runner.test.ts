import { describe, expect, it, vi } from 'vitest';

// Statistical tests run many seeds; allow time on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });
import type { Frame } from '../engine/frames';
import { createRng } from './math';
import { instantiateProgram, type SessionPlan } from './program';
import { ALPHA_EYES_CLOSED, ANCHOR_PAIRING, HIGH_HRV, STILLNESS } from './programs';
import { createSessionRunner, validateSession, type RunnerOptions, type SessionRecord } from './runner';
import type { Signature } from './signatures';
import { correlatedNoise, fastFrame, heartFrame, slowFrame } from './test-fixtures';

const OPTS: RunnerOptions = { sessionId: 's1', userId: 'u1', startedAt: '2026-11-20T09:00:00Z', seed: 42, headset: 'muse2', posture: 'upright' };

function schedule(plan: SessionPlan): { start: number; end: number; kind: string; index: number }[] {
  let t = 0;
  return plan.blocks.map((b) => {
    const s = { start: t, end: t + b.durationS, kind: b.kind, index: b.index };
    t += b.durationS;
    return s;
  });
}

/** Feed slow frames at 4 Hz with a value per block from `mu(blockIndex, kind)` plus correlated noise. */
function runAlpha(plan: SessionPlan, seed: number, mu: (trainIdx: number, kind: string) => number, extra?: (t: number) => Partial<Parameters<typeof slowFrame>[1]>): SessionRecord {
  const runner = createSessionRunner(plan, { ...OPTS, seed });
  const sched = schedule(plan);
  const total = sched[sched.length - 1].end;
  const n = Math.round(total / 0.25) + 4;
  const noise = correlatedNoise(createRng(seed), n, 0.25, 8, 1);
  let trainIdx = -1;
  let lastBlock = -1;
  for (let i = 0; i < n; i++) {
    const t = i * 0.25;
    const blk = sched.find((s) => t >= s.start && t < s.end) ?? sched[sched.length - 1];
    if (blk.index !== lastBlock) {
      lastBlock = blk.index;
      if (blk.kind === 'train') trainIdx++;
    }
    const m = blk.kind === 'train' || blk.kind === 'transfer' ? mu(trainIdx, blk.kind) : 0;
    runner.push(slowFrame(t, { bands: { alpha: m + noise[i] }, ...(extra?.(t) ?? {}) }));
  }
  runner.advance(total + 1);
  return runner.record();
}

describe('runner: adaptive thresholds', () => {
  const plan = instantiateProgram(ALPHA_EYES_CLOSED, {
    level: 1,
    values: { alpha_metric: 'spectra[temporal].bands.alpha.above_bg_db', blocks: 8, train_block_s: 120, rest_s: 20, settle_s: 30, baseline_s: 90, transfer_s: 60, closing_s: 30 },
  });

  it('converges into the 60-80% success band when the person improves, struggles, or is far above threshold', () => {
    const scenarios: Record<string, (k: number) => number> = {
      improving: (k) => 0.3 + 0.12 * k,
      fast_learner: (k) => 0.3 + 0.25 * k,
      struggling: () => -1.2,
      far_above: () => 3,
    };
    for (const [name, mu] of Object.entries(scenarios)) {
      const finals: number[] = [];
      const firsts: number[] = [];
      for (let seed = 1; seed <= 20; seed++) {
        const rec = runAlpha(plan, seed, (k) => mu(k));
        const train = rec.blocks.filter((b) => b.kind === 'train');
        firsts.push(train[0].success.alpha as number);
        finals.push(...train.slice(-3).map((b) => b.success.alpha as number));
      }
      const meanFinal = finals.reduce((a, b) => a + b, 0) / finals.length;
      const meanFirst = firsts.reduce((a, b) => a + b, 0) / firsts.length;
      const inBand = finals.filter((s) => s >= 0.55 && s <= 0.85).length / finals.length;
      console.log(`[runner] ${name}: first-block success ${(meanFirst * 100).toFixed(0)}%, last-3-block success ${(meanFinal * 100).toFixed(1)}%, ${(inBand * 100).toFixed(0)}% of final blocks within 55-85%`);
      expect(meanFinal).toBeGreaterThan(0.6);
      // A learner gaining 0.25 SD every two minutes stays a little ahead of the threshold (lag of one block).
      expect(meanFinal).toBeLessThan(name === 'fast_learner' ? 0.85 : 0.8);
    }
  });

  it('never adapts during feedback-off blocks and records every threshold change as a marker', () => {
    const rec = runAlpha(plan, 3, () => 2);
    const changes = rec.thresholdHistory.filter((c) => c.reason === 'adapt');
    expect(changes.length).toBeGreaterThan(0);
    const trainEnds = new Set(rec.blocks.filter((b) => b.kind === 'train').map((b) => b.tEnd));
    for (const c of changes) expect(trainEnds.has(c.t)).toBe(true);
    expect(rec.markers.filter((m) => m.label === 'threshold').length).toBe(rec.thresholdHistory.length);
  });
});

describe('runner: reward is zero when frames are null or gated', () => {
  const plan = instantiateProgram(ALPHA_EYES_CLOSED, { values: { alpha_metric: 'spectra[temporal].bands.alpha.above_bg_db', settle_s: 30, baseline_s: 60, train_block_s: 120, blocks: 1 } });

  function primed() {
    const r = createSessionRunner(plan, OPTS);
    const rng = createRng(5);
    let t = 0;
    for (; t < 90; t += 0.25) r.push(slowFrame(t, { bands: { alpha: rng.normal() * 0.5 } }));
    // Strong alpha in the train block: reward should be high.
    for (; t < 100; t += 0.25) r.push(slowFrame(t, { bands: { alpha: 3 } }));
    return { r, t };
  }

  it('rewards a clean, high value', () => {
    const { r } = primed();
    const o = r.output();
    expect(o.block?.kind).toBe('train');
    expect(o.reward.raw).toBe(1);
    expect(o.reward.level).toBeGreaterThan(0.9);
  });

  it('artifact: raw reward 0, level decays with the declared time constant, never held', () => {
    const { r, t: t0 } = primed();
    let t = t0;
    for (; t < t0 + 5; t += 1 / 32) {
      r.push(fastFrame(t, { artifact: true }));
      if (Math.abs((t * 4) % 1) < 1e-9) r.push(slowFrame(t, { bands: { alpha: 3 } }));
    }
    const o = r.output();
    expect(o.reward.raw).toBe(0);
    expect(o.reward.why).toBe('artifact');
    expect(o.reward.level).toBeLessThan(Math.exp(-4.5 / plan.rewardTauS) + 0.02);
  });

  it('null spectrum: raw reward 0 with the engine reason', () => {
    const { r, t: t0 } = primed();
    for (let t = t0; t < t0 + 6; t += 0.25) r.push(slowFrame(t, { bands: { alpha: null } }));
    const o = r.output();
    expect(o.reward.raw).toBe(0);
    expect(o.targets[0].value.v).toBeNull();
    expect(o.reward.level).toBeLessThan(0.05);
  });

  it('bad contact and muscle tension withhold reward', () => {
    const a = primed();
    for (let t = a.t; t < a.t + 6; t += 0.25) a.r.push(slowFrame(t, { bands: { alpha: 3 }, usable: false }));
    expect(a.r.output().reward.raw).toBe(0);
    const b = primed();
    for (let t = b.t; t < b.t + 6; t += 0.25) b.r.push(slowFrame(t, { bands: { alpha: 3 }, emgDb: 20 }));
    expect(b.r.output().reward.raw).toBe(0);
    expect(b.r.output().reward.why).toBe('muscle');
  });

  it('stale frames are not held: no frames for 2 s means no reward', () => {
    const { r, t } = primed();
    r.push(heartFrame(t + 2));
    // The heart frame advances the clock; the slow value is now older than its freshness limit.
    r.push(slowFrame(t + 2.5, { bands: { alpha: null } }));
    expect(r.output().reward.raw).toBe(0);
  });

  it('suggests refitting after sustained bad signal', () => {
    const { r, t } = primed();
    for (let x = t; x < t + 25; x += 0.25) r.push(slowFrame(x, { bands: { alpha: 3 }, usable: false }));
    expect(r.drainEvents().some((e) => e.type === 'check_fit')).toBe(true);
  });
});

describe('runner: session record', () => {
  const plan = instantiateProgram(ALPHA_EYES_CLOSED, { values: { alpha_metric: 'spectra[temporal].bands.alpha.above_bg_db', blocks: 3, train_block_s: 90, settle_s: 30 } });

  it('validates, carries markers for every block and replays deterministically', () => {
    const a = runAlpha(plan, 11, (k) => 0.5 + 0.2 * k);
    const b = runAlpha(plan, 11, (k) => 0.5 + 0.2 * k);
    expect(validateSession(a)).toEqual([]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.completed).toBe(true);
    expect(a.markers.filter((m) => m.type === 'block_start').length).toBe(plan.blocks.length);
    expect(a.markers.filter((m) => m.type === 'technique').length).toBeGreaterThan(0);
    expect(a.markers.some((m) => m.type === 'baseline_start')).toBe(true);
    const train = a.blocks.find((x) => x.kind === 'train')!;
    const st = train.stats['spectra[temporal].bands.alpha.above_bg_db'];
    expect(st.effect).not.toBeNull();
    expect(st.fractionInTarget).not.toBeNull();
    expect(a.training.params.minCleanFraction).toBe(0.6);
  });

  it('ratings, technique changes and stop are recorded', () => {
    const r = createSessionRunner(plan, OPTS);
    for (let t = 0; t < 400; t += 0.25) r.push(slowFrame(t, { bands: { alpha: 1 } }));
    r.setTechnique(401, 'breath_count');
    r.report(402, 'felt drowsy');
    r.stop(403);
    r.rate(404, { ease: 4, depth: 3 });
    const rec = r.record();
    expect(rec.stoppedEarly).toBe(true);
    expect(rec.markers.some((m) => m.type === 'report' && m.label === 'note')).toBe(true);
    expect(rec.markers.some((m) => m.type === 'technique' && m.label === 'breath_count')).toBe(true);
    expect(validateSession(rec)).toEqual([]);
  });
});

describe('runner: other target kinds', () => {
  it('stillness rewards falling muscle tension', () => {
    const plan = instantiateProgram(STILLNESS, { values: { settle_s: 30, baseline_s: 60, train_block_s: 60, blocks: 1 } });
    const r = createSessionRunner(plan, OPTS);
    const rng = createRng(2);
    let t = 0;
    for (; t < 90; t += 0.25) r.push(slowFrame(t, { emgDb: 5 + rng.normal() }));
    for (; t < 110; t += 0.25) r.push(slowFrame(t, { emgDb: 1 }));
    expect(r.output().reward.raw).toBe(1);
  });

  it('heart programs use heart frames and are not gated by EEG', () => {
    const plan = instantiateProgram(HIGH_HRV, { values: { settle_s: 30, baseline_s: 60, train_block_s: 120, blocks: 1 } });
    const r = createSessionRunner(plan, OPTS);
    const rng = createRng(8);
    let t = 0;
    for (; t < 90; t += 1) r.push(heartFrame(t, { rmssd: 40 + 3 * rng.normal() }));
    for (; t < 120; t += 1) r.push(heartFrame(t, { rmssd: 60 }));
    expect(r.output().reward.raw).toBe(1);
    r.push(heartFrame(121, { rmssd: null }));
    expect(r.output().reward.raw).toBe(0);
  });

  it('fast-path alpha target follows the confirmed track only', () => {
    const plan = instantiateProgram(ALPHA_EYES_CLOSED, { values: { settle_s: 30, baseline_s: 60, train_block_s: 120, blocks: 1 } });
    expect(plan.targets[0].field).toBe('fast.track[alpha].height_db');
    const r = createSessionRunner(plan, OPTS);
    const rng = createRng(4);
    for (let t = 0; t < 100; t += 1 / 32) {
      if (Math.round(t * 32) % 8 === 0) r.push(slowFrame(t, { alphaTrack: { freq: 10, height: 6 } }));
      r.push(fastFrame(t, { alphaHeight: t < 90 ? 6 + rng.normal() : 9 }));
    }
    expect(r.output().reward.raw).toBe(1);
    // Track no longer confirmed in the slow path: the fast value is not used.
    r.push(slowFrame(100, { alphaTrack: null }));
    r.push(fastFrame(100.03, { alphaHeight: 9 }));
    expect(r.output().reward.raw).toBe(0);
    expect(r.output().targets[0].value.why).toBe('not_confirmed');
  });
});

describe('runner: anchor pairing is gated by the signature', () => {
  const sig: Signature = {
    id: 'sig1', state: 'calm',
    fields: [{ field: 'spectra[temporal].bands.alpha.above_bg_db', direction: 1, stateMean: 3, contrastMean: 0, pooledSd: 1, d: 3, consistency: 1, stateRange: [2, 4], weight: 3 }],
    status: 'reliable',
    validation: { heldOutAuc: 0.95, nullAucMean: 0.5, nullAuc95: 0.7, p: 0.005, permutations: 199, nSessions: 4, nDays: 4, nStateBlocks: 12, nContrastBlocks: 12, reasons: [] },
    detection: { enter: 1, exit: 0.5, dwellS: 5, windowS: 10, contrastExceedFraction: 0.02, falseEntriesPer10Min: 1 },
    history: [],
  };
  it('plays the anchor only while the state is detected, and the control in rests', () => {
    const plan = instantiateProgram(ANCHOR_PAIRING, { values: { settle_s: 30, baseline_s: 60, state_s: 180, rest_s: 60, blocks: 2, closing_s: 30 } });
    const r = createSessionRunner(plan, { ...OPTS, signature: sig, anchor: { id: 'a1', controlId: 'c1' } });
    const sched = schedule(plan);
    const total = sched[sched.length - 1].end;
    const playTimes: number[] = [];
    for (let t = 0; t <= total; t += 0.25) {
      const blk = sched.find((s) => t >= s.start && t < s.end);
      // In the state blocks the person reaches the state 40 s in; elsewhere they rest.
      const inState = blk?.kind === 'train' && t - blk.start > 40;
      r.push(slowFrame(t, { bands: { alpha: inState ? 3 : 0 } }));
      for (const e of r.drainEvents()) if (e.type === 'play_anchor') playTimes.push(e.t);
    }
    const rec = r.record();
    expect(rec.pairings.length).toBeGreaterThan(0);
    expect(rec.pairings.every((p) => p.valid)).toBe(true);
    for (const t of playTimes) {
      const blk = sched.find((s) => t >= s.start && t < s.end)!;
      expect(blk.kind).toBe('train');
      expect(t - blk.start).toBeGreaterThan(40 + 5);
    }
    expect(rec.controlExposures.length).toBe(2);
    expect(validateSession(rec)).toEqual([]);
  });
});

// Keep the unused-import checker honest about Frame being part of the API surface.
export type _F = Frame;
