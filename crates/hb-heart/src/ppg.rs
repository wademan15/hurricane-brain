//! Pulse detection from the headset's optical sensor (PPG), 64 Hz, up to 3 channels.
//!
//! Every `ppg_step_samples` samples (on a fixed grid of the sample index, so the result does not
//! depend on how the input was chunked) the last `ppg_window_s` of every channel is band-passed with
//! a zero-phase filter. Each channel gets a quality: the peak normalized autocorrelation at pulse
//! periods. The best channel (with a switching margin) is searched for pulse peaks in the stretch
//! that is at least `ppg_margin_s` old, so the zero-phase filter has data on both sides of it.
//! Peaks must pass an adaptive threshold (a fraction of the recent pulse amplitude) and a
//! refractory period; peak times are refined to sub-sample precision with a parabola.

use crate::dsp::{filtfilt_bandpass, median};
use crate::params::HeartParams;
use std::collections::VecDeque;

#[derive(Debug, Clone)]
struct Candidate {
    t: f64,
    amp: f64,
}

/// A detected pulse: time on the session clock and whether it continues the previous pulse
/// without a dropout.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pulse {
    pub t: f64,
    pub contiguous: bool,
}

#[derive(Debug, Clone, Default)]
pub struct PpgDetector {
    n_ch: usize,
    anchor_t: f64,
    started: bool,
    /// Samples received since the anchor.
    n_total: u64,
    /// Ring buffers, one per channel; buf[c][0] is sample index `buf_start`.
    buf: Vec<VecDeque<f64>>,
    buf_start: u64,
    next_step_end: u64,
    region_done: u64,
    active_ch: Option<usize>,
    /// Latest quality per channel (None before the first full analysis).
    pub quality: Vec<Option<f64>>,
    pending: Option<Candidate>,
    last_pulse_t: Option<f64>,
    last_pulse_segment: u64,
    segment: u64,
    recent_amps: VecDeque<f64>,
    out: Vec<Pulse>,
}

impl PpgDetector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Channel currently used for detection, if its quality passes.
    pub fn active_channel(&self) -> Option<usize> {
        self.active_ch
    }

    fn reset(&mut self, t_first: f64, n_ch: usize) {
        self.n_ch = n_ch;
        self.anchor_t = t_first;
        self.started = true;
        self.n_total = 0;
        self.buf = vec![VecDeque::new(); n_ch];
        self.buf_start = 0;
        self.next_step_end = 0;
        self.region_done = 0;
        self.active_ch = None;
        self.quality = vec![None; n_ch];
        self.pending = None;
        self.recent_amps.clear();
        self.segment += 1;
    }

    /// Time of the newest sample, if any.
    pub fn newest_t(&self, fs: f64) -> Option<f64> {
        if self.started && self.n_total > 0 {
            Some(self.anchor_t + (self.n_total - 1) as f64 / fs)
        } else {
            None
        }
    }

    /// Add samples (interleaved by channel). Returns pulses finalized during this call.
    pub fn push(&mut self, p: &HeartParams, t_first: f64, data: &[f32], n_ch: usize) -> Vec<Pulse> {
        let fs = p.ppg_rate_hz;
        if n_ch == 0 || data.len() < n_ch {
            return Vec::new();
        }
        let n_new = data.len() / n_ch;
        let expected = self.anchor_t + self.n_total as f64 / fs;
        if !self.started || n_ch != self.n_ch || (t_first - expected).abs() > 2.0 / fs {
            // First packet, a change of layout, or a gap: start a new segment.
            self.reset(t_first, n_ch);
        }
        for i in 0..n_new {
            for c in 0..n_ch {
                let v = data[i * n_ch + c] as f64;
                // A non-finite sample is a dropout of this channel; keep it as NaN, the
                // analysis rejects windows that contain one.
                self.buf[c].push_back(if v.is_finite() { v } else { f64::NAN });
            }
        }
        self.n_total += n_new as u64;
        let step = p.ppg_step_samples.max(1.0) as u64;
        if self.next_step_end == 0 {
            self.next_step_end = step;
        }
        while self.next_step_end <= self.n_total {
            let e = self.next_step_end;
            self.step(p, e);
            self.next_step_end += step;
        }
        // Keep only what the next window needs.
        let wlen = (p.ppg_window_s * fs).round() as u64;
        let keep_from = self.next_step_end.saturating_sub(wlen + step);
        while self.buf_start < keep_from {
            for c in 0..self.n_ch {
                self.buf[c].pop_front();
            }
            self.buf_start += 1;
        }
        std::mem::take(&mut self.out)
    }

    fn step(&mut self, p: &HeartParams, e: u64) {
        let fs = p.ppg_rate_hz;
        let wlen = (p.ppg_window_s * fs).round() as u64;
        let ws = e.saturating_sub(wlen).max(self.buf_start);
        let n = (e - ws) as usize;
        let margin = (p.ppg_margin_s * fs).round() as u64;
        if (n as f64) < p.ppg_min_window_s * fs {
            return;
        }
        let off = (ws - self.buf_start) as usize;
        // Filter and score every channel.
        let mut filtered: Vec<Option<Vec<f64>>> = Vec::with_capacity(self.n_ch);
        for c in 0..self.n_ch {
            let x: Vec<f64> = self.buf[c].range(off..off + n).copied().collect();
            if x.iter().any(|v| !v.is_finite()) {
                self.quality[c] = None;
                filtered.push(None);
                continue;
            }
            let y = filtfilt_bandpass(&x, fs, p.ppg_band_lo_hz, p.ppg_band_hi_hz, fs as usize);
            // Quality over the newest ppg_quality_window_s of the window, excluding the margin
            // (short, so that a changing heart rate does not smear the autocorrelation).
            let qe = n.saturating_sub((p.ppg_margin_s * fs * 0.5) as usize);
            let qs = qe.saturating_sub((p.ppg_quality_window_s * fs) as usize);
            self.quality[c] = Some(pulse_quality(&y[qs..qe], fs, p.ppg_refractory_s, p.ppg_max_period_s, p.ppg_regularity_tol));
            filtered.push(Some(y));
        }
        // Choose the channel.
        let best = (0..self.n_ch)
            .filter_map(|c| self.quality[c].map(|q| (c, q)))
            .fold(None::<(usize, f64)>, |acc, (c, q)| match acc {
                Some((_, bq)) if bq >= q => acc,
                _ => Some((c, q)),
            });
        let prev = self.active_ch;
        let mut chosen = match (prev, best) {
            (Some(a), Some((b, qb))) => match self.quality[a] {
                Some(qa) if qa + p.ppg_switch_margin >= qb => Some(a),
                _ => Some(b),
            },
            (_, Some((b, _))) => Some(b),
            _ => None,
        };
        if let Some(c) = chosen {
            if self.quality[c].map_or(true, |q| q < p.ppg_min_quality) {
                chosen = None;
            }
        }
        if chosen != prev {
            self.pending = None;
            self.recent_amps.clear();
            if chosen.is_none() {
                // Dropout: the next pulse does not continue the previous one.
                self.segment += 1;
            }
        }
        self.active_ch = chosen;

        // Region to search: [region_start, e - margin), never closer than margin to either end.
        let region_end = e.saturating_sub(margin);
        let region_start = self.region_done.max(ws + margin);
        if region_end <= region_start {
            return;
        }
        self.region_done = region_end;
        let c = match chosen {
            Some(c) => c,
            None => return,
        };
        let y = filtered[c].as_ref().unwrap();
        let refr = p.ppg_refractory_s;

        // Forget a stale amplitude memory.
        let region_end_t = self.anchor_t + region_end as f64 / fs;
        if let Some(lt) = self.last_pulse_t {
            if region_end_t - lt > p.ppg_amp_reset_s {
                self.recent_amps.clear();
            }
        }
        let reference = if self.recent_amps.len() >= 3 {
            median(&self.recent_amps.iter().copied().collect::<Vec<_>>())
        } else {
            y.iter().copied().fold(f64::NEG_INFINITY, f64::max)
        };
        let thr = p.ppg_threshold_frac * reference;

        // Look two samples back into the previous region: a peak on the boundary may fail the
        // local-maximum test in both windows by a rounding-level difference. A peak seen twice is
        // merged by the refractory logic.
        let search_start = region_start.saturating_sub(2).max(ws + 1);
        for abs in search_start..region_end {
            let i = (abs - ws) as usize;
            if i == 0 || i + 1 >= y.len() {
                continue;
            }
            let (y0, y1, y2) = (y[i - 1], y[i], y[i + 1]);
            if !(y1 > y0 && y1 >= y2 && y1 > thr && y1 > 0.0) {
                continue;
            }
            let den = y0 - 2.0 * y1 + y2;
            let d = if den != 0.0 { (0.5 * (y0 - y2) / den).clamp(-0.5, 0.5) } else { 0.0 };
            let amp = y1 - 0.25 * (y0 - y2) * d;
            let cand = Candidate { t: self.anchor_t + (abs as f64 + d) / fs, amp };
            match self.pending.take() {
                None => self.pending = Some(cand),
                Some(pd) => {
                    if cand.t - pd.t < refr {
                        self.pending = Some(if cand.amp > pd.amp { cand } else { pd });
                    } else {
                        self.finalize(pd, refr);
                        self.pending = Some(cand);
                    }
                }
            }
        }
        // A pending peak is final once the search has moved a refractory period past it.
        if let Some(pd) = self.pending.clone() {
            if region_end_t - pd.t >= refr {
                self.pending = None;
                self.finalize(pd, refr);
            }
        }
    }

    fn finalize(&mut self, c: Candidate, refr: f64) {
        if let Some(lt) = self.last_pulse_t {
            if c.t - lt < refr {
                return;
            }
        }
        let contiguous = self.last_pulse_t.is_some() && self.last_pulse_segment == self.segment;
        self.last_pulse_t = Some(c.t);
        self.last_pulse_segment = self.segment;
        self.recent_amps.push_back(c.amp);
        while self.recent_amps.len() > 8 {
            self.recent_amps.pop_front();
        }
        self.out.push(Pulse { t: c.t, contiguous });
    }
}

/// Channel quality, 0..1: the product of two measures over the analysis stretch.
///
/// - Periodicity: the peak normalized autocorrelation at lags between `min_period` and
///   `max_period` seconds (near 1 for a clean pulse at a steady rate, lowered by a changing rate).
/// - Regularity: the fraction of consecutive pulse-interval pairs that differ by less than
///   `reg_tol` of their median, from a simple peak pick (local maxima above 40% of the stretch
///   maximum, `min_period` apart). Band-limited noise passes the first sometimes, rarely both.
pub fn pulse_quality(y: &[f64], fs: f64, min_period: f64, max_period: f64, reg_tol: f64) -> f64 {
    autocorr_peak(y, fs, min_period, max_period) * regularity(y, fs, min_period, reg_tol)
}

fn regularity(y: &[f64], fs: f64, min_period: f64, tol: f64) -> f64 {
    let mx = y.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if !(mx > 0.0) {
        return 0.0;
    }
    let refr = (min_period * fs).round() as usize;
    let mut peaks: Vec<(usize, f64)> = Vec::new();
    for i in 1..y.len().saturating_sub(1) {
        if y[i] > y[i - 1] && y[i] >= y[i + 1] && y[i] > 0.4 * mx {
            match peaks.last_mut() {
                Some(last) if i - last.0 < refr => {
                    if y[i] > last.1 {
                        *last = (i, y[i]);
                    }
                }
                _ => peaks.push((i, y[i])),
            }
        }
    }
    if peaks.len() < 4 {
        return 0.0;
    }
    let iv: Vec<f64> = peaks.windows(2).map(|w| (w[1].0 - w[0].0) as f64).collect();
    let med = median(&iv);
    let good = iv.windows(2).filter(|w| (w[1] - w[0]).abs() < tol * med).count();
    good as f64 / (iv.len() - 1) as f64
}

fn autocorr_peak(y: &[f64], fs: f64, min_period: f64, max_period: f64) -> f64 {
    let n = y.len();
    let l0 = (min_period * fs).floor().max(1.0) as usize;
    let l1 = ((max_period * fs).ceil() as usize).min(n / 2);
    let mut best: f64 = 0.0;
    for lag in l0..=l1 {
        let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
        for i in 0..n - lag {
            sxy += y[i] * y[i + lag];
            sxx += y[i] * y[i];
            syy += y[i + lag] * y[i + lag];
        }
        if sxx > 0.0 && syy > 0.0 {
            best = best.max(sxy / (sxx * syy).sqrt());
        }
    }
    best
}
