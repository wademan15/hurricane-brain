/**
 * TEST ONLY. A fake Web Bluetooth stack: just enough of BluetoothDevice / GATT for MuseDevice and
 * PolarH10, with a scripted Muse (Classic or Athena) or heart rate strap behind it, and fake
 * timers. No real Bluetooth is involved.
 */
import type { BluetoothLike, Timers } from '../ble';
import { MuseChar, museUuid } from '../muse/constants';
import { encodeControlReply } from './encoder';

const SIG = (n: number) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

export class FakeCharacteristic extends EventTarget {
  value: DataView | null = null;
  notifying = false;
  readonly uuid: string;
  readonly properties: { notify: boolean; writeWithoutResponse: boolean; write: boolean; read: boolean };
  onWrite: ((bytes: Uint8Array) => void) | null = null;
  readValueBytes: Uint8Array | null = null;
  service: unknown = null;

  constructor(uuid: string, props: Partial<FakeCharacteristic['properties']> = {}) {
    super();
    this.uuid = uuid;
    this.properties = { notify: true, writeWithoutResponse: false, write: false, read: false, ...props };
  }
  async startNotifications() { this.notifying = true; return this; }
  async stopNotifications() { this.notifying = false; return this; }
  async writeValueWithoutResponse(b: BufferSource) { this.onWrite?.(toBytes(b)); }
  async writeValueWithResponse(b: BufferSource) { this.onWrite?.(toBytes(b)); }
  async readValue() { const b = this.readValueBytes ?? new Uint8Array(1); return new DataView(b.buffer.slice(0)); }
  /** Deliver a notification (only if subscribed, like the real thing). */
  notify(bytes: Uint8Array): void {
    if (!this.notifying) return;
    this.value = new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function toBytes(b: BufferSource): Uint8Array {
  return b instanceof Uint8Array ? new Uint8Array(b) : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice() : new Uint8Array(b as ArrayBuffer).slice();
}

export class FakeService {
  readonly uuid: string;
  readonly chars: FakeCharacteristic[];
  constructor(uuid: string, chars: FakeCharacteristic[]) {
    this.uuid = uuid;
    this.chars = chars;
  }
  async getCharacteristics() { return this.chars; }
  async getCharacteristic(id: number | string) {
    const want = typeof id === 'number' ? SIG(id) : id;
    const c = this.chars.find((x) => x.uuid === want);
    if (!c) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
    return c;
  }
}

export class FakeDevice extends EventTarget {
  readonly name: string;
  readonly id = 'fake';
  services: FakeService[];
  connectCalls = 0;
  /** Make the next N connect() calls fail. */
  failNextConnects = 0;
  gatt: {
    connected: boolean;
    device: FakeDevice;
    connect: () => Promise<unknown>;
    disconnect: () => void;
    getPrimaryService: (id: number | string) => Promise<FakeService>;
  };

  constructor(name: string, services: FakeService[]) {
    super();
    this.name = name;
    this.services = services;
    this.gatt = {
      connected: false,
      device: this,
      connect: async () => {
        this.connectCalls++;
        if (this.failNextConnects > 0) {
          this.failNextConnects--;
          throw Object.assign(new Error('connect failed'), { name: 'NetworkError' });
        }
        this.gatt.connected = true;
        return this.gatt;
      },
      disconnect: () => {
        if (this.gatt.connected) this.dropLink();
      },
      getPrimaryService: async (id: number | string) => {
        const want = typeof id === 'number' ? SIG(id) : id;
        const s = this.services.find((x) => x.uuid === want);
        if (!s) throw Object.assign(new Error('no service'), { name: 'NotFoundError' });
        return s;
      },
    };
  }

  /** The link drops (out of range, headset off...). */
  dropLink(): void {
    this.gatt.connected = false;
    for (const s of this.services) for (const c of s.chars) c.notifying = false;
    this.dispatchEvent(new Event('gattserverdisconnected'));
  }
}

export interface FakeMuse {
  device: FakeDevice;
  chars: Map<number, FakeCharacteristic>;
  commands: string[];
  streaming: boolean;
  /** rc to answer per command (default 0); null = no reply. */
  rc: Record<string, number | null>;
}

export function fakeMuse(protocol: 'classic' | 'athena'): FakeMuse {
  const codes =
    protocol === 'athena'
      ? [MuseChar.CONTROL, MuseChar.ATHENA_DATA, MuseChar.ATHENA_DATA_2]
      : [MuseChar.CONTROL, 3, 4, 5, 6, 7, MuseChar.GYRO, MuseChar.ACCEL, MuseChar.TELEMETRY, 0x0f, 0x10, 0x11];
  const chars = new Map<number, FakeCharacteristic>();
  for (const c of codes) chars.set(c, new FakeCharacteristic(museUuid(c), c === MuseChar.CONTROL ? { writeWithoutResponse: true } : {}));
  const device = new FakeDevice(protocol === 'athena' ? 'MuseS-FAKE' : 'Muse-FAKE', [new FakeService(SIG(0xfe8d), [...chars.values()])]);
  const m: FakeMuse = { device, chars, commands: [], streaming: false, rc: protocol === 'athena' ? { L1: null, d: 255 } : {} };
  const control = chars.get(MuseChar.CONTROL)!;
  control.onWrite = (bytes) => {
    const cmd = new TextDecoder().decode(bytes.subarray(1, bytes[0]));
    m.commands.push(cmd);
    if (cmd === 'd' || cmd === 'dc001') m.streaming = (m.rc[cmd] ?? 0) === 0 || m.streaming;
    if (cmd === 'h') m.streaming = false;
    const rc = cmd in m.rc ? m.rc[cmd] : 0;
    if (rc === null) return;
    const body = cmd.startsWith('v') ? `{"fw":"9.9.9","hw":"fake","rc":${rc}}` : cmd === 's' ? `{"hn":"${device.name}","bp":63.5,"rc":${rc}}` : `{"rc":${rc}}`;
    queueMicrotask(() => encodeControlReply(body).forEach((n) => control.notify(n)));
  };
  return m;
}

export function fakeStrap(): { device: FakeDevice; hrm: FakeCharacteristic; battery: FakeCharacteristic } {
  const hrm = new FakeCharacteristic(SIG(0x2a37));
  const battery = new FakeCharacteristic(SIG(0x2a19), { read: true, notify: false });
  battery.readValueBytes = Uint8Array.of(88);
  const device = new FakeDevice('Polar H10 FAKE', [new FakeService(SIG(0x180d), [hrm]), new FakeService(SIG(0x180f), [battery])]);
  return { device, hrm, battery };
}

export function fakeBluetooth(device: FakeDevice): BluetoothLike & { requests: RequestDeviceOptions[] } {
  const requests: RequestDeviceOptions[] = [];
  return {
    requests,
    async requestDevice(o: RequestDeviceOptions) {
      requests.push(o);
      return device as unknown as BluetoothDevice;
    },
  };
}

/** Manual clock and timers. `now` is in ms. */
export class FakeTimers implements Timers {
  now = 0;
  private seq = 0;
  private tasks = new Map<number, { at: number; fn: () => void; every: number | null }>();
  setTimeout(fn: () => void, ms: number) { const id = ++this.seq; this.tasks.set(id, { at: this.now + ms, fn, every: null }); return id; }
  clearTimeout(id: unknown) { this.tasks.delete(id as number); }
  setInterval(fn: () => void, ms: number) { const id = ++this.seq; this.tasks.set(id, { at: this.now + ms, fn, every: ms }); return id; }
  clearInterval(id: unknown) { this.tasks.delete(id as number); }
  /** Move time forward, running due tasks in time order, with async work flushed between them. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every: number | null }] | null = null;
      for (const e of this.tasks) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      const [id, t] = next;
      this.now = t.at;
      if (t.every !== null) t.at += t.every;
      else this.tasks.delete(id);
      t.fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

/** Let every pending promise chain settle (a macrotask runs only after all microtasks). */
export async function flush(rounds = 3): Promise<void> {
  const setImmediate = (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate;
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}
