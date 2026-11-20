//! High variability state, relative to the person's own baseline, with the dwell and hysteresis
//! rules of spec section 8.4.
//!
//! The statistic is ln(current measure / baseline median), natural-log units. The baseline window
//! (`mark_baseline`) supplies the distribution of per-second values of the measure; the entry
//! threshold is its `high_hrv_enter_q` quantile (at least `high_hrv_min_rise` above the median),
//! the exit threshold its `high_hrv_exit_q` quantile, kept below entry. The state is entered after
//! the statistic stays at or above entry for `high_hrv_dwell_s`, and left when it falls below exit
//! or becomes null (a state that cannot be measured is not claimed).

use crate::dsp::{ln, median, quantile};
use crate::params::HeartParams;
use crate::types::{HighHrv, Measured, Reason};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Thresholds {
    pub median: f64,
    pub enter: f64,
    pub exit: f64,
}

#[derive(Debug, Clone, Default)]
pub struct HighState {
    /// Per whole second: the measure's value (last valid value seen in that second).
    history: BTreeMap<i64, f64>,
    baseline: Option<(f64, f64)>,
    thresholds: Option<Result<Thresholds, Reason>>,
    active: bool,
    since: Option<f64>,
    above_since: Option<f64>,
}

impl HighState {
    pub fn mark_baseline(&mut self, t0: f64, t1: f64) {
        self.baseline = Some((t0.min(t1), t0.max(t1)));
        self.thresholds = None;
    }

    pub fn clear_baseline(&mut self) {
        self.baseline = None;
        self.thresholds = None;
    }

    pub fn thresholds(&self) -> Option<Thresholds> {
        match self.thresholds {
            Some(Ok(th)) => Some(th),
            _ => None,
        }
    }

    /// Update with the measure's value at frame time t and return the frame field.
    pub fn update(&mut self, p: &HeartParams, t: f64, measure: Measured) -> HighHrv {
        if self.since.is_none() {
            self.since = Some(t);
        }
        if let Some(v) = measure.v {
            if v > 0.0 {
                self.history.insert(t.floor() as i64, v);
            }
        }
        // Keep at most six hours of per-second history.
        while self.history.len() > 6 * 3600 {
            let k = *self.history.keys().next().unwrap();
            self.history.remove(&k);
        }
        if self.thresholds.is_none() {
            if let Some((t0, t1)) = self.baseline {
                if t >= t1 {
                    let vals: Vec<f64> = self
                        .history
                        .range((t0.ceil() as i64)..=(t1.floor() as i64))
                        .map(|(_, &v)| ln(v))
                        .collect();
                    self.thresholds = Some(if (vals.len() as f64) < p.high_hrv_min_baseline_s {
                        Err(Reason::InsufficientClean)
                    } else {
                        let m = median(&vals);
                        let enter = (quantile(&vals, p.high_hrv_enter_q) - m).max(p.high_hrv_min_rise);
                        let exit = (quantile(&vals, p.high_hrv_exit_q) - m).max(0.0).min(enter - 0.5 * p.high_hrv_min_rise);
                        Ok(Thresholds { median: m, enter, exit })
                    });
                }
            }
        }
        let stat = match (&self.thresholds, measure.v) {
            (None, _) => Measured::null(if self.baseline.is_some() { Reason::WarmingUp } else { Reason::NotAvailable }),
            (Some(Err(r)), _) => Measured::null(*r),
            (Some(Ok(_)), None) => Measured::null(measure.why),
            (Some(Ok(th)), Some(v)) => {
                if v > 0.0 {
                    Measured::ok(ln(v) - th.median)
                } else {
                    Measured::null(Reason::Weak)
                }
            }
        };
        let th = self.thresholds();
        let was = self.active;
        match (th, stat.v) {
            (Some(th), Some(s)) => {
                if self.active {
                    if s < th.exit {
                        self.active = false;
                        self.above_since = None;
                    }
                } else if s >= th.enter {
                    let a = *self.above_since.get_or_insert(t);
                    if t - a >= p.high_hrv_dwell_s {
                        self.active = true;
                    }
                } else {
                    self.above_since = None;
                }
            }
            _ => {
                self.active = false;
                self.above_since = None;
            }
        }
        if was != self.active {
            self.since = Some(t);
        }
        HighHrv {
            active: self.active,
            for_s: (t - self.since.unwrap()).max(0.0),
            stat,
            enter_at: th.map(|x| x.enter),
            exit_at: th.map(|x| x.exit),
        }
    }
}
