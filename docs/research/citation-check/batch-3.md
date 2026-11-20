# Citation check, batch 3

Brief: /home/user/hurricane-brain/docs/research/brainwave-induction-research.md (not edited).
Verified by web search and fetches of publisher, PubMed, Brunel/BURA and Frontiers pages. Where a page could not be fetched (PMC captcha), metadata comes from a second source or is marked "from memory, high confidence".

---

## 1. Lakatos et al. (2005)
- **Status:** OK (add details)
- **Citation:** Lakatos P, Shah AS, Knuth KH, Ulbert I, Karmos G, Schroeder CE (2005). An oscillatory hierarchy controlling neuronal excitability and stimulus processing in the auditory cortex. *J Neurophysiol* 94(3):1904–1911.
- **DOI:** https://doi.org/10.1152/jn.00263.2005 (from memory, high confidence)
- **Claim check (l.444–445, "delta phase modulates theta amplitude, which modulates gamma"):** Yes. The study used laminar recordings in macaque primary auditory cortex. Delta phase modulated theta amplitude, and theta phase modulated gamma amplitude.
- **Fix:** Add "(macaque A1)". Grade A is fine for the existence of nested cascades.

## 2. Linkenkaer-Hansen et al. (2001)
- **Status:** OK
- **Citation:** Linkenkaer-Hansen K, Nikouline VV, Palva JM, Ilmoniemi RJ (2001). Long-range temporal correlations and scaling behavior in human brain oscillations. *J Neurosci* 21(4):1370–1377.
- **DOI:** https://doi.org/10.1523/JNEUROSCI.21-04-01370.2001
- **Claim check (l.468–470):** Yes. The study used MEG/EEG in about 10 subjects. DFA showed power-law long-range temporal correlations in the alpha (and beta) amplitude envelope, interpreted as consistent with self-organised criticality.
- **Fix:** None needed.

## 3. Lisman & Jensen (2013)
- **Status:** OK
- **Citation:** Lisman JE, Jensen O (2013). The theta-gamma neural code. *Neuron* 77(6):1002–1016.
- **DOI:** https://doi.org/10.1016/j.neuron.2013.03.007
- **Claim check (l.440–441):** Yes. This is a review and theory paper: theta-nested gamma cycles code ordered multi-item sequences and working memory.
- **Fix:** None needed.

## 4. Ngo et al. (2013)
- **Status:** OK (grade comment)
- **Citation:** Ngo HV, Martinetz T, Born J, Mölle M (2013). Auditory closed-loop stimulation of the sleep slow oscillation enhances memory. *Neuron* 78(3):545–553.
- **DOI:** https://doi.org/10.1016/j.neuron.2013.03.006
- **Claim check (l.503–505):** Yes. In n = 11, clicks timed to slow-oscillation up-states enhanced the slow oscillations and phase-locked spindles, and improved overnight word-pair retention. Later replications reliably show the slow-wave enhancement. The memory benefit is less consistent (for example, Henin et al. 2019 found no memory gain).
- **Fix:** Use Grade A–B for boosting slow waves and B for the memory benefit.

## 5. Pletzer, Kerschbaum & Klimesch (2010) — GOLDEN RATIO
- **Status:** CLAIM-WRONG (partly; grade too high)
- **Citation:** Pletzer B, Kerschbaum H, Klimesch W (2010). When frequencies never synchronize: the golden mean and the resting EEG. *Brain Res* 1335:91–102.
- **URL/DOI:** https://pubmed.ncbi.nlm.nih.gov/20350536/ ; https://doi.org/10.1016/j.brainres.2010.03.074 (DOI from memory, high confidence)
- **Claim check (l.394–402):**
  - Partly correct. The abstract does propose that EEG bands form a geometric series with ratio about 1.618. It also argues that excitatory phases of two oscillations at a phi ratio never coincide mathematically, giving a maximally uncoupled, "desynchronised" state that the authors link to the resting brain. Physiologically, the phases coincide occasionally, and phi gives the most irregular pattern of coincidences, which may allow spontaneous coupling and uncoupling (rest-to-activity transitions).
  - The abstract is purely mathematical/theoretical, and no empirical EEG analysis is reported in it. Klimesch (2013) also describes it as having "shown mathematically".
  - "Multiplexing: separate information channels sharing one network" is the brief's own gloss. Pletzer frames phi as "uncoupled/resting", not as multiplexing.
- **Grade:** C, not B ("theoretical with supporting EEG data" is not supported).
- **Fix:** Replace with: "…argued mathematically that if band centre frequencies form a geometric series with ratio phi, their excitatory phases never align exactly, giving a maximally decoupled 'resting' state while still allowing occasional, irregular coupling. Integer ratios (2:1, 3:1) allow phase-locking. Grade C (theoretical model)." Drop or reattribute "multiplexing".
- **Note on the adjacent Klimesch (2013, 2018) bullet (not in this batch):**
  - Klimesch 2013 (*Front Hum Neurosci* 7:766, doi 10.3389/fnhum.2013.00766) is an opinion/theory piece.
  - It proposes band centres that double (2.5, 5, 10, 20, 40 Hz). Golden-mean values are used only for band boundaries.
  - It proposes a link to heart rate and breathing (1.25 Hz ≈ 75 bpm as a scaling factor) and is explicitly speculative.
  - The "switching between harmonic and golden-mean ratios" idea matches Klimesch 2018 (*Eur J Neurosci*) better than 2013. Grade C rather than B–C.

## 6. Rodriguez-Larios & Alaerts (2019) — GOLDEN RATIO / DIRECTION
- **Status:** OK (one wording issue)
- **Citation:** Rodriguez-Larios J, Alaerts K (2019). Tracking transient changes in the neural frequency architecture: harmonic relationships between theta and alpha peaks facilitate cognitive performance. *J Neurosci* 39(32):6291–6298.
- **DOI:** https://doi.org/10.1523/JNEUROSCI.2919-18.2019 (BURA record: https://bura.brunel.ac.uk/handle/2438/27630)
- **Claim check (l.408–411):**
  - Yes, the direction is correct. Across 51 participants in two experiments (rest, breath focus, arithmetic), the share of epochs with a 2:1 alpha:theta peak ratio (≈10.6/5.3 Hz) rose with cognitive demand. It predicted greater alpha–theta phase synchrony and better arithmetic performance.
  - Non-harmonic ratios were more common at rest than during arithmetic.
  - Important caveat for §6.1 point 3: the paper's "non-harmonic" category is a ratio of **1.1–1.6**, which does not include phi (1.618). The paper tests harmonic vs non-harmonic, not phi specifically. So "phi-like alpha:theta relations go with restful/meditative states" overstates it. The evidence supports "non-harmonic (not 2:1)", not "near phi".
- **Grade:** B for the harmonic-vs-task finding is fine.
- **Fix (§6.1 point 3):** Change "phi-like (non-harmonic)" to "non-harmonic (ratios away from 2:1; these studies did not test phi specifically)". Note that a phi-specific marker is the app's own hypothesis.

## 7. Rodriguez-Larios et al. (2020) — WRONG JOURNAL, WRONG DETAIL
- **Status:** CORRECT-METADATA + CLAIM-WRONG (partly)
- **Corrected citation:** Rodriguez-Larios J, Wong KF, Lim J, Alaerts K (2020). Mindfulness training is associated with changes in alpha-theta cross-frequency dynamics during meditation. *Mindfulness* 11(12):2695–2704. (Not *NeuroImage*; the title also ends "…during meditation".)
- **DOI:** https://doi.org/10.1007/s12671-020-01487-3
- **Claim check (l.411–413):**
  - "Mindfulness training reduced harmonic alpha:theta relations during meditation": partly. In n = 36 novices (8-week MBSR-style course, pre/post EEG, no control group), training compliance correlated with decreased **3:1** (not 2:1) harmonicity and alpha–theta phase synchrony during meditation. The result is correlational.
  - "Mind-wandering episodes showed more harmonic coupling": not in this paper. It comes from Rodriguez-Larios J, Alaerts K (2021). EEG alpha–theta dynamics during mind wandering in the context of breath focus meditation: an experience sampling approach with novice meditation practitioners. *Eur J Neurosci* 53(6):1855–1868, https://doi.org/10.1111/ejn.15073. In n = 25 novices, mind wandering showed increased alpha–theta harmonicity and phase synchrony, with higher theta and lower alpha amplitude.
  - Also relevant for experienced meditators: Rodriguez-Larios J, Faber P, Achermann P, Tei S, Alaerts K (2020). From thoughtless awareness to effortful cognition: alpha-theta cross-frequency dynamics in experienced meditators during meditation, rest and arithmetic. *Sci Rep* 10:5419, https://doi.org/10.1038/s41598-020-62392-2. In n = 43, 2:1 harmonic occurrence increased linearly from meditation to rest to arithmetic.
  - A 2021 *NeuroImage* paper by the same group (meditators vs novices, mind wandering) reports alpha frequency/amplitude and 1/f slope, not harmonicity. This is probably the source of the journal mix-up.
  - The direction of the findings in the brief is correct throughout: harmonic coupling is lower in meditation and higher with task and mind wandering.
- **Fix:** "Rodriguez-Larios et al. (2020, *Mindfulness*) found that greater compliance with an 8-week mindfulness course correlated with fewer harmonic (3:1) alpha:theta relations during meditation (n = 36, no control group). In experienced meditators, 2:1 harmonic relations rose from meditation to rest to arithmetic (Rodriguez-Larios et al. 2020, *Sci Rep*), and mind-wandering episodes showed more alpha:theta harmonicity (Rodriguez-Larios and Alaerts 2021, *EJN*). Grade B–C (one lab, modest samples)." Add the two extra references. The brief's "one main group" grade note is accurate; B–C is more honest.

## 8. Roopun et al. (2008) — GOLDEN RATIO
- **Status:** OK (minor qualifications)
- **Citation:** Roopun AK, Kramer MA, Carracedo LM, Kaiser M, Davies CH, Traub RD, Kopell NJ, Whittington MA (2008). Temporal interactions between cortical rhythms. *Front Neurosci* 2(2):145–154.
- **DOI:** https://doi.org/10.3389/neuro.01.034.2008
- **Claim check (l.389–393):**
  - Mostly yes. The text states that bands "appear approximately distributed according to 'phi' (the 'golden mean') rather than 'e'", and the abstract says the frequency relationships "minimise interference".
  - It is a Focused Review summarising the group's in vitro neocortical slice work (rat, per the cited primary papers, e.g. Roopun et al. 2008 *Front Cell Neurosci*, "period concatenation"). It does not report new data.
  - "Observed" overstates it slightly: the phi spacing is an approximate observation across rhythms generated in slices.
- **Grade:** B–C rather than B (review of single-lab in vitro work; phi fit is approximate).
- **Fix:** "…a review of in vitro rat neocortex work, which noted that adjacent rhythm frequencies are spaced approximately by phi…". Optionally also cite the primary paper (Roopun et al. 2008, *Front Cell Neurosci* 2:1, doi 10.3389/neuro.03.001.2008).

## 9. Schartner et al. (2017)
- **Status:** OK (partly; attribution)
- **Citation:** Schartner MM, Carhart-Harris RL, Barrett AB, Seth AK, Muthukumaraswamy SD (2017). Increased spontaneous MEG signal diversity for psychoactive doses of ketamine, LSD and psilocybin. *Sci Rep* 7:46421.
- **DOI:** https://doi.org/10.1038/srep46421
- **Claim check (l.474–476):** Partly. This paper shows increased Lempel-Ziv signal diversity under ketamine, LSD and psilocybin (MEG). It does not show the fall in sleep and anaesthesia. Those findings are in Schartner et al. 2015 (*PLoS One*, propofol) and Schartner et al. 2017 (*Neurosci Conscious*, sleep).
- **Fix:** Add those references for the sleep/anaesthesia half. Grade B is fine.

## 10. Staresina et al. (2015)
- **Status:** OK
- **Citation:** Staresina BP, Bergmann TO, Bonnefond M, van der Meij R, Jensen O, Deuker L, Elger CE, Axmacher N, Fell J (2015). Hierarchical nesting of slow oscillations, spindles and ripples in the human hippocampus during sleep. *Nat Neurosci* 18(11):1679–1686.
- **DOI:** https://doi.org/10.1038/nn.4119
- **Claim check (l.445–447):** Yes. Intracranial recordings in epilepsy patients showed slow-oscillation up-states nesting spindles, and spindle troughs nesting ripples. This has been replicated since. Grade A is fine.

## 11. Voss et al. (2009)
- **Status:** OK metadata; grade too high
- **Citation:** Voss U, Holzmann R, Tuin I, Hobson JA (2009). Lucid dreaming: a state of consciousness with features of both waking and non-lucid dreaming. *Sleep* 32(9):1191–1200.
- **URL/DOI:** https://pubmed.ncbi.nlm.nih.gov/19750924/ ; https://doi.org/10.1093/sleep/32.9.1191
- **Claim check (l.494):** Yes as worded. 40 Hz power was higher in lucid dreaming than in REM, strongest in frontal and frontolateral regions. However, the result rests on **3 lucid episodes from 3 subjects** (6 lab participants, out of 20 trained). Later work (e.g. Baird et al. 2022, *Sleep*) questions the frontal-gamma "hybrid state" picture and points to eye-movement artifact.
- **Grade:** C.
- **Fix:** "…(Voss et al. 2009; 3 lucid episodes, not consistently replicated) … Grade C".

## 12. Coan & Allen (2004)
- **Status:** OK
- **Citation:** Coan JA, Allen JJB (2004). Frontal EEG asymmetry as a moderator and mediator of emotion. *Biol Psychol* 67(1–2):7–49.
- **DOI:** https://doi.org/10.1016/j.biopsycho.2004.03.002
- **Claim check (l.552–555):** Yes. It is a review of approach/withdrawal frontal asymmetry. "Small and noisy at the individual level" is fair (cf. the reliability critiques). Grade B (lab) / C (Muse) is fine.

## 13. Fredrickson et al. (2008)
- **Status:** OK
- **Citation:** Fredrickson BL, Cohn MA, Coffey KA, Pek J, Finkel SM (2008). Open hearts build lives: positive emotions, induced through loving-kindness meditation, build consequential personal resources. *J Pers Soc Psychol* 95(5):1045–1062.
- **DOI:** https://doi.org/10.1037/a0013262
- **Claim check (l.533–534):** Yes. In n = 139 working adults randomised to 7 weeks of loving-kindness meditation or a waitlist, daily positive emotions increased, which built resources and life satisfaction. Grade B is fine.

## 14. Grossman & Taylor (2007)
- **Status:** OK
- **Citation:** Grossman P, Taylor EW (2007). Toward understanding respiratory sinus arrhythmia: relations to cardiac vagal tone, evolution and biobehavioral functions. *Biol Psychol* 74(2):263–285.
- **DOI:** https://doi.org/10.1016/j.biopsycho.2005.11.014
- **Claim check (l.578–580):** Yes. The paper critiques polyvagal theory's evolutionary and anatomical premises and the use of RSA as a pure index of vagal tone.

## 15. Jasper & Shagass (1941)
- **Status:** OK
- **Citation:** Jasper H, Shagass C (1941). Conditioning the occipital alpha rhythm in man. *J Exp Psychol* 28(5):373–388.
- **DOI:** https://doi.org/10.1037/h0056139 (from memory, high confidence)
- **Claim check (l.591–593):** Yes. Conditioned alpha blocking was obtained by pairing a tone with light; the study was small and old. Grade C for complex-state conditioning is appropriate.

## 16. Juslin & Västfjäll (2008)
- **Status:** OK
- **Citation:** Juslin PN, Västfjäll D (2008). Emotional responses to music: the need to consider underlying mechanisms. *Behav Brain Sci* 31(5):559–575.
- **DOI:** https://doi.org/10.1017/S0140525X08005293
- **Claim check (l.595–596):** Yes. Evaluative conditioning and episodic memory are two of the six proposed mechanisms (BRECVEM). It is a theoretical framework, so Grade B–C rather than B.

## 17. Kok et al. (2013)
- **Status:** CLAIM-WRONG (unverifiable detail)
- **Citation:** Kok BE, Coffey KA, Cohn MA, Catalino LI, Vacharkulksemsuk T, Algoe SB, Brantley M, Fredrickson BL (2013). How positive emotions build physical health: perceived positive social connections account for the upward spiral between positive emotions and vagal tone. *Psychol Sci* 24(7):1123–1132.
- **URL/DOI:** https://pubmed.ncbi.nlm.nih.gov/23649562/ ; https://doi.org/10.1177/0956797612470827
- **Claim check (l.534–536):**
  - The original result (n = 65, 6-week loving-kindness meditation vs waitlist; vagal tone rose to the extent LKM raised positive emotion and social connection) is cited correctly.
  - "Did not hold up cleanly in a later preregistered replication": **not found.** Searches turned up no preregistered replication. What exists is a published reanalysis critique: Heathers JAJ, Brown NJL, Coyne JC, Friedman HL (2015). The elusory upward spiral: a reanalysis of Kok et al. (2013). *Psychol Sci* 26(7):1140–1143, https://doi.org/10.1177/0956797615572908. It found no reliable group × time effect on vagal tone. The authors replied: Kok BE, Fredrickson BL (2015). Evidence for the upward spiral stands steady. *Psychol Sci* 26(7):1144–1146.
- **Fix:** "…a reported link to rising vagal tone (Kok et al. 2013) was challenged in a reanalysis that found no reliable intervention effect on vagal tone (Heathers et al. 2015), so treat the HRV claim as Grade C." Grade C stands.

## 18. Lench, Flores & Bench (2011)
- **Status:** OK metadata; CLAIM partly
- **Citation:** Lench HC, Flores SA, Bench SW (2011). Discrete emotions predict changes in cognition, judgment, experience, behavior, and physiology: a meta-analysis of experimental emotion elicitations. *Psychol Bull* 137(5):834–855.
- **DOI:** https://doi.org/10.1037/a0024244
- **Claim check (l.526–529):**
  - Partly. The meta-analysis covers 687 studies, 4,946 effects and 49,473 participants, and four emotions (happiness, sadness, anger, anxiety). Elicitations were mostly effective, with strength varying by emotion comparison. **Picture presentation was the most effective method overall.** Effects were stronger for happiness and for self-reported experience.
  - The paper does not single out recall and imagery as the reliable self-generated methods.
  - Its conclusion favours discrete-emotion effects and gives *weaker* support to valence/arousal models. This sits awkwardly with the next bullet (l.530–531, "stronger for arousal than … specific emotions"), which needs a different source or softening.
- **Fix:** "…a meta-analysis of 687 emotion-elicitation experiments (Lench et al. 2011) found most induction methods effective (pictures strongest), with reliable changes in self-report and smaller, correlated changes in behaviour and physiology. Recall and imagery are the self-generated methods an app can use. Grade A that inductions work; B for self-generated methods specifically." Remove or re-source the arousal-vs-valence sentence.

## 19. Lieberman et al. (2007)
- **Status:** OK
- **Citation:** Lieberman MD, Eisenberger NI, Crockett MJ, Tom SM, Pfeifer JH, Way BM (2007). Putting feelings into words: affect labeling disrupts amygdala activity in response to affective stimuli. *Psychol Sci* 18(5):421–428.
- **DOI:** https://doi.org/10.1111/j.1467-9280.2007.01916.x
- **Claim check (l.546–547):** Yes. In fMRI (n ≈ 30), labelling emotional faces reduced the amygdala response, with right VLPFC increases. Note that the full title adds "in response to affective stimuli". "Emotional granularity" is a separate construct (Barrett), so the bullet conflates the two slightly. Grade B is fine.

## 20. McCraty et al. (2009)
- **Status:** OK
- **Citation:** McCraty R, Atkinson M, Tomasino D, Bradley RT (2009). The coherent heart: heart-brain interactions, psychophysiological coherence, and the emergence of system-wide order. *Integral Review* 5(2):10–115.
- **URL:** No DOI (Integral Review is open access).
- **Claim check (l.540–545):** Yes, framed correctly as HeartMath-affiliated work. Grade C is fine.

## 21. Oudiette & Paller (2013)
- **Status:** OK
- **Citation:** Oudiette D, Paller KA (2013). Upgrading the sleeping brain with targeted memory reactivation. *Trends Cogn Sci* 17(3):142–149.
- **DOI:** https://doi.org/10.1016/j.tics.2013.01.006
- **Claim check:** Yes. It is a review of targeted memory reactivation (TMR) with sounds and odours.

## 22. Grossman (2023)
- **Status:** OK
- **Citation:** Grossman P (2023). Fundamental challenges and likely refutations of the five basic premises of the polyvagal theory. *Biol Psychol* 180:108589.
- **DOI:** https://doi.org/10.1016/j.biopsycho.2023.108589
- **Claim check:** Yes.

## 23. Rasch et al. (2007)
- **Status:** CLAIM partly (cue modality)
- **Citation:** Rasch B, Büchel C, Gais S, Born J (2007). Odor cues during slow-wave sleep prompt declarative memory consolidation. *Science* 315(5817):1426–1429.
- **DOI:** https://doi.org/10.1126/science.1138581
- **Claim check (l.598–600, "sounds paired with learning … Rasch et al. 2007"):**
  - Partly. Rasch used an **odour** (rose scent), not a sound. Re-exposure during slow-wave sleep, but not REM or wake, improved retention of object-location memory.
  - The sound version is Rudoy JD, Voss JL, Westerberg CE, Paller KA (2009). Strengthening individual memories by reactivating them during sleep. *Science* 326(5956):1079, doi 10.1126/science.1179013.
  - TMR works in NREM (slow-wave sleep and N2). A meta-analysis (Hu X et al. 2020, *Psychol Bull* 146(3):218–244) supports a moderate NREM effect.
- **Fix:** "cues (odours, sounds) paired with learning can reactivate that memory when replayed during NREM sleep (Rasch et al. 2007, odour; Rudoy et al. 2009, sound; Oudiette and Paller 2013)". Also change "replay a user's anchor in light sleep" to "in NREM (N2/N3) sleep". Grade A–B is fine.

## 24. Russell & Sipich (1973)
- **Status:** CORRECT-METADATA (pages/DOI) + grade note
- **Citation:** Russell RK, Sipich JF (1973). Cue-controlled relaxation in the treatment of test anxiety. *J Behav Ther Exp Psychiatry* 4(1):47–49.
- **DOI:** https://doi.org/10.1016/0005-7916(73)90038-4
- **Claim check (l.585–589):**
  - Partly. This is a 3-page brief report with no abstract available. To my recollection it is a single-case or very small demonstration; the full text was not accessible to confirm sample size.
  - The "Grade B" in the brief relies on "later anxiety-treatment work" (e.g. Russell, Wise & Stratoudakis 1976, group cue-controlled relaxation; Öst's applied relaxation trials), which is not cited.
- **Fix:** Cite a controlled follow-up or applied-relaxation trial alongside it. Otherwise grade it C on this reference alone. Keep the "smaller than the original state, fades without practice" caveat.

## 25. Shaffer & Ginsberg (2017)
- **Status:** OK
- **Citation:** Shaffer F, Ginsberg JP (2017). An overview of heart rate variability metrics and norms. *Front Public Health* 5:258.
- **DOI:** https://doi.org/10.3389/fpubh.2017.00258
- **Claim check (l.567–569):** Yes. It is a review of RMSSD and HF power as vagally mediated indices. Grade A is fine.
