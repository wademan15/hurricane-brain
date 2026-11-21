/**
 * PolarH10: live chest strap over the standard Heart Rate Service. Works with any strap that
 * implements the SIG Heart Rate Service; the Polar H10 is the target and the default filter
 * accepts any heart rate device.
 */
import { BleSource, type BleSourceOptions } from '../ble';
import type { DeviceInput } from '../types';
import { DeviceSlot } from '../types';
import { BATTERY_LEVEL, BATTERY_SERVICE, HEART_RATE_MEASUREMENT, HEART_RATE_SERVICE } from './hrm';
import { ChestStrapPipeline } from './pipeline';

export interface PolarH10Options extends BleSourceOptions {
  /** Only list devices whose name starts with "Polar". Default false (any heart rate strap). */
  polarOnly?: boolean;
}

export class PolarH10 extends BleSource {
  readonly kind = 'chest_strap' as const;
  protected readonly slot = DeviceSlot.CHEST_STRAP;
  readonly pipeline: ChestStrapPipeline;
  private readonly popts: PolarH10Options;

  static requestOptions(polarOnly = false): RequestDeviceOptions {
    return {
      filters: polarOnly ? [{ namePrefix: 'Polar', services: [HEART_RATE_SERVICE] }] : [{ services: [HEART_RATE_SERVICE] }],
      optionalServices: [BATTERY_SERVICE],
    };
  }

  constructor(opts: PolarH10Options) {
    // A strap notifies about once a second; allow several missed beats before calling it stalled.
    super({ watchdogMs: 10000, ...opts });
    this.popts = opts;
    this.pipeline = new ChestStrapPipeline((type, ev) => this.em.emit(type, ev), opts.clock);
  }

  protected requestOptions(): RequestDeviceOptions {
    return PolarH10.requestOptions(this.popts.polarOnly);
  }

  protected decode(input: DeviceInput): void {
    this.pipeline.push(input);
  }

  protected async setup(server: BluetoothRemoteGATTServer): Promise<void> {
    const hrs = await server.getPrimaryService(HEART_RATE_SERVICE);
    const hrm = await hrs.getCharacteristic(HEART_RATE_MEASUREMENT);
    this.linkConnected({ name: this.deviceName });
    try {
      const bas = await server.getPrimaryService(BATTERY_SERVICE);
      const level = await bas.getCharacteristic(BATTERY_LEVEL);
      this.recordRead(level, await level.readValue());
      if (level.properties.notify) await this.subscribe(level, false);
    } catch {
      // battery service is optional
    }
    await this.subscribe(hrm, true);
  }
}
