//! Second whole-app fake test: the combined "both at once" state, and the faults that kept it
//! (and a steady golden ratio state) from holding. Each test names the fault it guards.
mod common;

use common::*;
use hb_engine::types::{ParamValue, Reason, SlowFrame};
use hb_engine::Engine;

fn fixture(name: &str) -> (Vec<f32>, Vec<f64>) {
    let base = format!("{}/../../lab/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(format!("{base}.f32")).expect("fixture samples");
    let samples: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{base}.json")).expect("fixture truth")).unwrap();
    let planted = meta["truth"]["peaks"].as_array().unwrap().iter().map(|p| p["f0"].as_f64().unwrap()).collect();
    (samples, planted)
}

fn run_fixture(samples: &[f32], params: &[(&str, ParamValue)]) -> Vec<hb_engine::types::Frame> {
    let mut cfg = config(1, params);
    cfg.mains_hz = None;
    let mut e = Engine::new(cfg).expect("engine");
    run_engine(&mut e, samples, 4, 12)
}

fn count(s: &[&SlowFrame], f: &dyn Fn(&SlowFrame) -> bool) -> usize {
    s.iter().filter(|x| f(x)).count()
}

/// The requirement: a clean golden ratio chain (5, 8.09, 13.09 Hz) and a clean octave chain
/// (5, 10, 20 Hz) in one 120 s recording at 12 dB reach the combined state, and hold it.
/// Before: both in 39 of 480 frames (golden 92, octave 89).
#[test]
fn the_both_cascades_fixture_reaches_and_holds_the_combined_state() {
    let (samples, planted) = fixture("both_phi_octave_12db");
    let frames = run_fixture(&samples, &[]);
    let s = slow(&frames);
    let both = count(&s, &|f| f.states.both.active);
    let phi = count(&s, &|f| f.states.phi.active);
    let oct = count(&s, &|f| f.states.octave.active);
    println!("frames {}: golden ratio state {phi}, octave state {oct}, both {both}", s.len());
    assert!(both >= 100 && phi >= 100 && oct >= 200, "both {both}, golden {phi}, octave {oct} of {}", s.len());
    // Every planted rhythm has a track near it in most frames once the first windows are in.
    let late: Vec<&SlowFrame> = s.iter().copied().filter(|f| f.t >= 30.0).collect();
    for f0 in planted {
        let n = count(&late, &|f| track_near(f, f0, 0.06 * f0).is_some());
        println!("  {f0:.2} Hz tracked in {n} of {}", late.len());
        assert!(n as f64 >= 0.75 * late.len() as f64, "{f0} Hz tracked in {n} of {}", late.len());
    }
    // No background fit is refused for the crowd of rhythms.
    let bad = s.iter().flat_map(|f| f.spectra.iter()).filter(|sp| sp.why == Reason::BadFit).count();
    assert!(bad <= 5, "{bad} site spectra with a refused background fit");
}

/// Fault: a pair that was never inside a harmonic's band was made "pending" for 3 s in every
/// 33 (the out-of-band window was counted as the pair's first test), and a pending pair is kept
/// out of the cascades. Every pair with a ratio of 1.5 or more was affected, golden pairs
/// included, and each time the golden state fell and had to wait out its dwell again.
#[test]
fn a_pair_that_was_never_in_a_harmonics_band_is_never_pending() {
    let n = (150.0 * RATE) as usize;
    let g = phi();
    let ch = four(n, 1.5, &[Rhythm { f: 7.0, bw: 0.3, snr_db: 13.0 }, Rhythm { f: 7.0 * g, bw: 0.4, snr_db: 13.0 }], 12.0, 31);
    let (frames, _) = run(&ch, 1, &[]);
    let s = slow(&frames);
    let late: Vec<&SlowFrame> = s.iter().copied().filter(|f| f.t >= 40.0).collect();
    let marked = count(&late, &|f| f.pairs.iter().any(|p| p.harmonic));
    let step = count(&late, &|f| f.cascades.phi.steps >= 1);
    let on = count(&late, &|f| f.states.phi.active);
    println!("golden pair: frames {}, pair marked harmonic or pending in {marked}, step in {step}, state in {on}", late.len());
    assert_eq!(marked, 0, "a golden ratio pair was kept out as a possible harmonic");
    assert!(step as f64 >= 0.9 * late.len() as f64 && on as f64 >= 0.8 * late.len() as f64, "step {step}, state {on} of {}", late.len());
}

/// Fault: the background level was set by the median of all fit bins, which six rhythms lift.
/// The valleys between them then read as under the background, the lack-of-fit guard refused
/// the fit, and whole windows went null (141 of 210 site spectra in one case).
#[test]
fn six_rhythms_do_not_fail_the_background_fit() {
    let n = (120.0 * RATE) as usize;
    let g = phi();
    let rh = [
        Rhythm { f: 4.0, bw: 0.3, snr_db: 12.0 },
        Rhythm { f: 4.0 * g, bw: 0.45, snr_db: 12.0 },
        Rhythm { f: 4.0 * g * g, bw: 0.7, snr_db: 12.0 },
        Rhythm { f: 8.3, bw: 0.5, snr_db: 12.0 },
        Rhythm { f: 16.6, bw: 1.0, snr_db: 12.0 },
        Rhythm { f: 33.2, bw: 1.5, snr_db: 12.0 },
    ];
    let (mut total, mut bad) = (0, 0);
    for seed in 0..3u64 {
        let ch = four(n, 1.5, &rh, 15.0, 900 + seed);
        let (frames, _) = run(&ch, 1, &[]);
        for f in slow(&frames) {
            for sp in &f.spectra {
                total += 1;
                bad += (sp.why == Reason::BadFit) as usize;
            }
        }
    }
    println!("six rhythms: {bad} of {total} site spectra with a refused background fit");
    assert!(bad as f64 <= 0.02 * total as f64, "{bad} of {total}");
}

/// Fault: the joining distance was three standard errors with no upper limit, and reached 1.5 to
/// 2 Hz, so a track hopped to a neighbouring rhythm and a neighbour's track was merged away
/// (one track read 3.1, then 4.9, then 6.7 Hz). A track now stays with its own rhythm.
#[test]
fn neighbouring_rhythms_keep_their_own_tracks() {
    let n = (150.0 * RATE) as usize;
    let rh = [
        Rhythm { f: 4.85, bw: 0.3, snr_db: 12.0 },
        Rhythm { f: 6.2, bw: 0.35, snr_db: 12.0 },
        Rhythm { f: 7.85, bw: 0.4, snr_db: 12.0 },
        Rhythm { f: 12.4, bw: 0.6, snr_db: 12.0 },
    ];
    let mut worst: f64 = 0.0;
    for seed in 0..3u64 {
        let ch = four(n, 1.5, &rh, 15.0, 940 + seed);
        let (frames, _) = run(&ch, 1, &[]);
        let mut range: std::collections::BTreeMap<u32, (f64, f64)> = Default::default();
        for f in slow(&frames) {
            for t in &f.tracks {
                if let Some(v) = t.freq_integrated.v {
                    let e = range.entry(t.id).or_insert((v, v));
                    e.0 = e.0.min(v);
                    e.1 = e.1.max(v);
                }
            }
        }
        for (id, (lo, hi)) in &range {
            println!("seed {seed} track {id}: {lo:.2} to {hi:.2} Hz");
            worst = worst.max(hi - lo);
        }
    }
    assert!(worst < 0.9, "a track's integrated frequency moved {worst:.2} Hz");
}

/// Fault: one 8 s spectrum of a rhythm 1 Hz wide is jagged, and "the bins above half the
/// tallest bin" was one lump of it: a 20 Hz rhythm became two tracks near 19.2 and 20.5 Hz and
/// the octave step from 10 Hz was lost. And smoothing must not join what the spectrum shows
/// apart: 8 and 10 Hz, both narrow, stay two tracks.
#[test]
fn a_broad_rhythm_is_one_track_and_close_narrow_rhythms_are_two() {
    let n = (150.0 * RATE) as usize;
    let (mut total, mut one, mut step, mut two) = (0, 0, 0, 0);
    let mut err2 = 0.0;
    for seed in 0..4u64 {
        let ch = four(n, 1.5, &[Rhythm { f: 8.0, bw: 0.3, snr_db: 12.0 }, Rhythm { f: 10.0, bw: 0.3, snr_db: 12.0 }, Rhythm { f: 20.0, bw: 1.0, snr_db: 12.0 }], 12.0, 960 + seed);
        let (frames, _) = run(&ch, 1, &[]);
        for f in slow(&frames).iter().filter(|f| f.t >= 40.0) {
            total += 1;
            let near: Vec<f64> = f.tracks.iter().filter_map(|t| t.freq_integrated.v).filter(|v| (v - 20.0).abs() < 2.5).collect();
            if near.len() == 1 {
                one += 1;
                err2 += (near[0] - 20.0) * (near[0] - 20.0);
            }
            step += (f.cascades.octave.steps >= 1) as usize;
            two += (track_near(f, 8.0, 0.5).is_some() && track_near(f, 10.0, 0.5).is_some()) as usize;
        }
    }
    let rms = (err2 / one.max(1) as f64).sqrt();
    println!("frames {total}: one track at 20 Hz in {one} (rms error {rms:.2} Hz), octave step in {step}, 8 and 10 Hz both tracked in {two}");
    assert!(one as f64 >= 0.9 * total as f64, "one track at 20 Hz in {one} of {total}");
    assert!(rms < 0.25, "rms error at 20 Hz {rms}");
    assert!(step as f64 >= 0.8 * total as f64, "octave step in {step} of {total}");
    assert!(two as f64 >= 0.85 * total as f64, "8 and 10 Hz both tracked in {two} of {total}");
}
