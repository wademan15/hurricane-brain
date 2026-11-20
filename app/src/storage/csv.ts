/**
 * CSV export of a stored session: per-block statistics, then per-second key measures.
 * A value that was not measured is an empty cell, and the per-second table has a companion
 * `_why` column carrying the engine's reason. Nothing is ever written as zero in its place.
 */
import { KEY_COLUMNS, type StoredSession } from './types';

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const line = (cells: unknown[]): string => cells.map(csvCell).join(',');

export function sessionSummaryCsv(s: StoredSession): string {
  const out: string[] = [];
  out.push(`# Hurricane Brain session export`);
  out.push(`# session,${csvCell(s.id)}`);
  out.push(`# program,${csvCell(s.programName)}`);
  out.push(`# started,${csvCell(s.startedAt)}`);
  out.push(`# ended,${csvCell(s.endedAt)}`);
  out.push(`# completed,${s.completed}`);
  out.push(`# engine version,${csvCell(s.settings.engine.version)}`);
  out.push(`# app version,${csvCell(s.settings.appVersion)}`);
  out.push(`# mains,${csvCell(s.settings.mains)}`);
  out.push(`# chance level driving the hurricane,${csvCell(s.settings.chanceDriver.toUpperCase())}`);
  out.push(`# audio and smoothing settings,${csvCell(JSON.stringify(s.settings.audio))}`);
  out.push(`# visual smoothing,${csvCell(JSON.stringify(s.settings.viz))}`);
  out.push(`# engine parameters,${csvCell(JSON.stringify(s.settings.engine.params))}`);
  if (Object.keys(s.settings.engineOverrides).length) out.push(`# engine overrides,${csvCell(JSON.stringify(s.settings.engineOverrides))}`);
  if (s.record) out.push(`# reward smoothing time constant (s),${s.record.rewardTauS}`);
  out.push('');
  out.push('# per-block statistics (empty = not measured)');
  out.push(
    line([
      'block_index', 'block_id', 'kind', 'strategy', 'label', 'feedback', 'eyes', 'start_s', 'end_s', 'planned_s',
      'clean_fraction', 'excluded', 'field', 'n_clean', 'field_clean_fraction', 'mean', 'sd', 'effective_n',
      'effect_d_vs_reference', 'effect_d_lo', 'effect_d_hi', 'time_to_target_s', 'fraction_in_target', 'stability', 'rating',
    ]),
  );
  for (const b of s.record?.blocks ?? []) {
    const fields = Object.keys(b.stats);
    const rating = b.rating ? JSON.stringify(b.rating) : '';
    const base = [b.index, b.id, b.kind, b.strategy, b.label, b.feedback, b.eyes, b.tStart, b.tEnd, b.plannedS, b.cleanFraction, b.excluded];
    if (!fields.length) out.push(line([...base, '', '', '', '', '', '', '', '', '', '', '', '', rating]));
    for (const f of fields) {
      const st = b.stats[f];
      const e = st.effect as unknown as { d?: number; dLo?: number; dHi?: number } | null;
      out.push(line([...base, f, st.n, st.cleanFraction, st.mean, st.sd, st.ess, e?.d, e?.dLo, e?.dHi, st.timeToTargetS, st.fractionInTarget, st.stability, rating]));
    }
  }
  out.push('');
  out.push('# per-second key measures (empty = not measured; the _why column says why)');
  const head: string[] = ['t_s', 'block'];
  for (const c of KEY_COLUMNS) head.push(`${c.id} [${c.unit}]`, `${c.id}_why`);
  out.push(line(head));
  for (const r of s.keyRows) {
    const row: unknown[] = [r.t, r.block];
    for (const c of KEY_COLUMNS) {
      const cell = r.cells[c.id];
      row.push(cell?.v ?? null, cell ? (cell.v === null ? cell.why : 'ok') : 'not_in_session');
    }
    out.push(line(row));
  }
  return out.join('\r\n') + '\r\n';
}
