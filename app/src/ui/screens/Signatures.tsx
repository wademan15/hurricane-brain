import { useMemo, useState } from 'react';
import { anchorCandidates, anchorDurationS, type AnchorSynthParams } from '../../audio/anchors';
import {
  anchorEligibility, createAnchor, deriveSeed, describeSignature, evaluateAnchor, getProgram, readyForProbe, signatureReach, validPairings, controlExposuresOwed,
  type AnchorRecord, type AnchorVerdict, type Signature, type SynthParams, type UserProfile,
} from '../../training';
import { neutralControlFor } from '../../audio/anchors';
import { Badge, Button, Card, Field, Modal, Note, PageHeader } from '../components/kit';
import { StartButton } from '../components/StartButton';
import { fmtDateTime, notMeasuredText, numberLine } from '../measured';
import { relearnSignature } from '../state/stores';
import { useController, useProfile, useServices } from '../state/app';

const EMOTIONS = getProgram('emotional_state_practice')?.variables.find((v) => v.id === 'emotion')?.options ?? [];
const emotionLabel = (id: string) => EMOTIONS.find((o) => o.value === id)?.label ?? id;

const FIELD_LABEL: Record<string, string> = {
  'spectra[temporal].bands.alpha.above_bg_db': 'alpha at the ears',
  'spectra[temporal].bands.theta.above_bg_db': 'theta at the ears',
  'spectra[temporal].bands.beta.above_bg_db': 'beta at the ears',
  'spectra[frontal].bands.alpha.above_bg_db': 'alpha on the forehead',
  'diff(spectra[AF8].bands.alpha.above_bg_db, spectra[AF7].bands.alpha.above_bg_db)': 'right-left forehead alpha',
  'spectra[temporal].bg_exponent': 'background slope',
  'quality[*].emg_db': 'muscle tension',
  'heart.hr_bpm': 'heart rate',
  'heart.rmssd_ms': 'heart variability (RMSSD)',
  'heart.resonance_strength': 'heart rhythm resonance',
};

function SignatureCard({ profile, state, sig, navigate }: { profile: UserProfile; state: string; sig: Signature | null; navigate: (to: string) => void }) {
  const { profile: store } = useServices();
  const blocks = profile.signatureBlocks[state] ?? [];
  const stateBlocks = blocks.filter((b) => b.label === 'state').length;
  const contrast = blocks.length - stateBlocks;
  const sessions = new Set(blocks.map((b) => b.sessionId)).size;
  const days = new Set(blocks.map((b) => b.day)).size;
  const v = sig?.validation;
  return (
    <Card>
      <div className="row split">
        <h3 style={{ margin: 0 }}>{emotionLabel(state)}</h3>
        {sig ? <Badge tone={sig.status === 'reliable' ? 'ok' : 'warn'}>{sig.status === 'reliable' ? 'Reliable' : 'Still learning'}</Badge> : <Badge>No signature yet</Badge>}
      </div>
      <p className="dim">
        {stateBlocks} feeling block{stateBlocks === 1 ? '' : 's'} and {contrast} comparison block{contrast === 1 ? '' : 's'}, from {sessions} session{sessions === 1 ? '' : 's'} on {days} day{days === 1 ? '' : 's'}.
      </p>
      {sig ? (
        <>
          <p>{describeSignature(sig)}</p>
          <details>
            <summary>What it is made of, and how it was tested</summary>
            <h4>The measurements that separate this feeling from comparison for you</h4>
            <ul>
              {sig.fields.map((f) => (
                <li key={f.field}>
                  {FIELD_LABEL[f.field] ?? f.field}: {f.direction > 0 ? 'higher' : 'lower'} in the feeling (typically {f.stateRange[0].toFixed(1)} to {f.stateRange[1].toFixed(1)}), separation {f.d.toFixed(2)}, same direction in {Math.round(f.consistency * 100)}% of sessions
                </li>
              ))}
            </ul>
            {v ? (
              <dl className="kv">
                <dt>Held-out separation (1 = perfect, 0.5 = chance)</dt><dd>{numberLine(v.heldOutAuc)}</dd>
                <dt>Shuffled-label 95th percentile</dt><dd>{numberLine(v.nullAuc95)}</dd>
                <dt>p against shuffled labels</dt><dd>{numberLine(v.p)}</dd>
                <dt>Sessions, days</dt><dd>{v.nSessions}, {v.nDays}</dd>
              </dl>
            ) : null}
            <p className="small dim">To be called reliable the signature must separate feeling from comparison on sessions it was not built from, better than shuffled labels, over at least three different days. False entries when you are not in the state: about {numberLine(sig.detection.falseEntriesPer10Min, 'per 10 min')}.</p>
            {sig.history.length ? (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
                <table>
                  <thead><tr><th>Checked</th><th>Status</th><th>Held-out</th><th>p</th><th>Sessions</th><th>Days</th></tr></thead>
                  <tbody>
                    {sig.history.slice().reverse().map((h) => (
                      <tr key={h.at}><td>{fmtDateTime(h.at)}</td><td>{h.status === 'reliable' ? 'reliable' : 'still learning'}</td><td>{numberLine(h.heldOutAuc)}</td><td>{numberLine(h.p)}</td><td>{h.nSessions}</td><td>{h.nDays}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </details>
        </>
      ) : (
        <p className="dim">A signature appears once there are at least two sessions with both feeling and comparison blocks and something separates them.</p>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <StartButton req={{ programId: 'emotional_state_practice', values: { emotion: state } }} navigate={navigate} variant="default">Practise {emotionLabel(state).toLowerCase()}</StartButton>
        {blocks.length ? <Button onClick={() => void store.put(relearnSignature(profile, state, new Date().toISOString()))}>Check the signature again</Button> : null}
      </div>
    </Card>
  );
}

const VERDICT: Record<AnchorVerdict, { text: string; tone: 'ok' | 'warn' | 'default' }> = {
  working: { text: 'Working, for you', tone: 'ok' },
  not_distinguishable: { text: 'Not distinguishable from the control', tone: 'warn' },
  weaker_than_control: { text: 'Weaker than the control', tone: 'warn' },
  too_few_trials: { text: 'Too few trials to say', tone: 'default' },
};

function describeCandidate(p: AnchorSynthParams): string {
  return `${Math.round(p.basePitchHz)} Hz, ${p.intervals.length} voice${p.intervals.length === 1 ? '' : 's'}, ${p.brightness < 0.35 ? 'soft' : p.brightness < 0.7 ? 'warm' : 'reedy'}, ${anchorDurationS(p).toFixed(0)} s`;
}

function AnchorCard({ a, profile, navigate }: { a: AnchorRecord; profile: UserProfile; navigate: (to: string) => void }) {
  const { controller, profile: store } = useServices();
  const ev = evaluateAnchor(a);
  const [err, setErr] = useState<string | null>(null);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const setRetired = (retired: boolean) => void store.put({ ...profile, anchors: profile.anchors.map((x) => (x.id === a.id ? { ...x, retired } : x)) });
  const play = async (control: boolean) => {
    setErr(null);
    try {
      const audio = controller.getAudio();
      await audio.start();
      audio.playAnchor((control ? a.control.synth : a.synth) as unknown as AnchorSynthParams);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const probeReady = readyForProbe(a);
  const row = (label: string, x: typeof ev.anchor) => (
    <tr>
      <td>{label}</td><td>{x.n}</td><td>{numberLine(x.meanDelta)}</td><td>{x.hitRate === null ? notMeasuredText('no_data') : `${Math.round(x.hitRate * 100)}%`}</td><td>{numberLine(x.medianLatencyS, 's')}</td>
    </tr>
  );
  return (
    <Card>
      <div className="row split">
        <h3 style={{ margin: 0 }}>{a.name}</h3>
        <Badge tone={VERDICT[ev.verdict].tone}>{VERDICT[ev.verdict].text}</Badge>
      </div>
      <p className="dim small">For {emotionLabel(a.state)}. Made {fmtDateTime(a.createdAt)}.{a.retired ? ' Retired.' : ''}</p>
      <p>{ev.reading}</p>
      {ev.needsRefresher ? <Note>A refresher pairing session would help keep this link strong.</Note> : null}
      <p className="small dim">{validPairings(a)} valid pairing{validPairings(a) === 1 ? '' : 's'} (the sound plays only while your signature is detected). Control sound plays still owed: {controlExposuresOwed(a)}. Plays outside pairing: {a.unpairedPlays.length}.</p>
      {a.probes.length ? (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
          <table>
            <thead><tr><th>Cue</th><th>Trials</th><th>Mean move toward signature</th><th>Reached it</th><th>Median time to reach</th></tr></thead>
            <tbody>{row('Anchor', ev.anchor)}{row('Control sound', ev.control)}</tbody>
          </table>
          {ev.diff ? <p className="small dim">Anchor minus control: {ev.diff.estimate.toFixed(2)} (95% interval {ev.diff.lo.toFixed(2)} to {ev.diff.hi.toFixed(2)}). The anchor counts as working only when this interval is above zero.</p> : null}
        </div>
      ) : null}
      {err ? <Note tone="bad">{err}</Note> : null}
      <div className="row">
        <Button size="small" onClick={() => void play(false)}>Listen to the anchor</Button>
        <Button size="small" variant="ghost" onClick={() => void play(true)}>Listen to the control</Button>
        <Button size="small" variant="ghost" onClick={() => controller.getAudio().stopAnchor()}>Stop</Button>
      </div>
      {!a.retired ? (
        <div className="row" style={{ marginTop: 8, alignItems: 'flex-start' }}>
          <StartButton req={{ programId: 'anchor_pairing', values: { emotion: a.state }, anchorId: a.id }} navigate={navigate} variant="default">Pairing session</StartButton>
          <div>
            <StartButton req={{ programId: 'anchor_probe', values: { emotion: a.state }, anchorId: a.id }} navigate={navigate} variant="default">Test the anchor</StartButton>
            {!probeReady ? <div className="small dim">Testing is more informative after more valid pairings.</div> : null}
          </div>
          <Button size="small" variant="ghost" onClick={() => setConfirmRetire(true)}>Retire</Button>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 8 }}>
          <Button size="small" onClick={() => setRetired(false)}>Restore this anchor</Button>
        </div>
      )}
      {confirmRetire ? (
        <Modal
          title={`Retire ${a.name}?`}
          onClose={() => setConfirmRetire(false)}
          actions={<>
            <Button variant="ghost" onClick={() => setConfirmRetire(false)}>Keep it</Button>
            <Button variant="danger" onClick={() => { setConfirmRetire(false); setRetired(true); }}>Retire</Button>
          </>}
        >
          <p className="dim">A retired anchor is no longer offered for pairing or testing. Its history is kept, and you can restore it here at any time.</p>
        </Modal>
      ) : null}
    </Card>
  );
}

function CreateAnchor({ profile }: { profile: UserProfile }) {
  const { controller, profile: store } = useServices();
  const st = useController();
  const states = [...new Set([...profile.signatures.map((s) => s.state)])];
  const [state, setState] = useState(states[0] ?? 'calm');
  const [refresh, setRefresh] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const sig = profile.signatures.find((s) => s.state === state) ?? null;
  const elig = anchorEligibility(sig, signatureReach(profile, state));
  const cands = useMemo(
    () => anchorCandidates(deriveSeed(profile.seed, `anchors:${profile.anchors.length}:${refresh}`), 6, profile.anchors.map((a) => a.synth as unknown as AnchorSynthParams), 0.8),
    [profile.seed, profile.anchors, refresh],
  );
  const listen = async (i: number) => {
    setErr(null);
    setPicked(i);
    try {
      const audio = controller.getAudio();
      await audio.start();
      audio.playAnchor(cands[i]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const create = async () => {
    if (picked === null || !sig) return;
    const synth = cands[picked];
    const now = new Date();
    const anchor = createAnchor({
      id: `a_${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
      name: name.trim() || `${emotionLabel(state)} anchor`,
      state,
      signatureId: sig.id,
      createdAt: now.toISOString(),
      synth: synth as unknown as SynthParams,
      control: { id: `c_${now.getTime().toString(36)}`, synth: neutralControlFor(synth) as unknown as SynthParams },
    });
    await store.put({ ...profile, anchors: [...profile.anchors, anchor] });
    setPicked(null);
    setName('');
  };
  return (
    <Card>
      <h2>Create an anchor</h2>
      <p className="dim">An anchor is a sound that is unique to you, paired with a state you can reliably reach, so that later the sound alone may help bring the state back. It plays only while your signature is detected, and it is later tested against a neutral control sound. You can listen to candidates now.</p>
      <Field label="For which feeling">
        <select value={state} onChange={(e) => setState(e.target.value)}>
          {[...new Set([...states, ...EMOTIONS.map((o) => String(o.value))])].map((s) => (
            <option key={s} value={s}>{emotionLabel(s)}</option>
          ))}
        </select>
      </Field>
      {!elig.eligible ? (
        <Note tone="warn">
          An anchor can be created only for a feeling with a reliable signature that you reach in most recent sessions:
          <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>{elig.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </Note>
      ) : null}
      <div className="stack">
        {cands.map((c, i) => (
          <div key={i} className="row split" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <label className="check" style={{ flex: 1 }}>
              <input type="radio" name="cand" checked={picked === i} onChange={() => setPicked(i)} />
              <span>Candidate {i + 1}<div className="small dim">{describeCandidate(c)}</div></span>
            </label>
            <Button size="small" onClick={() => void listen(i)} aria-label={`Listen to candidate ${i + 1}`}>Listen</Button>
          </div>
        ))}
      </div>
      {err ? <Note tone="bad">{err}</Note> : null}
      <p className="small dim">Use headphones. {st.session ? 'A session is running: listening here would mix with its sound.' : ''}</p>
      <Field label="Name"><input type="text" value={name} placeholder={`${emotionLabel(state)} anchor`} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="row">
        <Button variant="primary" disabled={!elig.eligible || picked === null || !!st.session} onClick={() => void create()}>Create anchor</Button>
        <Button variant="ghost" onClick={() => controller.getAudio().stopAnchor()}>Stop sound</Button>
        <Button variant="ghost" onClick={() => { setRefresh((r) => r + 1); setPicked(null); }}>Different candidates</Button>
      </div>
    </Card>
  );
}

export function Signatures({ navigate }: { navigate: (to: string) => void }) {
  const profile = useProfile();
  const [fresh, setFresh] = useState('calm');
  if (!profile) return <Card><p>Set up your profile in onboarding first.</p></Card>;
  const states = [...new Set([...profile.signatures.map((s) => s.state), ...Object.keys(profile.signatureBlocks)])];
  return (
    <div>
      <PageHeader title="Signatures" sub="A signature is what a feeling looks like in your own brain and heart measurements. It is personal, and it is tested before it is called reliable." />
      <Note>
        Four dry sensors cannot read emotions in general, and the evidence for doing so is weak. Everything here is learned from blocks you mark yourself and checked on sessions it has not seen. Until then it says "still learning".
      </Note>
      <h2>Your signatures</h2>
      {states.length ? states.map((s) => <SignatureCard key={s} profile={profile} state={s} sig={profile.signatures.find((x) => x.state === s) ?? null} navigate={navigate} />) : <Card><p className="dim">No feeling practised yet.</p></Card>}
      <Card>
        <h3>Practise a new feeling</h3>
        <Field label="Feeling">
          <select value={fresh} onChange={(e) => setFresh(e.target.value)}>
            {EMOTIONS.map((o) => (<option key={String(o.value)} value={String(o.value)}>{o.label}</option>))}
          </select>
        </Field>
        <StartButton req={{ programId: 'emotional_state_practice', values: { emotion: fresh } }} navigate={navigate}>Start Emotional State Practice</StartButton>
      </Card>
      <h2>Your anchors</h2>
      {profile.anchors.length ? profile.anchors.map((a) => <AnchorCard key={a.id} a={a} profile={profile} navigate={navigate} />) : <Card><p className="dim">No anchors yet.</p></Card>}
      <CreateAnchor profile={profile} />
    </div>
  );
}
