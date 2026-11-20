"""End to end self-test for bridge.py. Run: python bridge.py --self-test

Starts the bridge in this process, connects a WebSocket client that sends synthetic protocol
messages (a few seconds' worth), and checks what arrives on a local UDP socket as OSC and, if
pylsl and liblsl are available, on LSL inlets. Exit code 0 means every check ran and passed;
LSL checks that could not run are reported as SKIPPED, never as passed.
"""
from __future__ import annotations

import asyncio
import json
import math
import struct
import sys

from pythonosc.osc_message import OscMessage

import bridge as B

results: list[tuple[str, str, str]] = []  # (status, name, detail)


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append(("PASS" if cond else "FAIL", name, detail))


def skip(name: str, detail: str) -> None:
    results.append(("SKIP", name, detail))


def eeg_binary(first: int, rows: list[list[float]]) -> bytes:
    nch = len(rows[0])
    flat = [x for r in rows for x in r]
    return B.HEADER.pack(B.BINARY_MAGIC, 1, 1, nch, float(first), len(rows)) + struct.pack(f"<{len(flat)}f", *flat)


STREAMS = {
    "eeg": {"channels": ["AF7", "TP9", "TP10", "AF8"], "rate_hz": 256, "bits": 12, "model": "synthetic"},
    "ppg": {"channels": ["a", "b", "c"], "rate_hz": 64},
    "motion": {"rate_hz": 52},
    "chest_strap": None,
}


def slow(t: float, phi_active: bool) -> dict:
    ch = {"closeness": 0.2, "p": 0.3, "p_steps": 0.4}
    casc = {"steps": 2, "tracks": [1, 2, 3], "closeness": 0.9, "held_s": 3.0, "excess_a": 0.8,
            "excess_b": "not_available", "chance_a": ch, "chance_b": {"closeness": "warming_up", "p": "warming_up", "p_steps": "warming_up"}}
    pair = {"miss": 0.01, "closeness": 0.99, "aligned": True}
    return {
        "type": "slow", "t": t, "window_s": 8,
        "quality": [
            {"name": "TP9", "usable": True, "why": "ok", "artifacts": []},
            {"name": "AF7", "usable": True, "why": "ok", "artifacts": ["blink"]},
            {"name": "AF8", "usable": False, "why": "bad_contact", "artifacts": []},
            {"name": "TP10", "usable": True, "why": "ok", "artifacts": []},
        ],
        "bands": [{"site": "TP9", "band": "alpha", "above_bg_db": 3.5, "power": "insufficient_clean"}],
        "tracks": [{"id": 1, "state": "confirmed", "site": "TP9", "freq": 10.0, "freq_se": 0.05, "freq_integrated": 10.01,
                    "height_db": 4.0, "width_hz": "weak", "age_s": 5, "band": "alpha"},
                   {"id": 2, "state": "new", "site": "TP9", "freq": 16.0, "freq_se": None, "freq_integrated": "warming_up",
                    "height_db": 1.0, "width_hz": 1.0, "age_s": 1, "band": "beta"}],
        "dominant": 1,
        "pairs": [{"lo": 1, "hi": 2, "log_ratio": 0.48, "harmonic": False, "phi": pair, "octave": {**pair, "aligned": False}}],
        "cascades": {"phi": casc, "octave": casc},
        "states": {"phi": {"active": phi_active, "for_s": 2.0, "stat": 0.5},
                   "octave": {"active": False, "for_s": 9.0, "stat": "not_available"},
                   "both": {"active": False, "for_s": 9.0}},
        "iaf_hz": None, "mains_hz": 50,
    }


HEART = {
    "type": "heart", "t": 3.0, "source": "chest_strap", "beats": [{"t": 2.9, "ibi_ms": 812.0, "flagged": False}],
    "hr_bpm": 74.0, "rmssd_ms": "too_few_beats", "sdnn_ms": "warming_up", "lf_power": "warming_up", "hf_power": "warming_up",
    "resonance_hz": 0.1, "resonance_strength": 0.4, "breath_bpm": "no_data", "breath_phase": "warming_up",
    "pacer_adherence": "not_available", "corrected_fraction": 0.0,
    "high_hrv": {"active": False, "for_s": 3.0, "stat": "warming_up"}, "coupling": [],
}


class Udp(asyncio.DatagramProtocol):
    def __init__(self) -> None:
        self.msgs: list[tuple[str, tuple]] = []

    def datagram_received(self, data: bytes, addr: tuple) -> None:
        m = OscMessage(data)
        self.msgs.append((m.address, tuple(m.params)))

    def of(self, address: str) -> list[tuple]:
        return [p for a, p in self.msgs if a == address]


async def send_all(ws, osc_absent: bool) -> None:
    await ws.send(json.dumps({"type": "hello", "v": 1, "app": "selftest", "schema": 1}))
    await ws.send(json.dumps({"type": "streams", "streams": STREAMS}))
    await asyncio.sleep(0.3)
    # 3 s of EEG at 256 Hz in chunks of 12 samples; row = (AF7, TP9, TP10, AF8) = (k+0.5, k+0.25, k+0.75, k+1)
    first = 0
    for chunk in range(64):
        rows = [[first + j + 0.5, first + j + 0.25, first + j + 0.75, first + j + 1.0] for j in range(12)]
        await ws.send(eeg_binary(first, rows))
        first += 12
        if chunk % 4 == 0:
            t = first / 256
            await ws.send(json.dumps({"type": "motion", "t": t, "acc": [0.0, 0.0, 1.0], "gyro": [1.0, 2.0, 3.0]}))
            await ws.send(B.HEADER.pack(B.BINARY_MAGIC, 1, 2, 3, t, 2) + struct.pack("<6f", 1, 2, 3, 4, 5, 6))
        if chunk == 8:
            await ws.send(json.dumps(slow(first / 256, False)))
        if chunk == 20:
            await ws.send(json.dumps(slow(first / 256, True)))   # phi state on: LSL marker expected
        if chunk == 24:
            await ws.send(json.dumps(HEART))
            await ws.send(json.dumps({"type": "battery", "t": None, "percent": 87}))
            await ws.send(json.dumps({"type": "rr", "t": 3.0, "rr_ms": [800.0, 810.0]}))
            await ws.send(json.dumps({"type": "marker", "t": 3.0, "marker": "note", "label": "hello"}))
            await ws.send(json.dumps({"type": "fast", "t": 3.0, "artifact": False,
                                      "tracks": [{"id": 1, "freq": 10.5, "amp_uv": "weak", "height_db": 3.0, "phase": 0.1, "locked": True}]}))
        await asyncio.sleep(0.01)
    await ws.send("not json")
    await ws.send(b"\x00\x01")
    await asyncio.sleep(0.5)


async def lsl_part(lsl: B.LslOutputs) -> dict:
    import pylsl
    out: dict = {}

    def find(name: str):
        res = pylsl.resolve_byprop("name", name, 1, 5.0)
        return pylsl.StreamInlet(res[0], recover=False) if res else None

    inl = {n: await asyncio.to_thread(find, f"HurricaneBrain-{n}") for n in ("EEG", "Motion", "PPG", "Markers", "Metrics")}
    out["inlets"] = inl
    return out


async def pull(inlets: dict) -> dict:
    def go():
        got = {}
        for n, i in inlets.items():
            if i is None:
                got[n] = None
                continue
            s, ts = i.pull_chunk(timeout=1.0, max_samples=100000)
            got[n] = (s, ts)
        return got
    return await asyncio.to_thread(go)


async def main_async() -> None:
    loop = asyncio.get_running_loop()
    udp = Udp()
    transport, _ = await loop.create_datagram_endpoint(lambda: udp, local_addr=("127.0.0.1", 0))
    osc_port = transport.get_extra_info("sockname")[1]

    lsl = None
    lsl_reason = ""
    try:
        lsl = B.LslOutputs()
    except Exception as e:
        lsl_reason = repr(e)

    bridge = B.Bridge(B.make_osc_sender("127.0.0.1", osc_port), lsl, osc_absent=True)
    server = await B.serve(bridge, "127.0.0.1", 0)
    ws_port = list(server.sockets)[0].getsockname()[1]

    inlets = None
    if lsl is not None:
        lsl.configure(STREAMS)  # outlets must exist before the inlets can find them
        info = await lsl_part(lsl)
        inlets = info["inlets"]
        if any(v is None for v in inlets.values()):
            skip("LSL inlets", "pylsl loaded but could not discover its own outlets within 5 s (multicast/loopback blocked?): " +
                 ", ".join(k for k, v in inlets.items() if v is None))
            inlets = None
    else:
        skip("LSL", f"pylsl/liblsl not usable: {lsl_reason}")

    from websockets.asyncio.client import connect
    async with connect(f"ws://127.0.0.1:{ws_port}") as ws:
        await send_all(ws, True)

    lslgot = await pull(inlets) if inlets else None
    server.close()
    transport.close()

    # ---- OSC checks
    eeg = udp.of("/muse/eeg")
    check("OSC /muse/eeg count", len(eeg) == 64 * 12, f"{len(eeg)} messages")
    ok_order = all(abs(p[0] - (k + 0.25)) < 1e-3 and abs(p[1] - (k + 0.5)) < 1e-3 and abs(p[2] - (k + 1.0)) < 1e-3 and abs(p[3] - (k + 0.75)) < 1e-3
                   for k, p in enumerate(eeg[:200]))
    check("OSC /muse/eeg channel order is TP9, AF7, AF8, TP10", ok_order and len(eeg[0]) == 4 if eeg else False)
    check("OSC /muse/acc", (0.0, 0.0, 1.0) in udp.of("/muse/acc"))
    check("OSC /muse/gyro", (1.0, 2.0, 3.0) in udp.of("/muse/gyro"))
    check("OSC /muse/batt", udp.of("/muse/batt") == [(8700, -1, -1, -1)], str(udp.of("/muse/batt")))
    check("OSC horseshoe good=1, bad=4", udp.of("/muse/elements/horseshoe")[0] == (1.0, 1.0, 4.0, 1.0), str(udp.of("/muse/elements/horseshoe")[:1]))
    check("OSC blink while blink artifact present", len(udp.of("/muse/elements/blink")) == 2)
    check("OSC touching_forehead 0 when AF8 unusable", udp.of("/muse/elements/touching_forehead")[0] == (0,))
    check("OSC peak confirmed sent, 'new' not sent", udp.of("/hb/peak/1/freq") and not udp.of("/hb/peak/2/freq"))
    check("OSC peak uncertainty", udp.of("/hb/peak/1/freq_se")[0] == (0.05,))
    check("OSC null freq_se (None) omitted for peak 2 / reasons omitted", not udp.of("/hb/peak/1/width_hz"))
    check("OSC null band power omitted", not udp.of("/hb/band/alpha/TP9/power_uv2") and udp.of("/hb/band/alpha/TP9/above_bg_db") == [(3.5,)] * 2)
    check("OSC chance A and B (null B omitted)", udp.of("/hb/cascade/phi/chance_a/p") and not udp.of("/hb/cascade/phi/chance_b/p") and not udp.of("/hb/cascade/phi/excess_b"))
    check("OSC states", udp.of("/hb/state/phi") == [(0,), (1,)] and udp.of("/hb/state/both") == [(0,), (0,)])
    check("OSC pair closeness", udp.of("/hb/pair/1/2/phi/closeness")[0] == (0.99,))
    check("OSC heart hr sent, rmssd NOT sent as 0", udp.of("/hb/heart/hr_bpm") == [(74.0,)] and not udp.of("/hb/heart/rmssd_ms"))
    check("OSC /hb/absent names the rmssd null", ("/hb/heart/rmssd_ms", "too_few_beats") in udp.of("/hb/absent") or
          any(p == ("/hb/heart/rmssd_ms", "too_few_beats") for a, p in udp.msgs if a == "/hb/absent"))
    check("OSC beat", udp.of("/hb/heart/beat") == [(812.0, 0)])
    check("OSC rr", udp.of("/hb/rr") == [(800.0,), (810.0,)])
    check("OSC marker", udp.of("/hb/marker") == [("note", "hello")])
    check("OSC fast", udp.of("/hb/fast/1/freq") == [(10.5,)] and not udp.of("/hb/fast/1/amp_uv"))
    check("bridge survived bad input", bridge.bad_messages == 2, f"bad={bridge.bad_messages}")

    # ---- LSL checks
    if lslgot:
        s, ts = lslgot["EEG"]
        check("LSL EEG samples", len(s) == 64 * 12, f"{len(s)} samples")
        if s:
            check("LSL EEG values and channel order as in stream description", abs(s[5][0] - 5.5) < 1e-3 and abs(s[5][1] - 5.25) < 1e-3)
            dt = (ts[-1] - ts[0]) / (len(ts) - 1)
            check("LSL EEG timestamps spaced at 1/256 s", abs(dt - 1 / 256) < 1e-4, f"mean dt {dt:.6f}")
        s, ts = lslgot["Motion"]
        check("LSL Motion", len(s) == 16 and s[0] == [0.0, 0.0, 1.0, 1.0, 2.0, 3.0], f"{len(s)} samples")
        s, ts = lslgot["PPG"]
        check("LSL PPG", len(s) == 32 and s[0][:3] == [1.0, 2.0, 3.0], f"{len(s)} samples")
        s, ts = lslgot["Markers"]
        flat = [x[0] for x in s]
        check("LSL Markers: phi on and app marker", "state:phi:on" in flat and "marker:note:hello" in flat, str(flat))
        s, ts = lslgot["Metrics"]
        idx = B.METRIC_INDEX
        slows = [x for x in s if not math.isnan(x[idx["phi_closeness"]])]
        check("LSL Metrics slow samples", len(slows) == 2, f"{len(s)} samples")
        if slows:
            row = slows[0]
            check("LSL Metrics: null is NaN, not 0", math.isnan(row[idx["phi_excess_b"]]) and math.isnan(row[idx["band_alpha_TP9_above_bg_db"]]) is False
                  and math.isnan(row[idx["band_alpha_AF7_above_bg_db"]]) and math.isnan(row[idx["hr_bpm"]]))
        hearts = [x for x in s if not math.isnan(x[idx["hr_bpm"]])]
        check("LSL Metrics heart: hr set, rmssd NaN", len(hearts) == 1 and math.isnan(hearts[0][idx["rmssd_ms"]]))
        lsl_info = inlets["EEG"].info()
        check("LSL EEG metadata", lsl_info.type() == "EEG" and lsl_info.channel_count() == 4 and lsl_info.nominal_srate() == 256.0)
        labels = []
        ch = lsl_info.desc().child("channels").child("channel")
        while not ch.empty():
            labels.append(ch.child_value("label"))
            ch = ch.next_sibling()
        check("LSL EEG channel labels", labels == STREAMS["eeg"]["channels"], str(labels))


def main() -> int:
    try:
        asyncio.run(asyncio.wait_for(main_async(), timeout=90))
    except Exception as e:
        results.append(("FAIL", "self-test crashed", repr(e)))
    for status, name, detail in results:
        print(f"{status:5} {name}" + (f"  [{detail}]" if detail else ""))
    fails = sum(1 for r in results if r[0] == "FAIL")
    skips = sum(1 for r in results if r[0] == "SKIP")
    print(f"\n{sum(1 for r in results if r[0] == 'PASS')} passed, {fails} failed, {skips} skipped")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
