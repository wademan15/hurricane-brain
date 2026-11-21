# Storage (`app/src/storage`)

Everything is kept in this browser's IndexedDB. Nothing leaves the device unless the person
exports it (CLAUDE.md rule 8).

Stores: `recordings` (HBRAW bytes), `recordingMeta`, `sessions`, `profiles`, `settings`.
Several people can share one device: each profile has its own id, and every stored session carries
the `profileId` it belongs to. History, signatures and anchors are per profile.

## Session CSV export (`sessionSummaryCsv`)

One CSV file with comment lines (`# ...`) separating the tables. A value that was not measured is
an empty cell, never zero; where a column has a `_why` companion, it holds the engine's reason.

1. **Header**: session id, program, start and end, completion, engine and app versions, and every
   setting that affects a measurement or its smoothing: mains, chance level driving the hurricane,
   alignment response speed, whether harmonics counted toward octave alignment, reduced motion,
   sound-only, age group, audio and smoothing settings, engine parameters and overrides.
2. **Per-block statistics**: one row per block and field. `mean`, `sd`, `effective_n`, effect size
   with its interval, time to target, fraction in target, stability, and the block rating.
3. **Journal**: the person's own note, mood, ease and depth (1 to 5), tags. These are what the
   person said, not measurements.
4. **Cascade events**: one row per stretch in which the golden ratio state, the octave state, or
   both at once, held. `start_s`, `end_s`, `duration_s` (first to last frame in which it was
   active), then for each of golden ratio (`phi_`) and octave (`octave_`): `max_steps`,
   `member_bands`, `member_hz` and `measured_ratios` (low to high, ` > ` between members),
   `closeness`, the chance levels A and B, `p_chance_a`, and `closeness_why`. For `both`, both groups
   are filled. Copied from slow frames; a member frequency that was not measured says why.
5. **Per-second key measures**: `t_s`, `block`, then each column below as `<id> [unit]` and
   `<id>_why`. A value is the latest frame value no older than its freshness limit (slow frames
   1.5 s, heart frames 3 s); otherwise it is empty with the reason (`no_data`, `gap`, ...).

| Column id | Meaning |
| --- | --- |
| `alpha_db`, `theta_db`, `beta_db` | band power above the fitted background, temporal pair, dB. The band edges follow the individual alpha frequency when one is set (the engine's `bands`) |
| `alpha_fixed_db`, `theta_fixed_db`, `beta_fixed_db` | the same over the fixed textbook edges (the engine's `bands_fixed`: theta 4-8, alpha 8-13, beta 13-30 Hz), so sessions compare whatever the individual alpha frequency was. Empty with `not_available` for a recording made before the engine emitted it |
| `dominant_hz` | frequency of the strongest confirmed peak |
| `phi_closeness`, `phi_chance_a`, `phi_excess_a`, `phi_excess_b`, `phi_steps` | golden ratio alignment, chance level A, excess over A and over B, cascade steps |
| `oct_closeness`, `oct_chance_a`, `oct_excess_a`, `oct_excess_b`, `oct_steps` | the same for the octave |
| `phi_active`, `oct_active`, `both_active` | 1 while the state is active (the engine's own state) |
| `phi_for_s`, `oct_for_s`, `both_for_s` | seconds in the current condition |
| `at_ratio` | frequency ratio of the strongest confirmed alpha peak over the strongest confirmed theta peak |
| `at_miss_2`, `at_miss_3`, `at_miss_phi` | the engine's distance of that pair from 2:1, 3:1 and the golden ratio (natural log of the ratio) |
| `usable_channels`, `clean_fraction`, `emg_db` | signal quality |
| `hr_bpm`, `rmssd_ms`, `sdnn_ms`, `lf_power`, `hf_power`, `resonance_hz`, `resonance_strength`, `breath_bpm`, `pacer_adherence` | heart measures, present when a chest strap or pulse sensor was connected |
| `reward` | the training runner's reward level (program sessions) |

The published research on alpha and theta ratios tested 2:1 and 3:1. The golden ratio is this app's
own hypothesis, so it is always logged beside 2:1, 3:1 and the chance level.

## Other exports

- **Recording** (`.hbraw`): the raw device stream plus notes (markers, session start and end); a
  recording can be replayed with no headset.
- **Profile** (`.json`): one person's calibration, signatures, anchors and history.

## Appearance (round 4)

`AppSettings.appearanceBase` holds migrated legacy values; each person's own choices are in
`profileInfo[id].appearance`. `resolveAppearance(ageGroup, appearanceBase, own)` returns the
effective value (Night Garden and the kid screen are the defaults for a child). `migrateSettings`
is pure and idempotent. `exportProfileJson(profile, appearance)` embeds `hbAppearance`;
`Storage.appearanceOf(text)` reads it back on import.
