//! Shared serde types: the measurement frame contract of `app/src/engine/frames.ts`,
//! schema version 1. Field names and shapes match that file exactly. Reusable by the other
//! engine crates (hb-heart uses `Measured`, `Reason` and friends).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA_VERSION: u32 = 1;

/// Why a value is null, or `ok`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Ok,
    WarmingUp,
    NoData,
    Gap,
    BadContact,
    Artifact,
    InsufficientClean,
    BadFit,
    NotConfirmed,
    Weak,
    LostLock,
    Unresolved,
    TooFewBeats,
    TooManyCorrections,
    NotAvailable,
}

/// A measured value, or null with a reason. Never zero in place of null (spec rule 1).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Measured {
    pub v: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub se: Option<f64>,
    pub why: Reason,
}

impl Measured {
    /// A measured value without a standard error. A non-finite value becomes null.
    pub fn ok(v: f64) -> Self {
        if v.is_finite() {
            Measured { v: Some(v), se: None, why: Reason::Ok }
        } else {
            Measured::null(Reason::NotAvailable)
        }
    }

    /// A measured value with its standard error (dropped if not finite).
    pub fn with_se(v: f64, se: f64) -> Self {
        let mut r = Measured::ok(v);
        if r.v.is_some() && se.is_finite() {
            r.se = Some(se);
        }
        r
    }

    pub fn opt_se(v: f64, se: Option<f64>) -> Self {
        match se {
            Some(s) => Measured::with_se(v, s),
            None => Measured::ok(v),
        }
    }

    /// Null with a reason. Passing `Reason::Ok` is a bug and is mapped to `NotAvailable`.
    pub fn null(why: Reason) -> Self {
        debug_assert!(why != Reason::Ok, "null must carry a reason");
        let why = if why == Reason::Ok { Reason::NotAvailable } else { why };
        Measured { v: None, se: None, why }
    }

    pub fn from_result(r: Result<f64, Reason>) -> Self {
        match r {
            Ok(v) => Measured::ok(v),
            Err(w) => Measured::null(w),
        }
    }

    pub fn value(&self) -> Option<f64> {
        self.v
    }

    pub fn is_ok(&self) -> bool {
        self.v.is_some()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    Phi,
    Octave,
    #[serde(rename = "control_1_5")]
    Control15,
    #[serde(rename = "control_1_8")]
    Control18,
    /// 3:1. Scored and logged like the controls; never forms cascades or states (spec 8.1).
    #[serde(rename = "ratio_3")]
    Ratio3,
}

impl Target {
    pub const ALL: [Target; 5] = [Target::Phi, Target::Octave, Target::Control15, Target::Control18, Target::Ratio3];
}

/// `Record<Target, T>`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TargetMap<T> {
    pub phi: T,
    pub octave: T,
    pub ratio_3: T,
    pub control_1_5: T,
    pub control_1_8: T,
}

impl<T> TargetMap<T> {
    pub fn get(&self, t: Target) -> &T {
        match t {
            Target::Phi => &self.phi,
            Target::Octave => &self.octave,
            Target::Control15 => &self.control_1_5,
            Target::Control18 => &self.control_1_8,
            Target::Ratio3 => &self.ratio_3,
        }
    }
    pub fn from_fn(mut f: impl FnMut(Target) -> T) -> Self {
        TargetMap { phi: f(Target::Phi), octave: f(Target::Octave), ratio_3: f(Target::Ratio3), control_1_5: f(Target::Control15), control_1_8: f(Target::Control18) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BandName {
    Delta,
    Theta,
    Alpha,
    Beta,
    Gamma,
}

impl BandName {
    pub const ALL: [BandName; 5] = [BandName::Delta, BandName::Theta, BandName::Alpha, BandName::Beta, BandName::Gamma];
}

/// `Record<BandName, T>`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BandMap<T> {
    pub delta: T,
    pub theta: T,
    pub alpha: T,
    pub beta: T,
    pub gamma: T,
}

impl<T> BandMap<T> {
    pub fn get(&self, b: BandName) -> &T {
        match b {
            BandName::Delta => &self.delta,
            BandName::Theta => &self.theta,
            BandName::Alpha => &self.alpha,
            BandName::Beta => &self.beta,
            BandName::Gamma => &self.gamma,
        }
    }
    pub fn from_fn(mut f: impl FnMut(BandName) -> T) -> Self {
        BandMap { delta: f(BandName::Delta), theta: f(BandName::Theta), alpha: f(BandName::Alpha), beta: f(BandName::Beta), gamma: f(BandName::Gamma) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Blink,
    EyeMovement,
    Muscle,
    Motion,
    Pop,
    Gap,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChannelQuality {
    pub name: String,
    pub usable: bool,
    pub why: Reason,
    pub mains_uv: Option<f64>,
    pub sd_uv: Option<f64>,
    pub railed: Option<f64>,
    pub emg_db: Option<f64>,
    pub clean_fraction: f64,
    pub artifacts: Vec<ArtifactKind>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BandSummary {
    pub above_bg_db: Measured,
    pub power: Measured,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SiteSpectrum {
    pub site: String,
    pub why: Reason,
    pub f0: f64,
    pub df: f64,
    pub psd: Vec<f32>,
    pub flat: Vec<f32>,
    pub bg_exponent: Measured,
    pub bg_offset: Measured,
    pub k: u32,
    /// Band summaries over the band edges in force (`band_edges`: scaled to the individual
    /// alpha frequency when one is set).
    pub bands: BandMap<BandSummary>,
    /// The same over the fixed textbook edges (1-4, 4-8, 8-13, 13-30, 30-45 Hz), always, so a
    /// session can be compared with others whatever its individual alpha frequency.
    pub bands_fixed: BandMap<BandSummary>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackState {
    New,
    Confirmed,
    Fading,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarmonicOf {
    pub id: u32,
    pub n: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: u32,
    pub state: TrackState,
    pub site: String,
    pub freq: Measured,
    pub freq_integrated: Measured,
    pub height_db: Measured,
    pub width_hz: Measured,
    pub age_s: f64,
    pub band: BandName,
    pub harmonic_of: Option<HarmonicOf>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PairTargetScore {
    pub miss: Measured,
    pub closeness: Measured,
    pub log_evidence: Measured,
    pub aligned: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PairScore {
    pub lo: u32,
    pub hi: u32,
    pub log_ratio: Measured,
    pub harmonic: bool,
    pub targets: TargetMap<PairTargetScore>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CascadeTarget {
    Phi,
    Octave,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChanceLevel {
    pub closeness: Measured,
    pub p: Measured,
    pub p_steps: Measured,
}

impl ChanceLevel {
    pub fn null(why: Reason) -> Self {
        ChanceLevel { closeness: Measured::null(why), p: Measured::null(why), p_steps: Measured::null(why) }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChancePair {
    pub a: ChanceLevel,
    pub b: ChanceLevel,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Cascade {
    pub target: CascadeTarget,
    pub tracks: Vec<u32>,
    pub steps: u32,
    pub skipped: Vec<u32>,
    pub closeness: Measured,
    pub held_s: f64,
    pub chance: ChancePair,
    pub excess_a: Measured,
    pub excess_b: Measured,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AlignedState {
    pub target: CascadeTarget,
    pub active: bool,
    pub for_s: f64,
    pub stat: Measured,
    pub enter_at: Option<f64>,
    pub exit_at: Option<f64>,
}

/// The combined state: active only while both the golden ratio state and the octave state
/// are active. It has no statistic of its own; it is the conjunction of two measured states.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct BothState {
    pub active: bool,
    /// Seconds in the current combined condition (active or not).
    pub for_s: f64,
}

/// `states` of a slow frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct States {
    pub phi: AlignedState,
    pub octave: AlignedState,
    pub both: BothState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SiteComparison {
    pub track: u32,
    pub freq_diff: Measured,
    pub balance: Measured,
    pub locking_excess: Measured,
    #[serde(rename = "match")]
    pub match_: Measured,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PhiOctave<T> {
    pub phi: T,
    pub octave: T,
}

/// The constant `kind` tag of a slow frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SlowKind {
    #[serde(rename = "slow")]
    Slow,
}

/// The constant `kind` tag of a fast frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FastKind {
    #[serde(rename = "fast")]
    Fast,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SlowFrame {
    pub kind: SlowKind,
    pub schema: u32,
    pub t: f64,
    pub window_s: f64,
    pub quality: Vec<ChannelQuality>,
    pub spectra: Vec<SiteSpectrum>,
    pub tracks: Vec<Track>,
    pub dominant: Option<u32>,
    pub pairs: Vec<PairScore>,
    pub cascades: PhiOctave<Cascade>,
    pub states: States,
    pub hemispheres: Vec<SiteComparison>,
    pub front_back: Vec<SiteComparison>,
    pub mains_hz: Option<u32>,
    pub iaf_hz: Option<f64>,
    pub band_edges: BandMap<[f64; 2]>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FastTrack {
    pub id: u32,
    pub freq: Measured,
    pub amp_uv: Measured,
    pub height_db: Measured,
    pub phase: Measured,
    pub locked: bool,
    pub delay_s: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FastFrame {
    pub kind: FastKind,
    pub schema: u32,
    pub t: f64,
    pub tracks: Vec<FastTrack>,
    pub artifact: bool,
}

/// A frame from this engine. Serializes untagged: each variant carries its own `kind`.
/// (Heart frames come from hb-heart; a wrapper there or in the wasm crate can add them.)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Frame {
    Slow(Box<SlowFrame>),
    Fast(FastFrame),
}

impl Frame {
    pub fn t(&self) -> f64 {
        match self {
            Frame::Slow(s) => s.t,
            Frame::Fast(f) => f.t,
        }
    }
}

// ---------------------------------------------------------------------------
// Engine input
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EegStream {
    pub channels: Vec<String>,
    pub rate_hz: f64,
    #[serde(default)]
    pub bits: u32,
    #[serde(default)]
    pub model: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PpgStream {
    pub channels: Vec<String>,
    pub rate_hz: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MotionStream {
    pub rate_hz: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChestStrap {
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StreamDescription {
    #[serde(default)]
    pub eeg: Option<EegStream>,
    #[serde(default)]
    pub ppg: Option<PpgStream>,
    #[serde(default)]
    pub motion: Option<MotionStream>,
    #[serde(default)]
    pub chest_strap: Option<ChestStrap>,
}

/// A parameter value as it appears in `EngineConfig.params` and `params()`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParamValue {
    Bool(bool),
    Num(f64),
    Str(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EngineConfig {
    pub streams: StreamDescription,
    #[serde(default)]
    pub params: Option<BTreeMap<String, ParamValue>>,
    pub seed: u64,
    #[serde(default)]
    pub mains_hz: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkerType {
    BlockStart,
    BlockEnd,
    Technique,
    Instruction,
    Report,
    BaselineStart,
    BaselineEnd,
    AnchorPlay,
    Note,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Marker {
    pub t: f64,
    #[serde(rename = "type")]
    pub kind: MarkerType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Map<String, serde_json::Value>>,
}
