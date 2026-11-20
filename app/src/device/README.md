# Device layer

Bluetooth link to the headset and the chest strap, decoding, the session clock, recording and
replay. Output is exactly what the engine's push functions take (`app/src/engine/frames.ts`).
Protocol facts, sources and the full verification record are in [NOTES.md](NOTES.md).

## Supported devices

| Device | Protocol | Streams | Status |
| --- | --- | --- | --- |
| Muse 2 | Classic | EEG 4 ch (TP9, AF7, AF8, TP10) 256 Hz 12-bit, optical 3 ch 64 Hz, accel + gyro 52 Hz, battery | Decoders checked against muse-js test vectors and synthetic packets. **No recorded Classic session yet.** |
| Muse S (older firmware), Muse 2016 | Classic | as above; optical only where the characteristics exist | as Muse 2 |
| Muse S Athena | Athena | EEG 4 or 8 ch 256 Hz 14-bit, optical 4/8/16 ch 64 Hz, accel + gyro 52 Hz, battery | Decoder identical to muse-rs and OpenMuse on 9 real captures (firmware 3.1.x). **Firmware 4.x not seen.** |
| Polar H10 (any standard heart rate strap) | SIG Heart Rate Service | RR intervals, heart rate, contact, battery | Parser checked against the SIG flag definitions and two implementations. Not tried on a strap. |

The original 2014 Muse uses classic Bluetooth, not BLE, and cannot be reached from a browser.

## Use

```ts
import { SessionClock, MuseDevice, PolarH10, Recorder, ReplaySource, mergeStreams } from './device';

const clock = new SessionClock({ eegRateHz: 256, hostOriginMs: performance.now() }); // null without a headset
const muse = new MuseDevice({ clock });            // options: athenaPreset, classicPpg, classicAux, reconnect...
const strap = new PolarH10({ clock });
const rec = new Recorder({ clock: { eegRateHz: 256 }, devices: [
  { slot: 0, kind: 'muse', name: null }, { slot: 1, kind: 'chest_strap', name: null }] });
rec.attach(muse); rec.attach(strap);

button.onclick = () => muse.start();               // must be called from a click or tap
muse.on('streams', (s) => /* configure the engine with mergeStreams(s, strapStreams) */ 0);
muse.on('eeg', (e) => engine.pushEeg(e.firstIndex, e.samples));
muse.on('ppg', (e) => engine.pushPpg(e.t, e.samples));
muse.on('motion', (e) => engine.pushMotion(e.t, e.acc, e.gyro));
strap.on('rr', (e) => engine.pushRr(e.t, e.rrMs));
muse.on('status', (s) => /* idle | requesting | connecting | starting | streaming | reconnecting | stopped | failed */ 0);
muse.on('gap', (g) => /* lost samples, already visible to the engine as an index jump */ 0);

const file = rec.finish();                          // Uint8Array, HBRAW format below
const replay = new ReplaySource(file, { speed: 'fast' }); // or speed: 1 for real time
```

`DeviceSource` (`types.ts`) is the one interface for `MuseDevice`, `PolarH10` and `ReplaySource`.
Events: `status`, `streams`, `eeg`, `ppg`, `motion`, `rr`, `heartRate`, `battery`, `gap`, `info`,
`error`, and `input` (every raw notification, for the recorder).

## Timing

One session clock. EEG time is the sample count (`firstIndex / 256`), from packet counters with
wrap handling, never from arrival time. A lost packet is an index jump of exactly its samples and
a `gap` event. Optical and motion samples are counted on their own clocks and mapped onto the
session clock; chest strap beats are stamped on arrival (the engine contract) through the host to
session mapping anchored on EEG. Where arrival time is used, and why, is listed in `clock.ts`.

## Raw recording format (HBRAW v1)

`'HBRAW\0'`, u16 version, u32 header length, JSON header (clock settings, devices), then records
`[u8 kind][zigzag varint Δarrival µs][varint length][body]`. Inputs: RAW (slot, characteristic id,
notification bytes) and LINK (connect/disconnect with the configuration used). Decoded records:
STREAMS, EEG, PPG, MOTION, RR, HR, BATTERY, GAP, INFO, NOTE. Full layout in
`recording/format.ts`. Replaying the inputs re-decodes the session through the same code and gives
identical output (asserted by a test). Measured on synthetic sessions: Muse 2 with optical and
motion 4 KiB/s raw only, 11 KiB/s with decoded samples (40 MiB per hour); Athena p1041 8 KiB/s raw
only, 23 KiB/s with decoded samples. `new Recorder(header, { decoded: false })` keeps raw only.

## Known limits

Browser and OS behaviour below is from Chrome's Web Bluetooth documentation as remembered, not
checked on the owner's machines.

- **Web Bluetooth needs a user gesture** for the chooser (`start()` from a click or tap) and a
  secure page (https or localhost). Reconnecting after a drop needs no gesture while the page is
  open. After a page reload the user must choose the device again.
- **Browsers:** Chrome or Edge on Windows, macOS, Linux, Android, ChromeOS. Not Firefox. Not
  Safari, and nothing on iPhone or iPad (no Web Bluetooth in any iOS browser).
- **Android:** Bluetooth must be on; older Android versions (before 12) also need Location on and
  the location permission granted to Chrome, otherwise the chooser finds nothing. Unverified on the
  owner's phone.
- **Windows:** pair nothing in Windows Settings first; let Chrome's chooser find the device. A
  headset paired to the Muse phone app or another computer will not advertise.
- One headset and one strap per session. The engine contract has no second EEG stream.
- Athena: 0x53 DRL/REF data is decoded but not passed on; the device clock in packet headers is
  not used; channel names 5-8 and the optical channel roles are provisional (see NOTES.md).
- Motion on Classic pairs the accelerometer and gyroscope characteristics by arrival order, with
  up to one packet (58 ms) of misalignment between them.

## Tests

`cd app && npx vitest run src/device`. Fixtures and their licences: `test/fixtures/SOURCES.txt`.
Reference outputs are regenerated with `python3 -I test/tools/make_reference.py` (needs the
reference clones described in that script).
