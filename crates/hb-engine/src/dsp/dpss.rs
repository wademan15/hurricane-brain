//! Discrete prolate spheroidal sequences (Slepian tapers), computed in-crate.
//!
//! The tapers are the eigenvectors with the largest eigenvalues of the symmetric
//! tridiagonal matrix that commutes with the concentration operator (Slepian 1978; Percival
//! and Walden 1993, section 8.3):
//!   diag[i]    = ((N - 1 - 2i) / 2)^2 cos(2 pi W)
//!   offdiag[i] = (i + 1)(N - 1 - i) / 2
//! with W the half-bandwidth in cycles per sample. Eigenvalues come from Sturm-sequence
//! bisection and eigenvectors from inverse iteration, both O(N) per step, so tapers for
//! every stretch length the engine uses can be computed at start-up.

use crate::m;

/// Number of eigenvalues of the tridiagonal (d, e) strictly less than x.
fn sturm_count(d: &[f64], e: &[f64], x: f64) -> usize {
    let mut count = 0;
    let mut q = d[0] - x;
    if q < 0.0 {
        count += 1;
    }
    for i in 1..d.len() {
        let qq = if q == 0.0 { 1e-300 } else { q };
        q = d[i] - x - e[i - 1] * e[i - 1] / qq;
        if q < 0.0 {
            count += 1;
        }
    }
    count
}

/// Solve (T - lambda I) x = b by Gaussian elimination with partial pivoting on a
/// tridiagonal system (stable near singularity, which is the point of inverse iteration).
fn tri_solve_shifted(d: &[f64], e: &[f64], lambda: f64, b: &[f64]) -> Vec<f64> {
    let n = d.len();
    // Rows held as three bands plus one fill-in band from pivoting.
    let mut a0 = vec![0.0; n]; // main
    let mut a1 = vec![0.0; n]; // first super
    let mut a2 = vec![0.0; n]; // second super (fill)
    let mut sub = vec![0.0; n]; // sub of row i (element (i, i-1))
    for i in 0..n {
        a0[i] = d[i] - lambda;
        if i + 1 < n {
            a1[i] = e[i];
        }
        if i > 0 {
            sub[i] = e[i - 1];
        }
    }
    let mut rhs = b.to_vec();
    for i in 0..n.saturating_sub(1) {
        // Eliminate sub[i+1] using row i or swap rows i and i+1.
        if sub[i + 1].abs() > a0[i].abs() {
            // swap row i and i+1 (row i+1 has entries sub, a0, a1 at cols i, i+1, i+2)
            let (r0, r1, r2) = (a0[i], a1[i], a2[i]);
            a0[i] = sub[i + 1];
            a1[i] = a0[i + 1];
            a2[i] = a1[i + 1];
            sub[i + 1] = r0;
            a0[i + 1] = r1;
            a1[i + 1] = r2;
            a2[i + 1] = 0.0;
            rhs.swap(i, i + 1);
        }
        let piv = if a0[i] == 0.0 { 1e-300 } else { a0[i] };
        let f = sub[i + 1] / piv;
        a0[i + 1] -= f * a1[i];
        a1[i + 1] -= f * a2[i];
        rhs[i + 1] -= f * rhs[i];
        sub[i + 1] = 0.0;
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let mut s = rhs[i];
        if i + 1 < n {
            s -= a1[i] * x[i + 1];
        }
        if i + 2 < n {
            s -= a2[i] * x[i + 2];
        }
        let piv = if a0[i] == 0.0 { 1e-300 } else { a0[i] };
        x[i] = s / piv;
    }
    x
}

fn normalize(x: &mut [f64]) {
    let s = m::sqrt(x.iter().map(|v| v * v).sum::<f64>());
    if s > 0.0 {
        for v in x.iter_mut() {
            *v /= s;
        }
    }
}

/// The first `k` DPSS tapers of length `n` with time-half-bandwidth product `nw`,
/// each normalized to unit energy. Sign convention: each taper's sum (even order) or
/// first moment (odd order) is positive.
pub fn dpss(n: usize, nw: f64, k: usize) -> Vec<Vec<f64>> {
    assert!(n >= 2 && k >= 1 && k <= n);
    let w = nw / n as f64;
    let c = m::cos(m::TAU * w);
    let d: Vec<f64> = (0..n)
        .map(|i| {
            let a = (n as f64 - 1.0 - 2.0 * i as f64) / 2.0;
            a * a * c
        })
        .collect();
    let e: Vec<f64> = (0..n - 1).map(|i| (i as f64 + 1.0) * (n as f64 - 1.0 - i as f64) / 2.0).collect();
    // Gershgorin bounds.
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for i in 0..n {
        let r = if i > 0 { e[i - 1].abs() } else { 0.0 } + if i + 1 < n { e[i].abs() } else { 0.0 };
        lo = lo.min(d[i] - r);
        hi = hi.max(d[i] + r);
    }
    let mut out = Vec::with_capacity(k);
    for j in 0..k {
        // j-th largest eigenvalue = ascending index n-1-j.
        let target = n - 1 - j;
        let (mut a, mut b) = (lo, hi);
        for _ in 0..200 {
            let mid = 0.5 * (a + b);
            if sturm_count(&d, &e, mid) > target {
                b = mid;
            } else {
                a = mid;
            }
            if (b - a) <= 1e-14 * (a.abs() + b.abs()).max(1.0) {
                break;
            }
        }
        let lambda = 0.5 * (a + b);
        // Inverse iteration from a deterministic, generic start vector.
        let mut x: Vec<f64> = (0..n).map(|i| 1.0 + 0.1 * m::sin(0.7 * i as f64 + j as f64)).collect();
        let shift = lambda + 1e-10 * lambda.abs().max(1.0);
        for _ in 0..4 {
            x = tri_solve_shifted(&d, &e, shift, &x);
            // Re-orthogonalize against previous tapers (eigenvalues are well separated,
            // this only removes round-off).
            for prev in &out {
                let p: &Vec<f64> = prev;
                let dot: f64 = x.iter().zip(p.iter()).map(|(a, b)| a * b).sum();
                for (xi, pi) in x.iter_mut().zip(p.iter()) {
                    *xi -= dot * pi;
                }
            }
            normalize(&mut x);
        }
        let s: f64 = if j % 2 == 0 {
            x.iter().sum()
        } else {
            x.iter().enumerate().map(|(i, v)| (i as f64 - (n as f64 - 1.0) / 2.0) * v).sum()
        };
        if s < 0.0 {
            for v in x.iter_mut() {
                *v = -*v;
            }
        }
        out.push(x);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn orthonormal_and_concentrated() {
        let n = 512;
        let nw = 4.0;
        let t = dpss(n, nw, 7);
        for i in 0..7 {
            for j in 0..7 {
                let dot: f64 = t[i].iter().zip(t[j].iter()).map(|(a, b)| a * b).sum();
                let want = if i == j { 1.0 } else { 0.0 };
                assert!((dot - want).abs() < 1e-8, "{i} {j} {dot}");
            }
        }
        // First taper: concentration ratio near 1 (energy within |f| < W).
        let w = nw / n as f64;
        let nf = 8192;
        let mut inband = 0.0;
        let mut total = 0.0;
        for k in 0..nf {
            let f = (k as f64 / nf as f64) - 0.5;
            let (mut re, mut im) = (0.0, 0.0);
            for (i, v) in t[0].iter().enumerate() {
                re += v * m::cos(m::TAU * f * i as f64);
                im -= v * m::sin(m::TAU * f * i as f64);
            }
            let p = re * re + im * im;
            total += p;
            if f.abs() < w {
                inband += p;
            }
        }
        assert!(inband / total > 0.999, "{}", inband / total);
    }
}
