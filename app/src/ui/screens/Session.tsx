import { useEffect, useMemo, useState } from 'react';
import { HurricaneView, SpectrumView } from '../../viz';
import type { RatingKey } from '../../training';
import { BlockTable } from '../components/BlockTable';
import { CascadeStates, GoldenRatioInfo } from '../components/Cascades';
import { JournalForm } from '../components/Journal';
import { PHOTOSENSITIVITY } from '../copy';
import { Button, Card, Modal, Note, Segmented } from '../components/kit';
import { AlignmentTrio, HeartLine, PeaksLine, SignalLine, useLive } from '../components/LiveReadout';
import { HemisphereTable, PairTable } from '../components/LiveDetails';
import { summarizeSignal, fmtDuration } from '../measured';
import { useController, useServices, useSettings } from '../state/app';
import { deviceText } from '../components/bits';

type Panel = 'none' | 'spectrum' | 'details' | 'signal';

const RATING_TEXT: Record<RatingKey, { q: string; lo: string; hi: string }> = {
  ease: { q: 'How easy was that?', lo: 'hard', hi: 'easy' },
  depth: { q: 'How deep did it feel?', lo: 'shallow', hi: 'deep' },
  pleasantness: { q: 'How pleasant was it?', lo: 'unpleasant', hi: 'pleasant' },
  emotion_intensity: { q: 'How strongly did you feel it?', lo: 'barely', hi: 'strongly' },
  calm: { q: 'How calm do you feel?', lo: 'not calm', hi: 'very calm' },
  alertness: { q: 'How alert do you feel?', lo: 'drowsy', hi: 'alert' },
};

function RatingSheet({ keys, onDone }: { keys: RatingKey[]; onDone: (r: Partial<Record<RatingKey, number>>) => void }) {
  const [vals, setVals] = useState<Partial<Record<RatingKey, number>>>({});
  const set = (k: RatingKey, v: number) => {
    const next = { ...vals, [k]: v };
    setVals(next);
    if (keys.every((x) => next[x] !== undefined)) onDone(next);
  };
  return (
    <div className="stack" role="group" aria-label="Rate the last block">
      {keys.map((k) => (
        <div key={k}>
          <div style={{ marginBottom: 6 }}>{RATING_TEXT[k].q}</div>
          <div className="ratebtns">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" aria-pressed={vals[k] === n} aria-label={`${RATING_TEXT[k].q} ${n} of 5`} onClick={() => set(k, n)}>
                {n}
              </button>
            ))}
          </div>
          <div className="row split small" style={{ color: 'var(--live-subtle)' }}>
            <span>1 {RATING_TEXT[k].lo}</span>
            <span>5 {RATING_TEXT[k].hi}</span>
          </div>
        </div>
      ))}
      <Button variant="ghost" onClick={() => onDone(vals)}>
        Skip
      </Button>
    </div>
  );
}

function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let lock: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    const get = async () => {
      try {
        const l = await nav.wakeLock?.request('screen');
        if (l && !cancelled) lock = l;
        else await l?.release();
      } catch {
        /* not available or refused: the screen may dim, which is fine */
      }
    };
    void get();
    const onVis = () => document.visibilityState === 'visible' && void get();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release();
    };
  }, [on]);
}

/** The screen shown after a live session: what happened, and the short journal. */
function FinishedPanel({ navigate }: { navigate: (to: string) => void }) {
  const { controller } = useServices();
  const st = useController();
  const f = st.finished;
  if (!f) return null;
  return (
    <div className="stack">
      <Card>
        <h2>Session finished</h2>
        <p className="dim" data-testid="finished-summary">
          {f.programName} . {f.completed ? 'completed' : 'ended early'} . {fmtDuration(f.elapsedS)}
          {f.stored ? ' . saved on this device' : ''}
        </p>
        {f.record ? <BlockTable record={f.record} /> : <p className="dim">A free session has no blocks. Its per-second measures and cascade events are in History.</p>}
        {st.notice ? <Note tone="warn">{st.notice}</Note> : null}
      </Card>
      {f.stored && f.journalOpen ? (
        <Card>
          <JournalForm nowIso={() => new Date().toISOString()} onSave={(j) => void controller.submitJournal(j)} onSkip={() => void controller.submitJournal(null)} />
        </Card>
      ) : f.journal ? (
        <Card><p className="dim">Journal saved with the session.</p></Card>
      ) : null}
      <div className="row">
        {f.stored ? (
          <Button variant="primary" onClick={() => { controller.dismissFinished(); navigate(`history/${f.sessionId}`); }}>Open in History</Button>
        ) : null}
        <Button onClick={() => { controller.dismissFinished(); navigate('home'); }}>Done</Button>
      </div>
    </div>
  );
}

export function Session({ navigate }: { navigate: (to: string) => void }) {
  const { controller, view, settings: settingsStore } = useServices();
  const st = useController();
  const settings = useSettings();
  const live = useLive();
  const [panel, setPanel] = useState<Panel>('none');
  const [site, setSite] = useState('temporal');
  const [eyesClosed, setEyesClosed] = useState(() => settings.soundOnly);
  const [confirmStop, setConfirmStop] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const s = st.session;
  const replay = st.replay;
  const fin = st.finished;
  useWakeLock(!!s && settings.keepScreenOn);

  const sig = summarizeSignal(live.slow);
  const motion = settings.reducedMotion === 'on' ? 'reduced' : settings.reducedMotion === 'off' ? 'full' : 'auto';
  const hurricane = useMemo(
    () => <HurricaneView source={view} quality={settings.vizQuality} chance={settings.chanceDriver} motion={motion} />,
    [view, settings.vizQuality, settings.chanceDriver, motion],
  );

  // A live session that has ended shows its summary and journal. A replay keeps the live screen.
  if (!s && !replay) {
    return fin ? <FinishedPanel navigate={navigate} /> : (
      <Card>
        <h2>No session running</h2>
        <p className="dim">Start a free session or a program from Home, or open a recording to replay.</p>
        <Button variant="primary" onClick={() => navigate('home')}>Go to Home</Button>
      </Card>
    );
  }

  const isReplay = s ? s.mode === 'replay' : true;
  const replayDone = !s && !!replay && (replay.ended || !!fin);
  const out = s?.output ?? null;
  const block = out?.block ?? null;
  const museState = deviceText(st.muse, 'Headset');
  const reconnecting = st.muse.state === 'reconnecting' || st.strap.state === 'reconnecting';
  const heartExpected = st.strap.state === 'streaming' || st.strap.state === 'reconnecting' || (st.streams?.chest_strap ?? null) !== null;
  const title = replayDone ? 'Replay finished' : s ? (s.blockTitle ?? s.programName) : (replay?.label ?? 'Replay');
  const elapsed = s ? s.elapsedS : (fin?.elapsedS ?? null);
  const exitReplay = () => {
    void controller.closeReplay();
    navigate('home');
  };

  return (
    <div className="live" data-testid="live-session" data-state={replayDone ? 'finished' : 'running'}>
      <div className="live-stage">
        {hurricane}
        <div className="live-top">
          {replayDone ? (
            <Button size="small" variant="primary" onClick={exitReplay} aria-label="Exit the replay">Exit</Button>
          ) : (
            <Button size="small" variant="danger" onClick={() => setConfirmStop(true)} aria-label={isReplay ? 'Close replay' : 'Stop session'}>
              {isReplay ? 'Close' : 'Stop'}
            </Button>
          )}
          <div className="title">
            {isReplay && !replayDone ? 'Replay: ' : ''}
            {title}
            <small>
              {elapsed !== null ? fmtDuration(elapsed) : ''}
              {block ? ` . block ${block.index + 1}${out?.blockRemainingS != null ? `, ${fmtDuration(out.blockRemainingS)} left` : ''}` : ''}
              {block && !block.feedback ? ' . sound is not following you in this block' : ''}
            </small>
          </div>
          <Button size="small" onClick={() => setEyesClosed(true)} aria-label="Eyes closed mode: dim the screen">
            Eyes closed
          </Button>
        </div>
        <div className="live-guide" aria-live="polite">
          {s?.tether ? <div className="tether">{s.tether}</div> : null}
          {s?.guidance}
        </div>
      </div>

      <div className="live-dock">
        {replayDone ? (
          <div className="live-banner" data-testid="replay-finished" role="status">
            <strong>{replay?.error ? 'The recording could not be played.' : 'The recording has ended.'}</strong>{' '}
            <span className="live-sub">
              {replay?.error ? replay.error : 'Frames have stopped, so the picture has dissolved and nothing is measured now. The numbers below show not measured.'}
            </span>
            <div className="row" style={{ marginTop: 8 }}>
              <Button size="small" variant="primary" onClick={exitReplay}>Exit</Button>
              <span className="live-sub small">Play again:</span>
              <Button size="small" onClick={() => void controller.replayAgain(1)}>1x with sound</Button>
              <Button size="small" onClick={() => void controller.replayAgain(4)}>4x</Button>
              <Button size="small" onClick={() => void controller.replayAgain('fast')}>As fast as possible (no sound)</Button>
            </div>
          </div>
        ) : null}
        {reconnecting ? <Note tone="warn">Reconnecting to the device ({museState.text}). Values show as not measured until data returns.</Note> : null}
        {s?.checkFit ? (
          <Note tone="warn">
            The signal has been poor for a while. Check the fit of the band.{' '}
            <Button size="small" onClick={() => setPanel('signal')}>
              Show signal check
            </Button>
          </Note>
        ) : null}
        {s?.guideOffNotice ? <Note>This block uses a breathing guide at {s.pacerBpm} breaths a minute. The guide sound is off; you can turn it on in Settings. It is a guide, not a measurement.</Note> : s?.pacerBpm ? <Note>Breath guide: {s.pacerBpm} breaths a minute (a guide, not a measurement).</Note> : null}

        {s?.ratingRequest && !isReplay ? (
          <div style={{ margin: '8px 0 12px' }}>
            <RatingSheet keys={s.ratingRequest.keys} onDone={(r) => controller.rate(r)} />
          </div>
        ) : null}

        {panel === 'spectrum' ? (
          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <Segmented label="Spectrum site" value={site} onChange={setSite} options={['temporal', 'frontal', 'all', 'TP9', 'AF7', 'AF8', 'TP10'].map((v) => ({ value: v, label: v }))} />
            </div>
            <div className="live-panel">
              <SpectrumView source={controller.hub} site={site} />
            </div>
          </div>
        ) : null}
        {panel === 'details' ? (
          <div className="stack" style={{ marginBottom: 8 }}>
            <h4>Pairs and the controls</h4>
            <PairTable slow={live.slow} />
            <h4>Left and right</h4>
            <HemisphereTable slow={live.slow} />
            <p className="small dim">
              Mains {live.slow?.mains_hz ?? 'detecting'} Hz . individual alpha {live.slow?.iaf_hz != null ? `${live.slow.iaf_hz.toFixed(2)} Hz` : 'not set'} . the hurricane and blooms follow chance {settings.chanceDriver.toUpperCase()}.
            </p>
          </div>
        ) : null}
        {panel === 'signal' ? (
          <div className="stack" style={{ marginBottom: 8 }}>
            {sig.channels.length ? (
              sig.channels.map((c) => (
                <div key={c.name} className="small">
                  <strong>{c.name}</strong>: {c.usable ? 'usable' : `${c.reason}. ${c.fix ?? ''}`}
                </div>
              ))
            ) : (
              <p className="dim">Signal not measured (no frames arriving).</p>
            )}
          </div>
        ) : null}

        <AlignmentTrio live={live} chanceDriver={settings.chanceDriver} />
        <CascadeStates live={live} />
        <div className="chips" style={{ marginTop: 8 }}>
          <SignalLine live={live} />
          <PeaksLine live={live} />
          <HeartLine live={live} heartExpected={heartExpected} />
        </div>
        <div style={{ marginTop: 8 }} className="small"><GoldenRatioInfo /></div>

        <div className="live-tabs" role="group" aria-label="Panels">
          {(['spectrum', 'details', 'signal'] as const).map((p) => (
            <button key={p} type="button" aria-pressed={panel === p} onClick={() => setPanel(panel === p ? 'none' : p)}>
              {p === 'spectrum' ? 'Spectrum' : p === 'details' ? 'Pairs' : 'Signal'}
            </button>
          ))}
          {s && !isReplay ? (
            <button type="button" onClick={() => setNoteOpen(true)}>
              Mark moment
            </button>
          ) : null}
          {s && s.kind === 'program' && !isReplay ? (
            <button type="button" onClick={() => controller.skipBlock()}>
              Skip block
            </button>
          ) : null}
          {s && !isReplay ? (
            <button type="button" aria-pressed={!st.soundOn} onClick={() => controller.setSoundOn(!st.soundOn)}>
              {st.soundOn ? 'Sound on' : 'Sound off'}
            </button>
          ) : null}
          {s && s.kind === 'free' && !isReplay ? (
            <button type="button" aria-pressed={s.pacerBpm !== null} onClick={() => controller.setFreeBreathGuide(s.pacerBpm === null ? 6 : null)}>
              {s.pacerBpm === null ? 'Breath guide (6/min)' : 'Breath guide on'}
            </button>
          ) : null}
        </div>
        {s && out && out.feedback && s.kind === 'program' ? (
          <p className="small" style={{ color: 'var(--live-subtle)' }}>
            Reward level {Math.round(out.reward.level * 100)}%{out.reward.gated ? `, withheld (${out.reward.why ?? 'gated'})` : ''} (from your measurements, smoothed over {out.reward.tauS} s).
          </p>
        ) : null}
        {replayDone && fin?.record ? <BlockTable record={fin.record} /> : null}
      </div>

      {eyesClosed ? (
        <button
          type="button"
          className="eyes-closed"
          style={{ opacity: 1 - Math.min(0.5, settings.eyesClosedLevel) }}
          onClick={() => setEyesClosed(false)}
          aria-label="Screen is dark. Tap anywhere to look at the screen again."
        >
          <span>tap to look</span>
        </button>
      ) : null}

      {!settings.photoNoticeSeen && !eyesClosed ? (
        <Modal
          title="Before the picture"
          onClose={() => settingsStore.update({ photoNoticeSeen: true })}
          actions={
            <>
              <Button onClick={() => { settingsStore.update({ photoNoticeSeen: true, soundOnly: true }); setEyesClosed(true); }}>Sound only, screen dark</Button>
              <Button variant="primary" onClick={() => settingsStore.update({ photoNoticeSeen: true })}>Continue</Button>
            </>
          }
        >
          <ul>{PHOTOSENSITIVITY.map((t) => <li key={t} style={{ marginBottom: 8 }}>{t}</li>)}</ul>
        </Modal>
      ) : null}

      {noteOpen ? (
        <Modal
          title="Mark this moment"
          onClose={() => setNoteOpen(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setNoteOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  controller.addNote(noteText.trim() || 'marked moment');
                  setNoteText('');
                  setNoteOpen(false);
                }}
              >
                Save mark
              </Button>
            </>
          }
        >
          <input type="text" aria-label="Note" placeholder="What is happening (optional)" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
        </Modal>
      ) : null}

      {confirmStop ? (
        <Modal
          title={isReplay ? 'Close the replay?' : 'Stop the session?'}
          onClose={() => setConfirmStop(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirmStop(false)}>Keep going</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmStop(false);
                  if (isReplay) exitReplay();
                  else void controller.stop();
                }}
              >
                {isReplay ? 'Close replay' : 'Stop and save'}
              </Button>
            </>
          }
        >
          <p className="dim">{isReplay ? 'Nothing from a replay is saved.' : 'What was measured so far is saved on this device.'}</p>
        </Modal>
      ) : null}
    </div>
  );
}
