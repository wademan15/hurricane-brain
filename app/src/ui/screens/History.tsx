import { useRef, useState } from 'react';
import { readRecording } from '../../device';
import { KEY_COLUMNS, type RecordingMeta, type StoredSession } from '../../storage';
import { BlockTable } from '../components/BlockTable';
import { KeyChart } from '../components/KeyChart';
import { Badge, Button, Card, download, Modal, Note, PageHeader } from '../components/kit';
import { fmtBytes, fmtDateTime, fmtDuration } from '../measured';
import { useAsync, useController, useServices } from '../state/app';

const CHARTS = ['alpha_db', 'theta_db', 'phi_closeness', 'phi_excess_a', 'oct_excess_a', 'hr_bpm', 'rmssd_ms', 'clean_fraction', 'reward'];

export function HistoryList({ navigate }: { navigate: (to: string) => void }) {
  const { storage, controller } = useServices();
  const st = useController();
  const sessions = useAsync(() => storage.listSessions(), []);
  const recs = useAsync(() => storage.listRecordings(), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<RecordingMeta | null>(null);

  const importFile = async (f: File) => {
    setError(null);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const parsed = readRecording(bytes);
      const starts = parsed.records.filter((r) => r.kind === 'note' && (r.json as { type?: string })?.type === 'session_start').map((r) => (r as { json: { id: string; programName?: string; spec?: { kind?: 'program' | 'free'; programId?: string | null }; t?: number } }).json);
      const meta: RecordingMeta = {
        id: `r_import_${Date.now().toString(36)}`, createdAt: parsed.header.createdAt, endedAt: null, durationS: null, bytes: bytes.length,
        headset: parsed.header.devices.find((d) => d.kind === 'muse')?.name ?? null, hasHeart: parsed.header.devices.some((d) => d.kind === 'chest_strap'),
        sessions: starts.map((s) => ({ sessionId: s.id, kind: s.spec?.kind ?? 'free', programId: s.spec?.programId ?? null, programName: s.programName ?? 'Session', tStart: s.t ?? 0, tEnd: null })),
        label: f.name, imported: true,
      };
      await storage.saveRecording(meta, bytes);
      recs.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <PageHeader title="History" sub="Past sessions and recordings, stored only on this device." />
      {error ? <Note tone="bad">{error}</Note> : null}
      <h2>Sessions</h2>
      {sessions.data?.length ? (
        sessions.data.map((s) => (
          <Card key={s.id} tight>
            <div className="row split">
              <div style={{ minWidth: 0 }}>
                <strong>{s.programName}</strong>
                <div className="small dim">
                  {fmtDateTime(s.startedAt)} . {fmtDuration(s.tEnd !== null ? s.tEnd - s.tStart : null)} . {s.completed ? 'completed' : 'ended early'}
                </div>
              </div>
              <Button size="small" onClick={() => navigate(`history/${s.id}`)}>Open</Button>
            </div>
          </Card>
        ))
      ) : (
        <div className="empty">{sessions.loading ? 'Loading' : 'No sessions yet. Your sessions will appear here.'}</div>
      )}

      <h2>Recordings</h2>
      <p className="dim">A recording holds everything the headset sent, so any session can be analysed again later with a better method.</p>
      <input ref={fileRef} type="file" hidden aria-label="Import a recording file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
      <div className="row" style={{ marginBottom: 12 }}>
        <Button onClick={() => fileRef.current?.click()}>Import a recording file</Button>
      </div>
      {recs.data?.map((r) => (
        <Card key={r.id} tight>
          <div className="row split">
            <div style={{ minWidth: 0 }}>
              <strong>{r.label}</strong> {r.imported ? <Badge>imported</Badge> : null}
              <div className="small dim">{fmtDateTime(r.createdAt)} . {fmtBytes(r.bytes)} . {fmtDuration(r.durationS)}</div>
            </div>
            <div className="row">
              <Button size="small" disabled={!!st.session} onClick={async () => {
                try {
                  const bytes = await storage.getRecordingBytes(r.id);
                  if (!bytes) throw new Error('That recording is no longer on this device.');
                  await controller.startReplay(bytes, { label: r.label, sessionId: r.sessions[0]?.sessionId ?? null });
                  navigate('session');
                } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
              }}>Replay</Button>
              <Button size="small" onClick={async () => { const b = await storage.getRecordingBytes(r.id); if (b) download(`${r.id}.hbraw`, b as BlobPart, 'application/octet-stream'); }}>Export</Button>
              <Button size="small" variant="danger" onClick={() => setConfirm(r)}>Delete</Button>
            </div>
          </div>
        </Card>
      ))}
      {confirm ? (
        <Modal title="Delete this recording?" onClose={() => setConfirm(null)} actions={<><Button variant="ghost" onClick={() => setConfirm(null)}>Keep it</Button><Button variant="danger" onClick={async () => { await storage.deleteRecording(confirm.id); setConfirm(null); recs.reload(); }}>Delete</Button></>}>
          <p className="dim">The raw data cannot be recovered. Session summaries stay.</p>
        </Modal>
      ) : null}
    </div>
  );
}

export function HistoryDetail({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const { storage, controller } = useServices();
  const st = useController();
  const q = useAsync<StoredSession | null>(() => storage.getSession(id), [id]);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = q.data;
  if (q.loading) return <div className="empty">Loading</div>;
  if (!s) return <Card><h2>Session not found</h2><Button onClick={() => navigate('history')}>Back to History</Button></Card>;
  const rec = s.record;
  const replay = async () => {
    setError(null);
    try {
      if (!s.recordingId) throw new Error('This session has no recording.');
      const bytes = await storage.getRecordingBytes(s.recordingId);
      if (!bytes) throw new Error('The recording for this session is no longer on this device.');
      await controller.startReplay(bytes, { label: s.programName, sessionId: s.id });
      navigate('session');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const exportRecording = async () => {
    if (!s.recordingId) return;
    const b = await storage.getRecordingBytes(s.recordingId);
    if (b) download(`${s.recordingId}.hbraw`, b as BlobPart, 'application/octet-stream');
    else setError('The recording is no longer on this device.');
  };
  const ratings = rec?.blocks.filter((b) => b.rating) ?? [];
  return (
    <div>
      <p><a href="#/history">History</a></p>
      <PageHeader title={s.programName} sub={`${fmtDateTime(s.startedAt)} . ${fmtDuration(s.tEnd !== null ? s.tEnd - s.tStart : null)} . ${s.completed ? 'completed' : 'ended early'}`} />
      {error ? <Note tone="bad">{error}</Note> : null}
      <div className="row" style={{ marginBottom: 14 }}>
        <Button variant="primary" disabled={!s.recordingId || !!st.session} onClick={() => void replay()}>Replay through the engine</Button>
        <Button onClick={() => download(`${s.id}.csv`, s.keyRows.length || rec ? storage.sessionCsv(s) : '', 'text/csv')}>Export CSV</Button>
        <Button disabled={!s.recordingId} onClick={() => void exportRecording()}>Export recording</Button>
        <Button variant="danger" onClick={() => setConfirm(true)}>Delete</Button>
      </div>

      {rec ? (
        <Card>
          <h2>Blocks</h2>
          <BlockTable record={rec} />
          <p className="small dim">Block means are shown with their standard error. The measure for the program's target is in the last columns. Blocks marked excluded had too little clean signal.</p>
        </Card>
      ) : (
        <Card><p className="dim">A free session has no blocks. Its per-second measures are below.</p></Card>
      )}

      <Card>
        <h2>Over the session</h2>
        {s.keyRows.length ? CHARTS.map((c) => {
          const col = KEY_COLUMNS.find((k) => k.id === c);
          return col ? <KeyChart key={c} rows={s.keyRows} col={c} label={col.label} unit={col.unit} /> : null;
        }) : <p className="dim">No per-second data was recorded.</p>}
        <p className="small dim">Gaps in a line are seconds in which that value was not measured. Dashed lines mark block changes.</p>
      </Card>

      {ratings.length ? (
        <Card>
          <h2>Your ratings</h2>
          <ul>{ratings.map((b) => <li key={b.index}>Block {b.index + 1} ({b.id}): {Object.entries(b.rating ?? {}).map(([k, v]) => `${k.replace('_', ' ')} ${v} of 5`).join(', ')}</li>)}</ul>
        </Card>
      ) : null}

      {s.notes.length || rec?.markers.length ? (
        <Card>
          <details>
            <summary>Markers and notes ({(rec?.markers.length ?? 0) + s.notes.length})</summary>
            <div className="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Label</th></tr></thead><tbody>
              {(rec?.markers ?? []).map((m, i) => <tr key={i}><td>{fmtDuration(m.t - s.tStart)}</td><td>{m.type}</td><td>{m.label ?? ''}</td></tr>)}
              {s.notes.map((n, i) => <tr key={`n${i}`}><td>{fmtDuration(n.t - s.tStart)}</td><td>note</td><td>{n.text}</td></tr>)}
            </tbody></table></div>
          </details>
        </Card>
      ) : null}

      <Card>
        <details>
          <summary>Settings stored with this session</summary>
          <p className="small dim">Every setting that affects a measurement or its smoothing, as it was when the session ran.</p>
          <dl className="kv">
            <dt>Engine</dt><dd>{s.settings.engine.version ?? 'version not recorded'}</dd>
            <dt>Mains</dt><dd>{String(s.settings.mains)}</dd>
            <dt>Chance level driving the hurricane</dt><dd>{s.settings.chanceDriver.toUpperCase()}</dd>
            <dt>Visual smoothing</dt><dd>ramp {s.settings.viz.rampS} s, slow frames stale after {s.settings.viz.slowStaleS} s</dd>
            <dt>Pitch smoothing</dt><dd>{s.settings.audio.pitchTauS} s</dd>
            <dt>Loudness smoothing</dt><dd>{s.settings.audio.toneLoudnessTauS} s</dd>
            <dt>Loudness ceiling</dt><dd>{s.settings.audio.ceilingDb} dBFS</dd>
            {rec ? (<><dt>Reward smoothing</dt><dd>{rec.rewardTauS} s</dd></>) : null}
          </dl>
          <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(s.settings, null, 1)}</pre>
        </details>
      </Card>

      {confirm ? (
        <Modal title="Delete this session?" onClose={() => setConfirm(false)} actions={<><Button variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button><Button variant="danger" onClick={async () => { await storage.deleteSession(s.id); navigate('history'); }}>Delete</Button></>}>
          <p className="dim">The session and its recording are removed from this device. Your profile keeps what it learned.</p>
        </Modal>
      ) : null}
    </div>
  );
}
