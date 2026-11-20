/**
 * Control channel (0x0001), both protocols.
 *
 * Command: [len][ASCII command]['\n'], where len counts the command and the newline
 * (muse-js encodeCommand, muse-rs encode_command, OpenMuse encode_command agree).
 * Reply notifications: [len][UTF-8 fragment...]; fragments concatenate into JSON objects
 * carrying "rc" (0 = accepted). muse-js decodeResponse / parseControl, muse-rs ControlAccumulator.
 */
import { MAX_COMMAND_LEN } from './constants';

export function encodeCommand(cmd: string): Uint8Array {
  if (cmd.length === 0 || cmd.length > MAX_COMMAND_LEN) throw new RangeError(`command length ${cmd.length}`);
  const out = new Uint8Array(cmd.length + 2);
  out[0] = cmd.length + 1;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd.charCodeAt(i);
    if (c > 0x7e || c < 0x20) throw new RangeError('command must be printable ASCII');
    out[i + 1] = c;
  }
  out[cmd.length + 1] = 0x0a;
  return out;
}

export function decodeResponseFragment(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const end = Math.min(1 + bytes[0], bytes.length);
  return new TextDecoder().decode(bytes.subarray(1, end));
}

/**
 * Reassembles JSON objects from fragments by brace depth. Characters before the first '{'
 * are discarded (muse-rs ControlAccumulator behaviour).
 */
export class ControlAccumulator {
  private buf = '';
  private depth = 0;

  /** Returns every complete object closed by this fragment, parsed. Unparseable ones are skipped. */
  push(fragment: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const ch of fragment) {
      if (ch === '{') {
        if (this.depth === 0) this.buf = '';
        this.depth++;
        this.buf += ch;
      } else if (ch === '}') {
        if (this.depth === 0) continue;
        this.buf += ch;
        this.depth--;
        if (this.depth === 0) {
          try {
            const v: unknown = JSON.parse(this.buf);
            if (v && typeof v === 'object') out.push(v as Record<string, unknown>);
          } catch {
            // a corrupted reply is dropped; the command waiting on it times out
          }
          this.buf = '';
        }
      } else if (this.depth > 0) {
        this.buf += ch;
      }
    }
    return out;
  }
}
