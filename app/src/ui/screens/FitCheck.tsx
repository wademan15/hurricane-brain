import { Button, Card, Note, PageHeader } from '../components/kit';
import { FitCoach } from '../components/FitCoach';
import { FIT_STEPS } from '../copy';
import { useFitHold } from '../state/fit';
import { useController, useProfileInfo, useSettings } from '../state/app';

export function FitCheck({ navigate }: { navigate: (to: string) => void }) {
  const st = useController();
  const settings = useSettings();
  const info = useProfileInfo();
  const { slow, hold, good } = useFitHold(settings.fitHoldS);
  const live = st.link !== null;
  return (
    <div>
      <PageHeader title="Fit and signal check" sub="Contact quality for each sensor, from the engine's own measurement." />
      {!live ? (
        <Note tone="warn">
          No headset is connected, so nothing is measured. Connect a headset on the Home screen, or replay a recording to see its signal quality.{' '}
          <Button size="small" onClick={() => navigate('home')}>Go to Home</Button>
        </Note>
      ) : null}
      <FitCoach slow={slow} hold={hold} requiredS={settings.fitHoldS} good={good} smallHead={info.ageGroup === 'child' || info.ageGroup === 'teen'} />
      <Card>
        <h2>Fitting the headband</h2>
        <ol className="steps">
          {FIT_STEPS.map((s) => (
            <li key={s.title}>
              <strong>{s.title}</strong>
              <div className="dim">{s.text}</div>
            </li>
          ))}
        </ol>
        <p className="small dim">Most sessions are eyes closed, so get the fit right first and then you will not need to look at the screen.</p>
      </Card>
    </div>
  );
}
