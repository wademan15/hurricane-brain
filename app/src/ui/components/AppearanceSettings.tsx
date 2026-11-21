/**
 * Settings, Appearance (docs/design/theming.md). Everything here is stored for the active person
 * and travels with their profile export. None of it changes a measurement.
 */
import { useState } from 'react';
import type { Appearance } from '../../storage';
import { useAppearance, useProfile, useServices } from '../state/app';
import { THEMES, useResolvedMode } from '../themes';
import { Card, Field, Segmented } from './kit';

/** People who have passed the grown-up gate in this tab (in memory only: a reload locks again). */
const unlocked = new Set<string>();
export const isUnlocked = (id: string | undefined): boolean => !id || unlocked.has(id);

/** The grown-up lock is an arithmetic gate: add two numbers. A hold-to-unlock would pass for a determined child. */
export function GrownUpGate({ userId, onPass }: { userId: string; onPass: () => void }) {
  const [[a, b]] = useState(() => {
    const r = crypto.getRandomValues(new Uint8Array(2));
    return [6 + (r[0] % 7), 6 + (r[1] % 7)] as const;
  });
  const [v, setV] = useState('');
  const [bad, setBad] = useState(false);
  return (
    <Card>
      <h2>Grown-ups only</h2>
      <p className="dim">Settings are locked for this profile. To open them, add these two numbers.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (Number(v) === a + b) {
            unlocked.add(userId);
            onPass();
          } else {
            setBad(true);
            setV('');
          }
        }}
      >
        <Field label={`What is ${a} + ${b}?`}>
          <input type="text" inputMode="numeric" autoComplete="off" value={v} aria-invalid={bad} onChange={(e) => { setBad(false); setV(e.target.value); }} />
        </Field>
        {bad ? <p className="err" role="alert">Not quite. Try again.</p> : null}
        <button type="submit" className="btn primary">Unlock settings</button>
      </form>
    </Card>
  );
}

function ThemeCard({ id, name, feel, mode, on, onPick }: { id: Appearance['theme']; name: string; feel: string; mode: 'light' | 'dark'; on: boolean; onPick: () => void }) {
  return (
    <button type="button" className="theme-card theme-scope" data-theme={id} data-mode={mode} aria-pressed={on} onClick={onPick}>
      <span className="theme-card-sample" aria-hidden="true">
        <span className="theme-card-surface">
          <i className="s-line" />
          <i className="s-line short" />
          <span className="s-dots"><i className="s-accent" /><i className="s-gold" /><i className="s-octave" /></span>
        </span>
      </span>
      <span className="theme-card-name">{on ? '✓ ' : ''}{name}</span>
      <span className="theme-card-feel">{feel}</span>
    </button>
  );
}

export function AppearanceSettings() {
  const { profile: store } = useServices();
  const p = useProfile();
  const ap = useAppearance();
  const mode = useResolvedMode(ap.mode);
  const set = (patch: Partial<Appearance>) => p && store.setAppearance(p.userId, patch);
  if (!p) return null;
  return (
    <Card>
      <h2>Appearance</h2>
      <p className="dim small">Saved for {store.info(p.userId).name} on this device, and included when you export their profile. None of this changes what is measured.</p>

      <div role="group" aria-labelledby="theme-label" className="field">
        <span className="label" id="theme-label">Theme</span>
        <div className="theme-cards">
          {THEMES.map((t) => (
            <ThemeCard key={t.id} id={t.id} name={t.name} feel={t.feel} mode={mode} on={ap.theme === t.id} onPick={() => set({ theme: t.id })} />
          ))}
        </div>
        <span className="hint">Still Water is the default for grown-ups and Night Garden for a child's profile.</span>
      </div>

      <Field label="Light or dark" group>
        <Segmented label="Light or dark" value={ap.mode} onChange={(v) => set({ mode: v })} options={[{ value: 'system', label: 'Follow device' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      </Field>
      <Field label="Session screen" hint="Sessions are often used with eyes closed or in a dim room, so the session screen stays dark unless you choose otherwise." group>
        <Segmented label="Session screen" value={ap.session} onChange={(v) => set({ session: v })} options={[{ value: 'dark', label: 'Always dark' }, { value: 'match', label: 'Match my mode' }, { value: 'candle', label: 'Candlelight' }]} />
      </Field>
      <Field label="Dim during session" hint="Dims to near black after this long without a touch or key. The sound carries the feedback; touch the screen to bring it back." group>
        <Segmented label="Dim during session" value={ap.dim} onChange={(v) => set({ dim: v })} options={[{ value: 'off', label: 'Off' }, { value: '30', label: 'After 30 seconds' }, { value: '120', label: 'After 2 minutes' }]} />
      </Field>
      <Field label="Readouts" hint="Minimal: the picture and one line with golden ratio, octave and chance. Standard: the usual panel. Full instrument: every panel. Independent of the theme." group>
        <Segmented label="Readouts" value={ap.readouts} onChange={(v) => set({ readouts: v })} options={[{ value: 'minimal', label: 'Minimal' }, { value: 'standard', label: 'Standard' }, { value: 'full', label: 'Full instrument' }]} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={ap.showNumbers} onChange={(e) => set({ showNumbers: e.target.checked })} />
        <span><strong>Show numbers</strong><div className="small dim">Off shows words such as "high, well above chance" instead of values. The words come from the measured values; the precise numbers stay one tap away in Details.</div></span>
      </label>
      <Field label="Text size" hint="On top of your device's own font size." group>
        <Segmented label="Text size" value={ap.textSize} onChange={(v) => set({ textSize: v })} options={[{ value: 'device', label: 'Device' }, { value: 'larger', label: 'Larger' }, { value: 'largest', label: 'Largest' }]} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={ap.highContrast} onChange={(e) => set({ highContrast: e.target.checked })} />
        <span><strong>High contrast</strong><div className="small dim">Raises dim text and borders to at least 7 to 1.</div></span>
      </label>
      <label className="check">
        <input type="checkbox" checked={ap.reduceColour} onChange={(e) => set({ reduceColour: e.target.checked })} />
        <span><strong>Reduce colour reliance</strong><div className="small dim">Adds a shape or a word to anything that is otherwise told apart by colour alone.</div></span>
      </label>
      <Field label="Kid version of the session screen" hint="Big words, short sentences, fewer numbers and bigger buttons, in whichever theme you use. Automatic means on for a child's profile." group>
        <Segmented label="Kid version of the session screen" value={ap.kidView} onChange={(v) => set({ kidView: v })} options={[{ value: 'auto', label: 'Automatic' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={ap.technicalNames} onChange={(e) => set({ technicalNames: e.target.checked })} />
        <span><strong>Show technical names in the picture's readout</strong><div className="small dim">Adds the engine's field names under each row when you tap the picture.</div></span>
      </label>
      <label className="check">
        <input type="checkbox" checked={ap.lock} onChange={(e) => set({ lock: e.target.checked })} />
        <span><strong>Grown-up lock for Settings</strong><div className="small dim">Asks a grown-up to add two numbers before Settings opens. It locks again when the app is reloaded or the person changes.</div></span>
      </label>
    </Card>
  );
}
