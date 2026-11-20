/**
 * Display helpers for measured values (CLAUDE.md rule 1, spec section 2).
 *
 * A null Measured is shown as "not measured" with its reason in plain words. It is never shown
 * as 0, as a dash that could be read as zero, or as the last value.
 */
import type { ChannelQuality, Measured, Reason, SlowFrame } from '../engine/frames';
import { fmtNumber } from '../viz/readout';
import { REASON_TEXT } from '../viz/reasons';

export type UiReason = Reason | 'no_frame' | 'stale' | 'no_runner' | 'not_in_session';

const EXTRA_REASON: Record<'no_frame' | 'stale' | 'no_runner' | 'not_in_session', string> = {
  no_frame: 'nothing received yet',
  stale: 'frames stopped arriving',
  no_runner: 'no program is running',
  not_in_session: 'not recorded in this session',
};

/** Plain-language reason for a null. */
export function reasonPlain(why: UiReason): string {
  if (why in EXTRA_REASON) return EXTRA_REASON[why as keyof typeof EXTRA_REASON];
  return REASON_TEXT[why as Reason];
}

export interface Shown {
  measured: boolean;
  /** "10.2 +- 0.1 Hz" or "not measured". */
  text: string;
  /** Present only when not measured. */
  reason: string | null;
}

export const NOT_MEASURED = 'not measured';

/** The one place a Measured becomes text. `m` undefined means no frame has arrived. */
export function showMeasured(m: Measured | null | undefined, unit = '', scale = 1): Shown {
  if (m === null || m === undefined) return { measured: false, text: NOT_MEASURED, reason: reasonPlain('no_frame') };
  if (m.v === null || !Number.isFinite(m.v)) {
    return { measured: false, text: NOT_MEASURED, reason: m.why === 'ok' ? 'the engine gave no reason' : reasonPlain(m.why) };
  }
  const se = m.se !== null && m.se !== undefined ? m.se * scale : null;
  return { measured: true, text: fmtNumber(m.v * scale, se, unit), reason: null };
}

/** Single line, for places with no room for a second line. */
export function measuredLine(m: Measured | null | undefined, unit = '', scale = 1): string {
  const s = showMeasured(m, unit, scale);
  return s.measured ? s.text : `${NOT_MEASURED} (${s.reason})`;
}

/** A plain number the app already holds as measured (e.g. a stored block statistic). Null shows as not measured. */
export function showNumber(v: number | null | undefined, unit = '', se?: number | null): Shown {
  if (v === null || v === undefined || !Number.isFinite(v)) return { measured: false, text: NOT_MEASURED, reason: 'no clean data' };
  return { measured: true, text: fmtNumber(v, se ?? null, unit), reason: null };
}

/** Fixes to try for a channel, by the engine's reason. */
export const FIX_TEXT: Partial<Record<Reason, string>> = {
  bad_contact: 'Press the sensor gently against bare skin. Move hair out of the way and, if it is dry, dampen the skin slightly. Wipe oil or sunscreen from the forehead or behind the ears.',
  artifact: 'Relax your jaw and forehead and keep your head still for a few seconds.',
  gap: 'Packets were lost. Move closer to the device and away from other radios.',
  insufficient_clean: 'Hold still for a few seconds while the signal settles.',
  warming_up: 'The engine needs a few more seconds of data.',
  no_data: 'No data from this sensor yet.',
  weak: 'The signal is very small. Check that the sensor touches the skin.',
};

export type SignalLevel = 'none' | 'poor' | 'partial' | 'good';

export interface SignalSummary {
  level: SignalLevel;
  usable: number;
  total: number;
  /** One sentence, always honest: says why when not measured. */
  text: string;
  channels: { name: string; usable: boolean; reason: string; fix: string | null }[];
}

export function channelFix(q: ChannelQuality): string | null {
  if (q.usable) return null;
  return FIX_TEXT[q.why] ?? 'Check the fit of the band.';
}

export function summarizeSignal(slow: SlowFrame | null | undefined): SignalSummary {
  if (!slow || slow.quality.length === 0) {
    return { level: 'none', usable: 0, total: 0, text: `Signal ${NOT_MEASURED} (${reasonPlain('no_frame')})`, channels: [] };
  }
  const channels = slow.quality.map((q) => ({
    name: q.name,
    usable: q.usable,
    reason: q.usable ? 'usable' : reasonPlain(q.why),
    fix: channelFix(q),
  }));
  const usable = channels.filter((c) => c.usable).length;
  const total = channels.length;
  const level: SignalLevel = usable === total ? 'good' : usable === 0 ? 'poor' : 'partial';
  const bad = channels.filter((c) => !c.usable);
  const text =
    level === 'good'
      ? `Signal good: ${usable} of ${total} channels usable`
      : `Signal ${level === 'poor' ? 'not usable' : 'partly usable'}: ${bad.map((c) => `${c.name} (${c.reason})`).join(', ')}`;
  return { level, usable, total, text, channels };
}

export function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return NOT_MEASURED;
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Site lookup in a slow frame's spectra. */
export function spectrumAt(slow: SlowFrame | null | undefined, site: string) {
  return slow?.spectra.find((s) => s.site === site) ?? null;
}
