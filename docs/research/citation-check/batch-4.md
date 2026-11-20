# Fact-check batch 4: in-text citations with no full reference entry

Brief: /home/user/hurricane-brain/docs/research/brainwave-induction-research.md (line numbers refer to it).
Method: WebSearch, publisher/Frontiers pages and the Crossref API. PubMed and PMC returned bot checks, so PMIDs come from search-result URLs. The shared web-fetch budget ran out near the end. Items marked "(not re-fetched)" have metadata from search results or well-known values only.

---

## 1. Wan F et al. (2014): resting alpha predicts alpha-NF learning (line 353)
- **Status:** CORRECT-METADATA (the claim is OK; it only needs a full reference)
- **Citation:** Wan F, Nan W, Vai MI, Rosa A (2014). Resting alpha activity predicts learning ability in alpha neurofeedback. *Frontiers in Human Neuroscience* 8:500.
- **DOI:** https://doi.org/10.3389/fnhum.2014.00500 (PMC4095646)
- **Claim check:** Supported. N = 25 healthy adults did 20 alpha-NF sessions. Eyes-closed resting alpha amplitude correlated with three learning indices: r = 0.47, 0.55 and 0.63 (learning slope, p < .01). Eyes-open alpha correlated too, with r = 0.43 to 0.54.
- **Grade:** This is a single small study (C), so the overall "B–C" for predictors is fine.
- **Fix:** Add the full reference.

## 2. Witte M et al. (2013): technology locus of control predicts SMR-NF success (lines 357, 648)
- **Status:** CORRECT-METADATA, with a nuance
- **Citation:** Witte M, Kober SE, Ninaus M, Neuper C, Wood G (2013). Control beliefs can predict the ability to up-regulate sensorimotor rhythm during neurofeedback training. *Frontiers in Human Neuroscience* 7:478.
- **DOI:** https://doi.org/10.3389/fnhum.2013.00478 (PMC3744034)
- **Claim check:** Partly. The scale was the German KUT ("control beliefs in dealing with technology"). N = 20 (10 real NF, 10 sham). The correlation was **negative**: higher technology control beliefs went with lower SMR power (training r = −0.69, baseline r = −0.73; n = 10; p < .05). The sham group showed no significant correlation. The authors call the result preliminary.
- **Grade:** C.
- **Fix:** At line 357 add "(n = 10; higher technology control beliefs predicted *poorer* SMR up-regulation)". In the line-648 table, note that the KUT is German and that the direction is counter-intuitive. The profile must not assume "high tech confidence = good responder".

## 3. Hanslmayr S et al. (2005): upper-alpha NF and mental rotation (line 301)
- **Status:** CORRECT-METADATA
- **Citation:** Hanslmayr S, Sauseng P, Doppelmayr M, Schabus M, Klimesch W (2005). Increasing individual upper alpha power by neurofeedback improves cognitive performance in human subjects. *Applied Psychophysiology and Biofeedback* 30(1):1–10.
- **DOI:** https://doi.org/10.1007/s10484-005-2169-8
- **Claim check:** Supported, with a caveat. The training raised upper alpha and lowered theta, and mental rotation was tested before and after. Only "responders" who actually raised upper alpha improved on mental rotation, and the size of the alpha gain correlated with the improvement.
- **Grade:** B is OK for the group of studies; this study alone is C.
- **Fix:** Optionally add "(improvement only in participants who succeeded in raising upper alpha)". That supports the responder theme in 5.7.

## 4. Scott WC et al. (2005): Peniston-style protocol in addiction (line 312)
- **Status:** CORRECT-METADATA
- **Citation:** Scott WC, Kaiser D, Othmer S, Sideroff SI (2005). Effects of an EEG biofeedback protocol on a mixed substance abusing population. *American Journal of Drug and Alcohol Abuse* 31(3):455–469.
- **DOI:** https://doi.org/10.1081/ADA-200056807 (PubMed 16161729)
- **Claim check:** Supported. This was an RCT with N = 121 inpatients. The protocol was beta/SMR training for attention, then alpha-theta, for 40–50 sessions in total. The NF group stayed in treatment longer (p < .005). At 12 months, 77% of completers were abstinent versus 44% of controls. TOVA attention improved after about 13 beta/SMR sessions. The brief's phrase "used combined protocols" is accurate. It is a modified protocol rather than a strict replication.
- **Grade:** B–C is OK.
- **Fix:** Optionally write "an RCT (n = 121) adding beta/SMR attention training before alpha-theta".

## 5. Enriquez-Geppert S et al. (2014): frontal-midline theta NF (line 329)
- **Status:** CORRECT-METADATA
- **Citation (most likely):** Enriquez-Geppert S, Huster RJ, Figge C, Herrmann CS (2014). Self-regulation of frontal-midline theta facilitates memory updating and mental set shifting. *Frontiers in Behavioral Neuroscience* 8:420. https://doi.org/10.3389/fnbeh.2014.00420 (PMC4257088)
- **Companion paper, also dated 2014:** Enriquez-Geppert S, Huster RJ, Scharfenort R, Mokom ZN, Zimmermann J, Herrmann CS. Modulation of frontal-midline theta by neurofeedback. *Biological Psychology* 95:59–69 (PubMed 23499994) (not re-fetched).
- **Claim check:** Supported. N = 40, with a pseudo-NF control that replayed matched sessions. There were 8 sessions of 30 min, trained at Fz/FCz/Cz. NF gave larger gains in 3-back accuracy and in task-switching RTs. There was no effect on Stroop or stop-signal. "Needs Fz" is correct.
- **Grade:** B–C (positive but small).
- **Fix:** Add the reference(s).

## 6. Stetter F, Kupper S (2002): autogenic training meta-analysis (line 186)
- **Status:** OK. A full entry exists at line 728, and the metadata matches.
- **Citation:** Stetter F, Kupper S (2002). Autogenic training: a meta-analysis of clinical outcome studies. *Applied Psychophysiology and Biofeedback* 27(1):45–98.
- **DOI:** https://doi.org/10.1023/A:1014576505223
- **Claim check:** Supported. The meta-analysis covered 60 studies, 35 of them RCTs. It found medium-to-large pre–post effects and medium effects against control conditions. Anxiety disorders are among the conditions with medium positive effects. Against other psychological treatments, the effects were mostly null or small. The underlying studies date from 1952 to 1999.
- **Grade:** A for "relaxation benefits" is a little generous, because the studies are old and of mixed quality. B+ would be safer, but this is not an error.
- **Fix:** Add the DOI.

## 7. Task Force of ESC/NASPE (1996): HRV standards (line 568)
- **Status:** CORRECT-METADATA (not re-fetched; values from search results and standard records)
- **Citation:** Task Force of the European Society of Cardiology and the North American Society of Pacing and Electrophysiology (1996). Heart rate variability: standards of measurement, physiological interpretation and clinical use. *Circulation* 93(5):1043–1065. It was published simultaneously in *European Heart Journal* 17(3):354–381.
- **DOI/URL:** https://doi.org/10.1161/01.CIR.93.5.1043 ; PubMed 8598068 (Circulation), 8737210 (Eur Heart J)
- **Claim check:** Supported. The document defines HF power and RMSSD as markers of vagal modulation. "Rise with calm, safety" is the brief's own interpretation; the Task Force sets measurement standards. Grade A is fine for "HF/RMSSD index vagal control".
- **Fix:** Add the reference.

## 8. Mulholland (1970s) and Lynch & Paskewitz (1971): alpha gains are mostly release of alpha blocking (lines 87–91)
- **Status:** CORRECT-METADATA. Lynch & Paskewitz has an entry at line 721; add its volume, pages and DOI. Fix the Mulholland date.
- **Citations:**
  - Lynch JJ, Paskewitz DA (1971). On the mechanisms of the feedback control of human brain wave activity. *Journal of Nervous and Mental Disease* 153(3):205–217. https://doi.org/10.1097/00005053-197109000-00005 (Crossref)
  - Mulholland TB (1972). Occipital alpha revisited. *Psychological Bulletin* 78(3):176–182. https://doi.org/10.1037/h0032962 (Crossref)
  - Mulholland T (1968). Feedback electroencephalography. *Activitas Nervosa Superior* 10:410–438 (no DOI).
  - Strongest direct evidence for the "eyes-closed ceiling" point: Paskewitz DA, Orne MT (1973). Visual effects on alpha feedback training. *Science* 181:360–363 (not re-fetched). In total darkness over 6 sessions, subjects "do not appear to exceed their initial optimal baseline levels".
- **Claim check:** Supported. The Orne lab reviews describe apparent alpha gains as mainly disinhibition of visually or oculomotor-induced blocking: alpha "quadrupled" from a very low eyes-open start but did not exceed the eyes-closed baseline in darkness. Exceptions appeared under activation, not relaxation.
- **Grade:** A–B is fair. Kamiya and Hardt disputed the conclusion, so B is the safer choice.
- **Fix:** Change "Mulholland (1970s)" to "Mulholland (1968, 1972)" and add "Paskewitz and Orne (1973)" as the source for the eyes-closed-ceiling sentence.

## 9. Kamiya J (1960s / 1968 Psychology Today) (line 87)
- **Status:** CORRECT-METADATA
- **Citation:** Kamiya J (1968). Conscious control of brain waves. *Psychology Today* 1(11):56–60. The ISNR history article gives 1:56–61. The magazine piece is indexed in PsycEXTRA as https://doi.org/10.1037/e400092009-006 (Crossref).
- Better scholarly source: Kamiya J (1969). Operant control of the EEG alpha rhythm and some of its reported effects on consciousness. In C. T. Tart (Ed.), *Altered States of Consciousness*. New York: Wiley. Page ranges differ between sources (489–501 or 507–517).
- **Claim check:** Supported. "People can learn to raise alpha" is what Kamiya reported. Kamiya's first work was the 1962 WPA presentation on alpha discrimination.
- **Fix:** Write "Kamiya 1962, 1968, 1969" and add the 1968 and 1969 references.

## 10. DEAP dataset (Koelstra et al. 2012) (line 557)
- **Status:** CORRECT-METADATA
- **Citation:** Koelstra S, Mühl C, Soleymani M, Lee J-S, Yazdani A, Ebrahimi T, Pun T, Nijholt A, Patras I (2012). DEAP: a database for emotion analysis using physiological signals. *IEEE Transactions on Affective Computing* 3(1):18–31.
- **DOI:** https://doi.org/10.1109/T-AFFC.2011.15
- **Claim check:** Supported in general. The dataset has 32 participants who watched 40 one-minute music-video clips each, with 32-channel EEG plus peripheral signals. The paper reports single-trial classification of arousal, valence and liking at modest, near-60% binary accuracy. The exact per-class figures were not re-fetched (fetch budget). Poor cross-subject generalisation is a well-documented later finding, not a claim of the original paper.
- **Grade:** C is OK.
- **Fix:** Add the reference.

## 11. Davidson RJ: frontal asymmetry approach/withdrawal model (lines 323, 553)
- **Status:** CORRECT-METADATA
- **Citation:** Davidson RJ (1992). Anterior cerebral asymmetry and the nature of emotion. *Brain and Cognition* 20(1):125–151.
- **DOI:** https://doi.org/10.1016/0278-2626(92)90065-T (Crossref)
- **Claim check:** Supported. The model links relative left-frontal activity (less left alpha, i.e. more right alpha) with approach and positive affect, and right-frontal activity with withdrawal. The brief states the direction correctly.
- **Fix:** Replace "(Davidson;" with "(Davidson 1992;" and add the reference.

## 12. Penttonen M, Buzsáki G (2003): natural-log relationship between oscillators (line 415)
- **Status:** CORRECT-METADATA. The brief credits only Buzsáki and Draguhn 2004; the original proposal is Penttonen & Buzsáki 2003.
- **Citation:** Penttonen M, Buzsáki G (2003). Natural logarithmic relationship between brain oscillators. *Thalamus & Related Systems* 2(2):145–152.
- **DOI:** https://doi.org/10.1017/S1472928803000074
- **Claim check:** Partly. The paper says band centre frequencies form "an arithmetic progression on the natural logarithmic scale". That means a constant ratio between neighbouring bands, which in their scheme comes out near e. The abstract does not state the number e, so "ratio near e, about 2.72" is an interpretation of the scheme. It is the standard reading of Buzsáki & Draguhn 2004, Fig. 1. The brief's statement is acceptable.
- **Fix:** Change to "Penttonen and Buzsáki (2003; see also Buzsáki and Draguhn 2004) proposed that band centre frequencies are evenly spaced on a natural-log scale (successive ratio ≈ e)". Add the reference.

## 13. 2025 CNS poster "Strategies for neurofeedback success…" (line 104)
- **Status:** CORRECT-METADATA, and the claim overreaches
- **Citation:** McGowan M, Crilly A, Tang R, Tang Y-Y (2025). P194: Strategies for neurofeedback success: exploring the relationship between alpha power and mental effort. Poster, CNS*2025 (Organization for Computational Neurosciences annual meeting), Florence, 7 July 2025. This is the Computational Neuroscience meeting, not the Cognitive Neuroscience Society.
- **URL:** https://cns2025florence.sched.com/event/24uR0/p194-strategies-for-neurofeedback-success-exploring-the-relationship-between-alpha-power-and-mental-effort
- **Claim check:** Partly. N = 11 analysable participants did 10 sessions. The protocol rewarded **frontal-midline theta and SMR** and inhibited posterior beta; it was not an alpha protocol. Self-rated effort fell over training. Higher posterior parietal alpha was associated with lower effort (r = −0.64, p = .03). The poster is consistent with "effortless works better", but it is a tiny unreviewed poster, and it does not show that effortful strategies predict poorer success.
- **Grade:** D/C.
- **Fix:** Write "(see also McGowan et al. 2025, a small CNS*2025 poster, n = 11, in which lower reported effort went with higher posterior alpha)".

## 14. Claim: about 2–4% of people have aphantasia (Zeman; Dance et al. 2022) (line 178)
- **Status:** OK. The brief names no source; add the citations.
- **Citations:**
  - Dance CJ, Ipser A, Simner J (2022). The prevalence of aphantasia (imagery weakness) in the general population. *Consciousness and Cognition* 97:103243. https://doi.org/10.1016/j.concog.2021.103243
  - Zeman A, Dewar M, Della Sala S (2015). Lives without imagery: congenital aphantasia. *Cortex* 73:378–380. https://doi.org/10.1016/j.cortex.2015.05.019
- **Claim check:** Supported. Dance et al. found 3.9% of 1,004 people had aphantasia, and 0.8% had no imagery at all. "2–4%" is a fair range. "No voluntary imagery" fits the extreme subgroup better; the 3.9% includes people with very weak imagery.
- **Fix:** Write "About 2–4% have aphantasia (absent or near-absent voluntary imagery; Dance et al. 2022: 3.9%, 0.8% with none at all)".

## 15. Claim: about 10–15% of people are highly hypnotisable (line 260)
- **Status:** OK. The brief names no source; add one.
- **Source:** Terhune DB (2024). Hypnosis. *Open Encyclopedia of Cognitive Science*, MIT Press (https://oecs.mit.edu/pub/7rwgc0pr). It states "approximately 10 to 15% of the population being high responders", citing Laurence, Beaulieu-Prévost & du Chéné (2008), in Nash & Barnier (eds.), *Oxford Handbook of Hypnosis*.
- **Claim check:** Supported.
- **Fix:** Add the citation.

## 16. Claim: a later preregistered replication failed to replicate Kok et al. (2013) (lines 534–536)
- **Status:** CLAIM-WRONG (no such replication found)
- **Original:** Kok BE, Coffey KA, Cohn MA, Catalino LI, Vacharkulksemsuk T, Algoe SB, Brantley M, Fredrickson BL (2013). *Psychological Science* 24(7):1123–1132. https://doi.org/10.1177/0956797612470827
- **What actually exists:**
  - Heathers JAJ, Brown NJL, Coyne JC, Friedman HL (2015). The elusory upward spiral: a reanalysis of Kok et al. (2013). *Psychological Science* 26(7):1140–1143. https://doi.org/10.1177/0956797615572908 (DOI inferred from the APS page slug; not re-fetched). This is a reanalysis: the vagal-tone effect disappears under a log transform and correction for an unexplained drop in controls, and some HF-HRV values look implausible.
  - Nickerson CA (2018). Overstating the effects of loving-kindness meditation: comment on Kok et al. (2013). *Psychological Science* 29(3):463–466. https://doi.org/10.1177/0956797616682946 (Crossref)
  - Rebuttals: Kok BE et al. (2015), *Psychological Science* (PubMed 26025023), and Fredrickson BL, Kok BE (2018), *Psychological Science* 29(3):467–470, https://doi.org/10.1177/0956797617707319. Fredrickson and Kok state that "no direct or conceptual replications" had been published.
- **Searches tried:** standard and extended searches for a preregistered or failed replication of LKM → vagal tone. No preregistered replication was found.
- **Fix:** Write "A reported link to rising vagal tone (Kok et al. 2013) was challenged by independent reanalyses of the same data (Heathers et al. 2015; Nickerson 2018), and as of the authors' 2018 reply it had not been replicated, so treat the HRV claim as Grade C." Grade C stays.

## 17. Claim: Hove et al. (2016) is the shamanic drumming study (line 239; entry at line 710)
- **Status:** OK for the identity; the claim wording needs adjusting
- **Citation:** Hove MJ, Stelzer J, Nierhaus T, Thiel SD, Gundlach C, Margulies DS, Van Dijk KRA, Turner R, Keller PE, Merker B (2016). Brain network reconfiguration and perceptual decoupling during an absorptive state of consciousness. *Cerebral Cortex* 26(7):3116–3124.
- **DOI:** https://doi.org/10.1093/cercor/bhv137 (PubMed 26108612)
- **Claim check:** Partly. It is the shamanic drumming study: 15 experienced practitioners in fMRI, trance versus non-trance, while listening to rhythmic drumming. Trance increased hub centrality in the PCC, dACC and left insula, increased PCC coupling with control regions, and reduced auditory-pathway connectivity ("perceptual decoupling"). It was **fMRI only**, so it neither tested nor refuted EEG theta entrainment. The drum tempo (~4 Hz) was not confirmed on the pages fetched.
- **Fix:** Write "Hove et al. (2016, fMRI) found network reconfiguration and auditory decoupling during drumming-induced trance; EEG entrainment was not measured." Grade C stays. Add the DOI to the line-710 entry.
