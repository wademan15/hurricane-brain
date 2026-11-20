//! The provisional parameters (spec section 14), in one place.
//!
//! Every number that the bake-off may move lives here and nowhere else (CLAUDE.md rule 9).
//! The first block is the spec's table. The second block holds implementation parameters
//! that the spec does not yet list; each is recorded in NOTES.md for the signal architect.
//! Overrides arrive by name in `EngineConfig.params` and the full set is echoed by
//! `Engine::params()` and recorded with the session.

use crate::types::ParamValue;
use std::collections::BTreeMap;

pub trait ParamType: Sized {
    fn from_value(v: &ParamValue) -> Option<Self>;
    fn to_value(&self) -> ParamValue;
    const TYPE_NAME: &'static str;
}

impl ParamType for f64 {
    fn from_value(v: &ParamValue) -> Option<Self> {
        match v {
            ParamValue::Num(x) if x.is_finite() => Some(*x),
            _ => None,
        }
    }
    fn to_value(&self) -> ParamValue {
        ParamValue::Num(*self)
    }
    const TYPE_NAME: &'static str = "number";
}

impl ParamType for usize {
    fn from_value(v: &ParamValue) -> Option<Self> {
        match v {
            ParamValue::Num(x) if *x >= 0.0 && x.fract() == 0.0 && *x < 1e12 => Some(*x as usize),
            _ => None,
        }
    }
    fn to_value(&self) -> ParamValue {
        ParamValue::Num(*self as f64)
    }
    const TYPE_NAME: &'static str = "non-negative integer";
}

impl ParamType for bool {
    fn from_value(v: &ParamValue) -> Option<Self> {
        match v {
            ParamValue::Bool(b) => Some(*b),
            _ => None,
        }
    }
    fn to_value(&self) -> ParamValue {
        ParamValue::Bool(*self)
    }
    const TYPE_NAME: &'static str = "boolean";
}

impl ParamType for String {
    fn from_value(v: &ParamValue) -> Option<Self> {
        match v {
            ParamValue::Str(s) => Some(s.clone()),
            _ => None,
        }
    }
    fn to_value(&self) -> ParamValue {
        ParamValue::Str(self.clone())
    }
    const TYPE_NAME: &'static str = "string";
}

macro_rules! params {
    ($( $(#[$doc:meta])* $name:ident : $ty:ty = $default:expr ),* $(,)?) => {
        /// All provisional parameters. Field names are the override names.
        #[derive(Clone, Debug, PartialEq)]
        pub struct Params { $( $(#[$doc])* pub $name: $ty, )* }

        impl Default for Params {
            fn default() -> Self { Params { $( $name: $default, )* } }
        }

        impl Params {
            /// Set one parameter by name.
            pub fn set(&mut self, name: &str, v: &ParamValue) -> Result<(), String> {
                match name {
                    $( stringify!($name) => {
                        self.$name = <$ty as ParamType>::from_value(v).ok_or_else(|| {
                            format!("parameter {} expects a {}", name, <$ty as ParamType>::TYPE_NAME)
                        })?;
                        Ok(())
                    } )*
                    _ => Err(format!("unknown parameter {name}")),
                }
            }

            /// Every parameter by name, sorted.
            pub fn to_map(&self) -> BTreeMap<String, ParamValue> {
                let mut m = BTreeMap::new();
                $( m.insert(stringify!($name).to_string(), ParamType::to_value(&self.$name)); )*
                m
            }

            pub fn names() -> &'static [&'static str] {
                &[ $( stringify!($name), )* ]
            }
        }
    };
}

params! {
    // ---- Spec section 14 ----------------------------------------------------------
    /// Longest gap repaired by linear interpolation, samples (spec 3).
    gap_repair_max_samples: usize = 12,
    /// Repaired samples allowed in an analysed window, fraction (spec 3).
    repaired_max_fraction: f64 = 0.02,
    /// High-pass corner, Hz (spec 5.1).
    highpass_hz: f64 = 0.5,
    /// Mains exclusion half-width around the line and its harmonics, Hz (spec 5.1).
    mains_exclusion_hz: f64 = 2.0,
    /// Seconds a failed channel must pass in a row before it is used again (spec 5.2).
    channel_recovery_s: f64 = 3.0,
    /// Padding on each side of a flagged stretch, s (spec 5.3).
    artifact_pad_s: f64 = 0.25,
    /// Minimum clean fraction of the slow window (spec 5.3).
    min_clean_fraction: f64 = 0.6,
    /// Minimum longest clean stretch, s (spec 5.3).
    min_clean_stretch_s: f64 = 2.0,
    /// Slow window length, s; 8 or 4 (spec 6.1).
    slow_window_s: f64 = 8.0,
    /// Slow update interval, s (spec 6).
    slow_update_s: f64 = 0.25,
    /// Peak search range, Hz (spec 6.1).
    peak_search_lo_hz: f64 = 1.0,
    peak_search_hi_hz: f64 = 45.0,
    /// Background fit range, Hz (spec 6.2).
    bg_fit_lo_hz: f64 = 2.0,
    bg_fit_hi_hz: f64 = 45.0,
    /// False peaks allowed per window, all sites together (spec 6.3).
    alpha_peak: f64 = 0.01,
    /// Widest accepted peak, full width at half height, Hz (spec 6.3).
    peak_width_max_hz: f64 = 6.0,
    /// Persistence: a peak must pass in this many of the last `persistence_of` non-overlapping windows (spec 6.3).
    persistence_need: usize = 2,
    persistence_of: usize = 3,
    /// Hold after a peak stops passing, s (spec 6.3).
    peak_hold_s: f64 = 2.0,
    /// Integration time for the integrated frequency, s (spec 6.4).
    integration_s: f64 = 30.0,
    /// Track joining distance: this many standard errors or `track_join_hz`, whichever is larger (spec 6.5).
    track_join_se: f64 = 3.0,
    track_join_hz: f64 = 1.0,
    /// Fast frames per second (spec 7). Must divide the EEG rate.
    fast_per_s: f64 = 32.0,
    /// Fast path delay limit, s (spec 7).
    fast_delay_limit_s: f64 = 0.3,
    /// Lost lock time, s (spec 7).
    lost_lock_s: f64 = 1.0,
    /// Resolved limit on s_x, natural-log units (spec 8.2).
    resolved_max_sx: f64 = 0.03,
    /// Alignment tolerance epsilon, natural-log units (spec 8.2).
    tolerance: f64 = 0.03,
    /// Intrinsic tolerance tau of the evidence ratio (spec 8.4).
    tau: f64 = 0.01,
    /// Control ratios (spec 8.1). Reported as control_1_5 and control_1_8.
    control_ratio_a: f64 = 1.5,
    control_ratio_b: f64 = 1.8,
    /// Dwell before entering an aligned state, s (spec 8.4).
    dwell_s: f64 = 5.0,
    /// One false entry allowed per this many seconds (spec 8.4: 1 per 10 minutes).
    false_entry_interval_s: f64 = 600.0,
    /// Surrogates per chance estimate (spec 8.5).
    surrogates: usize = 200,
    /// Minimum lag for chance B, s (spec 8.5).
    chance_b_min_lag_s: f64 = 10.0,
    /// Track history needed for chance B, s (spec 8.5).
    chance_b_history_s: f64 = 120.0,
    /// Chance refresh interval, s (spec 8.5).
    chance_refresh_s: f64 = 5.0,
    /// Slow update time budget, ms (spec 11). Informational; the engine reads no clock.
    slow_budget_ms: f64 = 50.0,
    /// Exclude harmonic pairs from octave alignment and cascades (spec 6.6, D3).
    exclude_harmonics: bool = true,

    // ---- Implementation parameters not yet in the spec table (see NOTES.md) ------------
    /// Multitaper half-bandwidth W, Hz (spec 6.1 example: 0.5 Hz gives K=7 at 8 s).
    mt_half_bandwidth_hz: f64 = 0.5,
    /// Spectral grid spacing used internally, Hz (zero-padded FFT).
    spectrum_grid_hz: f64 = 0.0625,
    /// Output spectrum grid, Hz, and its range.
    spectrum_out_df_hz: f64 = 0.25,
    spectrum_out_lo_hz: f64 = 1.0,
    spectrum_out_hi_hz: f64 = 60.0,
    /// Effective independent tries per Rayleigh bin (1/T Hz, T the window length) searched,
    /// for the height test's multiple-comparison correction. Verified by simulation on
    /// background-only noise (see NOTES.md); 1 means one try per 1/T.
    peak_tries_per_rayleigh: f64 = 1.0,
    /// Narrowest accepted peak as a fraction of the estimator resolution 2W (a pure sine reads about 2W).
    peak_width_min_factor: f64 = 0.8,
    /// Background fit: drop bins above the line by more than this many expected log-SDs.
    bg_drop_sigma: f64 = 2.0,
    /// Background fit fails if inlier RMS residual exceeds this multiple of the expected log-SD.
    bg_fit_max_ratio: f64 = 3.0,
    /// Background curve: number of polynomial coefficients in log power against log frequency
    /// (2 = a plain power law, 3 = a quadratic, 4 = a cubic). Spec 6.2.
    bg_curve_terms: usize = 3,
    /// Background fit fails if the lack-of-fit statistic (block-averaged residual over its
    /// noise level) exceeds this. Spec 6.2.
    bg_lack_of_fit_max: f64 = 1.25,
    /// Width of the blocks the lack-of-fit statistic averages over, Hz.
    bg_lof_block_hz: f64 = 2.0,
    /// Floor on a window's centre-frequency standard error, Hz.
    freq_se_floor_hz: f64 = 0.005,
    /// Integrated frequency: weight, in degrees of freedom, of the windows' own jackknife errors
    /// when pooled with the scatter of the window estimates (spec 6.4).
    integration_prior_dof: f64 = 0.5,
    /// Integrated frequency: factor on the jackknife error while the estimates span less than
    /// two slow windows and there is no scatter to pool (spec 6.4).
    integration_young_se_factor: f64 = 2.0,
    /// Seconds a track is reported as `new`.
    track_new_s: f64 = 1.0,
    /// Track history kept for chance B, s (memory cap, spec 11).
    track_history_s: f64 = 600.0,
    /// Notch quality factor.
    notch_q: f64 = 30.0,
    /// Mains detection: seconds of data per check, and line-over-neighbourhood ratio needed, dB.
    mains_detect_s: f64 = 4.0,
    mains_detect_db: f64 = 10.0,
    /// Signal quality: plausible SD range, uV (spec 5.2 values), mains limit, rail level and railed fraction.
    quality_sd_min_uv: f64 = 1.0,
    quality_sd_max_uv: f64 = 100.0,
    quality_mains_max_uv: f64 = 50.0,
    quality_rail_uv: f64 = 980.0,
    quality_railed_max: f64 = 0.1,
    /// Samples in a run of identical raw values that count as railed/flat.
    quality_flat_run: usize = 8,
    /// Seconds of valid data used to set the gating reference levels; afterwards they only tighten.
    gate_reference_s: f64 = 60.0,
    /// Seconds of data needed before the gating detectors run (earlier samples are gated as warm-up).
    gate_warmup_s: f64 = 2.0,
    /// Step detector: low-pass corner, Hz, lag, s, and threshold in multiples of the reference median |step|.
    step_lowpass_hz: f64 = 4.0,
    step_lag_s: f64 = 0.2,
    step_k: f64 = 10.0,
    /// A step on one channel counts as unpartnered if no other channel exceeds this fraction of its threshold.
    step_partner_fraction: f64 = 0.5,
    /// Muscle: 30-45 Hz power over the reference median, dB.
    muscle_db: f64 = 6.0,
    /// Motion: gyroscope floor, deg/s, multiple of resting level, and accelerometer deviation, g.
    motion_gyro_min_dps: f64 = 10.0,
    motion_gyro_k: f64 = 3.0,
    motion_acc_g: f64 = 0.05,
    /// Settling time gated after a long gap or a filter change, s.
    gap_settle_s: f64 = 0.5,
    /// Fast path: amplitude floor as a multiple of the background's RMS amplitude in the tracker band.
    /// Background alone has a Rayleigh envelope and exceeds k RMS with probability exp(-k^2):
    /// 37 % at 1.0, 5 % at 1.73.
    fast_amp_floor: f64 = 1.73,
    /// Fast path: seconds of agreement before lock is regained.
    fast_relock_s: f64 = 0.25,
    /// Fast path: disagreement limit with the slow path, standard errors (spec 7: 3).
    fast_lock_se: f64 = 3.0,
    /// Harmonics: largest integer multiple tested, phase locking needed, and its excess over a time-shifted surrogate.
    harmonic_max_n: usize = 3,
    harmonic_plv_min: f64 = 0.7,
    harmonic_plv_excess: f64 = 0.3,
    /// Harmonics: the mean locking vector over the last integration time marks a pair when
    /// unlocked rhythms would reach its length with at most probability `harmonic_alpha`, and
    /// the mark is taken off when that probability is above `harmonic_release_p` (spec 6.6).
    harmonic_alpha: f64 = 0.01,
    harmonic_release_p: f64 = 0.2,
    /// Phase comparisons: number of time-shifted surrogates and their minimum shift, s.
    compare_shifts: usize = 8,
    compare_min_shift_s: f64 = 1.0,
    /// Confidence that a surrogate-derived aligned-state threshold is not below the true one
    /// (Monte Carlo error must never make alignment easier).
    threshold_confidence: f64 = 0.9,
    /// Aligned state: exit threshold = entry threshold minus this, in log-evidence units.
    state_hysteresis: f64 = 1.0,
    /// Which chance level sets the aligned-state threshold: "a", "b", or "both" (the stricter). Open decision D1.
    state_chance: String = "a".to_string(),
    /// Weight of the unrelated-peaks density mixed into a pair's baseline density q (keeps q from vanishing).
    baseline_mix: f64 = 0.1,
    /// Span of the chance-B time series used for the false-alarm threshold, s.
    chance_b_span_s: f64 = 120.0,
    /// Lowest entry threshold of an aligned state, nats of log evidence: the state needs
    /// evidence for the target whatever the chance threshold says (spec 8.4).
    state_min_evidence: f64 = 1.0,
    /// Excess alignment is zero unless the observed cascade beats all but this fraction of
    /// the surrogates (spec 8.5).
    excess_level: f64 = 0.05,
}

impl Params {
    /// Build from defaults plus overrides. Unknown names and type errors are reported.
    pub fn from_overrides(over: Option<&BTreeMap<String, ParamValue>>) -> Result<Params, String> {
        let mut p = Params::default();
        if let Some(o) = over {
            for (k, v) in o {
                p.set(k, v)?;
            }
        }
        p.validate()?;
        Ok(p)
    }

    pub fn validate(&self) -> Result<(), String> {
        let pos = [
            ("slow_window_s", self.slow_window_s),
            ("slow_update_s", self.slow_update_s),
            ("mt_half_bandwidth_hz", self.mt_half_bandwidth_hz),
            ("spectrum_grid_hz", self.spectrum_grid_hz),
            ("spectrum_out_df_hz", self.spectrum_out_df_hz),
            ("integration_s", self.integration_s),
            ("tolerance", self.tolerance),
            ("fast_per_s", self.fast_per_s),
            ("alpha_peak", self.alpha_peak),
            ("false_entry_interval_s", self.false_entry_interval_s),
        ];
        for (n, v) in pos {
            if !(v > 0.0) {
                return Err(format!("parameter {n} must be positive"));
            }
        }
        if self.alpha_peak >= 1.0 {
            return Err("alpha_peak must be below 1".into());
        }
        if self.persistence_need == 0 || self.persistence_need > self.persistence_of {
            return Err("persistence_need must be between 1 and persistence_of".into());
        }
        if !matches!(self.state_chance.as_str(), "a" | "b" | "both") {
            return Err("state_chance must be \"a\", \"b\" or \"both\"".into());
        }
        if self.surrogates < 20 {
            return Err("surrogates must be at least 20".into());
        }
        Ok(())
    }
}
