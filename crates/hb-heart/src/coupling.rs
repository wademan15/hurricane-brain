//! Brain-heart coupling with time-shifted surrogates.
//!
//! Both series live on the same 4 Hz grid over the coupling window. For each brain series two
//! measures are computed:
//!
//! - **correlation**: Pearson correlation between the heart rate series and the brain series, both
//!   band-passed to `coupling_lo_hz..coupling_hi_hz`, over samples where both are valid and at least
//!   `coupling_edge_s` from the window ends. Band-passing is required for an honest null: two
//!   unrelated random walks correlate strongly by accident, and a circular shift of a drifting series
//!   does not reproduce that (measured: 14.5% false positives at alpha 0.05 on detrended random
//!   walks, against 5% after band-passing; see NOTES.md).
//! - **phase_locking**: phase locking value |mean(exp(i(phi_heart - phi_brain)))| of the two series'
//!   analytic signals in `coupling_lo_hz..coupling_hi_hz`, over samples where both are valid and at
//!   least `coupling_edge_s` from the ends of the window.
//!
//! The chance level comes from circularly shifting the prepared brain series (values and mask)
//! by a random lag of at least `coupling_min_lag_s` and running the identical statistic function.
//! The observed value is that same function at lag 0. Detrending and the circular FFT band-pass are
//! done once per series before shifting; the circular band-pass commutes with a circular shift, so
//! shifting after filtering equals filtering after shifting.

use crate::dsp::{analytic_bandpass, detrend, fnv1a, Rng};
use crate::params::HeartParams;
use crate::types::{Coupling, Measured, Reason};

/// Prepared inputs for one pair of series (window length N, same grid).
pub struct Prepared {
    /// Band-passed values (real part of the analytic signal).
    pub hr: Vec<f64>,
    pub br: Vec<f64>,
    /// Analytic signals, unit phasors (0 where unusable).
    pub hr_ph: Vec<(f64, f64)>,
    pub hr_ph_ok: Vec<bool>,
    pub br_ph: Vec<(f64, f64)>,
    pub br_ph_ok: Vec<bool>,
}

/// Returns (band-passed values, unit phasors, usable mask).
fn prepare_one(x: &[f64], ok: &[bool], fs: f64, lo: f64, hi: f64, edge: usize) -> (Vec<f64>, Vec<(f64, f64)>, Vec<bool>) {
    let n = x.len();
    let mut d = detrend(x, Some(ok));
    for i in 0..n {
        if !ok[i] {
            d[i] = 0.0;
        }
    }
    let (re, im) = analytic_bandpass(&d, fs, lo, hi);
    let mut ph = vec![(0.0, 0.0); n];
    let mut ph_ok = vec![false; n];
    for i in 0..n {
        let a = (re[i] * re[i] + im[i] * im[i]).sqrt();
        if ok[i] && i >= edge && i + edge < n && a > 0.0 {
            ph[i] = (re[i] / a, im[i] / a);
            ph_ok[i] = true;
        }
    }
    (re, ph, ph_ok)
}

pub fn prepare(p: &HeartParams, fs: f64, hr: &[f64], hr_ok: &[bool], br: &[f64], br_ok: &[bool]) -> Prepared {
    let edge = (p.coupling_edge_s * fs).round() as usize;
    let (h, hp, hpo) = prepare_one(hr, hr_ok, fs, p.coupling_lo_hz, p.coupling_hi_hz, edge);
    let (b, bp, bpo) = prepare_one(br, br_ok, fs, p.coupling_lo_hz, p.coupling_hi_hz, edge);
    Prepared { hr: h, br: b, hr_ph: hp, hr_ph_ok: hpo, br_ph: bp, br_ph_ok: bpo }
}

/// Pearson correlation of band-passed hr[i] with br[(i + lag) mod N] over jointly usable samples.
/// Returns (r, number of joint samples).
pub fn correlation_at(pr: &Prepared, lag: usize) -> (f64, usize) {
    let n = pr.hr.len();
    let (mut c, mut sx, mut sy) = (0usize, 0.0, 0.0);
    for i in 0..n {
        let j = (i + lag) % n;
        if pr.hr_ph_ok[i] && pr.br_ph_ok[j] {
            c += 1;
            sx += pr.hr[i];
            sy += pr.br[j];
        }
    }
    if c < 3 {
        return (f64::NAN, c);
    }
    let (mx, my) = (sx / c as f64, sy / c as f64);
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let j = (i + lag) % n;
        if pr.hr_ph_ok[i] && pr.br_ph_ok[j] {
            let (dx, dy) = (pr.hr[i] - mx, pr.br[j] - my);
            sxy += dx * dy;
            sxx += dx * dx;
            syy += dy * dy;
        }
    }
    if sxx <= 0.0 || syy <= 0.0 {
        return (f64::NAN, c);
    }
    (sxy / (sxx * syy).sqrt(), c)
}

/// Phase locking value of the heart phase against the brain phase shifted by lag.
pub fn plv_at(pr: &Prepared, lag: usize) -> (f64, usize) {
    let n = pr.hr_ph.len();
    let (mut c, mut sr, mut si) = (0usize, 0.0, 0.0);
    for i in 0..n {
        let j = (i + lag) % n;
        if pr.hr_ph_ok[i] && pr.br_ph_ok[j] {
            let (ar, ai) = pr.hr_ph[i];
            let (br, bi) = pr.br_ph[j];
            // a * conj(b)
            sr += ar * br + ai * bi;
            si += ai * br - ar * bi;
            c += 1;
        }
    }
    if c < 3 {
        return (f64::NAN, c);
    }
    (((sr * sr + si * si).sqrt()) / c as f64, c)
}

/// Observed statistic with its surrogate chance level and p-value.
/// `stat` maps a lag to (value, joint samples); `magnitude` is what is compared (|r| or PLV).
pub fn with_surrogates(
    p: &HeartParams,
    fs: f64,
    n: usize,
    rng: &mut Rng,
    stat: &dyn Fn(usize) -> (f64, usize),
    magnitude: fn(f64) -> f64,
) -> (Measured, Measured, Measured) {
    let min_joint = (p.coupling_min_overlap_s * fs).ceil() as usize;
    let (obs, c) = stat(0);
    if !obs.is_finite() || c < min_joint {
        let r = if obs.is_finite() { Reason::InsufficientClean } else { Reason::Unresolved };
        return (Measured::null(r), Measured::null(r), Measured::null(r));
    }
    let min_lag = (p.coupling_min_lag_s * fs).round() as usize;
    if n < 2 * min_lag + 2 {
        let r = Reason::InsufficientClean;
        return (Measured::ok(obs), Measured::null(r), Measured::null(r));
    }
    let want = p.coupling_surrogates.max(1.0) as usize;
    let obs_m = magnitude(obs);
    let (mut sum, mut used, mut ge) = (0.0, 0usize, 0usize);
    // Draw lags; a lag whose shifted overlap is too small is redrawn (bounded attempts).
    let mut attempts = 0;
    while used < want && attempts < want * 4 {
        attempts += 1;
        let lag = rng.range(min_lag, n - min_lag);
        let (v, cj) = stat(lag);
        if !v.is_finite() || cj < min_joint / 2 {
            continue;
        }
        let m = magnitude(v);
        sum += m;
        used += 1;
        if m >= obs_m {
            ge += 1;
        }
    }
    if used < want / 2 {
        let r = Reason::InsufficientClean;
        return (Measured::ok(obs), Measured::null(r), Measured::null(r));
    }
    let chance = sum / used as f64;
    // p with the +1 correction (the observed counts as one of the null draws), never 0.
    let pval = (1 + ge) as f64 / (1 + used) as f64;
    (Measured::ok(obs), Measured::ok(chance), Measured::ok(pval))
}

/// Both coupling measures for one brain series. `seed` is the session seed; the surrogate stream is
/// derived from it, the series name and the window's end grid index, so it does not depend on
/// call history.
#[allow(clippy::too_many_arguments)]
pub fn couple(
    p: &HeartParams,
    seed: u64,
    name: &str,
    g_end: i64,
    fs: f64,
    hr: &[f64],
    hr_ok: &[bool],
    br: &[f64],
    br_ok: &[bool],
    suspect_artifact: bool,
    warming: bool,
) -> Vec<Coupling> {
    let mk = |measure: &str, v: Measured, c: Measured, pv: Measured| Coupling {
        brain: name.to_string(),
        measure: measure.to_string(),
        value: v,
        chance: c,
        p: pv,
        suspect_artifact,
    };
    let null_both = |r: Reason| {
        let m = Measured::null(r);
        vec![mk("correlation", m, m, m), mk("phase_locking", m, m, m)]
    };
    if suspect_artifact {
        // Spec 13: likely pulse leaking into the EEG; not reported as coupling.
        return null_both(Reason::Artifact);
    }
    let n = hr.len();
    let joint = (0..n).filter(|&i| hr_ok[i] && br_ok[i]).count();
    let min_joint = (p.coupling_min_overlap_s * fs).ceil() as usize;
    if joint < min_joint {
        return null_both(if warming { Reason::WarmingUp } else { Reason::InsufficientClean });
    }
    let pr = prepare(p, fs, hr, hr_ok, br, br_ok);
    let base = seed ^ fnv1a(name).rotate_left(17) ^ (g_end as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut rng_c = Rng::new(base ^ 0xC0);
    let mut rng_p = Rng::new(base ^ 0x9A);
    let (cv, cc, cp) = with_surrogates(p, fs, n, &mut rng_c, &|lag| correlation_at(&pr, lag), |r: f64| r.abs());
    let (pv, pc, pp) = with_surrogates(p, fs, n, &mut rng_p, &|lag| plv_at(&pr, lag), |x: f64| x);
    vec![mk("correlation", cv, cc, cp), mk("phase_locking", pv, pc, pp)]
}
