//! The engine: ingest, conditioning, quality, gating, and the slow and fast paths.

use crate::compare::{self, Analytic};
use crate::dsp::biquad::Biquad;
use crate::dsp::fft::{Fft, C};
use crate::fast::{DemodTracker, FastParams, TrackTarget, Tracker};
use crate::m;
use crate::params::Params;
use crate::prng::Rng;
use crate::ratios::{self, Baselines, NullDist, ScoreCtx, ScoreTrack, StateMachine};
use crate::spectral::{self, analyse_site, BgFit, Member, Multitaper, Peak, SiteAnalysis, SiteSpec};
use crate::tracks::{join_dist_at, Obs, TrackInt};
use crate::types::*;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// Engine version, recorded with every session (spec 11).
pub const ENGINE_VERSION: &str = concat!("hb-engine/", env!("CARGO_PKG_VERSION"));

/// Per-sample flag bits.
pub(crate) mod flag {
    pub const REPAIRED: u16 = 1;
    pub const INVALID: u16 = 2;
    pub const SETTLE: u16 = 4;
    pub const WARMUP: u16 = 8;
    pub const BLINK: u16 = 16;
    pub const EYE: u16 = 32;
    pub const MUSCLE: u16 = 64;
    pub const MOTION: u16 = 128;
    pub const POP: u16 = 256;
    pub const BADQ: u16 = 512;
    pub const GATED: u16 = INVALID | SETTLE | WARMUP | BLINK | EYE | MUSCLE | MOTION | POP | BADQ;
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineError {
    NoEeg,
    BadStream(String),
    BadParams(String),
}

impl core::fmt::Display for EngineError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            EngineError::NoEeg => write!(f, "no EEG stream described"),
            EngineError::BadStream(s) => write!(f, "bad stream description: {s}"),
            EngineError::BadParams(s) => write!(f, "bad parameters: {s}"),
        }
    }
}

impl std::error::Error for EngineError {}

/// Fixed-capacity ring indexed by absolute sample index.
#[derive(Clone, Debug)]
struct Ring<T> {
    buf: Vec<T>,
    start: u64,
    end: u64,
}

impl<T: Copy + Default> Ring<T> {
    fn new(cap: usize) -> Self {
        Ring { buf: vec![T::default(); cap], start: 0, end: 0 }
    }
    fn reset_at(&mut self, idx: u64) {
        self.start = idx;
        self.end = idx;
    }
    fn cap(&self) -> u64 {
        self.buf.len() as u64
    }
    fn push(&mut self, v: T) {
        let c = self.cap();
        self.buf[(self.end % c) as usize] = v;
        self.end += 1;
        if self.end - self.start > c {
            self.start = self.end - c;
        }
    }
    fn contains(&self, idx: u64) -> bool {
        idx >= self.start && idx < self.end
    }
    fn get(&self, idx: u64) -> T {
        debug_assert!(self.contains(idx));
        self.buf[(idx % self.cap()) as usize]
    }
    fn get_mut(&mut self, idx: u64) -> &mut T {
        let c = self.cap();
        &mut self.buf[(idx % c) as usize]
    }
}

/// The harmonic mark of one pair of tracks (spec 6.6): the multiple, whether the upper track
/// is currently marked a harmonic of the lower, and the recent tests (time, locking vector,
/// surrogate level or None if the upper track was outside the harmonic's band).
#[derive(Clone, Debug)]
struct HarmonicMark {
    n: u32,
    marked: bool,
    /// Phase tests made so far. Until `harmonic_pending_tests` have been made the pair is
    /// kept out of scoring ("pending").
    done: u32,
    /// When the upper track was last inside the harmonic's band.
    seen_t: f64,
    tests: VecDeque<(f64, C, Option<f64>)>,
}

/// Track merge and split events (spec 6.5 says they are recorded; the frame schema has no
/// field for them yet, see NOTES.md).
#[derive(Clone, Debug, PartialEq)]
pub enum TrackEvent {
    Born { t: f64, id: u32 },
    Merged { t: f64, kept: u32, removed: u32 },
    Split { t: f64, from: u32, new: u32 },
    Ended { t: f64, id: u32 },
    /// A rhythm came back at the place of a track that ended less than `track_resume_s` ago;
    /// the track continues under its old id.
    Resumed { t: f64, id: u32 },
}

/// Counters for testing and the lab comparison. Not part of the frame contract.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Diagnostics {
    pub slow_updates: u64,
    /// Slow updates in which at least one site was analysed.
    pub windows_analysed: u64,
    /// Slow updates in which any site had a peak passing the height and width tests.
    pub windows_with_passing_peak: u64,
    pub site_windows: u64,
    pub site_windows_with_passing_peak: u64,
    pub chance_refreshes: u64,
    pub chance_b_refreshes: u64,
    pub overlap_samples_dropped: u64,
    pub repaired_samples: u64,
    pub invalid_samples: u64,
    pub events: Vec<TrackEvent>,
}

#[derive(Clone, Debug)]
struct SiteDef {
    name: String,
    members: Vec<usize>,
    composite: bool,
}

struct Chan {
    name: String,
    hp: Biquad,
    notch: Option<Biquad>,
    steplp: Biquad,
    raw: Ring<f32>,
    rawhp: Ring<f32>,
    x: Ring<f32>,
    lp: Ring<f32>,
    d: Ring<f32>,
    flags: Ring<u16>,
    last_raw: Option<f32>,
    primed: bool,
    settle_until: u64,
    pending: Vec<(u64, u64, u16)>,
    valid_seen: u64,
    step_ref: Vec<f64>,
    step_scale: Option<f64>,
    musc_ref_vals: Vec<f64>,
    musc_ref: Option<f64>,
    recent_step: VecDeque<(f64, f64)>,
    recent_musc: VecDeque<(f64, f64)>,
    usable: bool,
    q_why: Reason,
    pass_s: f64,
    mains_uv: Option<f64>,
    sd_uv: Option<f64>,
    railed: Option<f64>,
    emg_db: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Valid,
    Repaired,
    Invalid,
}

/// Per-channel view of the current slow window.
struct ChanWin {
    clean_fraction: f64,
    artifacts: Vec<ArtifactKind>,
    why: Reason,
    member: Option<Member>,
}

#[derive(Default)]
struct MotionState {
    acc_lp: Option<[f64; 3]>,
    first_t: Option<f64>,
    gyro_ref_vals: Vec<f64>,
    gyro_ref: Option<f64>,
    last_t: Option<f64>,
}

#[derive(Default)]
struct ChanceCache {
    sig: Vec<u32>,
    at_update: u64,
    valid: bool,
    a: Option<[NullDist; 2]>,
    thr_a: [Option<f64>; 2],
    b: Option<[NullDist; 2]>,
    thr_b: [Option<f64>; 2],
    /// Smallest p-value chance B may report from the histories it was built on.
    b_p_floor: f64,
}

/// The signal engine. Feed it samples; drain frames.
pub struct Engine {
    p: Params,
    rate: f64,
    nch: usize,
    chans: Vec<Chan>,
    sites: Vec<SiteDef>,
    temporal_site: Option<usize>,
    frontal_site: Option<usize>,
    frontal: Vec<usize>,
    tp9: Option<usize>,
    tp10: Option<usize>,
    seed: u64,
    first_idx: Option<u64>,
    next_idx: u64,
    wlen: usize,
    quantum: usize,
    fast_block: usize,
    qlen: usize,
    min_len: usize,
    step_lag: usize,
    pad: u64,
    mt: Multitaper,
    /// Squared magnitude of the conditioning filters on the spectral grid.
    response: Vec<f64>,
    mains: Option<u32>,
    mains_fixed: bool,
    mains_next_check: u64,
    hann128: Vec<f64>,
    hann_q: Vec<f64>,
    fft128: Fft,
    fft_q: Option<Fft>,
    fft_mains: Option<(Fft, Vec<f64>)>,
    motion: MotionState,
    update_count: u64,
    nonoverlap: u64,
    persist: Vec<VecDeque<(u64, Vec<Peak>)>>,
    tracks: Vec<TrackInt>,
    /// Tracks that ended within the last `track_resume_s`. Not output. If the rhythm comes
    /// back at the same place the track continues under its id (spec 6.5).
    dormant: Vec<TrackInt>,
    next_track_id: u32,
    harmonics: BTreeMap<(u32, u32), HarmonicMark>,
    site_bg: Vec<Option<BgFit>>,
    baselines: Baselines,
    baseline_start: Option<f64>,
    chance: ChanceCache,
    states: [StateMachine; 2],
    /// The combined state (both targets active) and when it last changed.
    both: (bool, Option<f64>),
    /// Samples known to be missing and not yet repaired or voided, and whether the run they
    /// belong to is already too long to repair.
    pending_missing: u64,
    unrepairable: bool,
    held_since: [Vec<Option<f64>>; 2],
    trackers: BTreeMap<u32, (usize, Box<dyn Tracker>)>,
    fast_block_gated: bool,
    analytic: Analytic,
    iaf: Option<f64>,
    markers: VecDeque<Marker>,
    marker_log: Vec<Marker>,
    out: Vec<Frame>,
    diag: Diagnostics,
}

fn hann(n: usize) -> Vec<f64> {
    (0..n).map(|i| 0.5 - 0.5 * m::cos(m::TAU * i as f64 / n as f64)).collect()
}

impl Engine {
    pub fn new(cfg: EngineConfig) -> Result<Engine, EngineError> {
        let eeg = cfg.streams.eeg.clone().ok_or(EngineError::NoEeg)?;
        let p = Params::from_overrides(cfg.params.as_ref()).map_err(EngineError::BadParams)?;
        let rate = eeg.rate_hz;
        if !(rate >= 100.0 && rate <= 4096.0) {
            return Err(EngineError::BadStream(format!("EEG rate {rate} Hz is outside 100 to 4096")));
        }
        let nch = eeg.channels.len();
        if nch == 0 {
            return Err(EngineError::BadStream("no EEG channels".into()));
        }
        let quantum = (m::round(p.slow_update_s * rate) as usize).max(1);
        let fast_block = (m::round(rate / p.fast_per_s) as usize).max(1);
        if quantum % fast_block != 0 {
            return Err(EngineError::BadParams("slow update must be a whole number of fast frames".into()));
        }
        let wlen = ((m::round(p.slow_window_s * rate) as usize) / quantum).max(1) * quantum;
        let min_len = (m::ceil(p.min_clean_stretch_s * rate) as usize).div_ceil(quantum).max(1) * quantum;
        let nyq = rate / 2.0;
        let store_hi = (p.spectrum_out_hi_hz.max(p.peak_search_hi_hz + 8.0)).min(nyq - 1.0);
        let mt = Multitaper::new(rate, wlen, min_len.min(wlen), quantum, p.mt_half_bandwidth_hz, p.spectrum_grid_hz, store_hi);
        let cap = wlen + 4 * (rate as usize) + 512;
        let q = core::f64::consts::FRAC_1_SQRT_2;
        let mains = match cfg.mains_hz {
            Some(50) => Some(50),
            Some(60) => Some(60),
            Some(o) => return Err(EngineError::BadStream(format!("mains_hz must be 50 or 60, got {o}"))),
            None => None,
        };
        let chans: Vec<Chan> = eeg
            .channels
            .iter()
            .map(|name| Chan {
                name: name.clone(),
                hp: Biquad::highpass(rate, p.highpass_hz, q),
                notch: mains.filter(|f| (*f as f64) < nyq).map(|f| Biquad::notch(rate, f as f64, p.notch_q)),
                steplp: Biquad::lowpass(rate, p.step_lowpass_hz, q),
                raw: Ring::new(cap),
                rawhp: Ring::new(cap),
                x: Ring::new(cap),
                lp: Ring::new(cap),
                d: Ring::new(cap),
                flags: Ring::new(cap),
                last_raw: None,
                primed: false,
                settle_until: 0,
                pending: Vec::new(),
                valid_seen: 0,
                step_ref: Vec::new(),
                step_scale: None,
                musc_ref_vals: Vec::new(),
                musc_ref: None,
                recent_step: VecDeque::new(),
                recent_musc: VecDeque::new(),
                usable: false,
                q_why: Reason::WarmingUp,
                pass_s: 0.0,
                mains_uv: None,
                sd_uv: None,
                railed: None,
                emg_db: None,
            })
            .collect();
        let up = |s: &str| s.to_ascii_uppercase();
        let temporal: Vec<usize> = (0..nch).filter(|&i| up(&eeg.channels[i]).starts_with("TP")).collect();
        let frontal: Vec<usize> = (0..nch).filter(|&i| {
            let u = up(&eeg.channels[i]);
            u.starts_with("AF") || u.starts_with("FP")
        }).collect();
        let mut sites: Vec<SiteDef> = (0..nch).map(|i| SiteDef { name: eeg.channels[i].clone(), members: vec![i], composite: false }).collect();
        let mut temporal_site = None;
        let mut frontal_site = None;
        if !temporal.is_empty() {
            temporal_site = Some(sites.len());
            sites.push(SiteDef { name: "temporal".into(), members: temporal.clone(), composite: true });
        }
        if !frontal.is_empty() {
            frontal_site = Some(sites.len());
            sites.push(SiteDef { name: "frontal".into(), members: frontal.clone(), composite: true });
        }
        sites.push(SiteDef { name: "all".into(), members: (0..nch).collect(), composite: true });
        let nsites = sites.len();
        let find = |n: &str| eeg.channels.iter().position(|c| c.eq_ignore_ascii_case(n));
        let qlen = m::round(rate) as usize;
        let fft_q = if qlen.is_power_of_two() { Some(Fft::new(qlen)) } else { None };
        let mains_len = crate::dsp::fft::next_pow2((m::round(p.mains_detect_s * rate) as usize).max(256));
        let nonoverlap = ((wlen / quantum) as u64).max(1);
        let pad = m::round(p.artifact_pad_s * rate) as u64;
        let step_lag = (m::round(p.step_lag_s * rate) as usize).max(1);
        let mut e = Engine {
            rate,
            nch,
            chans,
            sites,
            temporal_site,
            frontal_site,
            frontal,
            tp9: find("TP9"),
            tp10: find("TP10"),
            seed: cfg.seed,
            first_idx: None,
            next_idx: 0,
            wlen,
            quantum,
            fast_block,
            qlen,
            min_len,
            step_lag,
            pad,
            response: Vec::new(),
            mt,
            mains,
            mains_fixed: mains.is_some(),
            mains_next_check: 0,
            hann128: hann(128),
            hann_q: hann(qlen),
            fft128: Fft::new(128),
            fft_q,
            fft_mains: Some((Fft::new(mains_len), hann(mains_len))),
            motion: MotionState::default(),
            update_count: 0,
            nonoverlap,
            persist: vec![VecDeque::new(); nsites],
            tracks: Vec::new(),
            dormant: Vec::new(),
            next_track_id: 1,
            harmonics: BTreeMap::new(),
            site_bg: vec![None; nsites],
            baselines: Baselines::new(),
            baseline_start: None,
            chance: ChanceCache::default(),
            states: [StateMachine::default(), StateMachine::default()],
            both: (false, None),
            pending_missing: 0,
            unrepairable: false,
            held_since: [Vec::new(), Vec::new()],
            trackers: BTreeMap::new(),
            fast_block_gated: false,
            analytic: Analytic::default(),
            iaf: None,
            markers: VecDeque::new(),
            marker_log: Vec::new(),
            out: Vec::new(),
            diag: Diagnostics::default(),
            p,
        };
        e.update_response();
        Ok(e)
    }

    /// The high-pass filter's power response on the spectral grid, for the background model.
    /// (The notch is left out: its zone is excluded from the fit and the peak search, and
    /// dividing by it would only blow up the flattened display at the mains line.)
    fn update_response(&mut self) {
        let ch = &self.chans[0];
        self.response = (0..self.mt.nstore)
            .map(|i| ch.hp.power_response(m::TAU * i as f64 * self.mt.df / self.rate))
            .collect();
    }

    pub fn version(&self) -> &'static str {
        ENGINE_VERSION
    }

    /// Every parameter in force, by name (spec 14), for recording with the session.
    pub fn params(&self) -> BTreeMap<String, ParamValue> {
        self.p.to_map()
    }

    pub fn param_struct(&self) -> &Params {
        &self.p
    }

    pub fn diagnostics(&self) -> &Diagnostics {
        &self.diag
    }

    pub fn markers(&self) -> &[Marker] {
        &self.marker_log
    }

    /// Set or clear the individual alpha frequency (band edges scale to it).
    pub fn set_iaf(&mut self, hz: Option<f64>) {
        self.iaf = hz.filter(|h| h.is_finite() && *h > 2.5 && *h < 25.0);
    }

    pub fn push_marker(&mut self, mk: Marker) {
        self.marker_log.push(mk.clone());
        self.markers.push_back(mk);
    }

    /// All frames produced since the last call, in time order.
    pub fn drain(&mut self) -> Vec<Frame> {
        std::mem::take(&mut self.out)
    }

    // -----------------------------------------------------------------------------
    // Input
    // -----------------------------------------------------------------------------

    /// EEG samples interleaved by channel, microvolts. `first_index` is the session-clock
    /// index of the first sample; a jump past the expected next index is a gap.
    pub fn push_eeg(&mut self, first_index: u64, samples: &[f32]) {
        let nch = self.nch;
        let nframes = samples.len() / nch;
        if nframes == 0 {
            return;
        }
        let mut start = 0usize;
        match self.first_idx {
            None => {
                self.first_idx = Some(first_index);
                self.next_idx = first_index;
                self.mains_next_check = first_index;
                for ch in self.chans.iter_mut() {
                    ch.raw.reset_at(first_index);
                    ch.rawhp.reset_at(first_index);
                    ch.x.reset_at(first_index);
                    ch.lp.reset_at(first_index);
                    ch.d.reset_at(first_index);
                    ch.flags.reset_at(first_index);
                }
            }
            Some(_) => {
                let next = self.next_idx;
                if first_index < next {
                    let skip = (next - first_index) as usize;
                    if skip >= nframes {
                        self.diag.overlap_samples_dropped += nframes as u64;
                        return;
                    }
                    self.diag.overlap_samples_dropped += skip as u64;
                    start = skip;
                } else if first_index > next {
                    // Missing samples: counted here, repaired or voided when the next real
                    // sample arrives (below).
                    self.pending_missing = first_index - next;
                }
            }
        }
        // Review: a frame in which no channel has a number is a lost sample, however it
        // reaches the engine: as a jump in the sample index (the device layer) or as a row of
        // NaN (the lab fixtures, and any source that keeps a fixed grid). Both are the same
        // gap and get the same repair (spec 3). Before, NaN rows were voided one by one and
        // never repaired: 1 % packet loss in a fixture voided 67 % of windows.
        let max_rep = self.p.gap_repair_max_samples as u64;
        let mut kinds = vec![Kind::Valid; nch];
        for k in start..nframes {
            let fr = &samples[k * nch..(k + 1) * nch];
            if fr.iter().all(|v| !v.is_finite()) {
                self.pending_missing += 1;
                if self.pending_missing > max_rep {
                    // Too long to repair: void it now so that time keeps moving.
                    let n = self.pending_missing;
                    self.pending_missing = 0;
                    self.void_run(n);
                    self.unrepairable = true;
                }
                continue;
            }
            if self.pending_missing > 0 {
                let n = self.pending_missing;
                self.pending_missing = 0;
                if self.unrepairable {
                    self.void_run(n);
                } else {
                    self.handle_gap(n, fr);
                }
            }
            self.unrepairable = false;
            for (c, kd) in kinds.iter_mut().enumerate() {
                *kd = if fr[c].is_finite() { Kind::Valid } else { Kind::Invalid };
            }
            self.ingest(fr, &kinds);
        }
    }

    /// Ingest `n` missing samples as invalid.
    fn void_run(&mut self, n: u64) {
        let kinds = vec![Kind::Invalid; self.nch];
        let fr = vec![0.0f32; self.nch];
        for _ in 0..n {
            self.ingest(&fr, &kinds);
        }
    }

    fn handle_gap(&mut self, gap: u64, next_vals: &[f32]) {
        let nch = self.nch;
        let can_repair = gap as usize <= self.p.gap_repair_max_samples
            && self.chans.iter().zip(next_vals.iter()).all(|(c, v)| c.last_raw.is_some() && v.is_finite());
        if can_repair {
            let last: Vec<f32> = self.chans.iter().map(|c| c.last_raw.unwrap()).collect();
            let kinds = vec![Kind::Repaired; nch];
            let mut fr = vec![0.0f32; nch];
            for j in 1..=gap {
                let a = j as f64 / (gap + 1) as f64;
                for c in 0..nch {
                    fr[c] = (last[c] as f64 + (next_vals[c] as f64 - last[c] as f64) * a) as f32;
                }
                self.diag.repaired_samples += 1;
                self.ingest(&fr, &kinds);
            }
        } else {
            self.void_run(gap);
        }
    }

    /// Accelerometer (g) and gyroscope (deg/s) at session time `t`. Used only for gating.
    pub fn push_motion(&mut self, t: f64, acc: [f32; 3], gyro: [f32; 3]) {
        if !t.is_finite() || acc.iter().chain(gyro.iter()).any(|v| !v.is_finite()) {
            return;
        }
        let p = &self.p;
        let a = [acc[0] as f64, acc[1] as f64, acc[2] as f64];
        let g = m::sqrt(gyro.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>());
        let ms = &mut self.motion;
        let dt = ms.last_t.map(|lt| (t - lt).clamp(0.0, 1.0)).unwrap_or(0.02);
        ms.last_t = Some(t);
        let first = *ms.first_t.get_or_insert(t);
        let alpha = 1.0 - m::exp(-dt / 1.0);
        let lp = ms.acc_lp.get_or_insert(a);
        for k in 0..3 {
            lp[k] += alpha * (a[k] - lp[k]);
        }
        let dev = m::sqrt((0..3).map(|k| (a[k] - lp[k]) * (a[k] - lp[k])).sum::<f64>());
        if t - first <= p.gate_reference_s {
            ms.gyro_ref_vals.push(g);
            // The resting level is a low quantile, not the median: movement that starts
            // early then counts as movement instead of setting the reference (bake-off, E).
            let mut v = ms.gyro_ref_vals.clone();
            v.sort_by(|a, b| a.total_cmp(b));
            ms.gyro_ref = m::quantile_sorted(&v, p.motion_ref_quantile.clamp(0.0, 1.0));
        }
        let gthr = p.motion_gyro_min_dps.max(p.motion_gyro_k * ms.gyro_ref.unwrap_or(0.0));
        if g > gthr || dev > p.motion_acc_g {
            let i = m::round(t * self.rate).max(0.0) as u64;
            let half = m::round(dt * self.rate) as u64;
            let a0 = i.saturating_sub(self.pad + half);
            let b0 = i + self.pad;
            for c in 0..self.nch {
                self.mark(c, a0, b0, flag::MOTION);
            }
        }
    }

    /// Flag samples [a, b] on channel c, deferring the part not yet received.
    fn mark(&mut self, c: usize, a: u64, b: u64, bit: u16) {
        let next = self.next_idx;
        let ch = &mut self.chans[c];
        let lo = a.max(ch.flags.start);
        let hi_now = b.min(next.saturating_sub(1));
        if next > 0 && lo <= hi_now {
            for i in lo..=hi_now {
                *ch.flags.get_mut(i) |= bit;
            }
        }
        if b >= next {
            ch.pending.push((a.max(next), b, bit));
        }
    }

    fn ingest(&mut self, vals: &[f32], kinds: &[Kind]) {
        let idx = self.next_idx;
        let p = &self.p;
        let settle = m::round(p.gap_settle_s * self.rate) as u64;
        let ref_len = m::round(p.gate_reference_s * self.rate) as u64;
        let _ = ref_len;
        for (c, ch) in self.chans.iter_mut().enumerate() {
            let mut fl: u16 = 0;
            ch.pending.retain(|&(_, b, _)| b >= idx);
            for &(a, b, bit) in &ch.pending {
                if idx >= a && idx <= b {
                    fl |= bit;
                }
            }
            match kinds[c] {
                Kind::Invalid => {
                    fl |= flag::INVALID;
                    ch.raw.push(0.0);
                    ch.rawhp.push(0.0);
                    ch.x.push(0.0);
                    ch.lp.push(0.0);
                    ch.d.push(0.0);
                    if ch.primed {
                        ch.primed = false;
                    }
                    ch.settle_until = idx + 1 + settle;
                    self.diag.invalid_samples += 1;
                }
                k => {
                    if k == Kind::Repaired {
                        fl |= flag::REPAIRED;
                    }
                    let r = vals[c];
                    if !ch.primed {
                        ch.hp.prime(r as f64);
                        if let Some(n) = ch.notch.as_mut() {
                            n.reset();
                        }
                        ch.steplp.reset();
                        ch.primed = true;
                    }
                    ch.raw.push(r);
                    let h = ch.hp.process(r as f64);
                    ch.rawhp.push(h as f32);
                    let y = match ch.notch.as_mut() {
                        Some(n) => n.process(h),
                        None => h,
                    };
                    ch.x.push(y as f32);
                    let l = ch.steplp.process(y);
                    ch.lp.push(l as f32);
                    let lag = self.step_lag as u64;
                    let dv = if idx >= lag && ch.lp.contains(idx - lag) && ch.flags.contains(idx - lag) && ch.flags.get(idx - lag) & flag::INVALID == 0 {
                        l - ch.lp.get(idx - lag) as f64
                    } else {
                        0.0
                    };
                    ch.d.push(dv as f32);
                    if idx < ch.settle_until {
                        fl |= flag::SETTLE;
                    }
                    if ch.step_scale.is_none() || ch.musc_ref.is_none() {
                        fl |= flag::WARMUP;
                    }
                    ch.valid_seen += 1;
                    ch.last_raw = Some(r);
                }
            }
            ch.flags.push(fl);
        }
        self.next_idx = idx + 1;
        self.classify_steps(idx);
        let end = idx + 1;
        if end % self.quantum as u64 == 0 {
            self.block_detect(idx);
        }
        if end % self.fast_block as u64 == 0 {
            self.muscle_detect(idx, end % self.quantum as u64 == 0);
        }
        if end % self.qlen as u64 == 0 {
            self.quality_update(idx);
        }
        if !self.mains_fixed && self.mains.is_none() && end >= self.mains_next_check + (m::round(self.p.mains_detect_s * self.rate) as u64) {
            self.mains_next_check = end;
            self.detect_mains(idx);
        }
        self.fast_feed(idx);
        if end % self.fast_block as u64 == 0 {
            self.emit_fast(idx);
        }
        if end % self.quantum as u64 == 0 {
            self.slow_update(idx);
        }
    }

    /// Step detector (blink, eye movement, pop) at sample `idx` (spec 5.3).
    fn classify_steps(&mut self, idx: u64) {
        let nch = self.nch;
        let k = self.p.step_k;
        let mut z = vec![0.0f64; nch];
        let mut sign = vec![0.0f64; nch];
        for (c, ch) in self.chans.iter().enumerate() {
            if ch.flags.get(idx) & flag::INVALID != 0 {
                continue;
            }
            if let Some(s) = ch.step_scale {
                if s > 0.0 {
                    let dv = ch.d.get(idx) as f64;
                    z[c] = dv.abs() / (k * s);
                    sign[c] = dv.signum();
                }
            }
        }
        if z.iter().all(|v| *v < 1.0) {
            return;
        }
        let a = idx.saturating_sub(self.step_lag as u64 + self.pad);
        let b = idx + self.pad;
        let pf = self.p.step_partner_fraction;
        let fr = self.frontal.clone();
        let mut handled = vec![false; nch];
        // Frontal pair moving together: blink (same sign) or eye movement (opposite sign).
        // One side may cross a sample before the other, so the partner needs only part of
        // the threshold.
        if fr.len() >= 2 && (z[fr[0]] >= 1.0 || z[fr[1]] >= 1.0) && z[fr[0]].min(z[fr[1]]) >= pf {
            let bit = if sign[fr[0]] == sign[fr[1]] { flag::BLINK } else { flag::EYE };
            for &c in &fr[..2] {
                self.mark(c, a, b, bit);
                handled[c] = true;
            }
        }
        // Any other channel over threshold: a step with no partner is a pop; with a partner
        // on another channel it is a multi-channel movement.
        for c in 0..nch {
            if handled[c] || z[c] < 1.0 {
                continue;
            }
            let partner = (0..nch).any(|o| o != c && z[o] >= pf);
            let bit = if partner { flag::MOTION } else { flag::POP };
            self.mark(c, a, b, bit);
        }
    }

    /// Per-block reference for the step detector: median |step| of each clean block.
    fn block_detect(&mut self, idx: u64) {
        let p = self.p.clone();
        let rate = self.rate;
        let q = self.quantum as u64;
        let ref_len = m::round(p.gate_reference_s * rate) as u64;
        let warm_blocks = (m::ceil(p.gate_warmup_s / p.slow_update_s) as usize).max(4);
        let keep = (p.track_history_s / p.slow_update_s) as usize;
        let t = idx as f64 / rate;
        for ch in self.chans.iter_mut() {
            let start = (idx + 1).saturating_sub(q);
            if start < ch.flags.start {
                continue;
            }
            let mut dv = Vec::with_capacity(q as usize);
            let mut any_invalid = false;
            for i in start..=idx {
                if ch.flags.get(i) & flag::INVALID != 0 {
                    any_invalid = true;
                } else {
                    dv.push((ch.d.get(i) as f64).abs());
                }
            }
            let in_ref = ch.valid_seen <= ref_len;
            if !any_invalid && dv.len() == q as usize {
                let med = m::median(&dv).unwrap_or(0.0);
                if in_ref || ch.step_scale.is_none() {
                    ch.step_ref.push(med);
                    if ch.step_ref.len() >= warm_blocks {
                        ch.step_scale = m::median(&ch.step_ref);
                    }
                }
                ch.recent_step.push_back((t, med));
                while ch.recent_step.len() > keep {
                    ch.recent_step.pop_front();
                }
            }
        }
    }

    /// Muscle detector (spec 5.3): 30-45 Hz power of the last 128 samples (Hann) against the
    /// channel's reference level. Runs every fast frame so the artifact flag reacts within
    /// about 30 ms of the evidence; the reference only collects once per slow block.
    fn muscle_detect(&mut self, idx: u64, collect_ref: bool) {
        let mains = self.mains_list();
        let p = &self.p;
        let rate = self.rate;
        let ref_len = m::round(p.gate_reference_s * rate) as u64;
        let warm_blocks = (m::ceil(p.gate_warmup_s / p.slow_update_s) as usize).max(4);
        let keep = (p.track_history_s / p.slow_update_s) as usize;
        let thr = m::pow(10.0, p.muscle_db / 10.0);
        let t = idx as f64 / rate;
        let n = 128u64;
        let mut marks: Vec<(usize, u64, u64)> = Vec::new();
        for (c, ch) in self.chans.iter_mut().enumerate() {
            let s0 = (idx + 1).saturating_sub(n);
            if rate < 96.0 || idx + 1 < n || s0 < ch.x.start || (s0..=idx).any(|i| ch.flags.get(i) & flag::INVALID != 0) {
                continue;
            }
            let mut buf = vec![C::default(); n as usize];
            let mut mean = 0.0;
            for i in s0..=idx {
                mean += ch.x.get(i) as f64;
            }
            mean /= n as f64;
            for (j, i) in (s0..=idx).enumerate() {
                buf[j].re = (ch.x.get(i) as f64 - mean) * self.hann128[j];
            }
            self.fft128.forward(&mut buf);
            let df = rate / n as f64;
            let (mut s, mut cnt) = (0.0, 0);
            for (kk, v) in buf.iter().enumerate().take(n as usize / 2) {
                let f = kk as f64 * df;
                if f >= p.muscle_lo_hz && f <= p.muscle_hi_hz && !spectral::in_mains_zone(f, &mains, p.mains_exclusion_hz) {
                    s += v.norm_sqr();
                    cnt += 1;
                }
            }
            if cnt == 0 {
                continue;
            }
            let pw = s / cnt as f64;
            if collect_ref {
                let in_ref = ch.valid_seen <= ref_len;
                if in_ref || ch.musc_ref.is_none() {
                    ch.musc_ref_vals.push(pw);
                    if ch.musc_ref_vals.len() >= warm_blocks {
                        ch.musc_ref = m::median(&ch.musc_ref_vals);
                    }
                }
                ch.recent_musc.push_back((t, pw));
                while ch.recent_musc.len() > keep {
                    ch.recent_musc.pop_front();
                }
            }
            if let Some(r) = ch.musc_ref {
                if r > 0.0 && pw > r * thr {
                    marks.push((c, s0, idx));
                }
            }
        }
        for (c, a, b) in marks {
            self.mark(c, a.saturating_sub(self.pad), b + self.pad, flag::MUSCLE);
        }
    }

    fn mains_list(&self) -> Vec<f64> {
        match self.mains {
            Some(f) => vec![f as f64],
            None => vec![50.0, 60.0],
        }
    }

    /// Signal quality, once a second (spec 5.2).
    fn quality_update(&mut self, idx: u64) {
        let p = self.p.clone();
        let rate = self.rate;
        let qlen = self.qlen as u64;
        let start = (idx + 1).saturating_sub(qlen);
        let mains = self.mains_list();
        let mut badq: Vec<usize> = Vec::new();
        for c in 0..self.nch {
            let bg = self.site_bg[c];
            let ch = &mut self.chans[c];
            if start < ch.flags.start {
                continue;
            }
            let valid: Vec<u64> = (start..=idx).filter(|&i| ch.flags.get(i) & flag::INVALID == 0).collect();
            if (valid.len() as u64) * 2 < qlen {
                ch.usable = false;
                ch.q_why = Reason::Gap;
                ch.mains_uv = None;
                ch.sd_uv = None;
                ch.railed = None;
                ch.emg_db = None;
                continue;
            }
            let nv = valid.len() as f64;
            let mean = valid.iter().map(|&i| ch.x.get(i) as f64).sum::<f64>() / nv;
            let sd = m::sqrt(valid.iter().map(|&i| {
                let d = ch.x.get(i) as f64 - mean;
                d * d
            }).sum::<f64>() / nv);
            // Railed: at the converter limit, or inside a run of identical raw values.
            let mut railed = 0usize;
            let mut run = 1usize;
            let mut prev: Option<f32> = None;
            let mut in_run_counted = 0usize;
            for &i in &valid {
                let r = ch.raw.get(i);
                if (r as f64).abs() >= p.quality_rail_uv {
                    railed += 1;
                    prev = Some(r);
                    continue;
                }
                if prev == Some(r) {
                    run += 1;
                    if run == p.quality_flat_run {
                        railed += run;
                        in_run_counted = run;
                    } else if run > p.quality_flat_run {
                        railed += 1;
                        in_run_counted += 1;
                    }
                } else {
                    run = 1;
                }
                prev = Some(r);
            }
            let _ = in_run_counted;
            let railed_f = (railed as f64 / nv).min(1.0);
            // Mains amplitude: single-bin DFT on the high-passed, un-notched signal.
            let mut mains_amp: f64 = 0.0;
            for &mf in &mains {
                if mf >= rate / 2.0 {
                    continue;
                }
                let (mut re, mut im) = (0.0, 0.0);
                for (j, i) in (start..=idx).enumerate() {
                    let v = ch.rawhp.get(i) as f64;
                    let ph = m::TAU * mf * j as f64 / rate;
                    re += v * m::cos(ph);
                    im -= v * m::sin(ph);
                }
                mains_amp = mains_amp.max(2.0 * m::hypot(re, im) / qlen as f64);
            }
            // EMG: 30-100 Hz power (mains excluded) over the fitted background, last second.
            let mut emg = None;
            if let (Some(fit), Some(fft), true) = (bg, self.fft_q.as_ref(), valid.len() as u64 == qlen) {
                let mut buf = vec![C::default(); qlen as usize];
                for (j, i) in (start..=idx).enumerate() {
                    buf[j].re = (ch.x.get(i) as f64 - mean) * self.hann_q[j];
                }
                fft.forward(&mut buf);
                let w2: f64 = self.hann_q.iter().map(|w| w * w).sum();
                let df = rate / qlen as f64;
                let (mut sp, mut sb) = (0.0, 0.0);
                for (kk, v) in buf.iter().enumerate().take(qlen as usize / 2) {
                    let f = kk as f64 * df;
                    if (30.0..=100.0).contains(&f) && !spectral::in_mains_zone(f, &mains, p.mains_exclusion_hz) {
                        sp += 2.0 * v.norm_sqr() / (rate * w2);
                        sb += fit.at(f);
                    }
                }
                if sp > 0.0 && sb > 0.0 {
                    emg = Some(m::db(sp / sb));
                }
            }
            let pass = sd >= p.quality_sd_min_uv && sd <= p.quality_sd_max_uv && railed_f <= p.quality_railed_max && mains_amp <= p.quality_mains_max_uv;
            if pass {
                ch.pass_s += qlen as f64 / rate;
            } else {
                ch.pass_s = 0.0;
                badq.push(c);
            }
            ch.usable = ch.pass_s + 1e-9 >= p.channel_recovery_s;
            ch.q_why = if ch.usable { Reason::Ok } else if pass { Reason::WarmingUp } else { Reason::BadContact };
            ch.mains_uv = Some(mains_amp);
            ch.sd_uv = Some(sd);
            ch.railed = Some(railed_f);
            ch.emg_db = emg;
        }
        for c in badq {
            self.mark(c, start, idx, flag::BADQ);
        }
    }

    /// Detect 50 or 60 Hz mains from the un-notched spectrum (spec 5.1).
    fn detect_mains(&mut self, idx: u64) {
        let Some((fft, win)) = self.fft_mains.as_ref() else { return };
        let n = fft.len() as u64;
        let start = (idx + 1).saturating_sub(n);
        let rate = self.rate;
        let df = rate / n as f64;
        // Mains is common to every channel: average the channels' periodograms first (2 dof
        // each), so a chance excess of mains_detect_db over the neighbourhood is negligible.
        let mut acc = vec![0.0f64; n as usize / 2];
        let mut used = 0usize;
        for ch in &self.chans {
            if start < ch.rawhp.start || (start..=idx).any(|i| ch.flags.get(i) & flag::INVALID != 0) {
                continue;
            }
            let mut buf = vec![C::default(); n as usize];
            for (j, i) in (start..=idx).enumerate() {
                buf[j].re = ch.rawhp.get(i) as f64 * win[j];
            }
            fft.forward(&mut buf);
            for (a, v) in acc.iter_mut().zip(buf.iter()) {
                *a += v.norm_sqr();
            }
            used += 1;
        }
        let mut best: [f64; 2] = [f64::NEG_INFINITY; 2];
        if used >= 2 {
            let mut neigh = Vec::new();
            for (k, v) in acc.iter().enumerate() {
                let f = k as f64 * df;
                if (40.0..=70.0).contains(&f) && (f - 50.0).abs() > 2.0 && (f - 60.0).abs() > 2.0 {
                    neigh.push(*v);
                }
            }
            if let Some(med) = m::median(&neigh).filter(|v| *v > 0.0) {
                for (j, mf) in [50.0f64, 60.0].iter().enumerate() {
                    if *mf + 1.0 >= rate / 2.0 {
                        continue;
                    }
                    let line = acc.iter().enumerate().filter(|(k, _)| ((*k as f64) * df - mf).abs() <= 0.5).map(|(_, v)| *v).fold(0.0, f64::max);
                    best[j] = m::db(line / med);
                }
            }
        }
        let pick = if best[0] >= best[1] { 0 } else { 1 };
        if best[pick] >= self.p.mains_detect_db {
            let f = if pick == 0 { 50 } else { 60 };
            self.mains = Some(f);
            let settle = m::round(self.p.gap_settle_s * rate) as u64;
            let next = self.next_idx;
            for ch in self.chans.iter_mut() {
                let mut nb = Biquad::notch(rate, f as f64, self.p.notch_q);
                nb.reset();
                ch.notch = Some(nb);
                ch.settle_until = ch.settle_until.max(next + settle);
            }
            self.update_response();
        }
    }

    // -----------------------------------------------------------------------------
    // Fast path
    // -----------------------------------------------------------------------------

    fn site_sample(&self, site: usize, idx: u64) -> (f64, bool) {
        let sd = &self.sites[site];
        let (mut s, mut n) = (0.0, 0);
        for &c in &sd.members {
            let ch = &self.chans[c];
            if !ch.usable || !ch.flags.contains(idx) {
                continue;
            }
            if ch.flags.get(idx) & flag::GATED != 0 {
                if !sd.composite {
                    return (0.0, true);
                }
                continue;
            }
            s += ch.x.get(idx) as f64;
            n += 1;
        }
        if n == 0 {
            (0.0, true)
        } else {
            (s / n as f64, false)
        }
    }

    fn fast_feed(&mut self, idx: u64) {
        let mut any_gated = false;
        if self.trackers.is_empty() {
            let mut usable = 0;
            for ch in &self.chans {
                if ch.usable {
                    usable += 1;
                    if ch.flags.get(idx) & flag::GATED != 0 {
                        any_gated = true;
                    }
                }
            }
            if usable == 0 {
                any_gated = true;
            }
        } else {
            let keys: Vec<(u32, usize)> = self.trackers.iter().map(|(k, v)| (*k, v.0)).collect();
            for (id, site) in keys {
                let (x, gated) = self.site_sample(site, idx);
                // A composite with some members gated still counts as an artifact moment.
                let partial = self.sites[site].members.iter().any(|&c| {
                    let ch = &self.chans[c];
                    ch.usable && ch.flags.get(idx) & flag::GATED != 0
                });
                any_gated |= gated || partial;
                if let Some((_, t)) = self.trackers.get_mut(&id) {
                    t.push(x, gated);
                }
            }
        }
        self.fast_block_gated |= any_gated;
    }

    fn emit_fast(&mut self, idx: u64) {
        let t = idx as f64 / self.rate;
        let mut tracks = Vec::with_capacity(self.trackers.len());
        for (id, (_, tr)) in self.trackers.iter_mut() {
            let r = tr.read();
            tracks.push(FastTrack { id: *id, freq: r.freq, amp_uv: r.amp_uv, height_db: r.height_db, phase: r.phase, locked: r.locked, delay_s: r.delay_s });
        }
        let artifact = self.fast_block_gated;
        self.fast_block_gated = false;
        self.out.push(Frame::Fast(FastFrame { kind: FastKind::Fast, schema: SCHEMA_VERSION, t, tracks, artifact }));
    }

    // -----------------------------------------------------------------------------
    // Slow path
    // -----------------------------------------------------------------------------

    fn fixed_band_edges() -> BandMap<[f64; 2]> {
        BandMap { delta: [1.0, 4.0], theta: [4.0, 8.0], alpha: [8.0, 13.0], beta: [13.0, 30.0], gamma: [30.0, 45.0] }
    }

    fn band_edges(&self) -> BandMap<[f64; 2]> {
        match self.iaf {
            None => Self::fixed_band_edges(),
            Some(i) => BandMap { delta: [1.0, 0.4 * i], theta: [0.4 * i, 0.8 * i], alpha: [0.8 * i, 1.2 * i], beta: [1.2 * i, 30.0], gamma: [30.0, 45.0] },
        }
    }

    fn band_of(&self, f: f64) -> BandName {
        let e = self.band_edges();
        for b in BandName::ALL {
            let [lo, hi] = *e.get(b);
            if f < hi && f >= lo {
                return b;
            }
        }
        if f < e.delta[0] {
            BandName::Delta
        } else {
            BandName::Gamma
        }
    }

    fn chan_window(&self, c: usize, end: u64) -> ChanWin {
        let ch = &self.chans[c];
        let w = self.wlen as u64;
        let have = self.first_idx.map(|f| end.saturating_sub(f)).unwrap_or(0);
        let null = |why, cf, arts| ChanWin { clean_fraction: cf, artifacts: arts, why, member: None };
        if have < w {
            return null(Reason::WarmingUp, 0.0, Vec::new());
        }
        let start = end - w;
        let (mut inval, mut rep, mut clean) = (0usize, 0usize, 0usize);
        let mut any = 0u16;
        let mut runs: Vec<(u64, usize)> = Vec::new();
        let mut run_start: Option<u64> = None;
        for i in start..end {
            let f = ch.flags.get(i);
            any |= f;
            if f & flag::INVALID != 0 {
                inval += 1;
            }
            if f & flag::REPAIRED != 0 {
                rep += 1;
            }
            if f & flag::GATED == 0 {
                clean += 1;
                if run_start.is_none() {
                    run_start = Some(i);
                }
            } else if let Some(s) = run_start.take() {
                runs.push((s, (i - s) as usize));
            }
        }
        if let Some(s) = run_start {
            runs.push((s, (end - s) as usize));
        }
        let mut arts = Vec::new();
        if any & flag::BLINK != 0 {
            arts.push(ArtifactKind::Blink);
        }
        if any & flag::EYE != 0 {
            arts.push(ArtifactKind::EyeMovement);
        }
        if any & flag::MUSCLE != 0 {
            arts.push(ArtifactKind::Muscle);
        }
        if any & flag::MOTION != 0 {
            arts.push(ArtifactKind::Motion);
        }
        if any & flag::POP != 0 {
            arts.push(ArtifactKind::Pop);
        }
        if any & (flag::INVALID | flag::REPAIRED | flag::SETTLE) != 0 {
            arts.push(ArtifactKind::Gap);
        }
        let cf = clean as f64 / w as f64;
        if !ch.usable {
            return null(ch.q_why, cf, arts);
        }
        if inval > 0 || rep as f64 > self.p.repaired_max_fraction * w as f64 {
            return null(Reason::Gap, cf, arts);
        }
        let longest = runs.iter().map(|r| r.1).max().unwrap_or(0);
        if cf < self.p.min_clean_fraction || longest < self.min_len {
            let why = if any & flag::WARMUP != 0 && clean == 0 { Reason::WarmingUp } else { Reason::InsufficientClean };
            return ChanWin { clean_fraction: cf, artifacts: arts, why, member: None };
        }
        let mut eig = Vec::new();
        for &(s, len) in &runs {
            if let Some(l) = self.mt.usable_len(len) {
                let s2 = s + (len - l) as u64;
                let xs: Vec<f64> = (s2..s2 + l as u64).map(|i| ch.x.get(i) as f64).collect();
                self.mt.eigenspectra(&xs, &mut eig);
            }
        }
        if eig.len() < 2 {
            return ChanWin { clean_fraction: cf, artifacts: arts, why: Reason::InsufficientClean, member: None };
        }
        ChanWin { clean_fraction: cf, artifacts: arts, why: Reason::Ok, member: Some(Member::new(eig)) }
    }

    /// The longest stretch inside the window that is clean on every listed channel.
    fn joint_run(&self, chans: &[usize], end: u64) -> Option<(u64, usize)> {
        let w = self.wlen as u64;
        if chans.is_empty() || end < w {
            return None;
        }
        let start = end - w;
        let mut best: Option<(u64, usize)> = None;
        let mut rs: Option<u64> = None;
        for i in start..=end {
            let clean = i < end && chans.iter().all(|&c| {
                let ch = &self.chans[c];
                ch.usable && ch.flags.contains(i) && ch.flags.get(i) & flag::GATED == 0
            });
            if clean {
                if rs.is_none() {
                    rs = Some(i);
                }
            } else if let Some(s) = rs.take() {
                let len = (i - s) as usize;
                if best.is_none_or(|b| len > b.1) {
                    best = Some((s, len));
                }
            }
        }
        best.filter(|b| b.1 >= self.min_len)
    }

    fn signal(&self, chans: &[usize], s: u64, len: usize) -> Vec<f64> {
        (s..s + len as u64).map(|i| chans.iter().map(|&c| self.chans[c].x.get(i) as f64).sum::<f64>() / chans.len() as f64).collect()
    }

    fn process_markers(&mut self, t: f64) {
        while let Some(mk) = self.markers.front() {
            if mk.t > t {
                break;
            }
            let mk = self.markers.pop_front().unwrap();
            match mk.kind {
                MarkerType::BaselineStart => self.baseline_start = Some(mk.t),
                MarkerType::BaselineEnd => {
                    if let Some(s) = self.baseline_start.take() {
                        self.close_baseline(s, mk.t);
                    }
                }
                _ => {}
            }
        }
    }

    /// At the end of a baseline block: each pair's log-ratio density (spec 8.4 T3 needs it),
    /// and tighten (never loosen) the gating references (spec 5.3).
    fn close_baseline(&mut self, s: f64, e: f64) {
        let us = self.p.slow_update_s;
        let need = (self.p.integration_s / us) as usize;
        let n = self.tracks.len();
        for i in 0..n {
            for j in (i + 1)..n {
                let (a, b) = (&self.tracks[i], &self.tracks[j]);
                let mut xs = Vec::new();
                for (k, fa) in a.hist_f.iter().enumerate() {
                    let t = a.hist_t0 + k as f64 * us;
                    if t < s || t > e {
                        continue;
                    }
                    let kb = m::round((t - b.hist_t0) / us);
                    if kb < 0.0 || kb as usize >= b.hist_f.len() {
                        continue;
                    }
                    let fb = b.hist_f[kb as usize];
                    xs.push(m::ln(fa.max(fb) / fa.min(fb)));
                }
                if xs.len() >= need {
                    let mu = xs.iter().sum::<f64>() / xs.len() as f64;
                    let var = xs.iter().map(|x| (x - mu) * (x - mu)).sum::<f64>() / (xs.len() as f64 - 1.0);
                    let key = if a.id < b.id { (a.id, b.id) } else { (b.id, a.id) };
                    self.baselines.insert(key, (mu, var));
                }
            }
        }
        let warm = 4;
        for ch in self.chans.iter_mut() {
            let st: Vec<f64> = ch.recent_step.iter().filter(|(t, _)| *t >= s && *t <= e).map(|v| v.1).collect();
            if st.len() >= warm {
                if let (Some(nv), Some(cur)) = (m::median(&st), ch.step_scale) {
                    ch.step_scale = Some(cur.min(nv));
                }
            }
            let mu: Vec<f64> = ch.recent_musc.iter().filter(|(t, _)| *t >= s && *t <= e).map(|v| v.1).collect();
            if mu.len() >= warm {
                if let (Some(nv), Some(cur)) = (m::median(&mu), ch.musc_ref) {
                    ch.musc_ref = Some(cur.min(nv));
                }
            }
        }
    }

    fn slow_update(&mut self, idx: u64) {
        let t = idx as f64 / self.rate;
        let end = idx + 1;
        self.update_count += 1;
        let u = self.update_count;
        self.diag.slow_updates += 1;
        self.process_markers(t);
        let p = self.p.clone();
        let nsites = self.sites.len();
        let mains = self.mains_list();
        let df = self.mt.df;

        // Per channel windows and spectra.
        let mut cw: Vec<ChanWin> = (0..self.nch).map(|c| self.chan_window(c, end)).collect();
        // Sites.
        let alpha_site = p.alpha_peak / nsites as f64;
        let mut analyses: Vec<Result<SiteAnalysis, Reason>> = Vec::with_capacity(nsites);
        for s in 0..nsites {
            let sd = &self.sites[s];
            let res = if !sd.composite {
                let c = sd.members[0];
                match cw[c].member.take() {
                    Some(mb) => Ok(SiteSpec::from_members(vec![mb])),
                    None => Err(cw[c].why),
                }
            } else {
                let mut mbs = Vec::new();
                let mut first_why = None;
                for &c in &sd.members {
                    match &analyses[c] {
                        Ok(a) => mbs.push(a.spec.members[0].clone()),
                        Err(w) => {
                            if first_why.is_none() {
                                first_why = Some(*w);
                            }
                        }
                    }
                }
                if mbs.is_empty() {
                    Err(first_why.unwrap_or(Reason::NoData))
                } else {
                    Ok(SiteSpec::from_members(mbs))
                }
            };
            analyses.push(res.map(|spec| analyse_site(spec, df, &p, &mains, alpha_site, &self.response)));
        }
        // Background fits for EMG and the fast path.
        let mut any_analysed = false;
        let mut any_pass = false;
        for (s, a) in analyses.iter().enumerate() {
            if let Ok(a) = a {
                any_analysed = true;
                self.diag.site_windows += 1;
                if let Ok(f) = a.bg_fit {
                    self.site_bg[s] = Some(f);
                }
                if !a.peaks.is_empty() {
                    any_pass = true;
                    self.diag.site_windows_with_passing_peak += 1;
                }
            }
        }
        if any_analysed {
            self.diag.windows_analysed += 1;
        }
        if any_pass {
            self.diag.windows_with_passing_peak += 1;
        }

        // Persistence (spec 6.3, item 3): passing now and in enough earlier non-overlapping windows.
        let mut persistent: Vec<(usize, Peak)> = Vec::new();
        for s in 0..nsites {
            let now: Vec<Peak> = match &analyses[s] {
                Ok(a) => a.peaks.clone(),
                Err(_) => Vec::new(),
            };
            let hist = &mut self.persist[s];
            let keep = (self.nonoverlap * p.persistence_of as u64) as usize + 1;
            for pk in &now {
                let mut count = 1;
                for k in 1..p.persistence_of as u64 {
                    let back = u.saturating_sub(k * self.nonoverlap);
                    if back == 0 || back == u {
                        continue;
                    }
                    if let Some((_, prev)) = hist.iter().find(|(uu, _)| *uu == back) {
                        if prev.iter().any(|q| (q.f - pk.f).abs() <= join_dist_at(pk.f, q.se, pk.se, &p)) {
                            count += 1;
                        }
                    }
                }
                if count >= p.persistence_need {
                    persistent.push((s, pk.clone()));
                }
            }
            hist.push_back((u, now));
            while hist.len() > keep {
                hist.pop_front();
            }
        }

        // Cluster across sites: one observation per rhythm, at its strongest site.
        persistent.sort_by(|a, b| b.1.h.total_cmp(&a.1.h).then(a.0.cmp(&b.0)).then(a.1.f.total_cmp(&b.1.f)));
        let mut used = vec![false; persistent.len()];
        let mut obs: Vec<Obs> = Vec::new();
        for i in 0..persistent.len() {
            if used[i] {
                continue;
            }
            used[i] = true;
            let (s0, ref pk0) = persistent[i];
            for j in (i + 1)..persistent.len() {
                if !used[j] && persistent[j].0 != s0 && (persistent[j].1.f - pk0.f).abs() <= join_dist_at(pk0.f, pk0.se, persistent[j].1.se, &p) {
                    used[j] = true;
                }
            }
            obs.push(Obs { site: s0, peak: pk0.clone() });
        }
        obs.sort_by(|a, b| a.peak.f.total_cmp(&b.peak.f));
        self.link_tracks(t, obs, &p);

        // Integrated frequency and history.
        let cap = (p.track_history_s / p.slow_update_s) as usize;
        let window_s = self.wlen as f64 / self.rate;
        for tr in self.tracks.iter_mut() {
            tr.integrate(t, window_s, &p);
            let before = tr.hist_f.len();
            tr.push_history(cap);
            if before == cap && tr.hist_f.len() == cap && tr.f_int.is_some() {
                // One entry dropped from the front.
                tr.hist_t0 += p.slow_update_s;
            }
        }
        // Per-site matches.
        for tr in self.tracks.iter_mut() {
            let f = tr.cur.as_ref().map(|c| c.f).unwrap_or(tr.last_f);
            for s in 0..nsites {
                tr.per_site[s] = None;
                if let Ok(a) = &analyses[s] {
                    let mut best: Option<&Peak> = None;
                    for pk in &a.peaks {
                        if (pk.f - f).abs() <= join_dist_at(f, pk.se, tr.last_se, &p) && best.is_none_or(|b| (pk.f - f).abs() < (b.f - f).abs()) {
                            best = Some(pk);
                        }
                    }
                    tr.per_site[s] = best.cloned();
                }
            }
        }
        self.detect_harmonics(t, end, &p);

        // Ratios, cascades, chance, states.
        let (pairs_out, cascades, states) = self.score(t, u, &p);

        // Hemispheres and front-back.
        let hemispheres = match (self.tp9, self.tp10) {
            (Some(a), Some(b)) => self.compare_sites(a, b, &[a], &[b], end, &p),
            _ => Vec::new(),
        };
        let front_back = match (self.frontal_site, self.temporal_site) {
            (Some(fs), Some(ts)) => {
                let fm: Vec<usize> = self.sites[fs].members.iter().copied().filter(|&c| self.chans[c].usable).collect();
                let tm: Vec<usize> = self.sites[ts].members.iter().copied().filter(|&c| self.chans[c].usable).collect();
                self.compare_sites(fs, ts, &fm, &tm, end, &p)
            }
            _ => Vec::new(),
        };

        self.sync_trackers(&p);

        // Frame.
        let quality: Vec<ChannelQuality> = (0..self.nch)
            .map(|c| {
                let ch = &self.chans[c];
                ChannelQuality {
                    name: ch.name.clone(),
                    usable: ch.usable,
                    why: ch.q_why,
                    mains_uv: ch.mains_uv,
                    sd_uv: ch.sd_uv,
                    railed: ch.railed,
                    emg_db: ch.emg_db,
                    clean_fraction: cw[c].clean_fraction,
                    artifacts: cw[c].artifacts.clone(),
                }
            })
            .collect();
        let edges = self.band_edges();
        let spectra: Vec<SiteSpectrum> = (0..nsites).map(|s| self.site_output(s, &analyses[s], &edges, &p)).collect();
        let tracks_out: Vec<Track> = self.tracks.iter().map(|tr| self.track_output(tr, t, &p)).collect();
        let dominant = self
            .tracks
            .iter()
            .filter_map(|tr| tr.cur.as_ref().map(|c| (tr.id, c.h)))
            .fold(None, |acc: Option<(u32, f64)>, (id, h)| match acc {
                Some((_, bh)) if bh >= h => acc,
                _ => Some((id, h)),
            })
            .map(|v| v.0);
        let frame = SlowFrame {
            kind: SlowKind::Slow,
            schema: SCHEMA_VERSION,
            t,
            window_s,
            quality,
            spectra,
            tracks: tracks_out,
            dominant,
            pairs: pairs_out,
            cascades,
            states,
            hemispheres,
            front_back,
            mains_hz: self.mains,
            iaf_hz: self.iaf,
            band_edges: edges,
        };
        self.out.push(Frame::Slow(Box::new(frame)));
    }

    fn link_tracks(&mut self, t: f64, obs: Vec<Obs>, p: &Params) {
        let nt = self.tracks.len();
        let no = obs.len();
        let mut cands: Vec<(f64, usize, usize)> = Vec::new();
        for (ti, tr) in self.tracks.iter().enumerate() {
            for (oi, o) in obs.iter().enumerate() {
                let (rf, rse) = tr.ref_f();
                let d = (o.peak.f - rf).abs();
                if d <= join_dist_at(rf, o.peak.se, rse, p) {
                    cands.push((d, ti, oi));
                }
            }
        }
        cands.sort_by(|a, b| a.0.total_cmp(&b.0).then(self.tracks[a.1].id.cmp(&self.tracks[b.1].id)).then(a.2.cmp(&b.2)));
        let mut t_obs: Vec<Option<usize>> = vec![None; nt];
        let mut o_tr: Vec<Option<usize>> = vec![None; no];
        for &(_, ti, oi) in &cands {
            if t_obs[ti].is_none() && o_tr[oi].is_none() {
                t_obs[ti] = Some(oi);
                o_tr[oi] = Some(ti);
            }
        }
        let mut removed = vec![false; nt];
        // Merge: an unmatched track whose rhythm another track took. The older id survives.
        for &(_, ti, oi) in &cands {
            if t_obs[ti].is_some() || removed[ti] {
                continue;
            }
            if let Some(tj) = o_tr[oi] {
                if tj == ti || removed[tj] {
                    continue;
                }
                // Review: two tracks are merged only when they have themselves converged
                // (their own frequencies within the joining distance), not whenever one of
                // them is without a peak this window and the other's peak is in reach. The
                // old rule let the older track take a neighbouring rhythm's peak and removed
                // that rhythm's own track.
                let ((fa, sa), (fb, sb)) = (self.tracks[ti].ref_f(), self.tracks[tj].ref_f());
                if (fa - fb).abs() > join_dist_at(fa.min(fb), sa, sb, p) {
                    continue;
                }
                let (ida, idb) = (self.tracks[ti].id, self.tracks[tj].id);
                if ida < idb {
                    t_obs[ti] = Some(oi);
                    t_obs[tj] = None;
                    o_tr[oi] = Some(ti);
                    removed[tj] = true;
                    self.diag.events.push(TrackEvent::Merged { t, kept: ida, removed: idb });
                } else {
                    removed[ti] = true;
                    self.diag.events.push(TrackEvent::Merged { t, kept: idb, removed: ida });
                }
            }
        }
        // Observe.
        for ti in 0..nt {
            if removed[ti] {
                continue;
            }
            match t_obs[ti] {
                Some(oi) => self.tracks[ti].observe(t, &obs[oi]),
                None => self.tracks[ti].cur = None,
            }
        }
        // Split or new.
        let nsites = self.sites.len();
        let mut born = Vec::new();
        for (oi, o) in obs.iter().enumerate() {
            if o_tr[oi].is_some() {
                continue;
            }
            // Review: a rhythm that waxes and wanes fails persistence for a few seconds and its
            // track ends. When it comes back at the same place it is the same rhythm: the
            // track continues, with its window estimates of the last integration time (the
            // gap simply holds none) and its history. Before, every return was a new track
            // that started again from one window's uncertainty; on the lab's 120 s cascade
            // files a planted rhythm went through 3 to 6 ids, and pairs spent most of the
            // time unresolved.
            let mut best: Option<(usize, f64)> = None;
            for (di, d) in self.dormant.iter().enumerate() {
                let (rf, rse) = d.ref_f();
                let dist = (o.peak.f - rf).abs();
                if dist <= join_dist_at(rf, o.peak.se, rse, p) && best.is_none_or(|b| dist < b.1) {
                    best = Some((di, dist));
                }
            }
            if let Some((di, _)) = best {
                let mut tr = self.dormant.remove(di);
                tr.observe(t, o);
                tr.per_site = vec![None; nsites];
                self.diag.events.push(TrackEvent::Resumed { t, id: tr.id });
                born.push(tr);
                continue;
            }
            let id = self.next_track_id;
            self.next_track_id += 1;
            let from = cands.iter().find(|c| c.2 == oi).map(|c| self.tracks[c.1].id);
            match from {
                Some(f) => self.diag.events.push(TrackEvent::Split { t, from: f, new: id }),
                None => self.diag.events.push(TrackEvent::Born { t, id }),
            }
            born.push(TrackInt::new(id, t, o, nsites));
        }
        // Drop merged tracks and those past their hold.
        let mut keep = Vec::with_capacity(nt + born.len());
        for (ti, tr) in std::mem::take(&mut self.tracks).into_iter().enumerate() {
            if removed[ti] {
                continue;
            }
            if tr.cur.is_none() && t - tr.last_pass_t > p.peak_hold_s {
                self.diag.events.push(TrackEvent::Ended { t, id: tr.id });
                if p.track_resume_s > 0.0 {
                    self.dormant.push(tr);
                }
                continue;
            }
            keep.push(tr);
        }
        self.dormant.retain(|d| t - d.last_pass_t <= p.track_resume_s);
        keep.extend(born);
        keep.sort_by_key(|tr| tr.id);
        self.tracks = keep;
        if self.diag.events.len() > 10_000 {
            let d = self.diag.events.len() - 10_000;
            self.diag.events.drain(0..d);
        }
    }

    /// Harmonic trap (spec 6.6): integer ratio within tolerance, frequencies consistent with
    /// the exact multiple, and n:1 phase locking in excess of time-shifted surrogates.
    fn detect_harmonics(&mut self, t: f64, end: u64, p: &Params) {
        let n = self.tracks.len();
        let trim = m::round(0.5 * self.rate) as usize;
        let min_shift = m::round(p.compare_min_shift_s * self.rate) as usize;
        // Every pair tested this update: (lower id, upper id), n, the locking vector, the
        // surrogate level (None when the upper track is outside the harmonic's band), and
        // whether this one window is decisive.
        let mut tests: Vec<((u32, u32), u32, C, Option<f64>, bool)> = Vec::new();
        let mut seen: Vec<((u32, u32), u32)> = Vec::new();
        for i in 0..n {
            for j in 0..n {
                if i == j {
                    continue;
                }
                let (lo, hi) = (&self.tracks[i], &self.tracks[j]);
                let (Some(pl), Some(ph)) = (&lo.cur, &hi.cur) else { continue };
                if ph.f <= pl.f {
                    continue;
                }
                let r = ph.f / pl.f;
                let nn = m::round(r) as u32;
                if nn < 2 || nn as usize > p.harmonic_max_n {
                    continue;
                }
                // Review: the upper track is a candidate when it sits inside the band where
                // the harmonic would be (n times as wide as the lower rhythm), or within the
                // error of the two centres. The alignment tolerance is not the right gate
                // here: one window's centres are off by more than 3 % for a broad rhythm,
                // and the phase test below, made at exactly n times the lower frequency,
                // is what decides.
                // It is never wider than twice the alignment tolerance in ratio, so a golden
                // ratio pair (19 % from 2:1) or a 1.8 near miss is not a candidate.
                let nf = nn as f64;
                let tol = (3.0 * m::sqrt(ph.se * ph.se + nf * nf * pl.se * pl.se)).max(self.mt.df).max(0.5 * nf * pl.width);
                if (ph.f - nf * pl.f).abs() > tol || m::ln(r / nf).abs() > 2.0 * p.tolerance {
                    // Out of the harmonic's band: evidence against an existing mark.
                    tests.push(((lo.id, hi.id), nn, C::default(), None, false));
                    continue;
                }
                // Channel: where the lower rhythm is strongest among channel sites.
                let mut chan: Option<(usize, f64)> = None;
                for c in 0..self.nch {
                    if let Some(pk) = &lo.per_site[c] {
                        if chan.is_none_or(|b| pk.h > b.1) {
                            chan = Some((c, pk.h));
                        }
                    }
                }
                let c = match chan {
                    Some((c, _)) => c,
                    None => match self.sites[lo.site].members.iter().copied().find(|&c| self.chans[c].usable) {
                        Some(c) => c,
                        None => continue,
                    },
                };
                // In the harmonic's band: the pair is a candidate from now on, tested or not.
                seen.push(((lo.id, hi.id), nn));
                let Some((s, len)) = self.joint_run(&[c], end) else { continue };
                let x = self.signal(&[c], s, len);
                let sd = (pl.width / 2.3548).max(0.3);
                let a_lo = self.analytic.band(&x, self.rate, pl.f, sd);
                let a_hi = self.analytic.band(&x, self.rate, nf * pl.f, nf * sd);
                if let Some((z, sur)) = compare::locking_vector(&a_lo, &a_hi, nn, trim, p.compare_shifts, min_shift) {
                    let plv = z.abs();
                    // Review: a pair whose locking survives the time shifts too is steady at
                    // exactly n:1 for the whole window. A shift cannot tell that from a harmonic
                    // (a strictly periodic waveform is its own shifted copy), so it is flagged.
                    let steady = sur >= p.harmonic_plv_min;
                    let strong = plv >= p.harmonic_plv_min && (plv - sur >= p.harmonic_plv_excess || steady);
                    tests.push(((lo.id, hi.id), nn, z, Some(sur), strong));
                }
            }
        }
        // Review: the mark is decided from the pair's history, not from one window (spec 6.6).
        // A harmonic keeps the same phase against its fundamental from window to window, so
        // the locking vectors of successive windows add; for two rhythms that are not locked
        // they point anywhere and cancel. The mean vector over the last integration time is
        // tested against the surrogate level: with m independent windows and unlocked phases
        // its squared length is exponential with mean (4 / pi) sur^2 / m.
        //   mark:    one decisive window (the old rule), or p <= harmonic_alpha;
        //   release: p > harmonic_release_p with at least two slow windows of tests.
        // A window in which the test could not be made says nothing and changes nothing.
        // Before, a mark lapsed 2 s after the last decisive window, and a harmonic whose
        // windows locked at 0.4 to 0.6 (under the 0.7 limit, far over the surrogates' 0.2)
        // was credited as an octave pair for most of a recording.
        let fresh = |nn: u32| HarmonicMark { n: nn, marked: false, done: 0, seen_t: t, tests: VecDeque::new() };
        for (k, nn) in seen {
            let e = self.harmonics.entry(k).or_insert_with(|| fresh(nn));
            if e.n != nn {
                *e = fresh(nn);
            }
            e.seen_t = t;
        }
        let keep_s = p.integration_s.max(2.0 * p.slow_window_s);
        for (k, nn, z, sur, strong) in tests {
            // A window with the upper track outside the harmonic's band counts against a pair
            // that is already a candidate. It never makes one: a pair that was never in a
            // harmonic's band has nothing pending. (Before, it did, and every pair with a
            // ratio of 1.5 or more, a golden pair included, was kept out of the cascades as
            // "pending" for 3 s in every 33.)
            if sur.is_none() && self.harmonics.get(&k).is_none_or(|h| h.n != nn) {
                continue;
            }
            let e = self.harmonics.entry(k).or_insert_with(|| fresh(nn));
            if e.n != nn {
                *e = fresh(nn);
            }
            // A window with the upper track outside the harmonic's band is a test too (and
            // one it failed).
            e.done = e.done.saturating_add(1);
            e.tests.push_back((t, z, sur));
            while e.tests.front().is_some_and(|(t0, _, _)| t - *t0 > keep_s) {
                e.tests.pop_front();
            }
            let span = e.tests.front().map(|(t0, _, _)| t - *t0).unwrap_or(0.0);
            let cnt = e.tests.len() as f64;
            let mut zsum = C::default();
            let (mut ssum, mut sn) = (0.0, 0.0);
            for (_, zz, ss) in e.tests.iter() {
                zsum = zsum + *zz;
                if let Some(v) = ss {
                    ssum += *v;
                    sn += 1.0;
                }
            }
            let p_lock = if sn > 0.0 && ssum > 0.0 {
                let sbar = ssum / sn;
                let m_ind = 1.0 + span / p.slow_window_s;
                m::exp(-m::PI * m_ind * zsum.scale(1.0 / cnt).norm_sqr() / (4.0 * sbar * sbar))
            } else {
                1.0
            };
            if strong || p_lock <= p.harmonic_alpha {
                e.marked = true;
            } else if e.marked && span >= 2.0 * p.slow_window_s && p_lock > p.harmonic_release_p {
                e.marked = false;
            }
        }
        let ids: BTreeSet<u32> = self.tracks.iter().map(|t| t.id).collect();
        // A pair that is not marked and has not been in a harmonic's band for a while is no
        // longer a candidate.
        let known = |id: &u32| ids.contains(id) || self.dormant.iter().any(|d| d.id == *id);
        self.harmonics.retain(|(a, b), h| known(a) && known(b) && (h.marked || t - h.seen_t <= keep_s));
    }

    /// The pairs kept out of octave alignment and cascades (spec 6.6): pairs marked harmonic,
    /// pairs in a harmonic's band whose phase test has not yet been made often enough to
    /// say ("pending"), and pairs of two harmonics of one fundamental (2f and 3f are one
    /// waveform, and their ratio of 1.5 is no relationship between rhythms).
    fn harmonic_set(&self, p: &Params) -> BTreeSet<(u32, u32)> {
        let key = |a: u32, b: u32| if a < b { (a, b) } else { (b, a) };
        let mut out = BTreeSet::new();
        let mut by_base: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for (&(lo, hi), h) in self.harmonics.iter() {
            if h.marked || (h.done as usize) < p.harmonic_pending_tests {
                out.insert(key(lo, hi));
            }
            if h.marked {
                by_base.entry(lo).or_default().push(hi);
            }
        }
        // Pending also covers a pair that sits at an integer ratio by its integrated
        // frequencies and has no test behind it yet (a track just born or just resumed).
        for (i, a) in self.tracks.iter().enumerate() {
            for b in self.tracks.iter().skip(i + 1) {
                let (Some((fa, _)), Some((fb, _))) = (a.f_int, b.f_int) else { continue };
                let (lo, hi, r) = if fa <= fb { (a.id, b.id, fb / fa) } else { (b.id, a.id, fa / fb) };
                let nn = m::round(r);
                if nn < 2.0 || nn as usize > p.harmonic_max_n || m::ln(r / nn).abs() > 2.0 * p.tolerance {
                    continue;
                }
                let tested = self.harmonics.get(&(lo, hi)).is_some_and(|h| h.done as usize >= p.harmonic_pending_tests);
                if !tested {
                    out.insert(key(lo, hi));
                }
            }
        }
        for ups in by_base.values() {
            for (i, a) in ups.iter().enumerate() {
                for b in &ups[i + 1..] {
                    out.insert(key(*a, *b));
                }
            }
        }
        out
    }

    #[allow(clippy::type_complexity)]
    fn score(&mut self, t: f64, u: u64, p: &Params) -> (Vec<PairScore>, PhiOctave<Cascade>, States) {
        let mut scored: Vec<ScoreTrack> = self.tracks.iter().filter_map(|tr| tr.f_int.map(|(f, se)| ScoreTrack { id: tr.id, f, se })).collect();
        scored.sort_by(|a, b| a.f.total_cmp(&b.f).then(a.id.cmp(&b.id)));
        let harm = self.harmonic_set(p);
        let baselines = self.baselines.clone();
        let mut ctx = ScoreCtx::new(p, &harm, &baselines);
        // Chance A places each surrogate inside the band in force for its real track.
        let edges = self.band_edges();
        let bands: Vec<[f64; 2]> = BandName::ALL.iter().map(|b| *edges.get(*b)).collect();
        ctx.null_bands = ratios::clip_null_bands(&bands, p);
        let sc = ratios::score_set(&scored, &ctx);

        // Chance refresh: every chance_refresh_s, or when the scored set changes.
        let sig: Vec<u32> = {
            let mut v: Vec<u32> = scored.iter().map(|s| s.id).collect();
            v.sort();
            v
        };
        let refresh_every = (m::round(p.chance_refresh_s / p.slow_update_s) as u64).max(1);
        let need_refresh = !self.chance.valid || sig != self.chance.sig || u - self.chance.at_update >= refresh_every;
        if need_refresh {
            self.diag.chance_refreshes += 1;
            self.chance.valid = true;
            self.chance.sig = sig;
            self.chance.at_update = u;
            if scored.len() >= 2 {
                let mut rng = Rng::derive(self.seed, 0xA, u);
                let a = ratios::chance_a(&scored, &ctx, &mut rng);
                self.chance.thr_a = [ratios::static_threshold(&a[0], p), ratios::static_threshold(&a[1], p)];
                self.chance.a = Some(a);
            } else {
                self.chance.a = None;
                self.chance.thr_a = [None, None];
            }
            let us = p.slow_update_s;
            let need = (p.chance_b_need_s() / us) as usize;
            let min_lag = (m::round(p.chance_b_min_lag_s / us) as usize).max(1);
            let by_id: BTreeMap<u32, &TrackInt> = self.tracks.iter().map(|t| (t.id, t)).collect();
            let hists: Vec<ratios::History> = scored
                .iter()
                .filter_map(|s| by_id.get(&s.id).map(|tr| ratios::History { id: tr.id, f: &tr.hist_f, se: &tr.hist_se }))
                .collect();
            let shortest = hists.iter().map(|h| h.f.len()).min().unwrap_or(0);
            if scored.len() >= 2
                && hists.len() == scored.len()
                && shortest >= need.max(2 * min_lag + 2)
                && ratios::chance_b_feasible(p, hists.len(), shortest, min_lag)
            {
                self.diag.chance_b_refreshes += 1;
                let mut rng = Rng::derive(self.seed, 0xB, u);
                let step = (m::round(1.0 / us) as usize).max(1);
                let span = hists.iter().map(|h| h.f.len()).min().unwrap().min((p.chance_b_span_s / us) as usize);
                let dwell_steps = (m::ceil(p.dwell_s / (step as f64 * us)) as usize).max(1);
                let b = ratios::chance_b(&hists, &ctx, &mut rng, min_lag, step, span, dwell_steps, step as f64 * us);
                self.chance.thr_b = b.thresholds;
                self.chance.b = Some(b.dists);
                self.chance.b_p_floor = ratios::chance_b_p_floor(p, shortest as f64 * us);
            } else {
                self.chance.b = None;
                self.chance.thr_b = [None, None];
            }
        }

        // Pairs.
        let pairs_out: Vec<PairScore> = sc
            .pairs
            .iter()
            .map(|pr| {
                let targets = TargetMap::from_fn(|tg| {
                    let ti = ratios::target_index(tg);
                    let unres = Reason::Unresolved;
                    PairTargetScore {
                        miss: Measured::with_se(pr.miss[ti], pr.sx),
                        closeness: pr.closeness[ti].map(Measured::ok).unwrap_or(Measured::null(unres)),
                        log_evidence: pr.log_ev[ti].map(Measured::ok).unwrap_or(Measured::null(unres)),
                        aligned: pr.aligned[ti],
                    }
                });
                PairScore { lo: scored[pr.lo].id, hi: scored[pr.hi].id, log_ratio: Measured::with_se(pr.x, pr.sx), harmonic: pr.harmonic, targets }
            })
            .collect();

        // Cascades.
        let mut casc: Vec<Cascade> = Vec::with_capacity(2);
        for (ci, target) in [CascadeTarget::Phi, CascadeTarget::Octave].into_iter().enumerate() {
            let cr = &sc.cascades[ci];
            let steps = cr.steps;
            // held_s: time since the cascade first had at least this many steps without a break.
            let hs = &mut self.held_since[ci];
            if hs.len() < steps + 1 {
                hs.resize(steps + 1, None);
            }
            for (k, slot) in hs.iter_mut().enumerate() {
                if k >= 1 && k <= steps {
                    if slot.is_none() {
                        *slot = Some(t);
                    }
                } else {
                    *slot = None;
                }
            }
            let held_s = if steps >= 1 { hs[steps].map(|s0| t - s0).unwrap_or(0.0) } else { 0.0 };
            let obs_c = cr.closeness.ok();
            let level_a = match &self.chance.a {
                Some(d) => d[ci].level(steps, obs_c),
                None => ChanceLevel::null(if scored.len() < 2 { Reason::NotConfirmed } else { Reason::WarmingUp }),
            };
            let level_b = match &self.chance.b {
                Some(d) => {
                    // A history of a few correlation times cannot support a small p-value.
                    let mut lv = d[ci].level(steps, obs_c);
                    let floor = self.chance.b_p_floor;
                    for pm in [&mut lv.p, &mut lv.p_steps] {
                        if let Some(v) = pm.v {
                            pm.v = Some(v.max(floor));
                        }
                    }
                    lv
                }
                None => ChanceLevel::null(if scored.len() < 2 { Reason::NotConfirmed } else { Reason::WarmingUp }),
            };
            // Excess alignment (spec 8.5): above zero only when the observed cascade beats all
            // but a fraction `excess_level` of the surrogates. Null where there is no observed
            // closeness or no chance distribution, and for chance B while its history cannot
            // support a percentile that small.
            let excess = |dist: Option<&ratios::NullDist>, lv: &ChanceLevel, p_floor: f64| -> Measured {
                match (obs_c, dist) {
                    (None, _) => Measured::null(cr.closeness.err().unwrap_or(Reason::NotAvailable)),
                    (Some(_), None) => Measured::null(lv.closeness.why),
                    (Some(_), Some(_)) if p_floor > p.excess_level => Measured::null(Reason::WarmingUp),
                    (Some(c), Some(d)) => match d.excess(steps, c, p.excess_level) {
                        Some((ex, _)) => Measured::ok(ex),
                        None => Measured::null(lv.closeness.why),
                    },
                }
            };
            let excess_a = excess(self.chance.a.as_ref().map(|d| &d[ci]), &level_a, 0.0);
            let excess_b = excess(self.chance.b.as_ref().map(|d| &d[ci]), &level_b, self.chance.b_p_floor);
            let closeness = match cr.closeness {
                Ok(c) => Measured::ok(c),
                Err(w) => Measured::null(w),
            };
            casc.push(Cascade {
                target,
                tracks: cr.members.iter().map(|&i| scored[i].id).collect(),
                steps: steps as u32,
                skipped: cr.skipped.iter().map(|&i| scored[i].id).collect(),
                closeness,
                held_s,
                excess_a,
                excess_b,
                chance: ChancePair { a: level_a, b: level_b },
            });
        }
        let oct = casc.pop().unwrap();
        let phi = casc.pop().unwrap();

        // States.
        let mut st: Vec<AlignedState> = Vec::with_capacity(2);
        for (ci, target) in [CascadeTarget::Phi, CascadeTarget::Octave].into_iter().enumerate() {
            let enter = match p.state_chance.as_str() {
                "b" => self.chance.thr_b[ci],
                "both" => match (self.chance.thr_a[ci], self.chance.thr_b[ci]) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (Some(a), None) => Some(a),
                    _ => None,
                },
                _ => self.chance.thr_a[ci],
            };
            // Review: the threshold is a quantile of the chance statistic, and when chance can
            // hardly reach the target at all (a theta and a beta track, say) that quantile is
            // far below zero. "Closer than chance" is then still nowhere near the target. The
            // state needs evidence for the target, not only less evidence against it.
            let enter = enter.map(|e| e.max(p.state_min_evidence));
            let exit = enter.map(|e| e - p.state_hysteresis);
            let stat = sc.stat[ci];
            self.states[ci].update_dwell(t, stat.ok(), enter, exit, p.dwell_s, p.exit_dwell_s, self.tracks.is_empty());
            let sm = &self.states[ci];
            st.push(AlignedState {
                target,
                active: sm.active,
                for_s: sm.since_t.map(|s| t - s).unwrap_or(0.0),
                stat: Measured::from_result(stat),
                enter_at: enter,
                exit_at: exit,
            });
        }
        let so = st.pop().unwrap();
        let sp = st.pop().unwrap();
        // The combined state: both at once. No statistic of its own.
        let both_now = sp.active && so.active;
        if self.both.1.is_none() || both_now != self.both.0 {
            self.both = (both_now, Some(t));
        }
        let both = BothState { active: both_now, for_s: self.both.1.map(|s0| t - s0).unwrap_or(0.0) };
        (pairs_out, PhiOctave { phi, octave: oct }, States { phi: sp, octave: so, both })
    }

    /// Compare side A (site `sa`, channels `ca`) with side B for every track present on both.
    #[allow(clippy::too_many_arguments)]
    fn compare_sites(&mut self, sa: usize, sb: usize, ca: &[usize], cb: &[usize], end: u64, p: &Params) -> Vec<SiteComparison> {
        let mut out = Vec::new();
        if ca.is_empty() || cb.is_empty() {
            return out;
        }
        let both: Vec<usize> = ca.iter().chain(cb.iter()).copied().collect();
        let run = self.joint_run(&both, end);
        let trim = m::round(0.5 * self.rate) as usize;
        let min_shift = m::round(p.compare_min_shift_s * self.rate) as usize;
        let sig = run.map(|(s, len)| (self.signal(ca, s, len), self.signal(cb, s, len)));
        let items: Vec<(u32, Peak, Peak, f64)> = self
            .tracks
            .iter()
            .filter_map(|tr| match (&tr.per_site[sa], &tr.per_site[sb]) {
                (Some(a), Some(b)) => Some((tr.id, a.clone(), b.clone(), tr.cur.as_ref().map(|c| c.f).unwrap_or(tr.last_f))),
                _ => None,
            })
            .collect();
        for (id, pa, pb, f) in items {
            let freq_diff = Measured::with_se(pa.f - pb.f, m::sqrt(pa.se * pa.se + pb.se * pb.se));
            let (balance, locking) = match &sig {
                Some((xa, xb)) => {
                    let sd = ((pa.width + pb.width) / 2.0 / 2.3548).max(0.3);
                    let za = self.analytic.band(xa, self.rate, f, sd);
                    let zb = self.analytic.band(xb, self.rate, f, sd);
                    let (aa, ab) = (compare::mean_amp(&za, trim), compare::mean_amp(&zb, trim));
                    let bal = if aa + ab > 0.0 { Measured::ok((aa - ab) / (aa + ab)) } else { Measured::null(Reason::Weak) };
                    let lk = match compare::locking(&za, &zb, 1, trim, p.compare_shifts, min_shift) {
                        Some((o, s)) => Measured::ok(compare::excess(o, s)),
                        None => Measured::null(Reason::InsufficientClean),
                    };
                    (bal, lk)
                }
                None => (Measured::null(Reason::InsufficientClean), Measured::null(Reason::InsufficientClean)),
            };
            let match_ = match (balance.v, locking.v) {
                (Some(b), Some(l)) => {
                    let tol = p.tolerance * f;
                    let fm = m::exp(-0.5 * ((pa.f - pb.f) / tol) * ((pa.f - pb.f) / tol));
                    let bm = 1.0 - b.abs();
                    Measured::ok(m::pow((fm * bm * l).max(0.0), 1.0 / 3.0))
                }
                _ => Measured::null(if balance.v.is_none() { balance.why } else { locking.why }),
            };
            out.push(SiteComparison { track: id, freq_diff, balance, locking_excess: locking, match_ });
        }
        out
    }

    fn sync_trackers(&mut self, p: &Params) {
        let fp = FastParams {
            rate: self.rate,
            block: self.fast_block,
            delay_limit_s: p.fast_delay_limit_s,
            lost_lock_s: p.lost_lock_s,
            relock_s: p.fast_relock_s,
            lock_se: p.fast_lock_se,
            amp_floor: p.fast_amp_floor,
        };
        let ids: BTreeSet<u32> = self.tracks.iter().map(|t| t.id).collect();
        self.trackers.retain(|id, _| ids.contains(id));
        for tr in &self.tracks {
            let centre = tr.cur.as_ref().map(|c| c.f).unwrap_or(tr.last_f);
            let site = tr.site;
            let bg = self.site_bg[site].map(|b| b.at(centre)).unwrap_or(0.0);
            let w = m::TAU * centre / self.rate;
            let c0 = self.sites[site].members[0];
            let ch = &self.chans[c0];
            let mut gd = ch.hp.group_delay_samples(w);
            if let Some(n) = &ch.notch {
                gd += n.group_delay_samples(w);
            }
            let target = TrackTarget { centre_hz: centre, se_hz: tr.last_se, width_hz: tr.last_width, bg_psd: bg, cond_delay_s: gd / self.rate };
            match self.trackers.get_mut(&tr.id) {
                Some((s, t)) => {
                    *s = site;
                    t.retune(&target);
                }
                None => {
                    self.trackers.insert(tr.id, (site, Box::new(DemodTracker::new(fp, &target))));
                }
            }
        }
    }

    fn site_output(&self, s: usize, a: &Result<SiteAnalysis, Reason>, edges: &BandMap<[f64; 2]>, p: &Params) -> SiteSpectrum {
        let name = self.sites[s].name.clone();
        let df_out = p.spectrum_out_df_hz;
        let fixed = Self::fixed_band_edges();
        match a {
            Err(w) => SiteSpectrum {
                site: name,
                why: *w,
                f0: p.spectrum_out_lo_hz,
                df: df_out,
                psd: Vec::new(),
                flat: Vec::new(),
                bg_exponent: Measured::null(*w),
                bg_offset: Measured::null(*w),
                k: 0,
                bands: spectral::null_bands(*w),
                bands_fixed: spectral::null_bands(*w),
            },
            Ok(an) => {
                let df = self.mt.df;
                let nout = (m::floor((p.spectrum_out_hi_hz - p.spectrum_out_lo_hz) / df_out + 1e-9) as usize) + 1;
                let bins: Vec<usize> = (0..nout)
                    .map(|i| (m::round((p.spectrum_out_lo_hz + i as f64 * df_out) / df) as usize).min(an.spec.s.len() - 1))
                    .collect();
                match an.bg_fit {
                    Ok(fit) => SiteSpectrum {
                        site: name,
                        why: Reason::Ok,
                        f0: p.spectrum_out_lo_hz,
                        df: df_out,
                        psd: bins.iter().map(|&b| an.spec.s[b] as f32).collect(),
                        flat: bins.iter().map(|&b| an.flat[b] as f32).collect(),
                        bg_exponent: Measured::with_se(fit.exponent, fit.exponent_se),
                        bg_offset: Measured::with_se(fit.offset, fit.offset_se),
                        k: an.spec.k as u32,
                        bands: BandMap::from_fn(|b| {
                            let [lo, hi] = *edges.get(b);
                            spectral::band_summary(&an.spec, &an.bg, df, lo, hi)
                        }),
                        bands_fixed: BandMap::from_fn(|b| {
                            let [lo, hi] = *fixed.get(b);
                            spectral::band_summary(&an.spec, &an.bg, df, lo, hi)
                        }),
                    },
                    Err(w) => SiteSpectrum {
                        site: name,
                        why: w,
                        f0: p.spectrum_out_lo_hz,
                        df: df_out,
                        psd: Vec::new(),
                        flat: Vec::new(),
                        bg_exponent: Measured::null(w),
                        bg_offset: Measured::null(w),
                        k: an.spec.k as u32,
                        bands: BandMap::from_fn(|b| {
                            let [lo, hi] = *edges.get(b);
                            let mut bs = spectral::band_summary(&an.spec, &an.spec.s, df, lo, hi);
                            bs.above_bg_db = Measured::null(w);
                            bs
                        }),
                        bands_fixed: BandMap::from_fn(|b| {
                            let [lo, hi] = *fixed.get(b);
                            let mut bs = spectral::band_summary(&an.spec, &an.spec.s, df, lo, hi);
                            bs.above_bg_db = Measured::null(w);
                            bs
                        }),
                    },
                }
            }
        }
    }

    fn track_output(&self, tr: &TrackInt, t: f64, p: &Params) -> Track {
        let nc = Reason::NotConfirmed;
        let state = match &tr.cur {
            None => TrackState::Fading,
            Some(_) if t - tr.born_t < p.track_new_s => TrackState::New,
            Some(_) => TrackState::Confirmed,
        };
        let harmonic_of = self
            .harmonics
            .iter()
            .filter(|((_, hi), h)| *hi == tr.id && h.marked)
            .min_by_key(|((lo, _), h)| (h.n, *lo))
            .map(|((lo, _), h)| HarmonicOf { id: *lo, n: h.n });
        let fref = tr.cur.as_ref().map(|c| c.f).or(tr.f_int.map(|v| v.0)).unwrap_or(tr.last_f);
        Track {
            id: tr.id,
            state,
            site: self.sites[tr.site].name.clone(),
            freq: tr.cur.as_ref().map(|c| Measured::with_se(c.f, c.se)).unwrap_or(Measured::null(nc)),
            freq_integrated: tr.f_int.map(|(f, se)| Measured::with_se(f, se)).unwrap_or(Measured::null(nc)),
            height_db: tr.cur.as_ref().map(|c| Measured::opt_se(c.h_db(), c.h_db_se)).unwrap_or(Measured::null(nc)),
            width_hz: tr.cur.as_ref().map(|c| Measured::ok(c.width)).unwrap_or(Measured::null(nc)),
            age_s: t - tr.born_t,
            band: self.band_of(fref),
            harmonic_of,
        }
    }
}
