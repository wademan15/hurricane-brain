import { useRef, useState } from 'react';
import { DEFAULT_AUDIO_SETTINGS, mergeSettings, type AudioSettings } from '../../audio/settings';
import { VIZ_SMOOTHING } from '../../viz';
import { Button, Card, download, Field, Modal, Note, PageHeader, Segmented } from '../components/kit';
import { GLOSSARY, GOLDEN_RATIO_TEXT, HEADPHONES, PHOTOSENSITIVITY, PRIVACY, PRIVACY_SENTENCE, STORE_DESCRIPTION, WELLNESS, WHAT_IT_DOES_NOT_CLAIM } from '../copy';
import { Storage, type ResponseSpeed } from '../../storage';
import { AppearanceSettings, GrownUpGate, isUnlocked } from '../components/AppearanceSettings';
import { fmtBytes } from '../measured';
import { APP_VERSION } from '../session/controller';
import { useAppearance, useAsync, useController, useProfile, useServices, useSettings } from '../state/app';

interface Slider {
  key: keyof AudioSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  help?: string;
}

const SMOOTHING: Slider[] = [
  { key: 'pitchTauS', label: 'Pitch smoothing', min: 0.02, max: 1, step: 0.01, unit: 's', help: 'The tone glides to a new pitch with this time constant.' },
  { key: 'toneLoudnessTauS', label: 'Tone loudness smoothing', min: 0.05, max: 2, step: 0.05, unit: 's' },
  { key: 'toneFadeS', label: 'Tone fade in and out', min: 1, max: 10, step: 0.5, unit: 's', help: 'How long a tone takes to fade when its peak is lost or found.' },
  { key: 'warmthTauS', label: 'Warmth smoothing', min: 1, max: 10, step: 0.5, unit: 's' },
  { key: 'steadyTauS', label: 'Steadiness smoothing', min: 1, max: 60, step: 1, unit: 's', help: 'How long alpha must hold before the bed settles into a warm body.' },
  { key: 'bedFadeS', label: 'Bed fade', min: 1, max: 10, step: 0.5, unit: 's' },
  { key: 'bloomTauS', label: 'Bloom rise', min: 1, max: 10, step: 0.5, unit: 's' },
  { key: 'bloomReleaseTauS', label: 'Bloom release', min: 1, max: 10, step: 0.5, unit: 's' },
  { key: 'thinFadeS', label: 'Thinning fade (artifact)', min: 1, max: 10, step: 0.5, unit: 's' },
];
const LEVELS: Slider[] = [
  { key: 'masterDb', label: 'Master volume', min: -60, max: 6, step: 1, unit: 'dB' },
  { key: 'ceilingDb', label: 'Loudest the sound can ever get', min: -40, max: -1, step: 1, unit: 'dBFS', help: 'A hard ceiling. Nothing exceeds it.' },
  { key: 'rolloffStartHz', label: 'Gentle roll-off starts at', min: 200, max: 2000, step: 50, unit: 'Hz' },
  { key: 'toneHarmonic2', label: 'Second harmonic (helps small speakers)', min: 0, max: 0.3, step: 0.01, unit: '' },
  { key: 'maxVoices', label: 'Most tones at once', min: 1, max: 8, step: 1, unit: '' },
  { key: 'heartLatencyS', label: 'Heartbeat delay', min: 0, max: 2, step: 0.05, unit: 's', help: 'A beat is played this long after it is detected. Raise it if beats are being dropped.' },
];
const BLOOMS: { k: 'phi' | 'octave' | 'both'; label: string; help: string }[] = [
  { k: 'phi', label: 'Golden ratio state', help: 'A soft doubling of each cascade member when the golden ratio state holds.' },
  { k: 'octave', label: 'Octave state', help: 'Hollow upper octaves on each member when the octave state holds. It sounds different on purpose.' },
  { k: 'both', label: 'Both at once', help: 'A slower gathering sound while both states hold together.' },
];
const SPEEDS: { value: ResponseSpeed; label: string; cost: string }[] = [
  { value: 'quicker', label: 'Quicker (15 s)', cost: 'Follows changes sooner, but each reading is less certain: the uncertainty is wider, more pairs come back "unresolved", and the chance level is higher. It cannot make alignment easier to reach.' },
  { value: 'steady', label: 'Steady (30 s)', cost: 'The default. A slow, steady reading, matched to the slow warming of the sound.' },
  { value: 'slower', label: 'Slower (60 s)', cost: 'The most certain readings, but it takes about a minute to follow a change, and short alignments are missed.' },
];
const GAINS: { k: keyof AudioSettings['gains']; label: string }[] = [
  { k: 'tones', label: 'Tracking tones' },
  { k: 'bed', label: 'Alpha bed' },
  { k: 'bloom', label: 'Alignment blooms' },
  { k: 'heart', label: 'Heartbeat' },
  { k: 'breath', label: 'Breath guide' },
  { k: 'anchor', label: 'Anchor sound' },
];

function Range({ s, value, onChange }: { s: Slider; value: number; onChange: (v: number) => void }) {
  return (
    <Field label={`${s.label}: ${Number.isInteger(s.step) ? value : value.toFixed(2)}${s.unit ? ` ${s.unit}` : ''}`} hint={s.help}>
      <input type="range" min={s.min} max={s.max} step={s.step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </Field>
  );
}

function DataManagement() {
  const { storage, profile: pstore, controller } = useServices();
  const profile = useProfile();
  const usage = useAsync(() => storage.usage(), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState('');
  const u = usage.data;
  return (
    <Card>
      <h2>Your data</h2>
      <p className="dim">{PRIVACY_SENTENCE}</p>
      {u ? (
        <dl className="kv">
          <dt>Recordings</dt><dd>{u.recordings} ({fmtBytes(u.recordingBytes)})</dd>
          <dt>Sessions</dt><dd>{u.sessions}</dd>
          <dt>People</dt><dd>{u.profiles}</dd>
          <dt>Browser storage in use</dt><dd>{u.usedBytes !== null ? `${fmtBytes(u.usedBytes)} of ${u.quotaBytes !== null ? fmtBytes(u.quotaBytes) : 'unknown'}` : 'not reported by this browser'}</dd>
        </dl>
      ) : null}
      {msg ? <Note tone={msg.tone}>{msg.text}</Note> : null}
      <input ref={fileRef} type="file" hidden accept="application/json,.json" aria-label="Choose a profile file" onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        try {
          const text = await f.text();
          const p = await storage.importProfileJson(text);
          const look = Storage.appearanceOf(text);
          const known = pstore.all.get().some((x) => x.profile.userId === p.userId);
          await pstore.put(p);
          if (!known) pstore.rename(p.userId, { name: 'Imported person' });
          if (look) pstore.setAppearance(p.userId, look);
          pstore.switchTo(p.userId);
          setMsg({ tone: 'ok', text: known ? 'Profile imported. It replaced that person on this device.' : 'Profile imported as a new person. You can rename them in People.' });
        } catch (err) {
          setMsg({ tone: 'bad', text: err instanceof Error ? err.message : String(err) });
        }
      }} />
      <div className="row">
        <Button disabled={!profile} onClick={() => profile && download('hurricane-brain-profile.json', storage.exportProfileJson(profile, pstore.info(profile.userId).appearance), 'application/json')}>Export this person's profile</Button>
        <Button onClick={() => fileRef.current?.click()}>Import a profile</Button>
        <Button variant="danger" onClick={() => setConfirm(true)}>Delete everything</Button>
      </div>
      <p className="small dim">Recordings and session CSV files are exported from History.</p>
      {confirm ? (
        <Modal title="Delete everything?" onClose={() => setConfirm(false)} actions={<>
          <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="danger" disabled={typed !== 'DELETE'} onClick={async () => {
            await controller.disconnect().catch(() => undefined);
            await storage.deleteEverything();
            window.location.hash = '#/home';
            window.location.reload();
          }}>Delete all data</Button>
        </>}>
          <p className="dim">This removes every recording, session, profile, signature, anchor and setting from this device. It cannot be undone. Export first if you want a copy. Type DELETE to confirm.</p>
          <input type="text" aria-label="Type DELETE to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Modal>
      ) : null}
    </Card>
  );
}

function StreamSettings() {
  const { settings } = useServices();
  const cfg = useSettings();
  const st = useController();
  const [url, setUrl] = useState(cfg.stream.url);
  const status = st.stream;
  return (
    <Card>
      <h2>Live stream out</h2>
      <p className="dim">Off by default. When on, the app sends its live measurements to a program you run on your own computer, at the address you enter below. Data leaves the app only to that address, and only while this is on.</p>
      <label className="check">
        <input type="checkbox" checked={cfg.stream.enabled} onChange={(e) => settings.update({ stream: { ...cfg.stream, enabled: e.target.checked, url } })} />
        <span><strong>Send live data to this address</strong></span>
      </label>
      <Field label="Address" hint="A WebSocket address such as ws://localhost:8765.">
        <input type="text" inputMode="url" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => settings.update({ stream: { ...cfg.stream, url } })} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={cfg.stream.rawEeg} onChange={(e) => settings.update({ stream: { ...cfg.stream, rawEeg: e.target.checked } })} />
        <span><strong>Also send the raw signal</strong><div className="small dim">The raw samples from the headset, as well as the engine's measurements.</div></span>
      </label>
      <p data-testid="stream-status" className="small">
        Status: {cfg.stream.enabled ? (status.state === 'open' ? 'connected' : status.state === 'connecting' ? 'connecting' : status.state === 'error' ? `not connected (${status.reason ?? 'unknown reason'})` : 'starting') : 'off'}
      </p>
    </Card>
  );
}

const TOLERANCE_PLAIN: Record<string, string> = {
  tolerance: 'How close counts as aligned (in natural-log ratio)',
};

/** A tolerance override. Only a number above zero is accepted; anything else shows an error and is not applied. */
function TolField({ name, engine, value, onChange }: { name: string; engine: number; value: number | undefined; onChange: (n: number | null) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const n = text.trim() === '' ? null : Number(text);
  const bad = n !== null && !(Number.isFinite(n) && n > 0 && n <= 1);
  const errId = `tol-err-${name}`;
  return (
    <Field label={`${TOLERANCE_PLAIN[name] ?? name} (engine value ${engine})`} hint={name !== 'tolerance' ? `Engine name: ${name}` : undefined}>
      <input type="number" step="any" min={0} max={1} value={text} placeholder={String(engine)} aria-invalid={bad} aria-describedby={bad ? errId : undefined} onChange={(e) => {
        setText(e.target.value);
        const m = e.target.value.trim() === '' ? null : Number(e.target.value);
        if (m === null) onChange(null);
        else if (Number.isFinite(m) && m > 0 && m <= 1) onChange(m);
      }} />
      {bad ? <span className="hint err" id={errId} role="alert">Enter a number above 0 and up to 1, or leave the box empty. This value is not being used.</span> : null}
    </Field>
  );
}

function EngineParams() {
  const { settings } = useServices();
  const st = useController();
  const cfg = useSettings();
  const info = st.engineInfo;
  if (!info) {
    return <p className="dim">The engine's parameters are shown once the engine is running, that is, when a headset is connected or a recording is open.</p>;
  }
  const entries = Object.entries(info.params).sort(([a], [b]) => a.localeCompare(b));
  const tol = entries.filter(([k, v]) => /tol/i.test(k) && typeof v === 'number');
  return (
    <div className="stack">
      <p className="small dim">Engine version {info.version}. These are the values in force for the current connection.</p>
      {tol.length ? (
        <div>
          <h4>Tolerances</h4>
          <p className="small dim">How close a ratio must be to its target to count as aligned. These change measurements, so they apply from the next session and are stored with it. Leave the box empty to use the engine's value.</p>
          {tol.map(([k, v]) => (
            <TolField key={k} name={k} engine={v as number} value={cfg.engineOverrides[k]} onChange={(n) => {
              const next = { ...cfg.engineOverrides };
              if (n === null) delete next[k];
              else next[k] = n;
              settings.update({ engineOverrides: next });
            }} />
          ))}
        </div>
      ) : null}
      <details>
        <summary>All {entries.length} parameters (read only)</summary>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="All engine parameters, scrolls sideways">
          <table><tbody>{entries.map(([k, v]) => <tr key={k}><td>{k}</td><td className="mono">{String(v)}</td></tr>)}</tbody></table>
        </div>
      </details>
    </div>
  );
}

export function Settings() {
  const profile = useProfile();
  const ap = useAppearance();
  const [, setPassed] = useState(0);
  if (ap.lock && profile && !isUnlocked(profile.userId)) {
    return (
      <div>
        <PageHeader title="Settings" />
        <GrownUpGate userId={profile.userId} onPass={() => setPassed((n) => n + 1)} />
      </div>
    );
  }
  return <SettingsBody />;
}

function SettingsBody() {
  const { settings } = useServices();
  const cfg = useSettings();
  const audio = mergeSettings(DEFAULT_AUDIO_SETTINGS, cfg.audio);
  const setA = (key: keyof AudioSettings, v: number) => settings.updateAudio({ [key]: v } as Partial<AudioSettings>);
  return (
    <div>
      <PageHeader title="Settings" />

      <Card>
        <h2>Sound</h2>
        <label className="check">
          <input type="checkbox" checked={cfg.soundOn} onChange={(e) => settings.update({ soundOn: e.target.checked })} />
          <span><strong>Play sound during sessions</strong><div className="small dim">Sound follows your measurements only. Nothing sounds without one.</div></span>
        </label>
        <Note>{HEADPHONES[0]} {HEADPHONES[1]}</Note>
        {LEVELS.map((s) => <Range key={s.key} s={s} value={audio[s.key] as number} onChange={(v) => setA(s.key, v)} />)}
        <h3>Loudness of each part</h3>
        {GAINS.map((g) => (
          <Field key={g.k} label={`${g.label}: ${audio.gains[g.k].toFixed(2)}`}>
            <input type="range" min={0} max={2} step={0.05} value={audio.gains[g.k]} onChange={(e) => settings.updateAudio({ gains: { [g.k]: Number(e.target.value) } })} />
          </Field>
        ))}
        <h3>Alignment sounds</h3>
        <p className="small dim">Each state has its own sound. Mute it or set its level. All are on by default. A sound only plays while its state is measured as active.</p>
        {BLOOMS.map((b) => (
          <div key={b.k} style={{ marginBottom: 10 }}>
            <label className="check">
              <input type="checkbox" checked={audio.blooms[b.k].on} onChange={(e) => settings.updateAudio({ blooms: { [b.k]: { on: e.target.checked } } })} />
              <span><strong>{b.label}</strong><div className="small dim">{b.help}</div></span>
            </label>
            <Field label={`${b.label} level: ${audio.blooms[b.k].level.toFixed(2)}`}>
              <input type="range" min={0} max={2} step={0.05} value={audio.blooms[b.k].level} disabled={!audio.blooms[b.k].on} onChange={(e) => settings.updateAudio({ blooms: { [b.k]: { level: Number(e.target.value) } } })} />
            </Field>
          </div>
        ))}
        <h3>Breath guide</h3>
        <label className="check">
          <input type="checkbox" checked={!!cfg.audio.breathGuide?.enabled} onChange={(e) => settings.updateAudio({ breathGuide: { enabled: e.target.checked } })} />
          <span><strong>Play a breath guide during paced-breathing blocks</strong><div className="small dim">A slow swell of soft air at the pacer rate. It is a guide, not a measurement, and the only sound that does not come from your signals. Off by default.</div></span>
        </label>
      </Card>

      <Card>
        <h2>Smoothing</h2>
        <p className="dim">Between a measurement and what you hear there is exactly one declared time constant per sound. They are stored with every session.</p>
        {SMOOTHING.map((s) => <Range key={s.key} s={s} value={audio[s.key] as number} onChange={(v) => setA(s.key, v)} />)}
        <Button variant="ghost" onClick={() => settings.resetAudio()}>Reset all sound settings</Button>
        <h3 style={{ marginTop: 16 }}>Visual smoothing (fixed)</h3>
        <dl className="kv">
          <dt>Ramp to a new value</dt><dd>{VIZ_SMOOTHING.RAMP_S} s, straight line, never overshooting</dd>
          <dt>Slow frames count as no data after</dt><dd>{VIZ_SMOOTHING.SLOW_STALE_S} s</dd>
          <dt>Heart frames count as no data after</dt><dd>{VIZ_SMOOTHING.HEART_STALE_S} s</dd>
        </dl>
      </Card>

      <AppearanceSettings />

      <Card>
        <h2>Picture and screen</h2>
        <Field label="Picture quality" hint="Lower is lighter on a phone battery. It changes resolution only, not what is shown." group>
          <Segmented label="Picture quality" value={cfg.vizQuality} onChange={(v) => settings.update({ vizQuality: v })} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
        </Field>
        <Field label="Which chance level drives the hurricane and the sounds" hint="Chance A (random peaks) places the same number of peaks at random. Chance B (your own usual pattern) shifts each peak's own history in time against the others. A is the default. Both are always shown in the readout." group>
          <Segmented label="Chance level" value={cfg.chanceDriver} onChange={(v) => settings.update({ chanceDriver: v })} options={[{ value: 'a', label: 'A (default)' }, { value: 'b', label: 'B' }]} />
        </Field>
        <Field label="Reduced motion" hint="Slower, calmer movement. The default follows your device's setting." group>
          <Segmented label="Reduced motion" value={cfg.reducedMotion} onChange={(v) => settings.update({ reducedMotion: v })} options={[{ value: 'system', label: 'Follow device' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={cfg.soundOnly} onChange={(e) => settings.update({ soundOnly: e.target.checked })} />
          <span><strong>Sound only: keep the screen dark during sessions</strong><div className="small dim">Sessions start with the screen dark. Tap the screen to look at it.</div></span>
        </label>
        <details>
          <summary>Photosensitivity</summary>
          <ul>{PHOTOSENSITIVITY.map((t) => <li key={t} style={{ marginBottom: 6 }}>{t}</li>)}</ul>
        </details>
        <Field label={`Eyes-closed brightness: ${Math.round(cfg.eyesClosedLevel * 100)}%`} hint="How much light stays on the screen in eyes-closed mode. 0 is black. In this mode the screen is meant to be nearly invisible, so it shows no text; tap it, or press Enter or Escape, to look again.">
          <input type="range" min={0} max={0.5} step={0.01} value={cfg.eyesClosedLevel} onChange={(e) => settings.update({ eyesClosedLevel: Number(e.target.value) })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={cfg.keepScreenOn} onChange={(e) => settings.update({ keepScreenOn: e.target.checked })} />
          <span>Keep the screen on during a session</span>
        </label>
      </Card>

      <Card>
        <h2>Measurement</h2>
        <Field label="Mains frequency" hint="The electrical supply frequency, removed from the signal. Auto detects it. Applies from the next connection." group>
          <Segmented label="Mains frequency" value={String(cfg.mains)} onChange={(v) => settings.update({ mains: v === 'auto' ? 'auto' : (Number(v) as 50 | 60) })} options={[{ value: 'auto', label: 'Auto' }, { value: '50', label: '50 Hz' }, { value: '60', label: '60 Hz' }]} />
        </Field>
        <Field label="Alignment response speed" hint="Applies from the next session and is stored with it." group>
          <Segmented label="Alignment response speed" value={cfg.responseSpeed} onChange={(v) => settings.update({ responseSpeed: v })} options={SPEEDS.map((x) => ({ value: x.value, label: x.label }))} />
        </Field>
        <p className="small dim" data-testid="speed-cost">{SPEEDS.find((x) => x.value === cfg.responseSpeed)?.cost}</p>
        <label className="check">
          <input type="checkbox" checked={cfg.harmonicsCount} onChange={(e) => settings.update({ harmonicsCount: e.target.checked })} />
          <span><strong>Count harmonics toward octave alignment</strong><div className="small dim">Off by default: a peak at exactly twice another is often just its harmonic. If on, harmonic pairs are still marked as harmonic on screen. Applies from the next session.</div></span>
        </label>
        <label className="check">
          <input type="checkbox" checked={cfg.fitCoaching} onChange={(e) => settings.update({ fitCoaching: e.target.checked })} />
          <span><strong>Check the headband before every session</strong><div className="small dim">Shows each sensor's contact and waits for a steady signal. You can always skip it.</div></span>
        </label>
        {cfg.fitCoaching ? (
          <Field label={`Seconds of good signal needed: ${cfg.fitHoldS}`}>
            <input type="range" min={3} max={30} step={1} value={cfg.fitHoldS} onChange={(e) => settings.update({ fitHoldS: Number(e.target.value) })} />
          </Field>
        ) : null}
        <Field label="Replay speed" group>
          <Segmented label="Replay speed" value={String(cfg.replaySpeed)} onChange={(v) => settings.update({ replaySpeed: v === 'fast' ? 'fast' : (Number(v) as 1 | 4) })} options={[{ value: '1', label: '1x (with sound)' }, { value: '4', label: '4x' }, { value: 'fast', label: 'As fast as possible' }]} />
        </Field>
        <h3>The engine</h3>
        <EngineParams />
      </Card>

      <StreamSettings />

      <Card>
        <h2>People</h2>
        <p className="dim">Everyone who trains on this device has their own calibration, history, signatures and anchors.</p>
        <a className="btn" href="#/profiles">Manage people</a>
      </Card>

      <DataManagement />

      <Card>
        <h2>About</h2>
        <p>Hurricane Brain {APP_VERSION}. {STORE_DESCRIPTION}</p>
        <Note>{WELLNESS}</Note>
        <h3>What it does not claim</h3>
        <ul>{WHAT_IT_DOES_NOT_CLAIM.map((t) => <li key={t}>{t}</li>)}</ul>
        <h3>Golden ratio alignment</h3>
        <p>{GOLDEN_RATIO_TEXT.measurement}</p>
        <p>{GOLDEN_RATIO_TEXT.research}</p>
        <p>{GOLDEN_RATIO_TEXT.winter}</p>
        <p>{GOLDEN_RATIO_TEXT.mainstream}</p>
        <p>{GOLDEN_RATIO_TEXT.stance}</p>
        <h3>Privacy</h3>
        <ul>{PRIVACY.map((t) => <li key={t}>{t}</li>)}</ul>
        <h3>Words used on the live screen</h3>
        <dl>{GLOSSARY.map((g) => <div key={g.term} style={{ marginBottom: 8 }}><dt><strong>{g.term}</strong></dt><dd style={{ margin: 0 }} className="dim">{g.text}</dd></div>)}</dl>
        <p className="small dim">This app does not include binaural, monaural or isochronic stimulation. It reports what the brain and heart are doing and does not drive them.</p>
      </Card>
    </div>
  );
}
