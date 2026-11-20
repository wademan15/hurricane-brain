//! Hurricane Brain WebAssembly glue.
//!
//! One session object, [`Session`] (`HbSession` in JavaScript), runs the EEG engine (`hb-engine`)
//! and the heart engine (`hb-heart`) on one session clock and hands their frames to the app as
//! one JSON array in time order (`app/src/engine/frames.ts`, schema 1).
//!
//! The logic lives in [`Core`], plain Rust that the native tests exercise. The wasm-bindgen class
//! is a thin shell over it.
//!
//! Configuration (`EngineConfig` in frames.ts, as JSON):
//! - `streams.eeg` may be null (a heart-only session). Otherwise it starts the EEG engine.
//! - `params`: keys starting with `heart.` go to the heart engine, every other key to the EEG
//!   engine. An unknown name in either is an error, so a typo cannot silently fall back to a
//!   default.
//! - `streams.ppg.rate_hz` sets `heart.ppg_rate_hz` unless that parameter is given explicitly.
//! - `seed` seeds both engines' surrogates.
//!
//! Brain-heart coupling: after every slow frame the heart engine receives the slow brain series
//! named in [`BRAIN_SERIES`] at the slow frame's time. A null in the slow frame is passed as null.
//!
//! The heart engine is active when the configuration declares a chest strap or a PPG stream, or
//! from the first `push_rr` / `push_ppg`. Before that no heart frames are produced, because a
//! session without any heart source would otherwise emit a `source: none` frame every second.
//!
//! Ordering: each `drain` returns everything produced since the previous one, sorted by `t`
//! (stable: on equal `t`, frames keep the order they were produced in, EEG before the heart
//! frames its slow frame caused). Each engine's own frames never go back in time across drains.
//! A heart frame can carry a `t` earlier than an EEG frame of a previous drain when the RR stream
//! lags the EEG stream, because frames are delivered as soon as they exist rather than held back.
//!
//! Deterministic: the same configuration and the same sequence of calls give the same bytes.

use hb_engine::types::{Frame as EegFrame, Marker, ParamValue as EegParam, SlowFrame};
use hb_engine::{Engine, ENGINE_VERSION};
use hb_heart::{HeartConfig, HeartEngine, HeartFrame, HeartParams, ParamValue as HeartParam};
use serde_json::Value;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

pub const WASM_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The slow brain series fed to the heart engine for coupling, by the names that appear in
/// `HeartFrame.coupling[].brain`.
pub const BRAIN_SERIES: [&str; 3] = ["alpha.above_bg_db@temporal", "theta.above_bg_db@temporal", "dominant.height_db"];

/// The values of [`BRAIN_SERIES`] in one slow frame. `None` is a null in the frame.
pub fn brain_values(s: &SlowFrame) -> [Option<f64>; 3] {
    let temporal = s.spectra.iter().find(|sp| sp.site == "temporal");
    let alpha = temporal.and_then(|sp| sp.bands.alpha.above_bg_db.v);
    let theta = temporal.and_then(|sp| sp.bands.theta.above_bg_db.v);
    let dominant = s.dominant.and_then(|id| s.tracks.iter().find(|tr| tr.id == id)).and_then(|tr| tr.height_db.v);
    [alpha, theta, dominant]
}

enum Out {
    Eeg(EegFrame),
    Heart(Box<HeartFrame>),
}

impl Out {
    fn t(&self) -> f64 {
        match self {
            Out::Eeg(f) => f.t(),
            Out::Heart(h) => h.t,
        }
    }
}

/// Both engines on one session clock.
pub struct Core {
    eeg: Option<Engine>,
    heart: HeartEngine,
    heart_active: bool,
    ppg_channels: usize,
    pending: Vec<Out>,
}

impl Core {
    pub fn new(config_json: &str) -> Result<Core, String> {
        let mut cfg: Value = serde_json::from_str(config_json).map_err(|e| format!("config is not valid JSON: {e}"))?;
        let obj = cfg.as_object_mut().ok_or("config must be a JSON object")?;

        // Split the parameter overrides between the two engines.
        let mut eeg_params: BTreeMap<String, EegParam> = BTreeMap::new();
        let mut heart_params: BTreeMap<String, HeartParam> = BTreeMap::new();
        if let Some(p) = obj.remove("params") {
            if !p.is_null() {
                let map: BTreeMap<String, Value> = serde_json::from_value(p).map_err(|e| format!("params: {e}"))?;
                for (k, v) in map {
                    if k.starts_with("heart.") {
                        let hv: HeartParam = serde_json::from_value(v).map_err(|e| format!("parameter {k}: {e}"))?;
                        heart_params.insert(k, hv);
                    } else {
                        let ev: EegParam = serde_json::from_value(v).map_err(|e| format!("parameter {k}: {e}"))?;
                        eeg_params.insert(k, ev);
                    }
                }
            }
        }
        let seed = obj.get("seed").and_then(Value::as_u64).ok_or("config.seed must be a non-negative integer")?;
        let streams = obj.get("streams").cloned().unwrap_or(Value::Null);
        let has_eeg = streams.get("eeg").is_some_and(|v| !v.is_null());
        let ppg = streams.get("ppg").filter(|v| !v.is_null());
        let strap = streams.get("chest_strap").is_some_and(|v| !v.is_null());
        let ppg_channels = ppg.and_then(|p| p.get("channels")).and_then(Value::as_array).map_or(0, |a| a.len());
        if let Some(rate) = ppg.and_then(|p| p.get("rate_hz")).and_then(Value::as_f64) {
            heart_params.entry("heart.ppg_rate_hz".into()).or_insert(HeartParam::Num(rate));
        }

        let eeg = if has_eeg {
            obj.insert("params".into(), serde_json::to_value(&eeg_params).map_err(|e| e.to_string())?);
            let ec: hb_engine::EngineConfig = serde_json::from_value(cfg).map_err(|e| format!("config: {e}"))?;
            Some(Engine::new(ec).map_err(|e| format!("EEG engine: {e}"))?)
        } else {
            if !eeg_params.is_empty() {
                return Err("EEG parameters given but streams.eeg is null".into());
            }
            None
        };
        let hp = HeartParams::with_overrides(&heart_params)?;
        let heart = HeartEngine::new(HeartConfig { seed, params: hp });
        Ok(Core { eeg, heart, heart_active: strap || ppg.is_some(), ppg_channels, pending: Vec::new() })
    }

    pub fn push_eeg(&mut self, first_index: u64, samples: &[f32]) {
        let Some(e) = self.eeg.as_mut() else { return };
        e.push_eeg(first_index, samples);
        self.collect_eeg();
    }

    pub fn push_motion(&mut self, t: f64, acc: &[f32], gyro: &[f32]) {
        let Some(e) = self.eeg.as_mut() else { return };
        if acc.len() != 3 || gyro.len() != 3 {
            return;
        }
        e.push_motion(t, [acc[0], acc[1], acc[2]], [gyro[0], gyro[1], gyro[2]]);
        self.collect_eeg();
    }

    pub fn push_ppg(&mut self, t: f64, samples: &[f32]) {
        if self.ppg_channels == 0 {
            return;
        }
        self.heart_active = true;
        self.heart.push_ppg(t, samples, self.ppg_channels);
        self.collect_heart();
    }

    pub fn push_rr(&mut self, t: f64, rr_ms: &[f32]) {
        self.heart_active = true;
        self.heart.push_rr(t, rr_ms);
        self.collect_heart();
    }

    pub fn push_marker(&mut self, json: &str) -> Result<(), String> {
        let mk: Marker = serde_json::from_str(json).map_err(|e| format!("marker: {e}"))?;
        if let Some(e) = self.eeg.as_mut() {
            e.push_marker(mk);
        }
        Ok(())
    }

    pub fn set_pacer(&mut self, bpm: Option<f64>) {
        self.heart.set_pacer(bpm);
    }

    pub fn set_iaf(&mut self, hz: Option<f64>) {
        if let Some(e) = self.eeg.as_mut() {
            e.set_iaf(hz);
        }
    }

    pub fn mark_heart_baseline(&mut self, t0: f64, t1: f64) {
        self.heart.mark_baseline(t0, t1);
    }

    /// Every frame since the last call, merged in time order, as a JSON array.
    pub fn drain_json(&mut self) -> String {
        let mut frames = std::mem::take(&mut self.pending);
        frames.sort_by(|a, b| a.t().total_cmp(&b.t()));
        let mut buf = Vec::with_capacity(frames.len() * 1024 + 2);
        buf.push(b'[');
        for (i, f) in frames.iter().enumerate() {
            if i > 0 {
                buf.push(b',');
            }
            match f {
                Out::Eeg(x) => serde_json::to_writer(&mut buf, x),
                Out::Heart(x) => serde_json::to_writer(&mut buf, x),
            }
            .expect("frame serializes");
        }
        buf.push(b']');
        String::from_utf8(buf).expect("serde_json writes UTF-8")
    }

    /// Number of frames waiting for the next drain.
    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    pub fn version(&self) -> String {
        format!("{ENGINE_VERSION}+hb-heart/{}+hb-wasm/{WASM_VERSION}", hb_heart::VERSION)
    }

    /// Both parameter sets in force: EEG names as they are, heart names prefixed `heart.`.
    pub fn params_json(&self) -> String {
        let mut m: BTreeMap<String, Value> = BTreeMap::new();
        if let Some(e) = self.eeg.as_ref() {
            for (k, v) in e.params() {
                m.insert(k, serde_json::to_value(v).expect("param"));
            }
        }
        for (k, v) in self.heart.params() {
            // hb-heart already names its parameters `heart.<name>`.
            m.insert(k, serde_json::to_value(v).expect("param"));
        }
        serde_json::to_string(&m).expect("params serialize")
    }

    fn collect_eeg(&mut self) {
        let Some(e) = self.eeg.as_mut() else { return };
        let frames = e.drain();
        let mut fed = false;
        for f in frames {
            if self.heart_active {
                if let EegFrame::Slow(s) = &f {
                    let vals = brain_values(s);
                    for (name, v) in BRAIN_SERIES.iter().zip(vals) {
                        self.heart.push_brain(s.t, name, v);
                    }
                    fed = true;
                }
            }
            self.pending.push(Out::Eeg(f));
            if fed {
                // Heart frames that the brain samples' clock advance produced, after their slow frame.
                self.collect_heart();
                fed = false;
            }
        }
    }

    fn collect_heart(&mut self) {
        for h in self.heart.drain() {
            self.pending.push(Out::Heart(Box::new(h)));
        }
    }
}

/// The engine session as JavaScript sees it.
#[wasm_bindgen(js_name = HbSession)]
pub struct Session(Core);

fn js_err(e: String) -> JsError {
    JsError::new(&e)
}

#[wasm_bindgen(js_class = HbSession)]
impl Session {
    /// `config_json`: an `EngineConfig` (frames.ts) as JSON. Throws on a bad config or parameter.
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> Result<Session, JsError> {
        Core::new(config_json).map(Session).map_err(js_err)
    }

    /// EEG samples interleaved by channel, microvolts. `first_index` is a non-negative integer.
    #[wasm_bindgen(js_name = pushEeg)]
    pub fn push_eeg(&mut self, first_index: f64, samples: &[f32]) {
        if !(first_index >= 0.0 && first_index.fract() == 0.0 && first_index < 9.0e15) {
            return;
        }
        self.0.push_eeg(first_index as u64, samples);
    }

    #[wasm_bindgen(js_name = pushMotion)]
    pub fn push_motion(&mut self, t: f64, acc: &[f32], gyro: &[f32]) {
        self.0.push_motion(t, acc, gyro);
    }

    #[wasm_bindgen(js_name = pushPpg)]
    pub fn push_ppg(&mut self, t: f64, samples: &[f32]) {
        self.0.push_ppg(t, samples);
    }

    #[wasm_bindgen(js_name = pushRr)]
    pub fn push_rr(&mut self, t: f64, rr_ms: &[f32]) {
        self.0.push_rr(t, rr_ms);
    }

    /// A `Marker` (frames.ts) as JSON.
    #[wasm_bindgen(js_name = pushMarker)]
    pub fn push_marker(&mut self, json: &str) -> Result<(), JsError> {
        self.0.push_marker(json).map_err(js_err)
    }

    #[wasm_bindgen(js_name = setPacer)]
    pub fn set_pacer(&mut self, bpm: Option<f64>) {
        self.0.set_pacer(bpm);
    }

    #[wasm_bindgen(js_name = setIaf)]
    pub fn set_iaf(&mut self, hz: Option<f64>) {
        self.0.set_iaf(hz);
    }

    #[wasm_bindgen(js_name = markHeartBaseline)]
    pub fn mark_heart_baseline(&mut self, t0: f64, t1: f64) {
        self.0.mark_heart_baseline(t0, t1);
    }

    /// All frames since the last call, in time order, as a JSON array string.
    pub fn drain(&mut self) -> String {
        self.0.drain_json()
    }

    pub fn pending(&self) -> usize {
        self.0.pending()
    }

    pub fn version(&self) -> String {
        self.0.version()
    }

    /// The merged parameter set as a JSON object string.
    pub fn params(&self) -> String {
        self.0.params_json()
    }
}
