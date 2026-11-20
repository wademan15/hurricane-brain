//! hb-run: replay a fixture through the engine and print frames as JSON Lines.
//!
//! Usage: hb-run path/to/name
//!   reads path/to/name.json  {"channels": [...], "rate_hz": 256, "seed": 1, ...}
//!         path/to/name.f32   little-endian float32 samples, interleaved by channel, uV
//! Optional keys in the JSON: "params" (overrides by name), "mains_hz" (50 or 60).
//! Unknown keys (such as "truth") are ignored. Writes one frame per line to stdout.

use hb_engine::types::{EegStream, EngineConfig, ParamValue, StreamDescription};
use hb_engine::Engine;
use std::collections::BTreeMap;
use std::io::{BufWriter, Write};

#[derive(serde::Deserialize)]
struct Meta {
    channels: Vec<String>,
    rate_hz: f64,
    #[serde(default)]
    seed: u64,
    #[serde(default)]
    params: Option<BTreeMap<String, ParamValue>>,
    #[serde(default)]
    mains_hz: Option<u32>,
    #[serde(default)]
    model: Option<String>,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: hb-run path/to/name   (reads name.json and name.f32)");
        std::process::exit(2);
    }
    let base = &args[1];
    let meta_txt = std::fs::read_to_string(format!("{base}.json")).unwrap_or_else(|e| {
        eprintln!("cannot read {base}.json: {e}");
        std::process::exit(1)
    });
    let meta: Meta = serde_json::from_str(&meta_txt).unwrap_or_else(|e| {
        eprintln!("bad {base}.json: {e}");
        std::process::exit(1)
    });
    let bytes = std::fs::read(format!("{base}.f32")).unwrap_or_else(|e| {
        eprintln!("cannot read {base}.f32: {e}");
        std::process::exit(1)
    });
    if bytes.len() % 4 != 0 {
        eprintln!("{base}.f32 length is not a multiple of 4");
        std::process::exit(1);
    }
    let samples: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let nch = meta.channels.len();
    let cfg = EngineConfig {
        streams: StreamDescription {
            eeg: Some(EegStream { channels: meta.channels.clone(), rate_hz: meta.rate_hz, bits: 0, model: meta.model.clone().unwrap_or_default() }),
            ..Default::default()
        },
        params: meta.params.clone(),
        seed: meta.seed,
        mains_hz: meta.mains_hz,
    };
    let mut engine = Engine::new(cfg).unwrap_or_else(|e| {
        eprintln!("engine: {e}");
        std::process::exit(1)
    });
    let out = std::io::stdout();
    let mut w = BufWriter::new(out.lock());
    // Feed in Muse-sized packets of 12 samples per channel.
    let per = 12 * nch;
    let mut idx: u64 = 0;
    for chunk in samples.chunks(per) {
        let n = chunk.len() / nch;
        engine.push_eeg(idx, &chunk[..n * nch]);
        idx += n as u64;
        for f in engine.drain() {
            serde_json::to_writer(&mut w, &f).expect("serialize");
            w.write_all(b"\n").expect("write");
        }
    }
    w.flush().expect("flush");
}
