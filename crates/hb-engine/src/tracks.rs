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

impl TrackInt {
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

    /// Update the integrated frequency: precision-weighted mean of the window estimates over
    /// the integration time. The 8 s windows overlap, so the naive standard error is inflated
    /// by sqrt(n / n_eff), n_eff the number of non-overlapping windows spanned; and it is never
    /// smaller than the scatter of the estimates allows (a wandering rhythm is less certain).
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
        let (mut sw, mut swf) = (0.0, 0.0);
        for &(_, f, se) in &self.win {
            let w = 1.0 / (se * se);
            sw += w;
            swf += w * f;
        }
        let fm = swf / sw;
        let n = self.win.len() as f64;
        let span = self.win.back().unwrap().0 - self.win.front().unwrap().0;
        let n_eff = ((span + window_s) / window_s).min(n).max(1.0);
        let se1 = m::sqrt(1.0 / sw) * m::sqrt(n / n_eff);
        let var = self.win.iter().map(|&(_, f, se)| (f - fm) * (f - fm) / (se * se)).sum::<f64>() / sw;
        let se2 = m::sqrt(var / n_eff);
        self.f_int = Some((fm, se1.max(se2)));
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
