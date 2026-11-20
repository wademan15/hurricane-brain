import { useState } from 'react';
import { Button, Card, Note, PageHeader } from '../components/kit';
import { FitCoach } from '../components/FitCoach';
import { useFitHold } from '../state/fit';
import { usesHeadset, useStarter } from '../state/start';
import { useController, useProfileInfo, useServices, useSettings } from '../state/app';
import { getProgram } from '../../training';

/** Before every session: look at the fit, then start. Skipping is always possible. */
export function Ready({ navigate }: { navigate: (to: string) => void }) {
  const { pending } = useServices();
  const settings = useSettings();
  const st = useController();
  const info = useProfileInfo();
  const p = pending.get();
  const { startNow } = useStarter(navigate);
  const { slow, hold, good } = useFitHold(settings.fitHoldS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!p) {
    return (
      <div>
        <PageHeader title="Nothing is waiting to start" />
        <Card>
          <p className="dim">Choose a session on Home or in Programs.</p>
          <Button variant="primary" onClick={() => navigate('home')}>Go to Home</Button>
        </Card>
      </div>
    );
  }
  const name = p.kind === 'free' ? 'Free session' : (getProgram(p.req.programId)?.name ?? 'Session');
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await startNow(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const noHeadset = !usesHeadset(p) || st.muse.state === 'none';
  return (
    <div>
      <PageHeader title="Get ready" sub={`${name}. Check the headband first, then start. Most sessions are eyes closed, so a good fit now means you will not need the screen.`} />
      {error ? <Note tone="bad">{error}</Note> : null}
      {noHeadset ? <Note tone="warn">No headset is connected, so there is no signal to check.</Note> : null}
      <FitCoach slow={slow} hold={hold} requiredS={settings.fitHoldS} good={good} smallHead={info.ageGroup === 'child' || info.ageGroup === 'teen'} />
      <div className="row" style={{ position: 'sticky', bottom: 0, padding: '12px 0', background: 'var(--bg)' }}>
        <Button variant="primary" size="big" disabled={!good || busy} onClick={() => void go()}>Start session</Button>
        <Button disabled={busy} onClick={() => void go()}>Skip the check and start</Button>
        <Button variant="ghost" onClick={() => { pending.replace(null); navigate('home'); }}>Back</Button>
      </div>
    </div>
  );
}
