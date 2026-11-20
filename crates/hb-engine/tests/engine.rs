mod common;
use common::*;
use hb_engine::m;
use hb_engine::prng::Rng;
use hb_engine::spectral::WindowAnalyzer;
use hb_engine::types::*;
use hb_engine::{Engine, Params};

fn sine_plus_bg(secs: f64, f: f64, amp: f64, seed: u64) -> Vec<Vec<f64>> {
    let n = (secs * RATE) as usize;
    let bg = four(n, 1.5, &[], 4.0, seed);
    bg.into_iter().map(|b| b.iter().enumerate().map(|(i, v)| v + amp * m::sin(m::TAU * f * i as f64 / RATE)).collect()).collect()
}

#[test]
fn sine_10hz_reads_10_within_0_1() {
    let ch = sine_plus_bg(60.0, 10.0, 10.0, 11);
    let (frames, _) = run(&ch, 1, &[]);
    let s = slow(&frames);
    let last = s.last().unwrap();
    let tr = track_near(last, 10.0, 0.5).expect("a track near 10 Hz");
    let fi = tr.freq_integrated.v.unwrap();
    let fw = tr.freq.v.unwrap();
    println!("10 Hz sine: integrated {fi:.4} +- {:.4} Hz, window {fw:.4} +- {:.4} Hz, height {:.1} dB, width {:.2} Hz, site {}",
        tr.freq_integrated.se.unwrap(), tr.freq.se.unwrap(), tr.height_db.v.unwrap(), tr.width_hz.v.unwrap(), tr.site);
    assert!((fi - 10.0).abs() <= 0.1, "integrated {fi}");
    assert!((fw - 10.0).abs() <= 0.1, "window {fw}");
    assert_eq!(tr.band, BandName::Alpha);
    // The fast path follows it.
    let fl = fast(&frames);
    let lf = fl.last().unwrap();
    let ft = lf.tracks.iter().find(|t| t.id == tr.id).expect("fast track");
    println!("fast: {:?} locked {} delay {:.3} s", ft.freq, ft.locked, ft.delay_s);
    assert!(ft.locked && (ft.freq.v.unwrap() - 10.0).abs() < 0.2);
    assert!(ft.delay_s <= 0.3 + 1e-9);
}

#[test]
fn planted_phi_cascade_is_phi_not_octave() {
    let p = phi();
    let planted = [10.0 / p, 10.0, 10.0 * p];
    let rh: Vec<Rhythm> = planted.iter().map(|&f| Rhythm { f, bw: 0.25, snr_db: 10.0 }).collect();
    let ch = four((150.0 * RATE) as usize, 1.5, &rh, 12.0, 21);
    let (frames, _) = run(&ch, 1, &[]);
    let s = slow(&frames);
    let last = s.last().unwrap();
    let mut ids = Vec::new();
    for &f in &planted {
        let tr = track_near(last, f, 0.05 * f).unwrap_or_else(|| panic!("no track near {f}: {:?}", last.tracks.iter().map(|t| t.freq_integrated.v).collect::<Vec<_>>()));
        let fi = tr.freq_integrated.v.unwrap();
        let err = (fi - f) / f;
        println!("planted {f:.3} Hz -> integrated {fi:.3} +- {:.3} Hz (error {:+.2}%)", tr.freq_integrated.se.unwrap(), 100.0 * err);
        assert!(err.abs() <= 0.01, "integrated frequency off by {:.2}%", 100.0 * err);
        ids.push(tr.id);
    }
    for w in ids.windows(2) {
        let pr = last.pairs.iter().find(|pr| pr.lo == w[0] && pr.hi == w[1]).expect("pair");
        println!("pair {}-{}: ratio {:.4}, phi miss {:+.4} aligned {}, octave aligned {}", pr.lo, pr.hi, m::exp(pr.log_ratio.v.unwrap()),
            pr.targets.phi.miss.v.unwrap(), pr.targets.phi.aligned, pr.targets.octave.aligned);
        assert!((m::exp(pr.log_ratio.v.unwrap()) - p).abs() < 0.03 * p);
        assert!(pr.targets.phi.aligned, "phi step not aligned");
        assert!(!pr.targets.octave.aligned);
        assert!(!pr.targets.control_1_5.aligned && !pr.targets.control_1_8.aligned);
    }
    let cp = &last.cascades.phi;
    println!("phi cascade {:?} steps {} closeness {:?} chance A {:?} excess_a {:?}", cp.tracks, cp.steps, cp.closeness.v, cp.chance.a.closeness.v, cp.excess_a.v);
    assert_eq!(cp.steps, 2);
    assert_eq!(cp.tracks, ids);
    assert_eq!(last.cascades.octave.steps, 0);
    assert!(cp.chance.a.p_steps.v.unwrap() < 0.05, "a 3-member phi cascade should be rare under chance A");
    assert!(cp.excess_a.v.unwrap() > 0.5);
    // Chance B is available after 120 s of history.
    println!("chance B {:?}, state {:?}", cp.chance.b.closeness, last.states.phi);
    // Golden ratio alignment is never reported without octave and chance alongside (structure).
    assert!(last.cascades.octave.chance.a.closeness.v.is_some() || last.cascades.octave.chance.a.closeness.why != Reason::Ok);
}

#[test]
fn planted_octave_cascade_is_octave_not_phi() {
    let planted = [5.0, 10.0, 20.0];
    let rh: Vec<Rhythm> = planted.iter().map(|&f| Rhythm { f, bw: 0.3, snr_db: 10.0 }).collect();
    let ch = four((150.0 * RATE) as usize, 1.5, &rh, 12.0, 31);
    let (frames, _) = run(&ch, 1, &[]);
    let s = slow(&frames);
    let last = s.last().unwrap();
    let mut ids = Vec::new();
    for &f in &planted {
        let tr = track_near(last, f, 0.05 * f).unwrap_or_else(|| panic!("no track near {f}"));
        let fi = tr.freq_integrated.v.unwrap();
        println!("planted {f} Hz -> {fi:.3} Hz ({:+.2}%), harmonic_of {:?}", 100.0 * (fi - f) / f, tr.harmonic_of);
        assert!(((fi - f) / f).abs() <= 0.01);
        assert!(tr.harmonic_of.is_none(), "independent rhythms flagged harmonic");
        ids.push(tr.id);
    }
    assert_eq!(last.cascades.octave.steps, 2, "octave cascade {:?}", last.cascades.octave);
    assert_eq!(last.cascades.octave.tracks, ids);
    assert_eq!(last.cascades.phi.steps, 0);
    for pr in &last.pairs {
        assert!(!pr.targets.phi.aligned, "phi aligned pair in an octave cascade: {pr:?}");
    }
}

#[test]
fn window_false_peak_rate_on_background_noise() {
    // Independent 8 s windows of pure 1/f background through the single-site analyser.
    let mut p = Params::default();
    p.alpha_peak = 0.01;
    let wa = WindowAnalyzer::new(p.clone(), RATE);
    let n = wa.window_len();
    let mut rng = Rng::new(7);
    let trials = 2000;
    let mut hits = 0;
    let mut height = 0;
    for i in 0..trials {
        let chi = [1.0, 1.5, 2.0][i % 3];
        let x = synth(n, chi, &[], 10.0, &mut rng);
        let xf: Vec<f32> = x.iter().map(|v| *v as f32).collect();
        let a = wa.analyse(&xf, &[50.0]);
        assert!(a.bg_fit.is_ok(), "background fit failed on pure background: {:?}", a.bg_fit);
        if !a.peaks.is_empty() {
            hits += 1;
        }
        if a.height_passes > 0 {
            height += 1;
        }
    }
    let rate = hits as f64 / trials as f64;
    println!("false peaks per window on 1/f noise: {hits}/{trials} = {:.4} (height test alone {:.4}), alpha_peak {}", rate, height as f64 / trials as f64, p.alpha_peak);
    assert!(rate <= p.alpha_peak, "false-peak rate {rate} exceeds alpha_peak");
}

#[test]
fn background_only_noise_confirms_nothing() {
    let mut total_updates = 0;
    let mut with_peak = 0;
    let mut confirmed = 0;
    for seed in 0..4u64 {
        let chi = [1.0, 1.5, 2.0, 1.5][seed as usize];
        let ch = four((180.0 * RATE) as usize, chi, &[], 10.0, 100 + seed);
        let (frames, e) = run(&ch, seed, &[]);
        let d = e.diagnostics();
        total_updates += d.windows_analysed;
        with_peak += d.windows_with_passing_peak;
        for s in slow(&frames) {
            confirmed += s.tracks.len();
            assert!(s.cascades.phi.steps < 2 && s.cascades.octave.steps < 2, "cascade of 3+ in noise");
            assert!(!s.states.phi.active && !s.states.octave.active, "aligned state in noise");
        }
    }
    let r = with_peak as f64 / total_updates as f64;
    println!("engine on 1/f noise: windows with a passing peak (any of 7 sites) {with_peak}/{total_updates} = {r:.4}; track-frames {confirmed}");
    assert!(r <= Params::default().alpha_peak, "rate {r}");
    assert_eq!(confirmed, 0, "confirmed tracks in background-only noise");
}

#[test]
fn white_noise_yields_nothing() {
    let ch = four((90.0 * RATE) as usize, 0.0, &[], 10.0, 41);
    let (frames, e) = run(&ch, 1, &[]);
    let s = slow(&frames);
    for f in &s {
        assert!(f.tracks.is_empty());
        assert_eq!(f.cascades.phi.steps, 0);
        assert!(f.cascades.phi.closeness.v.is_none());
    }
    let last = s.last().unwrap();
    let all = last.spectra.iter().find(|x| x.site == "all").unwrap();
    println!("white noise: bg exponent {:?}, diag {:?}", all.bg_exponent, (e.diagnostics().windows_with_passing_peak, e.diagnostics().windows_analysed));
    assert!(all.bg_exponent.v.unwrap().abs() < 0.2);
}

#[test]
fn non_sinusoidal_rhythm_harmonic_is_flagged() {
    let n = (90.0 * RATE) as usize;
    let mut rng = Rng::new(51);
    let mut ch = Vec::new();
    for _ in 0..4 {
        let bg = synth(n, 1.5, &[], 4.0, &mut rng);
        let mut ph = 0.0f64;
        let sig = 1.4 / m::sqrt(RATE);
        let x: Vec<f64> = (0..n)
            .map(|i| {
                ph += m::TAU * 10.0 / RATE + sig * rng.normal();
                // Pointed (non-sinusoidal) waveform: fundamental plus a phase-locked 2nd harmonic.
                bg[i] + 12.0 * (m::sin(ph) + 0.55 * m::sin(2.0 * ph + 0.6))
            })
            .collect();
        ch.push(x);
    }
    let (frames, _) = run(&ch, 1, &[]);
    let s = slow(&frames);
    let last = s.last().unwrap();
    let base = track_near(last, 10.0, 0.6).expect("10 Hz track");
    let h = track_near(last, 20.0, 1.0).expect("20 Hz track");
    println!("base {:?} harmonic track {:?} harmonic_of {:?}", base.freq_integrated.v, h.freq_integrated.v, h.harmonic_of);
    assert_eq!(h.harmonic_of, Some(HarmonicOf { id: base.id, n: 2 }));
    let pr = last.pairs.iter().find(|p| p.lo == base.id && p.hi == h.id).unwrap();
    assert!(pr.harmonic);
    assert!(!pr.targets.octave.aligned, "harmonic credited as octave alignment");
    assert_eq!(last.cascades.octave.steps, 0);
}

fn alpha_session(secs: f64, seed: u64) -> Vec<Vec<f64>> {
    four((secs * RATE) as usize, 1.5, &[Rhythm { f: 10.0, bw: 0.4, snr_db: 10.0 }], 10.0, seed)
}

#[test]
fn blinks_eye_movements_muscle_and_pops_are_gated() {
    let mut ch = alpha_session(100.0, 61);
    let half_sine = |i: usize, start: usize, len: usize| if i >= start && i < start + len { m::sin(m::PI * (i - start) as f64 / len as f64) } else { 0.0 };
    let len = (0.3 * RATE) as usize;
    let mut blink_t = Vec::new();
    // Blinks every 2 s from 30 to 50 s: both frontal channels, same sign.
    let mut t = 30.0;
    while t < 50.0 {
        let s0 = (t * RATE) as usize;
        for i in s0..s0 + len {
            let v = 150.0 * half_sine(i, s0, len);
            ch[1][i] += v;
            ch[2][i] += v;
        }
        blink_t.push(t);
        t += 2.0;
    }
    // Horizontal eye movements at 55 and 57 s: frontal pair, opposite sign, a held step.
    for &te in &[55.0, 57.0] {
        let s0 = (te * RATE) as usize;
        for i in s0..s0 + (0.6 * RATE) as usize {
            let ramp = ((i - s0) as f64 / (0.05 * RATE)).min(1.0);
            ch[1][i] += 120.0 * ramp;
            ch[2][i] -= 120.0 * ramp;
        }
    }
    // Electrode pop on TP10 at 62 s.
    {
        let s0 = (62.0 * RATE) as usize;
        for i in s0..s0 + (0.4 * RATE) as usize {
            ch[3][i] += 200.0 * m::exp(-((i - s0) as f64) / (0.1 * RATE));
        }
    }
    // Muscle: broadband 25-100 Hz bursts on all channels, 1 s at 75 and 80 s.
    let mut rng = Rng::new(62);
    for &tm in &[75.0, 80.0] {
        let s0 = (tm * RATE) as usize;
        let burst = synth(256, 0.0, &[], 1.0, &mut rng);
        for c in 0..4 {
            let hf: Vec<f64> = synth(256, 0.0, &[], 1.0, &mut rng);
            for i in 0..256 {
                // high-pass the white burst crudely with a first difference
                let v = if i > 0 { hf[i] - hf[i - 1] } else { 0.0 };
                ch[c][s0 + i] += 25.0 * v + 0.0 * burst[i];
            }
        }
    }
    let (frames, _) = run(&ch, 1, &[]);
    let s = slow(&frames);
    let at = |t: f64| s.iter().find(|f| f.t >= t).unwrap();
    let q = |f: &SlowFrame, name: &str| f.quality.iter().find(|q| q.name == name).unwrap().clone();
    let f40 = at(40.0);
    println!("40 s AF7 {:?}", q(f40, "AF7"));
    assert!(q(f40, "AF7").artifacts.contains(&ArtifactKind::Blink));
    assert!(q(f40, "AF8").artifacts.contains(&ArtifactKind::Blink));
    assert!(q(f40, "AF7").clean_fraction < 0.95);
    assert!(!q(f40, "TP9").artifacts.contains(&ArtifactKind::Blink));
    let f58 = at(58.0);
    println!("58 s AF7 {:?}", q(f58, "AF7").artifacts);
    assert!(q(f58, "AF7").artifacts.contains(&ArtifactKind::EyeMovement));
    let f63 = at(63.0);
    println!("63 s TP10 {:?}", q(f63, "TP10").artifacts);
    assert!(q(f63, "TP10").artifacts.contains(&ArtifactKind::Pop));
    assert!(!q(f63, "TP9").artifacts.contains(&ArtifactKind::Pop));
    let f77 = at(77.0);
    println!("77 s TP9 {:?}", q(f77, "TP9"));
    for name in CHANNELS {
        assert!(q(f77, name).artifacts.contains(&ArtifactKind::Muscle), "{name} muscle not gated");
    }
    // Fast frames flag the blink moments.
    let fl = fast(&frames);
    for &bt in &blink_t {
        let flagged = fl.iter().filter(|f| f.t >= bt + 0.1 && f.t <= bt + 0.3).all(|f| f.artifact);
        assert!(flagged, "blink at {bt} not flagged in fast frames");
    }
    // No confirmed peak attributable to the artifacts: nothing below 4 Hz or above 20 Hz.
    for f in &s {
        for tr in &f.tracks {
            let v = tr.freq_integrated.v.unwrap();
            assert!(v > 4.0 && v < 20.0, "artifact peak at {v} Hz, t {}", f.t);
        }
    }
    // Alpha is still found, and recovers after the artifacts end.
    assert!(track_near(s.last().unwrap(), 10.0, 0.5).is_some());
}

#[test]
fn gaps_repairable_long_and_too_many() {
    let ch = alpha_session(80.0, 71);
    let data = interleave(&ch);
    let nch = 4;
    let n = ch[0].len();
    // (a) An 8-sample gap every 4 s: repaired, analysis continues.
    let mut e = Engine::new(config(1, &[])).unwrap();
    let mut frames = Vec::new();
    let mut i = 0usize;
    while i < n {
        let k = 12.min(n - i);
        let drop = i % 1024 == 0 && i > 0;
        if !drop {
            e.push_eeg(i as u64, &data[i * nch..(i + k) * nch]);
        } else {
            // skip 8 samples, push the rest of the packet
            e.push_eeg((i + 8) as u64, &data[(i + 8) * nch..(i + k) * nch]);
        }
        frames.extend(e.drain());
        i += k;
    }
    assert!(e.diagnostics().repaired_samples > 0);
    let s = slow(&frames);
    let last = s.last().unwrap();
    let sp = last.spectra.iter().find(|x| x.site == "TP9").unwrap();
    println!("repaired: TP9 why {:?}, artifacts {:?}", sp.why, last.quality[0].artifacts);
    assert_eq!(sp.why, Reason::Ok);
    assert!(last.quality[0].artifacts.contains(&ArtifactKind::Gap));
    assert!(track_near(last, 10.0, 0.5).is_some());

    // (b) One long gap of 1 s at 40 s: windows containing it are null with reason gap.
    let mut e = Engine::new(config(1, &[])).unwrap();
    let g0 = (40.0 * RATE) as usize;
    let g1 = g0 + 256;
    let mut frames = run_engine(&mut e, &data[..g0 * nch], nch, 12);
    e.push_eeg(g1 as u64, &data[g1 * nch..]);
    frames.extend(e.drain());
    let s = slow(&frames);
    for f in &s {
        if f.t > 40.5 && f.t < 47.5 {
            for sp in &f.spectra {
                assert_eq!(sp.why, Reason::Gap, "t {} site {}", f.t, sp.site);
                assert!(sp.psd.is_empty() && sp.bg_exponent.v.is_none());
            }
        }
    }
    let late = s.iter().find(|f| f.t > 50.0).unwrap();
    assert_eq!(late.spectra.iter().find(|x| x.site == "TP9").unwrap().why, Reason::Ok);
    // Fast frames during the gap carry no invented values.
    for f in fast(&frames) {
        if f.t > 40.1 && f.t < 40.9 {
            assert!(f.artifact);
            for tr in &f.tracks {
                assert!(tr.freq.v.is_none() && tr.amp_uv.v.is_none(), "value during a gap: {tr:?}");
            }
        }
    }
    // Recovery: alpha re-confirmed after the gap.
    assert!(track_near(s.last().unwrap(), 10.0, 0.5).is_some());

    // (c) A 12-sample gap every 256 samples (4.7%): more than 2% repaired, not analysed.
    let mut e = Engine::new(config(1, &[])).unwrap();
    let mut frames = Vec::new();
    let mut i = 0usize;
    while i + 24 <= n {
        e.push_eeg(i as u64, &data[i * nch..(i + 12) * nch]);
        frames.extend(e.drain());
        i += if (i / 12) % 21 == 20 { 24 } else { 12 };
    }
    let s = slow(&frames);
    let last = s.last().unwrap();
    assert!(last.spectra.iter().all(|x| x.why == Reason::Gap), "{:?}", last.spectra.iter().map(|x| x.why).collect::<Vec<_>>());
}

#[test]
fn deterministic_and_chunking_invariant() {
    let p = phi();
    let rh: Vec<Rhythm> = [10.0 / p, 10.0, 10.0 * p].iter().map(|&f| Rhythm { f, bw: 0.3, snr_db: 10.0 }).collect();
    let ch = four((70.0 * RATE) as usize, 1.5, &rh, 12.0, 81);
    let data = interleave(&ch);
    let a = {
        let mut e = Engine::new(config(5, &[])).unwrap();
        to_jsonl(&run_engine(&mut e, &data, 4, 12))
    };
    let b = {
        let mut e = Engine::new(config(5, &[])).unwrap();
        to_jsonl(&run_engine(&mut e, &data, 4, 12))
    };
    let c = {
        let mut e = Engine::new(config(5, &[])).unwrap();
        to_jsonl(&run_engine(&mut e, &data, 4, 37))
    };
    assert!(a.len() > 1000);
    assert!(a == b, "same input twice gave different output");
    assert!(a == c, "chunking changed the output");
    // A different seed changes only surrogate-derived values, never the measurements.
    let d = {
        let mut e = Engine::new(config(6, &[])).unwrap();
        run_engine(&mut e, &data, 4, 12)
    };
    let ea = {
        let mut e = Engine::new(config(5, &[])).unwrap();
        run_engine(&mut e, &data, 4, 12)
    };
    for (x, y) in slow(&ea).iter().zip(slow(&d).iter()) {
        assert_eq!(x.tracks, y.tracks);
        assert_eq!(x.spectra, y.spectra);
    }
}

fn walk(v: &serde_json::Value, path: &str, bad: &mut Vec<String>, count: &mut usize) {
    match v {
        serde_json::Value::Object(o) => {
            if o.contains_key("v") && o.contains_key("why") {
                *count += 1;
                let vnull = o["v"].is_null();
                let ok = o["why"] == "ok";
                if vnull == ok {
                    bad.push(format!("{path}: {v}"));
                }
                if vnull && o.get("se").is_some_and(|s| !s.is_null()) {
                    bad.push(format!("{path}: se without value {v}"));
                }
            }
            for (k, x) in o {
                walk(x, &format!("{path}.{k}"), bad, count);
            }
        }
        serde_json::Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                walk(x, &format!("{path}[{i}]"), bad, count);
            }
        }
        _ => {}
    }
}

#[test]
fn null_is_never_zero_and_always_has_a_reason() {
    let p = phi();
    let rh: Vec<Rhythm> = [10.0 / p, 10.0].iter().map(|&f| Rhythm { f, bw: 0.3, snr_db: 10.0 }).collect();
    let mut ch = four((40.0 * RATE) as usize, 1.5, &rh, 12.0, 91);
    // A blink burst so artifact nulls appear too.
    for i in (20 * 256)..(20 * 256 + 80) {
        ch[1][i] += 200.0;
        ch[2][i] += 200.0;
    }
    let (frames, _) = run(&ch, 1, &[]);
    let mut bad = Vec::new();
    let mut count = 0;
    for f in &frames {
        let v = serde_json::to_value(f).unwrap();
        walk(&v, "frame", &mut bad, &mut count);
    }
    assert!(count > 10_000);
    assert!(bad.is_empty(), "{} bad Measured values, first: {:?}", bad.len(), bad.first());
    // During warm-up everything is null with a reason, never a zero stand-in.
    let s = slow(&frames);
    let early = s[3];
    for sp in &early.spectra {
        assert_eq!(sp.why, Reason::WarmingUp);
        assert!(sp.psd.is_empty() && sp.flat.is_empty());
        assert!(sp.bands.alpha.above_bg_db.v.is_none() && sp.bands.alpha.above_bg_db.why == Reason::WarmingUp);
    }
    assert!(early.cascades.phi.closeness.v.is_none() && early.cascades.phi.excess_a.v.is_none());
    assert!(early.states.phi.stat.v.is_none() && !early.states.phi.active);
    // Frame JSON carries the contract's field names.
    let j = serde_json::to_value(&frames.iter().find(|f| matches!(f, Frame::Slow(_))).unwrap()).unwrap();
    for k in ["kind", "schema", "t", "window_s", "quality", "spectra", "tracks", "dominant", "pairs", "cascades", "states", "hemispheres", "front_back", "mains_hz", "iaf_hz", "band_edges"] {
        assert!(j.get(k).is_some(), "missing {k}");
    }
    assert_eq!(j["kind"], "slow");
}

#[test]
fn hemisphere_and_front_back_comparisons() {
    // Shared alpha source on all channels (plus independent background): strongly locked.
    let n = (60.0 * RATE) as usize;
    let mut rng = Rng::new(101);
    let shared = synth(n, 1.5, &[Rhythm { f: 10.0, bw: 0.3, snr_db: 20.0 }], 8.0, &mut rng);
    let ch: Vec<Vec<f64>> = (0..4).map(|_| {
        let bg = synth(n, 1.5, &[], 5.0, &mut rng);
        bg.iter().zip(shared.iter()).map(|(a, b)| a + b).collect()
    }).collect();
    let (frames, _) = run(&ch, 1, &[]);
    let last = *slow(&frames).last().unwrap();
    println!("hemispheres {:?}\nfront_back {:?}", last.hemispheres, last.front_back);
    let h = last.hemispheres.first().expect("hemisphere comparison");
    assert!(h.freq_diff.v.unwrap().abs() < 0.3);
    assert!(h.locking_excess.v.unwrap() > 0.5);
    assert!(h.balance.v.unwrap().abs() < 0.3);
    assert!(!last.front_back.is_empty());
}

#[test]
fn params_are_echoed_and_overridable() {
    let e = Engine::new(config(1, &[("tolerance", ParamValue::Num(0.02)), ("slow_window_s", ParamValue::Num(4.0))])).unwrap();
    let pm = e.params();
    assert_eq!(pm["tolerance"], ParamValue::Num(0.02));
    assert_eq!(pm["alpha_peak"], ParamValue::Num(0.01));
    assert_eq!(pm["surrogates"], ParamValue::Num(200.0));
    assert!(Engine::new(config(1, &[("no_such_param", ParamValue::Num(1.0))])).is_err());
    assert!(Engine::new(config(1, &[("tolerance", ParamValue::Str("x".into()))])).is_err());
}

#[test]
fn four_second_window_option_runs() {
    let ch = sine_plus_bg(40.0, 10.0, 10.0, 12);
    let (frames, _) = run(&ch, 1, &[("slow_window_s", ParamValue::Num(4.0))]);
    let last = *slow(&frames).last().unwrap();
    assert_eq!(last.window_s, 4.0);
    let tr = track_near(last, 10.0, 0.3).expect("track");
    let sp = last.spectra.iter().find(|s| s.site == "TP9").unwrap();
    assert_eq!(sp.k, 3);
    assert!((tr.freq_integrated.v.unwrap() - 10.0).abs() < 0.1);
}

#[test]
fn slow_update_timing() {
    let p = phi();
    let rh: Vec<Rhythm> = [10.0 / p, 10.0, 10.0 * p, 20.0].iter().map(|&f| Rhythm { f, bw: 0.3, snr_db: 10.0 }).collect();
    let ch = four((180.0 * RATE) as usize, 1.5, &rh, 12.0, 111);
    let data = interleave(&ch);
    let mut e = Engine::new(config(1, &[])).unwrap();
    let nch = 4;
    let n = ch[0].len();
    let mut times = Vec::new();
    let mut i = 0;
    while i < n {
        let t0 = std::time::Instant::now();
        e.push_eeg(i as u64, &data[i * nch..(i + 64) * nch]);
        let dt = t0.elapsed().as_secs_f64() * 1000.0;
        let _ = e.drain();
        if i as f64 > 130.0 * RATE {
            times.push(dt);
        }
        i += 64;
    }
    times.sort_by(|a, b| a.total_cmp(b));
    let mean = times.iter().sum::<f64>() / times.len() as f64;
    let p50 = times[times.len() / 2];
    let p99 = times[times.len() * 99 / 100];
    let max = *times.last().unwrap();
    println!("slow update (64 samples incl. one slow update, 4 ch, ~4 tracks, chance B active): mean {mean:.2} ms, median {p50:.2} ms, p99 {p99:.2} ms, max {max:.2} ms; chance refreshes {} (B {})",
        e.diagnostics().chance_refreshes, e.diagnostics().chance_b_refreshes);
    if !cfg!(debug_assertions) {
        assert!(p50 < 50.0);
    }
}
