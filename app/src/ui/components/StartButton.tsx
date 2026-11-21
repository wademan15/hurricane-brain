import { useState, type ReactNode } from 'react';
import { getProgram } from '../../training';
import type { ProgramRequest } from '../session/plan';
import { useController } from '../state/app';
import { useStarter } from '../state/start';
import { Button, Note } from './kit';

/** Starts a program with the profile's defaults, or says exactly why it cannot start. */
export function StartButton({ req, navigate, children, variant = 'primary' }: { req: ProgramRequest; navigate: (to: string) => void; children: ReactNode; variant?: 'primary' | 'default' }) {
  const { begin } = useStarter(navigate);
  const st = useController();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const program = getProgram(req.programId);
  const ready = st.link?.kind === 'live' && st.engine === 'ready';
  const needHeadset = !!program?.requires.eeg && st.muse.state !== 'streaming';
  const needStrap = program?.requires.heart === 'required' && st.strap.state !== 'streaming';
  const why = !program ? 'unknown program' : !ready ? 'Connect a device on the Home screen first.' : needHeadset ? 'Needs the headset.' : needStrap ? 'Needs the chest strap.' : st.session ? 'A session is already running.' : null;
  return (
    <div>
      <Button
        variant={variant}
        disabled={!!why || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await begin({ kind: 'program', req });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
      </Button>
      {why ? <div className="small dim" style={{ marginTop: 4 }}>{why}</div> : null}
      {error ? <Note tone="bad">{error}</Note> : null}
    </div>
  );
}
