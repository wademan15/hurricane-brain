import { useState } from 'react';
import type { SafetyFlag } from '../../training';
import { Button, Card, Note } from '../components/kit';
import {
  FIT_STEPS, GENERAL_SAFETY, GOLDEN_RATIO_TEXT, HEADPHONES, PRIVACY, SAFETY_QUESTIONS, WHAT_IT_DOES_NOT_CLAIM, WHAT_IT_MEASURES, techniqueCautions,
} from '../copy';
import { useServices } from '../state/app';

const STEPS = ['What it measures', 'Golden ratio alignment', 'Headphones', 'Safety', 'Privacy', 'Fitting the headband'] as const;

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { settings, profile } = useServices();
  const [i, setI] = useState(0);
  const [safety, setSafety] = useState<Partial<Record<SafetyFlag, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = i === STEPS.length - 1;

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!profile.get()) {
        const seed = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
        await profile.create(safety, null, new Date(), seed);
      } else if (Object.values(safety).some(Boolean)) {
        const p = profile.get();
        if (p) await profile.put({ ...p, safety });
      }
      settings.update({ onboarded: true });
      onDone();
    } catch (e) {
      setError(`Your profile could not be saved on this device: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-main" style={{ height: '100%' }}>
      <div className="app-main-inner">
        <header className="hero">
          <p className="dim small" aria-live="polite">Step {i + 1} of {STEPS.length}</p>
          <h1>{i === 0 ? 'Welcome to Hurricane Brain' : STEPS[i]}</h1>
        </header>
        <div className="meter" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={i + 1} aria-label="Setup progress" style={{ marginBottom: 20 }}>
          <i style={{ width: `${((i + 1) / STEPS.length) * 100}%` }} />
        </div>

        {i === 0 ? (
          <>
            <Card>
              <h2>What the app measures</h2>
              <ul>{WHAT_IT_MEASURES.map((t) => <li key={t} style={{ marginBottom: 8 }}>{t}</li>)}</ul>
            </Card>
            <Card>
              <h2>What it does not claim</h2>
              <ul>{WHAT_IT_DOES_NOT_CLAIM.map((t) => <li key={t} style={{ marginBottom: 8 }}>{t}</li>)}</ul>
            </Card>
          </>
        ) : null}

        {i === 1 ? (
          <Card>
            <p>{GOLDEN_RATIO_TEXT.measurement}</p>
            <h3>Two readings</h3>
            <p>{GOLDEN_RATIO_TEXT.winter}</p>
            <p>{GOLDEN_RATIO_TEXT.mainstream}</p>
            <Note>{GOLDEN_RATIO_TEXT.stance}</Note>
          </Card>
        ) : null}

        {i === 2 ? (
          <Card>
            <ul>{HEADPHONES.map((t) => <li key={t} style={{ marginBottom: 10 }}>{t}</li>)}</ul>
            <p className="dim">Most sessions are eyes closed. The sound carries the state, so a gentle, comfortable level matters more than anything on the screen.</p>
          </Card>
        ) : null}

        {i === 3 ? (
          <>
            <Card>
              <h2>Before you begin</h2>
              <ul>{GENERAL_SAFETY.map((t) => <li key={t} style={{ marginBottom: 8 }}>{t}</li>)}</ul>
            </Card>
            <Card>
              <h2>Does any of this apply to you?</h2>
              <p className="dim">Your answers stay on this device. They only decide which programs and techniques are offered to you.</p>
              {SAFETY_QUESTIONS.map((q) => (
                <label key={q.flag} className="check">
                  <input type="checkbox" checked={!!safety[q.flag]} onChange={(e) => setSafety({ ...safety, [q.flag]: e.target.checked })} />
                  <span>{q.text}</span>
                </label>
              ))}
            </Card>
            <Card>
              <details>
                <summary>Cautions from the individual techniques</summary>
                <ul>{techniqueCautions().map((t) => <li key={t} style={{ marginBottom: 6 }}>{t}</li>)}</ul>
              </details>
            </Card>
          </>
        ) : null}

        {i === 4 ? (
          <Card>
            <ul>{PRIVACY.map((t) => <li key={t} style={{ marginBottom: 10 }}>{t}</li>)}</ul>
          </Card>
        ) : null}

        {i === 5 ? (
          <Card>
            <ol className="steps">
              {FIT_STEPS.map((s) => (
                <li key={s.title}>
                  <strong>{s.title}</strong>
                  <div className="dim">{s.text}</div>
                </li>
              ))}
            </ol>
            <p className="dim">You can check the signal for each sensor at any time from the Home screen.</p>
          </Card>
        ) : null}

        {error ? <Note tone="bad">{error}</Note> : null}
        <div className="row" style={{ marginTop: 16, justifyContent: 'space-between' }}>
          <Button variant="ghost" disabled={i === 0} onClick={() => setI(i - 1)}>Back</Button>
          {last ? (
            <Button variant="primary" size="big" disabled={busy} onClick={() => void finish()}>Get started</Button>
          ) : (
            <Button variant="primary" size="big" onClick={() => setI(i + 1)}>Next</Button>
          )}
        </div>
      </div>
    </div>
  );
}
