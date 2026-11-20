//! Seeded synthetic data for the heart engine tests.
#![allow(dead_code)]

use hb_heart::dsp::Rng;
use hb_heart::{HeartConfig, HeartEngine, HeartFrame, Measured, Reason};
use std::f64::consts::PI;

/// True beats: (time s, interval ms). Beat 0 is at t0 + ibi[0].
pub fn beats_from_ibis(t0: f64, ibis: &[f64]) -> Vec<(f64, f64)> {
    let mut t = t0;
    ibis.iter()
        .map(|&i| {
            t += i / 1000.0;
            (t, i)
        })
        .collect()
}

/// Intervals for `dur` seconds: mean + sinusoid(freq, amp) + AR(1) noise.
pub fn rr_series(seed: u64, dur: f64, mean: f64, amp: f64, freq: f64, noise_sd: f64) -> Vec<f64> {
    let mut rng = Rng::new(seed);
    let mut t = 0.0;
    let mut out = Vec::new();
    let mut ar = 0.0;
    while t < dur {
        ar = 0.5 * ar + noise_sd * rng.normal();
        let i = mean + amp * (2.0 * PI * freq * t).sin() + ar;
        t += i / 1000.0;
        out.push(i);
    }
    out
}

/// Deliver beats like a Polar H10: a notification about once a second carrying the intervals of
/// the beats since the previous one, arriving after a random delay in [0, jitter] s.
/// `drop` lists notification numbers that are lost.
pub fn deliver_rr(e: &mut HeartEngine, beats: &[(f64, f64)], seed: u64, jitter: f64, drop: &[usize]) {
    let mut rng = Rng::new(seed ^ 0xABCD);
    let mut k = 0usize;
    let mut i = 0usize;
    let mut notif_t = beats.first().map(|b| b.0.ceil()).unwrap_or(0.0);
    while i < beats.len() {
        let mut rr = Vec::new();
        while i < beats.len() && beats[i].0 <= notif_t {
            rr.push(beats[i].1 as f32);
            i += 1;
        }
        if !drop.contains(&k) {
            e.push_rr(notif_t + rng.uniform() * jitter, &rr);
        }
        k += 1;
        notif_t += 1.0;
    }
}

pub fn engine(seed: u64) -> HeartEngine {
    HeartEngine::new(HeartConfig { seed, ..Default::default() })
}

/// Every Measured in a frame, with a label.
pub fn all_measured(f: &HeartFrame) -> Vec<(String, Measured)> {
    let mut v = vec![
        ("hr_bpm".to_string(), f.hr_bpm),
        ("rmssd_ms".into(), f.rmssd_ms),
        ("sdnn_ms".into(), f.sdnn_ms),
        ("lf_power".into(), f.lf_power),
        ("hf_power".into(), f.hf_power),
        ("resonance_hz".into(), f.resonance_hz),
        ("resonance_strength".into(), f.resonance_strength),
        ("breath_bpm".into(), f.breath_bpm),
        ("breath_phase".into(), f.breath_phase),
        ("pacer_adherence".into(), f.pacer_adherence),
        ("high_hrv.stat".into(), f.high_hrv.stat),
    ];
    for c in &f.coupling {
        v.push((format!("{}:{}:value", c.brain, c.measure), c.value));
        v.push((format!("{}:{}:chance", c.brain, c.measure), c.chance));
        v.push((format!("{}:{}:p", c.brain, c.measure), c.p));
    }
    v
}

/// The null contract: a null carries a reason other than ok, a value carries ok and is finite.
pub fn check_null_contract(frames: &[HeartFrame]) {
    for f in frames {
        for (name, m) in all_measured(f) {
            match m.v {
                None => assert!(m.why != Reason::Ok && m.se.is_none(), "{name} at {}: null with ok", f.t),
                Some(v) => {
                    assert!(m.why == Reason::Ok && v.is_finite(), "{name} at {}: value with reason {:?}", f.t, m.why)
                }
            }
        }
        assert!(f.corrected_fraction.is_finite());
    }
}

/// PPG: pulses (gaussian systolic peak + dicrotic wave) at the given true peak times, plus baseline
/// wander and noise. Returns interleaved samples for 3 channels: 0 noise only, 1 weak pulse, 2 good.
pub fn ppg_signal(seed: u64, peaks: &[f64], dur: f64, fs: f64) -> Vec<f32> {
    let mut rng = Rng::new(seed ^ 0x5151);
    let n = (dur * fs) as usize;
    let mut out = Vec::with_capacity(n * 3);
    let mut j0 = 0usize;
    for i in 0..n {
        let t = i as f64 / fs;
        while j0 < peaks.len() && peaks[j0] < t - 1.0 {
            j0 += 1;
        }
        let mut pulse = 0.0;
        for &tp in peaks[j0..].iter().take_while(|&&tp| tp < t + 1.0) {
            let d = t - tp;
            pulse += (-d * d / (2.0 * 0.07 * 0.07)).exp() + 0.35 * (-(d - 0.3) * (d - 0.3) / (2.0 * 0.08 * 0.08)).exp();
        }
        let wander = 0.6 * (2.0 * PI * 0.07 * t).sin() + 0.3 * (2.0 * PI * 0.23 * t + 1.0).sin();
        out.push((1000.0 + 0.5 * rng.normal() + wander) as f32);
        out.push((1000.0 + 0.3 * pulse + 0.15 * rng.normal() + wander) as f32);
        out.push((1000.0 + 1.0 * pulse + 0.03 * rng.normal() + wander) as f32);
    }
    out
}
