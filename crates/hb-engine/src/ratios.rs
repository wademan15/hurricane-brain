//! Ratio alignment, cascades, chance levels and the aligned state (spec 8).
//!
//! `score_set` is the one scoring function. The observed tracks and every surrogate set go
//! through it unchanged, so every "best of several" choice is paid for in the null (rule 5).

use crate::m;
use crate::params::Params;
use crate::prng::Rng;
use crate::types::{CascadeTarget, ChanceLevel, Measured, Reason, Target};
use std::collections::{BTreeMap, BTreeSet};

/// A track as the scorer sees it: id, integrated frequency and its standard error.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScoreTrack {
    pub id: u32,
    pub f: f64,
    pub se: f64,
}

/// The person's baseline density of a pair's log ratio (spec 8.4, T3): mean and variance.
pub type Baselines = BTreeMap<(u32, u32), (f64, f64)>;

/// What the scorer needs besides the tracks.
pub struct ScoreCtx<'a> {
    pub p: &'a Params,
    /// ln of each target ratio, in `Target::ALL` order.
    pub ln_t: [f64; 4],
    /// Unordered id pairs flagged harmonic.
    pub harmonic: &'a BTreeSet<(u32, u32)>,
    pub baselines: &'a Baselines,
    /// ln(hi / lo) of the peak search range: support of the unrelated-peaks density.
    pub ln_range: f64,
}

impl<'a> ScoreCtx<'a> {
    pub fn new(p: &'a Params, harmonic: &'a BTreeSet<(u32, u32)>, baselines: &'a Baselines) -> Self {
        let phi = (1.0 + m::sqrt(5.0)) / 2.0;
        ScoreCtx {
            p,
            ln_t: [m::ln(phi), m::ln(2.0), m::ln(p.control_ratio_a), m::ln(p.control_ratio_b)],
            harmonic,
            baselines,
            ln_range: m::ln(p.peak_search_hi_hz / p.peak_search_lo_hz),
        }
    }

    fn key(a: u32, b: u32) -> (u32, u32) {
        if a < b {
            (a, b)
        } else {
            (b, a)
        }
    }

    pub fn is_harmonic(&self, a: u32, b: u32) -> bool {
        self.harmonic.contains(&Self::key(a, b))
    }

    /// ln q(x): density of x if the pair were just "this person's usual spread". Without a
    /// baseline for the pair, the density of two unrelated peaks placed log-uniformly in the
    /// search range (triangular on [0, L]).
    fn ln_q(&self, a: u32, b: u32, x: f64, sx2: f64) -> f64 {
        let l = self.ln_range;
        let tri = (2.0 * (l - x).max(l * 1e-3) / (l * l)).max(1e-12);
        match self.baselines.get(&Self::key(a, b)) {
            Some(&(mu, var)) => {
                let v = var + sx2;
                let g = m::exp(-0.5 * (x - mu) * (x - mu) / v) / m::sqrt(m::TAU * v);
                let w = self.p.baseline_mix.clamp(0.0, 1.0);
                m::ln((1.0 - w) * g + w * tri)
            }
            None => m::ln(tri),
        }
    }

    fn log_evidence_raw(&self, a: u32, b: u32, x: f64, sx: f64, t: f64) -> f64 {
        let v = sx * sx + self.p.tau * self.p.tau;
        let ln_n = -0.5 * m::ln(m::TAU * v) - 0.5 * (x - t) * (x - t) / v;
        ln_n - self.ln_q(a, b, x, sx * sx)
    }

    /// ln Lambda = ln N(x; t, s_x^2 + tau^2) - ln q(x), made non-increasing in s_x.
    ///
    /// The Gaussian likelihood alone rises with s_x when the miss exceeds sqrt(s_x^2 + tau^2),
    /// which would let a vaguer measurement score better. Taking the smaller of the value at
    /// s_x and at s_x = 0 removes that: uncertainty never makes alignment easier (spec 8.2).
    /// For the unrelated-peaks density q this is exactly monotone, because ln N is unimodal in
    /// the variance.
    pub fn log_evidence(&self, a: u32, b: u32, x: f64, sx: f64, t: f64) -> f64 {
        self.log_evidence_raw(a, b, x, sx, t).min(self.log_evidence_raw(a, b, x, 0.0, t))
    }
}

/// One pair's scores.
#[derive(Clone, Debug, PartialEq)]
pub struct PairResult {
    pub lo: usize,
    pub hi: usize,
    pub x: f64,
    pub sx: f64,
    pub resolved: bool,
    pub harmonic: bool,
    /// Per target (Target::ALL order): miss, closeness, log evidence (None if unresolved), aligned.
    pub miss: [f64; 4],
    pub closeness: [Option<f64>; 4],
    pub log_ev: [Option<f64>; 4],
    pub aligned: [bool; 4],
}

/// The best cascade for one target.
#[derive(Clone, Debug, PartialEq)]
pub struct CascadeResult {
    /// Member indices into the sorted track list, lowest first.
    pub members: Vec<usize>,
    pub skipped: Vec<usize>,
    pub steps: usize,
    /// Mean step closeness; with no aligned step, the best closeness of any eligible pair.
    pub closeness: Result<f64, Reason>,
    pub evidence: f64,
}

/// Everything scored for one set of tracks.
#[derive(Clone, Debug, PartialEq)]
pub struct SetScore {
    pub pairs: Vec<PairResult>,
    /// Phi then octave.
    pub cascades: [CascadeResult; 2],
    /// Aligned-state statistic: the largest log evidence over eligible resolved pairs.
    pub stat: [Result<f64, Reason>; 2],
}

/// Index of a cascade target in `Target::ALL`.
pub fn cascade_index(t: CascadeTarget) -> usize {
    match t {
        CascadeTarget::Phi => 0,
        CascadeTarget::Octave => 1,
    }
}

/// Score a set of tracks. `tracks` must be sorted by frequency (ties by id).
pub fn score_set(tracks: &[ScoreTrack], ctx: &ScoreCtx) -> SetScore {
    let p = ctx.p;
    let n = tracks.len();
    let mut pairs = Vec::with_capacity(n * n.saturating_sub(1) / 2);
    for i in 0..n {
        for j in (i + 1)..n {
            let (a, b) = (&tracks[i], &tracks[j]);
            let x = m::ln(b.f / a.f);
            let ra = a.se / a.f;
            let rb = b.se / b.f;
            let sx = m::sqrt(ra * ra + rb * rb);
            let resolved = sx <= p.resolved_max_sx;
            let harmonic = ctx.is_harmonic(a.id, b.id);
            let excluded = harmonic && p.exclude_harmonics;
            let mut pr = PairResult { lo: i, hi: j, x, sx, resolved, harmonic, miss: [0.0; 4], closeness: [None; 4], log_ev: [None; 4], aligned: [false; 4] };
            for (ti, t) in ctx.ln_t.iter().enumerate() {
                let miss = x - t;
                pr.miss[ti] = miss;
                if resolved {
                    let c = m::exp(-0.5 * (miss / p.tolerance) * (miss / p.tolerance));
                    pr.closeness[ti] = Some(c);
                    pr.log_ev[ti] = Some(ctx.log_evidence(a.id, b.id, x, sx, *t));
                    pr.aligned[ti] = !excluded && miss.abs() <= p.tolerance;
                }
            }
            pairs.push(pr);
        }
    }
    let cascades = [cascade(n, &pairs, 0, ctx), cascade(n, &pairs, 1, ctx)];
    let stat = [stat_for(n, &pairs, 0, ctx), stat_for(n, &pairs, 1, ctx)];
    SetScore { pairs, cascades, stat }
}

fn eligible(pr: &PairResult, ctx: &ScoreCtx) -> bool {
    pr.resolved && !(pr.harmonic && ctx.p.exclude_harmonics)
}

fn stat_for(n: usize, pairs: &[PairResult], ti: usize, ctx: &ScoreCtx) -> Result<f64, Reason> {
    if n < 2 {
        return Err(Reason::NotConfirmed);
    }
    let mut best: Option<f64> = None;
    for pr in pairs {
        if eligible(pr, ctx) {
            if let Some(e) = pr.log_ev[ti] {
                best = Some(best.map_or(e, |b: f64| b.max(e)));
            }
        }
    }
    best.ok_or(Reason::Unresolved)
}

/// Longest chain of aligned steps (spec 8.3), ties broken by total log evidence, then by
/// the lowest member indices. A chain may skip tracks between members.
fn cascade(n: usize, pairs: &[PairResult], ti: usize, ctx: &ScoreCtx) -> CascadeResult {
    let none = |why| CascadeResult { members: Vec::new(), skipped: Vec::new(), steps: 0, closeness: Err(why), evidence: 0.0 };
    if n < 2 {
        return none(Reason::NotConfirmed);
    }
    let idx = |i: usize, j: usize| -> usize {
        // index of pair (i, j), i < j, in row-major upper-triangle order
        i * (2 * n - i - 1) / 2 + (j - i - 1)
    };
    // best[j] = (steps, evidence, prev)
    let mut best: Vec<(usize, f64, Option<usize>)> = vec![(0, 0.0, None); n];
    for j in 0..n {
        for i in 0..j {
            let pr = &pairs[idx(i, j)];
            if !pr.aligned[ti] {
                continue;
            }
            let ev = pr.log_ev[ti].unwrap_or(0.0);
            let cand = (best[i].0 + 1, best[i].1 + ev);
            let cur = best[j];
            if cand.0 > cur.0 || (cand.0 == cur.0 && cand.0 > 0 && cand.1 > cur.1) {
                best[j] = (cand.0, cand.1, Some(i));
            }
        }
    }
    let mut end = 0;
    for j in 1..n {
        if best[j].0 > best[end].0 || (best[j].0 == best[end].0 && best[j].1 > best[end].1) {
            end = j;
        }
    }
    if best[end].0 == 0 {
        // No aligned step: closeness of the best eligible pair, so that the value is
        // continuous as a pair approaches the tolerance.
        let mut c: Option<f64> = None;
        let mut any_pair = false;
        for pr in pairs {
            if pr.harmonic && ctx.p.exclude_harmonics {
                continue;
            }
            any_pair = true;
            if let Some(v) = pr.closeness[ti] {
                c = Some(c.map_or(v, |b: f64| b.max(v)));
            }
        }
        return CascadeResult {
            members: Vec::new(),
            skipped: Vec::new(),
            steps: 0,
            closeness: c.ok_or(if any_pair { Reason::Unresolved } else { Reason::NotConfirmed }),
            evidence: 0.0,
        };
    }
    let mut members = vec![end];
    let mut cur = end;
    while let Some(pv) = best[cur].2 {
        members.push(pv);
        cur = pv;
    }
    members.reverse();
    let mut skipped = Vec::new();
    let mut csum = 0.0;
    for w in members.windows(2) {
        for s in (w[0] + 1)..w[1] {
            skipped.push(s);
        }
        csum += pairs[idx(w[0], w[1])].closeness[ti].unwrap_or(0.0);
    }
    let steps = members.len() - 1;
    CascadeResult { members, skipped, steps, closeness: Ok(csum / steps as f64), evidence: best[end].1 }
}

/// The per-surrogate summary kept for chance levels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NullDraw {
    pub steps: usize,
    pub closeness: Option<f64>,
    pub stat: Option<f64>,
}

/// A chance distribution for one target.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NullDist {
    pub draws: Vec<NullDraw>,
}

impl NullDist {
    /// Expected closeness, p-value and p_steps for an observed cascade (spec 8.5).
    pub fn level(&self, steps: usize, closeness: Option<f64>) -> ChanceLevel {
        let cs: Vec<f64> = self.draws.iter().filter_map(|d| d.closeness).collect();
        if cs.len() * 2 < self.draws.len() || cs.is_empty() {
            return ChanceLevel::null(Reason::NotAvailable);
        }
        let n = cs.len() as f64;
        let mean = cs.iter().sum::<f64>() / n;
        let var = cs.iter().map(|c| (c - mean) * (c - mean)).sum::<f64>() / (n - 1.0).max(1.0);
        let total = self.draws.len() as f64;
        let p = match closeness {
            Some(c) => {
                let k = self.draws.iter().filter(|d| d.steps > steps || (d.steps == steps && d.closeness.is_some_and(|x| x >= c))).count();
                Measured::ok((1.0 + k as f64) / (1.0 + total))
            }
            None => Measured::null(Reason::Unresolved),
        };
        let ks = self.draws.iter().filter(|d| d.steps >= steps).count();
        ChanceLevel { closeness: Measured::with_se(mean, m::sqrt(var / n)), p, p_steps: Measured::ok((1.0 + ks as f64) / (1.0 + total)) }
    }

    pub fn mean_closeness(&self) -> Option<f64> {
        let cs: Vec<f64> = self.draws.iter().filter_map(|d| d.closeness).collect();
        if cs.is_empty() || cs.len() * 2 < self.draws.len() {
            None
        } else {
            Some(cs.iter().sum::<f64>() / cs.len() as f64)
        }
    }
}

fn sort_tracks(v: &mut [ScoreTrack]) {
    v.sort_by(|a, b| a.f.total_cmp(&b.f).then(a.id.cmp(&b.id)));
}

fn draw_of(s: &SetScore, ti: usize) -> NullDraw {
    NullDraw { steps: s.cascades[ti].steps, closeness: s.cascades[ti].closeness.ok(), stat: s.stat[ti].ok() }
}

/// Chance A (spec 8.5): the same number of tracks placed at random in log frequency across
/// the search range, each keeping one real track's relative uncertainty and identity, scored
/// by `score_set`. Returns [phi, octave] distributions.
pub fn chance_a(tracks: &[ScoreTrack], ctx: &ScoreCtx, rng: &mut Rng) -> [NullDist; 2] {
    let p = ctx.p;
    let (llo, lhi) = (m::ln(p.peak_search_lo_hz), m::ln(p.peak_search_hi_hz));
    let mut out = [NullDist::default(), NullDist::default()];
    let mut sur = tracks.to_vec();
    for _ in 0..p.surrogates {
        for (s, t) in sur.iter_mut().zip(tracks.iter()) {
            let f = m::exp(rng.uniform(llo, lhi));
            *s = ScoreTrack { id: t.id, f, se: t.se / t.f * f };
        }
        sort_tracks(&mut sur);
        let sc = score_set(&sur, ctx);
        out[0].draws.push(draw_of(&sc, 0));
        out[1].draws.push(draw_of(&sc, 1));
    }
    out
}

/// A track's integrated-frequency history, one entry per slow update, oldest first.
#[derive(Clone, Debug)]
pub struct History<'a> {
    pub id: u32,
    pub f: &'a [f64],
    pub se: &'a [f64],
}

/// The result of chance B: snapshot distributions and, per target, the false-alarm
/// threshold from the time-shifted series with dwell and hysteresis applied.
pub struct ChanceB {
    pub dists: [NullDist; 2],
    pub thresholds: [Option<f64>; 2],
}

/// Chance B (spec 8.5): each track's own history shifted by an independent random lag of at
/// least `min_lag` updates, wrapping within that track's history. All histories must hold at
/// least `need` updates. `step` is the time-series sampling (in updates) for the false-alarm
/// threshold, `span` its length in updates, `dwell` the dwell in series steps.
#[allow(clippy::too_many_arguments)]
pub fn chance_b(hist: &[History], ctx: &ScoreCtx, rng: &mut Rng, min_lag: usize, step: usize, span: usize, dwell_steps: usize, step_s: f64) -> ChanceB {
    let p = ctx.p;
    let n = hist.len();
    let mut dists = [NullDist::default(), NullDist::default()];
    let npts = (span / step.max(1)).max(1);
    let mut series: [Vec<Vec<Option<f64>>>; 2] = [Vec::new(), Vec::new()];
    let mut set = vec![ScoreTrack { id: 0, f: 1.0, se: 0.0 }; n];
    for _ in 0..p.surrogates {
        let lags: Vec<usize> = hist
            .iter()
            .map(|h| {
                let len = h.f.len();
                rng.range(min_lag as u64, (len - min_lag) as u64) as usize
            })
            .collect();
        let at = |back: usize, set: &mut Vec<ScoreTrack>| {
            for (k, h) in hist.iter().enumerate() {
                let len = h.f.len();
                let idx = (len - 1 + 2 * len - (back % len) - lags[k]) % len;
                set[k] = ScoreTrack { id: h.id, f: h.f[idx], se: h.se[idx] };
            }
            sort_tracks(set);
        };
        at(0, &mut set);
        let sc = score_set(&set, ctx);
        dists[0].draws.push(draw_of(&sc, 0));
        dists[1].draws.push(draw_of(&sc, 1));
        let mut s0 = Vec::with_capacity(npts);
        let mut s1 = Vec::with_capacity(npts);
        for j in (0..npts).rev() {
            at(j * step, &mut set);
            let sc = score_set(&set, ctx);
            s0.push(sc.stat[0].ok());
            s1.push(sc.stat[1].ok());
        }
        series[0].push(s0);
        series[1].push(s1);
    }
    let total_s = p.surrogates as f64 * npts as f64 * step_s;
    let thresholds = [
        cfar_threshold(&series[0], dwell_steps, p.state_hysteresis, total_s, p.false_entry_interval_s),
        cfar_threshold(&series[1], dwell_steps, p.state_hysteresis, total_s, p.false_entry_interval_s),
    ];
    ChanceB { dists, thresholds }
}

/// Count state entries with dwell and hysteresis on a set of statistic series.
pub fn count_entries(series: &[Vec<Option<f64>>], enter: f64, exit: f64, dwell_steps: usize) -> usize {
    let mut entries = 0;
    for s in series {
        let mut active = false;
        let mut above = 0usize;
        for v in s {
            match (active, v) {
                (false, Some(x)) if *x >= enter => {
                    above += 1;
                    if above >= dwell_steps.max(1) {
                        active = true;
                        entries += 1;
                    }
                }
                (false, _) => above = 0,
                (true, Some(x)) if *x >= exit => {}
                (true, _) => {
                    active = false;
                    above = 0;
                }
            }
        }
    }
    entries
}

/// Lowest entry threshold whose false-entry rate on the null series, with dwell and
/// hysteresis applied exactly as in the live state machine, is at most one per `interval_s`.
pub fn cfar_threshold(series: &[Vec<Option<f64>>], dwell_steps: usize, hyst: f64, total_s: f64, interval_s: f64) -> Option<f64> {
    let mut vals: Vec<f64> = series.iter().flat_map(|s| s.iter().filter_map(|v| *v)).collect();
    if vals.is_empty() || total_s <= 0.0 {
        return None;
    }
    vals.sort_by(|a, b| a.total_cmp(b));
    let allowed = total_s / interval_s;
    let mut qs: Vec<f64> = (0..=40).map(|i| 0.5 + 0.0125 * i as f64).collect();
    qs.extend_from_slice(&[0.995, 0.999, 1.0]);
    for q in qs {
        let thr = m::quantile_sorted(&vals, q)?;
        let e = count_entries(series, thr, thr - hyst, dwell_steps);
        if (e as f64) <= allowed {
            return Some(thr);
        }
    }
    // Even the largest null value is entered too often: only values above all of them count.
    vals.last().map(|v| v + 1e-9)
}

/// Threshold from a static (snapshot) null: the (1 - p*) quantile, with p* the allowed false
/// entries per decorrelation time (the integration time).
pub fn static_threshold(d: &NullDist, p: &Params) -> Option<f64> {
    let mut v: Vec<f64> = d.draws.iter().map(|x| x.stat.unwrap_or(f64::NEG_INFINITY)).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let pstar = (p.integration_s / p.false_entry_interval_s).clamp(1e-6, 1.0);
    let t = m::quantile_sorted(&v, 1.0 - pstar)?;
    // If the quantile falls on surrogates with no eligible pair, there is no usable
    // threshold and the state cannot be entered (the conservative choice).
    if t.is_finite() {
        Some(t)
    } else {
        None
    }
}

/// Aligned-state machine (spec 8.4): dwell before entry, hysteresis on exit.
#[derive(Clone, Debug, PartialEq)]
pub struct StateMachine {
    pub active: bool,
    pub since_t: Option<f64>,
    above_since: Option<f64>,
}

impl Default for StateMachine {
    fn default() -> Self {
        StateMachine { active: false, since_t: None, above_since: None }
    }
}

impl StateMachine {
    pub fn update(&mut self, t: f64, stat: Option<f64>, enter: Option<f64>, exit: Option<f64>, dwell_s: f64) {
        if self.since_t.is_none() {
            self.since_t = Some(t);
        }
        let was = self.active;
        match (stat, enter, exit) {
            (Some(s), Some(en), Some(ex)) => {
                if self.active {
                    if s < ex {
                        self.active = false;
                        self.above_since = None;
                    }
                } else if s >= en {
                    let since = *self.above_since.get_or_insert(t);
                    if t - since >= dwell_s {
                        self.active = true;
                    }
                } else {
                    self.above_since = None;
                }
            }
            _ => {
                self.active = false;
                self.above_since = None;
            }
        }
        if was != self.active {
            self.since_t = Some(t);
        }
    }
}

/// Map a `Target` to its index.
pub fn target_index(t: Target) -> usize {
    match t {
        Target::Phi => 0,
        Target::Octave => 1,
        Target::Control15 => 2,
        Target::Control18 => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn phi_cascade_found_and_not_octave() {
        let p = Params::default();
        let h = BTreeSet::new();
        let b = Baselines::new();
        let ctx = ScoreCtx::new(&p, &h, &b);
        let phi = (1.0 + 5f64.sqrt()) / 2.0;
        let t = [
            ScoreTrack { id: 1, f: 10.0 / phi, se: 0.02 },
            ScoreTrack { id: 2, f: 8.0, se: 0.02 },
            ScoreTrack { id: 3, f: 10.0, se: 0.02 },
            ScoreTrack { id: 4, f: 10.0 * phi, se: 0.02 },
        ];
        let s = score_set(&t, &ctx);
        assert_eq!(s.cascades[0].steps, 2);
        assert_eq!(s.cascades[0].members, vec![0, 2, 3]);
        assert_eq!(s.cascades[0].skipped, vec![1]);
        assert_eq!(s.cascades[1].steps, 0);
    }

    #[test]
    fn uncertainty_never_helps() {
        let p = Params::default();
        let h = BTreeSet::new();
        let b = Baselines::new();
        let ctx = ScoreCtx::new(&p, &h, &b);
        let x = m::ln(1.6);
        let t = ctx.ln_t[0];
        let mut prev = f64::INFINITY;
        for k in 0..30 {
            let sx = 0.001 * k as f64;
            let e = ctx.log_evidence(1, 2, x, sx, t);
            assert!(e <= prev + 1e-12);
            prev = e;
        }
    }
}
