//! Fast path (spec 7): follows each confirmed track at 32 readings a second.
//!
//! The tracker is behind the `Tracker` trait so the bake-off candidates F2 to F5 can be
//! swapped in. The implemented candidate is F1: a narrow causal band-pass around the slow
//! path's centre with an analytic (complex) output, built as complex demodulation: multiply
//! by e^{-i psi(n)} with psi advancing at the slow-path centre, then a causal 2nd-order
//! Butterworth low-pass. The complex output is the analytic signal of the band-passed EEG,
//! so amplitude, phase and amplitude-weighted instantaneous frequency follow directly.

use crate::dsp::biquad::Biquad;
use crate::dsp::fft::C;
use crate::m;
use crate::types::{Measured, Reason};
use std::collections::VecDeque;

/// What the slow path tells a tracker about its track.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackTarget {
    /// Slow-path centre frequency, Hz, and its standard error.
    pub centre_hz: f64,
    pub se_hz: f64,
    /// Confirmed peak width (full width at half height), Hz.
    pub width_hz: f64,
    /// Fitted background PSD at the centre on the tracked site, uV^2/Hz (one-sided).
    pub bg_psd: f64,
    /// Group delay of the conditioning filters at the centre, s.
    pub cond_delay_s: f64,
}

/// One fast reading.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FastReading {
    pub freq: Measured,
    pub amp_uv: Measured,
    pub height_db: Measured,
    pub phase: Measured,
    pub locked: bool,
    pub delay_s: f64,
}

/// Fast-path parameters, taken from `Params`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FastParams {
    pub rate: f64,
    pub block: usize,
    pub delay_limit_s: f64,
    pub lost_lock_s: f64,
    pub relock_s: f64,
    pub lock_se: f64,
    pub amp_floor: f64,
}

/// A fast tracker for one track. Implementations must be causal and deterministic.
pub trait Tracker {
    /// Called on every slow update (and at creation) with the slow path's latest view.
    fn retune(&mut self, target: &TrackTarget);
    /// One conditioned sample of the tracked site. `gated` marks samples the gating removed.
    fn push(&mut self, x: f64, gated: bool);
    /// Called once per fast frame (every `block` samples), after the block's samples.
    fn read(&mut self) -> FastReading;
}

/// Candidate F1: complex demodulation band-pass, amplitude-weighted instantaneous frequency.
pub struct DemodTracker {
    fp: FastParams,
    target: TrackTarget,
    lp_re: Biquad,
    lp_im: Biquad,
    lp_cut_hz: f64,
    lp_delay_s: f64,
    enbw_hz: f64,
    psi: f64,
    z: C,
    z_prev: C,
    acc: C,
    /// Samples still to wait before output is meaningful (start-up or after gating).
    settle_left: usize,
    settle_len: usize,
    block_gated: bool,
    /// Whether gated input has ever reached this tracker (to name the settling reason).
    seen_gated: bool,
    /// Recent per-block frequency readings and weights, for the 1 s agreement test.
    recent: VecDeque<(f64, f64)>,
    bad_s: f64,
    good_s: f64,
    locked: bool,
}

impl DemodTracker {
    pub fn new(fp: FastParams, target: &TrackTarget) -> Self {
        let mut t = DemodTracker {
            fp,
            target: *target,
            lp_re: Biquad::lowpass(fp.rate, 1.0, core::f64::consts::FRAC_1_SQRT_2),
            lp_im: Biquad::lowpass(fp.rate, 1.0, core::f64::consts::FRAC_1_SQRT_2),
            lp_cut_hz: 0.0,
            lp_delay_s: 0.0,
            enbw_hz: 0.0,
            psi: 0.0,
            z: C::default(),
            z_prev: C::default(),
            acc: C::default(),
            settle_left: 0,
            settle_len: 0,
            block_gated: false,
            seen_gated: false,
            recent: VecDeque::new(),
            bad_s: 0.0,
            good_s: 0.0,
            locked: false,
        };
        t.design(target, true);
        t.settle_left = t.settle_len;
        t
    }

    /// The low-pass corner: half the confirmed width, but no narrower than the delay limit
    /// allows (spec 7: total delay at or under `delay_limit_s`).
    fn corner_for(&self, target: &TrackTarget) -> f64 {
        let block_delay = (self.fp.block as f64 - 1.0) / 2.0 / self.fp.rate;
        let budget = (self.fp.delay_limit_s - target.cond_delay_s - block_delay).max(0.05);
        // 2nd-order Butterworth DC group delay = sqrt(2) / (2 pi fc).
        let fc_min = core::f64::consts::SQRT_2 / (m::TAU * budget);
        (target.width_hz / 2.0).max(fc_min).min(0.45 * target.centre_hz.max(1.0))
    }

    fn design(&mut self, target: &TrackTarget, force: bool) {
        let fc = self.corner_for(target);
        if !force && self.lp_cut_hz > 0.0 && (fc / self.lp_cut_hz - 1.0).abs() < 0.25 {
            return;
        }
        let lp = Biquad::lowpass(self.fp.rate, fc, core::f64::consts::FRAC_1_SQRT_2);
        self.lp_re.retune_from(&lp);
        self.lp_im.retune_from(&lp);
        self.lp_cut_hz = fc;
        self.lp_delay_s = lp.group_delay_samples(0.0) / self.fp.rate;
        // Equivalent noise bandwidth (one-sided, Hz) from the impulse response.
        let mut h = lp.clone();
        h.reset();
        let n = (m::ceil(12.0 * self.fp.rate / fc) as usize).max(64);
        let mut s2 = 0.0;
        for i in 0..n {
            let y = h.process(if i == 0 { 1.0 } else { 0.0 });
            s2 += y * y;
        }
        let g0 = lp.dc_gain();
        self.enbw_hz = s2 * self.fp.rate / 2.0 / (g0 * g0);
        // After gated (zeroed) input the low-pass rings on for a while. A 2nd-order Butterworth's
        // transient decays as exp(-t / delay): 13 % is left after two delays, under 2 %
        // after four. Output stays null until then.
        self.settle_len = m::ceil(4.0 * self.lp_delay_s * self.fp.rate) as usize;
    }

    /// RMS amplitude the background alone produces in this tracker's band.
    fn bg_amp(&self) -> f64 {
        2.0 * m::sqrt(self.target.bg_psd.max(0.0) * self.enbw_hz)
    }

    fn delay_s(&self) -> f64 {
        self.lp_delay_s + self.target.cond_delay_s + (self.fp.block as f64 - 1.0) / 2.0 / self.fp.rate
    }
}

impl Tracker for DemodTracker {
    fn retune(&mut self, target: &TrackTarget) {
        self.design(target, false);
        self.target = *target;
    }

    fn push(&mut self, x: f64, gated: bool) {
        let x = if gated { 0.0 } else { x };
        if gated {
            self.block_gated = true;
            self.seen_gated = true;
            self.settle_left = self.settle_len;
        } else if self.settle_left > 0 {
            self.settle_left -= 1;
        }
        let w = m::TAU * self.target.centre_hz / self.fp.rate;
        let r = C::cis(-self.psi).scale(x);
        let zr = self.lp_re.process(r.re);
        let zi = self.lp_im.process(r.im);
        self.z_prev = self.z;
        self.z = C::new(zr, zi);
        // z_n conj(z_{n-1}): amplitude-squared-weighted phase increment.
        self.acc = self.acc + self.z * self.z_prev.conj();
        self.psi = m::wrap_pi(self.psi + w);
    }

    fn read(&mut self) -> FastReading {
        let fp = self.fp;
        let block_s = fp.block as f64 / fp.rate;
        let delay = self.delay_s();
        let acc = self.acc;
        self.acc = C::default();
        let gated = self.block_gated;
        self.block_gated = false;
        if gated || self.settle_left > 0 {
            // Settling after creation is warm-up; settling after gated input is the artifact's tail.
            let why = if gated || self.seen_gated { Reason::Artifact } else { Reason::WarmingUp };
            let n = Measured::null(why);
            return FastReading { freq: n, amp_uv: n, height_db: n, phase: n, locked: self.locked, delay_s: delay };
        }
        // Baseband phase is relative to the oscillator, so the analytic phase is arg(z) + psi
        // (psi has already advanced one sample past the last input).
        let amp = 2.0 * self.z.abs();
        let w = m::TAU * self.target.centre_hz / fp.rate;
        let phase = m::wrap_pi(self.z.arg() + self.psi - w);
        let bg_amp = self.bg_amp();
        let height = if bg_amp > 0.0 && amp > 0.0 { Measured::ok(m::db(amp * amp / (bg_amp * bg_amp))) } else { Measured::null(Reason::Weak) };
        let amp_m = Measured::ok(amp);
        // Without a background level there is no floor to pass: that is weak, not strong.
        let weak = !(bg_amp > 0.0 && amp > fp.amp_floor * bg_amp) || acc.norm_sqr() == 0.0;
        if weak {
            let n = Measured::null(Reason::Weak);
            return FastReading { freq: n, amp_uv: amp_m, height_db: height, phase: n, locked: self.locked, delay_s: delay };
        }
        let f = self.target.centre_hz + acc.arg() * fp.rate / m::TAU;
        let half = self.target.width_hz / 2.0;
        let in_range = (f - self.target.centre_hz).abs() <= half;
        // 1 s agreement test against the slow path (spec 7).
        let keep = m::round(1.0 / block_s) as usize;
        let wgt = acc.abs();
        self.recent.push_back((f, wgt));
        while self.recent.len() > keep.max(1) {
            self.recent.pop_front();
        }
        let mut disagree = false;
        if self.recent.len() >= keep / 4 + 1 {
            let sw: f64 = self.recent.iter().map(|(_, w)| w).sum();
            if sw > 0.0 {
                let mean = self.recent.iter().map(|(f, w)| f * w).sum::<f64>() / sw;
                let var = self.recent.iter().map(|(f, w)| w * (f - mean) * (f - mean)).sum::<f64>() / sw;
                // Independent readings in the window: about bandwidth x duration.
                let dur = self.recent.len() as f64 * block_s;
                let n_ind = (2.0 * self.lp_cut_hz * dur).max(1.0);
                let se_fast = m::sqrt(var / n_ind);
                let se = m::sqrt(self.target.se_hz * self.target.se_hz + se_fast * se_fast).max(1e-9);
                disagree = (mean - self.target.centre_hz).abs() > fp.lock_se * se;
            }
        }
        let bad = !in_range || disagree;
        if bad {
            self.bad_s += block_s;
            self.good_s = 0.0;
        } else {
            self.good_s += block_s;
            self.bad_s = 0.0;
        }
        if self.locked && self.bad_s > fp.lost_lock_s {
            self.locked = false;
        } else if !self.locked && self.good_s >= fp.relock_s {
            self.locked = true;
        }
        if !in_range || !self.locked {
            let n = Measured::null(Reason::LostLock);
            return FastReading { freq: n, amp_uv: amp_m, height_db: height, phase: n, locked: self.locked, delay_s: delay };
        }
        FastReading { freq: Measured::ok(f), amp_uv: amp_m, height_db: height, phase: Measured::ok(phase), locked: true, delay_s: delay }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn follows_a_sine() {
        let fp = FastParams { rate: 256.0, block: 8, delay_limit_s: 0.3, lost_lock_s: 1.0, relock_s: 0.25, lock_se: 3.0, amp_floor: 1.0 };
        let tgt = TrackTarget { centre_hz: 10.0, se_hz: 0.05, width_hz: 1.0, bg_psd: 0.01, cond_delay_s: 0.0 };
        let mut t = DemodTracker::new(fp, &tgt);
        let mut last = None;
        for n in 0..(256 * 4) {
            let x = 20.0 * m::sin(m::TAU * 10.1 * n as f64 / 256.0);
            t.push(x, false);
            if (n + 1) % 8 == 0 {
                last = Some(t.read());
            }
        }
        let r = last.unwrap();
        assert!(r.locked);
        assert!((r.freq.v.unwrap() - 10.1).abs() < 0.02, "{:?}", r.freq);
        assert!((r.amp_uv.v.unwrap() - 20.0).abs() < 1.0, "{:?}", r.amp_uv);
        assert!(r.delay_s <= 0.3 + 1e-9, "{}", r.delay_s);
    }
}
