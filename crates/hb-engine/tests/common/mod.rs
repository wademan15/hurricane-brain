//! Seeded synthetic EEG for the engine tests: 1/f^chi background plus narrow-band Gaussian
//! rhythms, synthesized in the frequency domain (the same construction as
//! lab/precision_and_chance_sketch.py), so each rhythm is a realistic stationary narrow-band
//! process that waxes and wanes.
#![allow(dead_code)]

use hb_engine::dsp::fft::{next_pow2, Fft, C};
use hb_engine::m;
use hb_engine::prng::Rng;
use hb_engine::types::*;
use hb_engine::Engine;
use std::collections::BTreeMap;

pub const RATE: f64 = 256.0;
pub const CHANNELS: [&str; 4] = ["TP9", "AF7", "AF8", "TP10"];

#[derive(Clone, Copy, Debug)]
pub struct Rhythm {
    pub f: f64,
    /// Standard deviation of the Gaussian spectral shape, Hz.
    pub bw: f64,
    /// Peak spectral density over the background at f, dB.
    pub snr_db: f64,
}

/// One channel: `n` samples, background exponent `chi`, rhythms, scaled to `sd_uv`.
pub fn synth(n: usize, chi: f64, rhythms: &[Rhythm], sd_uv: f64, rng: &mut Rng) -> Vec<f64> {
    let nfft = next_pow2(n);
    let fft = Fft::new(nfft);
    let mut buf = vec![C::default(); nfft];
    for k in 1..nfft / 2 {
        let f = k as f64 * RATE / nfft as f64;
        let fb = f.max(0.5);
        let bg = if chi == 0.0 { 1.0 } else { m::pow(fb, -chi) };
        let mut pk = 0.0;
        for r in rhythms {
            let base = if chi == 0.0 { 1.0 } else { m::pow(r.f, -chi) };
            pk += (m::pow(10.0, r.snr_db / 10.0) - 1.0) * base * m::exp(-0.5 * ((f - r.f) / r.bw) * ((f - r.f) / r.bw));
        }
        let a = m::sqrt(bg + pk);
        let z = C::new(a * rng.normal(), a * rng.normal());
        buf[k] = z;
        buf[nfft - k] = z.conj();
    }
    fft.inverse(&mut buf);
    let x: Vec<f64> = buf[..n].iter().map(|v| v.re).collect();
    scale_to(x, sd_uv)
}

pub fn scale_to(x: Vec<f64>, sd_uv: f64) -> Vec<f64> {
    let n = x.len() as f64;
    let mean = x.iter().sum::<f64>() / n;
    let sd = m::sqrt(x.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / n);
    x.iter().map(|v| (v - mean) / sd * sd_uv).collect()
}

/// Four channels with independent background and independent realizations of the same rhythms.
pub fn four(n: usize, chi: f64, rhythms: &[Rhythm], sd_uv: f64, seed: u64) -> Vec<Vec<f64>> {
    let mut rng = Rng::new(seed);
    (0..4).map(|_| synth(n, chi, rhythms, sd_uv, &mut rng)).collect()
}

pub fn config(seed: u64, params: &[(&str, ParamValue)]) -> EngineConfig {
    let mut pm = BTreeMap::new();
    for (k, v) in params {
        pm.insert(k.to_string(), v.clone());
    }
    EngineConfig {
        streams: StreamDescription {
            eeg: Some(EegStream { channels: CHANNELS.iter().map(|s| s.to_string()).collect(), rate_hz: RATE, bits: 12, model: "synthetic".into() }),
            ..Default::default()
        },
        params: if pm.is_empty() { None } else { Some(pm) },
        seed,
        mains_hz: Some(50),
    }
}

pub fn interleave(ch: &[Vec<f64>]) -> Vec<f32> {
    let n = ch[0].len();
    let mut out = Vec::with_capacity(n * ch.len());
    for i in 0..n {
        for c in ch {
            out.push(c[i] as f32);
        }
    }
    out
}

/// Run the engine over interleaved samples in chunks of `chunk` samples per channel.
pub fn run_engine(e: &mut Engine, data: &[f32], nch: usize, chunk: usize) -> Vec<Frame> {
    let n = data.len() / nch;
    let mut frames = Vec::new();
    let mut i = 0;
    while i < n {
        let k = chunk.min(n - i);
        e.push_eeg(i as u64, &data[i * nch..(i + k) * nch]);
        frames.extend(e.drain());
        i += k;
    }
    frames
}

pub fn run(ch: &[Vec<f64>], seed: u64, params: &[(&str, ParamValue)]) -> (Vec<Frame>, Engine) {
    let mut e = Engine::new(config(seed, params)).expect("engine");
    let data = interleave(ch);
    let f = run_engine(&mut e, &data, ch.len(), 12);
    (f, e)
}

pub fn slow(frames: &[Frame]) -> Vec<&SlowFrame> {
    frames.iter().filter_map(|f| if let Frame::Slow(s) = f { Some(&**s) } else { None }).collect()
}

pub fn fast(frames: &[Frame]) -> Vec<&FastFrame> {
    frames.iter().filter_map(|f| if let Frame::Fast(s) = f { Some(s) } else { None }).collect()
}

pub fn to_jsonl(frames: &[Frame]) -> String {
    let mut s = String::new();
    for f in frames {
        s.push_str(&serde_json::to_string(f).unwrap());
        s.push('\n');
    }
    s
}

pub fn track_near<'a>(sf: &'a SlowFrame, f: f64, tol: f64) -> Option<&'a Track> {
    sf.tracks.iter().find(|t| t.freq_integrated.v.is_some_and(|v| (v - f).abs() <= tol))
}

pub fn phi() -> f64 {
    (1.0 + 5f64.sqrt()) / 2.0
}
