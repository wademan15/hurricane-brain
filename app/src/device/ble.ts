/**
 * Shared Web Bluetooth plumbing for the live sources: chooser, connect, notification stamping,
 * disconnect detection, automatic reconnect with exponential backoff, and a data watchdog.
 *
 * Web Bluetooth facts relied on (Chrome documentation, unverified on the owner's machines):
 *  - requestDevice() must be called from a user gesture (click/tap).
 *  - After a disconnect, device.gatt.connect() on the same BluetoothDevice object needs no
 *    gesture, so reconnects are automatic while the page stays open.
 *  - Notifications reuse their DataView's buffer, so bytes are copied immediately.
 */
import { copyDataView } from './bytes';
import type { SessionClock } from './clock';
import { Emitter } from './emitter';
import type {
  ConnectionState,
  DeviceEventName,
  DeviceEvents,
  DeviceInput,
  DeviceSlot,
  DeviceSource,
  LinkConfig,
  Listener,
} from './types';

export interface BluetoothLike {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export interface ReconnectPolicy {
  /** Attempts before giving up. Default 20 (several minutes with the default delays). */
  maxAttempts?: number;
  /** First delay, ms. Default 1000; doubles each attempt. */
  baseMs?: number;
  /** Longest delay, ms. Default 30000. */
  maxMs?: number;
}

export interface BleSourceOptions {
  clock: SessionClock;
  /** Defaults to navigator.bluetooth. */
  bluetooth?: BluetoothLike;
  /** A device already chosen (skips the chooser, e.g. from navigator.bluetooth.getDevices()). */
  device?: BluetoothDevice;
  /** Host clock in ms; defaults to performance.now(). Must be the clock the SessionClock origin uses. */
  now?: () => number;
  timers?: Timers;
  reconnect?: ReconnectPolicy;
  /** Disconnect and reconnect if no data notification arrives for this long while streaming, ms. */
  watchdogMs?: number;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

export function bluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as Navigator & { bluetooth?: unknown }).bluetooth;
}

/** Vendor (Muse) or SIG 16-bit id of a characteristic UUID, for recordings. */
export function charCode(uuid: string): number {
  const u = uuid.toLowerCase();
  if (u.endsWith('-0000-1000-8000-00805f9b34fb') && u.startsWith('0000')) return parseInt(u.slice(4, 8), 16);
  if (u.endsWith('-4c4d-454d-96be-f03bac821358') && u.startsWith('273e')) return parseInt(u.slice(4, 8), 16);
  return -1;
}

export abstract class BleSource implements DeviceSource {
  abstract readonly kind: 'muse' | 'chest_strap';
  protected abstract readonly slot: DeviceSlot;
  protected readonly em = new Emitter();
  protected readonly clock: SessionClock;
  protected readonly timers: Timers;
  protected readonly now: () => number;
  protected device: BluetoothDevice | null;
  protected server: BluetoothRemoteGATTServer | null = null;
  private readonly bluetooth: BluetoothLike | null;
  private readonly policy: Required<ReconnectPolicy>;
  private readonly watchdogMs: number;
  private _state: ConnectionState = 'idle';
  private stopping = false;
  private everStreamed = false;
  private attempt = 0;
  private retryTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private lastDataMs = 0;
  private subscriptions: { ch: BluetoothRemoteGATTCharacteristic; fn: (e: Event) => void }[] = [];
  private onGattDisconnected = () => this.handleDisconnect();

  constructor(opts: BleSourceOptions) {
    this.clock = opts.clock;
    this.device = opts.device ?? null;
    this.bluetooth = opts.bluetooth ?? (bluetoothAvailable() ? (navigator.bluetooth as BluetoothLike) : null);
    this.now = opts.now ?? (() => performance.now());
    this.timers = opts.timers ?? defaultTimers;
    this.policy = { maxAttempts: 20, baseMs: 1000, maxMs: 30000, ...opts.reconnect };
    this.watchdogMs = opts.watchdogMs ?? 5000;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get deviceName(): string | null {
    return this.device?.name ?? null;
  }

  on<K extends DeviceEventName>(type: K, listener: Listener<K>): () => void {
    return this.em.on(type, listener);
  }

  /** Options for navigator.bluetooth.requestDevice(). */
  protected abstract requestOptions(): RequestDeviceOptions;
  /** Discover, subscribe (via this.subscribe), emit the link event, start streaming. */
  protected abstract setup(server: BluetoothRemoteGATTServer): Promise<void>;
  /** Feed one decoder input to this source's pipeline. */
  protected abstract decode(input: DeviceInput): void;
  /** Best-effort halt before disconnecting. */
  protected async halt(): Promise<void> {}
  /** Clear per-connection timers (keep-alive...). */
  protected teardownConnection(): void {}

  async start(): Promise<void> {
    if (this._state === 'streaming' || this._state === 'connecting' || this._state === 'starting') return;
    this.stopping = false;
    if (!this.device) {
      if (!this.bluetooth) {
        const message = 'Web Bluetooth is not available in this browser. Use Chrome or Edge on Windows, macOS, Linux or Android.';
        this.setState('failed', message);
        throw new Error(message);
      }
      this.setState('requesting');
      try {
        this.device = await this.bluetooth.requestDevice(this.requestOptions());
      } catch (err) {
        this.setState('idle', describeError(err));
        throw err;
      }
    }
    this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    try {
      await this.connectOnce();
    } catch (err) {
      this.setState('failed', describeError(err));
      this.safeDisconnect();
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopWatchdog();
    this.teardownConnection();
    if (this.server?.connected) {
      try {
        await this.halt();
      } catch {
        // the link may already be gone
      }
    }
    await this.unsubscribeAll();
    this.device?.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    const wasConnected = !!this.server?.connected;
    this.safeDisconnect();
    if (wasConnected) this.pushInput({ type: 'link', slot: this.slot, tUs: this.stamp(), state: 'disconnected' });
    this.setState('stopped');
  }

  // ---- for subclasses ----------------------------------------------------------

  protected stamp(): number {
    return this.clock.stampUs(this.now());
  }

  protected setState(state: ConnectionState, detail?: string, extra: Partial<DeviceEvents['status']> = {}): void {
    this._state = state;
    this.em.emit('status', { slot: this.slot, state, ...(detail ? { detail } : {}), ...extra });
  }

  /** Record and decode one input. All inputs go through here, in order. */
  protected pushInput(input: DeviceInput): void {
    this.em.emit('input', input);
    this.decode(input);
  }

  protected linkConnected(config: LinkConfig): void {
    this.pushInput({ type: 'link', slot: this.slot, tUs: this.stamp(), state: 'connected', config });
  }

  /** Subscribe to notifications; each one is copied, stamped and decoded. `data` feeds the watchdog. */
  protected async subscribe(ch: BluetoothRemoteGATTCharacteristic, data: boolean): Promise<void> {
    const code = charCode(ch.uuid);
    const fn = (e: Event) => {
      const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
      if (!value) return;
      const tUs = this.stamp();
      if (data) this.lastDataMs = this.now();
      this.pushInput({ type: 'raw', slot: this.slot, char: code, tUs, bytes: copyDataView(value) });
    };
    ch.addEventListener('characteristicvaluechanged', fn);
    this.subscriptions.push({ ch, fn });
    await ch.startNotifications();
  }

  /** Record a value that was read rather than notified. */
  protected recordRead(ch: BluetoothRemoteGATTCharacteristic, value: DataView): void {
    this.pushInput({ type: 'raw', slot: this.slot, char: charCode(ch.uuid), tUs: this.stamp(), bytes: copyDataView(value) });
  }

  // ---- connection lifecycle ------------------------------------------------------

  private async connectOnce(): Promise<void> {
    const device = this.device!;
    if (!device.gatt) throw new Error('This device has no GATT server.');
    this.setState(this.attempt > 0 ? 'reconnecting' : 'connecting', undefined, this.attempt > 0 ? { attempt: this.attempt } : {});
    for (const { ch, fn } of this.subscriptions) ch.removeEventListener('characteristicvaluechanged', fn);
    this.subscriptions = [];
    const server = await device.gatt.connect();
    this.server = server;
    this.setState('starting');
    await this.setup(server);
    if (this.stopping) return;
    this.attempt = 0;
    this.lastDataMs = this.now();
    this.everStreamed = true;
    this.startWatchdog();
    this.setState('streaming');
  }

  private handleDisconnect(): void {
    this.stopWatchdog();
    this.teardownConnection();
    // The same characteristic objects can come back after a reconnect: drop our listeners, or
    // every notification would be decoded twice.
    for (const { ch, fn } of this.subscriptions) ch.removeEventListener('characteristicvaluechanged', fn);
    this.subscriptions = [];
    if (this.stopping) return;
    this.pushInput({ type: 'link', slot: this.slot, tUs: this.stamp(), state: 'disconnected' });
    // During the very first connect, start() reports the failure; reconnecting starts once a
    // connection has worked.
    if (this.everStreamed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.retryTimer !== null) return;
    this.attempt++;
    if (this.attempt > this.policy.maxAttempts) {
      this.setState('failed', `Gave up after ${this.policy.maxAttempts} reconnect attempts.`);
      return;
    }
    const delay = Math.min(this.policy.maxMs, this.policy.baseMs * 2 ** (this.attempt - 1));
    this.setState('reconnecting', undefined, { attempt: this.attempt, retryInMs: delay });
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      this.connectOnce().catch((err) => {
        if (this.stopping) return;
        this.em.emit('error', { slot: this.slot, message: `reconnect attempt ${this.attempt} failed: ${describeError(err)}` });
        if (this.server?.connected) {
          this.safeDisconnect(); // gattserverdisconnected schedules the next attempt
        } else {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const period = Math.max(250, Math.floor(this.watchdogMs / 4));
    this.watchdogTimer = this.timers.setInterval(() => {
      if (this._state !== 'streaming') return;
      if (this.now() - this.lastDataMs > this.watchdogMs) {
        this.em.emit('error', { slot: this.slot, message: `no data for ${this.watchdogMs} ms; reconnecting` });
        this.safeDisconnect();
      }
    }, period);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) this.timers.clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private async unsubscribeAll(): Promise<void> {
    for (const { ch, fn } of this.subscriptions) {
      ch.removeEventListener('characteristicvaluechanged', fn);
      try {
        if (this.server?.connected) await ch.stopNotifications();
      } catch {
        // ignore
      }
    }
    this.subscriptions = [];
  }

  private safeDisconnect(): void {
    try {
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    } catch {
      // ignore
    }
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'NotFoundError') return 'No device chosen.';
    if (err.name === 'SecurityError') return 'Bluetooth needs a click or tap to start, and a secure (https) page.';
    if (err.name === 'NetworkError') return 'The device could not be reached. Is it switched on and close by?';
    return err.message || err.name;
  }
  return String(err);
}
