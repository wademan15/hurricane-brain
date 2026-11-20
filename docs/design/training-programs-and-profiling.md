# Training programs, user profiling and personal anchors: design

Status: first full draft, 2026-11-20. Research basis:
[`../research/brainwave-induction-research.md`](../research/brainwave-induction-research.md)
(section numbers below like "R4.3" point into it).

This document turns the research into something the build team can implement:
a strategy library, an onboarding assessment that profiles each user with their
own EEG, a set of training programs, a personal-anchor (signature sound)
system, and the data the signal engine must provide. Signal processing details
(filters, artifact detectors, the golden-ratio detector) belong to the signal
engine spec; this doc states what it needs from that spec.

---

## 1. Design principles

1. **Measure, don't assume.** Most induction techniques are Grade B–D (R1).
   Every user gets an objective, per-strategy answer from their own EEG.
2. **Individual first.** Bands are set from each user's individual alpha
   frequency (R2.1). Strategies, sounds, posture and time of day are chosen per
   person. Questionnaires are only a starting guess (R8).
3. **Allow, don't strive.** Effort blocks alpha (R3). Copy, voice and audio
   invite settling, never performance pressure.
4. **Never reward artifact.** Blinks, eye rolls, jaw clench, movement and poor
   contact are detected and excluded before anything is scored (R2.2).
5. **Gentle, continuous sound.** Feedback is a living soundscape whose warmth,
   depth and fullness follow the state. No beeps, no sudden onsets, slow fades
   (Jesus's requirement; R4.10 on orienting responses).
6. **Honest reporting.** The app tells users what moved and what did not,
   including "this technique did not change your brain".
7. **Built for later merging.** Timestamps, event markers and a strategy-arm
   interface leave room for HRV (Polar H10), breath pacing and EarthSync
   entrainment (R6.5, R9).

---

## 2. Target states the app can honestly train on Muse

| ID | State | Primary metric | Channels | Evidence for training | Muse feasibility |
|---|---|---|---|---|---|
| `stillness` | Soft face and jaw, still head | EMG power 30–100 Hz down; accelerometer still | all + ACC | A | Excellent |
| `alpha_ec` | Relaxed alpha, eyes closed | IAF-band periodic alpha (above 1/f fit) | TP9, TP10 | B | Good |
| `alpha_eo` | Calm alpha, eyes open | Same, eyes open, defocused gaze | TP9, TP10 | B | Fair |
| `upper_alpha` | Calm alertness | IAF to IAF+2 Hz alpha, eyes open | TP9, TP10 | B | Fair |
| `alpha_theta` | Twilight / hypnagogic edge | theta/alpha ratio, crossover events, not asleep | TP9, TP10 | B–C | Fair |
| `descent` | Sleep wind-down | alpha dropout, theta rise, then spindles/delta (Muse S) | all | A (stages exist) | Good on Muse S |
| `golden` | Golden ratio alignment | alpha:theta peak ratio near phi (spec owns detector) | TP9, TP10 | C (R6.1) | Fair |
| `approach` | Approach / positive-mood asymmetry | AF8 vs AF7 alpha asymmetry | AF7, AF8 | C | Experimental |
| `calm_heart` (later) | High-HRV resonance | 0.1 Hz HR oscillation amplitude, RMSSD | Polar H10 | A | Needs H10 |

**Not offered**, with an explanation in-app if a user asks: gamma training and
SMR training (Muse cannot measure them honestly, R2.2), frontal-midline theta
(needs Fz), and waking delta training (artifact).

---

## 3. Strategy library

A strategy is one way of trying to reach a state. Each has an ID, a modality
tag used for profiling, scripted guidance (voice and text) in three lengths,
the states it plausibly serves, and its artifact risks.

| ID | Strategy | Modality | Serves | Artifact risk | Grade |
|---|---|---|---|---|---|
| `none` | No strategy: rest and let the sound guide you | non-effort | all | low | B |
| `open_awareness` | Rest in open awareness, let thoughts pass | non-effort | alpha, alpha_theta | low | B |
| `breath_slow` | Paced breathing at the user's resonance rate (default 5.5/min) | breath | alpha, calm_heart | low | B |
| `breath_long_exhale` | Natural inhale, slow long exhale | breath | alpha, stillness | low | B–C |
| `breath_count` | Count breaths 1–10 and restart | breath / attention | alpha | low | B |
| `breath_nostril` | Attention on air at the nostrils | interoceptive | alpha | low | B |
| `body_scan` | Slow scan from crown to feet | somatic | stillness, alpha | low | B |
| `heavy_warm` | Autogenic: arms and legs heavy and warm | somatic | alpha, alpha_theta | low | B |
| `face_soften` | Soften brow, jaw, tongue, eyes | somatic | stillness | low | A |
| `visual_calm` | Calm low-detail scene (still lake, warm light) | visual | alpha | medium (eye movement) | B–C |
| `visual_drift` | Floating, drifting imagery | visual | alpha_theta, descent | medium | C |
| `visual_color` | Breathe a colour or soft light | visual | alpha | medium | C–D |
| `brow_point` | Rest attention at the brow point, eyes relaxed not crossed | attentional | alpha | **high (EOG)** | C–D |
| `soft_gaze` | Eyes open, wide defocused panoramic gaze | attentional | alpha_eo | medium | B |
| `mantra_silent` | Silent repeated word or phrase, effortless | verbal | alpha, alpha_theta | low | B–C |
| `hum_then_silence` | Hum on exhale for a minute, then rest in silence (score silence only) | auditory / breath | alpha | high while humming | C |
| `listen_sound` | Rest attention on a continuous sound | auditory | alpha | low | B |
| `descent_count` | Count slowly down from 100, letting each number sink | hypnotic | alpha_theta, descent | low | B–C |
| `entrain_binaural` | Binaural beat at alpha or theta rate under the soundscape | entrainment | alpha, alpha_theta | stimulus confound (R4.10) | B–C |
| `entrain_iso` | Isochronic pulses (later: EarthSync stimuli) | entrainment | alpha, alpha_theta | stimulus confound | C |
| `emotion_recall` | Recall a specific moment of a target emotion | emotional | emotional states (§7) | low | A (self-report) |
| `loving_kindness` | Wish well to self and others | emotional | warmth, calm_heart | low | B |
| `appreciation_heart` | Heart-area attention with appreciation and slow breath | emotional / breath | calm_heart | low | B–C |

The library is data, not code: new strategies (including EarthSync stimuli)
are added as entries with the same fields, and the profiling engine picks
them up automatically.

---

## 4. Session variables

Variables are either **set by the program**, **chosen by the user**, or
**logged** so the profile can control for them (R4.13).

| Variable | How captured | Use |
|---|---|---|
| Time of day, weekday | automatic | best-time recommendations |
| Session length, block structure | program | analysis |
| Eyes open / closed | program instruction, verified by blink rate and alpha jump | confirm condition |
| Posture (upright, reclined, lying) | user choice, verified by Muse accelerometer pitch | posture effect per user |
| Sound environment (silence, nature, soundscape type, entrainment) | user choice | sound preference per user |
| Guidance level (full voice, sparse cues, none) | program level | progression |
| Feedback on/off (transfer blocks) | program | skill transfer |
| Sleep last night (hours, quality 1–5) | 10-second pre-session check-in | confound control |
| Caffeine, alcohol, nicotine in last 4 h | check-in toggles | confound control |
| Mood and energy (1–5 each) | check-in sliders | confound control, emotion work |
| Headset model and fit quality | automatic | quality gate |
| Signal quality per channel, % clean epochs | automatic | quality gate |
| Post-session: depth, ease, pleasantness, emotional intensity (1–5) | 15-second check-out | subjective profile |
| Free note | optional | qualitative |

Check-in and check-out must stay under 20 seconds combined or people will stop
doing them. Voice answers are welcome.

---

## 5. Onboarding assessment ("Discovery")

Goal: within the first week, give each user a profile that says which
strategies, sounds and postures move their brain toward each state, with
honest confidence levels.

### 5.1 Stage A: setup and safety (2 minutes, once)
- Safety questions: epilepsy or seizures, trauma or dissociation history,
  psychosis or bipolar history, currently driving (R10). Answers adjust which
  programs unlock.
- Headset fit coaching with live per-channel quality, until all four channels
  are good for 10 seconds.

### 5.2 Stage B: short trait questionnaire (3–4 minutes, once, skippable)
Used only as Bayesian priors (§5.6), never as a label.
- Imagery vividness: 4-item VVIQ short form plus one aphantasia check
  ("When you picture an apple, do you see anything?").
- Absorption: 6 items from a short absorption scale.
- Interoception: 4 items (noticing breath and heartbeat).
- Meditation experience: none / some / regular / years, and which styles.
- Anxiety: 2 items (GAD-2).
- Chronotype and usual sleep.
- Comfort with technology / sense of control (2 items).

### 5.3 Stage C: physiological calibration (about 8 minutes, once, repeated monthly)
1. **Artifact calibration (90 s):** guided blinks, look left/right, look up,
   clench jaw, raise eyebrows, swallow, small head nod. Each is timestamped so
   the engine can tune per-person artifact detectors.
2. **Rest, eyes open (2 min)** fixating a soft point.
3. **Rest, eyes closed (2 min).**
4. **Repeat eyes open (1 min) and closed (1 min)** to check stability.

Outputs:
- **IAF** (peak alpha frequency) and alpha bandwidth, from eyes-closed data
  with 1/f removed.
- **Theta peak** if present, and the resting **alpha:theta ratio** (feeds the
  golden-ratio work).
- **Alpha reactivity** (eyes-closed ÷ eyes-open alpha). Low reactivity flags a
  likely "low-alpha" person, who will be steered toward stillness, breath and
  HRV goals with a kind explanation.
- **Aperiodic exponent** at rest.
- **Baseline EMG** level (tension profile).
- **Personal artifact signatures.**

### 5.4 Stage D: strategy sampler (sessions 1–5, about 20 minutes each)
This is the heart of the profiling. It is a small within-person experiment.

**Block design (per session):**
```
[settle 2 min] then repeat 5–6 times:
  [neutral rest 60 s] [strategy X 90 s] [rating 5 s]
[closing rest 60 s]
```
- **Neutral rest** is eyes closed, "simply rest", same constant soundscape.
  It is the within-session baseline for the following strategy block.
- **During sampler blocks the soundscape does not respond to the EEG.** This
  measures the strategy's own effect, separate from feedback learning.
- Each session tests 5–6 strategies; across five sessions every core strategy
  is tested at least twice, in a **counterbalanced order** (Latin square), so
  drowsiness creeping up across a session does not favour whatever comes last.
- The first session always includes `none`, `breath_slow`, `body_scan`,
  `visual_calm` and `mantra_silent` so everyone gets broad coverage on day one.
- After each block, a single tap: "How easy was that?" (1–5).

**Per-block metrics (computed by the engine on clean epochs only):**
- `effect_alpha`: log ratio of IAF-band periodic alpha in the strategy block vs
  the preceding rest block, after removing the session's linear time trend.
- `effect_theta_alpha`: change in theta/alpha ratio (for deep states).
- `effect_emg`: change in EMG power (stillness).
- `latency`: seconds from block start until the metric first exceeds the rest
  median plus one rest SD.
- `stability`: fraction of the block above that level.
- `clean_fraction`: share of epochs that passed artifact rejection. Blocks
  below 60% clean are excluded and re-queued.
- `ease` and later `pleasantness` ratings.

### 5.5 Stage E: variables sampler (woven into sessions 3–10)
Once the top strategies are known, later sessions vary one other factor at a
time using the user's best strategy: posture (upright vs reclined), sound
environment (silence, nature, soundscape, binaural), and time of day (logged
naturally). Same rest/active block structure.

### 5.6 Statistics: how the profile is estimated
- **Model:** a hierarchical Bayesian model per target state:
  `effect[user, strategy, block] = population_mean[strategy] + user_offset[user, strategy] + trait_terms + confounds + noise`.
  - `population_mean` comes from all consenting users (it starts from
    literature-informed priors and improves as the product grows).
  - `trait_terms` let questionnaire answers shift the prior (for example high
    VVIQ raises the prior for visual strategies; aphantasia sets it near zero).
  - `confounds` include sleep, caffeine, time of day and posture.
- **Output per strategy:** a posterior mean effect and an interval, mapped to
  plain labels: **Strong for you**, **Promising**, **Unclear yet**, **Not your
  path right now**.
- **Choosing what to try next:** Thompson sampling (a multi-armed bandit). The
  app mostly offers what works for the person, but keeps exploring strategies
  that are still uncertain. Exploration never drops to zero, because what
  works changes as skill grows.
- **Reliability check:** once a user has two sessions per strategy, compute the
  test-retest agreement of their rankings. If it is poor, the profile says
  "still learning about you" rather than over-claiming.
- A lightweight version (per-strategy running means with simple shrinkage) is
  enough for the first build; the full model can come later.

### 5.7 The profile (what the user sees)
"Your Brain Profile" card:
- Your alpha frequency, and how strongly your alpha responds to closing your
  eyes.
- Your top three pathways into calm alpha, deep states, and stillness, each
  with an honest strength label.
- Approaches that did not move your brain (with reassurance that this is
  common).
- Best posture, sound setting and time of day (once known).
- How your sense of a session compares with what your brain did ("you often
  feel deeper than the data shows during visualization" is useful insight).
- Your personal anchors (§7) and their measured strength.

---

## 6. Training programs

### 6.1 Shared structure
Every program uses the same ladder. Users advance when they meet the criterion
in two of their last three sessions.

| Level | Guidance | Feedback | Eyes | Criterion to advance |
|---|---|---|---|---|
| 1 Guided | Full voice using the user's best strategy | Continuous | Program default | ≥60% time in target over last 10 min |
| 2 Sparse | A cue every few minutes | Continuous | Program default | ≥60% time, latency under 90 s |
| 3 Silent | None | Continuous | Program default | ≥65% time, latency under 60 s |
| 4 Transfer | None | **Off** for alternating 2-min blocks | Program default | Off-blocks reach ≥75% of on-block effect |
| 5 Everyday | 1–3 minute micro-sessions, eyes open where possible | Optional | Open | Reaches target within 60 s, three days in a row |

**Session shape (levels 1–4):** 2 min settle, then 3–5 min training blocks with
20 s rests, total 15–30 min depending on user preference, then 1 min closing
rest. Two to five sessions per week is the realistic range; learning curves
are usually visible within 5–20 sessions (R5.8).

**Adaptive threshold:** the reward threshold is a percentile of the user's own
recent distribution (last 2–3 minutes), set so the soundscape is "rewarding"
about 70% of the time at level 1, falling to 60% at higher levels. The
threshold moves slowly (time constant around 60 s) so the user is not chasing
a moving target.

**Feedback mapping (all programs):**
- Base layer: the user's chosen soundscape, always present at a comfortable
  low level.
- Reward layer: as the metric rises above threshold, a warm layer swells in
  (for example a soft pad or cello-like drone), the low-pass filter opens
  slightly so the sound gets fuller and warmer, and a gentle stereo width
  increases. All parameters smoothed with 1–3 s time constants and capped
  rate of change, so nothing ever jumps.
- When the metric falls, the reward layer gently recedes; it never stops
  abruptly and nothing negative is played.
- Bad signal: the reward layer holds steady and slowly fades to neutral; after
  20 s of bad signal a soft voice says "let's adjust the headband". No alarm.
- Exact sound design belongs to the audio team; these are the behaviours it
  must meet.

### 6.2 Programs

**P1 Soft Landing** (`stillness`) — everyone's first program.
- Why: EMG relaxation is trainable, quickly felt, cleans the EEG for every
  later program, and works for "low-alpha" people too.
- Feedback: soundscape opens as forehead and jaw EMG falls and the head is still.
- Strategies offered: `face_soften`, `body_scan`, `breath_long_exhale`.
- Length: 8–12 min. Usually 1–3 sessions to graduate.

**P2 Calm Alpha** (`alpha_ec`)
- Eyes closed, seated upright or slightly reclined.
- Metric: periodic alpha at TP9/TP10 in the user's IAF band, relative to their
  eyes-closed baseline. Target is to reach baseline-plus quickly and hold it,
  not to break records (R3).
- Strategies: the user's top three from Discovery.

**P3 Open-Eyed Calm** (`alpha_eo`)
- Eyes open, soft gaze at a dim, plain point or at the hurricane visual at very
  low contrast. Bridges calm into daily life.
- Metric: same as P2 but relative to the eyes-open baseline.
- Unlocks at P2 level 3.

**P4 Clear Mind** (`upper_alpha`)
- Eyes open, upright. Rewards the upper-alpha band (IAF to IAF+2 Hz) with EMG
  held low, for calm alertness before work or study.
- Evidence B (Zoefel 2011; Nan 2012). Present as "calm focus practice", no
  cognitive-enhancement claims.

**P5 Twilight** (`alpha_theta`)
- Eyes closed, reclined, Muse S recommended for comfort.
- Two-layer feedback in the classic alpha-theta spirit, rendered gently: an
  "alpha" texture (soft flowing water or warm pad) and a deeper "theta" texture
  (low bowl-like drone). They crossfade according to the theta/alpha ratio, so
  the user hears themselves drift deeper. A **crossover** (theta above alpha
  for several seconds) is marked by the theta texture blooming slightly, never
  by a discrete sound.
- **Wake tether:** if markers of sleep appear (sustained alpha loss with rising
  slow activity and no movement, later spindles, or the user has gone
  unresponsive), the soundscape slowly brightens and a quiet voice invites a
  slightly deeper breath. The goal is to stay on the edge. Users can switch
  the tether off if they want to drift into sleep.
- Strategies: `visual_drift`, `heavy_warm`, `descent_count`, `mantra_silent`.
- Safety: unlocks after P2 level 2; shows a one-time note that strong images or
  feelings can arise, with a grounding exit (open eyes, feet on floor, long
  exhale; feedback fades out over 10 s).

**P6 Descent** (`descent`)
- Bedtime wind-down with Muse S. Feedback gradually fades out as the person
  reaches sleep onset, then the app goes silent and keeps recording if the user
  allowed overnight recording.
- Framed as wind-down, not as a sleep treatment (R5.5).
- Later option: replay the user's calm anchor softly in light sleep (targeted
  reactivation, R7.4), as an experiment the user opts into.

**P7 Golden Ratio Alignment** (`golden`)
- Built on the signal-engine spec's detector. This doc supplies the practice
  context: eyes closed, reclined or seated, using the user's best deep-state
  strategy, with feedback reflecting time spent with the alpha:theta peak ratio
  near phi.
- Copy should present it as emerging science (R6.1).

**P8 Balance** (`approach`) — experimental, behind a "labs" switch.
- Frontal alpha asymmetry feedback with positive-emotion strategies.
- Grade C on Muse; shown with an honest "experimental" badge.

**P9 Emotional states** — see §7.

**P10 Calm Heart** (`calm_heart`) — when the Polar H10 is integrated.
- Resonance breathing with a gentle breath pacer, finding each user's
  resonance rate (test 6.5 down to 4.5 breaths per minute, choose the one with
  the largest 0.1 Hz heart-rate oscillation, per Lehrer's protocol).

### 6.3 Non-responder pathway
If after five sessions a user's best strategy for a state is still "Unclear"
and their ladder progress is flat (R5.7):
1. Re-check fit and artifact rate; poor signal is the most common hidden cause.
2. Switch target to one that works for almost everyone (`stillness`, breath
   pacing, later `calm_heart`).
3. Try strategies outside their questionnaire-predicted modality.
4. Try a different posture and time of day.
5. Tell them plainly, kindly, that some brains show this rhythm less, and
   that the practice still has value.

---

## 7. Emotional states and personal anchors

### 7.1 Emotional-state training
Targets (each one a "state" in the same framework):
`calm`, `warmth` (compassion/loving-kindness), `gratitude`, `awe`, `confidence`,
`joyful_energy`.

**Definition of a state for one user:** the combination of
- the user's own rating (target emotion intensity, 1–5),
- the EEG profile during it (arousal markers from alpha, EMG and beta; rough
  approach index from AF7/AF8 asymmetry),
- and, once integrated, HRV (RMSSD, 0.1 Hz power, heart rate).

Because EEG cannot reliably tell joy from gratitude across people (R7.2), the
app builds a **personal state signature**: the average feature pattern across
that user's sessions where they rated the emotion strongly. The next session
is scored by how close the live features are to that signature
(a distance in standardised feature space), not by a generic emotion detector.

**Induction methods** (strategies, tested by the same profiling engine):
`emotion_recall` (a specific memory, with gentle prompts for sensory detail),
`loving_kindness`, `appreciation_heart`, guided imagery for awe, and posture
and breath cues for confidence.

**Honesty rule:** calm and warmth are the states most visible in physiology
(low arousal, higher HRV). High-energy positive states (joy, excitement)
look physiologically like other arousal; the app should say so and lean on
the personal signature plus self-report.

### 7.2 Personal anchors (signature sounds)

Jesus's idea: once a user can reliably produce a state, pair it with a
signature sound unique to them, so that the sound alone later helps bring the
state back. This is classical conditioning (R7.4). The design follows the
learning-theory rules so it actually works and so we can prove whether it does.

**Phase 0: earn it.** A state becomes eligible for an anchor when the user
has reached it (personal signature distance under threshold and rating ≥4) in
at least 4 of their last 6 sessions.

**Phase 1: create the sound.** The user picks from 3–4 procedurally generated
candidates, each a short (4–8 s) warm, slow-onset motif. Candidates are built
from the user's own data so each is unique: for example pitches chosen in
ratios taken from their IAF and alpha:theta ratio, and a timbre family they
rated pleasant in Discovery. Rules: soft attack (at least 300 ms), warm
mid-range, no high-pitched content, clearly distinct from the everyday
feedback soundscape (novel sounds condition faster). Each anchor gets an ID and
is stored with its full synthesis parameters so it is exactly reproducible.

**Phase 2: pairing (acquisition).** During sessions in the target state:
- The anchor plays **only when the live state is above threshold** and has
  been for a few seconds, fading in gently over the reward layer.
- Aim for about 30–60 pairings over 8–12 sessions, spaced across days and
  ideally across settings (home, outdoors, different times) so it generalises.
- The anchor is **never** used for anything else: not notifications, not
  alarms, not menus. That would teach the brain that the sound means nothing.

**Phase 3: test it honestly.** Every few pairing sessions, run a short probe
from a neutral state:
- Play the anchor, and on another trial a **control sound** of equal
  familiarity that was never paired (the user hears it the same number of times
  during neutral rest blocks).
- Measure movement toward the state signature over the 60 s after each sound.
- The anchor is "working" when its effect reliably exceeds the control sound's.
  The profile shows this as an anchor strength meter with its real data.

**Phase 4: use and maintain.**
- The user can call the anchor on demand (before a talk, at bedtime, in a
  stressful moment) through a one-tap "anchor" button or a widget.
- To prevent extinction, the app keeps re-pairing: roughly one in three
  practice sessions includes reinforced pairing, and on-demand uses are
  followed by a short guided top-up when the user has a minute (partial
  reinforcement is more durable, R7.4).
- If anchor strength drops, the app suggests a refresher block.

**Multiple anchors.** Each user can build several (for example calm,
warmth, confidence), each with its own sound. Sounds must be clearly distinct
from one another to avoid generalisation between them.

**Later options:** play the calm anchor during light sleep (targeted
reactivation experiment), share the anchor sound as a file for offline use,
and use HRV-confirmed pairing once the H10 is in.

**Claims:** we present anchors as a personal experiment ("your anchor
currently shifts your brain X% toward your calm state compared with a neutral
sound"), never as guaranteed.

---

## 8. What the signal engine must provide

For the signal-engine spec thread and the build team:

1. **Per-epoch features** (1 s epochs, 0.25 s hop suggested), per channel:
   - band power in IAF-relative bands, both total and **periodic above the
     aperiodic fit**;
   - aperiodic exponent and offset;
   - alpha and theta peak frequencies, and their ratio;
   - EMG power (30–100 Hz);
   - artifact flags: blink, horizontal and vertical eye movement, jaw/EMG burst,
     movement (accelerometer), poor contact.
2. **Per-user calibration store**: IAF, bandwidth, reactivity, baselines,
   personal artifact templates, monthly history.
3. **Event markers** on the same clock: block start/end, strategy ID, guidance
   cue played, feedback on/off, anchor played, control sound played, ratings.
4. **A shared monotonic clock** and per-sample timestamps for Muse, and later
   Polar H10 RR intervals and ECG, so EEG-HRV coupling can be computed
   (R9).
5. **Session record schema** (sketch):
   ```ts
   type StrategyId = string;           // from the strategy library
   type StateId = string;              // e.g. "alpha_ec", "calm"
   interface Block {
     kind: "settle" | "rest" | "strategy" | "train" | "transfer" | "probe";
     strategy?: StrategyId; target?: StateId;
     feedback: boolean; startMs: number; endMs: number;
     cleanFraction: number;
     metrics: Record<string, number>;   // effect_alpha, latency, stability, ...
     rating?: { ease?: number; depth?: number; emotion?: number };
   }
   interface Session {
     id: string; userId: string; headset: "muse2" | "museS" | "athena" | string;
     startedAt: string; posture: "upright" | "reclined" | "lying";
     checkIn: { sleepHours?: number; sleepQuality?: number; caffeine?: boolean;
                alcohol?: boolean; mood?: number; energy?: number };
     program?: string; level?: number; blocks: Block[];
   }
   interface StrategyEstimate {
     state: StateId; strategy: StrategyId;
     mean: number; lo: number; hi: number; nBlocks: number;
     label: "strong" | "promising" | "unclear" | "not_now";
   }
   interface Anchor {
     id: string; state: StateId; synth: Record<string, number | string>;
     pairings: number; probes: { anchorEffect: number; controlEffect: number; at: string }[];
   }
   ```
6. **Privacy:** raw EEG and profiles are personal health-adjacent data. Store
   locally by default, sync only with consent, and keep the population model
   on aggregated, consented effect sizes.

---

## 9. Validation plan

1. **Jesus as first user** (Muse 2 and later H10): run Discovery and two weeks
   of programs; check that artifact rejection works (no reward from blinks or
   eye rolls), that profiles are stable session to session, and that the audio
   meets the gentleness requirement.
2. **Small pilot (10–20 people)** across headsets: test-retest reliability of
   strategy rankings (target intraclass correlation ≥0.5 before showing
   "Strong" labels), completion rate of Discovery, and how many users get at
   least one "Strong" strategy.
3. **Built-in controls:** transfer blocks, the anchor control sound, and
   occasional "feedback from a recording" sham blocks (opt-in, labs only) to
   check that learning is specific.
4. **Bench tests for the engine:** recorded artifact sessions (blinks, jaw,
   eye rolls, walking) must not raise any reward metric.

---

## 10. Open questions for Jesus

1. Discovery takes about five 20-minute sessions. Is that acceptable, or
   should we offer a "quick profile" in one 15-minute session with lower
   confidence?
2. Should the twilight program's wake tether be on by default?
3. Should anchors be available to every user, or unlocked as an achievement
   after the eligibility criterion?
4. Are you comfortable with an optional, consented population model (pooled
   effect sizes only) to make everyone's priors better?
