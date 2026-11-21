//! Beat series per source, beat cleaning, and the chest strap clock.

use crate::dsp::median;
use crate::params::HeartParams;

/// One beat as stored by the engine.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BeatRec {
    /// Session time, s.
    pub t: f64,
    /// Interval ending at this beat, ms.
    pub ibi_ms: f64,
    /// Marked missed, extra, ectopic or out of physiological range by cleaning.
    pub flagged: bool,
    /// False when the previous beat of this source is not the one this interval started at
    /// (lost notifications, a pulse dropout, the first beat). Successive differences and
    /// resampling never span a non-contiguous beat.
    pub contiguous: bool,
}

impl BeatRec {
    pub fn clean(&self) -> bool {
        !self.flagged
    }
}

/// Time-ordered beats of one source, cleaned as they arrive.
#[derive(Debug, Clone, Default)]
pub struct BeatSeries {
    pub beats: Vec<BeatRec>,
    /// Total beats ever pushed (index of the next beat).
    pub total: u64,
    /// Time of the first beat ever, s.
    pub first_t: Option<f64>,
}

impl BeatSeries {
    pub fn last_t(&self) -> Option<f64> {
        self.beats.last().map(|b| b.t)
    }

    /// Clean and store one interval. Cleaning is causal: the interval is compared with the median
    /// of the preceding intervals (all of them, flagged or not, so a sustained change of rate is
    /// accepted after half the median span), which flags missed beats (about 2x), extra beats
    /// (two short intervals), and ectopic short-long pairs.
    pub fn push(&mut self, p: &HeartParams, t: f64, ibi_ms: f64, contiguous: bool) -> BeatRec {
        let mut flagged = !(ibi_ms >= p.clean_min_rr_ms && ibi_ms <= p.clean_max_rr_ms);
        let n = p.clean_median_n.max(1.0) as usize;
        let prev: Vec<f64> = self
            .beats
            .iter()
            .rev()
            .take_while(|b| b.t >= t - p.clean_median_span_s)
            .take(n)
            .map(|b| b.ibi_ms)
            .collect();
        if prev.len() >= 3 {
            let med = median(&prev);
            if (ibi_ms - med).abs() > p.clean_tolerance * med {
                flagged = true;
            }
        }
        let rec = BeatRec { t, ibi_ms, flagged, contiguous };
        if self.first_t.is_none() {
            self.first_t = Some(t);
        }
        self.beats.push(rec);
        self.total += 1;
        rec
    }

    /// Drop beats older than `keep_before`.
    pub fn prune(&mut self, keep_before: f64) {
        let k = self.beats.partition_point(|b| b.t < keep_before);
        if k > 256 {
            self.beats.drain(..k);
        }
    }

    /// Beats with t in (t0, t1].
    pub fn window(&self, t0: f64, t1: f64) -> &[BeatRec] {
        let a = self.beats.partition_point(|b| b.t <= t0);
        let b = self.beats.partition_point(|b| b.t <= t1);
        &self.beats[a..b]
    }

    /// Beats pushed since the beat with absolute index `since` (exclusive of earlier ones).
    pub fn since(&self, since: u64) -> &[BeatRec] {
        let first_abs = self.total - self.beats.len() as u64;
        let k = since.saturating_sub(first_abs).min(self.beats.len() as u64) as usize;
        &self.beats[k..]
    }
}

/// Places chest strap intervals on the session clock.
///
/// The strap sends intervals, not times. Beat k is at `c + S_k`, where `S_k` is the running sum of
/// intervals since the clock was anchored and `c` an offset. A notification arriving at `t` was
/// sent after its last beat, so `t - S_last` is an upper bound on `c`; the offset follows the
/// smallest such bound (snapping down at once, creeping up slowly to allow clock drift), which makes
/// it robust to notification jitter. A notification arriving much later than its intervals can
/// explain means intervals were lost: the clock re-anchors and the next beat is non-contiguous.
#[derive(Debug, Clone, Default)]
pub struct RrClock {
    c: Option<f64>,
    s: f64,
    last_arrival: f64,
    last_beat_t: Option<f64>,
    /// Number of re-anchors after lost intervals.
    pub lost_events: u64,
}

impl RrClock {
    /// Returns (beat time, interval ms, contiguous) for each interval.
    pub fn push(&mut self, p: &HeartParams, t: f64, rr_ms: &[f32]) -> Vec<(f64, f64, bool)> {
        let rr: Vec<f64> = rr_ms.iter().map(|&x| x as f64).filter(|x| x.is_finite() && *x > 0.0).collect();
        if rr.is_empty() {
            return Vec::new();
        }
        let sum_s: f64 = rr.iter().sum::<f64>() / 1000.0;
        let mut first_contiguous = true;
        match self.c {
            None => {
                self.c = Some(t - sum_s);
                self.s = 0.0;
                first_contiguous = false;
            }
            Some(mut c) => {
                c += p.rr_clock_creep * (t - self.last_arrival).max(0.0);
                let pred_last = c + self.s + sum_s;
                let off = t - pred_last;
                let lost_thr = p.rr_latency_max_s + 0.5 * rr[0] / 1000.0;
                if off > lost_thr {
                    c = t - self.s - sum_s;
                    first_contiguous = false;
                    self.lost_events += 1;
                } else if off < 0.0 {
                    c += off;
                }
                self.c = Some(c);
            }
        }
        self.last_arrival = t;
        let c = self.c.unwrap();
        let mut out = Vec::with_capacity(rr.len());
        for (i, &r) in rr.iter().enumerate() {
            self.s += r / 1000.0;
            let mut tb = c + self.s;
            // Keep beat times strictly increasing even when the offset snapped down.
            if let Some(prev) = self.last_beat_t {
                if tb <= prev {
                    tb = prev + 1e-3;
                }
            }
            self.last_beat_t = Some(tb);
            out.push((tb, r, if i == 0 { first_contiguous } else { true }));
        }
        out
    }
}
