//! Peak tracks (spec 6.5) and the integrated frequency (spec 6.4).

use crate::m;
use crate::params::Params;
use crate::spectral::Peak;
use std::collections::VecDeque;

/// One confirmed observation for this update: the strongest site's peak.
#[derive(Clone, Debug)]
pub struct Obs {
    pub site: usize,
    pub peak: Peak,
}

#[derive(Clone, Debug)]
pub struct TrackInt {
    pub id: u32,
    pub born_t: f64,
    pub last_pass_t: f64,
    pub site: usize,
    /// This update's observation, if the peak passed.
    pub cur: Option<Peak>,
    pub last_f: f64,
    pub last_se: f64,
    pub last_width: f64,
    /// Window estimates within the integration time: (t, f, se).
    pub win: VecDeque<(f64, f64, f64)>,
    /// Integrated frequency and its standard error, this update.
    pub f_int: Option<(f64, f64)>,
    /// Integrated-frequency history, one entry per slow update (for chance B).
    pub hist_f: Vec<f64>,
    pub hist_se: Vec<f64>,
    pub hist_t0: f64,
    /// Passing peak matched to this track at each site this update.
    pub per_site: Vec<Option<Peak>>,
}

/// Distance within which two frequency estimates are the same rhythm (spec 6.5).
pub fn join_dist(se_a: f64, se_b: f64, p: &Params) -> f64 {
    (p.track_join_se * m::sqrt(se_a * se_a + se_b * se_b)).max(p.track_join_hz)
}

/// The joining distance at frequency `f` (spec 6.5): `join_dist`, but never more than the
/// larger of `track_join_hz` and `track_join_max_rel` of the frequency.
///
/// The uncertainty term alone has no upper limit. One window's centre of a rhythm a few
/// tenths of a hertz wide can carry a jackknife error of 0.5 Hz, which makes "three standard
/// errors" 2 Hz: wider than the gap between neighbouring rhythms in the theta range. A track
/// whose own rhythm was absent for a window then took its neighbour's peak, and tracks walked
/// from rhythm to rhythm (fake test 2: one track read 3.1, 3.6, 4.2, 4.7, 5.0, 5.5, 6.1,
/// 6.7 Hz over 50 s across three planted rhythms).
pub fn join_dist_at(f: f64, se_a: f64, se_b: f64, p: &Params) -> f64 {
    join_dist(se_a, se_b, p).min(p.track_join_hz.max(p.track_join_max_rel * f))
}

impl TrackInt {
    /// Where this track's rhythm is taken to be when a new peak is matched to it: the
    /// integrated frequency (steady) if there is one, else the last window's centre.
    pub fn ref_f(&self) -> (f64, f64) {
        self.f_int.unwrap_or((self.last_f, self.last_se))
    }

    pub fn new(id: u32, t: f64, o: &Obs, nsites: usize) -> Self {
        TrackInt {
            id,
            born_t: t,
            last_pass_t: t,
            site: o.site,
            cur: Some(o.peak.clone()),
            last_f: o.peak.f,
            last_se: o.peak.se,
            last_width: o.peak.width,
            win: VecDeque::new(),
            f_int: None,
            hist_f: Vec::new(),
            hist_se: Vec::new(),
            hist_t0: t,
            per_site: vec![None; nsites],
        }
    }

    pub fn observe(&mut self, t: f64, o: &Obs) {
        self.cur = Some(o.peak.clone());
        self.site = o.site;
        self.last_f = o.peak.f;
        self.last_se = o.peak.se;
        self.last_width = o.peak.width;
        self.last_pass_t = t;
    }

    /// Update the integrated frequency (spec 6.4): the plain mean of the window estimates over
    /// the integration time, with a standard error that pools two variance estimates.
    ///
    /// - v1, from the windows' own jackknife errors: mean(se^2) / n_eff, where n_eff is the
    ///   number of non-overlapping windows spanned (the 8 s windows overlap, so the n estimates
    ///   are worth far fewer).
    /// - v2, from the scatter of the estimates themselves: mean((f - mean)^2) / (n_eff - 1),
    ///   the variance of a mean of n_eff independent values, with n_eff - 1 degrees of freedom.
    ///
    /// The result is (nu1 v1 + (n_eff - 1) v2) / (nu1 + n_eff - 1), nu1 = `integration_prior_dof`.
    /// Measured against planted rhythms (review, November 2026): the jackknife error of one
    /// window is about 1.7 times too large for rhythms 0.25 Hz wide and 1.6 to 1.8 times too
    /// small for rhythms 1 Hz wide, so v1 alone is wrong in both directions; the scatter is
    /// right on average but rests on four or five independent windows. Pooled, the reported
    /// error is within a factor 1.5 of the actual error across widths of 0.25 to 1 Hz.
    ///
    /// The mean is not precision-weighted. Weights of 1/se^2 from seven-taper jackknife errors
    /// are noisy and favour windows whose error happens to come out small; that made the
    /// actual error 20 to 30 % larger and the reported one smaller.
    ///
    /// While the estimates span less than two windows there is no scatter to pool, and the
    /// jackknife error is inflated by `integration_young_se_factor`, which covers its worst
    /// measured shortfall.
    pub fn integrate(&mut self, t: f64, window_s: f64, p: &Params) {
        if let Some(pk) = &self.cur {
            self.win.push_back((t, pk.f, pk.se));
        }
        while let Some(&(t0, _, _)) = self.win.front() {
            if t - t0 > p.integration_s {
                self.win.pop_front();
            } else {
                break;
            }
        }
        if self.win.is_empty() {
            self.f_int = None;
            return;
        }
        let n = self.win.len() as f64;
        let fm = self.win.iter().map(|w| w.1).sum::<f64>() / n;
        let span = self.win.back().unwrap().0 - self.win.front().unwrap().0;
        // Independent windows behind the estimates: the span in windows, but no more than
        // the time actually covered (a track that paused and resumed has a hole in its span).
        let covered = n * p.slow_update_s;
        let n_eff = ((span + window_s) / window_s).min((covered + window_s) / window_s).min(n).max(1.0);
        let v1 = self.win.iter().map(|w| w.2 * w.2).sum::<f64>() / n / n_eff;
        let var = if n_eff >= 2.0 {
            let v2 = self.win.iter().map(|w| (w.1 - fm) * (w.1 - fm)).sum::<f64>() / n / (n_eff - 1.0);
            let nu1 = p.integration_prior_dof.max(0.0);
            let nu2 = n_eff - 1.0;
            (nu1 * v1 + nu2 * v2) / (nu1 + nu2)
        } else {
            let k = p.integration_young_se_factor.max(1.0);
            v1 * k * k
        };
        self.f_int = Some((fm, m::sqrt(var).max(p.freq_se_floor_hz / m::sqrt(n_eff))));
    }

    pub fn push_history(&mut self, cap: usize) {
        if let Some((f, se)) = self.f_int {
            self.hist_f.push(f);
            self.hist_se.push(se);
            if self.hist_f.len() > cap {
                let d = self.hist_f.len() - cap;
                self.hist_f.drain(0..d);
                self.hist_se.drain(0..d);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prng::Rng;

    fn track_with(win: &[(f64, f64, f64)]) -> TrackInt {
        let pk = Peak { f: 10.0, se: 0.1, h: 5.0, h_db_se: None, width: 1.0 };
        let mut t = TrackInt::new(1, 0.0, &Obs { site: 0, peak: pk }, 1);
        t.cur = None;
        t.win = win.iter().copied().collect();
        t
    }

    /// Window estimates every 250 ms from overlapping 8 s windows, modelled as a moving
    /// average of white noise over 32 updates. The reported error of the integrated
    /// frequency must match the actual spread whether the windows' own errors are right,
    /// 1.7 times too large or 1.7 times too small (both were measured on planted rhythms).
    #[test]
    fn integrated_error_follows_the_scatter_not_only_the_window_errors() {
        let p = Params::default();
        let sd_window = 0.2;
        for &claim in &[1.0, 1.7, 1.0 / 1.7] {
            let mut rng = Rng::new(11);
            let (mut errs, mut ses) = (Vec::new(), Vec::new());
            for _ in 0..600 {
                let n = 121usize;
                let noise: Vec<f64> = (0..n + 32).map(|_| rng.normal()).collect();
                let win: Vec<(f64, f64, f64)> = (0..n)
                    .map(|k| {
                        let avg = noise[k..k + 32].iter().sum::<f64>() / 32.0 * (32f64).sqrt();
                        (100.0 + 0.25 * k as f64, 10.0 + sd_window * avg, sd_window * claim)
                    })
                    .collect();
                let mut t = track_with(&win);
                t.integrate(130.0, 8.0, &p);
                let (f, se) = t.f_int.unwrap();
                errs.push(f - 10.0);
                ses.push(se);
            }
            let n = errs.len() as f64;
            let rms = m::sqrt(errs.iter().map(|e| e * e).sum::<f64>() / n);
            let mean_se = ses.iter().sum::<f64>() / n;
            println!("window errors claimed x{claim:.2}: actual {rms:.4}, reported {mean_se:.4}, ratio {:.2}", rms / mean_se);
            assert!(rms / mean_se < 1.5 && rms / mean_se > 1.0 / 1.5, "claim x{claim}: actual/reported {}", rms / mean_se);
        }
    }

    /// With less than two windows of span there is no scatter to pool: the error is the
    /// windows' own, inflated, and never below one window's jackknife error.
    #[test]
    fn young_track_error_is_inflated() {
        let p = Params::default();
        let win: Vec<(f64, f64, f64)> = (0..8).map(|k| (20.0 + 0.25 * k as f64, 10.0, 0.1)).collect();
        let mut t = track_with(&win);
        t.integrate(22.0, 8.0, &p);
        let (_, se) = t.f_int.unwrap();
        assert!(se >= 0.1, "{se}");
        t.win.clear();
        t.integrate(22.0, 8.0, &p);
        assert!(t.f_int.is_none());
    }
}
