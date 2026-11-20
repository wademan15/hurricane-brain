//! Every tunable number of the heart engine, in one place (spec section 14 rule).
//! Defaults are provisional. Each can be overridden by name.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A parameter value as it arrives from `EngineConfig.params`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParamValue {
    Bool(bool),
    Num(f64),
    Str(String),
}

macro_rules! heart_params {
    ( $( $(#[$doc:meta])* $name:ident : $default:expr ),* $(,)? ) => {
        /// All tunable numbers, with provisional defaults.
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        pub struct HeartParams {
            $( $(#[$doc])* pub $name: f64, )*
            /// Which variability measure the high variability state uses:
            /// "rmssd" (default), "sdnn", "lf_power", "hf_power" or "resonance_strength".
            pub high_hrv_measure: String,
        }

        impl Default for HeartParams {
            fn default() -> Self {
                HeartParams { $( $name: $default, )* high_hrv_measure: "rmssd".to_string() }
            }
        }

        impl HeartParams {
            /// Override one parameter by name. Names are the field names, optionally prefixed
            /// with `heart.` so they can share a namespace with the EEG engine's parameters.
            pub fn set(&mut self, name: &str, value: &ParamValue) -> Result<(), String> {
                let key = name.strip_prefix("heart.").unwrap_or(name);
                if key == "high_hrv_measure" {
                    return match value {
                        ParamValue::Str(s) if HIGH_HRV_MEASURES.contains(&s.as_str()) => {
                            self.high_hrv_measure = s.clone();
                            Ok(())
                        }
                        _ => Err(format!("high_hrv_measure must be one of {:?}", HIGH_HRV_MEASURES)),
                    };
                }
                let num = match value {
                    ParamValue::Num(x) if x.is_finite() => *x,
                    ParamValue::Bool(b) => if *b { 1.0 } else { 0.0 },
                    _ => return Err(format!("parameter {key} needs a finite number")),
                };
                match key {
                    $( stringify!($name) => { self.$name = num; Ok(()) } )*
                    _ => Err(format!("unknown heart parameter {name}")),
                }
            }

            /// All parameters by name (recorded with every session).
            pub fn to_map(&self) -> BTreeMap<String, ParamValue> {
                let mut m = BTreeMap::new();
                $( m.insert(format!("heart.{}", stringify!($name)), ParamValue::Num(self.$name)); )*
                m.insert("heart.high_hrv_measure".to_string(), ParamValue::Str(self.high_hrv_measure.clone()));
                m
            }
        }
    };
}

pub const HIGH_HRV_MEASURES: [&str; 5] = ["rmssd", "sdnn", "lf_power", "hf_power", "resonance_strength"];

heart_params! {
    // ---- frames ----
    /// Longest time between heart frames, s.
    frame_max_interval_s: 1.0,

    // ---- source selection ----
    /// Chest strap counts as present while its latest beat is at most this old, s.
    strap_fresh_s: 3.0,
    /// Headset pulse counts as present while its latest beat is at most this old, s
    /// (PPG beats are reported with about ppg_margin_s of latency).
    ppg_fresh_s: 4.0,

    // ---- chest strap clock ----
    /// Largest normal delay between a beat and the notification carrying it, s.
    /// A larger delay (plus half an interval) means intervals were lost; the clock re-anchors.
    rr_latency_max_s: 1.3,
    /// How fast the strap-to-session clock offset may creep later, s per s (clock drift allowance).
    rr_clock_creep: 0.0005,

    // ---- beat cleaning ----
    /// Number of preceding intervals in the local median.
    clean_median_n: 11.0,
    /// An interval further than this fraction from the local median is flagged.
    clean_tolerance: 0.2,
    /// Physiological limits on an interval, ms.
    clean_min_rr_ms: 300.0,
    clean_max_rr_ms: 2000.0,
    /// Only intervals within this many seconds before a beat form its local median.
    clean_median_span_s: 30.0,
    /// Variability outputs are null when more than this fraction of intervals in the window is flagged.
    correction_limit: 0.05,

    // ---- heart rate ----
    /// Heart rate is the mean of clean intervals over this window, s (declared smoothing).
    hr_window_s: 5.0,

    // ---- time-domain variability ----
    /// RMSSD and SDNN window, s. 60 default; 30 is the fast, less reliable option.
    hrv_window_s: 60.0,
    /// Minimum clean beats per minute of window.
    hrv_min_beats_per_min: 30.0,
    /// The source's data must span at least this fraction of a window before a value is given.
    hrv_min_cover: 0.9,

    // ---- resampled series and spectra ----
    /// Even resampling rate of the interval series, Hz.
    resample_hz: 4.0,
    /// Spectral window (LF, HF, resonance, breathing), s.
    spec_window_s: 120.0,
    /// Spectral measures are null when two consecutive clean beats in the window are further apart than this, s.
    spec_max_bridge_s: 3.0,
    /// Zero padding factor of the periodogram (frequency grid only, not resolution).
    spec_pad_factor: 4.0,
    lf_lo_hz: 0.04,
    lf_hi_hz: 0.15,
    hf_lo_hz: 0.15,
    hf_hi_hz: 0.4,
    resonance_lo_hz: 0.04,
    resonance_hi_hz: 0.26,
    /// Half width of the resonance peak for its strength, Hz.
    resonance_halfwidth_hz: 0.015,

    // ---- breathing estimate ----
    breath_lo_hz: 0.05,
    breath_hi_hz: 0.5,
    /// A breathing peak needs this share of breath-band power within +-resonance_halfwidth_hz.
    breath_min_share: 0.2,
    /// ... and a mean density within +-resonance_halfwidth_hz of the peak at least this many times
    /// the local background (median density within +-breath_local_hz, peak excluded).
    breath_min_peak_ratio: 6.0,
    breath_local_hz: 0.1,
    /// Cycles of the measured rhythm used to fit the current breathing phase.
    breath_fit_cycles: 1.5,
    /// Breathing phase is projected forward from the last clean beat by at most this, s.
    breath_phase_max_ahead_s: 2.0,

    // ---- pacer adherence ----
    /// Window for pacer adherence, s. Null until the pacer has run this long at its current rate.
    pacer_window_s: 60.0,

    // ---- high variability state (spec 8.4 rules) ----
    /// Entry threshold: this quantile of the baseline log ratio values.
    high_hrv_enter_q: 0.9,
    /// Exit threshold: this quantile (hysteresis: exit is below entry).
    high_hrv_exit_q: 0.6,
    /// Entry threshold is at least this far above the baseline median, natural log units.
    high_hrv_min_rise: 0.1,
    /// Dwell above the entry threshold before entering, s.
    high_hrv_dwell_s: 5.0,
    /// Baseline needs at least this many seconds with a valid statistic.
    high_hrv_min_baseline_s: 60.0,

    // ---- brain-heart coupling ----
    coupling_window_s: 300.0,
    /// Overlapping clean data needed before coupling is reported, s.
    coupling_min_overlap_s: 180.0,
    coupling_lo_hz: 0.04,
    coupling_hi_hz: 0.26,
    coupling_surrogates: 200.0,
    /// Smallest circular time shift for a surrogate, s.
    coupling_min_lag_s: 30.0,
    /// Coupling (and its chance level) is recomputed this often, s (declared update interval).
    coupling_update_s: 5.0,
    /// Phase-locking ignores this much at each end of the window (filter wrap-around), s.
    coupling_edge_s: 12.5,

    // ---- headset optical pulse ----
    ppg_rate_hz: 64.0,
    ppg_band_lo_hz: 0.5,
    ppg_band_hi_hz: 5.0,
    /// Analysis window, s.
    ppg_window_s: 8.0,
    /// Minimum window before detection starts, s.
    ppg_min_window_s: 4.0,
    /// Detection runs every this many samples.
    ppg_step_samples: 16.0,
    /// Peaks are only looked for this far before the newest sample, s (latency of PPG beats).
    ppg_margin_s: 0.75,
    /// Two pulse peaks closer than this are one beat, s.
    ppg_refractory_s: 0.33,
    /// A peak must reach this fraction of the recent pulse amplitude.
    ppg_threshold_frac: 0.4,
    /// Recent-amplitude memory is cleared after this long without a beat, s.
    ppg_amp_reset_s: 2.5,
    /// Channel quality (peak normalized autocorrelation at pulse lags) needed to detect beats.
    ppg_min_quality: 0.5,
    /// A channel replaces the current one only when better by this much.
    ppg_switch_margin: 0.1,
    /// Longest pulse period considered in the quality measure, s.
    ppg_max_period_s: 1.5,
}

impl HeartParams {
    pub fn with_overrides(overrides: &BTreeMap<String, ParamValue>) -> Result<Self, String> {
        let mut p = HeartParams::default();
        for (k, v) in overrides {
            p.set(k, v)?;
        }
        Ok(p)
    }
}
