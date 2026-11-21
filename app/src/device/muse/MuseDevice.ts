/**
 * MuseDevice: one live source for every Muse, Classic or Athena, over Web Bluetooth.
 *
 * Detection: a headset that exposes characteristic 273e0013 speaks Athena (muse-rs).
 * Start sequences (muse-rs muse_client.rs MuseHandle::start, measured there on hardware;
 * OpenMuse muse.py initialize_device for Athena):
 *   Classic: h, s, preset (p21 | p20 with AUX | p50 with PPG), d, then v1 for device info.
 *   Athena:  v4, s, h, preset (default p1041), dc001 (then d only if dc001 is refused), L1.
 * Every command except L1 is answered by a JSON object with "rc"; we wait up to 2 s for it and
 * carry on either way (a missing reply often means "not this firmware's command").
 * Keep-alive: 'k' every 10 s (muse-lsl record.py does this for Classic; the Athena firmware has
 * a keep_alive command 'k' per muse-rs; whether either needs it is unverified, it is harmless).
 */
import { BleSource, describeError, type BleSourceOptions } from '../ble';
import type { DeviceInput, LinkConfig } from '../types';
import { DeviceSlot } from '../types';
import {
  ATHENA_DEFAULT_PRESET,
  CLASSIC_EEG_CHARS,
  CLASSIC_PPG_CHARS,
  CLASSIC_PRESET_AUX,
  CLASSIC_PRESET_EEG,
  CLASSIC_PRESET_PPG,
  MUSE_SERVICE,
  MuseChar,
  museUuid,
} from './constants';
import { encodeCommand } from './control';
import { MusePipeline } from './pipeline';

export interface MuseDeviceOptions extends BleSourceOptions {
  /** Classic: subscribe to the optical sensor (Muse 2, Muse S) when present. Default true. */
  classicPpg?: boolean;
  /** Classic: subscribe to the AUX EEG input (preset p20). Ignored when PPG is on. Default false. */
  classicAux?: boolean;
  /** Athena preset. Default p1041 (8 EEG, 16 optical), the default of muse-rs and OpenMuse. */
  athenaPreset?: string;
  /** Keep-alive period, ms; 0 disables. Default 10000. */
  keepAliveMs?: number;
  /** Command reply timeout, ms. Default 2000 (muse-rs). */
  replyTimeoutMs?: number;
  /** Passed to the pipeline; stored in the recording header by the app. */
  settleSamples?: number;
}

export class MuseDevice extends BleSource {
  readonly kind = 'muse' as const;
  protected readonly slot = DeviceSlot.MUSE;
  readonly pipeline: MusePipeline;
  private readonly mopts: MuseDeviceOptions;
  private control: BluetoothRemoteGATTCharacteristic | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();
  private replyWaiters: ((rc: number | null) => void)[] = [];
  private keepAlive: unknown = null;
  /** The last version reply ("fw", "hw", ...) and status reply ("bp", "ps", ...). */
  version: Record<string, unknown> | null = null;
  status: Record<string, unknown> | null = null;
  protocol: 'classic' | 'athena' | null = null;

  static requestOptions(): RequestDeviceOptions {
    return {
      filters: [{ services: [MUSE_SERVICE] }, { namePrefix: 'Muse' }],
      optionalServices: [MUSE_SERVICE],
    };
  }

  constructor(opts: MuseDeviceOptions) {
    super(opts);
    this.mopts = opts;
    this.pipeline = new MusePipeline((type, ev) => this.em.emit(type, ev), {
      clock: opts.clock,
      settleSamples: opts.settleSamples,
    });
    this.em.on('info', ({ slot, json }) => {
      if (slot !== DeviceSlot.MUSE) return;
      if ('fw' in json) this.version = json;
      if ('bp' in json || 'hn' in json) this.status = json;
      if ('rc' in json) {
        const w = this.replyWaiters.shift();
        if (w) w(typeof json.rc === 'number' ? json.rc : null);
      }
    });
  }

  protected requestOptions(): RequestDeviceOptions {
    return MuseDevice.requestOptions();
  }

  protected decode(input: DeviceInput): void {
    this.pipeline.push(input);
  }

  protected async setup(server: BluetoothRemoteGATTServer): Promise<void> {
    const service = await server.getPrimaryService(MUSE_SERVICE);
    const all = await service.getCharacteristics();
    const byCode = new Map<number, BluetoothRemoteGATTCharacteristic>();
    for (const ch of all) {
      const m = /^273e([0-9a-f]{4})-4c4d-454d-96be-f03bac821358$/.exec(ch.uuid.toLowerCase());
      if (m) byCode.set(parseInt(m[1], 16), ch);
    }
    const control = byCode.get(MuseChar.CONTROL);
    if (!control) throw new Error(`Muse control characteristic ${museUuid(MuseChar.CONTROL)} not found`);
    this.control = control;
    this.writeChain = Promise.resolve();
    this.replyWaiters = [];
    const athena = byCode.has(MuseChar.ATHENA_DATA);
    this.protocol = athena ? 'athena' : 'classic';

    // Decide what to subscribe to, announce it, then subscribe.
    let config: LinkConfig;
    let data: BluetoothRemoteGATTCharacteristic[];
    if (athena) {
      const preset = this.mopts.athenaPreset ?? ATHENA_DEFAULT_PRESET;
      data = [MuseChar.ATHENA_DATA, MuseChar.ATHENA_DATA_2].flatMap((c) => (byCode.has(c) ? [byCode.get(c)!] : []));
      config = { name: this.deviceName, protocol: 'athena', preset };
    } else {
      const wantPpg = (this.mopts.classicPpg ?? true) && CLASSIC_PPG_CHARS.every((c) => byCode.has(c));
      const wantAux = !wantPpg && (this.mopts.classicAux ?? false) && byCode.has(MuseChar.EEG_AUX);
      const eegChars = CLASSIC_EEG_CHARS.slice(0, wantAux ? 5 : 4);
      const missing = eegChars.filter((c) => !byCode.has(c));
      if (missing.length) throw new Error(`Muse EEG characteristics missing: ${missing.map(museUuid).join(', ')}`);
      const ppgChars = wantPpg ? CLASSIC_PPG_CHARS : [];
      const preset = wantPpg ? CLASSIC_PRESET_PPG : wantAux ? CLASSIC_PRESET_AUX : CLASSIC_PRESET_EEG;
      const others = [MuseChar.TELEMETRY, MuseChar.ACCEL, MuseChar.GYRO].filter((c) => byCode.has(c));
      data = [...eegChars, ...ppgChars, ...others].map((c) => byCode.get(c)!);
      config = { name: this.deviceName, protocol: 'classic', preset, eegChars, ppgChars };
    }
    this.linkConnected(config);
    await this.subscribe(control, false);
    for (const ch of data) await this.subscribe(ch, ch.uuid.toLowerCase() !== museUuid(MuseChar.TELEMETRY));

    if (athena) {
      await this.command('v4');
      await this.command('s');
      await this.command('h');
      await this.command(config.preset!);
      const rc = await this.command('dc001');
      if (rc !== 0) await this.command('d');
      await this.send('L1');
    } else {
      await this.command('h');
      await this.command('s');
      await this.command(config.preset!);
      await this.command('d');
      await this.command('v1');
    }
    const ka = this.mopts.keepAliveMs ?? 10000;
    if (ka > 0) {
      this.keepAlive = this.timers.setInterval(() => {
        this.send('k').catch((err) => this.em.emit('error', { slot: this.slot, message: `keep-alive: ${describeError(err)}` }));
      }, ka);
    }
  }

  protected teardownConnection(): void {
    if (this.keepAlive !== null) this.timers.clearInterval(this.keepAlive);
    this.keepAlive = null;
    for (const w of this.replyWaiters.splice(0)) w(null);
  }

  protected async halt(): Promise<void> {
    await this.send('h');
  }

  /** Write a command without waiting for its reply. Writes are serialized. */
  send(cmd: string): Promise<void> {
    const control = this.control;
    if (!control) return Promise.reject(new Error('not connected'));
    const bytes = encodeCommand(cmd);
    const p = this.writeChain.then(async () => {
      if (control.properties.writeWithoutResponse) await control.writeValueWithoutResponse(bytes);
      else await control.writeValueWithResponse(bytes);
    });
    this.writeChain = p.catch(() => undefined);
    return p;
  }

  /** Write a command and wait for its "rc". Resolves to rc, or null on timeout. Throws if the write fails. */
  async command(cmd: string): Promise<number | null> {
    const timeoutMs = this.mopts.replyTimeoutMs ?? 2000;
    let resolve!: (rc: number | null) => void;
    const reply = new Promise<number | null>((r) => (resolve = r));
    this.replyWaiters.push(resolve);
    try {
      await this.send(cmd);
    } catch (err) {
      const i = this.replyWaiters.indexOf(resolve);
      if (i >= 0) this.replyWaiters.splice(i, 1);
      throw err;
    }
    let timer: unknown = null;
    const timeout = new Promise<null>((r) => {
      timer = this.timers.setTimeout(() => {
        const i = this.replyWaiters.indexOf(resolve);
        if (i >= 0) this.replyWaiters.splice(i, 1);
        r(null);
      }, timeoutMs);
    });
    const rc = await Promise.race([reply, timeout]);
    this.timers.clearTimeout(timer);
    if (rc !== 0) this.em.emit('error', { slot: this.slot, message: `command ${cmd}: ${rc === null ? 'no reply' : `rc ${rc}`}` });
    return rc;
  }
}
