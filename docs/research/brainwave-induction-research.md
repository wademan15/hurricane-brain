# Inducing brainwave states: research brief

Status: first full draft, 2026-11-20. Owner: training-programs research.
Companion design doc: [`../design/training-programs-and-profiling.md`](../design/training-programs-and-profiling.md).

This brief collects what is known about deliberately shifting EEG rhythms
(alpha, theta, delta and others) with mental techniques, sound and
neurofeedback, and what that means for an app built on Muse headsets. It is
written to be honest about evidence. Where a practice is traditional or
anecdotal we say so, and where the Muse cannot see a rhythm we say that too.

Citations are given as author and year so the team can look them up. Every
reference was checked against the real paper (publisher pages, PubMed records,
library catalogues) on 2026-11-20; claims that overstated or misattributed a
paper were corrected and grades adjusted. A few page numbers and DOIs could not
be fetched and are marked "unverified". Frontier observations (Grade F) are
kept on purpose and are not expected to have citations.

---

## 1. Evidence grades used in this document

| Grade | Meaning |
|---|---|
| **A** | Replicated across many labs, or a meta-analysis with consistent effects. Safe to build on. |
| **B** | Several controlled studies point the same way, with some inconsistency or small samples. Build on it, but measure. |
| **C** | Small, uncontrolled, or single-lab studies. Treat as a hypothesis to test with our own data. |
| **D** | Tradition, practitioner reports, or marketing. Offer it as an option only, never as a claim. |
| **F** | Frontier: first-hand observations (including Jesus's own EEG recordings) and practitioner work ahead of the peer-reviewed literature. Kept deliberately, labelled honestly, and treated as something our own data can test. |

The single most important design consequence of this table: **because most
techniques sit at B to D, the app must measure what works for each person
instead of asserting it.** That is the basis for the profiling design.

---

## 2. What the bands are, and what a Muse can actually see

### 2.1 Bands (conventional edges; we will individualise them)

| Band | Typical range | Associated with | Grade |
|---|---|---|---|
| Delta | 0.5–4 Hz | Deep NREM sleep. In waking adults, mostly artifact or pathology. | A |
| Theta | 4–8 Hz | Drowsiness and sleep onset (hypnagogia); frontal-midline theta during focused internal attention and some meditation. | A for drowsiness, B for meditation |
| Alpha | 8–12 Hz | Relaxed wakefulness, eyes closed, internally directed attention, inhibition of visual processing. | A |
| Low / high alpha | ~8–10 / ~10–12 Hz | Low alpha tracks general alertness; upper alpha tracks task-specific and memory processes (Klimesch 1999). | B |
| SMR / low beta | 12–15 Hz | Still, alert body (sensorimotor strip). | B, but not reachable on Muse |
| Beta | 15–30 Hz | Active thinking, alertness, anxiety; heavily contaminated by muscle. | A for existence, C for consumer-headset measurement |
| Gamma | 30–100 Hz | Binding and attention; reported high in long-term meditators (Lutz et al. 2004). | B in lab, **D on Muse** (dominated by muscle) |

**Individual alpha frequency (IAF).** Peak alpha varies from about 8 to 12.5 Hz
between people, falls with age, and shifts with arousal (Klimesch 1999; Corcoran
et al. 2018 published an automated IAF estimator). Fixed 8–12 Hz bands mislabel
part of one person's alpha as theta or beta. The engine should estimate IAF in
onboarding and define bands relative to it (for example theta = IAF−6 to IAF−2,
alpha = IAF−2 to IAF+2). Grade A for the existence of IAF variation, B for the
use of IAF-based bands in successful training studies (Nan et al. 2012; Zoefel et al. 2011). Whether IAF-based bands train *better* than fixed bands has not been tested head to head: Grade C.

### 2.2 Muse sensor geometry and its consequences

Muse 2 and Muse S (Gen 1/2) record four EEG channels at 256 Hz: **TP9, AF7, AF8,
TP10**, referenced at Fpz. Athena adds hardware (including fNIRS) and a new
protocol but keeps the same broad frontal and temporal placement. Krigolson et
al. (2017) showed Muse can record standard ERP components, so it is a real EEG,
but it has blind spots:

| Target | Can Muse see it? | Notes |
|---|---|---|
| Posterior alpha (O1/O2/Pz) | **Partly**, via TP9/TP10 | Temporal sites pick up eyes-closed alpha well in most people. Good primary alpha site. |
| Frontal alpha | Yes, AF7/AF8 | Smaller amplitude and contaminated by blinks and eye movements. |
| Frontal alpha asymmetry | Approximately (AF7 vs AF8) | Close to F7/F8, not the classic F3/F4. Experimental. |
| Frontal-midline theta (Fz) | **No**, only indirectly | Fm-theta is at Fz. AF7/AF8 theta is dominated by eye movement in the 1–7 Hz range. |
| Hypnagogic theta | Yes, roughly | Diffuse theta rise at sleep onset shows on all channels once eyes are still and closed. |
| Waking delta | **Mostly artifact** | Eye movement, sweat, cable or band movement. Only trust delta in sleep. |
| SMR (C3/C4/Cz) | **No** | Do not offer SMR training on Muse. |
| Gamma | **Mostly muscle** | Jaw, forehead and temporalis EMG overlap 20–100 Hz at exactly TP9/TP10. Do not offer gamma training. |
| EMG (muscle tension) | **Yes, very well** | This is a feature: relaxing forehead and jaw is genuinely trainable and helps every other protocol. |
| Blinks / eye movement | Yes, AF7/AF8 | Must be detected and removed, and can also be used as a calibration and a stillness signal. |

**Design rule:** every protocol must declare which channels it uses, and the
engine must reject or down-weight epochs with eye, muscle or contact artifact.
A single blink adds large low-frequency power at AF7/AF8 and would be rewarded
as "theta" or "delta" by a naive system. That is the most common way consumer
neurofeedback rewards the wrong thing.

---

## 3. The foundational fact about "alpha training"

Early alpha biofeedback (Kamiya 1968, 1969) showed people can
learn to raise alpha. Lynch and Paskewitz (1971), Mulholland (1968, 1972) and
Paskewitz and Orne (1973) then argued that much of that "gain" is **learning to stop blocking alpha**: alpha is
suppressed by visual input, visual fixation and focusing (accommodation and
vergence), eye movement, and effortful attention to the outside. With eyes
closed, a calm person is already near their natural alpha ceiling. Kamiya and
Hardt disputed how far this goes, so treat it as Grade B.

Consequences for us (Grade B):

1. The meaningful baseline is the person's **eyes-closed resting alpha**, not
   zero. Gains above that ceiling are modest; the real skill is reaching and
   holding it quickly, and keeping it with eyes open.
2. Trying hard suppresses alpha. Effort, striving and analytic monitoring are
   among the most reliable alpha blockers. Instructions should invite
   *allowing*, not *achieving*.
3. Kober et al. (2013) found that in SMR training, people who reported **no
   specific strategy** learned best, though that comparison rests on very few
   people (Grade C). A 2025 conference poster (McGowan et al., CNS*2025, n = 11)
   found lower reported effort went with higher posterior alpha (Grade C–D).
   Together with the alpha-blocking literature this is enough to treat
   "no strategy / let the sound guide you" as a first-class strategy in the
   profile, not a fallback, and to test it rather than assume it.

---

## 4. Techniques that shift brain rhythms

Each entry lists the mechanism, the expected EEG change, what the Muse will see,
the evidence grade, and who it may suit. "Suits" lines are hypotheses for the
profiling engine to test, not facts.

### 4.1 Eyes closed vs eyes open
- **Effect:** Closing the eyes raises posterior alpha within about a second (the
  Berger effect). Barry et al. (2007) quantified it across bands.
- **Muse:** Clear at TP9/TP10 in most users. A minority (perhaps 5–10%) show low
  alpha regardless ("low-alpha" individuals), which should be detected in
  onboarding, not treated as failure.
- **Grade:** A.
- **Use:** Onboarding calibration (alpha reactivity) and the first rung of every
  alpha program. Eyes-open alpha is a later, harder level.

### 4.2 Gaze: soft gaze, defocus, and "between the eyes"
- **Mechanism:** Visual fixation and accommodation suppress alpha; a defocused,
  wide "panoramic" gaze should therefore suppress it less. Mulholland and Peper
  (1971) tied alpha suppression to focusing, converging, tracking and fast eye
  movements; the panoramic-gaze step is our inference, not tested directly.
  Practices that direct attention to the brow point (ajna, "third eye"),
  candle gazing (trataka), or an upward eye roll have long traditions; the
  upward roll is also part of Spiegel's hypnotic induction.
- **Expected change:** Defocused gaze with eyes open can permit alpha. Eyes-closed
  brow focus is reported to deepen absorption.
- **Muse caveat:** Converging or rolling the eyes upward creates a large, steady
  electro-oculogram shift at AF7/AF8. **We must not reward that as a brainwave
  change.** For brow-point focus, use TP9/TP10 for scoring and instruct
  "rest attention at the brow, eyes relaxed, not crossed".
- **Grade:** B for defocus permitting alpha; C–D for brow-point focus
  specifically. No good controlled EEG study isolates brow focus.
- **Suits (hypothesis):** People who report strong attentional control or a
  meditation background in concentration practices.

### 4.3 Breath
- **Slow paced breathing (about 4.5–6.5 breaths per minute):** Zaccaro et al.
  (2018) systematically reviewed slow breathing (defined as under 10 breaths
  per minute) and found raised HRV and parasympathetic markers; the EEG
  evidence (increased alpha, decreased theta) rests on four small studies, two
  clearly supportive, one mixed and one null. Breathing at each person's **resonance frequency** (Lehrer and
  Gevirtz 2014) maximises heart-rate oscillation and is the clearest bridge to
  the Polar H10 phase. Grade C for the EEG effect, A for the autonomic effect.
- **Long exhale / cyclic sighing:** Balban et al. (2023) found five minutes of
  daily cyclic sighing improved mood and lowered respiratory rate more than
  mindfulness meditation in a single remote randomised trial. EEG not measured. Grade B–C (autonomic and mood), C (EEG).
- **Breath counting / breath attention:** A core concentration practice; raises
  alpha and in experienced meditators frontal theta, based on the general mindfulness EEG literature (Lomas et al. 2015 review; breath counting was not analysed separately). Grade B–C.
- **Humming / bhramari / "Om":** Small studies report increased theta or alpha
  and calm; humming also lengthens exhale. Grade C. Muse caveat: vocalising
  vibrates the skull and creates EMG, so score only in the silent phase after.
- **Breath holds and fast breathing (Wim Hof style, holotropic):** Strongly
  change EEG (hyperventilation slows the EEG through low CO2). **Not offered**:
  safety risk (fainting, seizure threshold in epilepsy) and the slowing is
  hypocapnia, not a trained state.
- **Suits (hypothesis):** People with high interoceptive awareness (MAIA-2) or
  who find visual imagery hard.
- **Brainwave–breath coupling:** Breathing phase modulates brain activity.
  Zelano et al. (2016) showed nasal breathing entrains limbic delta and theta
  in intracranial recordings; Heck et al. (2017) reviewed respiration-locked
  oscillations (mostly animal evidence); Kluger and Gross (2021) and Kluger et
  al. (2021) report breathing-phase modulation of scalp alpha in humans
  (details unverified). This is a natural future "coupling" metric once breath can be
  estimated (from H10 ECG-derived respiration or accelerometer).

### 4.4 Visualization and imagery
- **Mechanism:** Internally directed attention raises alpha (Cooper et al.
  2003; Benedek et al. 2014 found right-parietal alpha rises reflect focused
  internal attention, not creativity as such). But *vivid, effortful* visual imagery can engage visual
  cortex and reduce alpha in some people. Calm, slow, low-detail scenes
  (a lake, warm light, floating) tend to support alpha; dreamy drifting imagery
  supports theta as drowsiness rises.
- **Grade:** B for internal attention raising alpha; C for specific scripts.
- **Important individual difference:** Visual imagery vividness varies
  enormously (VVIQ, Marks 1973). About 4% of people have absent or very weak
  imagery and under 1% none at all (Dance et al. 2022: 3.9% and 0.8%, n = 1,004;
  Zeman et al. 2015). For them visualization is not a path, and the app should
  learn that quickly and move on, without making them feel broken.
- **Suits (hypothesis):** High VVIQ, high absorption (Tellegen Absorption Scale).

### 4.5 Body scan, progressive relaxation, warmth and heaviness (autogenic)
- **Mechanism:** Reducing muscle tone lowers EMG (which cleans the EEG) and
  shifts arousal down. Autogenic training ("my arms are heavy and warm") has a
  long clinical record for anxiety (Stetter and Kupper 2002 meta-analysis of studies from 1952–1999).
  Green and Green at the Menninger Clinic combined hand-warming biofeedback with
  alpha-theta work (*Beyond Biofeedback*, 1977).
- **EEG:** Alpha rises, and with continued relaxation theta rises.
- **Grade:** A–B for relaxation benefits (meta-analysis of older studies), B for EEG shift.
- **Muse bonus:** Forehead and jaw EMG are directly measurable, so we can give
  real feedback on "soften the jaw, soften the brow", which is often the
  fastest early win.
- **Suits (hypothesis):** Somatic learners, high muscle tension at baseline,
  people new to meditation.

### 4.6 Mantra and repeated phrases
- **Transcendental Meditation:** Travis and colleagues report increased frontal
  alpha1 power and coherence. Most studies come from TM-affiliated groups.
  Grade B–C.
- **Non-directive mantra meditation (Acem):** Lagopoulos et al. (2009) found more
  theta and alpha than during rest. Grade C (small sample, single group).
- **Mechanism:** A low-effort anchor that occupies verbal working memory and
  crowds out discursive thought.
- **Muse caveat:** Silent mantra only; spoken mantra creates EMG.
- **Suits (hypothesis):** Verbal thinkers, people whose minds chatter; those who
  find breath focus anxious.

### 4.7 Open monitoring, open awareness, "doing nothing"
- **Mechanism:** Releasing control and resting in awareness. Cahn and Polich
  (2006) and Lomas et al. (2015) reviewed meditation EEG: the most consistent
  findings across styles are increased alpha and theta, with effects stronger
  in experienced practitioners.
- **Grade:** B.
- **Note:** Given section 3, this "allow, don't try" style may be one of the
  best alpha strategies for many people. Test it explicitly.

### 4.8 Focused attention on a sound or sensation
- Concentrating on a continuous sound, the sensation at the nostrils, or a body
  point. Builds stability. EEG effect overlaps breath attention. Grade B.

### 4.9 Posture
- **Upright seated** keeps arousal up and suits alpha and eyes-open work.
- **Reclined or supine** lowers arousal, raises theta and makes sleep onset
  likely, which suits alpha-theta and sleep programs and hurts focus programs.
- **Muse caveat:** Lying on the back presses the TP9/TP10 sensors against a
  pillow; contact noise and pressure artifacts go up. Muse S fabric band
  handles this better than Muse 2. Recommend a neck pillow or seated recline.
- Grade A for arousal effects of posture, C for specific EEG prescriptions.

### 4.10 Sound and entrainment
- **Binaural beats:** A meta-analysis (Garcia-Argibay et al. 2019) found a medium overall behavioural effect (g ≈ 0.45) on anxiety, memory and attention, but
  systematic reviews of EEG data (for example Ingendoh et al. 2023) find
  **inconsistent evidence of actual brainwave entrainment** at alpha or theta
  rates. Grade B for subjective calm, C for entrainment.
- **Isochronic tones and rhythmic drumming:** Auditory steady-state responses
  are robust around 40 Hz but weak at theta and alpha rates. Shamanic drumming
  near 4–4.5 Hz is reported to induce trance. Hove et al. (2016) scanned
  shamanic practitioners with fMRI (no EEG) and found brain-network
  reconfiguration and reduced auditory-pathway connectivity during drumming
  trance; theta entrainment was not tested. Grade C.
- **Audio-visual entrainment (flicker):** Photic driving does entrain occipital
  rhythms (Grade A for entrainment), but flicker carries a **photosensitive
  seizure risk** and is excluded from this product.
- **Music and nature sounds:** Calm, slow, low-surprise music and natural
  soundscapes lower arousal (Grade B). Startling or high-pitched sounds trigger
  orienting responses that block alpha (Grade A). This supports Jesus's
  requirement that all feedback audio be warm, continuous and never startling.
- **Silence:** Some people do best with no sound beyond the feedback.
- **Design consequence:** Entrainment audio is offered as a **variable to test
  per user**, never as a claim. The profiling engine can tell a user honestly
  "binaural beats did / did not change your brain".
- **Crucial confound:** If a program plays a stimulus at a frequency, the EEG
  may show power at that frequency through electrical pickup or an evoked
  response, not a trained state. Entrainment blocks must be scored with that
  frequency notched out, or scored on a no-stimulus period afterwards.

### 4.11 Hypnosis and guided induction
- Hypnotic induction (relaxation, descent imagery, counting down) raises theta
  in highly hypnotisable people, though the review evidence shows a tendency
  rather than a firm finding (Jensen et al. 2015). Hypnotisability is a stable
  trait, with roughly 10–15% of people highly hypnotisable on standard scales.
  Grade B–C.
- **Suits (hypothesis):** High absorption, high hypnotisability.

### 4.12 Sleep-onset and hypnagogic work
- Hori et al. (1994; chapter in Ogilvie and Harsh, eds., *Sleep Onset*) described nine EEG stages of sleep onset, from alpha
  dropout through theta ripples to spindles. Hypnagogic imagery appears in the
  theta-dominant stages.
- Peniston-style alpha-theta training deliberately holds people near this
  edge. The MIT "Dormio" work (Haar Horowitz et al. 2020) works with the same
  stage differently: it detects sleep onset from heart rate, skin conductance
  and finger flexion (no EEG) and repeatedly wakes the person with a prompt
  to capture hypnagogic imagery.
- The challenge is staying on the edge without falling asleep, which needs a
  gentle "tether" (see the design doc).
- Grade A that these stages exist; B–C for training at the edge.

### 4.13 Lifestyle and session variables
These are not techniques but they move the EEG and must be logged so the
profile is not confounded:

| Variable | Typical effect | Grade |
|---|---|---|
| Sleep deprivation | Raises theta, makes alpha-theta sessions slip into sleep | A |
| Caffeine | Lowers alpha and theta power | A |
| Alcohol | Raises alpha/theta acutely | A |
| Nicotine | Raises alpha frequency, lowers slow power | B |
| Benzodiazepines | Raise beta strongly | A |
| Large meal | Post-meal drowsiness, theta up | B |
| Time of day / circadian dip | Early afternoon dip raises theta | B |
| Recent exercise | Alpha up after moderate exercise | B |
| Age | IAF falls, alpha amplitude falls | A |
| Menstrual cycle phase | Small alpha changes | C |
| Room noise, light, temperature | Orienting and arousal effects | B |
| Headset fit and sweat | Artifact; slow drifts look like delta | A |

---

## 5. Neurofeedback protocol literature

### 5.1 Alpha upregulation
- Classic eyes-closed alpha enhancement improves self-reported calm. Hardt and
  Kamiya (1978) found anxiety fell with alpha gains only in high-anxiety
  people, independent of muscle tension and breathing; later reviews argue much
  of the clinical effect overlaps with relaxation and expectation (Thibault and
  Raz 2017). Grade B.
- **Individual upper-alpha training** improved short-term memory (Nan et al.
  2012) and mental rotation (Zoefel et al. 2011, Hanslmayr et al. 2005 for
  cognitive performance). Grade B.
- Gruzelier (2014) reviewed healthy-performance neurofeedback in three papers and
  concluded alpha and alpha-theta show promise but with many small samples.

### 5.2 Alpha-theta (the "deep states" protocol)
- **Classic setup:** eyes closed, reclined, Pz or O1 electrode, two tones: one
  rewards alpha, one rewards theta, often a third sound for rising beta.
  The aim is a **theta/alpha crossover**, where theta power exceeds alpha as the
  person drifts toward hypnagogia while staying awake.
- **Clinical history:** Peniston and Kulkosky (1989, 1991) reported large
  effects in alcoholism and combat PTSD in small, unblinded single-lab
  studies; Scott et al. (2005) was positive in an addiction program but used a
  combined protocol. Grade C.
- **Performance:** Egner and Gruzelier (2003) found alpha-theta improved music
  performance in conservatoire students. Gruzelier's group reported similar
  results in dance and singing in separate papers (see Gruzelier 2014 part II).
  Grade B–C.
- **Safety:** This protocol can surface strong memories and emotions. Clinical
  use was supervised. The consumer app must include an "I need to stop" path,
  gentle grounding, and avoid marketing it as therapy.

### 5.3 Frontal alpha asymmetry
- Relative left-frontal activity (more right alpha) links to approach and
  positive mood (Davidson 1992). Allen et al. (2001, n = 18) trained asymmetry
  and changed emotional responses to film clips and facial EMG. Muse AF7/AF8 approximate it. Results are mixed and the measure is
  noisy. Grade C on Muse. Offer as an experimental program only.

### 5.4 Theta upregulation for focus or memory
- Frontal-midline theta training has some positive studies (for example
  Enriquez-Geppert et al. 2014), but it needs Fz. **Not offered on Muse.**

### 5.5 Sleep-related neurofeedback
- SMR training for insomnia gave mixed results, and a sham-controlled trial
  (Schabus et al. 2017) found no specific effect beyond placebo. Our sleep
  program should therefore be framed as a guided wind-down with measured
  descent, not as a sleep treatment.

### 5.6 How much of neurofeedback is specific?
Thibault and Raz (2017) argued much of neurofeedback's clinical benefit is
psychosocial (expectation, attention, relaxation, practice). Sham-controlled
trials in ADHD and insomnia often show similar gains in both arms. For a
consumer product this cuts two ways:
- We should not make clinical or therapeutic claims.
- The relaxation, attention training and self-knowledge are real benefits in
  themselves, and our profiling can **show a user objectively** whether their
  brain changed, which almost no consumer product does.

### 5.7 Responders and non-responders
- Alkoby et al. (2018) reviewed the "inefficacy problem": a substantial
  minority of participants fail to learn to modulate the trained rhythm; the
  commonly quoted range is roughly **16% to 57%** across studies (figure taken
  from the full text, not the abstract; recheck before any public use).
- Predictors with some support (Grade B–C):
  - **Baseline power of the trained band** (people with more resting alpha learn
    alpha training better; Wan et al. 2014). Nan et al. (2012) also found the
    mental strategies that worked differed between people, with "positive
    thinking" the most common successful one, which supports profiling.
  - **Early learning**: performance in the first few sessions predicts later
    success.
  - **Psychological factors**: motivation, mood and attention (Cohen Kadosh
    and Staunton 2019 review). Locus of control in dealing with technology
    mattered in a small study, but in the *opposite* direction to intuition:
    higher tech control beliefs went with poorer SMR learning (Witte et al.
    2013, r ≈ −0.7, n = 10, preliminary; Grade C).
  - **Strategy style**: relaxed, non-effortful approaches beat effortful ones
    (Kober et al. 2013).
- **Design consequences:** detect likely non-responders early, switch them to
  a different strategy or a different target band, use shaping so everyone
  experiences success early, and always offer the parts that work for nearly
  everyone (EMG relaxation, breath pacing).

### 5.8 Feedback design parameters from the literature
| Parameter | What the literature suggests | Grade |
|---|---|---|
| Reward rate | Keep success around 60–80% of the time early (shaping); too-easy loses learning signal, too-hard frustrates. | B (learning theory, practitioner consensus) |
| Threshold | Adaptive, updated from recent performance. | B |
| Latency | Feedback within about 250–500 ms of the EEG change helps operant learning. | B |
| Modality | Auditory for eyes closed; visual adds load but helps eyes-open training. | B |
| Continuous vs discrete | Continuous proportional feedback is more informative; discrete rewards are more salient. We use continuous, per the audio requirement. | C |
| Session length | 20–40 minutes, split into 2–5 minute blocks with short rests. | B |
| Number of sessions | Learning curves usually emerge over 5–20 sessions. | B |
| Transfer trials | Blocks without feedback test whether the skill is internal. Essential. | A (NF methodology) |
| Explicit strategy instructions | Mixed. Giving a strategy helps beginners; over-specifying can add effort. | C |

---

## 6. Golden ratio rhythms, cross-frequency structure, nonlinear dynamics and altered states

Jesus asked that the team be well informed on the mainstream science here, not
only the Dan Winter and FlameInMind material. This section covers it. The
"golden ratio alignment" detector itself is owned by the signal-engine spec;
this section supplies the scientific grounding and the training implications.

### 6.1 The golden mean in the frequency architecture of the brain
- **Roopun et al. (2008)**, a review of the Whittington and Kopell group's
  rat neocortex slice work, noted that the centre frequencies of distinct
  cortical rhythms are spaced approximately by the golden ratio (about 1.618),
  and proposed this lets rhythms coexist with minimal interference. Grade B–C
  (strong underlying lab work, animal model, review paper).
- **Pletzer, Kerschbaum and Klimesch (2010)**, "When frequencies never
  synchronize: the golden mean and the resting EEG" (*Brain Research*), argued
  that classical human EEG bands (delta, theta, alpha, beta, gamma) have centre
  frequencies in a geometric series with ratio near phi. Because phi is the
  "most irrational" number, two rhythms at a phi ratio never fall into stable
  phase alignment, so a phi ratio marks a maximally **uncoupled "resting"**
  state with only occasional irregular coupling. Rhythms at integer ratios
  (2:1, 3:1) can phase-lock, which **couples** them for communication. (Calling
  this "multiplexing" is our gloss.) The paper is a mathematical, theoretical
  argument with no new EEG data analysis. Grade C.
- **Klimesch (2013)**, a speculative opinion paper, proposed a "binary
  hierarchy": band centre frequencies double from band to band (2.5, 5, 10,
  20, 40 Hz), with golden-mean values marking band boundaries, extending to
  brain-body rhythms such as heart and breath. **Klimesch (2018)** developed
  the idea that switching between harmonic (coupled) and golden-mean
  (decoupled) relations lets the brain flexibly connect or separate
  processes. Grade C.
- **Rodriguez-Larios and Alaerts (2019, *Journal of Neuroscience*)** tracked
  the instantaneous ratio between individual alpha and theta peak frequencies.
  Transient **2:1 harmonic** alpha:theta ratios became more frequent during
  cognitive tasks and predicted better performance. Their "non-harmonic"
  comparison category was ratios of 1.1–1.6, so phi itself was not tested.
- **Rodriguez-Larios et al. (2020, *Scientific Reports*)**: in 43 experienced
  meditators, 2:1 harmonic relations rose from meditation to rest to mental
  arithmetic. **Rodriguez-Larios et al. (2020, *Mindfulness*)**: in 36 novices
  on an 8-week course (no control group), better course compliance correlated
  with less 3:1 harmonicity during meditation. **Rodriguez-Larios and Alaerts
  (2021, *European Journal of Neuroscience*)**: mind-wandering episodes showed
  more harmonic alpha:theta relations. Grade B–C (consistent direction, one
  research group).
- **Penttonen and Buzsáki (2003)** and **Buzsáki and Draguhn (2004)**
  described cortical bands as a linear progression on a natural-log scale
  (commonly read as a ratio near e, about 2.72), which is a
  related but distinct proposal. The exact constant is debated; the robust
  finding is that **bands are spaced by non-integer ratios that discourage
  locking**.

**What this means for Hurricane Brain:**
1. The measurable quantity is the **ratio of individual peak frequencies**
   (for example alpha peak ÷ theta peak), tracked over time, plus whether that
   ratio is near phi (decoupled, multiplexing) or near 2:1 (coupled).
2. On Muse this is feasible for **alpha:theta**, since both peaks can be found
   at TP9/TP10 with eyes closed. Beta:alpha is possible but weaker. Anything
   involving gamma is not reliable on Muse because of muscle contamination.
3. The early evidence suggests **non-harmonic alpha:theta relations (away from
   2:1) go with meditation, and harmonic 2:1 with active cognition and mind
   wandering**. That a ratio near phi specifically marks the meditative end is
   **our hypothesis** (supported by Pletzer and Klimesch's theory, not yet
   tested directly). A "golden ratio alignment" practice is therefore
   scientifically coherent and testable with our own data across users, and it
   should be described to users as emerging research, not established fact.
4. Peak-frequency estimation needs care: theta often has no clear peak in
   waking EEG, and the 1/f background (6.3) biases naive peak picking.
   Use a periodic/aperiodic decomposition before computing ratios.

### 6.2 Cross-frequency coupling and frequency cascades
- **Phase-amplitude coupling (PAC):** the phase of a slow rhythm modulates the
  amplitude of a faster one. Canolty et al. (2006, *Science*) showed high
  gamma (80–150 Hz) locked to theta phase in human neocortex; Lisman and Jensen
  (2013) proposed theta-gamma coupling as a code for memory sequences. Alpha imposes "pulsed inhibition" on gamma (Jensen and Mazaheri 2010).
  Grade A in invasive recordings, B in scalp EEG.
- **Nested cascades:** delta phase modulates theta amplitude, which modulates
  gamma (Lakatos et al. 2005), giving a hierarchy of nested rhythms. Sleep
  shows a clear cascade: slow oscillations nest spindles, which nest ripples
  (Staresina et al. 2015). Grade A.
- **Phase-phase (n:m) coupling:** rhythms at integer ratios can phase-lock;
  this is the mechanism the golden-mean argument says is avoided at phi ratios.
- **Muse feasibility:** theta-gamma PAC on Muse is **not trustworthy** (gamma is
  muscle). Delta/theta phase to alpha amplitude is possible but vulnerable to
  eye artifacts at AF7/AF8; use TP9/TP10 only. Slow-oscillation and spindle
  cascades are feasible in overnight Muse S recordings. Treat all CFC metrics
  as research features, behind a flag, with surrogate-data statistics to
  reject spurious coupling (PAC is notoriously prone to false positives from
  non-sinusoidal waveforms; Aru et al. 2015).

### 6.3 Nonlinear and scale-free dynamics
- **Aperiodic (1/f) component:** EEG power falls with frequency as 1/f^χ.
  The exponent χ steepens with sleep and anaesthesia (Lendner et al. 2020) and
  has been proposed as an index of excitation/inhibition balance (Gao et al.
  2017). Tools like FOOOF/specparam (Donoghue et al. 2020) separate it from
  true oscillatory peaks. **This matters for every protocol:** a change in
  "theta power" may be a tilt in the 1/f background, not more theta rhythm.
  Grade A that the component exists and confounds band power; B for its
  interpretation. Recommendation: the engine computes both, and rewards
  periodic power above the aperiodic fit.
- **Long-range temporal correlations (LRTC):** the alpha amplitude envelope
  shows scale-free fluctuations measurable with detrended fluctuation analysis
  (Linkenkaer-Hansen et al. 2001), consistent with the brain operating near
  criticality. Meditation has been reported to change LRTC (Irrmischer et al.
  2018). Grade B. Feasible on Muse for alpha at TP9/TP10, needs several
  minutes of clean data.
- **Complexity and entropy:** Lempel-Ziv complexity, multiscale entropy and
  fractal dimension fall in sleep and anaesthesia (Schartner et al. 2015, 2017
  *Neuroscience of Consciousness*) and rise with psychedelics (Schartner et al.
  2017 *Scientific Reports*). They are candidate global "state" measures that do
  not depend on band definitions. Grade B. Feasible on Muse with careful
  artifact rejection.
- **Metastability:** the brain moves between transient states rather than
  holding one. Training goals should reward **dwelling and returning**, not a
  fixed number, which also fits the continuous-audio design.

### 6.4 Altered states: what the EEG literature shows
| State | Typical EEG signature | Muse-visible? | Grade |
|---|---|---|---|
| Relaxed wakefulness | Posterior alpha up | Yes | A |
| Hypnagogia / sleep onset | Alpha dropout, theta ripples, vertex waves | Mostly | A |
| Deep meditation (various) | Alpha and theta up; frontal-midline theta in concentration | Partly (no Fz) | B |
| Long-term meditators | High-amplitude gamma (Lutz 2004, 25–42 Hz; Braboszcz et al. 2017, 60–110 Hz) | No (EMG) | B |
| Jhana / absorption states | Single-meditator case study: frontal gamma up, 6–8 Hz up relative to faster bands, reward-area activation on fMRI (Hagerty et al. 2013) | Unknown | C |
| Hypnosis (high hypnotisables) | Theta up, connectivity changes | Partly | B |
| Flow | Mixed; frontal theta and alpha changes, transient hypofrontality hypothesis | Partly | C |
| Psychedelic states | Broadband power drop, mostly alpha (Carhart-Harris et al. 2016, MEG); complexity up (Schartner et al. 2017) | Yes, partly | B (not a product target) |
| Lucid dreaming | Raised frontal ~40 Hz during REM (Voss et al. 2009, 3 lucid episodes; disputed since) | Overnight, uncertain | C |
| Deep NREM sleep | Delta slow waves, spindles | Yes (Muse S overnight) | A |

### 6.5 Frontier observations: octave and golden ratio cascades, trance states

Some of what this app is built around sits ahead of the published literature.
We keep it, label it Grade F, and design the app so it can gather good data on
it.

**Octave cascade and golden ratio cascade (Grade F for the cascade
phenomenon; the underlying ratios have Grade B grounding).**
- Jesus has recorded EEG in which a person's band peaks line up across several
  bands at once, either in **octaves** (each peak about 2× the one below:
  for example ~2.5, 5, 10, 20, 40 Hz) or in a **golden ratio series** (each
  peak about 1.618× the one below). FlameInMind (Dan Winter and Patrick Botte)
  shows marker lines for both and alerts when they occur.
- Mainstream anchors for both: Klimesch's binary-hierarchy model has band
  centres doubling from band to band (octaves), with harmonic 2:1 relations
  proposed to **couple** rhythms and golden-mean relations to **decouple**
  them (6.1). Rodriguez-Larios and colleagues measured transient 2:1 and 3:1
  alpha:theta relations directly. So each pairwise ratio is a published idea; what has not
  been published, to our knowledge, is a **multi-band cascade** (three or more
  bands locked in one series at the same moment) as a trainable state.
- **On Muse:** a cascade across delta–theta–alpha–beta is measurable at
  TP9/TP10 when the signal is clean; the gamma rung is not trustworthy because
  of muscle, so a Muse cascade should be defined on up to four bands and say so.
- **Design:** the engine detects both cascade types side by side, with a gentle
  sound marker (never a beep) for each, and logs every event so we build the
  first good dataset on them.

**Children's trance states and blindfold sight (Grade F, extraordinary
claim).**
- Jesus has observed his niece and nephews entering trance states and
  reports seeing cascades in their EEG during them. Practitioner programmes
  teach children "mind sight" or blindfolded reading.
- The trance and EEG part is plausible and recordable: absorption and
  hypnotic-like states are well documented in children, who are on average
  more hypnotisable than adults.
- The blindfold-sight part has, to our knowledge, no controlled
  peer-reviewed support; informal tests usually cannot rule out seeing past
  the blindfold. That does not prove it false; it means it has not been
  tested well.
- **How the app can help:** record EEG during these sessions with event
  markers so the cascades can be analysed properly. If Jesus wants to test
  the perception claim, a simple rigorous protocol is possible later
  (opaque goggles that block downward gaze, targets chosen at random by
  software, the tester not knowing the target).
- **Product rule:** do not make blindfold-sight claims in marketing; do offer
  the recording and analysis tools. Any work with children needs parental
  consent and child-appropriate session lengths.

### 6.6 Where entrainment fits later (EarthSync merge)
Jesus has a separate entrainment app, EarthSync, that may later merge into one
app with HRV, breath training and visual entrainment. Not in scope now, but the
brain side should leave room for it:
- **Closed-loop entrainment:** time audio pulses to the user's own measured
  alpha or theta phase or peak frequency, rather than a fixed rate. This is
  more principled than open-loop beats and is an active research area
  (for example closed-loop auditory stimulation of sleep slow waves, Ngo et al.
  2013; Grade A–B for boosting slow waves, B for the memory benefit, which
  has replicated less consistently).
- **Entrainment as a tested variable:** the profiling engine (design doc)
  already treats entrainment audio as one strategy among many, so EarthSync
  stimuli can plug in as additional strategy arms.
- **Confound handling:** any stimulus at frequency f must have f notched from
  scoring, or be scored in post-stimulus windows, so we never reward the
  stimulus itself showing up in the EEG.
- **Safety:** visual entrainment means flicker. When it is merged it needs a
  photosensitivity screen and conservative limits (avoid 15–25 Hz flicker,
  which is the highest-risk range).

---

## 7. Emotional states and how they show in EEG and HRV

Jesus wants training to include emotional states (calm, gratitude, joy,
compassion, confidence and so on), and later to let each user anchor a state
to their own signature sound. This section covers the evidence; the anchoring
design is in the design doc.

### 7.1 Can people reliably produce an emotion on purpose?
- **Yes, moderately.** A meta-analysis of emotion-induction methods (Lench,
  Flores and Bench 2011) found most methods work, including recall, imagery,
  music and film, with pictures strongest. Recall and imagery are the
  self-generated methods, which is what an app needs. Grade A that induction
  works; B for self-generated methods specifically.
- In physiology, **arousal** (how activated) is easier to detect than
  **valence** (pleasant vs unpleasant) or specific emotions (see 7.2).
- Practised methods:
  - **Loving-kindness and compassion meditation** increase positive emotion
    over weeks (Fredrickson et al. 2008). Grade B. A reported link to rising
    vagal tone (Kok et al. 2013) was challenged by reanalyses of its own data
    (Heathers et al. 2015; Nickerson 2018), and no direct replication has been
    published, so treat the HRV claim as Grade C.
  - **Gratitude and appreciation** recall: reliable short-term mood lift.
    Grade B.
  - **Awe** imagery and recall: reliable self-report change. Grade B.
  - **Heart-focused appreciation with slow breathing** (the HeartMath
    "coherence" technique) produces a strong 0.1 Hz heart-rhythm pattern.
    Most of that is the slow breathing itself, i.e. resonance breathing
    (Lehrer and Gevirtz 2014, Grade A). Claims that the emotion adds a
    distinct heart-brain effect come mainly from HeartMath-affiliated work
    (McCraty et al. 2009). Grade C for the emotion-specific part.
  - **Affect labelling:** putting a feeling into words reduces amygdala
    reactivity to emotional images (Lieberman et al. 2007). Grade B.
    (Emotional granularity, the habit of making fine distinctions between
    feelings, is a related but separate idea.)

### 7.2 What the EEG can and cannot show about emotion
- **Arousal:** visible. Low arousal goes with more alpha, less muscle and
  less beta; high arousal the reverse. Grade A–B. Muse sees this.
- **Valence and approach/withdrawal:** frontal alpha asymmetry (more left
  frontal activity with approach and positive affect, Davidson 1992; Coan and
  Allen 2004). Real but small and noisy at the individual level. Grade B in
  labs, C on Muse (AF7/AF8).
- **Specific emotions from EEG:** public-dataset classifiers (for example
  DEAP) reach modest accuracy, mainly for arousal, and generalise poorly
  across people. Grade C. **Personal models** trained on one person's own
  labelled sessions do better than population models, which fits our
  individual-profile approach.
- **Honest position:** on Muse alone we can track arousal and a rough
  approach/withdrawal index, not "joy vs gratitude". With the Polar H10 we gain
  a much clearer autonomic picture. The combination plus the user's own
  rating is the right definition of a state.

### 7.3 What HRV adds
- **High-frequency HRV / RSA and RMSSD** index vagal (parasympathetic) heart
  control; they rise with calm, safety and slow breathing (Task Force 1996;
  Shaffer and Ginsberg 2017). Grade A.
- **Resonance / coherence state:** at about 6 breaths per minute heart rate
  oscillates in a smooth high-amplitude 0.1 Hz wave. Easily measured with the
  H10. Grade A for the physiology. This is the "high HRV state" Jesus
  mentioned and is the most reliable measurable target in this whole area.
- **Emotion-specific HRV:** positive calm states raise HRV; anger and anxiety
  lower it; excitement and joy raise heart rate and may lower HRV even though
  pleasant. So "high HRV" means calm-pleasant, not every positive emotion.
  Grade B.
- **Polyvagal theory**, which inspired the Safe and Sound Protocol, is
  popular but its specific anatomical claims are disputed (Grossman and Taylor
  2007; Grossman 2023). The practical guidance that warm, prosodic,
  mid-frequency sound feels safe is reasonable and is what we follow; we
  should avoid making polyvagal claims in copy.

### 7.4 Conditioning a state to a sound: the evidence
- **Cue-controlled relaxation:** pairing a cue word or sound with deep
  relaxation over repeated sessions lets the cue alone later produce partial
  relaxation (Russell and Sipich 1973, a brief report; later anxiety-treatment
  work). Grade B–C. Effects are real but usually **smaller than the original
  state** and fade without practice.
- **Classical conditioning of physiological responses** (heart rate, skin
  conductance, salivation) is well established (Grade A). Conditioning of
  **EEG rhythms** has older evidence of conditioned alpha blocking (Jasper and
  Shagass 1941). Conditioning of a complex positive brain state is plausible
  but not well studied. Grade C.
- **Music and memory:** music evokes emotion partly through evaluative
  conditioning and episodic memory (Juslin and Västfjäll 2008). A personal
  sound that has been present during many good sessions becomes emotionally
  meaningful. Grade B–C (a theory paper, well grounded in conditioning work).
- **Targeted memory reactivation:** cues paired with learning can reactivate
  that memory when replayed in NREM sleep: an odour in Rasch et al. (2007),
  sounds in Rudoy et al. (2009); review in Oudiette and Paller (2013).
  Grade A–B. A later option: replay a user's anchor in NREM sleep.
- **Rules from learning theory that the design must respect (Grade A):**
  - **Contingency matters**: the cue must predict the state. Playing it at
    random times, or as a notification, weakens it (extinction, latent
    inhibition).
  - **Extinction**: repeated cue-without-state weakens the link; occasional
    re-pairing maintains it.
  - **Partial reinforcement** makes a learned response more resistant to
    extinction.
  - **Context effects**: responses learned in one setting transfer partly to
    others; practising in several settings helps generalisation.
  - **Novelty**: a new, distinctive sound conditions faster than a familiar
    one (latent inhibition), so the anchor should not be the everyday
    feedback soundscape.
  - **Controls**: to know the anchor works, compare it with an equally
    familiar sound that was never paired (a "control sound"). Otherwise
    familiarity and expectation look like conditioning.
- **NLP "anchoring"** is a folk version of this idea without good evidence of
  its own (Grade D); we build on the conditioning literature instead.

---

## 8. Learning styles: what holds up and what does not

Jesus's instinct that different people reach states in different ways is
supported by the neurofeedback data above: strategy success varies widely
between individuals. But one popular framing does **not** hold up: fixed
"learning styles" (visual, auditory, kinesthetic) that predict the best way to
teach someone. Pashler et al. (2008) reviewed the evidence and found no support
for matching instruction to self-reported style.

So the app should not sort people into styles from a questionnaire and stop.
It should:
1. Use a short questionnaire only as a **prior** (a starting guess).
2. **Measure** each strategy's effect on the person's own EEG.
3. Keep updating as they practise, since what works changes with skill.

Traits that plausibly predict which strategies work, and are cheap to measure:

| Trait | Instrument | Predicts (hypothesis) |
|---|---|---|
| Imagery vividness | VVIQ (16 items, or a 4-item short form) | Visualization strategies |
| Absorption | Tellegen Absorption Scale (or a short version) | Imagery, hypnotic induction, alpha-theta |
| Interoceptive awareness | MAIA-2 subscales | Breath and body strategies |
| Meditation experience | Simple history items | Open monitoring, mantra, brow-point focus |
| Trait anxiety | GAD-2 or STAI short form | Whether breath focus calms or agitates |
| Chronotype and sleep | Short MEQ, sleep hours | Best time of day; alpha-theta sleep risk |
| Tech locus of control | Short scale (Witte et al. 2013) | Responder likelihood; note the small study found *higher* tech control beliefs predicted *poorer* learning (Grade C) |

---

## 9. HRV and brain coupling (future hooks)

Not in scope for the first build, but the brain side should be designed so
these can be added without rework:

- **Resonance breathing at about 0.1 Hz** produces large heart-rate oscillations;
  a coupling metric can ask whether alpha power or alpha envelope oscillates at
  the same 0.1 Hz.
- **Respiration phase and EEG:** oscillatory power is modulated by breathing
  phase (Zelano 2016 for limbic delta/theta; Kluger and Gross 2021 for scalp
  alpha; Heck 2017 review). ECG-derived respiration from the Polar H10
  lets us compute breath-locked alpha.
- **Heartbeat-evoked potential (HEP):** EEG response time-locked to the R-peak;
  linked to interoceptive attention. Feasible with H10 R-peaks (1 ms
  resolution) and Muse timestamps if clocks are aligned. Grade B in labs, C on
  consumer gear.
- **Cardiac cycle and alpha:** alpha and perception vary across the cardiac
  cycle. Research-grade only.
- **Engine requirements now:** a shared monotonic clock and timestamps on every
  EEG sample, per-epoch storage of band powers, and event markers for breath
  pacer phase. These are cheap to add now and expensive to retrofit.

---

## 10. Safety and responsible use

- **Epilepsy:** no flicker or photic stimulation; no hyperventilation or breath
  holding programs. Screen with one onboarding question and adjust.
- **Trauma and dissociation:** alpha-theta and deep imagery can bring up strong
  material. Provide a grounding exit (eyes open, feet on floor, slow exhale,
  feedback fades out), and suggest professional support where appropriate.
- **Psychosis or bipolar history:** recommend not using deep-state programs
  without clinician input.
- **Driving and machinery:** never use while driving. (Jesus often uses voice
  while driving; the app should refuse to start a session when the phone
  reports motion consistent with driving, as a nice-to-have.)
- **Regulatory:** to stay a general-wellness product (US FDA guidance), avoid
  claims to treat or diagnose any condition. Use "relaxation", "focus",
  "self-awareness", "sleep wind-down".

---

## 11. Key references (to verify before external use)

- Alkoby O, Abu-Rmileh A, Shriki O, Todder D (2018). Can we predict who will respond to neurofeedback? A review of the inefficacy problem and existing predictors for successful EEG neurofeedback learning. *Neuroscience*.
- Allen JJB, Harmon-Jones E, Cavender JH (2001). Manipulation of frontal EEG asymmetry through biofeedback alters self-reported emotional responses and facial EMG. *Psychophysiology* 38(4):685–693.
- Balban MY et al. (2023). Brief structured respiration practices enhance mood and reduce physiological arousal. *Cell Reports Medicine*.
- Barry RJ et al. (2007). EEG differences between eyes-closed and eyes-open resting conditions. *Clinical Neurophysiology*.
- Benedek M et al. (2014). Alpha power increases in right parietal cortex reflects focused internal attention. *Neuropsychologia*.
- Cahn BR, Polich J (2006). Meditation states and traits: EEG, ERP, and neuroimaging studies. *Psychological Bulletin*.
- Corcoran AW et al. (2018). Toward a reliable, automated method of individual alpha frequency (IAF) quantification. *Psychophysiology*.
- Egner T, Gruzelier JH (2003). Ecological validity of neurofeedback: modulation of slow wave EEG enhances musical performance. *NeuroReport*.
- Garcia-Argibay M, Santed MA, Reales JM (2019). Efficacy of binaural auditory beats in cognition, anxiety, and pain perception: a meta-analysis. *Psychological Research*.
- Green E, Green A (1977). *Beyond Biofeedback*.
- Gruzelier JH (2014). EEG-neurofeedback for optimising performance. I: A review of cognitive and affective outcome in healthy participants. II: Creativity, the performing arts and ecological validity. III: A review of methodological and theoretical considerations. *Neuroscience and Biobehavioral Reviews* 44 (three separate papers).
- Haar Horowitz A et al. (2020). Dormio: a targeted dream incubation device. *Consciousness and Cognition*.
- Hardt JV, Kamiya J (1978). Anxiety change through electroencephalographic alpha feedback seen only in high anxiety subjects. *Science* 201:79–81. doi:10.1126/science.663641
- Heck DH et al. (2017). Breathing as a fundamental rhythm of brain function. *Frontiers in Neural Circuits*.
- Hori T, Hayashi M, Morikawa T (1994). Topographical EEG changes and the hypnagogic experience. In Ogilvie RD, Harsh JR (eds.), *Sleep Onset: Normal and Abnormal Processes*, pp. 237–253. APA.
- Hove MJ et al. (2016). Brain network reconfiguration and perceptual decoupling during an absorptive state of consciousness. *Cerebral Cortex* 26(7):3116–3124. doi:10.1093/cercor/bhv137
- Ingendoh RM, Posny ES, Heine A (2023). Binaural beats to entrain the brain? A systematic review of the effects of binaural beat stimulation on brain oscillatory activity, and the implications for psychological research and intervention. *PLOS ONE* 18(5):e0286023.
- Jensen MP, Adachi T, Hakimian S (2015). Brain oscillations, hypnosis, and hypnotizability. *American Journal of Clinical Hypnosis*.
- Cohen Kadosh K, Staunton G (2019). A systematic review of the psychological factors that influence neurofeedback learning outcomes. *NeuroImage*.
- Klimesch W (1999). EEG alpha and theta oscillations reflect cognitive and memory performance. *Brain Research Reviews*.
- Kober SE et al. (2013). Learning to modulate one's own brain activity: the effect of spontaneous mental strategies. *Frontiers in Human Neuroscience*.
- Krigolson OE et al. (2017). Choosing MUSE: validation of a low-cost, portable EEG system for ERP research. *Frontiers in Neuroscience*.
- Lagopoulos J et al. (2009). Increased theta and alpha EEG activity during nondirective meditation. *Journal of Alternative and Complementary Medicine*.
- Lehrer PM, Gevirtz R (2014). Heart rate variability biofeedback: how and why does it work? *Frontiers in Psychology*.
- Lomas T, Ivtzan I, Fu CHY (2015). A systematic review of the neurophysiology of mindfulness on EEG oscillations. *Neuroscience and Biobehavioral Reviews*.
- Lutz A et al. (2004). Long-term meditators self-induce high-amplitude gamma synchrony during mental practice. *PNAS*.
- Lynch JJ, Paskewitz DA (1971). On the mechanisms of the feedback control of human brain wave activity. *Journal of Nervous and Mental Disease*.
- Marks DF (1973). Visual imagery differences in the recall of pictures. *British Journal of Psychology* (VVIQ).
- Mulholland T, Peper E (1971). Occipital alpha and accommodative vergence, pursuit tracking, and fast eye movements. *Psychophysiology*.
- Nan W et al. (2012). Individual alpha neurofeedback training effect on short term memory. *International Journal of Psychophysiology*.
- Pashler H, McDaniel M, Rohrer D, Bjork R (2008). Learning styles: concepts and evidence. *Psychological Science in the Public Interest*.
- Peniston EG, Kulkosky PJ (1989). Alpha-theta brainwave training and beta-endorphin levels in alcoholics. *Alcoholism: Clinical and Experimental Research* 13(2):271–279.
- Peniston EG, Kulkosky PJ (1991). Alpha-theta brainwave neurofeedback therapy for Vietnam veterans with combat-related post-traumatic stress disorder. *Medical Psychotherapy* 4:47–60.
- Schabus M et al. (2017). Better than sham? A double-blind placebo-controlled neurofeedback study in primary insomnia. *Brain*.
- Stetter F, Kupper S (2002). Autogenic training: a meta-analysis of clinical outcome studies. *Applied Psychophysiology and Biofeedback*.
- Thibault RT, Raz A (2017). The psychology of neurofeedback: clinical intervention even if applied placebo. *American Psychologist*.
- Zaccaro A et al. (2018). How breath-control can change your life: a systematic review on psycho-physiological correlates of slow breathing. *Frontiers in Human Neuroscience*.
- Zelano C et al. (2016). Nasal respiration entrains human limbic oscillations and modulates cognitive function. *Journal of Neuroscience*.
- Zoefel B, Huster RJ, Herrmann CS (2011). Neurofeedback training of the upper alpha frequency band in EEG improves cognitive performance. *NeuroImage*.
- Aru J et al. (2015). Untangling cross-frequency coupling in neuroscience. *Current Opinion in Neurobiology*.
- Braboszcz C et al. (2017). Increased gamma brainwave amplitude compared to control in three different meditation traditions. *PLOS ONE*.
- Buzsáki G, Draguhn A (2004). Neuronal oscillations in cortical networks. *Science*.
- Canolty RT et al. (2006). High gamma power is phase-locked to theta oscillations in human neocortex. *Science*.
- Carhart-Harris RL et al. (2016). Neural correlates of the LSD experience revealed by multimodal neuroimaging. *PNAS*.
- Donoghue T et al. (2020). Parameterizing neural power spectra into periodic and aperiodic components. *Nature Neuroscience*.
- Gao R, Peterson EJ, Voytek B (2017). Inferring synaptic excitation/inhibition balance from field potentials. *NeuroImage*.
- Hagerty MR et al. (2013). Case study of ecstatic meditation: fMRI and EEG evidence of self-stimulating a reward system. *Neural Plasticity*.
- Irrmischer M et al. (2018). Controlling the temporal structure of brain oscillations by focused attention meditation. *Human Brain Mapping*.
- Jensen O, Mazaheri A (2010). Shaping functional architecture by oscillatory alpha activity: gating by inhibition. *Frontiers in Human Neuroscience*.
- Klimesch W (2013). An algorithm for the EEG frequency architecture of consciousness and brain body coupling. *Frontiers in Human Neuroscience* 7:766. doi:10.3389/fnhum.2013.00766
- Klimesch W (2018). The frequency architecture of brain and brain body oscillations: an analysis. *European Journal of Neuroscience*.
- Lakatos P et al. (2005). An oscillatory hierarchy controlling neuronal excitability and stimulus processing in the auditory cortex. *Journal of Neurophysiology*.
- Linkenkaer-Hansen K et al. (2001). Long-range temporal correlations and scaling behavior in human brain oscillations. *Journal of Neuroscience*.
- Lisman JE, Jensen O (2013). The theta-gamma neural code. *Neuron*.
- Ngo HV et al. (2013). Auditory closed-loop stimulation of the sleep slow oscillation enhances memory. *Neuron*.
- Pletzer B, Kerschbaum H, Klimesch W (2010). When frequencies never synchronize: the golden mean and the resting EEG. *Brain Research*.
- Rodriguez-Larios J, Alaerts K (2019). Tracking transient changes in the neural frequency architecture: harmonic relationships between theta and alpha peaks facilitate cognitive performance. *Journal of Neuroscience*.
- Rodriguez-Larios J, Wong KF, Lim J, Alaerts K (2020). Mindfulness training is associated with changes in alpha-theta cross-frequency dynamics during meditation. *Mindfulness* 11(12):2695–2704. doi:10.1007/s12671-020-01487-3
- Rodriguez-Larios J et al. (2020). From thoughtless awareness to effortful cognition: alpha-theta cross-frequency dynamics in experienced meditators during meditation, rest and arithmetic. *Scientific Reports* 10:5419.
- Rodriguez-Larios J, Alaerts K (2021). EEG alpha-theta dynamics during mind wandering in the context of breath focus meditation: an experience sampling approach with novice meditation practitioners. *European Journal of Neuroscience* 53(6):1855–1868. doi:10.1111/ejn.15073
- Roopun AK et al. (2008). Temporal interactions between cortical rhythms. *Frontiers in Neuroscience* 2(2):145–154. (Review.)
- Schartner MM et al. (2017). Increased spontaneous MEG signal diversity for psychoactive doses of ketamine, LSD and psilocybin. *Scientific Reports*.
- Staresina BP et al. (2015). Hierarchical nesting of slow oscillations, spindles and ripples in the human hippocampus during sleep. *Nature Neuroscience*.
- Voss U et al. (2009). Lucid dreaming: a state of consciousness with features of both waking and non-lucid dreaming. *Sleep*.
- Coan JA, Allen JJB (2004). Frontal EEG asymmetry as a moderator and mediator of emotion. *Biological Psychology*.
- Fredrickson BL et al. (2008). Open hearts build lives: positive emotions, induced through loving-kindness meditation, build consequential personal resources. *Journal of Personality and Social Psychology*.
- Grossman P, Taylor EW (2007). Toward understanding respiratory sinus arrhythmia: relations to cardiac vagal tone, evolution and biobehavioral functions. *Biological Psychology*.
- Jasper H, Shagass C (1941). Conditioning the occipital alpha rhythm in man. *Journal of Experimental Psychology*.
- Juslin PN, Västfjäll D (2008). Emotional responses to music: the need to consider underlying mechanisms. *Behavioral and Brain Sciences*.
- Kok BE et al. (2013). How positive emotions build physical health: perceived positive social connections account for the upward spiral between positive emotions and vagal tone. *Psychological Science*.
- Lench HC, Flores SA, Bench SW (2011). Discrete emotions predict changes in cognition, judgment, experience, behavior, and physiology: a meta-analysis of experimental emotion elicitations. *Psychological Bulletin*.
- Lieberman MD et al. (2007). Putting feelings into words: affect labeling disrupts amygdala activity in response to affective stimuli. *Psychological Science* 18(5):421–428.
- McCraty R et al. (2009). The coherent heart: heart-brain interactions, psychophysiological coherence, and the emergence of system-wide order. *Integral Review*.
- Oudiette D, Paller KA (2013). Upgrading the sleeping brain with targeted memory reactivation. *Trends in Cognitive Sciences*.
- Grossman P (2023). Fundamental challenges and likely refutations of the five basic premises of the polyvagal theory. *Biological Psychology*.
- Rasch B et al. (2007). Odor cues during slow-wave sleep prompt declarative memory consolidation. *Science*.
- Russell RK, Sipich JF (1973). Cue-controlled relaxation in the treatment of test anxiety. *Journal of Behavior Therapy and Experimental Psychiatry*.
- Shaffer F, Ginsberg JP (2017). An overview of heart rate variability metrics and norms. *Frontiers in Public Health*.
- Dance CJ, Ipser A, Simner J (2022). The prevalence of aphantasia (imagery weakness) in the general population. *Consciousness and Cognition* 97:103243.
- Davidson RJ (1992). Anterior cerebral asymmetry and the nature of emotion. *Brain and Cognition* 20(1):125–151.
- Enriquez-Geppert S et al. (2014). Modulation of frontal-midline theta by neurofeedback. *Biological Psychology* 95:59–69.
- Hanslmayr S et al. (2005). Increasing individual upper alpha power by neurofeedback improves cognitive performance in human subjects. *Applied Psychophysiology and Biofeedback* 30(1):1–10.
- Heathers JAJ, Brown NJL, Coyne JC, Friedman HL (2015). The elusory upward spiral: a reanalysis of Kok et al. (2013). *Psychological Science* 26(7):1140–1143.
- Kamiya J (1968). Conscious control of brain waves. *Psychology Today* 1:56–60.
- Kamiya J (1969). Operant control of the EEG alpha rhythm and some of its reported effects on consciousness. In Tart CT (ed.), *Altered States of Consciousness*. Wiley.
- Kluger DS, Gross J (2021). Respiration modulates oscillatory neural network activity at rest. *PLOS Biology*. (Details unverified.)
- Koelstra S et al. (2012). DEAP: a database for emotion analysis using physiological signals. *IEEE Transactions on Affective Computing* 3(1):18–31.
- Lendner JD et al. (2020). An electrophysiological marker of arousal level in humans. *eLife* 9:e55092.
- McGowan et al. (2025). Strategies for neurofeedback success: exploring the relationship between alpha power and mental effort. Poster P194, CNS*2025 (Computational Neuroscience), Florence.
- Mulholland TB (1972). Occipital alpha revisited. *Psychological Bulletin* 78(3):176–182.
- Nickerson CA (2018). Overstating the effects of loving-kindness meditation: comment on Kok et al. (2013). *Psychological Science* 29(3):463–466. doi:10.1177/0956797616682946
- Paskewitz DA, Orne MT (1973). Visual effects on alpha feedback training. *Science* 181:360–363. (Details unverified.)
- Penttonen M, Buzsáki G (2003). Natural logarithmic relationship between brain oscillators. *Thalamus & Related Systems* 2(2):145–152. doi:10.1017/S1472928803000074
- Rudoy JD, Voss JL, Westerberg CE, Paller KA (2009). Strengthening individual memories by reactivating them during sleep. *Science* 326:1079.
- Schartner M et al. (2015). Complexity of multi-dimensional spontaneous EEG decreases during propofol induced general anaesthesia. *PLOS ONE* 10(8):e0133532.
- Schartner MM et al. (2017). Global and local complexity of intracranial EEG decreases during NREM sleep. *Neuroscience of Consciousness* 2017(1):niw022.
- Scott WC, Kaiser D, Othmer S, Sideroff SI (2005). Effects of an EEG biofeedback protocol on a mixed substance abusing population. *American Journal of Drug and Alcohol Abuse* 31(3):455–469.
- Task Force of the European Society of Cardiology and the North American Society of Pacing and Electrophysiology (1996). Heart rate variability: standards of measurement, physiological interpretation and clinical use. *Circulation* 93(5):1043–1065.
- Wan F, Nan W, Vai MI, Rosa A (2014). Resting alpha activity predicts learning ability in alpha neurofeedback. *Frontiers in Human Neuroscience* 8:500.
- Witte M, Kober SE, Ninaus M, Neuper C, Wood G (2013). Control beliefs can predict the ability to up-regulate sensorimotor rhythm during neurofeedback training. *Frontiers in Human Neuroscience* 7:478.
- Zeman A, Dewar M, Della Sala S (2015). Lives without imagery: congenital aphantasia. *Cortex* 73:378–380.
