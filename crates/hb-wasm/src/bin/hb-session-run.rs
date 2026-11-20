//! hb-session-run: replay a fixture (and optionally a chest-strap RR script) through the same
//! session glue the browser runs, natively. Used by app/src/engine/test to check that the
//! WebAssembly build gives byte-identical output.
//!
//! Usage: hb-session-run path/to/name [rr.json]
//!   name.json / name.f32: a lab fixture (see lab/fixtures/README.md).
//!   rr.json: [[t, [rr_ms, ...]], ...] notifications, in time order.
//! EEG is pushed in 12-sample packets. After each packet, every RR notification with t at or
//! before the packet's last sample time is pushed, then the session is drained. Every non-empty
//! drain is printed on its own line (a JSON array of frames).

use hb_wasm::Core;
use std::io::{BufWriter, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 || args.len() > 3 {
        eprintln!("usage: hb-session-run path/to/name [rr.json]");
        std::process::exit(2);
    }
    let base = &args[1];
    let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{base}.json")).expect("read json")).expect("parse json");
    let bytes = std::fs::read(format!("{base}.f32")).expect("read f32");
    let samples: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let rr: Vec<(f64, Vec<f32>)> = match args.get(2) {
        Some(p) => serde_json::from_str(&std::fs::read_to_string(p).expect("read rr")).expect("parse rr"),
        None => Vec::new(),
    };
    let channels = meta["channels"].clone();
    let nch = channels.as_array().expect("channels").len();
    let rate = meta["rate_hz"].as_f64().expect("rate_hz");
    let config = serde_json::json!({
        "streams": {
            "eeg": { "channels": channels, "rate_hz": rate, "bits": 0, "model": meta.get("model").cloned().unwrap_or("".into()) },
            "ppg": null, "motion": null,
            "chest_strap": if rr.is_empty() { serde_json::Value::Null } else { serde_json::json!({ "name": "replay" }) },
        },
        "params": meta.get("params").cloned().unwrap_or(serde_json::Value::Null),
        "seed": meta.get("seed").and_then(|s| s.as_u64()).unwrap_or(0),
        "mains_hz": meta.get("mains_hz").cloned().unwrap_or(serde_json::Value::Null),
    });
    let mut core = Core::new(&config.to_string()).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1)
    });
    let out = std::io::stdout();
    let mut w = BufWriter::new(out.lock());
    let mut idx = 0u64;
    let mut k = 0usize;
    for chunk in samples.chunks(12 * nch) {
        let n = chunk.len() / nch;
        core.push_eeg(idx, &chunk[..n * nch]);
        idx += n as u64;
        let t_last = (idx - 1) as f64 / rate;
        while k < rr.len() && rr[k].0 <= t_last {
            core.push_rr(rr[k].0, &rr[k].1);
            k += 1;
        }
        if core.pending() > 0 {
            w.write_all(core.drain_json().as_bytes()).unwrap();
            w.write_all(b"\n").unwrap();
        }
    }
    w.flush().unwrap();
}
