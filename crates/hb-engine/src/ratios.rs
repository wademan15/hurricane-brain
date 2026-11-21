//! Ratio alignment, cascades, chance levels and the aligned state (spec 8).
//!
//! `score_set` is the one scoring function. The observed tracks and every surrogate set go
//! through it unchanged, so every "best of several" choice is paid for in the null (rule 5).

use crate::m;
use crate::params::Params;
use crate::dsp::special::{binom_cdf, poisson_cdf};
use crate::prng::Rng;
use crate::types::{CascadeTarget, ChanceLevel, Measured, Reason, Target};
use std::collections::{BTreeMap, BTreeSet};

/// Number of scored targets (`Target::ALL`).
pub const NT: usize = 5;

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
    pub ln_t: [f64; NT],
    /// Unordered id pairs flagged harmonic.
    pub harmonic: &'a BTreeSet<(u32, u32)>,
    pub baselines: &'a Baselines,
    /// ln(hi / lo) of the peak search range: support of the unrelated-peaks density.
    pub ln_range: f64,
    /// Chance A placement ranges (Hz), ascending and contiguous: a surrogate peak is placed
    /// at random in log frequency inside the range that holds its real track (spec 8.5).
    /// `new` fills in the named bands clipped to the search range; the engine replaces them
    /// with the bands in force (individual alpha frequency).
    pub null_bands: Vec<[f64; 2]>,
}

/// The default chance A placement ranges: the named bands of spec 6.5, clipped to the search range.
pub fn default_null_bands(p: &Params) -> Vec<[f64; 2]> {
    clip_null_bands(&[[1.0, 4.0], [4.0, 8.0], [8.0, 13.0], [13.0, 30.0], [30.0, 45.0]], p)
}

/// Clip placement ranges to the peak search range and stretch the outer ones to its ends, so
/// every searched frequency belongs to exactly one range. Empty ranges are dropped; with
/// none left the whole search range is one range.
pub fn clip_null_bands(bands: &[[f64; 2]], p: &Params) -> Vec<[f64; 2]> {
    let (lo, hi) = (p.peak_search_lo_hz, p.peak_search_hi_hz);
    let mut out: Vec<[f64; 2]> = Vec::new();
    for b in bands {
        let a = b[0].max(lo);
        let z = b[1].min(hi);
        if z > a {
            out.push([a, z]);
        }
    }
    if out.is_empty() {
        return vec![[lo, hi]];
    }
    out[0][0] = lo;
    let last = out.len() - 1;
    out[last][1] = hi;
    out
}

impl<'a> ScoreCtx<'a> {
    pub fn new(p: &'a Params, harmonic: &'a BTreeSet<(u32, u32)>, baselines: &'a Baselines) -> Self {
        let phi = (1.0 + m::sqrt(5.0)) / 2.0;
        ScoreCtx {
            p,
            ln_t: [m::ln(phi), m::ln(2.0), m::ln(p.control_ratio_a), m::ln(p.control_ratio_b), m::ln(3.0)],
            harmonic,
            baselines,
            ln_range: m::ln(p.peak_search_hi_hz / p.peak_search_lo_hz),
            null_bands: default_null_bands(p),
        }
    }

    /// The chance A placement range holding frequency `f` (the nearest one if `f` is outside all).
    pub fn null_band_of(&self, f: f64) -> [f64; 2] {
        let nb = &self.null_bands;
        for (i, b) in nb.iter().enumerate() {
            if f >= b[0] && (f < b[1] || i + 1 == nb.len()) {
                return *b;
            }
        }
        nb.first().copied().unwrap_or([self.p.peak_search_lo_hz, self.p.peak_search_hi_hz])
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
    /// search range (triangular on [0, L]). With a baseline, a Gaussian at the baseline mean
    /// mixed with that density.
    ///
    /// q must not depend on the current measurement's s_x. An earlier version widened the
    /// baseline Gaussian by s_x^2; a vaguer measurement then lowered q at the person's usual
    /// ratio and raised the evidence (by up to 5 nats for a tight baseline), which spec 8.2
    /// forbids. The baseline variance already contains the measurement noise of the baseline
    /// block. It is floored at tau^2 so a very steady baseline cannot make q a spike.
    fn ln_q(&self, a: u32, b: u32, x: f64) -> f64 {
        let l = self.ln_range;
        let tri = (2.0 * (l - x).max(l * 1e-3) / (l * l)).max(1e-12);
        match self.baselines.get(&Self::key(a, b)) {
            Some(&(mu, var)) => {
                let v = var.max(self.p.tau * self.p.tau);
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
        ln_n - self.ln_q(a, b, x)
    }

    /// ln Lambda = ln N(x; t, s_x^2 + tau^2) - ln q(x), made non-increasing in s_x.
    ///
    /// The Gaussian likelihood alone rises with s_x when the miss exceeds sqrt(s_x^2 + tau^2),
    /// which would let a vaguer measurement score better. Taking the smaller of the value at
    /// s_x and at s_x = 0 removes that: uncertainty never makes alignment easier (spec 8.2).
    /// This is exactly monotone for every pair, because q does not depend on s_x and ln N is
    /// unimodal in the variance.
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
    pub miss: [f64; NT],
    pub closeness: [Option<f64>; NT],
    pub log_ev: [Option<f64>; NT],
    pub aligned: [bool; NT],
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
    /// Aligned-state statistic: the largest total log evidence along any chain of eligible
    /// resolved pairs (`chain_stat`). For a single pair it is that pair's log evidence.
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
            let (x, sx, resolved) = pair_core(a, b, p);
            let harmonic = ctx.is_harmonic(a.id, b.id);
            let excluded = harmonic && p.exclude_harmonics;
            let mut pr = PairResult { lo: i, hi: j, x, sx, resolved, harmonic, miss: [0.0; NT], closeness: [None; NT], log_ev: [None; NT], aligned: [false; NT] };
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

/// Log ratio, its standard error, and whether it is resolved (spec 8.1, 8.2). The one
/// definition used by every scoring path.
#[inline]
fn pair_core(a: &ScoreTrack, b: &ScoreTrack, p: &Params) -> (f64, f64, bool) {
    let x = m::ln(b.f / a.f);
    let ra = a.se / a.f;
    let rb = b.se / b.f;
    let sx = m::sqrt(ra * ra + rb * rb);
    (x, sx, sx <= p.resolved_max_sx)
}

/// Only the aligned-state statistics [phi, octave] of a sorted track set: the same pair
/// arithmetic, eligibility and chain as `score_set`, without building pair records or
/// cascades. Used for the chance-B time series, where only the statistic is needed. A unit
/// test checks it equals `score_set(..).stat` exactly.
pub fn stats_only(tracks: &[ScoreTrack], ctx: &ScoreCtx) -> [Option<f64>; 2] {
    let p = ctx.p;
    let n = tracks.len();
    let mut out: [Option<f64>; 2] = [None, None];
    for (ti, slot) in out.iter_mut().enumerate() {
        *slot = chain_stat(n, |i, j| {
            let (a, b) = (&tracks[i], &tracks[j]);
            let (x, sx, resolved) = pair_core(a, b, p);
            if !resolved || (p.exclude_harmonics && ctx.is_harmonic(a.id, b.id)) {
                None
            } else {
                Some(ctx.log_evidence(a.id, b.id, x, sx, ctx.ln_t[ti]))
            }
        });
    }
    out
}

/// The aligned-state statistic (spec 8.4): the largest total log evidence along a chain of
/// tracks of rising frequency, each step an eligible resolved pair. `ev(i, j)` is the log
/// evidence of the pair (i, j), i < j, or None if the pair is not eligible. None if no pair
/// is eligible.
///
/// A chain of one step is a pair, so with two tracks this is the pair's log evidence. The
/// evidence of one pair cannot exceed about 4.5 nats however good the match (it is capped by
/// the intrinsic tolerance), while among many tracks some unrelated pair reaches nearly that
/// by chance. With the single best pair as the statistic, a five-member cascade among seven
/// tracks therefore could not beat its own chance threshold, and a weaker three-member one
/// could (fake test, November 2026). Independent steps multiply likelihood ratios, so their
/// log evidence adds: a cascade of k good steps scores about k times one pair, and chance
/// must produce a whole chain to match it. The surrogates are scored by this same function.
pub fn chain_stat(n: usize, ev: impl Fn(usize, usize) -> Option<f64>) -> Option<f64> {
    // best[j]: the largest total over chains that end at j, None if no eligible pair ends there.
    let mut best: Vec<Option<f64>> = vec![None; n];
    let mut top: Option<f64> = None;
    for j in 0..n {
        for i in 0..j {
            if let Some(e) = ev(i, j) {
                // Start a new chain at i, or extend the best one ending there if it adds.
                let cand = e + best[i].map_or(0.0, |b| b.max(0.0));
                if best[j].is_none_or(|b| cand > b) {
                    best[j] = Some(cand);
                }
            }
        }
        if let Some(b) = best[j] {
            if top.is_none_or(|t| b > t) {
                top = Some(b);
            }
        }
    }
    top
}

fn eligible(pr: &PairResult, ctx: &ScoreCtx) -> bool {
    pr.resolved && !(pr.harmonic && ctx.p.exclude_harmonics)
}

fn stat_for(n: usize, pairs: &[PairResult], ti: usize, ctx: &ScoreCtx) -> Result<f64, Reason> {
    if n < 2 {
        return Err(Reason::NotConfirmed);
    }
    // index of pair (i, j), i < j, in row-major upper-triangle order
    let idx = |i: usize, j: usize| i * (2 * n - i - 1) / 2 + (j - i - 1);
    chain_stat(n, |i, j| {
        let pr = &pairs[idx(i, j)];
        if eligible(pr, ctx) {
            pr.log_ev[ti]
        } else {
            None
        }
    })
    .ok_or(Reason::Unresolved)
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

    /// Excess alignment of an observed cascade over this chance distribution (spec 8.5), and
    /// the reference closeness it is measured from.
    ///
    /// The reference is the closeness that only a fraction `level` of surrogates reach or
    /// beat, counting a surrogate with a longer cascade as closeness 1 and one with a shorter
    /// cascade as 0, which is the order the percentile uses. The excess is
    /// (c - reference) / (1 - reference), and 0 at or below the reference. So it is above
    /// zero only when the percentile is at or under `level`: it cannot be large beside an
    /// unremarkable p. (It used to be measured from the mean surrogate closeness. Among five
    /// tracks the mean is about 0.15 while a quarter of surrogates hold a pair within
    /// tolerance, and one such pair read "0.96 over chance" beside p = 0.4.)
    /// None if too few surrogates could be scored.
    pub fn excess(&self, steps: usize, closeness: f64, level: f64) -> Option<(f64, f64)> {
        let scored = self.draws.iter().filter(|d| d.closeness.is_some()).count();
        if self.draws.is_empty() || scored * 2 < self.draws.len() {
            return None;
        }
        let mut e: Vec<f64> = self
            .draws
            .iter()
            .map(|d| match d.steps.cmp(&steps) {
                core::cmp::Ordering::Greater => 1.0,
                core::cmp::Ordering::Less => 0.0,
                core::cmp::Ordering::Equal => d.closeness.unwrap_or(0.0),
            })
            .collect();
        e.sort_by(|a, b| b.total_cmp(a));
        // The k-th largest, k = floor(level (N + 1)): beating it puts at most k - 1 surrogates
        // at or above the observed value, so p = (1 + count) / (1 + N) <= level.
        let k = m::floor(level * (e.len() as f64 + 1.0)) as usize;
        let reference = if k == 0 { 1.0 } else { e[(k - 1).min(e.len() - 1)] };
        let ex = if reference < 1.0 && closeness > reference { (closeness - reference) / (1.0 - reference) } else { 0.0 };
        Some((ex.clamp(0.0, 1.0), reference))
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

/// Chance A (spec 8.5): the same number of tracks, each placed at random in log frequency
/// inside the band that holds the real track, keeping that track's relative uncertainty and
/// identity, scored by `score_set`. Returns [phi, octave] distributions.
///
/// Placement is per band, not across the whole search range. A theta peak and an alpha peak
/// can only form ratios between 1 and 3.25, so they land within 3 % of the golden ratio about
/// 9 % of the time (spec 8.5, first table row); surrogates spread over 1 to 45 Hz land there
/// under 3 % of the time, and the chance level for the commonest real configuration came out
/// about three times too low (review, November 2026: P(p <= 0.05) was 0.16 for unrelated
/// theta and alpha peaks).
pub fn chance_a(tracks: &[ScoreTrack], ctx: &ScoreCtx, rng: &mut Rng) -> [NullDist; 2] {
    let p = ctx.p;
    let ranges: Vec<(f64, f64)> = tracks
        .iter()
        .map(|t| {
            let b = ctx.null_band_of(t.f);
            (m::ln(b[0]), m::ln(b[1]))
        })
        .collect();
    let mut out = [NullDist::default(), NullDist::default()];
    let mut sur = tracks.to_vec();
    for _ in 0..p.surrogates {
        for ((s, t), r) in sur.iter_mut().zip(tracks.iter()).zip(ranges.iter()) {
            let f = m::exp(rng.uniform(r.0, r.1));
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

/// Smallest relative lag (in slow updates) allowed between any two tracks' shifts in chance
/// B: the larger of the minimum lag and the correlation time of an integrated frequency,
/// which is the integration time plus one slow window. Two histories shifted against each
/// other by less than that still share most of the data behind each value, so the surrogate
/// would keep the very relationship it is meant to remove.
pub fn chance_b_min_relative_lag(p: &Params, min_lag: usize) -> usize {
    let corr = m::ceil((p.integration_s + p.slow_window_s) / p.slow_update_s) as usize;
    corr.max(min_lag).max(1)
}

/// Whether `n` histories, the shortest `min_len` updates long, leave room for `n` shifts
/// that are each at least `min_lag` from zero and from the wrap point and at least the
/// minimum relative lag from each other. Until they do, chance B is still warming up.
pub fn chance_b_feasible(p: &Params, n: usize, min_len: usize, min_lag: usize) -> bool {
    chance_b_slack(p, n, min_len, min_lag).is_some()
}

fn chance_b_slack(p: &Params, n: usize, min_len: usize, min_lag: usize) -> Option<usize> {
    if n < 2 {
        return None;
    }
    let d = chance_b_min_relative_lag(p, min_lag);
    // Lags lie in [min_lag, min_lag + room]; the wrap-around distance between the largest
    // and the smallest must also be at least d.
    let room = min_len.checked_sub(2 * min_lag)?.min(min_len.checked_sub(d + 1)?);
    room.checked_sub((n - 1) * d)
}

/// The smallest p-value chance B can honestly report from histories `span_s` long. Shifted
/// copies of one history are not independent draws: a history holds only span / correlation
/// time independent values of each track, so about that number squared independent pairings.
/// Measured on independent wandering tracks, P(p <= 0.01) was 4 to 9 % with 120 s of history
/// and 1 % with 300 s or more. The floor is 1 / (1 + (span / correlation time)^2).
pub fn chance_b_p_floor(p: &Params, span_s: f64) -> f64 {
    let m_ind = span_s / (p.integration_s + p.slow_window_s);
    (1.0 / (1.0 + m_ind * m_ind)).clamp(0.0, 1.0)
}

/// Chance B (spec 8.5): each track's own history shifted by a random lag of at least
/// `min_lag` updates, wrapping within that track's history, with every two tracks' lags at
/// least `chance_b_min_relative_lag` apart. All histories must hold at least `need` updates.
/// `step` is the time-series sampling (in updates) for the false-alarm threshold, `span` its
/// length in updates, `dwell` the dwell in series steps.
///
/// The lags used to be drawn independently per track. What decides whether a pair's
/// relationship survives is the difference of the two lags, and with independent draws that
/// difference was under the 38 s correlation time of the integrated frequencies in about
/// 60 % of surrogates at the minimum history (under 10 s in 19 %): the null was mostly the
/// observed relationship itself. If the histories are too short for the separation the
/// result holds no draws and no thresholds (the caller should test `chance_b_feasible`).
#[allow(clippy::too_many_arguments)]
pub fn chance_b(hist: &[History], ctx: &ScoreCtx, rng: &mut Rng, min_lag: usize, step: usize, span: usize, dwell_steps: usize, step_s: f64) -> ChanceB {
    let p = ctx.p;
    let n = hist.len();
    let mut dists = [NullDist::default(), NullDist::default()];
    let min_len = hist.iter().map(|h| h.f.len()).min().unwrap_or(0);
    let Some(slack) = chance_b_slack(p, n, min_len, min_lag) else {
        return ChanceB { dists, thresholds: [None, None] };
    };
    let d = chance_b_min_relative_lag(p, min_lag);
    let npts = (span / step.max(1)).max(1);
    let mut series: [Vec<Vec<Option<f64>>>; 2] = [Vec::new(), Vec::new()];
    let mut set = vec![ScoreTrack { id: 0, f: 1.0, se: 0.0 }; n];
    let mut offs = vec![0usize; n];
    let mut order: Vec<usize> = (0..n).collect();
    let mut lags = vec![0usize; n];
    for _ in 0..p.surrogates {
        // n sorted offsets in [0, slack], spread by d, handed to the tracks in random order.
        for o in offs.iter_mut() {
            *o = rng.range(0, slack as u64) as usize;
        }
        offs.sort_unstable();
        for i in (1..n).rev() {
            let j = rng.range(0, i as u64) as usize;
            order.swap(i, j);
        }
        for (k, &o) in offs.iter().enumerate() {
            lags[order[k]] = min_lag + o + k * d;
        }
        // Only the frequency is taken from the shifted moment. The uncertainty is the track's
        // present relative uncertainty, as in chance A, so that a surrogate is resolved exactly
        // when the observed set is. With the uncertainty of the shifted moment, surrogates
        // drawn from a track's first seconds (large error, unresolved) could never score, and
        // counted as "chance did worse": for unrelated rhythms P(p <= 0.05) was 0.17.
        let at = |back: usize, set: &mut Vec<ScoreTrack>| {
            for (k, h) in hist.iter().enumerate() {
                let len = h.f.len();
                let idx = (len - 1 + 2 * len - (back % len) - lags[k]) % len;
                let rel = h.se[len - 1] / h.f[len - 1];
                set[k] = ScoreTrack { id: h.id, f: h.f[idx], se: rel * h.f[idx] };
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
            let st = stats_only(&set, ctx);
            s0.push(st[0]);
            s1.push(st[1]);
        }
        series[0].push(s0);
        series[1].push(s1);
    }
    let total_s = p.surrogates as f64 * npts as f64 * step_s;
    let thresholds = [
        cfar_threshold(&series[0], dwell_steps, p.state_hysteresis, total_s, p.false_entry_interval_s, p.threshold_confidence),
        cfar_threshold(&series[1], dwell_steps, p.state_hysteresis, total_s, p.false_entry_interval_s, p.threshold_confidence),
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
/// hysteresis applied exactly as in the live state machine, is shown to be at most one per
/// `interval_s` with confidence `conf`: the observed entry count must be one that a process
/// at the allowed rate would produce with probability at most 1 - conf (Poisson). So Monte
/// Carlo error in the surrogates can only make entry harder.
pub fn cfar_threshold(series: &[Vec<Option<f64>>], dwell_steps: usize, hyst: f64, total_s: f64, interval_s: f64, conf: f64) -> Option<f64> {
    let mut vals: Vec<f64> = series.iter().flat_map(|s| s.iter().filter_map(|v| *v)).collect();
    if vals.is_empty() || total_s <= 0.0 {
        return None;
    }
    vals.sort_by(|a, b| a.total_cmp(b));
    let allowed = total_s / interval_s;
    // Largest count still significantly below the allowed rate.
    let mut kmax: Option<usize> = None;
    let mut k = 0usize;
    while poisson_cdf(k, allowed) <= 1.0 - conf {
        kmax = Some(k);
        k += 1;
    }
    let mut qs: Vec<f64> = (0..=40).map(|i| 0.5 + 0.0125 * i as f64).collect();
    qs.extend_from_slice(&[0.995, 0.999, 1.0]);
    for q in qs {
        let thr = m::quantile_sorted(&vals, q)?;
        let e = count_entries(series, thr, thr - hyst, dwell_steps);
        if kmax.is_some_and(|km| e <= km) {
            return Some(thr);
        }
    }
    // Even the largest null value is entered too often: only values above all of them count.
    vals.last().map(|v| v + 1e-9)
}

/// Threshold from a static (snapshot) null: an upper confidence bound (level `conf`) on the
/// (1 - p*) quantile of the statistic, p* the allowed false entries per decorrelation time
/// (the integration time). The order statistic is chosen from the binomial law so that the
/// true quantile lies at or below it with probability at least `conf`.
pub fn static_threshold(d: &NullDist, p: &Params) -> Option<f64> {
    let mut v: Vec<f64> = d.draws.iter().map(|x| x.stat.unwrap_or(f64::NEG_INFINITY)).collect();
    let n = v.len();
    if n == 0 {
        return None;
    }
    v.sort_by(|a, b| b.total_cmp(a)); // descending
    let pstar = (p.integration_s / p.false_entry_interval_s).clamp(1e-6, 1.0);
    // j-th largest is above the true (1 - p*) quantile with probability P(Bin(n, p*) >= j).
    // Take the largest j with P(Bin(n, p*) <= j - 1) <= 1 - conf.
    let mut j = 1usize;
    while j < n && binom_cdf(j, n, pstar) <= 1.0 - p.threshold_confidence {
        j += 1;
    }
    let t = v[j - 1];
    // If the bound falls on surrogates with no eligible pair, there is no usable threshold and
    // the state cannot be entered (the conservative choice).
    if t.is_finite() {
        Some(t)
    } else {
        None
    }
}

/// Aligned-state machine (spec 8.4): dwell before entry, hysteresis and dwell on exit.
#[derive(Clone, Debug, PartialEq)]
pub struct StateMachine {
    pub active: bool,
    pub since_t: Option<f64>,
    above_since: Option<f64>,
    below_since: Option<f64>,
}

impl Default for StateMachine {
    fn default() -> Self {
        StateMachine { active: false, since_t: None, above_since: None, below_since: None }
    }
}

impl StateMachine {
    /// The rule with no exit dwell: the state ends at the first update under the exit level.
    pub fn update(&mut self, t: f64, stat: Option<f64>, enter: Option<f64>, exit: Option<f64>, dwell_s: f64) {
        self.update_dwell(t, stat, enter, exit, dwell_s, 0.0, false);
    }

    /// Entry: the statistic at or over `enter` for `dwell_s` without a break. Exit: the
    /// statistic under `exit`, or not measurable, for `exit_dwell_s` without a break; at once
    /// when `nothing` is set (no confirmed rhythm at all, so nothing is being measured).
    #[allow(clippy::too_many_arguments)]
    pub fn update_dwell(&mut self, t: f64, stat: Option<f64>, enter: Option<f64>, exit: Option<f64>, dwell_s: f64, exit_dwell_s: f64, nothing: bool) {
        if self.since_t.is_none() {
            self.since_t = Some(t);
        }
        let was = self.active;
        if self.active {
            let holds = matches!((stat, exit), (Some(s), Some(ex)) if s >= ex);
            if holds {
                self.below_since = None;
            } else {
                let since = *self.below_since.get_or_insert(t);
                if nothing || t - since >= exit_dwell_s {
                    self.active = false;
                    self.above_since = None;
                    self.below_since = None;
                }
            }
        } else {
            match (stat, enter) {
                (Some(s), Some(en)) if s >= en => {
                    let since = *self.above_since.get_or_insert(t);
                    if t - since >= dwell_s {
                        self.active = true;
                        self.below_since = None;
                    }
                }
                _ => self.above_since = None,
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
        Target::Ratio3 => 4,
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
            ScoreTrack { id: 2, f: 8.5, se: 0.02 },
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
    fn stats_only_matches_score_set() {
        let p = Params::default();
        let mut h = BTreeSet::new();
        h.insert((2u32, 5u32));
        let mut b = Baselines::new();
        b.insert((1, 3), (0.47, 0.0004));
        let ctx = ScoreCtx::new(&p, &h, &b);
        let mut rng = Rng::new(3);
        for _ in 0..500 {
            let n = 2 + (rng.next_u64() % 6) as usize;
            let mut t: Vec<ScoreTrack> = (0..n)
                .map(|k| {
                    let f = m::exp(rng.uniform(0.0, m::ln(45.0)));
                    ScoreTrack { id: k as u32 + 1, f, se: f * rng.uniform(0.0005, 0.03) }
                })
                .collect();
            sort_tracks(&mut t);
            let full = score_set(&t, &ctx);
            let lean = stats_only(&t, &ctx);
            assert_eq!(full.stat[0].ok(), lean[0]);
            assert_eq!(full.stat[1].ok(), lean[1]);
        }
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
    /// Spec 8.2: uncertainty must never make alignment easier, with or without a baseline.
    /// Before the review a tight baseline let the evidence rise by up to 5.4 nats as s_x grew.
    #[test]
    fn uncertainty_never_helps_with_a_baseline() {
        let p = Params::default();
        let h = BTreeSet::new();
        for &var in &[1e-6, 1e-5, 1e-4, 1e-3, 1e-2] {
            for mui in 0..40 {
                let mu = 0.3 + 0.01 * mui as f64;
                let mut b = Baselines::new();
                b.insert((1, 2), (mu, var));
                let ctx = ScoreCtx::new(&p, &h, &b);
                for xi in 0..60 {
                    let x = 0.40 + 0.003 * xi as f64;
                    for ti in 0..2 {
                        let mut prev = f64::INFINITY;
                        for k in 0..=60 {
                            let sx = 0.0005 * k as f64;
                            let e = ctx.log_evidence(1, 2, x, sx, ctx.ln_t[ti]);
                            assert!(e <= prev + 1e-9, "evidence rose with s_x: var {var} mu {mu} x {x} sx {sx}: {prev} -> {e}");
                            prev = e;
                        }
                    }
                }
            }
        }
    }

    /// A larger uncertainty can never turn a pair that is not aligned into one that is, nor
    /// raise the aligned-state statistic.
    #[test]
    fn larger_uncertainty_never_aligns_a_pair() {
        let p = Params::default();
        let h = BTreeSet::new();
        let b = Baselines::new();
        let ctx = ScoreCtx::new(&p, &h, &b);
        let mut rng = Rng::new(17);
        for _ in 0..2000 {
            let f1 = rng.uniform(3.0, 12.0);
            let f2 = f1 * m::exp(rng.uniform(0.3, 0.8));
            let mut was_aligned = [true; 4];
            let mut prev_stat = [f64::INFINITY; 2];
            for k in 0..40 {
                let rel = 0.001 * k as f64;
                let t = [ScoreTrack { id: 1, f: f1, se: rel * f1 }, ScoreTrack { id: 2, f: f2, se: rel * f2 }];
                let sc = score_set(&t, &ctx);
                for ti in 0..4 {
                    let a = sc.pairs[0].aligned[ti];
                    assert!(!a || was_aligned[ti], "pair became aligned as uncertainty grew");
                    was_aligned[ti] = a;
                }
                for ci in 0..2 {
                    if let Ok(v) = sc.stat[ci] {
                        assert!(v <= prev_stat[ci] + 1e-9, "state statistic rose with uncertainty");
                        prev_stat[ci] = v;
                    }
                }
            }
        }
    }

    /// Chance A must be valid for the commonest real configuration: one theta peak and one
    /// alpha peak that have nothing to do with each other. With surrogates spread over the
    /// whole search range, P(p <= 0.05) was 0.16 and the state threshold was exceeded by 10 %
    /// of such pairs against a design value of 5 %.
    #[test]
    fn chance_a_is_valid_for_unrelated_theta_and_alpha_peaks() {
        let p = Params::default();
        let h = BTreeSet::new();
        let b = Baselines::new();
        let ctx = ScoreCtx::new(&p, &h, &b);
        let mut rng = Rng::new(99);
        let trials = 2000;
        let (mut p05, mut p01, mut exceed) = (0, 0, 0);
        for tr in 0..trials {
            let mut t = vec![
                ScoreTrack { id: 1, f: m::exp(rng.uniform(m::ln(4.0), m::ln(8.0))), se: 0.0 },
                ScoreTrack { id: 2, f: m::exp(rng.uniform(m::ln(8.0), m::ln(13.0))), se: 0.0 },
            ];
            for s in t.iter_mut() {
                s.se = 0.006 * s.f;
            }
            let sc = score_set(&t, &ctx);
            let mut r2 = Rng::derive(7, 0xA, tr as u64);
            let a = chance_a(&t, &ctx, &mut r2);
            let lv = a[0].level(sc.cascades[0].steps, sc.cascades[0].closeness.ok());
            let pv = lv.p.v.expect("p");
            if pv <= 0.05 {
                p05 += 1;
            }
            if pv <= 0.01 {
                p01 += 1;
            }
            if let (Some(thr), Ok(st)) = (static_threshold(&a[0], &p), sc.stat[0]) {
                if st >= thr {
                    exceed += 1;
                }
            }
        }
        let n = trials as f64;
        println!("unrelated theta+alpha: P(p<=0.05) {:.3}, P(p<=0.01) {:.3}, state threshold exceeded {:.3}", p05 as f64 / n, p01 as f64 / n, exceed as f64 / n);
        assert!(p05 as f64 / n <= 0.07, "P(p<=0.05) = {}", p05 as f64 / n);
        assert!(p01 as f64 / n <= 0.02, "P(p<=0.01) = {}", p01 as f64 / n);
        let pstar = p.integration_s / p.false_entry_interval_s;
        assert!(exceed as f64 / n <= pstar, "threshold exceeded by {} of unrelated pairs, design {pstar}", exceed as f64 / n);
    }

    #[test]
    fn null_bands_cover_the_search_range() {
        let mut p = Params::default();
        let nb = default_null_bands(&p);
        assert_eq!(nb.first().unwrap()[0], p.peak_search_lo_hz);
        assert_eq!(nb.last().unwrap()[1], p.peak_search_hi_hz);
        for w in nb.windows(2) {
            assert_eq!(w[0][1], w[1][0]);
        }
        p.peak_search_lo_hz = 5.0;
        p.peak_search_hi_hz = 20.0;
        let nb = clip_null_bands(&[[1.0, 4.0], [4.0, 8.0], [8.0, 13.0], [13.0, 30.0], [30.0, 45.0]], &p);
        assert_eq!(nb, vec![[5.0, 8.0], [8.0, 13.0], [13.0, 20.0]]);
        let h = BTreeSet::new();
        let b = Baselines::new();
        let pd = Params::default();
        let ctx = ScoreCtx::new(&pd, &h, &b);
        assert_eq!(ctx.null_band_of(6.0), [4.0, 8.0]);
        assert_eq!(ctx.null_band_of(8.0), [8.0, 13.0]);
        assert_eq!(ctx.null_band_of(45.0), [30.0, 45.0]);
        assert_eq!(ctx.null_band_of(0.5), [1.0, 4.0]);
    }

    /// Chance B must remove the relationship. Two histories that ramp together at an exact
    /// golden ratio are aligned at equal times and far from it at any relative lag beyond the
    /// correlation time. With independent lags per track, 19 % of surrogates had a relative lag
    /// under 10 s and kept the alignment.
    #[test]
    fn chance_b_surrogates_do_not_keep_the_relationship() {
        let p = Params::default();
        let h = BTreeSet::new();
        let b = Baselines::new();
        let ctx = ScoreCtx::new(&p, &h, &b);
        let phi = (1.0 + 5f64.sqrt()) / 2.0;
        let len = 640usize; // 160 s
        let f1: Vec<f64> = (0..len).map(|k| 6.0 * (1.0 + 0.001 * k as f64)).collect();
        let f2: Vec<f64> = f1.iter().map(|f| f * phi).collect();
        let se1: Vec<f64> = f1.iter().map(|f| 0.004 * f).collect();
        let se2: Vec<f64> = f2.iter().map(|f| 0.004 * f).collect();
        let hist = [History { id: 1, f: &f1, se: &se1 }, History { id: 2, f: &f2, se: &se2 }];
        let min_lag = (p.chance_b_min_lag_s / p.slow_update_s) as usize;
        assert!(chance_b_feasible(&p, 2, len, min_lag));
        let mut rng = Rng::new(5);
        let cb = chance_b(&hist, &ctx, &mut rng, min_lag, 4, 480, 5, 1.0);
        assert_eq!(cb.dists[0].draws.len(), p.surrogates);
        let worst = cb.dists[0].draws.iter().filter_map(|d| d.closeness).fold(0.0f64, f64::max);
        println!("largest surrogate closeness {worst:.4}");
        assert!(worst < 0.02, "a chance B surrogate kept the alignment: closeness {worst}");
        assert!(cb.dists[0].draws.iter().all(|d| d.steps == 0));
        // Too short for the separation: no draws, and the caller reports warming up.
        assert!(!chance_b_feasible(&p, 5, 480, min_lag));
        let short = [History { id: 1, f: &f1[..150], se: &se1[..150] }, History { id: 2, f: &f2[..150], se: &se2[..150] }];
        assert!(!chance_b_feasible(&p, 2, 150, min_lag));
        let cb = chance_b(&short, &ctx, &mut rng, min_lag, 4, 150, 5, 1.0);
        assert!(cb.dists[0].draws.is_empty() && cb.thresholds == [None, None]);
    }
    /// A chance B surrogate is resolved exactly when the observed set is: it takes the tracks'
    /// present uncertainty, not the uncertainty of the shifted moment. Otherwise surrogates
    /// from a track's first, vague seconds can never score and chance looks worse than it is.
    #[test]
    fn chance_b_surrogates_use_the_present_uncertainty() {
        let p = Params::default();
        let h = BTreeSet::new();
        let b = Baselines::new();
        let ctx = ScoreCtx::new(&p, &h, &b);
        let len = 640usize;
        let f1 = vec![6.0; len];
        let f2 = vec![9.8; len];
        // The first half of each history is far too vague to be resolved.
        let se1: Vec<f64> = (0..len).map(|k| if k < len / 2 { 0.5 } else { 0.02 }).collect();
        let se2: Vec<f64> = (0..len).map(|k| if k < len / 2 { 0.8 } else { 0.03 }).collect();
        let hist = [History { id: 1, f: &f1, se: &se1 }, History { id: 2, f: &f2, se: &se2 }];
        let mut rng = Rng::new(5);
        let cb = chance_b(&hist, &ctx, &mut rng, 40, 4, 480, 5, 1.0);
        assert_eq!(cb.dists[0].draws.len(), p.surrogates);
        assert!(cb.dists[0].draws.iter().all(|d| d.closeness.is_some() && d.stat.is_some()), "a surrogate was unresolved although the observed pair is resolved");
        // Constant histories: every surrogate equals the observation, so p = 1.
        let now = [ScoreTrack { id: 1, f: 6.0, se: 0.02 }, ScoreTrack { id: 2, f: 9.8, se: 0.03 }];
        let sc = score_set(&now, &ctx);
        let lv = cb.dists[0].level(sc.cascades[0].steps, sc.cascades[0].closeness.ok());
        assert_eq!(lv.p.v, Some(1.0));
    }

    #[test]
    fn chance_b_percentile_floor_follows_the_history_length() {
        let p = Params::default();
        let f120 = chance_b_p_floor(&p, 120.0);
        let f600 = chance_b_p_floor(&p, 600.0);
        assert!((f120 - 1.0 / (1.0 + (120.0f64 / 38.0).powi(2))).abs() < 1e-12);
        assert!(f120 > 0.05 && f600 < 0.01 && f600 > 0.0);
    }
}
