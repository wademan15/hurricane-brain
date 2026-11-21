# Live stream out

Sends the live data to other software on the same computer. A browser cannot send UDP or speak
LSL, so the app sends over a **WebSocket** to a small program the user runs
([`tools/stream-bridge`](../../../tools/stream-bridge/README.md)), and that program re-emits it as
OSC (Mind Monitor address style plus `/hb/`) and as Lab Streaming Layer streams.

```ts
import { StreamOut, DEFAULT_URL } from './stream';   // DEFAULT_URL = 'ws://localhost:8765'
const out = new StreamOut();
out.on('status', (s) => /* idle | connecting | open | error (reason, attempt, retryInMs) */ 0);
out.connect(urlTheUserTyped);      // nothing is opened or sent before this call
out.setStreams(streamDescription); // call whenever the engine is configured; re-sent on every reconnect
muse.on('eeg', (e) => out.handleEeg(e.firstIndex, e.samples));
muse.on('ppg', (e) => out.handlePpg(e.t, e.samples));
muse.on('motion', (e) => out.handleMotion(e.t, e.acc, e.gyro));
strap.on('rr', (e) => out.handleRr(e.t, e.rrMs));
muse.on('battery', (e) => out.handleBattery(e.percent, e.t));
for (const f of engine.drain()) out.handleFrame(f);
out.handleMarker(marker);
out.stats; // { sent, dropped, droppedNotOpen, droppedBackedUp, bytesSent }
```

Behaviour: only the URL the user enters is contacted (ws:// or wss://; the UI should suggest
`ws://localhost:8765` and let the user change it). Never throws into the caller. When the socket is not
open, or its send buffer holds more than 1 MiB, the message is dropped and counted (no queueing, so
live data is never delayed and memory never grows). On a lost connection it reconnects with backoff
500 ms, 1 s, 2 s ... capped at 10 s, and resends `hello` and `streams` on each open. `disconnect()`
stops it. Chrome allows `ws://localhost` from an https page; `ws://` to another machine from an https
page is blocked (mixed content), so use the bridge on the same computer.

## Wire protocol, version 1

One WebSocket, two message kinds. `protocol.ts` is the source of truth; `bridge.py` decodes the same.

### Binary (bulk samples): 16 byte header, then float32 little endian

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | u8 | magic `0x48` |
| 1 | u8 | protocol version (1) |
| 2 | u8 | kind: 1 EEG, 2 PPG |
| 3 | u8 | channel count |
| 4 | f64 | EEG: index of the first sample on the session clock (time = index / rate). PPG: session time of the first sample, seconds |
| 12 | u32 | samples per channel |
| 16 | f32[] | samples interleaved by channel, in the order of the `streams` message. EEG microvolts; PPG raw ADC units |

### Text: JSON objects with a `"type"`

| type | Fields |
| --- | --- |
| `hello` | `v` (protocol), `app`, `schema` (frame schema) |
| `streams` | `streams`: the engine `StreamDescription`. Sent before data and on every reconnect |
| `motion` | `t`, `acc[3]` g, `gyro[3]` deg/s |
| `rr` | `t`, `rr_ms[]` |
| `battery` | `t` (or null), `percent` |
| `marker` | `t`, `marker` (the Marker type), `label` |
| `slow` | `t`, `window_s`, `quality[]`, `bands[]` (site, band, above_bg_db, power), `tracks[]`, `dominant`, `pairs[]` (phi and octave only), `cascades.{phi,octave}` (with chance A and B), `states.{phi,octave,both}`, `iaf_hz`, `mains_hz`. The full spectra (psd, flat) are not sent |
| `fast` | `t`, `artifact`, `tracks[]` (id, freq, amp_uv, height_db, phase, locked) |
| `heart` | `t`, `source`, `beats[]`, hr_bpm, rmssd_ms, sdnn_ms, lf_power, hf_power, resonance_hz, resonance_strength, breath_bpm, breath_phase, pacer_adherence, corrected_fraction, `high_hrv`, `coupling[]` |

### Nulls

A `Measured` value is sent as a **number when measured, and as a string naming the reason when it is
not** (`"warming_up"`, `"bad_contact"`, ...). It is never 0 and never the previous value. Optional
plain numbers (`freq_se`, `iaf_hz`, `mains_hz`) use JSON `null`. In the bridge:

- **OSC:** the message for a missing value is **omitted** for that tick. With `--osc-absent` the bridge
  also sends `/hb/absent <address> <reason>` for each omitted value, so a receiver can tell "not
  measured" from "lost packet". An EEG sample containing a non-finite number is omitted whole.
- **LSL:** the channel is **NaN** (EEG, PPG, Motion pass NaN through).

## OSC address list

Mind Monitor style addresses (`/muse/...`) are sent only where this app has the equivalent data.
Everything else is under `/hb/`. Units as in `engine/frames.ts`.

| Address | Arguments | Notes |
| --- | --- | --- |
| `/muse/eeg` | f f f f | TP9, AF7, AF8, TP10 in microvolts, one message per sample (256 Hz), reordered by channel name. Only the four Muse sites; extra channels (Athena 8 ch) go to LSL only |
| `/muse/acc` | f f f | g |
| `/muse/gyro` | f f f | deg/s |
| `/muse/batt` | i i i i | `[percent*100, -1, -1, -1]`. We only know percent; the other three are unavailable and sent as -1 (Mind Monitor's "N/A" value). Interpretation of the first value is unverified |
| `/muse/elements/horseshoe` | f f f f | TP9, AF7, AF8, TP10. **1.0 if the engine marks the channel usable, 4.0 if not.** 2.0 ("medium") is never sent: the engine has no middle grade. Sent per slow frame (4 Hz) when all four channels are in the quality list |
| `/muse/elements/touching_forehead` | i | 1 if AF7 and AF8 are both usable, 0 if either is not. Omitted while either is warming up or has no data. Derived, not a sensor flag |
| `/muse/elements/blink` | i | 1 only while any channel's slow window contains a `blink` artifact. **Window based**, not an instantaneous detector: it stays 1 for up to the slow window length (8 s default) after a blink |
| `/hb/quality/{ch}` | i s | usable (0/1), reason |
| `/hb/artifact/{ch}/{kind}` | i | 1 while that artifact kind (blink, eye_movement, muscle, motion, pop, gap) is in the slow window |
| `/hb/band/{band}/{site}/above_bg_db` | f | engine band summary: mean power above the fitted background, dB |
| `/hb/band/{band}/{site}/power_uv2` | f | total band power, microvolts squared |
| `/hb/peaks/count` | i | confirmed peaks |
| `/hb/peaks/dominant` | i | id of the strongest confirmed peak (omitted if none) |
| `/hb/peak/{id}/{state,site,band}` | s | peaks in state confirmed or fading only |
| `/hb/peak/{id}/freq`, `freq_se`, `freq_integrated`, `height_db`, `width_hz`, `age_s` | f | Hz; `freq_se` is one standard error of `freq`; height above background in dB |
| `/hb/pair/{lo}/{hi}/log_ratio` | f | ln(f_hi / f_lo) |
| `/hb/pair/{lo}/{hi}/{phi,octave}/miss`, `closeness` | f | |
| `/hb/pair/{lo}/{hi}/{phi,octave}/aligned` | i | |
| `/hb/cascade/{phi,octave}/steps` | i | |
| `/hb/cascade/{phi,octave}/closeness`, `held_s`, `excess_a`, `excess_b` | f | |
| `/hb/cascade/{phi,octave}/chance_a/{closeness,p,p_steps}`, `chance_b/...` | f | chance level for the same cascade, both procedures |
| `/hb/state/{phi,octave,both}` | i | 0/1. Golden ratio alignment, octave alignment, and both at once |
| `/hb/state/{phi,octave,both}/for_s`; `/hb/state/{phi,octave}/stat` | f | |
| `/hb/iaf_hz`, `/hb/mains_hz` | f | omitted until known |
| `/hb/fast/artifact` | i | |
| `/hb/fast/{id}/{freq,amp_uv,height_db,phase}` | f | 32 Hz tracker |
| `/hb/fast/{id}/locked` | i | |
| `/hb/heart/source` | s | |
| `/hb/heart/{hr_bpm,rmssd_ms,sdnn_ms,lf_power,hf_power,resonance_hz,resonance_strength,breath_bpm,breath_phase,pacer_adherence,corrected_fraction}` | f | |
| `/hb/heart/high_hrv`, `/hb/heart/high_hrv/for_s`, `.../stat` | i, f, f | |
| `/hb/heart/beat` | f i | ibi_ms, flagged (0/1) |
| `/hb/coupling/{brain}/{measure}/{value,chance,p}` | f | `suspect_artifact` as i |
| `/hb/rr` | f | chest strap interval, ms |
| `/hb/battery` | f | percent |
| `/hb/marker` | s s | marker type, label |
| `/hb/absent` | s s | only with `--osc-absent`: address, reason |

### What is deliberately not under `/muse/`

- **Band powers** `/muse/elements/{delta..gamma}_absolute`: not sent. Mind Monitor's are the log of the
  power spectral density **per sensor** in Bels. Ours are per **site** (including composites like
  `temporal`), measured as dB above a fitted background, a different quantity. A receiver expecting
  Mind Monitor's would silently misread ours, so they live under `/hb/band/`.
- **`/muse/elements/jaw_clench`**: not sent. The engine reports a `muscle` artifact kind, which is not
  specific to jaw clenches. It is available as `/hb/artifact/{ch}/muscle`.
- Mind Monitor's `/Marker/n` button addresses, and the optional ppg/fnirs/aux messages: not sent.

### Verified against what

Mind Monitor's own FAQ page (https://mind-monitor.com/FAQ.php) and a forum thread
(https://musemonitor.com/forums/viewtopic.php?p=3345), fetched during development. The page text was
read through a summarising tool, not by hand, and no Mind Monitor install was run, so the address
list, argument counts, horseshoe 1/2/4 coding, blink/jaw_clench "only when true" behaviour and the
`/muse/batt` layout are as that page states them but **not tested against the real app or a real
receiver**. The default OSC port 5000 is not stated on that page; it is from memory. Nothing here was
tried with TouchDesigner, Max, Resolume or similar.

## LSL streams

All created by the bridge (prefix `HurricaneBrain`, change with `--lsl-prefix`), `source_id`
`hurricane-brain-<Name>`.

| Stream | Type | Channels | Rate | Unit |
| --- | --- | --- | --- | --- |
| `HurricaneBrain-EEG` | EEG | the labels in the stream description (TP9, AF7, AF8, TP10, ...) | the device rate (256 Hz) | microvolts |
| `HurricaneBrain-Motion` | Motion | acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z | the device rate (52 Hz) | g, deg/s |
| `HurricaneBrain-PPG` | PPG | the device's optical channel labels | 64 Hz | raw ADC units |
| `HurricaneBrain-Markers` | Markers | 1 string | irregular | `state:{phi,octave,both,high_hrv}:{on,off}` on a state change (not for the first observed value), `marker:<type>[:<label>]` for app markers |
| `HurricaneBrain-Metrics` | Metrics | see below, float32 | irregular | various; labels in the stream's channel metadata |

Metrics: one sample per slow frame (4 Hz) and per heart frame, plus one per chest strap interval and
battery report. **A sample carries only the values of the frame that produced it; all other channels
are NaN.** Values are never held from an earlier frame. NaN also means "not measured". Channels:
`band_{delta..gamma}_{TP9,AF7,AF8,TP10}_above_bg_db`, `peak_count`, `dominant_freq_hz`,
`dominant_height_db`, `{phi,octave}_{active,for_s,stat,steps,closeness,excess_a,excess_b,chance_a_closeness,chance_a_p,chance_b_closeness,chance_b_p}`,
`both_active`, `both_for_s`, `iaf_hz`, `hr_bpm`, `rmssd_ms`, `sdnn_ms`, `lf_power`, `hf_power`,
`resonance_hz`, `resonance_strength`, `breath_bpm`, `pacer_adherence`, `high_hrv_active`,
`high_hrv_for_s`, `rr_ms`, `battery_percent`. The fast tracker, pairs and coupling are OSC only.

### Timestamps and their limit

Every message carries session time (EEG index / rate, 0 = first EEG sample). The bridge maps it to the
LSL clock **once**, at the first timed message: `lsl_time = session_time + (local_clock() - first
session_time)`. That offset therefore includes the WebSocket and processing delay of that first
message (typically a few milliseconds on localhost), is never re-estimated, and absorbs any clock
rate difference between the browser and the bridge computer over a long session. Within a stream,
relative timing is exact (EEG timestamps are index-based, a lost packet is a gap). Across streams the
alignment is good to roughly that first-message delay, not to sub-millisecond. If the app is
restarted, restart the bridge too (a new session clock starts at 0).
