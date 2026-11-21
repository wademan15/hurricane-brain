# Hurricane Brain stream bridge

A small Python program that receives the app's live stream over a WebSocket and re-emits it as
**OSC over UDP** (Mind Monitor style addresses plus `/hb/...`) and as **Lab Streaming Layer** streams.
Run it on the same computer as Chrome. Protocol, full OSC address list, null handling and LSL channel
lists: [`app/src/stream/README.md`](../../app/src/stream/README.md).

## Setup on Windows 11

1. Install Python 3.10 or newer from python.org (tick "Add python.exe to PATH").
2. Open PowerShell in this folder and run:
   ```
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt
   ```
   `pylsl` ships liblsl for Windows. If it fails to install the bridge still runs with OSC only.
3. Start it: `python bridge.py`. The first time, Windows Firewall may ask about Python; for OSC and
   LSL on this one computer, "Cancel"/private networks only is enough. LSL to another computer on the
   LAN needs "Allow" on private networks.
4. In the app, open Live stream out, keep `ws://localhost:8765` and press Connect.

## Options

```
--ws-host 127.0.0.1  --ws-port 8765      where the app connects (this computer only by default)
--osc-host 127.0.0.1 --osc-port 5000     where OSC goes (5000 is the port Mind Monitor users usually use)
--no-osc | --no-lsl                      turn an output off
--osc-absent                             also send /hb/absent <address> <reason> for values not measured
--lsl-prefix HurricaneBrain              LSL stream name prefix
--origin http://localhost:5173           only accept the app from this page origin (repeatable)
-v                                       print message counts every 10 s
```

If `pylsl` or `liblsl` is missing the bridge prints "LSL is OFF" and carries on with OSC.
Anyone who can reach the WebSocket port can feed the bridge, which is why it listens on 127.0.0.1 by
default; use `--origin` if you want only the app's page accepted.

## Check that it works

1. **Without the app:** `python bridge.py --self-test`. It starts the bridge, sends a few seconds of
   synthetic messages, and checks the OSC that arrives on a local UDP socket and the LSL streams it can
   read back. It prints PASS, FAIL or SKIPPED per check (LSL checks are SKIPPED, not passed, if liblsl
   cannot run).
2. **With the app:** start the bridge, press Connect in the app. The bridge prints "app connected".
   The app's status shows `open`, and its drop counter should stay near 0.
3. **OSC:** point any OSC monitor at `127.0.0.1:5000` (for example Protokol, or a TouchDesigner OSC In
   chop) and look for `/muse/eeg` and `/hb/...`. Only one program can listen on a UDP port; close
   Mind Monitor receivers on the same port.
4. **LSL:** open LabRecorder or any LSL viewer; `HurricaneBrain-EEG`, `-Motion`, `-PPG`, `-Markers`
   and `-Metrics` should be listed once data is flowing (EEG/Motion/PPG appear after the app sends
   its stream description, i.e. when the headset connects).

Restart the bridge when you restart the app's session (the session clock restarts at 0).

## What is not verified

Run against synthetic data only: no real Muse, no real app session, no Windows machine, no third-party
OSC or LSL receiver other than python-osc and pylsl themselves. Mind Monitor compatibility is from
its public FAQ, not tested against Mind Monitor receivers (see the app README).
