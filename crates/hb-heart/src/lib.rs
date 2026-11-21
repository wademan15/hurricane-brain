//! Hurricane Brain heart and breath engine (spec section 13).
//!
//! Pure library: no I/O, no clocks, no threads. Deterministic: the same inputs in the same order
//! give byte-identical frames, on native and wasm32 (all transcendental functions come from `libm`;
//! random numbers only for surrogates, from the configured seed).
//!
//! Inputs: chest strap intervals (`push_rr`), headset optical pulse (`push_ppg`), slow brain series
//! for coupling (`push_brain`), the breath pacer (`set_pacer`), the baseline window
//! (`mark_baseline`) and the pulse-artifact flag (`set_suspect_artifact`).
//! Output: `HeartFrame`s from `drain()`: one whenever beats are detected, and at least once a
//! second (`frame_max_interval_s`) once any input has arrived.

pub mod beats;
pub mod coupling;
pub mod dsp;
pub mod hrv;
pub mod params;
pub mod ppg;
pub mod state;
pub mod types;

pub use params::{HeartParams, ParamValue};
pub use types::{Beat, Coupling, HeartFrame, HeartKind, HeartSource, HighHrv, Measured, Reason, SCHEMA_VERSION};

use beats::{BeatSeries, RrClock};
use hrv::{SeriesKind, TimeDomain};
use ppg::PpgDetector;
use state::HighState;
use std::collections::BTreeMap;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Engine configuration.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HeartConfig {
    /// Seed for surrogates. Stored with the session.
    pub seed: u64,
    pub params: HeartParams,
}

impl HeartConfig {
    /// Defaults with overrides by name (unknown names are an error).
    pub fn with_overrides(seed: u64, overrides: &BTreeMap<String, ParamValue>) -> Result<Self, String> {
        Ok(HeartConfig { seed, params: HeartParams::with_overrides(overrides)? })
    }
}

#[derive(Debug, Clone, Default)]
struct BrainSeries {
    /// Grid index (round(t * resample_hz)) -> value; None is a null from the EEG engine.
    vals: BTreeMap<i64, Option<f64>>,
    suspect_artifact: bool,
}

pub struct HeartEngine {
    p: HeartParams,
    seed: u64,
    start_t: Option<f64>,
    now: f64,
    last_frame_t: Option<f64>,

    rr_clock: RrClock,
    strap: BeatSeries,
    ppg: PpgDetector,
    ppg_beats: BeatSeries,
    ppg_last_pulse: Option<f64>,

    emitted_strap: u64,
    emitted_ppg: u64,

    brain: BTreeMap<String, BrainSeries>,
    pacer: Option<(f64, f64)>,
    high: HighState,

    coupling: Vec<types::Coupling>,
    coupling_slot: Option<i64>,

    out: Vec<HeartFrame>,
}

impl HeartEngine {
    pub fn new(config: HeartConfig) -> Self {
        HeartEngine {
            p: config.params,
            seed: config.seed,
            start_t: None,
            now: f64::NEG_INFINITY,
            last_frame_t: None,
            rr_clock: RrClock::default(),
            strap: BeatSeries::default(),
            ppg: PpgDetector::new(),
            ppg_beats: BeatSeries::default(),
            ppg_last_pulse: None,
            emitted_strap: 0,
            emitted_ppg: 0,
            brain: BTreeMap::new(),
            pacer: None,
            high: HighState::default(),
            coupling: Vec::new(),
            coupling_slot: None,
            out: Vec::new(),
        }
    }

    pub fn version(&self) -> &'static str {
        VERSION
    }

    /// The parameter set in force, by name.
    pub fn params(&self) -> BTreeMap<String, ParamValue> {
        self.p.to_map()
    }

    pub fn param_struct(&self) -> &HeartParams {
        &self.p
    }

    /// Number of times the strap clock re-anchored after lost intervals.
    pub fn strap_lost_events(&self) -> u64 {
        self.rr_clock.lost_events
    }

    /// PPG channel currently used for pulse detection (None when no channel passes quality).
    pub fn ppg_active_channel(&self) -> Option<usize> {
        self.ppg.active_channel()
    }

    /// Latest quality per PPG channel (None before the first analysis or on a dropout).
    pub fn ppg_quality(&self) -> &[Option<f64>] {
        &self.ppg.quality
    }

    // -----------------------------------------------------------------------
    // Inputs
    // -----------------------------------------------------------------------

    /// Chest strap beat-to-beat intervals, ms; `t` is the session time the notification arrived.
    /// A notification may carry zero, one or several intervals.
    pub fn push_rr(&mut self, t: f64, rr_ms: &[f32]) {
        if !t.is_finite() {
            return;
        }
        self.advance(t, true);
        let placed = self.rr_clock.push(&self.p, t, rr_ms);
        for (tb, rr, contiguous) in placed.iter().copied() {
            self.strap.push(&self.p, tb, rr, contiguous);
        }
        if !placed.is_empty() {
            self.emit(self.now);
        }
    }

    /// Headset optical pulse at `ppg_rate_hz`, interleaved by channel; `t_first` is the session
    /// time of the first sample.
    pub fn push_ppg(&mut self, t_first: f64, interleaved: &[f32], n_channels: usize) {
        if !t_first.is_finite() || n_channels == 0 {
            return;
        }
        let n = interleaved.len() / n_channels;
        if n == 0 {
            return;
        }
        let t_last = t_first + (n - 1) as f64 / self.p.ppg_rate_hz;
        self.advance(t_last, false);
        let pulses = self.ppg.push(&self.p, t_first, interleaved, n_channels);
        let before = self.ppg_beats.total;
        for pl in pulses {
            if let Some(prev) = self.ppg_last_pulse {
                let ibi = (pl.t - prev) * 1000.0;
                self.ppg_beats.push(&self.p, pl.t, ibi, pl.contiguous);
            }
            self.ppg_last_pulse = Some(pl.t);
        }
        if self.ppg_beats.total > before && self.source_at(self.now) == HeartSource::HeadsetPpg {
            self.emit(self.now);
        }
    }

    /// One sample of a slow brain series (about 4 Hz), e.g. "alpha.above_bg_db@temporal".
    /// `None` means the EEG engine reported null at that time.
    pub fn push_brain(&mut self, t: f64, name: &str, value: Option<f64>) {
        if !t.is_finite() {
            return;
        }
        self.advance(t, false);
        let g = (t * self.p.resample_hz).round() as i64;
        let s = self.brain.entry(name.to_string()).or_default();
        s.vals.insert(g, value.filter(|v| v.is_finite()));
        let keep_from = g - ((self.p.coupling_window_s + 60.0) * self.p.resample_hz) as i64;
        while let Some((&k, _)) = s.vals.iter().next() {
            if k >= keep_from {
                break;
            }
            s.vals.remove(&k);
        }
    }

    /// Mark a brain series as suspected pulse artifact (spec 13). Its coupling is then null with
    /// reason `artifact` and `suspect_artifact: true`.
    pub fn set_suspect_artifact(&mut self, name: &str, suspect: bool) {
        self.brain.entry(name.to_string()).or_default().suspect_artifact = suspect;
    }

    /// Breath pacer rate in breaths per minute, or None when off. The pacer is a guide, not a
    /// measurement; adherence restarts its window whenever the rate changes.
    pub fn set_pacer(&mut self, bpm: Option<f64>) {
        let bpm = bpm.filter(|b| b.is_finite() && *b > 0.0);
        match (self.pacer, bpm) {
            (Some((old, _)), Some(new)) if old == new => {}
            (_, Some(new)) => self.pacer = Some((new, self.now.max(self.start_t.unwrap_or(0.0)))),
            (_, None) => self.pacer = None,
        }
    }

    /// Set the baseline window for the high variability state. May be called before, during or
    /// after the window; thresholds are fixed once frame time passes t1.
    pub fn mark_baseline(&mut self, t0: f64, t1: f64) {
        self.high.mark_baseline(t0, t1);
    }

    pub fn clear_baseline(&mut self) {
        self.high.clear_baseline();
    }

    /// All frames produced since the last call, in time order.
    pub fn drain(&mut self) -> Vec<HeartFrame> {
        std::mem::take(&mut self.out)
    }

    // -----------------------------------------------------------------------
    // Clock and frames
    // -----------------------------------------------------------------------

    fn advance(&mut self, t: f64, beat_frame_follows: bool) {
        if self.start_t.is_none() {
            self.start_t = Some(t);
            self.now = t;
            if !beat_frame_follows {
                self.emit(t);
            }
            return;
        }
        let step = self.p.frame_max_interval_s;
        if let Some(mut last) = self.last_frame_t {
            loop {
                let next = last + step;
                let due = if beat_frame_follows { next < t } else { next <= t };
                if !due {
                    break;
                }
                self.now = self.now.max(next);
                self.emit(next);
                last = next;
            }
        }
        self.now = self.now.max(t);
    }

    fn source_at(&self, t: f64) -> HeartSource {
        if self.strap.last_t().is_some_and(|lt| t - lt <= self.p.strap_fresh_s) {
            HeartSource::ChestStrap
        } else if self.ppg_beats.last_t().is_some_and(|lt| t - lt <= self.p.ppg_fresh_s) {
            HeartSource::HeadsetPpg
        } else {
            HeartSource::None
        }
    }

    fn emit(&mut self, t: f64) {
        let f = self.compute_frame(t);
        self.last_frame_t = Some(t);
        self.out.push(f);
    }

    fn compute_frame(&mut self, t: f64) -> HeartFrame {
        let p = self.p.clone();
        let source = self.source_at(t);
        let keep = p.coupling_window_s.max(p.spec_window_s).max(p.hrv_window_s) + 60.0;
        self.strap.prune(t - keep);
        self.ppg_beats.prune(t - keep);

        let series = match source {
            HeartSource::ChestStrap => Some(&self.strap),
            HeartSource::HeadsetPpg => Some(&self.ppg_beats),
            HeartSource::None => None,
        };

        let beats: Vec<Beat> = match source {
            HeartSource::ChestStrap => self.strap.since(self.emitted_strap),
            HeartSource::HeadsetPpg => self.ppg_beats.since(self.emitted_ppg),
            HeartSource::None => &[],
        }
        .iter()
        .map(|b| Beat { t: b.t, ibi_ms: b.ibi_ms, flagged: b.flagged })
        .collect();
        self.emitted_strap = self.strap.total;
        self.emitted_ppg = self.ppg_beats.total;

        let (hr, td, fd, pacer) = match series {
            None => {
                let m = Measured::null(Reason::NoData);
                (m, TimeDomain { rmssd: m, sdnn: m, corrected_fraction: 0.0 }, hrv::FreqDomain::null(Reason::NoData), {
                    if self.pacer.is_some() {
                        m
                    } else {
                        Measured::null(Reason::NotAvailable)
                    }
                })
            }
            Some(s) => {
                let hr = hrv::heart_rate(s.window(t - p.hr_window_s, t));
                let td = hrv::time_domain(&p, s.first_t, t, s.window(t - p.hrv_window_s, t));
                let fd = hrv::freq_domain(&p, &s.beats, s.first_t, t);
                let pa = hrv::pacer_adherence(&p, &s.beats, s.first_t, t, self.pacer);
                (hr, td, fd, pa)
            }
        };

        let measure = match p.high_hrv_measure.as_str() {
            "sdnn" => td.sdnn,
            "lf_power" => fd.lf,
            "hf_power" => fd.hf,
            "resonance_strength" => fd.resonance_strength,
            _ => td.rmssd,
        };
        let high_hrv = self.high.update(&p, t, measure);

        // Coupling, recomputed every coupling_update_s.
        let slot = (t / p.coupling_update_s).floor() as i64;
        if self.coupling_slot != Some(slot) {
            self.coupling_slot = Some(slot);
            self.coupling = self.compute_coupling(t, source);
        }

        HeartFrame {
            kind: HeartKind::Heart,
            schema: SCHEMA_VERSION,
            t,
            source,
            beats,
            hr_bpm: hr,
            rmssd_ms: td.rmssd,
            sdnn_ms: td.sdnn,
            lf_power: fd.lf,
            hf_power: fd.hf,
            resonance_hz: fd.resonance_hz,
            resonance_strength: fd.resonance_strength,
            breath_bpm: fd.breath_bpm,
            breath_phase: fd.breath_phase,
            pacer_adherence: pacer,
            corrected_fraction: td.corrected_fraction,
            high_hrv,
            coupling: self.coupling.clone(),
        }
    }

    fn compute_coupling(&self, t: f64, source: HeartSource) -> Vec<types::Coupling> {
        let p = &self.p;
        let fs = p.resample_hz;
        let n = (p.coupling_window_s * fs).round() as i64;
        let g_end = (t * fs).floor() as i64;
        let g0 = g_end - n + 1;
        let series = match source {
            HeartSource::ChestStrap => Some(&self.strap),
            HeartSource::HeadsetPpg => Some(&self.ppg_beats),
            HeartSource::None => None,
        };
        let (hr, hr_ok) = match series {
            Some(s) => {
                let in_win = s.window((g0 as f64 - 1.0) / fs - p.clean_max_rr_ms / 1000.0, t);
                let r = hrv::resample(in_win, SeriesKind::HeartRateBpm, fs, g0, g_end, p.resample_cubic != 0.0);
                let ok: Vec<bool> = (0..r.v.len()).map(|i| r.valid[i] && !r.bridged[i]).collect();
                (r.v, ok)
            }
            None => (vec![0.0; n as usize], vec![false; n as usize]),
        };
        let warming = t - self.start_t.unwrap_or(t) < p.coupling_window_s;
        let mut out = Vec::new();
        for (name, bs) in &self.brain {
            let mut br = vec![0.0; n as usize];
            let mut br_ok = vec![false; n as usize];
            for (&g, v) in bs.vals.range(g0..=g_end) {
                if let Some(v) = v {
                    br[(g - g0) as usize] = *v;
                    br_ok[(g - g0) as usize] = true;
                }
            }
            out.extend(coupling::couple(p, self.seed, name, g_end, fs, &hr, &hr_ok, &br, &br_ok, bs.suspect_artifact, warming));
        }
        out
    }
}
