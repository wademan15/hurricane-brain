import { useState } from 'react';
import { Button, Card, Note } from '../components/kit';
import { ProfileForm, type NewPerson } from '../components/ProfileForm';
import {
  FIT_STEPS, GENERAL_SAFETY, GOLDEN_RATIO_TEXT, HEADPHONES, PHOTOSENSITIVITY, PRIVACY, WELLNESS, WHAT_IT_DOES_NOT_CLAIM, WHAT_IT_MEASURES, techniqueCautions,
} from '../copy';
import { useServices } from '../state/app';

const STEPS = ['What it measures', 'Who is this for', 'Golden ratio alignment', 'Headphones', 'Safety and the screen', 'Privacy', 'Fitting the headband'] as const;

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { settings, profile } = useServices();
  const [i, setI] = useState(0);
  const [person, setPerson] = useState<NewPerson>({ name: '', ageGroup: null, safety: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = i === STEPS.length - 1;

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!profile.get()) {
        const seed = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
        await profile.create({ name: person.name, ageGroup: person.ageGroup, safety: person.safety, questionnaire: null }, new Date(), seed);
      }
      settings.update({ onboarded: true, photoNoticeSeen: true });
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
            <Note>{WELLNESS}</Note>
            <Card>
              <h2>What it does not claim</h2>
              <ul>{WHAT_IT_DOES_NOT_CLAIM.map((t) => <li key={t} style={{ marginBottom: 8 }}>{t}</li>)}</ul>
            </Card>
          </>
        ) : null}

        {i === 1 ? (
          <Card>
            <h2>Who is this for?</h2>
            <p className="dim">Each person has their own profile, with their own calibration, history, signatures and anchors. You can add more people later.</p>
            <ProfileForm value={person} onChange={setPerson} withSafety={false} />
          </Card>
        ) : null}

        {i === 2 ? (
          <Card>
            <p>{GOLDEN_RATIO_TEXT.measurement}</p>
            <Note>{GOLDEN_RATIO_TEXT.research}</Note>
            <h3>Two readings</h3>
            <p>{GOLDEN_RATIO_TEXT.winter}</p>
            <p>{GOLDEN_RATIO_TEXT.mainstream}</p>
            <Note>{GOLDEN_RATIO_TEXT.stance}</Note>
          </Card>
        ) : null}

        {i === 3 ? (
          <Card>
            <ul>{HEADPHONES.map((t) => <li key={t} style={{ marginBottom: 10 }}>{t}</li>)}</ul>
            <p className="dim">Most sessions are eyes closed. The sound carries the state, so a gentle, comfortable level matters more than anything on the screen.</p>
          </Card>
        ) : null}

        {i === 4 ? (
          <>
            <Card>
              <h2>The screen</h2>
              <ul>{PHOTOSENSITIVITY.map((t) => <li key={t} style={{ marginBottom: 8 }}>{t}</li>)}</ul>
              <label className="check">
                <input type="checkbox" checked={settings.get().reducedMotion === 'on'} onChange={(e) => settings.update({ reducedMotion: e.target.checked ? 'on' : 'system' })} />
                <span>Use reduced motion</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.get().soundOnly} onChange={(e) => settings.update({ soundOnly: e.target.checked })} />
                <span>Sound only: keep the screen dark during sessions</span>
              </label>
            </Card>
            <Card>
              <h2>Before you begin</h2>
              <ul>{GENERAL_SAFETY.map((t) => <li key={t} style={{ marginBottom: 8 }}>{t}</li>)}</ul>
            </Card>
            <Card>
              <h2>Does any of this apply?</h2>
              <ProfileForm value={person} onChange={setPerson} withIdentity={false} />
            </Card>
            <Card>
              <details>
                <summary>Cautions from the individual techniques</summary>
                <ul>{techniqueCautions().map((t) => <li key={t} style={{ marginBottom: 6 }}>{t}</li>)}</ul>
              </details>
            </Card>
          </>
        ) : null}

        {i === 5 ? (
          <Card>
            <ul>{PRIVACY.map((t) => <li key={t} style={{ marginBottom: 10 }}>{t}</li>)}</ul>
          </Card>
        ) : null}

        {i === 6 ? (
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
            <Button variant="primary" size="big" disabled={busy || !person.name.trim()} onClick={() => void finish()}>Get started</Button>
          ) : (
            <Button variant="primary" size="big" onClick={() => setI(i + 1)}>Next</Button>
          )}
        </div>
      </div>
    </div>
  );
}
