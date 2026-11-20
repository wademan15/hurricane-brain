/**
 * Starting a session. With fit coaching on (the default) every session first goes through the
 * "get ready" screen; with it off, or when no headset is involved, it starts at once.
 */
import { useCallback } from 'react';
import { getProgram } from '../../training';
import type { ProgramRequest } from '../session/plan';
import { useController, useServices, useSettings } from './app';

export type PendingStart = { kind: 'free' } | { kind: 'program'; req: ProgramRequest };


export function usesHeadset(p: PendingStart): boolean {
  return p.kind === 'free' ? true : !!getProgram(p.req.programId)?.requires.eeg;
}

export function useStarter(navigate: (to: string) => void) {
  const { controller, pending } = useServices();
  const settings = useSettings();
  const st = useController();
  const startNow = useCallback(
    async (p: PendingStart) => {
      pending.replace(null);
      if (p.kind === 'free') await controller.startFree();
      else await controller.startProgram(p.req);
      navigate('session');
    },
    [controller, pending, navigate],
  );
  const begin = useCallback(
    async (p: PendingStart) => {
      const coach = settings.fitCoaching && usesHeadset(p) && st.muse.state !== 'none' && !st.link?.heartOnly;
      if (coach) {
        pending.replace(p);
        navigate('ready');
      } else await startNow(p);
    },
    [settings.fitCoaching, st.muse.state, st.link?.heartOnly, pending, navigate, startNow],
  );
  return { begin, startNow };
}
