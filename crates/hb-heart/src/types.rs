//! Output types. These serialize (serde) to exactly the `HeartFrame` shape in
//! `app/src/engine/frames.ts`, schema version 1.
//!
//! `Measured` and `Reason` are local copies of the shared types; they will be unified
//! with `hb-engine`'s copies later (see NOTES.md).

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

/// Why a value is null, or `ok`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

/// A measured value or null with a reason. `se` is one standard error where it can be estimated.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Measured {
    pub v: Option<f64>,
    pub se: Option<f64>,
    pub why: Reason,
}

impl Measured {
    /// A measured value. A non-finite value becomes null with reason `unresolved`,
    /// so NaN or infinity can never reach the output.
    pub fn ok(v: f64) -> Self {
        if v.is_finite() {
            Measured { v: Some(v), se: None, why: Reason::Ok }
        } else {
            Measured::null(Reason::Unresolved)
        }
    }

    pub fn ok_se(v: f64, se: f64) -> Self {
        let mut m = Measured::ok(v);
        if m.v.is_some() && se.is_finite() && se >= 0.0 {
            m.se = Some(se);
        }
        m
    }

    pub fn null(why: Reason) -> Self {
        debug_assert!(why != Reason::Ok, "a null must carry a reason other than ok");
        Measured { v: None, se: None, why }
    }

    pub fn is_ok(&self) -> bool {
        self.v.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeartSource {
    ChestStrap,
    HeadsetPpg,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Beat {
    /// Time of the beat on the session clock, s.
    pub t: f64,
    /// Interval since the previous beat, ms.
    pub ibi_ms: f64,
    /// True if beat cleaning marked this interval as missed, extra or ectopic.
    pub flagged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct HighHrv {
    pub active: bool,
    pub for_s: f64,
    pub stat: Measured,
    pub enter_at: Option<f64>,
    pub exit_at: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Coupling {
    pub brain: String,
    /// "correlation" or "phase_locking".
    pub measure: String,
    pub value: Measured,
    pub chance: Measured,
    pub p: Measured,
    pub suspect_artifact: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HeartKind {
    #[serde(rename = "heart")]
    Heart,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeartFrame {
    pub kind: HeartKind,
    pub schema: u32,
    pub t: f64,
    pub source: HeartSource,
    pub beats: Vec<Beat>,
    pub hr_bpm: Measured,
    pub rmssd_ms: Measured,
    pub sdnn_ms: Measured,
    pub lf_power: Measured,
    pub hf_power: Measured,
    pub resonance_hz: Measured,
    pub resonance_strength: Measured,
    pub breath_bpm: Measured,
    pub breath_phase: Measured,
    pub pacer_adherence: Measured,
    pub corrected_fraction: f64,
    pub high_hrv: HighHrv,
    pub coupling: Vec<Coupling>,
}
