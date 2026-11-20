//! Native tests of the session glue: EEG frames pass through unchanged, brain series reach the
//! heart engine, frames come out in time order, and output is deterministic.

use hb_wasm::Core;

const CFG: &str = r#"{"streams":{"eeg":{"channels":["TP9","AF7","AF8","TP10"],"rate_hz":256,"bits":12,"model":"test"},"ppg":null,"motion":null,"chest_strap":{"name":"H10"}},"seed":7}"#;

/// Deterministic test signal: a 10 Hz rhythm plus a cheap pseudo-random background.
fn eeg(n: usize, first: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(n * 4);
    for i in first..first + n {
        let t = i as f64 / 256.0;
        for c in 0..4u64 {
            let mut x = (i as u64).wrapping_mul(6364136223846793005).wrapping_add(c * 1442695040888963407);
            x ^= x >> 33;
            let noise = (x % 2000) as f64 / 100.0 - 10.0;
            out.push((noise + 8.0 * (std::f64::consts::TAU * 10.0 * t).sin()) as f32);
        }
    }
    out
}

fn run(chunk: usize, secs: usize) -> Vec<String> {
    let mut core = Core::new(CFG).unwrap();
    let mut out = Vec::new();
    let total = secs * 256;
    let mut i = 0;
    let mut next_beat = 0.0f64;
    while i < total {
        let n = chunk.min(total - i);
        core.push_eeg(i as u64, &eeg(n, i));
        i += n;
        let t = i as f64 / 256.0;
        while next_beat + 1.0 <= t {
            next_beat += 1.0;
            core.push_rr(next_beat, &[1000.0 + 50.0 * (next_beat * 0.6).sin() as f32]);
        }
        out.push(core.drain_json());
    }
    out
}

#[test]
fn deterministic_bytes() {
    assert_eq!(run(12, 40), run(12, 40));
}

#[test]
fn frames_in_time_order_and_all_kinds_present() {
    let all: Vec<serde_json::Value> =
        run(12, 40).iter().flat_map(|s| serde_json::from_str::<Vec<serde_json::Value>>(s).unwrap()).collect();
    let kinds = |k: &str| all.iter().filter(|f| f["kind"] == k).count();
    assert!(kinds("slow") > 100 && kinds("fast") > 1000 && kinds("heart") > 30, "{} {} {}", kinds("slow"), kinds("fast"), kinds("heart"));
    // Per kind, time never decreases.
    for k in ["slow", "fast", "heart"] {
        let ts: Vec<f64> = all.iter().filter(|f| f["kind"] == k).map(|f| f["t"].as_f64().unwrap()).collect();
        assert!(ts.windows(2).all(|w| w[0] <= w[1]), "{k} not in order");
    }
}

#[test]
fn eeg_frames_identical_to_engine() {
    // Without a heart source the output is exactly the EEG engine's frames, byte for byte.
    let cfg = CFG.replace(r#""chest_strap":{"name":"H10"}"#, r#""chest_strap":null"#);
    let mut core = Core::new(&cfg).unwrap();
    let mut e = hb_engine::Engine::new(serde_json::from_str(&cfg).unwrap()).unwrap();
    let (mut ours, mut theirs) = (String::new(), String::new());
    for k in 0..(30 * 256 / 12) {
        let x = eeg(12, k * 12);
        core.push_eeg((k * 12) as u64, &x);
        e.push_eeg((k * 12) as u64, &x);
        let d = core.drain_json();
        ours.push_str(&d[1..d.len() - 1]);
        let f: Vec<String> = e.drain().iter().map(|f| serde_json::to_string(f).unwrap()).collect();
        theirs.push_str(&f.join(","));
    }
    assert!(ours.len() > 1_000_000);
    assert!(ours == theirs);
}

#[test]
fn params_split_and_merged() {
    let cfg = CFG.replace(r#""seed":7"#, r#""seed":7,"params":{"heart.hr_window_s":7,"slow_update_s":0.25}"#);
    let core = Core::new(&cfg).unwrap();
    let p: serde_json::Value = serde_json::from_str(&core.params_json()).unwrap();
    assert_eq!(p["heart.hr_window_s"], 7.0);
    assert_eq!(p["slow_update_s"], 0.25);
    assert!(Core::new(&CFG.replace(r#""seed":7"#, r#""seed":7,"params":{"heart.nope":1}"#)).is_err());
    assert!(Core::new(&CFG.replace(r#""seed":7"#, r#""seed":7,"params":{"nope":1}"#)).is_err());
}

#[test]
fn heart_only_session() {
    let cfg = r#"{"streams":{"eeg":null,"ppg":null,"motion":null,"chest_strap":{"name":"H10"}},"seed":1}"#;
    let mut core = Core::new(cfg).unwrap();
    for k in 1..=20 {
        core.push_rr(k as f64, &[1000.0]);
    }
    let v: Vec<serde_json::Value> = serde_json::from_str(&core.drain_json()).unwrap();
    assert!(v.len() >= 20 && v.iter().all(|f| f["kind"] == "heart"));
}

#[test]
fn brain_series_reach_coupling() {
    let all: Vec<serde_json::Value> =
        run(12, 20).iter().flat_map(|s| serde_json::from_str::<Vec<serde_json::Value>>(s).unwrap()).collect();
    let last = all.iter().rev().find(|f| f["kind"] == "heart").unwrap();
    let names: Vec<&str> = last["coupling"].as_array().unwrap().iter().map(|c| c["brain"].as_str().unwrap()).collect();
    for n in hb_wasm::BRAIN_SERIES {
        assert!(names.iter().any(|x| x == &n), "{n} missing from {names:?}");
    }
}
