//! Special functions for the chi-squared law used in peak confirmation (spec 6.1, 6.3).

use crate::m;

fn gser(a: f64, x: f64) -> f64 {
    let gln = m::lgamma(a);
    let mut ap = a;
    let mut del = 1.0 / a;
    let mut sum = del;
    for _ in 0..10_000 {
        ap += 1.0;
        del *= x / ap;
        sum += del;
        if del.abs() < sum.abs() * 1e-16 {
            break;
        }
    }
    sum * m::exp(-x + a * m::ln(x) - gln)
}

fn gcf(a: f64, x: f64) -> f64 {
    let gln = m::lgamma(a);
    let fpmin = 1e-300;
    let mut b = x + 1.0 - a;
    let mut c = 1.0 / fpmin;
    let mut d = 1.0 / b;
    let mut h = d;
    for i in 1..10_000 {
        let an = -(i as f64) * (i as f64 - a);
        b += 2.0;
        d = an * d + b;
        if d.abs() < fpmin {
            d = fpmin;
        }
        c = b + an / c;
        if c.abs() < fpmin {
            c = fpmin;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < 1e-16 {
            break;
        }
    }
    m::exp(-x + a * m::ln(x) - gln) * h
}

/// Regularized upper incomplete gamma Q(a, x).
pub fn gammq(a: f64, x: f64) -> f64 {
    if x <= 0.0 {
        1.0
    } else if x < a + 1.0 {
        1.0 - gser(a, x)
    } else {
        gcf(a, x)
    }
}

/// Survival function of the chi-squared law with `dof` degrees of freedom.
pub fn chi2_sf(x: f64, dof: f64) -> f64 {
    gammq(dof / 2.0, x / 2.0)
}

/// Inverse survival function: the x with P(chi2_dof > x) = p.
pub fn chi2_isf(p: f64, dof: f64) -> f64 {
    let p = p.clamp(1e-300, 1.0);
    let mut lo = 0.0;
    let mut hi = dof.max(1.0);
    while chi2_sf(hi, dof) > p {
        hi *= 2.0;
        if hi > 1e8 {
            break;
        }
    }
    for _ in 0..300 {
        let mid = 0.5 * (lo + hi);
        if chi2_sf(mid, dof) > p {
            lo = mid;
        } else {
            hi = mid;
        }
        if hi - lo <= 1e-13 * hi {
            break;
        }
    }
    0.5 * (lo + hi)
}

/// Trigamma function psi'(x) for x > 0.
pub fn trigamma(mut x: f64) -> f64 {
    let mut r = 0.0;
    while x < 10.0 {
        r += 1.0 / (x * x);
        x += 1.0;
    }
    let x2 = 1.0 / (x * x);
    r + 1.0 / x + x2 / 2.0 + (1.0 / 6.0 - x2 * (1.0 / 30.0 - x2 * (1.0 / 42.0 - x2 / 30.0))) / (x * x * x)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_values() {
        // chi2 with 2 dof: sf(x) = exp(-x/2).
        assert!((chi2_sf(3.0, 2.0) - m::exp(-1.5)).abs() < 1e-12);
        let x = chi2_isf(0.05, 14.0);
        assert!((x - 23.6848).abs() < 1e-3, "{x}");
        let x = chi2_isf(1e-5, 14.0);
        assert!((chi2_sf(x, 14.0) - 1e-5).abs() < 1e-10);
        // trigamma(1) = pi^2/6
        assert!((trigamma(1.0) - m::PI * m::PI / 6.0).abs() < 1e-10);
    }
}
