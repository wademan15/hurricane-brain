//! Regression tests from the milestone review of November 2026. Each one fails on the code
//! as it stood before the review and states the number it guards.

mod common;
use common::*;
use hb_engine::fast::{DemodTracker, FastParams, TrackTarget, Tracker};
use hb_engine::m;
use hb_engine::prng::Rng;
use hb_engine::spectral::WindowAnalyzer;
use hb_engine::Params;

fn false_peak_rate(shape: &str, terms: usize, trials: usize, seed: u64) -> f64 {
    let mut p = Params::default();
    p.bg_curve_terms = terms;
    if terms == 2 {
        // The plain power law as it was: no lack-of-fit guard either.
        p.bg_lack_of_fit_max = 1e9;
    }
    let wa = WindowAnalyzer::new(p, RATE);
    let n = wa.window_len();
    let sh = bg_shape(shape);
    let mut rng = Rng::new(seed);
    let mut hits = 0;
    for _ in 0..trials {
        let x = synth_shape(n, sh.as_ref(), &[], 10.0, &mut rng);
        let xf: Vec<f32> = x.iter().map(|v| *v as f32).collect();
        let a = wa.analyse(&xf, &[50.0]);
        if !a.peaks.is_empty() {
            hits += 1;
        }
    }
    hits as f64 / trials as f64
}

/// Spec 6.3 and 10.3 test C: false peaks per window at or under alpha_peak on background-only
/// noise, including backgrounds that are not one power law. With the plain power-law
/// background the rates were 29 % (knee) and 12 % (noise floor) against a stated 1 %.
#[test]
fn false_peaks_stay_under_alpha_when_the_background_is_not_a_power_law() {
    let alpha = Params::default().alpha_peak;
    for shape in ["knee", "floor"] {
        let now = false_peak_rate(shape, Params::default().bg_curve_terms, 800, 4242);
        let before = false_peak_rate(shape, 2, 300, 4242);
        println!("{shape}: false peaks per window {now:.4} with the curved background, {before:.4} with a plain power law (alpha {alpha})");
        assert!(now <= alpha, "{shape}: false-peak rate {now} exceeds alpha_peak {alpha}");
        assert!(before > 2.0 * alpha, "{shape}: expected the plain power law to fail here ({before})");
    }
}

/// A filter edge inside the fitted range is the case the adopted quadratic does not fully
/// absorb (spec 6.2): 1.6 to 1.9 % per window against 5 to 11 % for the plain power law.
/// This pins the size of that known shortfall, and that a cubic removes it.
#[test]
fn filter_edges_inside_the_fitted_range_are_a_known_bounded_shortfall() {
    let alpha = Params::default().alpha_peak;
    for shape in ["lowpass", "highpass"] {
        let now = false_peak_rate(shape, Params::default().bg_curve_terms, 800, 4242);
        let cubic = false_peak_rate(shape, 4, 800, 4242);
        let before = false_peak_rate(shape, 2, 300, 4242);
        println!("{shape}: false peaks per window {now:.4} (default), {cubic:.4} (cubic), {before:.4} (plain power law); alpha {alpha}");
        assert!(now <= 3.0 * alpha, "{shape}: {now}");
        assert!(now < 0.5 * before, "{shape}: default {now} against {before} for the plain power law");
        assert!(cubic <= alpha, "{shape}: cubic {cubic}");
    }
}

/// The same through the whole engine: 1/f^2 background over a noise floor confirmed a track
/// in 14 % of frames (112 tracks born in 40 minutes), almost all below 3 Hz.
#[test]
fn a_noise_floor_does_not_create_tracks() {
    let n = (150.0 * RATE) as usize;
    let sh = bg_shape("floor");
    let mut frames_with_track = 0;
    let mut total = 0;
    for seed in 0..2u64 {
        let mut rng = Rng::new(1000 + seed);
        let ch: Vec<Vec<f64>> = (0..4).map(|_| synth_shape(n, sh.as_ref(), &[], 10.0, &mut rng)).collect();
        let (frames, e) = run(&ch, 1, &[]);
        for s in slow(&frames) {
            total += 1;
            if !s.tracks.is_empty() {
                frames_with_track += 1;
            }
            assert!(!s.states.phi.active && !s.states.octave.active);
        }
        let d = e.diagnostics();
        println!("seed {seed}: windows with a passing peak {}/{}", d.windows_with_passing_peak, d.windows_analysed);
    }
    println!("noise floor: frames with a confirmed track {frames_with_track}/{total}");
    assert_eq!(frames_with_track, 0);
}

/// A real rhythm still stands out over a curved background, and reads at the right place.
#[test]
fn rhythms_are_still_found_over_a_curved_background() {
    let n = (90.0 * RATE) as usize;
    let sh = bg_shape("floor");
    let rh = [Rhythm { f: 6.0, bw: 0.4, snr_db: 10.0 }, Rhythm { f: 10.0, bw: 0.4, snr_db: 10.0 }, Rhythm { f: 21.0, bw: 0.5, snr_db: 10.0 }];
    let mut rng = Rng::new(77);
    let ch: Vec<Vec<f64>> = (0..4).map(|_| synth_shape(n, sh.as_ref(), &rh, 12.0, &mut rng)).collect();
    let (frames, _) = run(&ch, 1, &[]);
    let s = slow(&frames);
    let last = s.last().unwrap();
    for r in &rh {
        let tr = track_near(last, r.f, 0.03 * r.f).unwrap_or_else(|| panic!("no track near {} Hz: {:?}", r.f, last.tracks.iter().map(|t| t.freq_integrated.v).collect::<Vec<_>>()));
        println!("planted {} Hz -> {:.3} +- {:.3}", r.f, tr.freq_integrated.v.unwrap(), tr.freq_integrated.se.unwrap());
    }
    assert_eq!(last.tracks.len(), 3, "extra tracks: {:?}", last.tracks.iter().map(|t| t.freq_integrated.v).collect::<Vec<_>>());
}

/// Spec 10.3, calibration: the reported standard error of the integrated frequency matches
/// the actual spread of errors within a factor 1.5 (here 1.6 on the dangerous side and 2 on
/// the safe side, to allow for 48 samples), for narrow and for broad rhythms. Before the review the actual error of rhythms 1 Hz wide
/// was 1.3 to 2.2 times the reported one (RMS z up to 2.6).
#[test]
fn integrated_frequency_error_is_calibrated() {
    let f0s = [5.3, 10.0, 19.0];
    for &bw in &[0.25, 1.0] {
        let mut errs: Vec<f64> = Vec::new();
        let mut ses: Vec<f64> = Vec::new();
        for seed in 0..8u64 {
            let rh: Vec<Rhythm> = f0s.iter().map(|&f| Rhythm { f, bw, snr_db: 10.0 }).collect();
            let ch = four((112.0 * RATE) as usize, 1.5, &rh, 12.0, 5000 + seed);
            let (frames, _) = run(&ch, 1, &[]);
            let s = slow(&frames);
            for &tt in &[60.0, 110.0] {
                let Some(sf) = s.iter().find(|f| (f.t - tt).abs() < 0.13) else { continue };
                for &f0 in &f0s {
                    if let Some(tr) = track_near(sf, f0, 2.0) {
                        errs.push(tr.freq_integrated.v.unwrap() - f0);
                        ses.push(tr.freq_integrated.se.unwrap());
                    }
                }
            }
        }
        let n = errs.len() as f64;
        let rms = (errs.iter().map(|e| e * e).sum::<f64>() / n).sqrt();
        let mut sorted = ses.clone();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let med = sorted[sorted.len() / 2];
        let z = (errs.iter().zip(ses.iter()).map(|(e, s)| (e / s) * (e / s)).sum::<f64>() / n).sqrt();
        println!("rhythm width {bw} Hz: n {n}, actual RMS error {rms:.3} Hz, median reported SE {med:.3} Hz, ratio {:.2}, RMS z {z:.2}", rms / med);
        assert!(n >= 30.0, "too few tracks found to judge: {n}");
        // Too small an error is the dangerous side (limit 1.6); too large is the safe side (limit 2).
        assert!(rms / med <= 1.6 && rms / med >= 0.5, "width {bw}: actual/reported = {:.2}", rms / med);
        assert!(z <= 1.6, "width {bw}: RMS z {z:.2}");
    }
}

/// Spec 7, null when weak: with no rhythm at all, a tracker told to follow 10 Hz must not
/// report a frequency most of the time. The floor is 1.73 background RMS amplitudes, which
/// background alone exceeds 5 % of the time; at the old floor of 1.0 it reported a frequency
/// in 31 % of frames.
#[test]
fn background_alone_rarely_passes_the_fast_amplitude_floor() {
    let p = Params::default();
    let fp = FastParams { rate: RATE, block: 8, delay_limit_s: p.fast_delay_limit_s, lost_lock_s: p.lost_lock_s, relock_s: p.fast_relock_s, lock_se: p.fast_lock_se, amp_floor: p.fast_amp_floor };
    let mut rng = Rng::new(9);
    let n = 256 * 120;
    let bg = synth(n, 1.5, &[], 10.0, &mut rng);
    let wa = WindowAnalyzer::new(p.clone(), RATE);
    let xf: Vec<f32> = bg[..wa.window_len()].iter().map(|v| *v as f32).collect();
    let bgpsd = wa.analyse(&xf, &[50.0]).bg_fit.unwrap().at(10.0);
    let tgt = TrackTarget { centre_hz: 10.0, se_hz: 0.1, width_hz: 1.0, bg_psd: bgpsd, cond_delay_s: 0.0 };
    let mut t = DemodTracker::new(fp, &tgt);
    let (mut valid, mut tot) = (0, 0);
    for (i, x) in bg.iter().enumerate() {
        t.push(*x, false);
        if (i + 1) % 8 == 0 {
            tot += 1;
            if t.read().freq.v.is_some() {
                valid += 1;
            }
        }
    }
    let frac = valid as f64 / tot as f64;
    println!("background only: fast frequency reported in {frac:.3} of frames");
    assert!(frac <= 0.10, "{frac}");
}

/// After gated input the tracker's filter still holds the zeros it was fed. Output resumes
/// only when what is left of them is under 2 % (four filter delays; at two it was 13 %).
#[test]
fn fast_amplitude_is_right_when_output_resumes_after_an_artifact() {
    let fp = FastParams { rate: RATE, block: 8, delay_limit_s: 0.3, lost_lock_s: 1.0, relock_s: 0.25, lock_se: 3.0, amp_floor: 1.73 };
    let tgt = TrackTarget { centre_hz: 10.0, se_hz: 0.05, width_hz: 1.0, bg_psd: 0.01, cond_delay_s: 0.0 };
    let mut t = DemodTracker::new(fp, &tgt);
    let mut first_after: Option<f64> = None;
    for n in 0..(256 * 8) {
        let x = 20.0 * m::sin(m::TAU * 10.0 * n as f64 / 256.0);
        let gated = (256 * 4..256 * 5).contains(&n);
        t.push(x, gated);
        if (n + 1) % 8 == 0 {
            let r = t.read();
            if n >= 256 * 5 && first_after.is_none() {
                if let Some(a) = r.amp_uv.v {
                    first_after = Some(a);
                    println!("first amplitude after the artifact: {a:.2} uV at {:.3} s after it ended", (n + 1) as f64 / 256.0 - 5.0);
                    assert!((n + 1) as f64 / 256.0 - 5.0 <= 3.0, "recovery later than 3 s (spec 10.3 test E)");
                }
            }
        }
    }
    let a = first_after.expect("output resumed");
    assert!((a - 20.0).abs() <= 0.05 * 20.0, "amplitude {a} uV when output resumed, true 20");
}

/// Spec 6.6: a strictly periodic waveform is one rhythm with harmonics. A 4 Hz train of
/// 40 uV pulses on the forehead, too small to gate, has lines at 4 and 8 Hz locked at exactly
/// 2:1. Before the review the harmonic test compared the locking with time-shifted copies
/// only; a periodic waveform is its own shifted copy, so the excess was nil, the pair was
/// not flagged, and the octave state was on in 513 of 720 frames.
#[test]
fn a_periodic_waveform_is_a_harmonic_not_an_octave() {
    let secs = 150.0;
    let n = (secs * RATE) as usize;
    let mut ch = four(n, 1.5, &[Rhythm { f: 10.0, bw: 0.4, snr_db: 10.0 }], 10.0, 300);
    let (period, dur, amp) = (0.25, 0.25, 40.0);
    let len = (dur * RATE) as usize;
    let mut t = 0.1;
    while t + dur < secs {
        let i0 = (t * RATE) as usize;
        for k in 0..len {
            let v = amp * m::sin(m::PI * k as f64 / len as f64);
            ch[1][i0 + k] += v;
            ch[2][i0 + k] += v;
            ch[0][i0 + k] += 0.1 * v;
            ch[3][i0 + k] += 0.1 * v;
        }
        t += period;
    }
    let (frames, _) = run(&ch, 1, &[]);
    let s = slow(&frames);
    let both: Vec<_> = s.iter().filter(|f| track_near(f, 4.0, 0.3).is_some() && track_near(f, 8.0, 0.4).is_some()).collect();
    let flagged = both.iter().filter(|f| f.tracks.iter().any(|t| t.harmonic_of.is_some())).count();
    let octave_step = s.iter().filter(|f| f.cascades.octave.steps >= 1).count();
    let octave_on = s.iter().filter(|f| f.states.octave.active).count();
    println!("frames {}; 4 and 8 Hz both tracked {}; flagged harmonic {flagged}; octave step {octave_step}; octave state {octave_on}", s.len(), both.len());
    assert!(both.len() > 100, "the test needs both lines tracked ({})", both.len());
    assert!(flagged as f64 >= 0.95 * both.len() as f64, "flagged {flagged} of {}", both.len());
    assert_eq!(octave_on, 0);
    assert!(octave_step as f64 <= 0.02 * s.len() as f64, "octave step credited in {octave_step} frames");
}

// ---------------------------------------------------------------------------------------------
// Second part: the whole-app fake test and the bake-off (November 2026).
// ---------------------------------------------------------------------------------------------

use hb_engine::ratios::{self, chain_stat, Baselines, NullDist, NullDraw, ScoreCtx, ScoreTrack};
use hb_engine::types::{EegStream, EngineConfig, Frame, ParamValue, StreamDescription};
use hb_engine::Engine;
use std::collections::BTreeSet;

fn tracks_at(fs: &[f64], rel_se: f64) -> Vec<ScoreTrack> {
    fs.iter().enumerate().map(|(i, &f)| ScoreTrack { id: i as u32 + 1, f, se: rel_se * f }).collect()
}

/// Spec 8.4: a longer cascade must not be harder to recognise than a shorter one. With the
/// best single pair as the statistic, a five-member cascade among seven tracks scored 3.66
/// against a chance threshold of 3.90 and never entered the state, while a three-member
/// cascade (threshold 1.9) did. The statistic is now the total evidence along the best chain.
#[test]
fn a_longer_cascade_scores_higher_and_beats_its_own_chance_threshold() {
    let pd = Params::default();
    let (h, b) = (BTreeSet::new(), Baselines::new());
    let ctx = ScoreCtx::new(&pd, &h, &b);
    let g = phi();
    let mut prev = 0.0;
    for members in 2..=5usize {
        // A cascade from 3.4 Hz, every member 0.3 % off its place, plus two unrelated tracks.
        let mut fs: Vec<f64> = (0..members).map(|k| 3.4 * m::pow(g, k as f64) * (1.0 + 0.003 * if k % 2 == 0 { 1.0 } else { -1.0 })).collect();
        fs.push(11.3);
        fs.push(27.9);
        fs.sort_by(|a, b| a.total_cmp(b));
        let tr = tracks_at(&fs, 0.004);
        let sc = ratios::score_set(&tr, &ctx);
        let stat = sc.stat[0].unwrap();
        let mut rng = Rng::new(7);
        let null = ratios::chance_a(&tr, &ctx, &mut rng);
        let thr = ratios::static_threshold(&null[0], &pd).unwrap().max(pd.state_min_evidence);
        println!("{members} members among {} tracks: steps {}, statistic {stat:.2}, chance A threshold {thr:.2}", tr.len(), sc.cascades[0].steps);
        assert_eq!(sc.cascades[0].steps, members - 1);
        assert!(stat > prev + 2.0, "statistic {stat} does not grow with the cascade ({prev})");
        if members >= 3 {
            assert!(stat > thr + 1.0, "{members} members: statistic {stat} against threshold {thr}");
        }
        prev = stat;
    }
    // One pair is one pair: the chain statistic of two tracks is that pair's log evidence.
    let two = tracks_at(&[6.0, 6.0 * g], 0.004);
    let sc = ratios::score_set(&two, &ctx);
    assert_eq!(sc.stat[0].ok(), sc.pairs[0].log_ev[0]);
    assert_eq!(chain_stat(3, |i, j| if (i, j) == (0, 2) { Some(-5.0) } else { None }), Some(-5.0));
    assert_eq!(chain_stat(3, |_, _| None), None);
    assert_eq!(chain_stat(3, |i, j| Some(if j == i + 1 { 3.0 } else { 1.0 })), Some(6.0));
}

/// Spec 8.4: "closer to the target than chance" is not alignment. A theta and a beta track
/// three times apart are nowhere near the golden ratio; the chance threshold for such a pair
/// is hundreds of nats below zero, and the state used to switch on whenever the pair was less
/// far off than most surrogates. The threshold now never goes below `state_min_evidence`.
#[test]
fn the_state_needs_evidence_for_the_target_not_only_less_evidence_against_it() {
    let n = (120.0 * RATE) as usize;
    let rh = [Rhythm { f: 4.45, bw: 0.25, snr_db: 12.0 }, Rhythm { f: 17.4, bw: 0.4, snr_db: 12.0 }];
    let ch = four(n, 1.5, &rh, 10.0, 91);
    let (frames, _) = run(&ch, 1, &[]);
    let s = slow(&frames);
    let floor = Params::default().state_min_evidence;
    let mut scored = 0;
    for f in &s {
        assert!(!f.states.phi.active && !f.states.octave.active && !f.states.both.active, "state on at {}", f.t);
        for st in [&f.states.phi, &f.states.octave] {
            if let Some(e) = st.enter_at {
                assert!(e >= floor, "entry threshold {e} below the floor");
                scored += 1;
            }
        }
    }
    assert!(scored > 100, "the pair was never scored ({scored})");
}

/// Spec 8.5: excess alignment is zero unless the percentile is at or under `excess_level`.
/// It used to be measured from the mean surrogate closeness and read 0.96 beside p = 0.4.
#[test]
fn excess_is_zero_unless_the_percentile_is_small() {
    // 200 surrogates: 60 with one aligned step (closeness spread over 0.61 to 1), the rest none.
    let mut d = NullDist::default();
    for i in 0..200usize {
        d.draws.push(if i < 60 { NullDraw { steps: 1, closeness: Some(0.61 + 0.39 * i as f64 / 59.0), stat: Some(1.0) } } else { NullDraw { steps: 0, closeness: Some(0.1), stat: Some(-5.0) } });
    }
    let level = 0.05;
    for &(steps, c) in &[(1usize, 0.7), (1, 0.9), (1, 0.96), (1, 0.999), (0, 0.5), (2, 0.8)] {
        let lv = d.level(steps, Some(c));
        let p = lv.p.v.unwrap();
        let (ex, reference) = d.excess(steps, c, level).unwrap();
        println!("steps {steps} closeness {c}: p {p:.3}, reference {reference:.3}, excess {ex:.3}");
        if p > level {
            assert_eq!(ex, 0.0, "excess {ex} beside p {p}");
        }
        if ex > 0.0 {
            assert!(p <= level, "excess {ex} beside p {p}");
        }
    }
    // A two-step cascade where chance never makes one: the whole closeness is excess.
    assert_eq!(d.excess(2, 0.8, level).unwrap().0, 0.8);
    // The old definition on the 0.9 case, (0.9 - mean) / (1 - mean) with mean about 0.31, read
    // 0.86 beside p = 0.085.
    assert_eq!(d.excess(1, 0.9, level).unwrap().0, 0.0);
}

/// Frame contract: a fifth target, 3:1, scored like the controls and never part of a cascade
/// or state; and the combined state, on only while both states are on.
#[test]
fn ratio_3_is_scored_and_the_combined_state_needs_both() {
    let pd = Params::default();
    let (h, b) = (BTreeSet::new(), Baselines::new());
    let ctx = ScoreCtx::new(&pd, &h, &b);
    let sc = ratios::score_set(&tracks_at(&[5.0, 15.03], 0.003), &ctx);
    let i3 = ratios::target_index(hb_engine::types::Target::Ratio3);
    assert!(sc.pairs[0].aligned[i3] && sc.pairs[0].closeness[i3].unwrap() > 0.9);
    assert!(!sc.pairs[0].aligned[0] && !sc.pairs[0].aligned[1]);
    assert_eq!(sc.cascades[0].steps + sc.cascades[1].steps, 0);

    // A golden ratio cascade (4, 6.47, 10.47 Hz) and an octave cascade (13.5, 27 Hz... with 6.75
    // absent, so 13.5 and 27) in one recording.
    let g = phi();
    let n = (150.0 * RATE) as usize;
    let rh = [
        Rhythm { f: 4.0, bw: 0.25, snr_db: 13.0 },
        Rhythm { f: 4.0 * g, bw: 0.25, snr_db: 13.0 },
        Rhythm { f: 4.0 * g * g, bw: 0.25, snr_db: 13.0 },
        Rhythm { f: 15.0, bw: 0.3, snr_db: 13.0 },
        Rhythm { f: 30.0, bw: 0.3, snr_db: 13.0 },
    ];
    let ch = four(n, 1.5, &rh, 12.0, 5);
    let (frames, _) = run(&ch, 1, &[]);
    let s = slow(&frames);
    let (mut both, mut phi_on, mut oct_on) = (0, 0, 0);
    let mut prev: Option<(bool, f64)> = None;
    for f in &s {
        let st = &f.states;
        assert_eq!(st.both.active, st.phi.active && st.octave.active, "combined state is not the conjunction at {}", f.t);
        if let Some((was, for_s)) = prev {
            if was == st.both.active {
                assert!(st.both.for_s > for_s, "for_s does not count up");
            } else {
                assert_eq!(st.both.for_s, 0.0);
            }
        }
        prev = Some((st.both.active, st.both.for_s));
        both += st.both.active as usize;
        phi_on += st.phi.active as usize;
        oct_on += st.octave.active as usize;
        for pr in &f.pairs {
            let _ = &pr.targets.ratio_3;
        }
    }
    println!("frames {}: golden ratio state {phi_on}, octave state {oct_on}, both {both}", s.len());
    assert!(phi_on > 100 && oct_on > 100 && both > 100);
    let json = serde_json::to_string(s.last().unwrap()).unwrap();
    assert!(json.contains("\"both\":{\"active\":") && json.contains("\"ratio_3\":{") && json.contains("\"bands_fixed\":{"));
}

fn harmonic_recording(secs: f64, seed: u64) -> Vec<Vec<f64>> {
    // An 8 Hz rhythm whose frequency wanders, with harmonics at 2 and 3 times its phase, in a
    // 1/f background: one waveform, three spectral bumps.
    let n = (secs * RATE) as usize;
    let mut out = four(n, 1.8, &[], 8.0, seed);
    let mut rng = Rng::new(seed ^ 0x5eed);
    let (mut ph, mut df) = (0.0f64, 0.0f64);
    for i in 0..n {
        df += -df / (1.5 * RATE) + 0.6 * m::sqrt(2.0 / (1.5 * RATE)) * rng.normal();
        ph += m::TAU * (8.0 + df) / RATE;
        let v = 9.0 * (m::sin(ph) + 0.5 * m::sin(2.0 * ph + 0.7) + 0.35 * m::sin(3.0 * ph + 0.2));
        for c in out.iter_mut() {
            c[i] += v;
        }
    }
    out
}

/// Spec 6.6 and 10.3 D: the harmonic mark holds. On the lab's harmonic recording the mark on
/// the 16 Hz track lapsed whenever one window's locking fell under 0.7 (it sat at 0.4 to 0.6
/// against 0.2 for the shifted copies), and the pair was then credited as an octave step in
/// 173 of 360 frames and as the octave state in 44. The mark is now decided from the pair's
/// history, a pair in a harmonic's band is kept out of scoring until it has been tested, and
/// two harmonics of one fundamental are not a 1.5 pair.
#[test]
fn the_harmonic_mark_is_stable_and_no_octave_is_credited() {
    let (mut frames_n, mut both_tracked, mut marked, mut oct_step, mut oct_state, mut c15) = (0, 0, 0, 0, 0, 0);
    for seed in [3u64, 4] {
        let ch = harmonic_recording(120.0, seed);
        let (frames, _) = run(&ch, 1, &[]);
        for f in slow(&frames) {
            frames_n += 1;
            let lo = track_near(f, 8.0, 0.6);
            let hi = track_near(f, 16.0, 1.2);
            if let (Some(lo), Some(hi)) = (lo, hi) {
                both_tracked += 1;
                if hi.harmonic_of.is_some_and(|h| h.id == lo.id && h.n == 2) {
                    marked += 1;
                }
            }
            oct_step += (f.cascades.octave.steps >= 1) as usize;
            oct_state += f.states.octave.active as usize;
            c15 += f.pairs.iter().filter(|p| p.targets.control_1_5.aligned).count();
        }
    }
    println!("frames {frames_n}; 8 and 16 Hz both tracked {both_tracked}; 16 Hz marked harmonic {marked}; octave step {oct_step}; octave state {oct_state}; 1.5 pairs aligned {c15}");
    assert!(both_tracked > 300);
    assert!(marked as f64 >= 0.95 * both_tracked as f64, "marked {marked} of {both_tracked}");
    assert_eq!(oct_state, 0);
    assert_eq!(oct_step, 0, "octave step credited to a harmonic");
}

/// Two independent rhythms an octave apart are not a harmonic: the history test must not
/// take the octave away (the cost of the rule above, kept small).
#[test]
fn an_independent_octave_pair_keeps_its_octave() {
    let n = (150.0 * RATE) as usize;
    let (mut total, mut flagged, mut step) = (0, 0, 0);
    for seed in 0..4u64 {
        let ch = four(n, 1.5, &[Rhythm { f: 10.0, bw: 0.3, snr_db: 12.0 }, Rhythm { f: 20.0, bw: 0.4, snr_db: 12.0 }], 10.0, 700 + seed);
        let (frames, _) = run(&ch, 1, &[]);
        for f in slow(&frames).iter().filter(|f| f.t > 40.0) {
            total += 1;
            flagged += f.tracks.iter().any(|t| t.harmonic_of.is_some()) as usize;
            step += (f.cascades.octave.steps >= 1) as usize;
        }
    }
    println!("independent 10 and 20 Hz: frames {total}, harmonic mark in {flagged}, octave step in {step}");
    assert!(flagged as f64 <= 0.10 * total as f64, "marked harmonic in {flagged} of {total}");
    assert!(step as f64 >= 0.85 * total as f64, "octave step in {step} of {total}");
}

fn push_all(e: &mut Engine, ch: &[Vec<f64>], lost: &dyn Fn(usize) -> bool, as_nan: bool) -> Vec<Frame> {
    // Packets of 12 samples; a lost packet is either skipped (index jump) or sent as NaN rows.
    let n = ch[0].len();
    let mut frames = Vec::new();
    let mut i = 0;
    let mut pk = 0;
    while i + 12 <= n {
        let mut buf = Vec::with_capacity(48);
        for k in i..i + 12 {
            for c in ch {
                buf.push(if lost(pk) && as_nan { f32::NAN } else { c[k] as f32 });
            }
        }
        if !lost(pk) || as_nan {
            e.push_eeg(i as u64, &buf);
        }
        frames.extend(e.drain());
        i += 12;
        pk += 1;
    }
    frames
}

/// Spec 3 and 10.3 G: 1 % packet loss. A lost 12-sample packet is repaired whether it arrives
/// as a jump in the sample index or as rows of NaN, and the two give identical frames. Fed as
/// NaN rows (the lab fixtures), the engine used to void every window that held one: 67 % of
/// site-windows null with reason "gap", 24 confirmed track-windows against 210.
#[test]
fn one_percent_packet_loss_is_repaired_either_way() {
    let n = (100.0 * RATE) as usize;
    let g = phi();
    let rh = [Rhythm { f: 6.0, bw: 0.3, snr_db: 12.0 }, Rhythm { f: 6.0 * g, bw: 0.3, snr_db: 12.0 }];
    let ch = four(n, 1.5, &rh, 10.0, 33);
    let mut rng = Rng::new(99);
    let lost_set: BTreeSet<usize> = (1..n / 12).filter(|_| rng.uniform(0.0, 1.0) < 0.01).collect();
    println!("{} of {} packets lost", lost_set.len(), n / 12);
    let lost = |pk: usize| lost_set.contains(&pk);
    let run_with = |as_nan: bool, any: bool| {
        let mut e = Engine::new(config(1, &[])).unwrap();
        let none = |_: usize| false;
        let frames = push_all(&mut e, &ch, if any { &lost } else { &none }, as_nan);
        (frames, e.diagnostics().repaired_samples)
    };
    let (clean, _) = run_with(false, false);
    let (jump, rep_j) = run_with(false, true);
    let (nan, rep_n) = run_with(true, true);
    // A single lost packet is repaired; two in a row (24 samples) are over the limit and voided.
    let single = lost_set.iter().filter(|&&k| !lost_set.contains(&(k + 1)) && (k == 0 || !lost_set.contains(&(k - 1)))).count();
    assert!(single >= 15);
    assert_eq!(rep_j, 12 * single as u64);
    assert_eq!(rep_n, rep_j);
    assert_eq!(to_jsonl(&jump), to_jsonl(&nan), "NaN rows and index jumps must give the same frames");
    let count = |fr: &[Frame]| {
        let s = slow(fr);
        let null = s.iter().filter(|f| f.t > 10.0 && f.spectra.iter().all(|sp| sp.why != hb_engine::types::Reason::Ok)).count();
        let both = s.iter().filter(|f| track_near(f, 6.0, 0.3).is_some() && track_near(f, 6.0 * g, 0.4).is_some()).count();
        (s.len(), null, both)
    };
    let (nc, null_c, both_c) = count(&clean);
    let (_, null_l, both_l) = count(&nan);
    println!("clean: {nc} frames, {null_c} without a spectrum, both rhythms tracked in {both_c}; 1 % loss: {null_l} and {both_l}");
    // Two packets lost in a row cannot be repaired, and the windows that hold that hole give
    // no spectrum (8 s each time; it happens about once in 8 minutes at 1 % loss). Here there
    // are two such holes. Everything else must come through.
    assert!(null_l <= null_c + 40, "windows voided under 1 % loss: {null_l}");
    assert!(both_l as f64 >= 0.8 * both_c as f64, "tracks lost under 1 % loss: {both_l} against {both_c}");
}

/// Spec 6.5: a rhythm that fades for a few seconds and returns is the same track. Its
/// integrated frequency keeps the estimates from before the pause, so the pair is resolved
/// again at once and the id does not change.
#[test]
fn a_rhythm_that_pauses_and_returns_keeps_its_track() {
    let secs = 120.0;
    let n = (secs * RATE) as usize;
    let steady = four(n, 1.5, &[Rhythm { f: 10.0, bw: 0.3, snr_db: 12.0 }], 10.0, 55);
    let burst = four(n, 1.5, &[Rhythm { f: 6.2, bw: 0.25, snr_db: 13.0 }], 10.0, 56);
    let bg = four(n, 1.5, &[], 10.0, 57);
    // The 6.2 Hz rhythm is absent from 60 to 72 s.
    let ch: Vec<Vec<f64>> = (0..4)
        .map(|c| (0..n).map(|i| {
            let t = i as f64 / RATE;
            let off = (60.0..72.0).contains(&t);
            steady[c][i] + if off { bg[c][i] } else { burst[c][i] }
        }).collect())
        .collect();
    let (frames, e) = run(&ch, 1, &[]);
    let s = slow(&frames);
    let ids: BTreeSet<u32> = s.iter().filter_map(|f| track_near(f, 6.2, 0.4).map(|t| t.id)).collect();
    let gone = s.iter().filter(|f| f.t > 64.0 && f.t < 72.0 && track_near(f, 6.2, 0.4).is_none()).count();
    let resumed = e.diagnostics().events.iter().filter(|ev| matches!(ev, hb_engine::TrackEvent::Resumed { .. })).count();
    println!("ids used by the 6.2 Hz rhythm: {ids:?}; frames without it during the pause: {gone}; resumed events: {resumed}");
    assert!(gone > 8, "the track should be absent while the rhythm is (measured or null)");
    assert_eq!(ids.len(), 1, "the returning rhythm got a new id");
    assert!(resumed >= 1);
    // With `track_resume_s` 0 the old behaviour: a new track.
    let (frames, _) = run(&ch, 1, &[("track_resume_s", ParamValue::Num(0.0))]);
    let ids0: BTreeSet<u32> = slow(&frames).iter().filter_map(|f| track_near(f, 6.2, 0.4).map(|t| t.id)).collect();
    assert!(ids0.len() >= 2);
}

/// Spec 8.5 and 15: chance B becomes available inside a three-minute session, and the history
/// it needs follows the integration time. Presets are valid parameter sets.
#[test]
fn chance_b_is_available_in_a_three_minute_session_and_presets_are_valid() {
    let pd = Params::default();
    assert!((pd.chance_b_need_s() - 114.0).abs() < 1e-9);
    for name in Params::PRESETS {
        let over = Params::preset(name).unwrap();
        let p = Params::from_overrides(Some(&over)).unwrap_or_else(|e| panic!("preset {name}: {e}"));
        println!("preset {name}: {over:?}; chance B history {} s", p.chance_b_need_s());
    }
    assert!(Params::preset("nonsense").is_none());
    let quick = Params::from_overrides(Some(&Params::preset("quicker").unwrap())).unwrap();
    assert!(quick.chance_b_need_s() < pd.chance_b_need_s());

    let n = (180.0 * RATE) as usize;
    let g = phi();
    let rh = [Rhythm { f: 6.0, bw: 0.3, snr_db: 12.0 }, Rhythm { f: 6.0 * g, bw: 0.3, snr_db: 12.0 }, Rhythm { f: 21.0, bw: 0.4, snr_db: 12.0 }];
    let ch = four(n, 1.5, &rh, 10.0, 12);
    let (frames, _) = run(&ch, 1, &[]);
    let s = slow(&frames);
    let first_b = s.iter().find(|f| f.cascades.phi.chance.b.closeness.v.is_some()).map(|f| f.t);
    println!("chance B first available at {first_b:?} s");
    let t = first_b.expect("chance B never became available in 180 s");
    assert!(t < 150.0, "chance B first available at {t} s");
    for f in &s {
        // Both excess values are always there: a number, or null with a reason.
        for c in [&f.cascades.phi, &f.cascades.octave] {
            for ex in [&c.excess_a, &c.excess_b] {
                assert!(ex.v.is_some() || ex.why != hb_engine::types::Reason::Ok);
            }
        }
    }
    let _ = (EegStream { channels: vec![], rate_hz: 256.0, bits: 0, model: String::new() }, StreamDescription::default(), EngineConfig { streams: StreamDescription::default(), params: None, seed: 0, mains_hz: None });
}
