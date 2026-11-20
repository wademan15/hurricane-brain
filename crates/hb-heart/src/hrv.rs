//! Heart rate, time-domain variability, the evenly resampled interval series and the
//! frequency-domain measures (LF, HF, resonance, breathing, pacer adherence).

use crate::beats::BeatRec;
use crate::dsp::{analytic_bandpass, atan2, cos, detrend, mean, sd, sin, wrap_pi, Spectrum};
use crate::params::HeartParams;
use crate::types::{Measured, Reason};
use std::f64::consts::PI;

/// What value a resampled series carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeriesKind {
    /// Beat-to-beat interval, ms.
    IntervalMs,
    /// Instantaneous heart rate, beats per minute.
    HeartRateBpm,
}

/// A series on the absolute grid `t = g / fs`, g = g0, g0 + 1, ...
#[derive(Debug, Clone)]
pub struct Resampled {
    pub g0: i64,
    pub fs: f64,
    pub v: Vec<f64>,
    /// A value exists (inside the span of clean beats).
    pub valid: Vec<bool>,
    /// The value is interpolated across an excluded beat or a non-contiguous beat.
    pub bridged: Vec<bool>,
    /// Longest distance between the two clean beats that interpolate any sample, s.
    pub max_span_s: f64,
}

/// Linear interpolation of the clean beats' values onto the grid [g0, g1]. Flagged beats are never
/// used as values. Samples between two clean beats that are not consecutive (an excluded beat or a
/// dropout between them) are marked `bridged`.
pub fn resample(beats: &[BeatRec], kind: SeriesKind, fs: f64, g0: i64, g1: i64) -> Resampled {
    let n = if g1 >= g0 { (g1 - g0 + 1) as usize } else { 0 };
    let mut out = Resampled { g0, fs, v: vec![0.0; n], valid: vec![false; n], bridged: vec![false; n], max_span_s: 0.0 };
    // Clean beats with their position in `beats`.
    let clean: Vec<(usize, &BeatRec)> = beats.iter().enumerate().filter(|(_, b)| b.clean()).collect();
    if clean.len() < 2 || n == 0 {
        return out;
    }
    let val = |b: &BeatRec| match kind {
        SeriesKind::IntervalMs => b.ibi_ms,
        SeriesKind::HeartRateBpm => 60000.0 / b.ibi_ms,
    };
    let mut j = 0usize;
    for k in 0..n {
        let t = (g0 + k as i64) as f64 / fs;
        while j + 1 < clean.len() && clean[j + 1].1.t < t {
            j += 1;
        }
        if j + 1 >= clean.len() {
            break;
        }
        let (ia, a) = clean[j];
        let (ib, b) = clean[j + 1];
        if t < a.t || t > b.t {
            continue;
        }
        let w = if b.t > a.t { (t - a.t) / (b.t - a.t) } else { 0.0 };
        out.v[k] = val(a) + w * (val(b) - val(a));
        out.valid[k] = true;
        out.bridged[k] = !(ib == ia + 1 && b.contiguous);
        out.max_span_s = out.max_span_s.max(b.t - a.t);
    }
    out
}

/// Fraction of intervals flagged in a set of beats (0 when empty).
pub fn corrected_fraction(beats: &[BeatRec]) -> f64 {
    if beats.is_empty() {
        return 0.0;
    }
    beats.iter().filter(|b| b.flagged).count() as f64 / beats.len() as f64
}

/// Heart rate from the mean of clean intervals ending in (t - hr_window_s, t].
pub fn heart_rate(beats_in_window: &[BeatRec]) -> Measured {
    if beats_in_window.is_empty() {
        return Measured::null(Reason::Gap);
    }
    let ibi: Vec<f64> = beats_in_window.iter().filter(|b| b.clean()).map(|b| b.ibi_ms).collect();
    if ibi.is_empty() {
        return Measured::null(Reason::InsufficientClean);
    }
    let m = mean(&ibi);
    let hr = 60000.0 / m;
    if ibi.len() >= 2 {
        // Delta method: se(60000/m) = 60000 se(m) / m^2.
        let se_m = sd(&ibi) / (ibi.len() as f64).sqrt();
        Measured::ok_se(hr, 60000.0 * se_m / (m * m))
    } else {
        Measured::ok(hr)
    }
}

pub struct TimeDomain {
    pub rmssd: Measured,
    pub sdnn: Measured,
    pub corrected_fraction: f64,
}

/// Validity checks shared by every windowed variability measure.
/// Returns Err(reason) when the window may not be used.
pub fn window_status(p: &HeartParams, first_t: Option<f64>, t: f64, window_s: f64, beats: &[BeatRec]) -> Result<(), Reason> {
    let first = match first_t {
        Some(f) => f,
        None => return Err(Reason::NoData),
    };
    if t - first < p.hrv_min_cover * window_s {
        return Err(Reason::WarmingUp);
    }
    if beats.is_empty() {
        return Err(Reason::Gap);
    }
    if corrected_fraction(beats) > p.correction_limit {
        return Err(Reason::TooManyCorrections);
    }
    let clean = beats.iter().filter(|b| b.clean()).count() as f64;
    if clean < p.hrv_min_beats_per_min * window_s / 60.0 {
        return Err(Reason::TooFewBeats);
    }
    Ok(())
}

/// RMSSD and SDNN over the beats of the window. Successive differences use only pairs of
/// consecutive, contiguous, clean intervals; SDNN uses clean intervals.
pub fn time_domain(p: &HeartParams, first_t: Option<f64>, t: f64, beats: &[BeatRec]) -> TimeDomain {
    let w = p.hrv_window_s;
    let cf = corrected_fraction(beats);
    if let Err(r) = window_status(p, first_t, t, w, beats) {
        return TimeDomain { rmssd: Measured::null(r), sdnn: Measured::null(r), corrected_fraction: cf };
    }
    let (rmssd, sdnn) = rmssd_sdnn(beats);
    TimeDomain { rmssd, sdnn, corrected_fraction: cf }
}

/// The plain computation, also used by tests as the engine side of the reference comparison.
pub fn rmssd_sdnn(beats: &[BeatRec]) -> (Measured, Measured) {
    let mut d2 = Vec::new();
    for k in 1..beats.len() {
        let (a, b) = (&beats[k - 1], &beats[k]);
        if a.clean() && b.clean() && b.contiguous {
            let d = b.ibi_ms - a.ibi_ms;
            d2.push(d * d);
        }
    }
    let clean: Vec<f64> = beats.iter().filter(|b| b.clean()).map(|b| b.ibi_ms).collect();
    let rmssd = if d2.len() >= 2 {
        let ms = mean(&d2);
        let r = ms.sqrt();
        // se of the mean square, propagated through the square root. Treats successive
        // differences as independent, so it is a lower bound.
        let se_ms = sd(&d2) / (d2.len() as f64).sqrt();
        Measured::ok_se(r, if r > 0.0 { se_ms / (2.0 * r) } else { f64::NAN })
    } else {
        Measured::null(Reason::TooFewBeats)
    };
    let sdnn = if clean.len() >= 3 {
        let s = sd(&clean);
        Measured::ok_se(s, s / (2.0 * (clean.len() as f64 - 1.0)).sqrt())
    } else {
        Measured::null(Reason::TooFewBeats)
    };
    (rmssd, sdnn)
}

/// Frequency-domain outputs.
#[derive(Debug, Clone, Copy)]
pub struct FreqDomain {
    pub lf: Measured,
    pub hf: Measured,
    pub resonance_hz: Measured,
    pub resonance_strength: Measured,
    pub breath_bpm: Measured,
    pub breath_phase: Measured,
}

impl FreqDomain {
    pub fn null(r: Reason) -> Self {
        let m = Measured::null(r);
        FreqDomain { lf: m, hf: m, resonance_hz: m, resonance_strength: m, breath_bpm: m, breath_phase: m }
    }
}

/// The evenly resampled interval series over a window ending at t, with its validity.
pub fn window_series(p: &HeartParams, beats_all: &[BeatRec], first_t: Option<f64>, t: f64, window_s: f64) -> Result<Resampled, Reason> {
    let fs = p.resample_hz;
    let in_win: Vec<BeatRec> = beats_all.iter().filter(|b| b.t > t - window_s && b.t <= t).copied().collect();
    let first = first_t.ok_or(Reason::NoData)?;
    if t - first < p.hrv_min_cover * window_s {
        return Err(Reason::WarmingUp);
    }
    if in_win.is_empty() {
        return Err(Reason::Gap);
    }
    if corrected_fraction(&in_win) > p.correction_limit {
        return Err(Reason::TooManyCorrections);
    }
    let clean: Vec<&BeatRec> = in_win.iter().filter(|b| b.clean()).collect();
    if (clean.len() as f64) < p.hrv_min_beats_per_min * window_s / 60.0 {
        return Err(Reason::TooFewBeats);
    }
    let g0 = (clean[0].t * fs).ceil() as i64;
    let g1 = (clean[clean.len() - 1].t * fs).floor() as i64;
    let r = resample(&in_win, SeriesKind::IntervalMs, fs, g0, g1);
    if (r.v.len() as f64) < p.hrv_min_cover * window_s * fs || r.valid.iter().any(|v| !v) {
        return Err(Reason::Gap);
    }
    if r.max_span_s > p.spec_max_bridge_s {
        return Err(Reason::Gap);
    }
    Ok(r)
}

/// LF, HF, resonance and breathing from the spectral window ending at t.
pub fn freq_domain(p: &HeartParams, beats_all: &[BeatRec], first_t: Option<f64>, t: f64) -> FreqDomain {
    let r = match window_series(p, beats_all, first_t, t, p.spec_window_s) {
        Ok(r) => r,
        Err(why) => return FreqDomain::null(why),
    };
    let fs = r.fs;
    let s = Spectrum::periodogram(&r.v, fs, p.spec_pad_factor);
    let dof = |lo: f64, hi: f64| {
        // Hann window: about one independent estimate per 1.5 frequency resolutions, each with
        // 2 degrees of freedom; se of a chi-square band sum = P / sqrt(dof / 2).
        let n_ind = ((hi - lo) * s.duration_s / 1.5).max(1.0);
        2.0 * n_ind
    };
    let band = |lo: f64, hi: f64| {
        let pw = s.band_power(lo, hi);
        Measured::ok_se(pw, pw / (dof(lo, hi) / 2.0).sqrt())
    };
    let lf = band(p.lf_lo_hz, p.lf_hi_hz);
    let hf = band(p.hf_lo_hz, p.hf_hi_hz);
    let total = s.band_power(p.lf_lo_hz, p.hf_hi_hz);
    let hw = p.resonance_halfwidth_hz;

    let (resonance_hz, resonance_strength) = match s.peak(p.resonance_lo_hz, p.resonance_hi_hz) {
        Some((f, _)) if total > 0.0 => {
            let share = s.band_power(f - hw, f + hw) / total;
            let se_f = inst_freq_se(&r.v, fs, f, hw.max(0.02));
            (
                match se_f {
                    Some(se) => Measured::ok_se(f, se),
                    None => Measured::ok(f),
                },
                Measured::ok(share.clamp(0.0, 1.0)),
            )
        }
        _ => (Measured::null(Reason::NotConfirmed), Measured::null(Reason::NotConfirmed)),
    };

    // Breathing: a clear peak in the breath band.
    let (breath_bpm, breath_phase) = match s.peak(p.breath_lo_hz, p.breath_hi_hz) {
        Some((f, pk)) => {
            let band_total = s.band_power(p.breath_lo_hz, p.breath_hi_hz);
            let share = if band_total > 0.0 { s.band_power(f - hw, f + hw) / band_total } else { 0.0 };
            // Peak density (mean over +-hw) against the local background: the median density
            // within +-breath_local_hz, excluding +-2 hw around the peak.
            let peak_density = s.band_power(f - hw, f + hw) / (2.0 * hw);
            let bg = s.median_excluding(f - p.breath_local_hz, f + p.breath_local_hz, f - 2.0 * hw, f + 2.0 * hw);
            let _ = pk;
            if share >= p.breath_min_share && bg > 0.0 && peak_density / bg >= p.breath_min_peak_ratio {
                let se_f = inst_freq_se(&r.v, fs, f, hw.max(0.02));
                let bpm = match se_f {
                    Some(se) => Measured::ok_se(f * 60.0, se * 60.0),
                    None => Measured::ok(f * 60.0),
                };
                let t_end = (r.g0 + r.v.len() as i64 - 1) as f64 / fs;
                (bpm, breath_phase(p, &r.v, fs, f, t_end, t))
            } else {
                (Measured::null(Reason::NotConfirmed), Measured::null(Reason::NotConfirmed))
            }
        }
        None => (Measured::null(Reason::NotConfirmed), Measured::null(Reason::NotConfirmed)),
    };

    FreqDomain { lf, hf, resonance_hz, resonance_strength, breath_bpm, breath_phase }
}

/// Standard error of a rhythm's frequency: the spread of its instantaneous frequency (from the
/// analytic signal in f +- hw), divided by the square root of the number of cycles in the window.
fn inst_freq_se(x: &[f64], fs: f64, f: f64, hw: f64) -> Option<f64> {
    let y = detrend(x, None);
    let (re, im) = analytic_bandpass(&y, fs, (f - hw).max(0.0), f + hw);
    let n = re.len();
    let edge = n / 10;
    if n < 2 * edge + 4 {
        return None;
    }
    let mut inst = Vec::with_capacity(n);
    for i in edge + 1..n - edge {
        let dphi = wrap_pi(atan2(im[i], re[i]) - atan2(im[i - 1], re[i - 1]));
        inst.push(dphi * fs / (2.0 * PI));
    }
    let cycles = (n as f64 / fs * f).max(1.0);
    let s = sd(&inst);
    if s.is_finite() {
        Some(s / cycles.sqrt())
    } else {
        None
    }
}

/// Breathing phase at time t. Phase 0 is the heart rate maximum (shortest interval) of the
/// respiratory rhythm, pi its minimum. Fitted as a sinusoid at the measured breathing frequency
/// over the last `breath_fit_cycles` cycles ending at the last clean beat, and projected forward at
/// that frequency by at most `breath_phase_max_ahead_s`.
fn breath_phase(p: &HeartParams, x: &[f64], fs: f64, f: f64, t_end: f64, t: f64) -> Measured {
    let ahead = t - t_end;
    if ahead > p.breath_phase_max_ahead_s {
        return Measured::null(Reason::Gap);
    }
    let len = ((p.breath_fit_cycles / f) * fs).round() as usize;
    if len < 6 || len > x.len() {
        return Measured::null(Reason::InsufficientClean);
    }
    // Negate so that the oscillation is in heart rate's direction, then detrend the fit segment.
    let seg: Vec<f64> = x[x.len() - len..].iter().map(|v| -v).collect();
    let y = detrend(&seg, None);
    // Least squares y ~ a cos(w tau) + b sin(w tau), tau = time relative to t_end (<= 0).
    let w = 2.0 * PI * f;
    let (mut scc, mut sss, mut scs, mut syc, mut sys) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (i, &v) in y.iter().enumerate() {
        let tau = (i as f64 - (len - 1) as f64) / fs;
        let (c, s) = (cos(w * tau), sin(w * tau));
        scc += c * c;
        sss += s * s;
        scs += c * s;
        syc += v * c;
        sys += v * s;
    }
    let det = scc * sss - scs * scs;
    if det.abs() < 1e-12 {
        return Measured::null(Reason::Unresolved);
    }
    let a = (syc * sss - sys * scs) / det;
    let b = (sys * scc - syc * scs) / det;
    let amp = (a * a + b * b).sqrt();
    if amp <= 0.0 {
        return Measured::null(Reason::Weak);
    }
    let mut ss_res = 0.0;
    for (i, &v) in y.iter().enumerate() {
        let tau = (i as f64 - (len - 1) as f64) / fs;
        let e = v - (a * cos(w * tau) + b * sin(w * tau));
        ss_res += e * e;
    }
    let resid_sd = (ss_res / (len as f64 - 2.0).max(1.0)).sqrt();
    let se = resid_sd / (amp * (len as f64 / 2.0).sqrt());
    // y = A cos(w tau + theta_end) => a = A cos(theta), b = -A sin(theta).
    let theta_end = atan2(-b, a);
    Measured::ok_se(wrap_pi(theta_end + w * ahead), se)
}

/// Pacer adherence: share of 0.04-0.4 Hz power within +-resonance_halfwidth_hz of the pacer
/// frequency, divided by the same share computed by the same procedure for a pure sinusoid at the
/// pacer frequency of the same length (the most a perfect follower could score), capped at 1.
pub fn pacer_adherence(p: &HeartParams, beats_all: &[BeatRec], first_t: Option<f64>, t: f64, pacer: Option<(f64, f64)>) -> Measured {
    let (bpm, since) = match pacer {
        Some(x) => x,
        None => return Measured::null(Reason::NotAvailable),
    };
    let f = bpm / 60.0;
    if !(f >= p.lf_lo_hz && f <= p.hf_hi_hz) {
        return Measured::null(Reason::NotAvailable);
    }
    if t - since < p.pacer_window_s {
        return Measured::null(Reason::WarmingUp);
    }
    let r = match window_series(p, beats_all, first_t, t, p.pacer_window_s) {
        Ok(r) => r,
        Err(why) => return Measured::null(why),
    };
    let hw = p.resonance_halfwidth_hz;
    let share = |x: &[f64]| {
        let s = Spectrum::periodogram(x, r.fs, p.spec_pad_factor);
        let tot = s.band_power(p.lf_lo_hz, p.hf_hi_hz);
        if tot > 0.0 {
            s.band_power(f - hw, f + hw) / tot
        } else {
            0.0
        }
    };
    let observed = share(&r.v);
    let pure: Vec<f64> = (0..r.v.len()).map(|i| cos(2.0 * PI * f * i as f64 / r.fs)).collect();
    let reference = share(&pure);
    if reference <= 0.0 {
        return Measured::null(Reason::Unresolved);
    }
    Measured::ok((observed / reference).clamp(0.0, 1.0))
}
