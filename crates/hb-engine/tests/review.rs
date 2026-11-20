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
