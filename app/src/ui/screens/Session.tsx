import { useEffect, useMemo, useState } from 'react';
import { HurricaneView, SpectrumView } from '../../viz';
import type { RatingKey } from '../../training';
import { BlockTable } from '../components/BlockTable';
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
          <div className="row split small" style={{ color: '#8ea0bb' }}>
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

export function Session({ navigate }: { navigate: (to: string) => void }) {
  const { controller, view } = useServices();
  const st = useController();
  const settings = useSettings();
  const live = useLive();
  const [panel, setPanel] = useState<Panel>('none');
  const [site, setSite] = useState('temporal');
  const [eyesClosed, setEyesClosed] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const s = st.session;
  const replayActive = st.replay !== null;
  useWakeLock(!!s && settings.keepScreenOn);

  const sig = summarizeSignal(live.slow);
  const hurricane = useMemo(() => <HurricaneView source={view} quality={settings.vizQuality} />, [view, settings.vizQuality]);

  // After the session ends or the replay is closed, there is nothing left to show here.
  if (!s && !st.finished && !replayActive) {
    return (
      <Card>
        <h2>No session running</h2>
        <p className="dim">Start a free session or a program from Home, or open a recording to replay.</p>
        <Button variant="primary" onClick={() => navigate('home')}>Go to Home</Button>
      </Card>
    );
  }

  if (!s) {
    const f = st.finished;
    return (
      <div className="stack">
        <Card>
          <h2>{replayActive ? 'Replay finished' : 'Session finished'}</h2>
          {f ? (
            <>
              <p className="dim">
                {f.programName} . {f.completed ? 'completed' : 'ended early'}
                {f.stored ? ' . saved on this device' : ' . replays are not saved or added to your profile'}
              </p>
              {f.record ? <BlockTable record={f.record} /> : <p className="dim">A free session has no blocks. Its per-second measures are in History.</p>}
            </>
          ) : st.replay && !st.replay.ended ? (
            <p className="dim">Replaying {st.replay.label}. Waiting for the recording to start.</p>
          ) : (
            <p className="dim">{st.replay?.error ? `The recording could not be played: ${st.replay.error}` : 'The recording has ended. Frames have stopped, so nothing is measured now.'}</p>
          )}
          {st.notice ? <Note tone="warn">{st.notice}</Note> : null}
          <div className="row">
            {f?.stored ? (
              <Button variant="primary" onClick={() => { controller.dismissFinished(); navigate(`history/${f.sessionId}`); }}>
                Open in History
              </Button>
            ) : null}
            <Button
              onClick={() => {
                const wasReplay = replayActive;
                controller.dismissFinished();
                if (wasReplay) void controller.closeReplay();
                navigate('home');
              }}
            >
              Done
            </Button>
          </div>
        </Card>
        {replayActive && st.replay && !st.replay.ended ? (
          <div className="live" style={{ position: 'relative', height: 360, borderRadius: 14, overflow: 'hidden' }}>
            <div className="live-stage">{hurricane}</div>
          </div>
        ) : null}
      </div>
    );
  }

  const out = s.output;
  const block = out?.block ?? null;
  const museState = deviceText(st.muse, 'Headset');
  const reconnecting = st.muse.state === 'reconnecting' || st.strap.state === 'reconnecting';
  const heartExpected = st.strap.state === 'streaming' || st.strap.state === 'reconnecting' || (st.streams?.chest_strap ?? null) !== null;
  const isReplay = s.mode === 'replay';

  return (
    <div className="live" data-testid="live-session">
      <div className="live-stage">
        {hurricane}
        <div className="live-top">
          <Button size="small" variant="danger" onClick={() => setConfirmStop(true)} aria-label={isReplay ? 'Close replay' : 'Stop session'}>
            {isReplay ? 'Close' : 'Stop'}
          </Button>
          <div className="title">
            {isReplay ? 'Replay: ' : ''}
            {s.blockTitle ?? s.programName}
            <small>
              {fmtDuration(s.elapsedS)}
              {block ? ` . block ${block.index + 1}${out?.blockRemainingS != null ? `, ${fmtDuration(out.blockRemainingS)} left` : ''}` : ''}
              {block && !block.feedback ? ' . sound is not following you in this block' : ''}
            </small>
          </div>
          <Button size="small" onClick={() => setEyesClosed(true)} aria-label="Eyes closed mode: dim the screen">
            Eyes closed
          </Button>
        </div>
        <div className="live-guide" aria-live="polite">
          {s.tether ? <div className="tether">{s.tether}</div> : null}
          {s.guidance}
        </div>
      </div>

      <div className="live-dock">
        {reconnecting ? <Note tone="warn">Reconnecting to the device ({museState.text}). Values show as not measured until data returns.</Note> : null}
        {s.checkFit ? (
          <Note tone="warn">
            The signal has been poor for a while. Check the fit of the band.{' '}
            <Button size="small" onClick={() => setPanel('signal')}>
              Show signal check
            </Button>
          </Note>
        ) : null}
        {s.guideOffNotice ? <Note>This block uses a breathing guide at {s.pacerBpm} breaths a minute. The guide sound is off; you can turn it on in Settings. It is a guide, not a measurement.</Note> : s.pacerBpm ? <Note>Breath guide: {s.pacerBpm} breaths a minute (a guide, not a measurement).</Note> : null}

        {s.ratingRequest && !isReplay ? (
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
              Mains {live.slow?.mains_hz ?? 'detecting'} Hz . individual alpha {live.slow?.iaf_hz != null ? `${live.slow.iaf_hz.toFixed(2)} Hz` : 'not set'} . the hurricane follows chance {settings.chanceDriver.toUpperCase()}.
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
        <div className="chips" style={{ marginTop: 8 }}>
          <SignalLine live={live} />
          <PeaksLine live={live} />
          <HeartLine live={live} heartExpected={heartExpected} />
        </div>

        <div className="live-tabs" role="group" aria-label="Panels">
          {(['spectrum', 'details', 'signal'] as const).map((p) => (
            <button key={p} type="button" aria-pressed={panel === p} onClick={() => setPanel(panel === p ? 'none' : p)}>
              {p === 'spectrum' ? 'Spectrum' : p === 'details' ? 'Pairs' : 'Signal'}
            </button>
          ))}
          {!isReplay ? (
            <button type="button" onClick={() => setNoteOpen(true)}>
              Mark moment
            </button>
          ) : null}
          {s.kind === 'program' && !isReplay ? (
            <button type="button" onClick={() => controller.skipBlock()}>
              Skip block
            </button>
          ) : null}
          {!isReplay ? (
            <button type="button" aria-pressed={!st.soundOn} onClick={() => controller.setSoundOn(!st.soundOn)}>
              {st.soundOn ? 'Sound on' : 'Sound off'}
            </button>
          ) : null}
          {s.kind === 'free' && !isReplay ? (
            <button type="button" aria-pressed={s.pacerBpm !== null} onClick={() => controller.setFreeBreathGuide(s.pacerBpm === null ? 6 : null)}>
              {s.pacerBpm === null ? 'Breath guide (6/min)' : 'Breath guide on'}
            </button>
          ) : null}
        </div>
        {out && out.feedback && s.kind === 'program' ? (
          <p className="small" style={{ color: '#8ea0bb' }}>
            Reward level {Math.round(out.reward.level * 100)}%{out.reward.gated ? `, withheld (${out.reward.why ?? 'gated'})` : ''} (from your measurements, smoothed over {out.reward.tauS} s).
          </p>
        ) : null}
      </div>

      {eyesClosed ? (
        <button
          type="button"
          className="eyes-closed"
          style={{ opacity: 1 - Math.min(0.5, settings.eyesClosedLevel) }}
          onClick={() => setEyesClosed(false)}
          aria-label="Eyes closed mode. Tap anywhere to look at the screen again."
        >
          <span>tap to look</span>
        </button>
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
                  if (isReplay) {
                    void controller.closeReplay();
                    navigate('home');
                  } else void controller.stop();
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

