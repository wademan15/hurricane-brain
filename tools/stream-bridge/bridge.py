#!/usr/bin/env python3
"""Hurricane Brain stream bridge.

Receives the app's live stream over a WebSocket (protocol v1, see app/src/stream/README.md)
and re-emits it as OSC over UDP (Mind Monitor address style plus /hb/ addresses) and as
Lab Streaming Layer outlets. Run it on the same computer as the browser.

    python bridge.py                      # ws://127.0.0.1:8765  ->  OSC 127.0.0.1:5000 + LSL
    python bridge.py --no-lsl             # OSC only
    python bridge.py --self-test          # end to end check, no app needed

Null discipline: a value the app reports as "not measured" is never sent as 0.
OSC: that value's message is omitted (optionally announced on /hb/absent with --osc-absent).
LSL: that channel is NaN.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import struct
import sys
from typing import Any, Callable, Optional

PROTOCOL_VERSION = 1
BINARY_MAGIC = 0x48
HEADER = struct.Struct("<BBBBdI")  # magic, version, kind, channels, position(f64), samples per channel
assert HEADER.size == 16

log = logging.getLogger("hb-bridge")

MM_ORDER = ["TP9", "AF7", "AF8", "TP10"]
BANDS = ["delta", "theta", "alpha", "beta", "gamma"]
SITES = ["TP9", "AF7", "AF8", "TP10"]

OscMsg = tuple[str, list]


def num(x: Any) -> Optional[float]:
    """A finite number, or None. Strings (null reasons), bools and None are None."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    f = float(x)
    return f if math.isfinite(f) else None


def addr_part(s: Any) -> str:
    """Make a string safe as one OSC address part."""
    out = "".join("_" if c in " #*,/?[]{}" else c for c in str(s))
    return out or "_"


class Collector:
    """Collects OSC messages for one incoming app message, plus the values that were absent."""

    def __init__(self) -> None:
        self.msgs: list[OscMsg] = []
        self.absent: list[tuple[str, str]] = []

    def f(self, address: str, x: Any) -> None:
        v = num(x)
        if v is None:
            self.absent.append((address, x if isinstance(x, str) else "null"))
        else:
            self.msgs.append((address, [v]))

    def i(self, address: str, x: Any) -> None:
        if x is None or isinstance(x, str):
            self.absent.append((address, x if isinstance(x, str) else "null"))
        else:
            self.msgs.append((address, [int(x)]))

    def s(self, address: str, x: Any) -> None:
        if x is None:
            self.absent.append((address, "null"))
        else:
            self.msgs.append((address, [str(x)]))

    def raw(self, address: str, args: list) -> None:
        self.msgs.append((address, args))


# ---------------------------------------------------------------------------
# OSC mapping (pure functions; the address list is documented in README.md)
# ---------------------------------------------------------------------------

def horseshoe_and_forehead(quality: list[dict], c: Collector) -> None:
    by = {q.get("name"): q for q in quality}
    # /muse/elements/horseshoe: 1 = good (channel usable), 4 = bad (not usable). 2 is never sent.
    if all(n in by for n in MM_ORDER):
        c.raw("/muse/elements/horseshoe", [1.0 if by[n].get("usable") else 4.0 for n in MM_ORDER])
    # touching_forehead: only when both forehead channels have a verdict (not warming up / no data).
    if all(n in by and by[n].get("why") not in ("warming_up", "no_data") for n in ("AF7", "AF8")):
        c.raw("/muse/elements/touching_forehead", [1 if by["AF7"].get("usable") and by["AF8"].get("usable") else 0])
    # blink: sent (1) only while a blink artifact is in the slow window of any channel.
    if any("blink" in (q.get("artifacts") or []) for q in quality):
        c.raw("/muse/elements/blink", [1])
    for q in quality:
        n = addr_part(q.get("name"))
        c.raw(f"/hb/quality/{n}", [1 if q.get("usable") else 0, str(q.get("why"))])
        for kind in q.get("artifacts") or []:
            c.raw(f"/hb/artifact/{n}/{addr_part(kind)}", [1])


def cascade_msgs(name: str, cas: dict, c: Collector) -> None:
    p = f"/hb/cascade/{name}"
    c.i(f"{p}/steps", cas.get("steps"))
    c.f(f"{p}/closeness", cas.get("closeness"))
    c.f(f"{p}/held_s", cas.get("held_s"))
    c.f(f"{p}/excess_a", cas.get("excess_a"))
    c.f(f"{p}/excess_b", cas.get("excess_b"))
    for ab in ("a", "b"):
        ch = cas.get(f"chance_{ab}") or {}
        c.f(f"{p}/chance_{ab}/closeness", ch.get("closeness"))
        c.f(f"{p}/chance_{ab}/p", ch.get("p"))
        c.f(f"{p}/chance_{ab}/p_steps", ch.get("p_steps"))


def osc_slow(m: dict) -> Collector:
    c = Collector()
    horseshoe_and_forehead(m.get("quality") or [], c)
    for b in m.get("bands") or []:
        base = f"/hb/band/{addr_part(b.get('band'))}/{addr_part(b.get('site'))}"
        c.f(f"{base}/above_bg_db", b.get("above_bg_db"))
        c.f(f"{base}/power_uv2", b.get("power"))
    tracks = m.get("tracks") or []
    conf = [t for t in tracks if t.get("state") in ("confirmed", "fading")]
    c.raw("/hb/peaks/count", [sum(1 for t in tracks if t.get("state") == "confirmed")])
    if m.get("dominant") is not None:
        c.raw("/hb/peaks/dominant", [int(m["dominant"])])
    for t in conf:
        p = f"/hb/peak/{int(t['id'])}"
        c.s(f"{p}/state", t.get("state"))
        c.s(f"{p}/site", t.get("site"))
        c.s(f"{p}/band", t.get("band"))
        c.f(f"{p}/freq", t.get("freq"))
        c.f(f"{p}/freq_se", t.get("freq_se"))
        c.f(f"{p}/freq_integrated", t.get("freq_integrated"))
        c.f(f"{p}/height_db", t.get("height_db"))
        c.f(f"{p}/width_hz", t.get("width_hz"))
        c.f(f"{p}/age_s", t.get("age_s"))
    for pr in m.get("pairs") or []:
        p = f"/hb/pair/{int(pr['lo'])}/{int(pr['hi'])}"
        c.f(f"{p}/log_ratio", pr.get("log_ratio"))
        for target in ("phi", "octave"):
            tt = pr.get(target) or {}
            c.f(f"{p}/{target}/miss", tt.get("miss"))
            c.f(f"{p}/{target}/closeness", tt.get("closeness"))
            c.i(f"{p}/{target}/aligned", 1 if tt.get("aligned") else 0)
    cas = m.get("cascades") or {}
    for name in ("phi", "octave"):
        if name in cas:
            cascade_msgs(name, cas[name], c)
    st = m.get("states") or {}
    for name in ("phi", "octave"):
        if name in st:
            c.i(f"/hb/state/{name}", 1 if st[name].get("active") else 0)
            c.f(f"/hb/state/{name}/for_s", st[name].get("for_s"))
            c.f(f"/hb/state/{name}/stat", st[name].get("stat"))
    if "both" in st:
        c.i("/hb/state/both", 1 if st["both"].get("active") else 0)
        c.f("/hb/state/both/for_s", st["both"].get("for_s"))
    c.f("/hb/iaf_hz", m.get("iaf_hz"))
    c.f("/hb/mains_hz", m.get("mains_hz"))
    return c


def osc_fast(m: dict) -> Collector:
    c = Collector()
    c.i("/hb/fast/artifact", 1 if m.get("artifact") else 0)
    for t in m.get("tracks") or []:
        p = f"/hb/fast/{int(t['id'])}"
        c.f(f"{p}/freq", t.get("freq"))
        c.f(f"{p}/amp_uv", t.get("amp_uv"))
        c.f(f"{p}/height_db", t.get("height_db"))
        c.f(f"{p}/phase", t.get("phase"))
        c.i(f"{p}/locked", 1 if t.get("locked") else 0)
    return c


def osc_heart(m: dict) -> Collector:
    c = Collector()
    p = "/hb/heart"
    c.s(f"{p}/source", m.get("source"))
    for k in ("hr_bpm", "rmssd_ms", "sdnn_ms", "lf_power", "hf_power", "resonance_hz",
              "resonance_strength", "breath_bpm", "breath_phase", "pacer_adherence"):
        c.f(f"{p}/{k}", m.get(k))
    c.f(f"{p}/corrected_fraction", m.get("corrected_fraction"))
    hh = m.get("high_hrv") or {}
    c.i(f"{p}/high_hrv", 1 if hh.get("active") else 0)
    c.f(f"{p}/high_hrv/for_s", hh.get("for_s"))
    c.f(f"{p}/high_hrv/stat", hh.get("stat"))
    for b in m.get("beats") or []:
        c.raw(f"{p}/beat", [float(b["ibi_ms"]), 1 if b.get("flagged") else 0])
    for cp in m.get("coupling") or []:
        base = f"/hb/coupling/{addr_part(cp.get('brain'))}/{addr_part(cp.get('measure'))}"
        c.f(f"{base}/value", cp.get("value"))
        c.f(f"{base}/chance", cp.get("chance"))
        c.f(f"{base}/p", cp.get("p"))
        c.i(f"{base}/suspect_artifact", 1 if cp.get("suspect_artifact") else 0)
    return c


def osc_motion(m: dict) -> Collector:
    c = Collector()
    acc = [num(x) for x in m.get("acc") or []]
    gyro = [num(x) for x in m.get("gyro") or []]
    if len(acc) == 3 and None not in acc:
        c.raw("/muse/acc", acc)
    else:
        c.absent.append(("/muse/acc", "null"))
    if len(gyro) == 3 and None not in gyro:
        c.raw("/muse/gyro", gyro)
    else:
        c.absent.append(("/muse/gyro", "null"))
    return c


def osc_battery(m: dict) -> Collector:
    c = Collector()
    p = num(m.get("percent"))
    if p is None:
        c.absent.append(("/muse/batt", "null"))
        return c
    # Mind Monitor: 4 ints [percent*100, millivolts, adc volts or -1, temperature]. We only have
    # percent; the other three are unavailable and are sent as -1 (Mind Monitor's "N/A" value).
    c.raw("/muse/batt", [int(round(p * 100)), -1, -1, -1])
    c.raw("/hb/battery", [p])
    return c


def osc_rr(m: dict) -> Collector:
    c = Collector()
    for r in m.get("rr_ms") or []:
        if num(r) is not None:
            c.raw("/hb/rr", [float(r)])
    return c


def osc_marker(m: dict) -> Collector:
    c = Collector()
    c.raw("/hb/marker", [str(m.get("marker")), "" if m.get("label") is None else str(m.get("label"))])
    return c


# ---------------------------------------------------------------------------
# LSL
# ---------------------------------------------------------------------------

METRIC_CHANNELS: list[str] = (
    [f"band_{b}_{s}_above_bg_db" for b in BANDS for s in SITES]
    + ["peak_count", "dominant_freq_hz", "dominant_height_db"]
    + [f"{t}_{k}" for t in ("phi", "octave") for k in
       ("active", "for_s", "stat", "steps", "closeness", "excess_a", "excess_b",
        "chance_a_closeness", "chance_a_p", "chance_b_closeness", "chance_b_p")]
    + ["both_active", "both_for_s", "iaf_hz"]
    + ["hr_bpm", "rmssd_ms", "sdnn_ms", "lf_power", "hf_power", "resonance_hz", "resonance_strength",
       "breath_bpm", "pacer_adherence", "high_hrv_active", "high_hrv_for_s", "rr_ms", "battery_percent"]
)
METRIC_INDEX = {n: i for i, n in enumerate(METRIC_CHANNELS)}


def metrics_slow(m: dict) -> list[float]:
    v = [math.nan] * len(METRIC_CHANNELS)

    def put(name: str, x: Any) -> None:
        n = num(x)
        if n is not None:
            v[METRIC_INDEX[name]] = n

    for b in m.get("bands") or []:
        key = f"band_{b.get('band')}_{b.get('site')}_above_bg_db"
        if key in METRIC_INDEX:
            put(key, b.get("above_bg_db"))
    tracks = m.get("tracks") or []
    put("peak_count", sum(1 for t in tracks if t.get("state") == "confirmed"))
    dom = next((t for t in tracks if t.get("id") == m.get("dominant")), None)
    if dom is not None:
        put("dominant_freq_hz", dom.get("freq_integrated"))
        put("dominant_height_db", dom.get("height_db"))
    st = m.get("states") or {}
    cas = m.get("cascades") or {}
    for t in ("phi", "octave"):
        if t in st:
            put(f"{t}_active", 1 if st[t].get("active") else 0)
            put(f"{t}_for_s", st[t].get("for_s"))
            put(f"{t}_stat", st[t].get("stat"))
        if t in cas:
            c = cas[t]
            put(f"{t}_steps", c.get("steps"))
            put(f"{t}_closeness", c.get("closeness"))
            put(f"{t}_excess_a", c.get("excess_a"))
            put(f"{t}_excess_b", c.get("excess_b"))
            put(f"{t}_chance_a_closeness", (c.get("chance_a") or {}).get("closeness"))
            put(f"{t}_chance_a_p", (c.get("chance_a") or {}).get("p"))
            put(f"{t}_chance_b_closeness", (c.get("chance_b") or {}).get("closeness"))
            put(f"{t}_chance_b_p", (c.get("chance_b") or {}).get("p"))
    if "both" in st:
        put("both_active", 1 if st["both"].get("active") else 0)
        put("both_for_s", st["both"].get("for_s"))
    put("iaf_hz", m.get("iaf_hz"))
    return v


def metrics_heart(m: dict) -> list[float]:
    v = [math.nan] * len(METRIC_CHANNELS)
    for k in ("hr_bpm", "rmssd_ms", "sdnn_ms", "lf_power", "hf_power", "resonance_hz",
              "resonance_strength", "breath_bpm", "pacer_adherence"):
        n = num(m.get(k))
        if n is not None:
            v[METRIC_INDEX[k]] = n
    hh = m.get("high_hrv") or {}
    v[METRIC_INDEX["high_hrv_active"]] = 1.0 if hh.get("active") else 0.0
    n = num(hh.get("for_s"))
    if n is not None:
        v[METRIC_INDEX["high_hrv_for_s"]] = n
    return v


class LslOutputs:
    """The five LSL outlets. Raises ImportError if pylsl / liblsl is unavailable."""

    def __init__(self, prefix: str = "HurricaneBrain", source_id: str = "hurricane-brain") -> None:
        import pylsl  # noqa: F401  (may raise ImportError or OSError for a missing liblsl)

        self.pylsl = pylsl
        self.prefix = prefix
        self.source_id = source_id
        self.eeg = self.ppg = self.motion = None
        self.markers = self._make_markers()
        self.metrics = self._make_metrics()
        self.eeg_rate = 256.0
        self.ppg_rate = 64.0
        self.streams_key: Optional[str] = None

    def _info(self, name: str, typ: str, labels: list[str], rate: float, fmt: Any, unit: str) -> Any:
        L = self.pylsl
        info = L.StreamInfo(f"{self.prefix}-{name}", typ, len(labels), rate, fmt, f"{self.source_id}-{name}")
        d = info.desc()
        d.append_child_value("manufacturer", "Hurricane Brain")
        d.append_child_value("session_clock", "seconds since the first EEG sample; mapped to local_clock at first message")
        chans = d.append_child("channels")
        for lab in labels:
            ch = chans.append_child("channel")
            ch.append_child_value("label", lab)
            ch.append_child_value("unit", unit)
            ch.append_child_value("type", typ)
        return info

    def _make_markers(self) -> Any:
        L = self.pylsl
        info = L.StreamInfo(f"{self.prefix}-Markers", "Markers", 1, L.IRREGULAR_RATE, L.cf_string, f"{self.source_id}-Markers")
        info.desc().append_child_value("manufacturer", "Hurricane Brain")
        return L.StreamOutlet(info)

    def _make_metrics(self) -> Any:
        L = self.pylsl
        info = self._info("Metrics", "Metrics", METRIC_CHANNELS, L.IRREGULAR_RATE, L.cf_float32, "various")
        info.desc().append_child_value("null_policy", "NaN means not measured; never 0")
        return L.StreamOutlet(info)

    def configure(self, streams: dict) -> None:
        """(Re)create EEG, PPG and Motion outlets from the app's stream description."""
        key = json.dumps(streams, sort_keys=True)
        if key == self.streams_key:
            return
        self.streams_key = key
        L = self.pylsl
        self.eeg = self.ppg = self.motion = None  # old outlets disappear when garbage collected
        e = streams.get("eeg")
        if e:
            self.eeg_rate = float(e["rate_hz"])
            info = self._info("EEG", "EEG", list(e["channels"]), self.eeg_rate, L.cf_float32, "microvolts")
            info.desc().append_child_value("model", str(e.get("model")))
            self.eeg = L.StreamOutlet(info)
        p = streams.get("ppg")
        if p:
            self.ppg_rate = float(p["rate_hz"])
            self.ppg = L.StreamOutlet(self._info("PPG", "PPG", list(p["channels"]), self.ppg_rate, L.cf_float32, "raw ADC units"))
        mo = streams.get("motion")
        if mo:
            labels = ["acc_x", "acc_y", "acc_z", "gyro_x", "gyro_y", "gyro_z"]
            info = self._info("Motion", "Motion", labels, float(mo["rate_hz"]), L.cf_float32, "g (acc), deg/s (gyro)")
            self.motion = L.StreamOutlet(info)

    def clock(self) -> float:
        return float(self.pylsl.local_clock())


# ---------------------------------------------------------------------------
# The bridge
# ---------------------------------------------------------------------------

class Bridge:
    def __init__(self, osc_send: Optional[Callable[[str, list], None]], lsl: Optional[LslOutputs],
                 osc_absent: bool = False) -> None:
        self.osc_send = osc_send
        self.lsl = lsl
        self.osc_absent = osc_absent
        self.streams: dict = {}
        self.eeg_map: Optional[list[int]] = None  # indices of TP9, AF7, AF8, TP10 in the EEG channel list
        self.n_eeg = 0
        self.offset: Optional[float] = None  # lsl_time = session_t + offset
        self.prev_state: dict[str, bool] = {}
        self.warned: set[str] = set()
        self.counts: dict[str, int] = {}
        self.bad_messages = 0

    # -- helpers
    def warn_once(self, key: str, text: str) -> None:
        if key not in self.warned:
            self.warned.add(key)
            log.warning(text)

    def _send(self, c: Collector) -> None:
        if self.osc_send is None:
            return
        for addr, args in c.msgs:
            try:
                self.osc_send(addr, args)
            except OSError as e:
                self.warn_once("osc-send", f"OSC send failed: {e}")
        if self.osc_absent:
            for addr, why in c.absent:
                try:
                    self.osc_send("/hb/absent", [addr, why])
                except OSError:
                    pass

    def anchor(self, t: float) -> None:
        """Map the session clock to the LSL clock the first time a timed message arrives.

        The offset includes this message's network and processing delay (typically a few ms on
        localhost) and is never updated afterwards, so LSL times drift from true capture time only
        by the clock difference between the app and this computer over the session."""
        if self.offset is None and self.lsl is not None:
            self.offset = self.lsl.clock() - t

    def lt(self, t: float) -> Optional[float]:
        return None if self.offset is None else t + self.offset

    # -- entry points
    def on_text(self, text: str) -> None:
        try:
            m = json.loads(text)
            typ = m["type"]
        except (ValueError, KeyError, TypeError):
            self.bad_messages += 1
            self.warn_once("bad-json", "ignored a message that is not protocol JSON")
            return
        self.counts[typ] = self.counts.get(typ, 0) + 1
        try:
            self.dispatch(typ, m)
        except Exception as e:  # one bad message must not stop the stream
            self.bad_messages += 1
            log.warning("error handling %s message: %r", typ, e)

    def dispatch(self, typ: str, m: dict) -> None:
        if typ == "hello":
            if m.get("v") != PROTOCOL_VERSION:
                log.warning("app protocol version %s, bridge speaks %s", m.get("v"), PROTOCOL_VERSION)
            else:
                log.info("app connected (protocol v%s, schema %s)", m.get("v"), m.get("schema"))
            return
        if typ == "streams":
            self.on_streams(m.get("streams") or {})
            return
        t = num(m.get("t"))
        if t is not None:
            self.anchor(t)
        if typ == "slow":
            self._send(osc_slow(m))
            self.lsl_metrics(t, metrics_slow(m))
            self.state_markers(t, m)
        elif typ == "fast":
            self._send(osc_fast(m))
        elif typ == "heart":
            self._send(osc_heart(m))
            self.lsl_metrics(t, metrics_heart(m))
            hh = m.get("high_hrv") or {}
            if "active" in hh:
                self.state_change("high_hrv", bool(hh["active"]), t)
        elif typ == "motion":
            self._send(osc_motion(m))
            acc = [num(x) for x in m.get("acc") or []]
            gyro = [num(x) for x in m.get("gyro") or []]
            if self.lsl and self.lsl.motion and t is not None and len(acc) == 3 and len(gyro) == 3:
                v = [math.nan if x is None else x for x in acc + gyro]
                self.lsl.motion.push_sample(v, self.lt(t))
        elif typ == "battery":
            self._send(osc_battery(m))
            p = num(m.get("percent"))
            if p is not None and t is not None:
                v = [math.nan] * len(METRIC_CHANNELS)
                v[METRIC_INDEX["battery_percent"]] = p
                self.lsl_metrics(t, v)
        elif typ == "rr":
            self._send(osc_rr(m))
            if t is not None:
                for r in m.get("rr_ms") or []:
                    if num(r) is not None:
                        v = [math.nan] * len(METRIC_CHANNELS)
                        v[METRIC_INDEX["rr_ms"]] = float(r)
                        self.lsl_metrics(t, v)
        elif typ == "marker":
            self._send(osc_marker(m))
            if t is not None:
                label = m.get("label")
                self.lsl_marker(f"marker:{m.get('marker')}" + (f":{label}" if label else ""), t)
        else:
            self.warn_once(f"type-{typ}", f"ignored unknown message type {typ!r}")

    def on_streams(self, s: dict) -> None:
        self.streams = s
        e = s.get("eeg")
        self.eeg_map = None
        self.n_eeg = len(e["channels"]) if e else 0
        if e:
            names = [str(n).upper() for n in e["channels"]]
            if all(n in names for n in MM_ORDER):
                self.eeg_map = [names.index(n) for n in MM_ORDER]
            else:
                self.warn_once("eeg-names", f"EEG channels {e['channels']} lack TP9/AF7/AF8/TP10: /muse/eeg will not be sent (LSL still is)")
        if self.lsl:
            self.lsl.configure(s)
        log.info("streams: %s", json.dumps(s))

    def on_binary(self, data: bytes) -> None:
        try:
            if len(data) < HEADER.size:
                raise ValueError("short")
            magic, ver, kind, nch, pos, nper = HEADER.unpack_from(data)
            if magic != BINARY_MAGIC or ver != PROTOCOL_VERSION:
                raise ValueError("bad magic or version")
            n = nch * nper
            if len(data) != HEADER.size + 4 * n:
                raise ValueError("length mismatch")
            vals = struct.unpack_from(f"<{n}f", data, HEADER.size)
        except (ValueError, struct.error) as e:
            self.bad_messages += 1
            self.warn_once("bad-bin", f"ignored a bad binary message: {e}")
            return
        key = "eeg" if kind == 1 else "ppg" if kind == 2 else "?"
        self.counts[key] = self.counts.get(key, 0) + 1
        if kind == 1:
            self.on_eeg(int(pos), nch, nper, vals)
        elif kind == 2:
            self.on_ppg(pos, nch, nper, vals)

    def on_eeg(self, first: int, nch: int, nper: int, vals: tuple) -> None:
        if nch != self.n_eeg:
            self.warn_once("eeg-nch", "EEG data before (or inconsistent with) the stream description: dropped")
            return
        rate = float(((self.streams.get("eeg") or {}).get("rate_hz")) or 256.0)
        self.anchor((first + nper) / rate)
        if self.osc_send and self.eeg_map:
            for k in range(nper):
                row = vals[k * nch:(k + 1) * nch]
                out = [row[i] for i in self.eeg_map]
                if all(math.isfinite(x) for x in out):  # a non-finite sample is omitted, never zeroed
                    try:
                        self.osc_send("/muse/eeg", list(out))
                    except OSError as e:
                        self.warn_once("osc-send", f"OSC send failed: {e}")
        if self.lsl and self.lsl.eeg and self.offset is not None:
            rows = [list(vals[k * nch:(k + 1) * nch]) for k in range(nper)]
            if rows:
                self.lsl.eeg.push_chunk(rows, self.offset + (first + nper - 1) / rate)

    def on_ppg(self, t: float, nch: int, nper: int, vals: tuple) -> None:
        if self.lsl and self.lsl.ppg and nch == len(self.streams.get("ppg", {}).get("channels", [])):
            self.anchor(t)
            rows = [list(vals[k * nch:(k + 1) * nch]) for k in range(nper)]
            if rows and self.offset is not None:
                self.lsl.ppg.push_chunk(rows, self.offset + t + (nper - 1) / self.lsl.ppg_rate)

    # -- LSL helpers
    def lsl_metrics(self, t: Optional[float], v: list[float]) -> None:
        if self.lsl and t is not None and self.offset is not None:
            self.lsl.metrics.push_sample(v, self.offset + t)

    def lsl_marker(self, text: str, t: float) -> None:
        if self.lsl and self.offset is not None:
            self.lsl.markers.push_sample([text], self.offset + t)

    def state_change(self, name: str, active: bool, t: Optional[float]) -> None:
        prev = self.prev_state.get(name)
        self.prev_state[name] = active
        if prev is not None and prev != active and t is not None:
            self.lsl_marker(f"state:{name}:{'on' if active else 'off'}", t)

    def state_markers(self, t: Optional[float], m: dict) -> None:
        st = m.get("states") or {}
        for name in ("phi", "octave", "both"):
            if name in st:
                self.state_change(name, bool(st[name].get("active")), t)


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

async def serve(bridge: Bridge, host: str, port: int, origins: Optional[list[str]] = None):
    from websockets.asyncio.server import serve as ws_serve

    async def handler(ws: Any) -> None:
        log.info("client connected from %s", getattr(ws, "remote_address", "?"))
        try:
            async for message in ws:
                if isinstance(message, str):
                    bridge.on_text(message)
                else:
                    bridge.on_binary(bytes(message))
        except Exception as e:  # connection dropped
            log.info("client ended: %r", e)
        log.info("client disconnected")

    return await ws_serve(handler, host, port, origins=origins, max_size=2**22)


def make_osc_sender(host: str, port: int) -> Callable[[str, list], None]:
    from pythonosc.udp_client import SimpleUDPClient

    client = SimpleUDPClient(host, port)

    def send(address: str, args: list) -> None:
        client.send_message(address, args)

    return send


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Hurricane Brain stream bridge: WebSocket in, OSC and LSL out.")
    p.add_argument("--ws-host", default="127.0.0.1", help="address to listen on (default 127.0.0.1, this computer only)")
    p.add_argument("--ws-port", type=int, default=8765)
    p.add_argument("--osc-host", default="127.0.0.1")
    p.add_argument("--osc-port", type=int, default=5000, help="default 5000 (Mind Monitor's usual port; unverified)")
    p.add_argument("--no-osc", action="store_true", help="disable the OSC output")
    p.add_argument("--no-lsl", action="store_true", help="disable the LSL outputs")
    p.add_argument("--osc-absent", action="store_true", help="also send /hb/absent <address> <reason> for each value not measured")
    p.add_argument("--lsl-prefix", default="HurricaneBrain", help="LSL stream name prefix")
    p.add_argument("--origin", action="append", help="only accept WebSocket clients from this page origin (repeatable), e.g. http://localhost:5173")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--self-test", action="store_true", help="run the built-in end to end test and exit")
    return p


async def run(args: argparse.Namespace) -> None:
    osc = None if args.no_osc else make_osc_sender(args.osc_host, args.osc_port)
    lsl = None
    if not args.no_lsl:
        try:
            lsl = LslOutputs(prefix=args.lsl_prefix)
        except Exception as e:  # ImportError, or OSError when liblsl is missing
            print(f"LSL is OFF: could not load pylsl/liblsl ({e!r}).\n"
                  f"  Install with: pip install pylsl   (use --no-lsl to silence this)", file=sys.stderr)
    bridge = Bridge(osc, lsl, osc_absent=args.osc_absent)
    server = await serve(bridge, args.ws_host, args.ws_port, args.origin)
    print(f"Hurricane Brain bridge listening on ws://{args.ws_host}:{args.ws_port}")
    print(f"  OSC: {'off' if osc is None else f'udp://{args.osc_host}:{args.osc_port}'}")
    print(f"  LSL: {'off' if lsl is None else args.lsl_prefix + '-EEG / -Motion / -PPG / -Markers / -Metrics'}")
    print("Enter ws://localhost:%d in the app's Live stream out box. Ctrl+C to stop." % args.ws_port)
    try:
        while True:
            await asyncio.sleep(10)
            if args.verbose:
                log.info("counts %s bad %d", bridge.counts, bridge.bad_messages)
    finally:
        server.close()


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(message)s")
    if args.self_test:
        import selftest
        return selftest.main()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    except OSError as e:
        print(f"Could not start: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
