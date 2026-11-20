//! A small deterministic PRNG: xoshiro256** (Blackman and Vigna), seeded through
//! splitmix64. Used only for surrogates (spec rule 6). Streams are derived from the
//! session seed plus a stream label, so the numbers do not depend on how input was chunked.

use crate::m;

#[derive(Clone, Debug)]
pub struct Rng {
    s: [u64; 4],
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut st = seed;
        let mut s = [0u64; 4];
        for v in s.iter_mut() {
            *v = splitmix64(&mut st);
        }
        if s == [0; 4] {
            s[0] = 1;
        }
        Rng { s }
    }

    /// A generator for one purpose at one moment: seed, stream label and counter mixed.
    pub fn derive(seed: u64, stream: u64, counter: u64) -> Self {
        let mut st = seed ^ stream.wrapping_mul(0xD6E8_FEB8_6659_FD93);
        let a = splitmix64(&mut st);
        let mut st2 = a ^ counter.wrapping_mul(0xA076_1D64_78BD_642F);
        Rng::new(splitmix64(&mut st2))
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }

    /// Uniform in [0, 1).
    #[inline]
    pub fn f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    pub fn uniform(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.f64()
    }

    /// Uniform integer in [lo, hi] inclusive.
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            return lo;
        }
        let span = hi - lo + 1;
        lo + ((self.next_u64() as u128 * span as u128) >> 64) as u64
    }

    /// Standard normal by Box-Muller (one value per call; deterministic).
    pub fn normal(&mut self) -> f64 {
        let mut u1 = self.f64();
        if u1 <= 0.0 {
            u1 = f64::MIN_POSITIVE;
        }
        let u2 = self.f64();
        m::sqrt(-2.0 * m::ln(u1)) * m::cos(m::TAU * u2)
    }
}
