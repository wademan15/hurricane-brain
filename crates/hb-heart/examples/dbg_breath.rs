#[path = "../tests/common/mod.rs"]
mod common;
use common::*;
fn main() {
    let fs = 64.0;
    for seed in 8u64..20 {
    let mut peaks = Vec::new();
    let mut t = 0.5;
    while t < 120.0 {
        let hr = 72.0 + 8.0 * (2.0 * std::f64::consts::PI * 0.12 * t).sin() + 2.0 * (t / 60.0);
        t += 60.0 / hr;
        peaks.push(t);
    }
    let sig = ppg_signal(seed, &peaks, 121.0, fs);
    let mut e = engine(seed);
    let n = sig.len() / 3;
    let mut i = 0;
    let mut mn = [9.0f64; 3];
    let mut mx = [0.0f64; 3];
    while i < n {
        let k = 12.min(n - i);
        e.push_ppg(i as f64 / fs, &sig[i * 3..(i + k) * 3], 3);
        for c in 0..3 { if let Some(q) = e.ppg_quality()[c] { mn[c] = mn[c].min(q); mx[c] = mx[c].max(q);} }
        i += k;
    }
    println!("seed {seed} min {:?} max {:?}", mn, mx);
    }
}
