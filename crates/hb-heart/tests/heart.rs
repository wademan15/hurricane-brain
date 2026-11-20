mod common;

use common::*;
use hb_heart::{HeartFrame, HeartSource, Reason};

fn last_ok(frames: &[HeartFrame]) -> &HeartFrame {
    frames.last().expect("no frames")
}

/// Straightforward reference: RMSSD over all successive differences, SDNN (n-1) over all intervals.
fn reference(ibis: &[f64]) -> (f64, f64) {
    let d2: Vec<f64> = ibis.windows(2).map(|w| (w[1] - w[0]).powi(2)).collect();
    let rmssd = (d2.iter().sum::<f64>() / d2.len() as f64).sqrt();
    let m = ibis.iter().sum::<f64>() / ibis.len() as f64;
    let sdnn = (ibis.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (ibis.len() - 1) as f64).sqrt();
    (rmssd, sdnn)
}

#[test]
fn rmssd_sdnn_match_reference() {
    for seed in 1..=5u64 {
        let ibis = rr_series(seed, 90.0, 850.0, 0.0, 0.1, 25.0);
        let beats = beats_from_ibis(0.0, &ibis);
        let mut e = engine(seed);
        deliver_rr(&mut e, &beats, seed, 0.3, &[]);
        let frames = e.drain();
        check_null_contract(&frames);
        let f = last_ok(&frames);
        // Beats as the engine placed them, accumulated from all frames.
        let all: Vec<_> = frames.iter().flat_map(|f| f.beats.iter().copied()).collect();
        assert_eq!(all.len(), ibis.len(), "every interval becomes one beat");
        for (b, i) in all.iter().zip(&ibis) {
            assert_eq!(b.ibi_ms, *i as f32 as f64, "interval passed through unchanged");
            assert!(!b.flagged, "clean series has no flags");
        }
        let win: Vec<f64> = all.iter().filter(|b| b.t > f.t - 60.0 && b.t <= f.t).map(|b| b.ibi_ms).collect();
        let (r_ref, s_ref) = reference(&win);
        let r = f.rmssd_ms.v.unwrap();
        let s = f.sdnn_ms.v.unwrap();
        println!("seed {seed}: rmssd engine {r:.6} ref {r_ref:.6}; sdnn engine {s:.6} ref {s_ref:.6}; n {}", win.len());
        assert!((r - r_ref).abs() < 1e-9 * r_ref, "rmssd {r} vs {r_ref}");
        assert!((s - s_ref).abs() < 1e-9 * s_ref, "sdnn {s} vs {s_ref}");
        // And against the true beat times (independent of the strap clock reconstruction).
        let truth: Vec<f64> = beats.iter().filter(|b| b.0 > f.t - 60.0 && b.0 <= f.t).map(|b| b.1).collect();
        let (r_t, s_t) = reference(&truth);
        assert!((r - r_t).abs() / r_t < 0.05, "rmssd {r} vs truth-window {r_t}");
        assert!((s - s_t).abs() / s_t < 0.05, "sdnn {s} vs truth-window {s_t}");
        assert_eq!(f.source, HeartSource::ChestStrap);
        let hr = f.hr_bpm.v.unwrap();
        assert!((hr - 60000.0 / 850.0).abs() < 5.0, "hr {hr}");
    }
}

#[test]
fn thirty_second_window_option() {
    let ibis = rr_series(9, 50.0, 800.0, 0.0, 0.1, 20.0);
    let beats = beats_from_ibis(0.0, &ibis);
    let mut e = hb_heart::HeartEngine::new(hb_heart::HeartConfig {
        seed: 9,
        params: hb_heart::HeartParams { hrv_window_s: 30.0, ..Default::default() },
    });
    deliver_rr(&mut e, &beats, 9, 0.2, &[]);
    let frames = e.drain();
    let f = last_ok(&frames);
    let all: Vec<_> = frames.iter().flat_map(|f| f.beats.iter().copied()).collect();
    let win: Vec<f64> = all.iter().filter(|b| b.t > f.t - 30.0 && b.t <= f.t).map(|b| b.ibi_ms).collect();
    let (r_ref, _) = reference(&win);
    assert!((f.rmssd_ms.v.unwrap() - r_ref).abs() < 1e-9 * r_ref);
    // Before 27 s (0.9 x 30) of data the value is warming up.
    let early = frames.iter().find(|f| f.t > 5.0).unwrap();
    assert_eq!(early.rmssd_ms.why, Reason::WarmingUp);
}

#[test]
fn resonance_breathing_at_six_per_minute() {
    let ibis = rr_series(3, 200.0, 900.0, 60.0, 0.1, 8.0);
    let beats = beats_from_ibis(0.0, &ibis);
    let mut e = engine(3);
    e.set_pacer(Some(6.0));
    deliver_rr(&mut e, &beats, 3, 0.3, &[]);
    let frames = e.drain();
    check_null_contract(&frames);
    let f = last_ok(&frames);
    let rf = f.resonance_hz.v.unwrap();
    let rs = f.resonance_strength.v.unwrap();
    let br = f.breath_bpm.v.unwrap();
    let pa = f.pacer_adherence.v.unwrap();
    println!(
        "resonance {rf:.4} Hz (se {:?}), strength {rs:.3}, breath {br:.3}/min (se {:?}), phase {:?}, adherence {pa:.3}, lf {:.0} hf {:.0}",
        f.resonance_hz.se, f.breath_bpm.se, f.breath_phase.v, f.lf_power.v.unwrap(), f.hf_power.v.unwrap()
    );
    assert!((rf - 0.1).abs() < 0.005, "resonance {rf}");
    assert!(rs > 0.8, "strength {rs}");
    assert!((br - 6.0).abs() < 0.3, "breath {br}");
    assert!(pa > 0.9, "adherence {pa}");
    assert!(f.lf_power.v.unwrap() > 5.0 * f.hf_power.v.unwrap());
    // Expected LF power: amplitude 60 ms sinusoid -> 1800 ms^2.
    let lf = f.lf_power.v.unwrap();
    assert!((lf - 1800.0).abs() / 1800.0 < 0.15, "lf {lf}");

    // Breath phase: phase 0 is the heart-rate maximum = interval minimum. The generator gives
    // an interval the value 900 + 60 sin(2 pi 0.1 t) at its start t; the engine (by the usual
    // convention) places an interval at the beat that ends it, about 0.84 s later at the minimum.
    // So the minimum on the beat-time axis is at 0.1 (t - 0.84) = 0.75 mod 1.
    let mut errs = Vec::new();
    for f in frames.iter().filter(|f| f.t > 150.0 && f.breath_phase.v.is_some()) {
        let expected = hb_heart::dsp::wrap_pi(2.0 * std::f64::consts::PI * (0.1 * (f.t - 0.84) - 0.75));
        errs.push(hb_heart::dsp::wrap_pi(f.breath_phase.v.unwrap() - expected).abs());
    }
    let max_err = errs.iter().cloned().fold(0.0, f64::max);
    println!("breath phase: {} frames, max error {max_err:.3} rad", errs.len());
    assert!(errs.len() > 50 && max_err < 0.35, "phase error {max_err}");

    // A pacer at a different rate gets low adherence on the same data.
    let mut e2 = engine(3);
    e2.set_pacer(Some(12.0));
    deliver_rr(&mut e2, &beats, 3, 0.3, &[]);
    let pa2 = e2.drain().last().unwrap().pacer_adherence.v.unwrap();
    println!("adherence to a 12/min pacer: {pa2:.3}");
    assert!(pa2 < 0.1, "adherence {pa2}");
}

#[test]
fn no_clear_breathing_peak_is_null() {
    // White-ish interval noise, no rhythm.
    let ibis = rr_series(4, 200.0, 850.0, 0.0, 0.1, 30.0);
    let mut e = engine(4);
    deliver_rr(&mut e, &beats_from_ibis(0.0, &ibis), 4, 0.3, &[]);
    let frames = e.drain();
    check_null_contract(&frames);
    let late: Vec<_> = frames.iter().filter(|f| f.t > 130.0).collect();
    let nulls = late.iter().filter(|f| f.breath_bpm.v.is_none()).count();
    println!("breath null in {nulls} of {} late frames for rhythm-free data", late.len());
    assert!(nulls as f64 > 0.9 * late.len() as f64);
    assert!(late.iter().filter(|f| f.breath_bpm.v.is_none()).all(|f| f.breath_bpm.why == Reason::NotConfirmed));
}

#[test]
fn missed_and_extra_beats_are_flagged_and_do_not_corrupt_rmssd() {
    let ibis = rr_series(5, 200.0, 850.0, 0.0, 0.1, 20.0);
    let mut bad = ibis.clone();
    // Ectopic first (later indices shift after the splices): premature beat then compensatory pause.
    let (a, b) = (bad[210], bad[211]);
    bad[210] = a - 250.0;
    bad[211] = b + 250.0;
    // Extra beat at index 135: one interval split 40/60.
    let x = bad[135];
    bad.splice(135..136, [0.4 * x, 0.6 * x]);
    // Missed beat at index 60: two intervals merged.
    let merged = bad[60] + bad[61];
    bad.splice(60..62, [merged]);

    let mut e_clean = engine(5);
    deliver_rr(&mut e_clean, &beats_from_ibis(0.0, &ibis), 5, 0.3, &[]);
    let fc = e_clean.drain();
    let mut e_bad = engine(5);
    deliver_rr(&mut e_bad, &beats_from_ibis(0.0, &bad), 5, 0.3, &[]);
    let fb = e_bad.drain();
    check_null_contract(&fb);

    let flagged: Vec<_> = fb.iter().flat_map(|f| f.beats.iter()).filter(|b| b.flagged).map(|b| b.ibi_ms.round()).collect();
    println!("flagged intervals: {flagged:?}");
    let r = |v: f64| (v as f32 as f64).round();
    assert!(flagged.contains(&r(merged)), "missed beat flagged");
    assert!(flagged.contains(&r(0.4 * x)) && flagged.contains(&r(0.6 * x)), "extra beat flagged");
    assert!(flagged.contains(&r(a - 250.0)) && flagged.contains(&r(b + 250.0)), "ectopic pair flagged");
    assert_eq!(flagged.len(), 5, "nothing else flagged");

    // Compare RMSSD frame by frame (nearest clean-run frame in time) wherever both are measured.
    let mut worst: f64 = 0.0;
    let mut n = 0;
    let mut max_cf: f64 = 0.0;
    for d in &fb {
        let c = fc.iter().min_by(|x, y| (x.t - d.t).abs().total_cmp(&(y.t - d.t).abs())).unwrap();
        if (c.t - d.t).abs() > 0.05 {
            continue;
        }
        if let (Some(rc), Some(rb)) = (c.rmssd_ms.v, d.rmssd_ms.v) {
            worst = worst.max((rb - rc).abs() / rc);
            n += 1;
        }
        max_cf = max_cf.max(d.corrected_fraction);
    }
    println!("rmssd compared on {n} frames: worst relative difference {:.4}; max corrected fraction {max_cf:.4}", worst);
    assert!(n > 100);
    assert!(worst < 0.05, "rmssd differs by {worst}");
    assert!(max_cf > 0.0 && max_cf <= 0.05);
    // Naive RMSSD over a window containing the missed beat, for comparison: wrecked by one interval.
    let tm = fb.iter().flat_map(|f| f.beats.iter()).find(|b| b.ibi_ms.round() == r(merged)).unwrap().t;
    let all: Vec<f64> = fb.iter().flat_map(|f| f.beats.iter()).filter(|b| b.t > tm - 30.0 && b.t <= tm + 30.0).map(|b| b.ibi_ms).collect();
    let clean_all: Vec<f64> = fc.iter().flat_map(|f| f.beats.iter()).filter(|b| b.t > tm - 30.0 && b.t <= tm + 30.0).map(|b| b.ibi_ms).collect();
    let (naive, _) = reference(&all);
    let (truth, _) = reference(&clean_all);
    println!("naive rmssd around the missed beat: {naive:.1} vs clean {truth:.1}");
    assert!(naive > 2.0 * truth);
}

#[test]
fn too_many_corrections_and_too_few_beats_are_null() {
    let mut ibis = rr_series(6, 150.0, 850.0, 0.0, 0.1, 15.0);
    // Corrupt 8% of the intervals in the last minute.
    for k in (60..ibis.len()).step_by(12) {
        ibis[k] *= 1.6;
    }
    let mut e = engine(6);
    deliver_rr(&mut e, &beats_from_ibis(0.0, &ibis), 6, 0.3, &[]);
    let frames = e.drain();
    check_null_contract(&frames);
    let f = frames.last().unwrap();
    println!("corrected fraction {:.3}", f.corrected_fraction);
    assert!(f.corrected_fraction > 0.05);
    assert_eq!(f.rmssd_ms.why, Reason::TooManyCorrections);
    assert_eq!(f.sdnn_ms.why, Reason::TooManyCorrections);
    assert_eq!(f.lf_power.why, Reason::TooManyCorrections);

    // Too few beats: a heart rate of 25/min is below the minimum (and every interval flagged).
    let slow = vec![1900.0; 80];
    let mut e2 = engine(6);
    let p = hb_heart::HeartParams { hrv_min_beats_per_min: 35.0, ..Default::default() };
    let mut e3 = hb_heart::HeartEngine::new(hb_heart::HeartConfig { seed: 6, params: p });
    deliver_rr(&mut e2, &beats_from_ibis(0.0, &slow), 6, 0.3, &[]);
    deliver_rr(&mut e3, &beats_from_ibis(0.0, &slow), 6, 0.3, &[]);
    let f3 = e3.drain();
    let last3 = f3.last().unwrap();
    println!("too few beats: rmssd why {:?}", last3.rmssd_ms.why);
    assert_eq!(last3.rmssd_ms.why, Reason::TooFewBeats);
}

#[test]
fn strap_clock_is_robust_to_jitter_and_lost_notifications() {
    let ibis = rr_series(7, 120.0, 800.0, 30.0, 0.1, 10.0);
    let beats = beats_from_ibis(0.3, &ibis);
    let mut e = engine(7);
    deliver_rr(&mut e, &beats, 7, 0.4, &[40, 41, 90]);
    let frames = e.drain();
    check_null_contract(&frames);
    let got: Vec<_> = frames.iter().flat_map(|f| f.beats.iter().copied()).collect();
    // Match each emitted beat to its true beat by interval sequence and compare times.
    let mut max_err: f64 = 0.0;
    let mut errs = Vec::new();
    for b in &got {
        let tb = beats.iter().min_by(|x, y| (x.0 - b.t).abs().total_cmp(&(y.0 - b.t).abs())).unwrap();
        errs.push(b.t - tb.0);
        max_err = max_err.max((b.t - tb.0).abs());
    }
    let mean_err = errs.iter().sum::<f64>() / errs.len() as f64;
    println!(
        "{} of {} beats received, lost events {}, beat time error mean {mean_err:.3} s max {max_err:.3} s",
        got.len(),
        beats.len(),
        e.strap_lost_events()
    );
    assert_eq!(e.strap_lost_events(), 2, "two runs of lost notifications detected");
    // Placed no later than arrival and never far from the truth (latency floor + jitter).
    assert!(max_err < 0.45, "beat time error {max_err}");
    // Strictly increasing.
    assert!(got.windows(2).all(|w| w[1].t > w[0].t));
    // Lost notifications do not create flagged beats or corrupt variability.
    assert!(got.iter().all(|b| !b.flagged));
}

#[test]
fn ppg_beats_within_15_ms() {
    let fs = 64.0;
    // Heart rate varying 62-82 bpm with a 0.12 Hz rhythm and a slow drift.
    let mut peaks = Vec::new();
    let mut t = 0.5;
    while t < 120.0 {
        let hr = 72.0 + 8.0 * (2.0 * std::f64::consts::PI * 0.12 * t).sin() + 2.0 * (t / 60.0);
        t += 60.0 / hr;
        peaks.push(t);
    }
    let sig = ppg_signal(8, &peaks, 121.0, fs);
    let mut e = engine(8);
    // Push in 12-sample chunks of 3 channels, like headset packets.
    let n = sig.len() / 3;
    let mut i = 0;
    while i < n {
        let k = 12.min(n - i);
        e.push_ppg(i as f64 / fs, &sig[i * 3..(i + k) * 3], 3);
        i += k;
    }
    let frames = e.drain();
    check_null_contract(&frames);
    let got: Vec<_> = frames.iter().flat_map(|f| f.beats.iter().copied()).collect();
    assert!(frames.iter().filter(|f| !f.beats.is_empty()).all(|f| f.source == HeartSource::HeadsetPpg));
    let mut errs = Vec::new();
    for b in &got {
        let tp = peaks.iter().min_by(|x, y| (*x - b.t).abs().total_cmp(&(*y - b.t).abs())).unwrap();
        errs.push((b.t - tp) * 1000.0);
    }
    let max_abs = errs.iter().map(|x| x.abs()).fold(0.0, f64::max);
    let mean = errs.iter().sum::<f64>() / errs.len() as f64;
    let expected = peaks.iter().filter(|&&p| p > 5.0 && p < 119.0).count();
    println!(
        "ppg: {} beats detected ({} true peaks between 5 and 119 s), error mean {mean:.2} ms, max |error| {max_abs:.2} ms, flagged {}, channel quality {:?}",
        got.len(),
        expected,
        got.iter().filter(|b| b.flagged).count(),
        e.ppg_quality()
    );
    assert!(max_abs < 15.0, "max error {max_abs} ms");
    assert!(got.len() >= expected, "missed beats");
    assert!(got.iter().all(|b| !b.flagged));
    // Best channel chosen: channel 2 (the clean one).
    let q = e.ppg_quality();
    assert!(q[2].unwrap() > q[0].unwrap());
}

#[test]
fn source_prefers_fresh_strap_then_ppg() {
    let fs = 64.0;
    let ibis = rr_series(11, 100.0, 850.0, 0.0, 0.1, 10.0);
    let beats = beats_from_ibis(0.0, &ibis);
    let peaks: Vec<f64> = beats.iter().map(|b| b.0 + 0.2).collect();
    let sig = ppg_signal(11, &peaks, 100.0, fs);
    let mut e = engine(11);
    // Strap stops at 50 s.
    let strap: Vec<_> = beats.iter().copied().filter(|b| b.0 < 50.0).collect();
    let mut rr_iter = 0usize;
    let mut notif = 1.0;
    let n = sig.len() / 3;
    let mut i = 0;
    while i < n {
        let k = 16.min(n - i);
        let t_chunk = i as f64 / fs;
        // Deliver strap notifications due before this chunk.
        while notif <= t_chunk {
            let mut rr = Vec::new();
            while rr_iter < strap.len() && strap[rr_iter].0 <= notif {
                rr.push(strap[rr_iter].1 as f32);
                rr_iter += 1;
            }
            if notif < 50.0 {
                e.push_rr(notif, &rr);
            }
            notif += 1.0;
        }
        e.push_ppg(t_chunk, &sig[i * 3..(i + k) * 3], 3);
        i += k;
    }
    let frames = e.drain();
    check_null_contract(&frames);
    let at = |t: f64| frames.iter().find(|f| f.t >= t).unwrap().source;
    assert_eq!(at(30.0), HeartSource::ChestStrap);
    assert_eq!(at(70.0), HeartSource::HeadsetPpg);
    // Frames at least once a second.
    let max_gap = frames.windows(2).map(|w| w[1].t - w[0].t).fold(0.0, f64::max);
    assert!(max_gap <= 1.0 + 1e-9, "frame gap {max_gap}");
    assert!(frames.windows(2).all(|w| w[1].t >= w[0].t));
}

#[test]
fn no_input_source_is_none_with_no_data() {
    let mut e = engine(1);
    for k in 0..40 {
        e.push_brain(k as f64 * 0.25, "alpha.above_bg_db@temporal", Some(1.0));
    }
    let frames = e.drain();
    check_null_contract(&frames);
    assert!(frames.len() >= 9);
    for f in &frames {
        assert_eq!(f.source, HeartSource::None);
        assert_eq!(f.hr_bpm.why, Reason::NoData);
        assert_eq!(f.rmssd_ms.why, Reason::NoData);
        assert_eq!(f.pacer_adherence.why, Reason::NotAvailable);
        assert_eq!(f.high_hrv.stat.why, Reason::NotAvailable);
        for c in &f.coupling {
            assert_eq!(c.value.why, Reason::WarmingUp);
        }
    }
}

#[test]
fn high_hrv_state_relative_to_baseline() {
    // 150 s of low variability, then 150 s of high variability.
    let mut ibis = rr_series(12, 150.0, 850.0, 0.0, 0.1, 10.0);
    ibis.extend(rr_series(13, 150.0, 850.0, 50.0, 0.1, 25.0));
    let mut e = engine(12);
    e.mark_baseline(60.0, 140.0);
    deliver_rr(&mut e, &beats_from_ibis(0.0, &ibis), 12, 0.3, &[]);
    let frames = e.drain();
    check_null_contract(&frames);
    let before: Vec<_> = frames.iter().filter(|f| f.t < 140.0).collect();
    assert!(before.iter().all(|f| !f.high_hrv.active && f.high_hrv.stat.why == Reason::WarmingUp));
    let base: Vec<_> = frames.iter().filter(|f| f.t > 141.0 && f.t < 150.0).collect();
    assert!(base.iter().all(|f| !f.high_hrv.active && f.high_hrv.enter_at.is_some()));
    let f = frames.last().unwrap();
    let (en, ex) = (f.high_hrv.enter_at.unwrap(), f.high_hrv.exit_at.unwrap());
    println!("enter_at {en:.3}, exit_at {ex:.3}, final stat {:?}, active {} for {:.1} s", f.high_hrv.stat.v, f.high_hrv.active, f.high_hrv.for_s);
    assert!(ex < en);
    assert!(f.high_hrv.active);
    // Entered only after the dwell: first active frame is at least dwell after the first frame above entry.
    let first_above = frames.iter().find(|f| f.high_hrv.stat.v.map_or(false, |s| s >= en)).unwrap().t;
    let first_active = frames.iter().find(|f| f.high_hrv.active).unwrap().t;
    println!("first above entry {first_above:.2} s, first active {first_active:.2} s");
    assert!(first_active - first_above >= 5.0 - 1e-9);
    // Never flickers: one entry only.
    let entries = frames.windows(2).filter(|w| !w[0].high_hrv.active && w[1].high_hrv.active).count();
    assert_eq!(entries, 1);
}

#[test]
fn deterministic_byte_identical_json() {
    let run = |seed: u64| {
        let ibis = rr_series(21, 400.0, 850.0, 40.0, 0.1, 15.0);
        let beats = beats_from_ibis(0.0, &ibis);
        let mut e = engine(seed);
        e.set_pacer(Some(6.0));
        e.mark_baseline(10.0, 100.0);
        let mut rng = hb_heart::dsp::Rng::new(5);
        let mut x = 0.0;
        let mut k = 0usize;
        let mut notif = 1.0;
        let mut bi = 0usize;
        while notif < 400.0 {
            let mut rr = Vec::new();
            while bi < beats.len() && beats[bi].0 <= notif {
                rr.push(beats[bi].1 as f32);
                bi += 1;
            }
            e.push_rr(notif + 0.1, &rr);
            for _ in 0..4 {
                x += rng.normal();
                e.push_brain(k as f64 * 0.25, "alpha.above_bg_db@temporal", Some(x));
                k += 1;
            }
            notif += 1.0;
        }
        serde_json::to_string(&e.drain()).unwrap()
    };
    let a = run(42);
    let b = run(42);
    assert_eq!(a, b);
    assert!(a.contains("\"kind\":\"heart\""));
    assert!(a.contains("\"why\":\"warming_up\""));
    assert!(a.contains("\"measure\":\"phase_locking\""));
    let c = run(43);
    assert_ne!(a, c, "the seed drives the surrogates");
    println!("json bytes {}", a.len());
}

#[test]
fn json_shape_matches_contract() {
    let ibis = rr_series(2, 30.0, 850.0, 0.0, 0.1, 10.0);
    let mut e = engine(2);
    e.set_suspect_artifact("track:3.height_db", true);
    deliver_rr(&mut e, &beats_from_ibis(0.0, &ibis), 2, 0.3, &[]);
    e.push_brain(31.0, "track:3.height_db", None);
    let frames = e.drain();
    let v: serde_json::Value = serde_json::to_value(frames.last().unwrap()).unwrap();
    let o = v.as_object().unwrap();
    let keys: Vec<&str> = o.keys().map(|s| s.as_str()).collect();
    for k in [
        "kind", "schema", "t", "source", "beats", "hr_bpm", "rmssd_ms", "sdnn_ms", "lf_power", "hf_power", "resonance_hz",
        "resonance_strength", "breath_bpm", "breath_phase", "pacer_adherence", "corrected_fraction", "high_hrv", "coupling",
    ] {
        assert!(keys.contains(&k), "missing {k}");
    }
    assert_eq!(keys.len(), 18);
    assert_eq!(o["kind"], "heart");
    assert_eq!(o["schema"], 1);
    assert_eq!(o["source"], "chest_strap");
    let m = o["rmssd_ms"].as_object().unwrap();
    assert!(m.contains_key("v") && m.contains_key("se") && m.contains_key("why"));
    assert_eq!(o["rmssd_ms"]["why"], "warming_up");
    assert!(o["rmssd_ms"]["v"].is_null());
    let hh = o["high_hrv"].as_object().unwrap();
    for k in ["active", "for_s", "stat", "enter_at", "exit_at"] {
        assert!(hh.contains_key(k));
    }
    let c = &o["coupling"][0];
    assert_eq!(c["brain"], "track:3.height_db");
    assert_eq!(c["suspect_artifact"], true);
    assert_eq!(c["value"]["why"], "artifact");
    let b = &o["beats"];
    assert!(b.is_array());
    println!("{}", serde_json::to_string_pretty(&v).unwrap().lines().take(30).collect::<Vec<_>>().join("\n"));
}

/// Intervals with a breathing rhythm whose rate wanders (rate_hz +- 8%), plus AR noise.
fn rr_breathing(seed: u64, dur: f64, mean: f64, amp: f64, rate_hz: f64, noise_sd: f64) -> Vec<f64> {
    let mut rng = hb_heart::dsp::Rng::new(seed);
    let (mut t, mut ph, mut ar) = (0.0, rng.uniform() * 6.28, 0.0);
    let mut out = Vec::new();
    while t < dur {
        ar = 0.5 * ar + noise_sd * rng.normal();
        let i = mean + amp * ph.sin() + ar;
        let f = rate_hz * (1.0 + 0.08 * (2.0 * std::f64::consts::PI * t / 47.0).sin());
        ph += 2.0 * std::f64::consts::PI * f * i / 1000.0;
        t += i / 1000.0;
        out.push(i);
    }
    out
}

#[test]
fn breath_estimate_detection_and_false_rates() {
    let seeds = 30u64;
    let (mut noise_frames, mut noise_detected) = (0usize, 0usize);
    let (mut br_frames, mut br_detected, mut br_err_max) = (0usize, 0usize, 0.0f64);
    for seed in 0..seeds {
        // Rhythm-free intervals.
        let ibis = rr_series(1000 + seed, 200.0, 850.0, 0.0, 0.1, 30.0);
        let mut e = engine(seed);
        deliver_rr(&mut e, &beats_from_ibis(0.0, &ibis), seed, 0.3, &[]);
        for f in e.drain().iter().filter(|f| f.t > 130.0) {
            noise_frames += 1;
            if f.breath_bpm.v.is_some() {
                noise_detected += 1;
            }
        }
        // Spontaneous breathing near 15/min with a wandering rate.
        let ibis = rr_breathing(2000 + seed, 200.0, 850.0, 25.0, 0.25, 15.0);
        let mut e = engine(seed);
        deliver_rr(&mut e, &beats_from_ibis(0.0, &ibis), seed, 0.3, &[]);
        for f in e.drain().iter().filter(|f| f.t > 130.0) {
            br_frames += 1;
            if let Some(b) = f.breath_bpm.v {
                br_detected += 1;
                br_err_max = br_err_max.max((b - 15.0).abs());
            }
        }
    }
    let fpr = noise_detected as f64 / noise_frames as f64;
    let det = br_detected as f64 / br_frames as f64;
    println!("breath estimate: false reports on rhythm-free data {noise_detected}/{noise_frames} = {fpr:.4}; detection of 15/min wandering breathing {br_detected}/{br_frames} = {det:.3}, max error {br_err_max:.2}/min");
    assert!(fpr < 0.05, "false breath estimates {fpr}");
    assert!(det > 0.8, "breath detection {det}");
    assert!(br_err_max < 1.5);
}
