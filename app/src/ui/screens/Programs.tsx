import { useMemo, useState } from 'react';
import {
  availablePrograms, getProgram, getStrategy, instantiateProgram, LADDER, NOT_OFFERED, planDiscoverySession, PROGRAMS, strategiesFor,
  type EvidenceGrade, type Posture, type Program, type UserProfile, type VarValue, type VariableSpec,
} from '../../training';
import { Badge, Button, Card, Field, Note, PageHeader } from '../components/kit';
import { fmtDuration } from '../measured';
import { useController, useProfile, useServices } from '../state/app';

const GROUPS: { title: string; blurb: string; families: Program['family'][] }[] = [
  { title: 'Getting started', blurb: 'Teach the app your signals and find what suits you.', families: ['calibration', 'profiling'] },
  { title: 'Calm and stillness', blurb: 'Quieten the body and raise calm alpha.', families: ['stillness', 'alpha'] },
  { title: 'Deeper states', blurb: 'Slower rhythms, drowsy and dreamlike states. Often the least certain evidence.', families: ['theta', 'alpha_theta', 'sleep_onset'] },
  { title: 'Alignment', blurb: 'Golden ratio, octave and left-right balance. Always shown with the chance level.', families: ['alignment', 'hemisphere', 'asymmetry'] },
  { title: 'Heart', blurb: 'Breathing rate, heart rhythm and variability. Needs a chest strap for most programs.', families: ['heart', 'brain_heart'] },
  { title: 'Feelings, signatures and anchors', blurb: 'Personal states, learned from your own marked blocks.', families: ['emotion', 'signature', 'anchor'] },
];

const GRADE_TEXT: Record<EvidenceGrade, string> = {
  A: 'Grade A: well established',
  'A-B': 'Grade A to B: well supported',
  B: 'Grade B: supported, with limits',
  'B-C': 'Grade B to C: some support, some doubt',
  C: 'Grade C: weak or mixed evidence',
  'C-D': 'Grade C to D: very weak',
  D: 'Grade D: exploratory, no good evidence of a benefit',
};
const gradeTone = (g: EvidenceGrade): 'ok' | 'warn' | 'bad' | 'accent' => (g.startsWith('A') ? 'ok' : g === 'B' ? 'accent' : g === 'D' || g === 'C-D' ? 'bad' : 'warn');

export function GradeBadge({ g }: { g: EvidenceGrade }) {
  return <Badge tone={gradeTone(g)} title={GRADE_TEXT[g]}>Evidence {g}</Badge>;
}

export function lockedReason(p: Program, profile: UserProfile | null): string | null {
  if (!profile) return 'Set up a profile first.';
  if (availablePrograms(profile).includes(p.id)) return null;
  if ((p.unlock?.excludeIf ?? []).some((f) => profile.safety[f])) return 'Not offered, because of the safety answers you gave.';
  if (p.unlock?.afterProgram) {
    const prev = getProgram(p.unlock.afterProgram);
    const lvl = profile.programs[p.unlock.afterProgram]?.level ?? 0;
    if (lvl < (p.unlock.level ?? 1)) return `Unlocks after ${prev?.name ?? p.unlock.afterProgram} (level ${p.unlock.level ?? 1}).`;
  }
  if (p.requires.signature && !profile.signatures.some((s) => s.status === 'reliable')) return 'Needs a reliable personal signature first (see Anchors).';
  if (p.requires.anchor && !profile.anchors.some((a) => !a.retired)) return 'Needs a sound anchor first (see Anchors).';
  return 'Not available yet.';
}

function ProgramCard({ p, profile, navigate }: { p: Program; profile: UserProfile | null; navigate: (to: string) => void }) {
  const locked = lockedReason(p, profile);
  return (
    <section className="card prog-card" onClick={() => navigate(`programs/${p.id}`)}>
      <div className="row split">
        <h3 style={{ margin: 0 }}>
          <a href={`#/programs/${p.id}`} style={{ color: 'inherit', textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>{p.name}</a>
        </h3>
        <GradeBadge g={p.evidence.grade} />
      </div>
      <p className="dim" style={{ margin: '6px 0' }}>{p.summary}</p>
      <div className="tag-row">
        {p.experimental ? <Badge tone="warn">Experimental</Badge> : null}
        {p.requires.eeg ? <Badge>Headset</Badge> : null}
        {p.requires.heart === 'required' ? <Badge>Chest strap needed</Badge> : p.requires.heart === 'optional' ? <Badge>Chest strap optional</Badge> : null}
        {locked ? <Badge tone="warn">{locked}</Badge> : null}
      </div>
    </section>
  );
}

export function ProgramList({ navigate }: { navigate: (to: string) => void }) {
  const profile = useProfile();
  return (
    <div>
      <PageHeader title="Programs" sub="Each program says how strong its evidence is, and where it is weak. Grades run from A (well established) to D (exploratory)." />
      {GROUPS.map((g) => {
        const items = PROGRAMS.filter((p) => g.families.includes(p.family));
        if (!items.length) return null;
        return (
          <div key={g.title}>
            <h2>{g.title}</h2>
            <p className="dim">{g.blurb}</p>
            {items.map((p) => (
              <ProgramCard key={p.id} p={p} profile={profile} navigate={navigate} />
            ))}
          </div>
        );
      })}
      <h2>Not offered, and why</h2>
      <Card>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {NOT_OFFERED.map((n) => (
            <li key={n.target} style={{ marginBottom: 10 }}>
              <strong>{n.target.replace(/_/g, ' ')}</strong>
              <div className="dim">{n.reason}</div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function VariableInput({ v, value, onChange }: { v: VariableSpec; value: VarValue; onChange: (x: VarValue) => void }) {
  if (v.kind === 'boolean') {
    return (
      <label className="check">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <span>
          <strong>{v.label}</strong>
          <div className="small dim">{v.description}</div>
        </span>
      </label>
    );
  }
  if (v.kind === 'choice') {
    return (
      <Field label={v.label} hint={v.description}>
        <select value={String(value)} onChange={(e) => onChange(typeof v.options?.[0]?.value === 'number' ? Number(e.target.value) : e.target.value)}>
          {v.options?.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  return (
    <Field label={`${v.label}: ${String(value)}${v.unit ? ` ${v.unit}` : ''}`} hint={v.description}>
      <input type="range" min={v.min} max={v.max} step={v.step ?? 1} value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} />
    </Field>
  );
}

export function ProgramDetail({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const { controller } = useServices();
  const st = useController();
  const profile = useProfile();
  const program = getProgram(id);
  const [values, setValues] = useState<Record<string, VarValue>>({});
  const [level, setLevel] = useState<number | null>(null);
  const [strategy, setStrategy] = useState('');
  const [posture, setPosture] = useState<Posture>('upright');
  const [anchorId, setAnchorId] = useState('');
  const [caffeine, setCaffeine] = useState(false);
  const [sleepHours, setSleepHours] = useState('');
  const [mood, setMood] = useState('');
  const [energy, setEnergy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const merged = useMemo(() => {
    const m: Record<string, VarValue> = {};
    for (const v of program?.variables ?? []) m[v.id] = values[v.id] ?? v.default;
    return m;
  }, [program, values]);

  const plannedS = useMemo(() => {
    if (!program || !profile) return null;
    try {
      const plan = instantiateProgram(program, {
        values: merged,
        level: program.ladder ? (level ?? profile.programs[program.id]?.level ?? 1) : undefined,
        strategySlots: program.id === 'discovery_sampler' ? planDiscoverySession(profile).strategies : undefined,
        probeOrder: program.id === 'anchor_probe' ? Array.from({ length: Number(merged.probe_pairs ?? 3) * 2 }, (_, i) => (i % 2 ? 'control' : 'anchor')) : undefined,
      });
      return plan.blocks.reduce((a, b) => a + b.durationS, 0);
    } catch {
      return null;
    }
  }, [program, profile, merged, level]);

  if (!program) {
    return (
      <Card>
        <h2>Program not found</h2>
        <Button onClick={() => navigate('programs')}>Back to programs</Button>
      </Card>
    );
  }
  const locked = lockedReason(program, profile);
  const usesUserChoice = JSON.stringify(program.blocks).includes('"user_choice"');
  const stateId = program.state.replace(/\$\{(\w+)\}/g, (_m, n: string) => String(merged[n] ?? ''));
  const strategyOptions = strategiesFor(stateId);
  const currentLevel = level ?? profile?.programs[program.id]?.level ?? 1;
  const anchors = (profile?.anchors ?? []).filter((a) => !a.retired);
  const recommended = program.strategies.recommended.map((sid) => getStrategy(sid)).filter((s) => !!s);
  const cautions = [...new Set(recommended.flatMap((s) => s?.cautions ?? []))];

  const needHeadset = program.requires.eeg && !(st.muse.state === 'streaming');
  const needStrap = program.requires.heart === 'required' && st.strap.state !== 'streaming';
  const notReady = st.link?.kind !== 'live' || st.engine !== 'ready';
  const blocker = locked ?? (notReady ? 'Connect a device on the Home screen first.' : needHeadset ? 'This program needs the headset.' : needStrap ? 'This program needs the chest strap.' : st.session ? 'A session is already running.' : null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const sh = Number(sleepHours);
      await controller.startProgram({
        programId: program.id,
        values,
        level: program.ladder ? currentLevel : undefined,
        userStrategy: strategy || undefined,
        posture,
        anchorId: anchorId || undefined,
        checkIn: { caffeine, ...(sleepHours && Number.isFinite(sh) ? { sleepHours: sh } : {}), ...(mood ? { mood: Number(mood) } : {}), ...(energy ? { energy: Number(energy) } : {}) },
      });
      navigate('session');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p><a href="#/programs">Programs</a></p>
      <PageHeader title={program.name} sub={program.summary} />
      <div className="tag-row">
        <GradeBadge g={program.evidence.grade} />
        {program.experimental ? <Badge tone="warn">Experimental</Badge> : null}
        {program.requires.eeg ? <Badge>Headset</Badge> : null}
        {program.requires.heart !== 'none' ? <Badge>Chest strap {program.requires.heart}</Badge> : null}
        {plannedS !== null ? <Badge>About {fmtDuration(plannedS)}</Badge> : null}
      </div>
      {locked ? <Note tone="warn">{locked}</Note> : null}

      <Card>
        <h3>What it is</h3>
        <p>{program.description}</p>
      </Card>

      <Card>
        <h3>The evidence, honestly</h3>
        <p><strong>{GRADE_TEXT[program.evidence.grade]}.</strong> {program.evidence.summary}</p>
        {program.evidence.sources.length ? <p className="small dim">Sources named in the research brief (not independently re-checked by the app): {program.evidence.sources.join('; ')}.</p> : null}
        {program.experimental ? <Note tone="warn">This program is experimental. It is offered for exploration, and the app does not claim it helps.</Note> : null}
      </Card>

      <Card>
        <h3>Cautions</h3>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {[...program.safetyNotes, ...program.contraindications, ...cautions].map((t) => (
            <li key={t} style={{ marginBottom: 6 }}>{t}</li>
          ))}
        </ul>
      </Card>

      <Card>
        <h3>Your choices</h3>
        {program.ladder ? (
          <Field label={`Level: ${LADDER[currentLevel - 1].name}`} hint="Level 1 is fully guided. Higher levels give less guidance and test whether the skill holds without the sound. The app moves you up when your sessions meet the criterion.">
            <select value={currentLevel} onChange={(e) => setLevel(Number(e.target.value))}>
              {LADDER.map((l) => (
                <option key={l.level} value={l.level}>{l.level}. {l.name}</option>
              ))}
            </select>
          </Field>
        ) : null}
        {program.variables.map((v) => (
          <VariableInput key={v.id} v={v} value={merged[v.id]} onChange={(x) => setValues((s) => ({ ...s, [v.id]: x }))} />
        ))}
        {usesUserChoice ? (
          <Field label="Technique" hint="Which way you bring on the state. Leave on 'best so far' to use what your profile has found.">
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              <option value="">Best so far (from your profile)</option>
              {strategyOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
        ) : null}
        {program.requires.anchor ? (
          <Field label="Anchor">
            <select value={anchorId} onChange={(e) => setAnchorId(e.target.value)}>
              <option value="">The anchor for this state</option>
              {anchors.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.state})</option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Posture">
          <select value={posture} onChange={(e) => setPosture(e.target.value as Posture)}>
            <option value="upright">Sitting upright</option>
            <option value="reclined">Reclined</option>
            <option value="lying">Lying down</option>
          </select>
        </Field>
        <details>
          <summary>Optional check-in (helps you read your history later)</summary>
          <label className="check"><input type="checkbox" checked={caffeine} onChange={(e) => setCaffeine(e.target.checked)} /> <span>I have had caffeine today</span></label>
          <div className="grid2">
            <Field label="Hours slept"><input type="number" min="0" max="16" step="0.5" value={sleepHours} onChange={(e) => setSleepHours(e.target.value)} /></Field>
            <Field label="Mood (1 to 5)"><input type="number" min="1" max="5" value={mood} onChange={(e) => setMood(e.target.value)} /></Field>
            <Field label="Energy (1 to 5)"><input type="number" min="1" max="5" value={energy} onChange={(e) => setEnergy(e.target.value)} /></Field>
          </div>
        </details>
      </Card>

      {error ? <Note tone="bad">{error}</Note> : null}
      {blocker ? <p className="dim" role="status">{blocker}</p> : null}
      <Button variant="primary" size="big" block disabled={!!blocker || busy} onClick={start}>
        {busy ? 'Starting' : 'Start this program'}
      </Button>
    </div>
  );
}
