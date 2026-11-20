import { useRef, useState } from 'react';
import { getProgram, recommendPrograms } from '../../training';
import { Badge, Button, Card, Note, PageHeader, Segmented } from '../components/kit';
import { deviceText } from '../components/bits';
import { BLUETOOTH_UNAVAILABLE, WIRED_NOTE } from '../copy';
import { fmtDateTime, fmtDuration } from '../measured';
import { useController, useProfile, useProfileInfo, useServices, useSettings, useAsync } from '../state/app';
import { useStarter } from '../state/start';

export function Home({ navigate }: { navigate: (to: string) => void }) {
  const { controller, storage } = useServices();
  const st = useController();
  const profile = useProfile();
  const info = useProfileInfo();
  const settings = useSettings();
  const { settings: settingsStore } = useServices();
  const { begin } = useStarter(navigate);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recs = useAsync(() => storage.listRecordings(), []);
  const sessions = useAsync(() => storage.listSessions(profile?.userId), [st.finished?.sessionId, profile?.userId]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const ready = st.link?.kind === 'live' && st.engine === 'ready';
  const waiting = st.link?.kind === 'live' && st.engine !== 'ready' && (st.muse.state === 'streaming' || st.strap.state === 'streaming');
  const museBusy = ['requesting', 'connecting', 'starting'].includes(st.muse.state);
  const strapBusy = ['requesting', 'connecting', 'starting'].includes(st.strap.state);
  const rec = profile ? recommendPrograms(profile)[0] : undefined;
  const recProgram = rec ? getProgram(rec.programId) : undefined;
  const muse = deviceText(st.muse, 'Headset');
  const strap = deviceText(st.strap, 'Chest strap');

  const openFile = async (file: File) => {
    await run('replay', async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await controller.startReplay(bytes, { label: file.name });
      navigate('session');
    });
  };

  return (
    <div>
      <PageHeader title="Hurricane Brain" sub="Brainwave and heart biofeedback. Measured values only: when something cannot be measured, the app says so." />
      <div className="row split" style={{ marginBottom: 12 }}>
        <span data-testid="active-person">Training as <strong>{info.name}</strong></span>
        <Button size="small" variant="ghost" onClick={() => navigate('profiles')}>Change person</Button>
      </div>

      {st.session ? (
        <Card>
          <h2>Session in progress</h2>
          <p className="dim">{st.session.programName}</p>
          <Button variant="primary" size="big" block onClick={() => navigate('session')}>
            Return to the session
          </Button>
        </Card>
      ) : null}

      {!st.bluetooth ? <Note tone="warn">{BLUETOOTH_UNAVAILABLE}</Note> : null}
      {error ? <Note tone="bad">{error}</Note> : null}

      <Card>
        <h2>Devices</h2>
        <div className="stack">
          <div className="row split">
            <div>
              <strong>Headset</strong>
              <div className="small dim">
                {st.muse.name ? `${st.muse.name}. ` : ''}
                <span>{muse.text}</span>
                {st.muse.battery !== null ? <span> . battery {Math.round(st.muse.battery)}%</span> : null}
              </div>
            </div>
            <div className="row">
              <Badge tone={muse.tone}>{st.muse.state === 'none' ? 'off' : st.muse.state}</Badge>
              <Button disabled={!st.bluetooth || museBusy || busy !== null || st.muse.state === 'streaming'} onClick={() => run('muse', () => controller.connectMuse())}>
                {st.muse.state === 'streaming' ? 'Connected' : museBusy ? 'Connecting' : 'Connect headset'}
              </Button>
            </div>
          </div>
          <div className="row split">
            <div>
              <strong>Chest strap</strong> <span className="dim small">(optional, for heart rate and variability)</span>
              <div className="small dim">
                {st.strap.name ? `${st.strap.name}. ` : ''}
                {strap.text}
                {st.strap.battery !== null ? ` . battery ${Math.round(st.strap.battery)}%` : ''}
              </div>
            </div>
            <div className="row">
              <Badge tone={strap.tone}>{st.strap.state === 'none' ? 'off' : st.strap.state}</Badge>
              <Button disabled={!st.bluetooth || strapBusy || busy !== null || st.strap.state === 'streaming'} onClick={() => run('strap', () => controller.connectStrap())}>
                {st.strap.state === 'streaming' ? 'Connected' : strapBusy ? 'Connecting' : 'Connect chest strap'}
              </Button>
            </div>
          </div>
          {st.bluetooth && st.muse.state === 'none' && st.strap.state === 'none' ? (
            <div className="row">
              <Button size="small" variant="ghost" onClick={() => run('heart', () => controller.connectStrap({ heartOnly: true }))}>
                Use the chest strap on its own (heart only)
              </Button>
            </div>
          ) : null}
          <p className="small dim">{WIRED_NOTE} Chrome asks you to choose a device each time, and the buttons must be tapped, not triggered automatically.</p>
          {st.notice ? (
            <Note tone="warn">
              {st.notice}{' '}
              <Button size="small" variant="ghost" onClick={() => controller.dismissNotice()}>
                Dismiss
              </Button>
            </Note>
          ) : null}
          {(st.muse.state !== 'none' || st.strap.state !== 'none') && !st.session ? (
            <div className="row">
              <Button size="small" variant="ghost" onClick={() => run('disc', () => controller.disconnect())}>
                Disconnect
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <h2>Start</h2>
        <div className="stack">
          <Button variant="primary" size="big" block disabled={!ready || busy !== null || !!st.session} onClick={() => run('quick', () => begin({ kind: 'free' }))}>
            Quick start: free session
          </Button>
          <p className="small dim">
            {ready
              ? 'One tap. The hurricane and the sound follow what is measured. Nothing needs looking at; eyes-closed mode dims the screen.'
              : waiting
                ? 'Connected. Waiting for the first seconds of data so the engine can start.'
                : st.link?.kind === 'replay'
                  ? 'A replay is open. Close it to connect a headset.'
                  : 'Connect a headset (or chest strap) to start. Without a device you can replay a recording below.'}
          </p>
          <div className="row">
            <Button onClick={() => navigate('fit')}>Check fit and signal</Button>
            {st.engine === 'error' ? <Badge tone="bad">Engine problem</Badge> : null}
          </div>
        </div>
      </Card>

      {recProgram && rec ? (
        <Card>
          <h2>Recommended next</h2>
          <h3>{recProgram.name}</h3>
          <p className="dim">{rec.reason}</p>
          <div className="row">
            <Button onClick={() => navigate(`programs/${recProgram.id}`)}>Open and adjust</Button>
            <Button
              variant="primary"
              disabled={!ready || busy !== null || !!st.session}
              onClick={() =>
                run('prog', () => begin({ kind: 'program', req: { programId: recProgram.id } }))
              }
            >
              Start with defaults
            </Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <h2>Replay a recording</h2>
        <p className="dim">
          Replay runs a recorded session through the real engine, by the same path as a live headset. No device is needed.
        </p>
        <input
          ref={fileRef}
          type="file"
          hidden
          aria-label="Choose a recording file"
          accept=".hbraw,application/octet-stream"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void openFile(f);
          }}
        />
        <div className="row">
          <Button disabled={busy !== null || !!st.session} onClick={() => fileRef.current?.click()}>
            Open a recording file
          </Button>
          <Segmented
            label="Replay speed"
            value={settings.replaySpeed}
            onChange={(v) => settingsStore.update({ replaySpeed: v })}
            options={[{ value: 1, label: '1x with sound' }, { value: 4, label: '4x' }, { value: 'fast', label: 'As fast as possible' }]}
          />
        </div>
        <p className="small dim">Faster speeds play without sound.</p>
        {recs.data && recs.data.length ? (
          <div className="stack" style={{ marginTop: 14 }}>
            <h4>Recorded on this device</h4>
            {recs.data.slice(0, 5).map((r) => (
              <div key={r.id} className="row split">
                <div>
                  <div>{r.label}</div>
                  <div className="small dim">
                    {fmtDateTime(r.createdAt)} . {fmtDuration(r.durationS)} . {r.sessions.map((s) => s.programName).join(', ') || 'no session'}
                  </div>
                </div>
                <Button
                  size="small"
                  disabled={busy !== null || !!st.session}
                  onClick={() =>
                    run('replay', async () => {
                      const bytes = await storage.getRecordingBytes(r.id);
                      if (!bytes) throw new Error('That recording is no longer on this device.');
                      await controller.startReplay(bytes, { label: r.label, sessionId: r.sessions[0]?.sessionId ?? null });
                      navigate('session');
                    })
                  }
                >
                  Replay
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      {sessions.data && sessions.data.length ? (
        <Card>
          <h2>Last session</h2>
          <div className="row split">
            <div>
              <div>{sessions.data[0].programName}</div>
              <div className="small dim">{fmtDateTime(sessions.data[0].startedAt)}</div>
            </div>
            <Button size="small" onClick={() => navigate(`history/${sessions.data?.[0].id}`)}>
              Open
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
