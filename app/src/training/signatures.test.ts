import { describe, expect, it, vi } from 'vitest';

// Statistical tests run many seeds; allow time on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });
import { anchorEligibility, canPair, createAnchor, evaluateAnchor, planProbeOrder, recordSession, type ProbeTrial } from './anchors';
import { createRng, type Rng } from './math';
import { createSignatureDetector, learnSignature, SIGNATURE_CANDIDATE_FIELDS, type SignatureBlock } from './signatures';

function sessions(rng: Rng, nSessions: number, planted: Record<string, number>, perLabel = 4): SignatureBlock[] {
  const out: SignatureBlock[] = [];
  for (let s = 0; s < nSessions; s++) {
    const offset: Record<string, number> = {};
    for (const f of SIGNATURE_CANDIDATE_FIELDS) offset[f] = 0.5 * rng.normal();
    for (const label of ['state', 'contrast'] as const) {
      for (let k = 0; k < perLabel; k++) {
        const features: Record<string, number | null> = {};
        const windows: Record<string, number | null>[] = [{}, {}, {}];
        for (const f of SIGNATURE_CANDIDATE_FIELDS) {
          const mu = offset[f] + (label === 'state' ? (planted[f] ?? 0) : 0) + rng.normal();
          features[f] = mu;
          windows.forEach((w) => (w[f] = mu + 0.7 * rng.normal()));
        }
        out.push({ sessionId: `s${s}`, day: `2026-11-${String(10 + s).padStart(2, '0')}`, label, features, windows });
      }
    }
  }
  return out;
}

describe('signatures', () => {
  const planted = { [SIGNATURE_CANDIDATE_FIELDS[0]]: 1.5, [SIGNATURE_CANDIDATE_FIELDS[8]]: 1.2 };
  const seeds = 40;

  it('a planted signature is declared reliable and finds the planted fields', () => {
    let reliable = 0;
    let foundPlanted = 0;
    const aucs: number[] = [];
    for (let k = 0; k < seeds; k++) {
      const sig = learnSignature(sessions(createRng(100 + k), 4, planted), { id: 'x', state: 'calm', at: '2026-11-20', seed: k, permutations: 99 })!;
      if (sig.status === 'reliable') reliable++;
      if (sig.fields.slice(0, 2).every((f) => f.field in planted)) foundPlanted++;
      aucs.push(sig.validation.heldOutAuc ?? 0);
    }
    console.log(`[signatures] planted: reliable in ${reliable}/${seeds}, planted fields ranked first in ${foundPlanted}/${seeds}, mean held-out AUC ${(aucs.reduce((a, b) => a + b, 0) / seeds).toFixed(2)}`);
    expect(reliable / seeds).toBeGreaterThan(0.85);
    expect(foundPlanted / seeds).toBeGreaterThan(0.8);
  });

  it('label-shuffled (no real difference) data is not declared reliable', () => {
    let reliable = 0;
    const aucs: number[] = [];
    for (let k = 0; k < seeds; k++) {
      const sig = learnSignature(sessions(createRng(900 + k), 4, {}), { id: 'x', state: 'calm', at: '2026-11-20', seed: k, permutations: 99 });
      if (sig?.status === 'reliable') reliable++;
      if (sig?.validation.heldOutAuc != null) aucs.push(sig.validation.heldOutAuc);
    }
    console.log(`[signatures] null: reliable in ${reliable}/${seeds}; mean held-out AUC ${(aucs.reduce((a, b) => a + b, 0) / Math.max(aucs.length, 1)).toFixed(2)}`);
    expect(reliable / seeds).toBeLessThanOrEqual(0.05);
  });

  it('is still learning with fewer than 3 days, however strong', () => {
    const sig = learnSignature(sessions(createRng(1), 2, { [SIGNATURE_CANDIDATE_FIELDS[0]]: 4 }), { id: 'x', state: 'calm', at: 'a', seed: 1, permutations: 49 })!;
    expect(sig.status).toBe('still_learning');
    expect(sig.validation.reasons.join(' ')).toMatch(/3 different days|3 sessions/);
  });

  it('live detector uses dwell and hysteresis and is null without data', () => {
    const sig = learnSignature(sessions(createRng(7), 4, planted), { id: 'x', state: 'calm', at: 'a', seed: 3, permutations: 49 })!;
    const det = createSignatureDetector(sig);
    const stateVals = Object.fromEntries(sig.fields.map((f) => [f.field, f.stateMean + 0.5 * f.direction * f.pooledSd]));
    const restVals = Object.fromEntries(sig.fields.map((f) => [f.field, f.contrastMean]));
    expect(det.update(0, Object.fromEntries(sig.fields.map((f) => [f.field, null]))).score.v).toBeNull();
    let r = det.update(1, stateVals);
    expect(r.active).toBe(false); // dwell not yet met
    for (let t = 1.25; t <= 8; t += 0.25) r = det.update(t, stateVals);
    expect(r.active).toBe(true);
    for (let t = 8.25; t <= 30; t += 0.25) r = det.update(t, restVals);
    expect(r.active).toBe(false);
  });
});

describe('anchors', () => {
  const base = createAnchor({ id: 'a1', name: 'Calm', state: 'calm', signatureId: 'sig', createdAt: '2026-11-20', synth: { root: 220, timbre: 'pad' }, control: { id: 'c1', synth: { root: 247 } } });

  function trials(rng: Rng, anchorEffect: number, n: number): ProbeTrial[] {
    const out: ProbeTrial[] = [];
    for (let i = 0; i < n; i++) {
      for (const cue of ['anchor', 'control'] as const) {
        const delta = (cue === 'anchor' ? anchorEffect : 0) + 0.2 + rng.normal() * 0.6;
        out.push({ sessionId: `s${i}`, day: `2026-11-${10 + (i % 4)}`, t: i * 100, cue, preScore: 0, postMean: delta, delta, latencyS: delta > 0.8 ? 20 : null, reached: delta > 0.8 });
      }
    }
    return out;
  }

  it('working anchor is detected; a null anchor is called working at most at about the nominal rate', () => {
    let working = 0;
    let falseWorking = 0;
    const seeds = 300;
    for (let k = 0; k < seeds; k++) {
      const rng = createRng(k);
      if (evaluateAnchor(recordSession(base, { probes: trials(rng, 1.0, 10) })).verdict === 'working') working++;
      if (evaluateAnchor(recordSession(base, { probes: trials(rng, 0, 10) })).verdict === 'working') falseWorking++;
    }
    console.log(`[anchors] planted anchor effect: working in ${working}/${seeds}; null anchor called working in ${falseWorking}/${seeds}`);
    expect(working / seeds).toBeGreaterThan(0.85);
    expect(falseWorking / seeds).toBeLessThan(0.05);
  });

  it('needs enough trials over enough days', () => {
    expect(evaluateAnchor(recordSession(base, { probes: trials(createRng(1), 2, 3) })).verdict).toBe('too_few_trials');
  });

  it('eligibility requires a reliable signature and 4 of the last 6 sessions', () => {
    const reach = (xs: boolean[]) => xs.map((r, i) => ({ sessionId: `s${i}`, day: `d${i}`, reached: r }));
    expect(anchorEligibility(null, reach([true, true, true, true])).eligible).toBe(false);
    const sig = { status: 'reliable' } as Parameters<typeof anchorEligibility>[0];
    expect(anchorEligibility(sig, reach([true, false, true, false, true, false])).eligible).toBe(false);
    expect(anchorEligibility(sig, reach([false, true, true, false, true, true])).eligible).toBe(true);
  });

  it('pairing gate and probe order', () => {
    expect(canPair({ active: true, forS: 2, now: 100, lastPairT: null, pairsThisBlock: 0 })).toBe(false);
    expect(canPair({ active: true, forS: 6, now: 100, lastPairT: null, pairsThisBlock: 0 })).toBe(true);
    expect(canPair({ active: true, forS: 6, now: 100, lastPairT: 70, pairsThisBlock: 1 })).toBe(false);
    expect(canPair({ active: false, forS: 60, now: 100, lastPairT: null, pairsThisBlock: 0 })).toBe(false);
    const order = planProbeOrder(4, 9);
    expect(order.filter((x) => x === 'anchor').length).toBe(4);
    expect(order).toEqual(planProbeOrder(4, 9));
  });
});
