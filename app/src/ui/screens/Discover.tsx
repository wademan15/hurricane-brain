import { useMemo, useState } from 'react';
import {
  compareStrategies, deriveSeed, getProgram, getStrategy, planDiscoverySession, priorGuess, recommendNext, recommendPrograms, STATE_METRICS,
  subjectiveVsMeasured, type Questionnaire, type StrategyEstimate, type StrategyLabel, type UserProfile,
} from '../../training';
import { Badge, Button, Card, Field, Note, PageHeader } from '../components/kit';
import { IntervalBar } from '../components/IntervalBar';
import { StartButton } from '../components/StartButton';
import { fmtDateTime, numberLine } from '../measured';
import { useProfile, useServices } from '../state/app';

const LABEL_TEXT: Record<StrategyLabel, { text: string; tone: 'ok' | 'accent' | 'default' | 'warn' }> = {
  strong: { text: 'Strong', tone: 'ok' },
  promising: { text: 'Promising', tone: 'accent' },
  unclear: { text: 'Unclear', tone: 'default' },
  not_now: { text: 'Not now', tone: 'warn' },
};

function strategyName(id: string): string {
  return id === 'none' ? 'Just resting' : (getStrategy(id)?.name ?? id);
}

function Estimates({ profile }: { profile: UserProfile }) {
  const states = [...new Set(profile.estimates.map((e) => e.state))];
  if (!states.length) {
    return <p className="dim">No estimates yet. Run a Discovery session: each technique is compared with the rest just before it, and the results appear here with their uncertainty.</p>;
  }
  return (
    <div className="stack">
      {states.map((state) => {
        const ests = profile.estimates.filter((e) => e.state === state).sort((a, b) => b.mean - a.mean);
        const scale = Math.max(0.5, ...ests.map((e) => Math.max(Math.abs(e.lo), Math.abs(e.hi))));
        const cmp = ests.length >= 2 ? compareStrategies(profile, state, ests[0].strategy, ests[1].strategy) : null;
        return (
          <div key={state}>
            <h3>{STATE_METRICS[state]?.label ?? state}</h3>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
              <table>
                <thead>
                  <tr><th>Technique</th><th>Effect (95% interval)</th><th>Evidence so far</th><th>Label</th></tr>
                </thead>
                <tbody>
                  {ests.map((e: StrategyEstimate) => (
                    <tr key={e.strategy}>
                      <td>
                        {strategyName(e.strategy)}
                        <div className="small dim">{e.reading}</div>
                      </td>
                      <td>
                        <IntervalBar mean={e.mean} lo={e.lo} hi={e.hi} scale={scale} />
                        <div className="small mono">{e.mean.toFixed(2)} ({e.lo.toFixed(2)} to {e.hi.toFixed(2)})</div>
                      </td>
                      <td className="small">{e.nBlocks} clean block{e.nBlocks === 1 ? '' : 's'}, {e.nSessions} session{e.nSessions === 1 ? '' : 's'}</td>
                      <td><Badge tone={LABEL_TEXT[e.label].tone}>{LABEL_TEXT[e.label].text}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cmp ? (
              <Note tone={cmp.verdict === 'within_noise' ? 'default' : 'ok'}>
                <strong>{strategyName(ests[0].strategy)} against {strategyName(ests[1].strategy)}:</strong>{' '}
                {cmp.verdict === 'within_noise' ? 'within noise. ' : cmp.verdict === 'a_higher' ? 'the first is higher. ' : 'the second is higher. '}
                {cmp.reading}
              </Note>
            ) : null}
          </div>
        );
      })}
      <p className="small dim">Effects are standardized: how far a technique moved your measure, in units of your own resting spread, corrected for settling down as a session goes on. Labels need several clean blocks over several sessions. One block proves nothing.</p>
    </div>
  );
}

function QuestionnaireCard({ profile }: { profile: UserProfile }) {
  const { profile: store } = useServices();
  const q = profile.questionnaire;
  const [draft, setDraft] = useState<Questionnaire>(q ?? {});
  const [saved, setSaved] = useState(false);
  const num = (k: keyof Questionnaire, label: string, lo: number, hi: number, hint: string) => (
    <Field label={`${label} (${lo} to ${hi})`} hint={hint}>
      <input
        type="number" min={lo} max={hi} value={(draft[k] as number | undefined) ?? ''}
        aria-invalid={draft[k] !== undefined && !((draft[k] as number) >= lo && (draft[k] as number) <= hi)}
        onChange={(e) => { setSaved(false); setDraft({ ...draft, [k]: e.target.value === '' ? undefined : Number(e.target.value) }); }}
        // leaving the box pulls an out-of-range number into range, so nothing outside it is saved
        onBlur={() => { const v = draft[k] as number | undefined; if (v !== undefined && Number.isFinite(v) && (v < lo || v > hi)) setDraft({ ...draft, [k]: Math.min(hi, Math.max(lo, v)) }); }}
      />
      {draft[k] !== undefined && !((draft[k] as number) >= lo && (draft[k] as number) <= hi) ? <span className="hint err" role="alert">Use a number from {lo} to {hi}.</span> : null}
    </Field>
  );
  const guesses = useMemo(() => {
    if (!profile.questionnaire) return [];
    return ['visual_calm', 'breath_resonance', 'body_scan', 'mantra_silent', 'open_awareness']
      .map((id) => ({ id, g: priorGuess(profile.questionnaire, id) }))
      .filter((x) => getStrategy(x.id))
      .sort((a, b) => b.g - a.g);
  }, [profile.questionnaire]);
  return (
    <Card>
      <h2>Optional questionnaire</h2>
      <Note>These answers are only a starting guess for which techniques to try first. They never set the labels above: those come from your measured response.</Note>
      <div className="grid2">
        {num('imagery', 'Imagery vividness', 1, 5, '1 = I see very little, 5 = very vivid')}
        {num('absorption', 'Absorption', 1, 5, 'How easily you lose yourself in music, a book or a view')}
        {num('interoception', 'Noticing breath and heartbeat', 1, 5, '1 = rarely, 5 = often')}
        {num('verbal', 'Thinking in words', 1, 5, '1 = mostly pictures, 5 = mostly words')}
        {num('anxiety', 'Feeling on edge', 0, 6, '0 = never, 6 = nearly every day. Only used to choose gentler techniques first.')}
        <Field label="Meditation experience">
          <select value={draft.meditation ?? ''} onChange={(e) => { setSaved(false); setDraft({ ...draft, meditation: (e.target.value || undefined) as Questionnaire['meditation'] }); }}>
            <option value="">Prefer not to say</option>
            <option value="none">None</option>
            <option value="some">Some</option>
            <option value="regular">Regular</option>
            <option value="years">Years</option>
          </select>
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={draft.aphantasia === true} onChange={(e) => { setSaved(false); setDraft({ ...draft, aphantasia: e.target.checked }); }} />
        <span>When I picture an apple, I do not see anything.</span>
      </label>
      <div className="row">
        <Button onClick={async () => { await store.put({ ...profile, questionnaire: { ...draft } }); setSaved(true); }}>Save answers</Button>
        {saved ? <span className="dim" role="status">Saved on this device.</span> : null}
      </div>
      {guesses.length ? (
        <p className="small dim" style={{ marginTop: 10 }}>Starting guess for what to try first: {guesses.slice(0, 3).map((x) => strategyName(x.id)).join(', ')}. A guess, not a result.</p>
      ) : null}
    </Card>
  );
}

export function Discover({ navigate }: { navigate: (to: string) => void }) {
  const profile = useProfile();
  if (!profile) return <Card><p>Set up your profile in onboarding first.</p></Card>;
  const cal = profile.calibrations.at(-1);
  const plan = planDiscoverySession(profile);
  const recs = recommendPrograms(profile);
  const next = recommendNext(profile, 'alpha_ec', deriveSeed(profile.seed, `rec:${profile.sessions.length}`));
  const svm = subjectiveVsMeasured(profile, 'alpha_ec').filter((x) => x.meanEase !== null);
  const res = profile.resonance;

  return (
    <div>
      <PageHeader title="Discover" sub="What suits your brain and heart, learned from your own measurements. People differ, so the app tests rather than assumes." />

      <Card>
        <h2>Calibration</h2>
        {cal ? (
          <>
            <dl className="kv">
              <dt>Individual alpha frequency</dt>
              <dd>{numberLine(cal.iafHz, 'Hz', cal.iafSe)}</dd>
              <dt>Eyes-closed alpha rise</dt>
              <dd>{numberLine(cal.alphaReactivityDb, 'dB')}</dd>
              <dt>Theta peak</dt>
              <dd>{numberLine(cal.thetaPeakHz, 'Hz')}</dd>
              <dt>Last run</dt>
              <dd>{fmtDateTime(cal.at)}</dd>
            </dl>
            {cal.lowAlpha ? <Note>Your alpha changes little when you close your eyes. That is common and not a problem. The app will lean on stillness and heart programs for you.</Note> : null}
          </>
        ) : (
          <p className="dim">Not done yet. About eight minutes: it teaches the app your signals and finds your alpha frequency.</p>
        )}
        <StartButton req={{ programId: 'calibration' }} navigate={navigate}>{cal ? 'Run calibration again' : 'Run calibration'}</StartButton>
      </Card>

      <Card>
        <h2>Discovery session {plan.sessionIndex + 1}</h2>
        <p className="dim">{plan.reason}</p>
        <ol style={{ paddingLeft: 20 }}>
          {plan.strategies.map((s) => (
            <li key={s}>{strategyName(s)}</li>
          ))}
        </ol>
        <p className="small dim">Each technique follows a short rest. The sound does not respond during Discovery, so the technique itself is what gets measured. The order changes between sessions.</p>
        <StartButton req={{ programId: 'discovery_sampler' }} navigate={navigate}>Start Discovery</StartButton>
      </Card>

      <Card>
        <h2>Your estimates</h2>
        <Estimates profile={profile} />
        {next ? <Note><strong>Suggested next technique:</strong> {strategyName(next.strategy)} ({next.mode === 'best_so_far' ? 'best so far' : 'exploring'}). {next.reading}</Note> : null}
        {svm.length ? (
          <details>
            <summary>How it felt against how it measured</summary>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
              <table>
                <thead><tr><th>Technique</th><th>Your ease rating (1 to 5)</th><th>Measured effect</th><th>Blocks</th></tr></thead>
                <tbody>
                  {svm.map((x) => (
                    <tr key={x.strategy}><td>{strategyName(x.strategy)}</td><td>{x.meanEase?.toFixed(1)}</td><td>{x.meanEffect.toFixed(2)}</td><td>{x.n}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </Card>

      <Card>
        <h2>Resonance breathing rate</h2>
        {res ? (
          <>
            <p><strong>{res.bpm} breaths a minute</strong> <span className="dim small">({fmtDateTime(res.at)})</span></p>
            <p className="dim">{res.reading}</p>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
              <table>
                <thead><tr><th>Rate</th><th>Heart rhythm power</th><th>Resonance strength</th><th>Followed the pacer</th></tr></thead>
                <tbody>
                  {res.candidates.map((c) => (
                    <tr key={c.bpm} style={!c.usable ? { opacity: 0.6 } : undefined}>
                      <td>{c.bpm}{res.withinNoise.includes(c.bpm) ? ' (within noise)' : ''}{!c.usable ? ' (not usable)' : ''}</td>
                      <td>{numberLine(c.lfPower)}</td>
                      <td>{numberLine(c.resonanceStrength)}</td>
                      <td>{numberLine(c.adherence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="dim">Not found yet. With a chest strap, you breathe with a pacer at five slow rates and the app finds where your heart rhythm swings most.</p>
        )}
        <StartButton req={{ programId: 'hrv_resonance_finding' }} navigate={navigate} variant="default">{res ? 'Find it again' : 'Find your breathing rate'}</StartButton>
      </Card>

      <Card>
        <h2>Recommended programs</h2>
        {recs.map((r) => {
          const p = getProgram(r.programId);
          return (
            <div key={r.programId} className="row split" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <strong>{p?.name}</strong>
                <div className="small dim">{r.reason}</div>
              </div>
              <Button size="small" onClick={() => navigate(`programs/${r.programId}`)}>Open</Button>
            </div>
          );
        })}
      </Card>

      <QuestionnaireCard profile={profile} />
    </div>
  );
}
