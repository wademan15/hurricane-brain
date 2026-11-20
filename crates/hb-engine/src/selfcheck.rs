//! Platform determinism check (spec 11): run a fixed synthetic session through the engine
//! and hash the serialized frames. The same seed must give the same digest on every build,
//! native or wasm32. The browser build can compare its digest with the native one.

use crate::dsp::fft::{next_pow2, Fft, C};
use crate::m;
use crate::prng::Rng;
use crate::types::{EegStream, EngineConfig, StreamDescription};
use crate::Engine;

fn fnv1a(h: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *h ^= *b as u64;
        *h = h.wrapping_mul(0x0000_0100_0000_01B3);
    }
}

/// Synthetic 4-channel session: 1/f^1.5 background plus rhythms at 10/phi, 10 and 10*phi Hz.
fn session(seed: u64, secs: u32) -> Vec<f32> {
    let rate = 256.0;
    let n = (secs as f64 * rate) as usize;
    let nfft = next_pow2(n.max(2));
    let fft = Fft::new(nfft);
    let phi = (1.0 + m::sqrt(5.0)) / 2.0;
    let rh = [10.0 / phi, 10.0, 10.0 * phi];
    let mut rng = Rng::new(seed);
    let mut chans = Vec::new();
    for _ in 0..4 {
        let mut buf = vec![C::default(); nfft];
        for k in 1..nfft / 2 {
            let f = k as f64 * rate / nfft as f64;
            let mut p = m::pow(f.max(0.5), -1.5);
            for r in rh {
                p += 9.0 * m::pow(r, -1.5) * m::exp(-0.5 * ((f - r) / 0.3) * ((f - r) / 0.3));
            }
            let a = m::sqrt(p);
            let z = C::new(a * rng.normal(), a * rng.normal());
            buf[k] = z;
            buf[nfft - k] = z.conj();
        }
        fft.inverse(&mut buf);
        // Scale to 12 uV standard deviation (inside the plausibility range of spec 5.2).
        let mean = buf[..n].iter().map(|v| v.re).sum::<f64>() / n as f64;
        let sd = m::sqrt(buf[..n].iter().map(|v| (v.re - mean) * (v.re - mean)).sum::<f64>() / n as f64);
        for v in buf.iter_mut() {
            v.re = (v.re - mean) / sd * 12.0;
        }
        chans.push(buf);
    }
    let mut out = Vec::with_capacity(n * 4);
    for i in 0..n {
        for c in &chans {
            out.push(c[i].re as f32);
        }
    }
    out
}

/// Digest of all frames for a synthetic session of `secs` seconds.
pub fn digest(seed: u64, secs: u32) -> u64 {
    run(seed, secs, |_| {})
}

/// Run the self-check session and hand each frame to `visit`; returns the digest.
pub fn run(seed: u64, secs: u32, mut visit: impl FnMut(&crate::Frame)) -> u64 {
    let cfg = EngineConfig {
        streams: StreamDescription {
            eeg: Some(EegStream { channels: ["TP9", "AF7", "AF8", "TP10"].iter().map(|s| s.to_string()).collect(), rate_hz: 256.0, bits: 12, model: "selfcheck".into() }),
            ..Default::default()
        },
        params: None,
        seed,
        mains_hz: None,
    };
    let mut e = Engine::new(cfg).expect("selfcheck config");
    let data = session(seed, secs);
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let per = 12 * 4;
    let mut idx = 0u64;
    for chunk in data.chunks(per) {
        e.push_eeg(idx, chunk);
        idx += (chunk.len() / 4) as u64;
        for f in e.drain() {
            visit(&f);
            let s = serde_json::to_string(&f).expect("serialize");
            fnv1a(&mut h, s.as_bytes());
            fnv1a(&mut h, b"\n");
        }
    }
    h
}
