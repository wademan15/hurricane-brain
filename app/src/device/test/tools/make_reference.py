"""Build the Athena reference files the device tests compare against.

Developer tool, not shipped. Needs local clones of the two reference decoders:

  /home/user/refs/OpenMuse   (MIT)   https://github.com/DominiqueMakowski/OpenMuse
  /home/user/refs/muse-rs    (Apache-2.0) https://github.com/eugenehp/muse-rs, run through
                             the harness binary built from /home/user/refs/musers-harness
                             (muse-rs's own src/parse.rs, unmodified, included by #[path]).

For every fixture it decodes each notification with BOTH decoders, checks that they agree on
every value (raw integer per sample), and writes <fixture>.ref.json with, per notification, the
list of subpackets as {tag, counter, raw}. `counter` comes from muse-rs (OpenMuse does not expose
the first subpacket's counter), `raw` from OpenMuse, converted back to the integer the headset
sent. The two decoders are independent implementations, so agreement is evidence on its own.

Run:  python3 -I app/src/device/test/tools/make_reference.py
"""

import importlib.util
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "fixtures")
OPENMUSE_DECODE = "/home/user/refs/OpenMuse/OpenMuse/decode.py"
HARNESS = "/home/user/targets/device-refs/release/musers-harness"

spec = importlib.util.spec_from_file_location("openmuse_decode", OPENMUSE_DECODE)
om = importlib.util.module_from_spec(spec)
spec.loader.exec_module(om)

MUSERS_EEG = 0.0885
ACC = 0.0000610352
GYRO = -0.0074768


def openmuse_line(line):
    """OpenMuse wants 'iso<TAB>uuid<TAB>hex'. muse-rs fixtures are bare hex."""
    if "\t" in line:
        return line
    return "2026-01-01T00:00:00+00:00\t273e0013-4c4d-454d-96be-f03bac821358\t" + line


def om_subpackets(line):
    """OpenMuse subpackets of one notification, in wire order, raw integers."""
    payload = bytes.fromhex(line.rsplit("\t", 1)[-1].strip())
    out = []
    for pkt in om._parse_packets(payload, None, None):
        for sp in om._parse_data_subpackets(pkt):
            dec = om._decode_subpacket_data(sp)
            if dec is None:
                continue  # 0x53 and unknown: OpenMuse does not decode them
            d = dec["data"]
            t = dec["sensor_type"]
            if t == "EEG":
                raw = [int(round(float(v) / om.EEG_SCALE)) for v in d.reshape(-1)]
            elif t == "OPTICS":
                raw = [int(round(float(v) * 32768.0)) for v in d.reshape(-1)]
            elif t == "ACCGYRO":
                raw = []
                for row in d:
                    raw += [int(round(float(v) / ACC)) for v in row[:3]]
                    raw += [int(round(float(v) / GYRO)) for v in row[3:]]
            elif t == "BATTERY":
                raw = [int(round(float(d[0]) * 256.0))]
            else:
                continue
            out.append({"tag": int(dec["tag_byte"]), "type": t, "raw": raw})
    return out


def musers_counters(events):
    """(type, counter, values) per subpacket, rebuilt from muse-rs's per-channel events."""
    subs = []
    i = 0
    while i < len(events):
        e = events[i]
        k = e["k"]
        if k in ("eeg", "ppg"):
            group = [e]
            j = i + 1
            while j < len(events) and events[j]["k"] == k and events[j]["i"] == e["i"] and events[j]["c"] > group[-1]["c"]:
                group.append(events[j])
                j += 1
            subs.append(("EEG" if k == "eeg" else "OPTICS", e["i"], group))
            i = j
        elif k == "acc":
            subs.append(("ACCGYRO", e["i"], [e, events[i + 1]]))
            i += 2
        elif k == "bat":
            subs.append(("BATTERY", e["i"], [e]))
            i += 1
        else:
            i += 1  # gap events: none in these fixtures (asserted below)
    return subs


def check_agree(om_sp, mr):
    t, counter, group = mr
    assert om_sp["type"] == t, (om_sp, t)
    raw = om_sp["raw"]
    if t == "EEG":
        n_ch = len(group)
        n_s = len(group[0]["s"])
        for ch, ev in enumerate(group):
            for s, v in enumerate(ev["s"]):
                r = raw[s * n_ch + ch]
                assert abs((r - 8192) * MUSERS_EEG - v) < 1e-9, (r, v)
        assert n_ch * n_s == len(raw)
    elif t == "OPTICS":
        n_ch = len(group)
        for ch, ev in enumerate(group):
            for s, v in enumerate(ev["s"]):
                assert raw[s * n_ch + ch] == v
    elif t == "ACCGYRO":
        acc, gyro = group
        for s in range(3):
            for a in range(3):
                assert abs(raw[s * 6 + a] * ACC - acc["s"][s * 3 + a]) < 1e-6
                assert abs(raw[s * 6 + 3 + a] * GYRO - gyro["s"][s * 3 + a]) < 1e-4
    elif t == "BATTERY":
        assert abs(raw[0] / 256.0 - group[0]["v"]) < 1e-3
    return counter


def build(name):
    path = os.path.join(FIX, name)
    lines = [l.rstrip("\n") for l in open(path) if l.strip()]
    hexes = "\n".join(l.rsplit("\t", 1)[-1].strip() for l in lines) + "\n"
    out = subprocess.run([HARNESS], input=hexes.encode(), capture_output=True, check=True).stdout.decode()
    mr_lines = [json.loads(l) for l in out.splitlines()]
    assert len(mr_lines) == len(lines)
    notes = []
    n_sub = 0
    for line, mr_events in zip(lines, mr_lines):
        assert not any(e["k"] == "gap" for e in mr_events) or name.startswith("musers"), "unexpected gap"
        oms = om_subpackets(openmuse_line(line))
        mrs = musers_counters([e for e in mr_events if e["k"] != "gap"])
        if len(oms) == len(mrs) - 1 and mrs[-1][0] == "BATTERY":
            # A 0x88 battery block shorter than OpenMuse's fixed minimum (188 B) is skipped by
            # OpenMuse; muse-rs reads 0x88 to the end of its packet. Take muse-rs's value and
            # say so: this one value has a single source.
            b = mrs[-1][2][0]
            oms.append({"tag": 0x88, "type": "BATTERY", "raw": [int(round(b["v"] * 256.0))], "single_source": "muse-rs"})
            print(f"  {name}: short 0x88 block decoded by muse-rs only (OpenMuse minimum length 188)")
        assert len(oms) == len(mrs), (name, len(oms), len(mrs))
        subs = []
        for o, m in zip(oms, mrs):
            counter = check_agree(o, m)
            subs.append({"tag": o["tag"], "counter": counter, "raw": o["raw"]})
        n_sub += len(subs)
        notes.append(subs)
    ref = {
        "fixture": name,
        "generated_by": "app/src/device/test/tools/make_reference.py",
        "decoders": ["OpenMuse decode.py @ a9be252 (MIT)", "muse-rs 0.2.4 parse.rs @ 0293bc7 (Apache-2.0)"],
        "notifications": notes,
    }
    with open(path + ".ref.json", "w") as f:
        json.dump(ref, f, separators=(",", ":"))
    print(f"{name}: {len(lines)} notifications, {n_sub} subpackets, OpenMuse and muse-rs agree")


if __name__ == "__main__":
    for n in sorted(os.listdir(FIX)):
        if (n.startswith("openmuse_") and n.endswith(".txt")) or n.endswith(".hex"):
            build(n)
