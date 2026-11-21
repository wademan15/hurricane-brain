mod common;

use common::*;
use hb_heart::coupling::couple;
use hb_heart::dsp::Rng;
use hb_heart::{HeartParams, Reason};

const FS: f64 = 4.0;

fn random_walk(rng: &mut Rng, n: usize, step: f64, start: f64) -> Vec<f64> {
    let mut x = start;
    (0..n)
        .map(|_| {
            x += step * rng.normal();
            x
        })
        .collect()
}

/// Smooth band-limited rhythm in the coupling band: sum of a few slow sinusoids with random phases.
fn slow_rhythm(rng: &mut Rng, n: usize) -> Vec<f64> {
    let comps: Vec<(f64, f64)> = (0..4).map(|_| (0.05 + 0.15 * rng.uniform(), std::f64::consts::TAU * rng.uniform())).collect();
    (0..n).map(|i| comps.iter().map(|(f, ph)| (std::f64::consts::TAU * f * i as f64 / FS + ph).sin()).sum::<f64>()).collect()
}

struct Rates {
    corr_fp: usize,
    plv_fp: usize,
    n: usize,
}

fn run_direct(seeds: u64, planted: bool) -> Rates {
    run_direct_lag(seeds, planted, 0)
}

fn run_direct_lag(seeds: u64, planted: bool, lag: usize) -> Rates {
    let p = HeartParams::default();
    let n = (p.coupling_window_s * FS) as usize;
    let mut r = Rates { corr_fp: 0, plv_fp: 0, n: 0 };
    for seed in 0..seeds {
        let mut rng = Rng::new(10_000 + seed);
        let hr = {
            let w = random_walk(&mut rng, n, 0.25, 70.0);
            let s = slow_rhythm(&mut rng, n);
            w.iter().zip(&s).map(|(a, b)| a + 1.5 * b).collect::<Vec<_>>()
        };
        let mut br = random_walk(&mut rng, n, 0.05, 0.0);
        let noise: Vec<f64> = (0..n).map(|_| rng.normal()).collect();
        for i in 0..n {
            br[i] += 0.3 * noise[i];
            if planted {
                // Brain series follows the heart rate (after `lag` samples) at a modest strength.
                let j = i.saturating_sub(lag);
                br[i] += 0.15 * (hr[j] - 70.0);
            }
        }
        // 5% of brain samples missing (artifact gating), in short runs.
        let mut br_ok = vec![true; n];
        let mut i = 0;
        while i < n {
            if rng.uniform() < 0.01 {
                for k in i..(i + 5).min(n) {
                    br_ok[k] = false;
                }
            }
            i += 1;
        }
        let hr_ok = vec![true; n];
        let out = couple(&p, seed, "alpha.above_bg_db@temporal", 1000 + n as i64, FS, &hr, &hr_ok, &br, &br_ok, false, false);
        assert_eq!(out.len(), 2);
        let pc = out[0].p.v.unwrap();
        let pp = out[1].p.v.unwrap();
        r.n += 1;
        if pc < 0.05 {
            r.corr_fp += 1;
        }
        if pp < 0.05 {
            r.plv_fp += 1;
        }
    }
    r
}

#[test]
fn independent_random_walks_show_no_coupling_at_the_stated_rate() {
    let r = run_direct(400, false);
    let fc = r.corr_fp as f64 / r.n as f64;
    let fp = r.plv_fp as f64 / r.n as f64;
    println!("independent slow series, {} seeds, alpha 0.05: correlation false positive rate {fc:.4}, phase locking {fp:.4}", r.n);
    // Binomial(400, 0.05): mean 20, sd 4.4. Allow up to mean + 3 sd.
    assert!(fc <= 0.083, "correlation false positives {fc}");
    assert!(fp <= 0.083, "phase locking false positives {fp}");
}

#[test]
fn planted_coupling_is_detected() {
    let r = run_direct(100, true);
    let dc = r.corr_fp as f64 / r.n as f64;
    let dp = r.plv_fp as f64 / r.n as f64;
    println!("planted coupling at zero lag, {} seeds: correlation detected {dc:.3}, phase locking detected {dp:.3}", r.n);
    assert!(dc >= 0.9, "correlation detection {dc}");
    assert!(dp >= 0.9, "phase locking detection {dp}");
    // With the brain series 1 s behind, zero-lag correlation loses part of the band (a 1 s lag is
    // 72 degrees at 0.2 Hz); phase locking does not care about a constant lag.
    let r = run_direct_lag(100, true, 4);
    let dc = r.corr_fp as f64 / r.n as f64;
    let dp = r.plv_fp as f64 / r.n as f64;
    println!("planted coupling at 1 s lag, {} seeds: correlation detected {dc:.3}, phase locking detected {dp:.3}", r.n);
    assert!(dp >= 0.9, "phase locking detection {dp}");
}

#[test]
fn naive_correlation_would_mislead() {
    // The plain correlation of two independent random walks is often large; the engine's
    // band-passed correlation with its time-shifted chance level does not call them coupled.
    let p = HeartParams::default();
    let n = (p.coupling_window_s * FS) as usize;
    let (mut big, mut big_called) = (0, 0);
    for seed in 0..100u64 {
        let mut rng = Rng::new(77_000 + seed);
        let hr = random_walk(&mut rng, n, 0.25, 70.0);
        let br = random_walk(&mut rng, n, 0.05, 0.0);
        let (a, b) = (hb_heart::dsp::detrend(&hr, None), hb_heart::dsp::detrend(&br, None));
        let sab: f64 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
        let r_naive = sab / (a.iter().map(|x| x * x).sum::<f64>() * b.iter().map(|x| x * x).sum::<f64>()).sqrt();
        let ok = vec![true; n];
        let out = couple(&p, seed, "x", n as i64, FS, &hr, &ok, &br, &ok, false, false);
        if r_naive.abs() > 0.3 {
            big += 1;
            if out[0].p.v.unwrap() < 0.05 {
                big_called += 1;
            }
        }
    }
    println!("independent random walks with naive detrended |r| > 0.3: {big} of 100; of those, engine p < 0.05: {big_called}");
    assert!(big > 20);
    assert!(big_called as f64 <= 0.1 * big as f64);
}

#[test]
fn coupling_needs_enough_overlap_and_honours_artifact_flag() {
    let p = HeartParams::default();
    let n = (p.coupling_window_s * FS) as usize;
    let mut rng = Rng::new(5);
    let hr = random_walk(&mut rng, n, 0.25, 70.0);
    let br = random_walk(&mut rng, n, 0.05, 0.0);
    let mut ok = vec![false; n];
    for k in n - 170 * 4..n {
        ok[k] = true;
    }
    let all = vec![true; n];
    let out = couple(&p, 1, "x", n as i64, FS, &hr, &all, &br, &ok, false, true);
    assert!(out.iter().all(|c| c.value.why == Reason::WarmingUp && c.p.why == Reason::WarmingUp));
    let out = couple(&p, 1, "x", n as i64, FS, &hr, &all, &br, &ok, false, false);
    assert!(out.iter().all(|c| c.value.why == Reason::InsufficientClean));
    let out = couple(&p, 1, "x", n as i64, FS, &hr, &all, &br, &all, true, false);
    assert!(out.iter().all(|c| c.suspect_artifact && c.value.why == Reason::Artifact && c.chance.v.is_none()));
}

/// End to end through the engine: heart rate from a random walk delivered as chest strap
/// intervals, brain series pushed at 4 Hz.
fn end_to_end(seed: u64, planted: bool) -> (f64, f64, Vec<hb_heart::HeartFrame>) {
    let mut rng = Rng::new(50_000 + seed);
    let dur = 330.0;
    let n = (dur * FS) as usize;
    let hr_walk = random_walk(&mut rng, n, 0.2, 70.0);
    let rhythm = slow_rhythm(&mut rng, n);
    let hr_at = |t: f64| {
        let k = ((t * FS) as usize).min(n - 1);
        (hr_walk[k] + 1.5 * rhythm[k]).clamp(45.0, 110.0)
    };
    let mut ibis = Vec::new();
    let mut t = 0.0;
    while t < dur - 1.0 {
        let i = 60000.0 / hr_at(t);
        ibis.push(i);
        t += i / 1000.0;
    }
    let beats = beats_from_ibis(0.0, &ibis);
    let mut e = engine(seed);
    let mut br = 0.0;
    let mut bi = 0usize;
    let mut notif = 1.0;
    for k in 0..n {
        let tk = k as f64 / FS;
        while notif <= tk {
            let mut rr = Vec::new();
            while bi < beats.len() && beats[bi].0 <= notif {
                rr.push(beats[bi].1 as f32);
                bi += 1;
            }
            e.push_rr(notif + 0.05, &rr);
            notif += 1.0;
        }
        br += 0.05 * rng.normal();
        let mut v = br + 0.3 * rng.normal();
        if planted {
            v += 0.15 * (hr_at((tk - 1.0).max(0.0)) - 70.0);
        }
        e.push_brain(tk, "alpha.above_bg_db@temporal", Some(v));
    }
    let frames = e.drain();
    let last = frames.last().unwrap();
    let pc = last.coupling[0].p.v.unwrap();
    let pp = last.coupling[1].p.v.unwrap();
    (pc, pp, frames)
}

#[test]
fn end_to_end_coupling_rates() {
    let seeds = 40u64;
    let (mut fc, mut fp, mut dc, mut dp) = (0, 0, 0, 0);
    for seed in 0..seeds {
        let (pc, pp, frames) = end_to_end(seed, false);
        if seed == 0 {
            check_null_contract(&frames);
            // Warming up for the first 180 s of overlap.
            let early = frames.iter().find(|f| f.t > 100.0).unwrap();
            assert!(early.coupling.iter().all(|c| c.value.why == Reason::WarmingUp));
        }
        fc += (pc < 0.05) as usize;
        fp += (pp < 0.05) as usize;
        let (pc, pp, _) = end_to_end(seed, true);
        dc += (pc < 0.05) as usize;
        dp += (pp < 0.05) as usize;
    }
    println!(
        "end to end, {seeds} seeds: false positives correlation {fc}, phase locking {fp}; planted detected correlation {dc}, phase locking {dp}"
    );
    assert!(fc as f64 / seeds as f64 <= 0.125 && fp as f64 / seeds as f64 <= 0.125);
    assert!(dc as f64 / seeds as f64 >= 0.9 && dp as f64 / seeds as f64 >= 0.9);
}
