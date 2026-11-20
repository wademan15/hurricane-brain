# Training layer (`app/src/training`)

Pure, deterministic TypeScript: programs as data, the induction technique library, the session
runner, block statistics, the user profile, personal state signatures and sound anchors. No UI,
no clocks, no `Math.random`. Everything reads only the measurement frames in
`app/src/engine/frames.ts`. Import from `app/src/training` (the `index.ts` barrel).

Tests: `cd app && npx vitest run src/training`. Typecheck: `cd app && npx tsc -b`.
`test-fixtures.ts` builds synthetic frames for tests only; it is never a demo mode.

## How the app uses it

```ts
import { getProgram, instantiateProgram, createSessionRunner, ingestSession, planDiscoverySession,
         bestStrategy, createProfile } from './training';

// 1. Pick a program and the user's variable choices. Profile hints fill strategy slots.
const program = getProgram('alpha_eyes_closed')!;
const plan = instantiateProgram(program, {
  level: profile.programs[program.id]?.level ?? 1,
  values: { train_block_s: 180, alpha_metric: 'spectra[temporal].bands.alpha.above_bg_db' },
  bestStrategy: bestStrategy(profile, 'alpha_ec'),
  resonanceBpm: profile.resonance?.bpm,
});

// 2. Run it. Feed every frame from EngineApi.drain() in order; call advance(t) on a timer if
//    no frames arrive (the session clock still moves; values are then null and reward is 0).
const runner = createSessionRunner(plan, { sessionId, userId, startedAt: new Date().toISOString(), seed,
  posture, checkIn, priorBaselines: profileBaselines, signature, anchor });
for (const f of engine.drain()) runner.push(f);
for (const e of runner.drainEvents()) handle(e);      // guidance, pacer, anchor/control sound, rating prompt, check fit
const out = runner.output();                           // out.reward.level 0..1 drives the reward layer and visuals
// Forward runner.markers() to engine.pushMarker so markers are stored with the raw data.

// 3. When finished (runner.isFinished()), keep the record and fold it into the profile.
const record = runner.record();                         // SessionRecord, validated by validateSession
profile = ingestSession(profile, record);
```

Discovery (profiling): `const dp = planDiscoverySession(profile)` then
`instantiateProgram(getProgram('discovery_sampler')!, { strategySlots: dp.strategies })`.

Anchor test: `instantiateProgram(getProgram('anchor_probe')!, { probeOrder: planProbeOrder(pairs, seed) })`,
run with `{ signature, anchor }`, then `evaluateAnchor(anchorRecord)` after `ingestSession`.

Signature: after emotional practice sessions, `learnSignature(profile.signatureBlocks[state], { id, state, at, seed, previous })`
and store it in `profile.signatures`. It is `still_learning` until it passes held-out and shuffled-label tests over 3+ days.

## Modules

| File | What it does |
| --- | --- |
| `params.ts` | Every provisional number of the training layer, recorded in each session. |
| `fields.ts` | Field paths over frames: `compileField(path).resolve(ctx)` returns `Measured`; null stays null; stale frames are null. Grammar in the file header, including `diff(A, B)`. |
| `program.ts` | The `Program` format (JSON, versioned), `validateProgram`, the five-level `LADDER`, `instantiateProgram` into a `SessionPlan`. |
| `programs/` | The program library (`PROGRAMS`, `getProgram`, `NOT_OFFERED`). |
| `strategies.ts` | The technique library (`STRATEGIES`, `getStrategy`, `strategiesFor`, `CORE_STRATEGIES`). |
| `runner.ts` | `createSessionRunner(plan, opts)`: frames + clock in; reward 0..1, events, markers, `SessionRecord` out. `validateSession`. |
| `stats.ts` | Block statistics with autocorrelation-honest intervals; `compareTechniques` with a "within noise" verdict; session trend correction. |
| `profile.ts` | `UserProfile`, calibration, strategy estimates and labels, Discovery planning (Williams Latin square), recommendations, resonance rate. |
| `signatures.ts` | Learn, validate and live-detect personal state signatures. |
| `anchors.ts` | Anchor records, eligibility, pairing gate, probe order, honest evaluation against a control sound. |

## Runner contract

- Reward is continuous 0..1 (`output().reward.level`), smoothed with one declared time constant
  (`plan.rewardTauS`, recorded). There are no reward events: the reward layer swells and recedes.
- Reward is 0 when the target is null, the frame is stale, gating withholds the moment (fast-frame
  artifact, required channels unusable or below the clean fraction, muscle above baseline + allowance),
  or in feedback-off blocks (baseline, rest, strategy sampler, transfer, probe).
- Thresholds start from the session baseline (or the profile's) and adapt only between feedback
  blocks, toward the level's success centre (60-80% band), with steps capped in baseline SDs.
- Events: `block_start`, `block_end`, `instruction`, `pacer` (bpm or null), `play_anchor`
  (pairing or probe), `play_control` (exposure or probe), `rating_request`, `tether`, `check_fit`, `session_end`.
- Markers (frames.ts `Marker`): block and baseline start/end, technique (planned and reported),
  every instruction and cue, threshold changes, pacer changes, anchor and control plays, pairing
  results, ratings, notes, skip, stop.
- Determinism: block boundaries are scheduled times; the same plan, options and frames give a
  byte-identical record (tested).

## Programs

| id | Name | Target field(s) | Evidence |
| --- | --- | --- | --- |
| `calibration` | Calibration | none (artifact tasks, EO/EC rest) | A |
| `discovery_sampler` | Discovery | none (technique vs preceding rest, feedback off) | B |
| `stillness_soft_landing` | Soft Landing | `quality[*].emg_db` down | A |
| `alpha_eyes_closed` | Calm Alpha | `fast.track[alpha].height_db` or `spectra[temporal].bands.alpha.above_bg_db` | B |
| `alpha_eyes_open` | Open-Eyed Calm | same, eyes-open baseline | B |
| `theta_drift` | Theta Drift | `spectra[temporal].bands.theta.above_bg_db` | B-C |
| `alpha_theta_twilight` | Twilight | theta + `diff(theta, alpha)` | B-C |
| `sleep_onset_descent` | Descent | `diff(theta, alpha)`; delta displayed only, low confidence | B-C |
| `golden_ratio_alignment` | Golden Ratio Alignment | `cascades.phi.excess_a` (or `_b`), slow reward | C |
| `golden_cascade_growing` | Growing the Cascade | `cascades.phi.steps` + excess | C |
| `octave_alignment` | Octave Alignment | `cascades.octave.excess_a` (or `_b`) | C |
| `hemisphere_balance` | Balance | `hemispheres[alpha|theta].match` | D (labs) |
| `frontal_approach_balance` | Approach Balance | `diff(AF8 alpha, AF7 alpha)` | C (labs) |
| `hrv_resonance_finding` | Find Your Breathing Rate | pacer trials 6.5..4.5/min; `heart.lf_power` | A |
| `hrv_resonance_breathing` | Calm Heart | `heart.resonance_strength` (or RMSSD, LF) | A |
| `high_hrv_state` | High Variability | `heart.rmssd_ms` | A-B |
| `brain_heart_calm` | Brain and Heart | alpha + `heart.resonance_strength`, coupling displayed with chance | B-C |
| `emotional_state_practice` | Emotional State Practice | none (marked state/contrast blocks) | B |
| `signature_practice` | Signature Practice | personal signature score | B |
| `anchor_pairing` | Anchor Pairing | signature; anchor plays only while detected | C |
| `anchor_probe` | Anchor Test | none (anchor vs control cues) | C |

Not offered (`NOT_OFFERED`): gamma, SMR, frontal-midline theta, waking delta, upper alpha (needs a
field), entrainment.
