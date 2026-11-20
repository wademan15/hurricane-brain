/** The short, optional entry after a session. Pure layout over `Journal` (storage/types). */
import { useState } from 'react';
import type { Journal } from '../../storage';
import { Button, Field } from './kit';

export const JOURNAL_TAGS = ['relaxed', 'tired', 'focused', 'restless', 'sleepy', 'happy', 'sad', 'worried', 'curious', 'distracted'];

const SCALES: { key: 'mood' | 'ease' | 'depth'; q: string; lo: string; hi: string }[] = [
  { key: 'mood', q: 'How do you feel now?', lo: 'low', hi: 'good' },
  { key: 'ease', q: 'How easy was it?', lo: 'hard', hi: 'easy' },
  { key: 'depth', q: 'How deep did it feel?', lo: 'shallow', hi: 'deep' },
];

export function JournalForm({ onSave, onSkip, nowIso }: { onSave: (j: Journal) => void; onSkip: () => void; nowIso: () => string }) {
  const [note, setNote] = useState('');
  const [vals, setVals] = useState<Record<'mood' | 'ease' | 'depth', number | null>>({ mood: null, ease: null, depth: null });
  const [tags, setTags] = useState<string[]>([]);
  const toggle = (t: string) => setTags((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]));
  return (
    <div className="stack" data-testid="journal-form">
      <h2>How was that?</h2>
      <p className="dim small">All optional. Only you see this, and it stays on this device.</p>
      {SCALES.map((s) => (
        <div key={s.key} role="group" aria-label={s.q}>
          <div style={{ marginBottom: 6 }}>{s.q}</div>
          <div className="ratebtns ratebtns-light">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" aria-pressed={vals[s.key] === n} aria-label={`${s.q} ${n} of 5`} onClick={() => setVals({ ...vals, [s.key]: vals[s.key] === n ? null : n })}>
                {n}
              </button>
            ))}
          </div>
          <div className="row split small dim"><span>1 {s.lo}</span><span>5 {s.hi}</span></div>
        </div>
      ))}
      <div role="group" aria-label="Tags">
        <div style={{ marginBottom: 6 }}>Tags</div>
        <div className="tag-row">
          {JOURNAL_TAGS.map((t) => (
            <button key={t} type="button" className="tag-btn" aria-pressed={tags.includes(t)} onClick={() => toggle(t)}>{t}</button>
          ))}
        </div>
      </div>
      <Field label="A note">
        <textarea rows={3} value={note} placeholder="Anything you noticed (optional)" onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="row">
        <Button variant="primary" size="big" onClick={() => onSave({ note: note.trim(), mood: vals.mood, ease: vals.ease, depth: vals.depth, tags, writtenAt: nowIso() })}>Save</Button>
        <Button variant="ghost" onClick={onSkip}>Skip</Button>
      </div>
    </div>
  );
}

export function JournalView({ journal }: { journal: Journal }) {
  const bits = [
    journal.mood !== null ? `feeling ${journal.mood} of 5` : null,
    journal.ease !== null ? `ease ${journal.ease} of 5` : null,
    journal.depth !== null ? `depth ${journal.depth} of 5` : null,
  ].filter(Boolean);
  return (
    <div data-testid="journal-view">
      {bits.length ? <p>{bits.join(' . ')}</p> : <p className="dim">No ratings given.</p>}
      {journal.tags.length ? <div className="tag-row">{journal.tags.map((t) => <span className="badge" key={t}>{t}</span>)}</div> : null}
      {journal.note ? <p>{journal.note}</p> : null}
    </div>
  );
}
