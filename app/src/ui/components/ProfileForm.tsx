/** Name, age group and the safety questions for a new person. Pure layout; the caller saves. */
import { useState } from 'react';
import type { SafetyFlag } from '../../training';
import type { AgeGroup } from '../../storage';
import { AGE_GROUPS, CHILD_HELPER_NOTE, SAFETY_QUESTIONS } from '../copy';
import { Field, Note, Segmented } from './kit';

export interface NewPerson {
  name: string;
  ageGroup: AgeGroup | null;
  safety: Partial<Record<SafetyFlag, boolean>>;
}

export function ProfileForm({ value, onChange, withSafety = true, withIdentity = true }: { value: NewPerson; onChange: (v: NewPerson) => void; withSafety?: boolean; withIdentity?: boolean }) {
  const [touched, setTouched] = useState(false);
  return (
    <div className="stack">
      {withIdentity ? (<>
      <Field label="Name" hint="Only used on this device, to tell people apart.">
        <input type="text" value={value.name} maxLength={40} autoComplete="off" placeholder="For example: Sam" onChange={(e) => { setTouched(true); onChange({ ...value, name: e.target.value }); }} aria-invalid={touched && !value.name.trim()} />
      </Field>
      <div>
        <div className="label" style={{ fontWeight: 600, marginBottom: 6 }}>Age group (optional)</div>
        <Segmented<string>
          label="Age group"
          value={value.ageGroup ?? ''}
          onChange={(v) => onChange({ ...value, ageGroup: v === '' ? null : (v as AgeGroup) })}
          options={[{ value: '', label: 'Not said' }, ...AGE_GROUPS.map((a) => ({ value: a.value as string, label: a.label }))]}
        />
        <p className="small dim" style={{ marginTop: 6 }}>{AGE_GROUPS.find((a) => a.value === value.ageGroup)?.text ?? 'It adjusts the wording and fit tips. It never switches a safety check off.'}</p>
      </div>
      {value.ageGroup === 'child' ? <Note>{CHILD_HELPER_NOTE}</Note> : null}
      </>) : null}
      {withSafety ? (
        <div>
          <div className="label" style={{ fontWeight: 600 }}>Does any of this apply?</div>
          <p className="small dim">The answers stay on this device. They only decide which programs and techniques are offered. For a child, a grown-up answers.</p>
          {SAFETY_QUESTIONS.map((q) => (
            <label key={q.flag} className="check">
              <input type="checkbox" checked={!!value.safety[q.flag]} onChange={(e) => onChange({ ...value, safety: { ...value.safety, [q.flag]: e.target.checked } })} />
              <span>{q.text}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
