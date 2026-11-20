import { useState } from 'react';
import { Button, Card, Modal, Note, PageHeader } from '../components/kit';
import { ProfileForm, type NewPerson } from '../components/ProfileForm';
import { AGE_GROUPS } from '../copy';
import { fmtDateTime } from '../measured';
import { useController, useProfile, useProfiles, useServices } from '../state/app';

const EMPTY: NewPerson = { name: '', ageGroup: null, safety: {} };

/** The people who use this device. Each has their own calibration, history, signatures and anchors. */
export function Profiles({ navigate }: { navigate: (to: string) => void }) {
  const { profile: store } = useServices();
  const st = useController();
  const active = useProfile();
  const all = useProfiles();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<NewPerson>(EMPTY);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = !!st.session;

  const add = async () => {
    setError(null);
    try {
      const seed = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
      await store.create({ name: form.name, ageGroup: form.ageGroup, safety: form.safety, questionnaire: null }, new Date(), seed);
      setForm(EMPTY);
      setAdding(false);
    } catch (e) {
      setError(`The person could not be saved on this device: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const target = all.find((e) => e.profile.userId === confirm);
  return (
    <div>
      <PageHeader title="People" sub="Everyone who trains on this device has their own calibration, history, signatures and anchors. Nothing is shared between people." />
      {locked ? <Note tone="warn">A session is running. People can be changed when it ends.</Note> : null}
      {error ? <Note tone="bad">{error}</Note> : null}
      {all.map(({ profile: p, info }) => {
        const isActive = p.userId === active?.userId;
        const group = AGE_GROUPS.find((a) => a.value === info.ageGroup)?.label;
        return (
          <Card key={p.userId}>
            <div className="row split">
              <div className="person" aria-current={isActive}>
                <span className="avatar" aria-hidden="true">{(info.name || '?').slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{info.name}</strong> {isActive ? <span className="badge accent">using now</span> : null}
                  <div className="small dim">{group ? `${group} . ` : ''}{p.sessions.length} program session{p.sessions.length === 1 ? '' : 's'} . since {fmtDateTime(p.createdAt)}</div>
                </div>
              </div>
              <div className="row">
                {!isActive ? <Button disabled={locked} onClick={() => { store.switchTo(p.userId); navigate('home'); }}>Switch to {info.name}</Button> : null}
                <Button variant="danger" size="small" disabled={locked} onClick={() => setConfirm(p.userId)}>Delete</Button>
              </div>
            </div>
          </Card>
        );
      })}
      {adding ? (
        <Card>
          <h2>Add a person</h2>
          <ProfileForm value={form} onChange={setForm} />
          <div className="row">
            <Button variant="primary" disabled={!form.name.trim()} onClick={() => void add()}>Add and switch</Button>
            <Button variant="ghost" onClick={() => { setAdding(false); setForm(EMPTY); }}>Cancel</Button>
          </div>
        </Card>
      ) : (
        <Button size="big" disabled={locked} onClick={() => setAdding(true)}>Add a person</Button>
      )}
      {target ? (
        <Modal
          title={`Delete ${target.info.name}?`}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>Keep</Button>
              <Button variant="danger" onClick={() => { const id = target.profile.userId; setConfirm(null); void store.remove(id); }}>Delete {target.info.name} and their sessions</Button>
            </>
          }
        >
          <p className="dim">This removes their calibration, history, signatures, anchors, journal entries and recordings from this device. It cannot be undone. Export first if you want to keep anything.</p>
        </Modal>
      ) : null}
    </div>
  );
}
