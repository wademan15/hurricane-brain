# Hurricane Brain: UX and accessibility review

Reviewer: a fresh reviewer who had not seen the app before. Date: 2026-11-20. Build: production (`pnpm build`, `vite preview`), Chromium headless through Playwright, replaying `e2e/out/recordings/phi3_10db.hbraw` at 4x. Viewports: 1440x900, 412x915, 360x640, plus 320x640 (reflow) and 720x450 (the same as 200% zoom on a 1440 screen). Automated checks: axe-core 4.10 (WCAG 2.0/2.1 A and AA rules plus best practice) on every screen. Screenshots are in `app/e2e/out/ux-review/` (git-ignored). The raw results are in `report.json` and `kbd-report.json` in that folder. The review scripts are not in the repo.

No app source was changed.

## Summary

The app is honest and careful. It shows "not measured" with a reason everywhere, puts golden ratio beside octave and chance on every live screen, puts the wellness notice and the photosensitivity notice first, confirms every destructive action, and keeps live regions quiet (0 announcements in a 10 s sample of a running replay). Axe found nothing on most content screens (Home, People, Fit, Programs, Discover, Anchors, History, Settings).

Most of the problems are in four places:

1. **Shared kit components** that break keyboard and touch users:
   - `Field` wraps the segmented controls in a `<label>`, so tapping a hint silently changes a setting, including measurement settings.
   - `Modal` has no focus trap and does not return focus when it closes.
2. **The live session screen as a layer.**
   - Keyboard focus moves into the hidden navigation behind it.
   - Eyes-closed mode does not take focus.
   - The tap-to-inspect readout sits inside `role="img"`, so screen readers cannot reach it.
   - The readout's close button is covered by the "Eyes closed" button.
3. **Words and numbers a newcomer cannot read.**
   - "over chance A: 0.874" sits beside a chance level of 0.171, and the two do not subtract.
   - "p (A)", "steps", "in the state", "held 0:03" and the " . " separator (which looks like a decimal point) need plain wording.
   - The three states (golden ratio, octave, both at once) look almost the same at a glance.
4. **Contrast of the "not measured" text.** At 4.08:1 it fails AA, and it is the text that matters most for honesty.

The privacy wording also contradicts the stream-out feature.

| Severity | Count |
| --- | --- |
| Blocker | 0 |
| Major | 12 |
| Minor | 22 |
| Polish | 9 |

## Findings

### Major

**M1. Tapping a setting's label or hint changes the setting (segmented controls inside `<label>`)**
- Where: Settings (Picture quality, Which chance level drives the hurricane, Reduced motion, Mains frequency, Alignment response speed, Replay speed). `app/src/ui/components/kit.tsx` `Field` renders `<label className="field">`, and `Segmented` buttons are placed inside it.
- What the user experiences: a label's activation goes to its first labelable descendant, which here is the first button. Tapping the hint text "Lower is lighter on a phone battery..." switched Picture quality from Medium to Low. After choosing chance B, tapping its explanation set it back to A. The same happens with Mains (back to Auto) and Response speed (to "Quicker (15 s)"). Response speed changes what is measured, and nothing tells the user it changed. On a phone, people tap or scroll-touch text all the time.
- WCAG: 3.2.2 On Input (unexpected change of context or setting), 1.3.1.
- Evidence: `kbd-report.json` → `label-click picture quality before/after` `[false,true,false]` → `[true,false,false]`, and `label-click chance` ends back on A.
- Fix: in `Field`, render a `<div role="group" aria-labelledby>` (or `fieldset`/`legend`) when the child is a group, and keep `<label>` only for single inputs. Simplest: add a `group` prop to `Field` that switches the wrapper, and use it everywhere `Segmented` sits inside `Field`.

**M2. Modals do not trap focus or return it**
- Where: every `Modal` in `kit.tsx`: Delete everything, Delete person, Delete session or recording, Stop session, Mark moment, Before the picture.
- What the user experiences:
  - Tab from the last modal button moves focus to the navigation links behind the scrim ("Home", "Programs"...).
  - After Escape, focus lands on an unrelated nav link ("History") instead of the button that opened the modal.
  - Screen reader users can wander out of a "Delete everything?" dialog without knowing it is still open.
- WCAG: 2.4.3 Focus Order, 2.1.2 (soft trap missing), 4.1.2.
- Evidence: `kbd-report.json` `delete-modal-tab` (all five tabs are `[NAV-behind-modal]`), `focus-after-modal-escape: A History`.
- Fix:
  - Use the native `<dialog>` with `showModal()`, which gives a focus trap, Escape and inert background for free. Otherwise, set `inert` on `.app-main` and `.nav` while open.
  - Remember `document.activeElement` on open and restore it on close.
  - Put `aria-labelledby` on the `<h2>` instead of a duplicate `aria-label`.

**M3. Keyboard focus goes behind the live session screen**
- Where: `screens/Session.tsx` (`.live` is `position: fixed` over `App.tsx`'s `<nav>` and the running-session banner).
- What the user experiences: after the seven live controls, Tab moves to Home, Programs, Discover, Anchors, History and Settings. These links are invisible under the storm canvas, so the focus ring disappears and Enter navigates away from a session.
- WCAG: 2.4.3, 2.4.7 Focus Visible, 2.4.11 (2.2) Focus Not Obscured.
- Evidence: `kbd-report.json` `live-tab` entries 8 to 13: `inNav: true, obscured: "hb-hurricane-canvas"`.
- Fix: while `section === 'session'`, render the nav with `inert` (or do not render it), and make `.live` the only focusable subtree. Move focus to the session title when the screen opens (see m8).

**M4. The tap-to-inspect readout is not reachable by screen reader, and only the centre is reachable by keyboard**
- Where: `app/src/viz/HurricaneView.tsx`: the wrapper is `role="img"` with `tabIndex=0`, and the `ReadoutPanel` (a heading, a close button and two tables) is rendered inside it.
- What the user experiences:
  - Children of `role="img"` are presentational, so the readout, which is the main honest "number behind the picture", is hidden from assistive technology.
  - Enter or Space always inspects the centre of the storm, so a keyboard user cannot inspect the arms, ring or swell.
  - Focus stays on the picture when the readout opens.
- WCAG: 4.1.2, 1.3.1, 2.1.1 Keyboard.
- Evidence: axe `nested-interactive` (serious) on `.hb-hurricane` at all sizes; `readout-in-role-img: true`; `focus-after-inspect-enter: hb-hurricane`.
- Fix:
  - Render `ReadoutPanel` as a sibling of the `role="img"` element: a `section` with `aria-labelledby` pointing at its `h3`. Move focus to its heading on open and back to the picture on close (Escape already closes it).
  - Add a keyboard route to every element, for example a small "Inspect:" list of buttons (Eye, Arms, Ring, Swell, Rotation), or arrow keys that step between parts.
  - Give the empty first `<th>` in the alignment table a visually hidden label ("Measure"), which fixes axe `empty-table-header`.

**M5. The readout's close button is covered by the "Eyes closed" button**
- Where: the live screen at 1440x900 (also checked at phone widths). `.hb-readout` sits at `top: 16px; right: 16px` under `.live-top`, whose "Eyes closed" button is drawn on top.
- What the user experiences: a mouse user sees "×" partly hidden, and clicking there turns on eyes-closed mode instead of closing the readout.
- WCAG: 2.4.11 (2.2), and usability.
- Evidence: `desk-63-inspect-centre.png`; `readout-close-occlusion`: the element at the centre of the close button is "Eyes closed mode: dim the screen".
- Fix: offset the readout below the top bar (`top: calc(var(--tap) + 16px)`), or raise its z-index above `.live-top` and leave the top-right corner clear.

**M6. "Not measured" text fails contrast**
- Where: `.nm` and `.nm small` use `--faint #6f7d93`. In the alignment cells on `--surface-2 #131c2d` the ratio is 4.08:1. On `--surface` (cards, history) it is 4.42:1. The font sizes are 12.6 to 17.9 px, so 4.5:1 applies. The light theme's `--faint` on `--surface-2` is 3.95:1.
- What the user experiences: the app's most important honesty message ("not measured", and the reason) is the hardest text to read, especially in a dim room and for low-vision users.
- WCAG: 1.4.3.
- Evidence: axe `color-contrast` serious: 8 nodes at live start, 14 at replay finished, also at `mob-63-inspect` and `mob-65-panel-pairs`.
- Fix: raise `--faint` to about `#8593a9` (about 5.6:1 on `#131c2d`). Keep the italics to tell it apart from a value. In the light theme use `#5d6a80` or darker.

**M7. The privacy wording contradicts the stream-out feature**
- Where: `copy.ts` `PRIVACY[0]` ("...stored in this browser and are never sent anywhere"), shown in onboarding step 6 and Settings → About. Settings → Your data says "Nothing is sent anywhere." (`Settings.tsx` `DataManagement`). Settings → Live stream out sends live measurements, and optionally the raw EEG, to a WebSocket address.
- What the user experiences: two unconditional "never sent" statements sit on the same page as a feature that sends data. CLAUDE.md rule 8 is about the user's choice, and the privacy text should say so.
- Fix: change it to "Everything stays on this device unless you choose to export it or turn on Live stream out, which sends live measurements only to the address you type, only while it is on." Use the same sentence in all three places, and add one onboarding bullet.

**M8. Onboarding dead end: "Get started" is disabled with no reason**
- Where: `screens/Onboarding.tsx`. The name is asked on step 2, and the button is disabled on step 7 if the name is blank.
- What the user experiences: anyone who presses Next past step 2 (a parent hurrying, or a screen reader user) reaches the end with a dimmed button, no message, and five steps between them and the field. Step 7 does not mention the name at all (`onboard-last-text-mentions-name: false`). The name field sets `aria-invalid` but shows no error text.
- WCAG: 3.3.1 Error Identification, 3.3.3 Error Suggestion.
- Evidence: `kbd-onboard-last-noname.png`.
- Fix:
  - Prefer: allow a blank name and default it to "Me" (it can be renamed in People).
  - Otherwise: keep the button enabled. On press, show "Add a name on step 2 so you can tell people apart" with a "Go to step 2" button. Or block Next on step 2 with an inline error tied by `aria-describedby`.

**M9. Live vocabulary is not readable by a newcomer or a child, and one value reads as an error**
- Where: `components/LiveReadout.tsx` (`AlignCell`, chance list), `components/Cascades.tsx`, and the separators in `Session.tsx` and `History.tsx`.
- What the user experiences (`desk-61-live-mid.png`):
  - The golden ratio cell shows `0.874` and "over chance A: 0.874". The chance cell next to it shows `A, golden 0.171`. A reader expects 0.874 − 0.171. By the spec (section 8.5) excess equals the whole closeness once the cascade beats 95% of surrogates, which is correct but cannot be guessed. The octave cell shows "over chance A: 0" beside "0.000" (mixed formats).
  - "p (A), golden 0.030", "A, golden / B, octave", "steps", "held 0:03", "in this condition", "not in the state" and "warming up: not enough data yet" are all shown at once.
  - The separator " . " makes "over chance A: 0.416 . 1 step" read like the number "0.416.1".
  - The readout uses good plain wording already ("as often as this by chance: fewer than 1 in 100, by random peaks"), but the main cells do not.
- Fix (truthful, no overclaim). Suggested main-cell wording:
  - Golden ratio alignment **0.87** (0 to 1). Below it: "Random peaks: 0.17 typical. Beaten by fewer than 1 in 100 random tries." Use a "·" separator.
  - "over chance A" → "Beyond chance (A)", shown only in the details or readout, with the readout's existing note "(0 = no better than chance; not a probability)".
  - "p (A), golden 0.030" → "Random peaks did this well: 3 in 100".
  - "steps" → "peaks in the chain" ("a chain of 3 peaks").
  - "in the state / not in the state" → "Holding now (9 s)" / "Not holding".
  - "cascade" → keep the term (the owner asked for it by name), with a one-line "?" tip: "A chain of rhythm peaks, each about 1.618 times (golden) or 2 times (octave) the one below."
  - "chance A / chance B" → "Chance: random peaks (A)" and "Chance: your own rhythms shifted in time (B)". Use the same words as the Settings hint.
  - Replace every " . " separator with " · " or a comma (screen readers read " . " as "dot").

**M10. On phones the live screen is crowded, and "beside" becomes "below"**
- Where: `index.css` `@media (max-width:560px) .trio` puts the chance cell on its own row. `.live-dock` is up to 52vh.
- What the user experiences:
  - At 360x640 the dock is 333 px tall with 863 px of content (`reflow-r320.live`). The signal state chip ("Signal good: 4 of 4"), the peaks, and the Spectrum / Pairs / Signal tabs are all below the fold, and Mark moment, Sound and Skip block are further down.
  - Golden and octave sit side by side, but the chance level is pushed under them, which bends rule 3 ("beside") on exactly the devices children will use.
- Evidence: `sm-61-live-mid.png`, `mob-61-live-mid.png`, `sm-62-live-dock-bottom.png`.
- Fix:
  - On narrow screens show one compact row of three equal cells: Golden 0.87 · Octave 0.00 · Chance 0.17 / 0.09. Put the full chance list and the cascade details behind a "Details" disclosure.
  - Pin a one-line status strip (signal state and holding state) at the top of the dock.
  - Put the action buttons (Sound, Mark moment, Skip block) in a fixed bottom row.

**M11. The three states (golden ratio, octave, both at once) are hard to tell apart at a glance**
- Where: `components/Cascades.tsx`. The `.cellbox.both` class has no styles in `index.css`.
- What the user experiences:
  - Golden ratio and octave cells differ only by border and label colour (gold `#e2b86b` and teal `#6fc7c0` have nearly the same luminance, 1.07:1).
  - "Both at once" has no colour or mark at all.
  - An active state differs from an inactive one only by the words "in the state" and "not in the state", in the same size and weight. Nothing on the screen says "holding golden ratio now".
  - Colour is not the only carrier (the words are there), so 1.4.1 passes, but at-a-glance reading fails.
- Fix:
  - Give each state a distinct shape and icon: a spiral for golden, concentric rings for octave, both icons for "both".
  - When active, fill the cell or add a high-contrast badge "Holding · 0:09" with the icon. When inactive, keep the cell outlined and muted.
  - Give "both" its own token (`--both`) and a double border.
  - Repeat the active state in the top bar title so it stays visible on phones.

**M12. Eyes-closed mode is not keyboard-operable**
- Where: `Session.tsx` `.eyes-closed` overlay button.
- What the user experiences:
  - Focus stays on the "Eyes closed" button under the overlay. Tab walks through the dimmed controls (About golden ratio, Spectrum, Pairs...), and Escape does not exit.
  - A keyboard or switch user cannot return to the screen without finding the overlay with a pointer.
  - The "tap to look" text is 1.56:1. Dim is intentional, but it should not be the only cue.
- Evidence: `kbd-report.json` `focus-in-eyes-closed: btn small`, `eyes-closed-tab` (all `obscured: eyes-closed`), `eyes-closed-after-escape: 1`.
- Fix:
  - Move focus to the overlay button on open, and make the rest of `.live` inert while it is shown.
  - Exit on Escape, Enter or Space, and return focus to "Eyes closed".
  - The overlay's `aria-label` is good. Keep the visible text dim if wanted, since an eyes-closed screen is a reasonable exception, but say so in Settings.

### Minor

**m1. The page title never changes**: it is "Hurricane Brain" on every route (`index.html`, no `document.title` updates). WCAG 2.4.2. Fix: set `document.title = "<Screen> · Hurricane Brain"` in `App.tsx` per section, and for program and session detail use their names.

**m2. No focus management on route change.** After choosing a nav link, focus stays on the link (`focus-after-nav`). Screen reader users get no cue that the page changed. Fix: focus the `<h1>` (`tabIndex=-1`) after a hash change.

**m3. Desktop tab order does not match the visual order.** The sidebar is drawn first but comes last in tab order (main is before nav in the DOM). Acceptable, but a "Skip to navigation" or a nav-first DOM with a skip link is clearer. WCAG 1.3.2 and 2.4.3 (advisory).

**m4. Onboarding has no `main` landmark.** `Onboarding.tsx` renders `div.app-main`. Axe reports `landmark-one-main` and `region` on all 7 steps. When the step changes, focus stays on the Next button at the bottom (focus after Back is "Back"), and new content appears above it. Fix: use `<main>`, and move focus to the step `<h1>` on Next and Back.

**m5. Headings skip levels or are missing.**
- Onboarding step 3 goes from h1 to h3.
- Program detail goes from h1 to h3, because card titles are h3 with no h2 (`Programs.tsx`).
- Ready with nothing pending, and Session with no session running, have no h1.

Axe reports `heading-order` and `page-has-heading-one` (moderate). Fix: make card titles h2 on those pages, and give the empty states an h1.

**m6. Touch targets under 44 px on phones.**
- `.btn.small` is 40 px tall (`--tap-small: 40px`): Change person, Delete (People), Open (History, Discover), Edit (journal), Listen to candidate 1 to 6, and, on the live screen, Close, Eyes closed, Exit, and the replay speed buttons.
- The breadcrumb links "Programs" and "History" are 20 px tall.
- The program name links are 21 px tall. The whole card is clickable with a mouse through `onClick` on a `<section>`, but not with the keyboard or a screen reader.
- The "B" chance button is 43x44.

Evidence: `report.json` targets for `mob-*` and `sm-*`. Fix: `--tap-small: 44px`. Make breadcrumbs buttons or padded links. Use a stretched-link pattern on the program cards (the `<a>` covers the card through `::after`).

**m7. Escape does not close the Spectrum, Pairs or Signal panels** (`spectrum-open-after-escape: 1`). Fix: on Escape, close the open panel and return focus to its tab.

**m8. Opening a session or replay leaves focus on `<body>`** and announces nothing. Fix: focus the live title (`tabIndex=-1`). Optionally make the title region `role="status"` once ("Replay started: Free session").

**m9. Content is clipped at narrow widths** (`body { overflow-x:hidden }` hides it instead of scrolling).
- Programs: the locked-reason badges ("Unlocks after Calm Alpha (level 2).") are `white-space: nowrap` and reach x=408 px on a 360 px screen.
- Settings → Visual smoothing: `<dd>` reaches 420 px.
- History detail: the "Settings stored with this session" `kv` list reaches 459 px.

WCAG 1.4.10. Evidence: `report.json` reflow (`sm-20-programs`, `mob-50-settings`, `sm-42-history-detail`). Fix: let `.badge` wrap (`white-space: normal`) for long text, or show the locked reason as a line of text. Make `.kv` one column below 480 px with `overflow-wrap:anywhere`.

**m10. Root font size is in px.** `html { font: 17px/... }` ignores the user's browser default font size (Chrome Settings → Font size). Browser zoom works (200% reflowed with no loss at 720x450), so 1.4.4 passes, but low-vision users who rely on the font-size setting get nothing. Fix: `--font-size: 106.25%` (17 px at the default 16), with rem sizes elsewhere.

**m11. Scrollable tables are not keyboard-scrollable.** `.table-wrap` (pair table, hemisphere table, event log) scrolls sideways on phones but cannot be focused (axe `scrollable-region-focusable` at 360 px). Fix: `tabIndex=0`, `role="region"` and an `aria-label` on `.table-wrap`.

**m12. The readout shows engine field paths to every user.** For example `slow.tracks[id=1].freq` and `slow.cascades.phi.tracks.length` appear in monospace under each row (`HurricaneView.tsx` `ReadoutPanel`). This is noise for a newcomer or a child. Fix: hide them behind a "Show technical names" toggle (Settings or the readout footer).

**m13. "Not measured" reasons are inconsistent after a replay ends.** The alignment cells say "no data" and "over chance A: not measured, nothing received yet". The cascade cells and chance list say "frames stopped arriving". "Nothing received yet" is false after two minutes of data. Evidence: `desk-finished-text` in `report.json`. Fix: in `AlignCell`, use the same `stale` / `no_frame` logic as `CascadeCell` for both lines.

**m14. Names differ across screens.**
- The nav says "Anchors", but the page is "Signatures and anchors".
- The nav "Discover" uses the person icon, which is the same idea as "People".
- The readout says "Aligned state: in alignment", while the cell below says "Golden ratio cascade: not in the state". They mean different thresholds, but users read them as a contradiction.
- Settings calls them "Golden ratio state", "Octave state" and "Both at once".
- Replay speeds are "4x" on Home and "4 times" in Settings.

Fix: pick one set of terms ("Golden ratio state", "Octave state", "Both at once", "holding / not holding", "aligned pair" for the instant per-pair test) and use it in copy, readout and Settings. Rename the nav to "Signatures".

**m15. Disclosure widgets have no marker.** `details > summary { display:flex }` removes Chrome's disclosure triangle. "About golden ratio alignment" (live), "Optional check-in", "All N parameters", "Cautions from the individual techniques" and "Photosensitivity" look like bold headings, not controls (`desk-61-live-mid.png`). Fix: add a chevron (`summary::before`) that rotates with `[open]`, or use `display:list-item`.

**m16. The in-session rating sheet submits on the last tap.** `RatingSheet` calls `onDone` as soon as every key has a value, so a slip on the last question cannot be corrected. This matters with eyes half-open. Fix: add an explicit "Done" button, or a 2 s undo.

**m17. "Retire" an anchor has no confirmation and no undo** (`Signatures.tsx`; there is no un-retire path). Fix: confirm, or offer "Restore" on retired anchors.

**m18. Number fields accept anything.** Mood 1 to 5, Energy and Hours slept (`Programs.tsx`), the questionnaire numbers, and the Settings tolerance overrides accept out-of-range values silently. The tolerance fields are labelled with raw engine keys. WCAG 3.3.1. Fix: clamp the value, or show an inline error tied with `aria-describedby`. Give the tolerances plain labels ("How close counts as golden ratio (± in log ratio)").

**m19. Bottom-nav labels collide at 320 to 360 px.** "Programs" and "Discover" touch (`r320-__programs.png`). Fix: a smaller label size under 380 px, or shorter labels.

**m20. Low contrast on control boundaries and selected state.** Control borders are `#243049` on the surfaces (1.40:1), and the live pill tabs are 1.48:1. The selected segment differs from the others by background `#1a2538` against transparent (about 1.3:1), plus font weight and text colour. WCAG 1.4.11. Fix: border tokens of 3:1 or more for interactive controls (for example `#4a5a7a`). Mark the selected segment with a check mark or a 2 px accent underline.

**m21. "Left and right symmetry" may say more than the measure supports.** The readout labels `hemispheres.match` "Left and right symmetry". The spec (section 9 review note, line 426) warns that the shared reference electrode inflates left and right locking, and that the UI must say zero-lag locking cannot be told apart from the reference. Fix (signal lead to confirm): add the caveat line to the readout row, or rename it "left and right peak match (shared reference: see note)".

**m22. No light theme or larger-text option is exposed.** `theme.css` defines `:root[data-theme='light']`, but nothing in Settings sets it. Low-vision users who need a light or high-contrast theme cannot choose it. Following the owner's rule ("give the person the option"), add Settings → Visuals → Theme: Dark (default) / Light / Follow device, and a text-size option. The live screen can stay dark.

### Polish

- **p1.** Too many digits for a newcomer: "theta: 7.353 ± 0.055 Hz", "Closeness 0.874". Show 1 decimal for Hz and 2 for 0 to 1 values in the main view, and keep full precision in Pairs and the readout.
- **p2.** Home: "the buttons must be tapped, not triggered automatically" is developer wording. Suggest: "Chrome shows a list of nearby devices each time; pick your headset."
- **p3.** The fit step title "Wet-free, clean skin" is odd, and it conflicts with the later tip "Moisten dry skin very slightly with a damp fingertip". Suggest: "Clean skin, hair out of the way".
- **p4.** History charts: a series that is all zero (octave closeness) is drawn on a range of "-0.50 to 0.50", but closeness cannot be negative. Pin the 0 to 1 scales to 0 to 1.
- **p5.** Disabled primary buttons are drawn at 50% opacity in the accent colour and still look tappable (Home "Quick start", "Start with defaults"). Use a neutral surface for the disabled state. The reason text below is already good.
- **p6.** Onboarding is 7 dense steps before anything happens, and there is no bundled demo recording, so a newcomer without a headset has nothing to replay. Offer "Try a sample recording" on Home. This is the shortest path to seeing what the app does, and it is honest (it is labelled a replay).
- **p7.** Child mode: the Child age group only opens the small-head fit tips. Suggestions:
  - A simplified live dock: one big state word with its icon ("Golden ratio: holding"), the signal dot, and the Stop button. Numbers go behind "Grown-up details".
  - Hide Settings → The engine.
  - Use the rating sheet's 1 to 5 with faces as well as words.
  - Keep sessions short by default.
- **p8.** "Mark moment" saves "marked moment" when the note is empty. Say so in the placeholder ("Leave empty to just mark the time").
- **p9.** The default "Kept going / Stop and save" modal on the live screen shows "Stop" in the danger colour as the top-left control. That is easy to hit while reaching for the screen with eyes closed. Consider moving Stop to the right, or requiring a long press in eyes-closed mode.

## Axe summary per screen

Counts are violations as `rule (impact, nodes)`. "clean" means no violations. The same results at 1440x900 (desk), 412x915 (mob) and 360x640 (sm) unless noted.

| Screen | Result |
| --- | --- |
| Onboarding steps 1 to 7 | `landmark-one-main` (moderate, 1), `region` (moderate, 2 to 4); step 3 also `heading-order` (moderate, 1) |
| Home | clean |
| People | clean |
| Get ready (nothing pending) | `page-has-heading-one` (moderate, 1) |
| Fit and signal check (no data) | clean |
| Programs list | clean |
| Program detail (Calibration, Calm Alpha) | `heading-order` (moderate, 1) |
| Discover | clean |
| Signatures and anchors | clean |
| History (empty, list, detail with event log) | clean |
| Settings | clean (axe does not catch M1) |
| Live, start of replay | `color-contrast` (serious, 8): "not measured" 4.08:1 |
| Live, mid replay | clean (desk, mob, sm) |
| Live, tap-to-inspect | `nested-interactive` (serious, 1), `empty-table-header` (minor, 1); mob also `color-contrast` (serious, 8) |
| Live, Spectrum panel | clean |
| Live, Pairs panel | desk clean; mob `color-contrast` (serious, 8); sm `scrollable-region-focusable` (serious, 2) |
| Live, Signal panel | clean |
| Live, eyes-closed overlay | `color-contrast` (serious, 1): "tap to look" 1.56:1 |
| Replay finished | `color-contrast` (serious, 14) |
| Session route with nothing running | `page-has-heading-one` (moderate, 1) |

Axe could not decide contrast for text over gradients (the live top bar), canvas text (spectrum axis labels) or the storm. By calculation:
- Readout and spectrum dim text `--hb-ink-dim #7d8aa0` on `#03060c`: 5.81:1 (pass).
- `--live-subtle` on the dock: 7.31:1 (pass).
- Gold and octave label text on `--surface-2`: 9.18:1 and 8.61:1 (pass).
- The 55% gold cell border: about 3.3:1 (pass for non-text).

## Measured contrast of theme tokens (dark theme unless noted)

| Pair | Ratio | Verdict |
| --- | --- | --- |
| `--faint` on `--surface-2` (not measured, in cells) | 4.08 | fail (AA text) |
| `--faint` on `--surface` | 4.42 | fail |
| `--faint` on `--bg` / live dock | 4.72 / 4.66 | pass (just) |
| `--dim` on `--surface-2` | 6.92 | pass |
| `--gold` / `--octave` on `--surface-2` | 9.18 / 8.61 | pass |
| gold against octave (luminance) | 1.07 | colours differ in hue only; labels carry the meaning |
| `--eyes-closed-text` on `--live-bg` | 1.56 | fail (by design; see M12) |
| `--border` on `--surface` (control edges) | 1.40 | fail 1.4.11 |
| light theme `--faint` on `--surface-2` | 3.95 | fail |
| `--accent-ink` on `--accent` (primary buttons) | 8.27 | pass |

## What passed

- **Honesty in the interface:**
  - Every null shows "not measured" with a reason.
  - Frames that stop arriving clear the values rather than holding the last one (seen after the replay ends).
  - Golden ratio alignment is always next to octave alignment and the chance level on desktop (see M10 for phones).
  - The golden ratio is framed as the app's own hypothesis with both readings, and the app "takes no side".
- **Wording rules:**
  - "Wellness and self-exploration, not a medical device" appears on onboarding step 1, in Settings → About and in the page meta description.
  - No medical claims were found.
  - The photosensitivity notice comes before any picture: onboarding step 5, and a modal before the first picture if onboarding was skipped.
  - The "no binaural, monaural or isochronic stimulation" statement is in About.
  - Program evidence grades are explicit, with a "Not offered, and why" list.
- **Destructive actions are confirmed:**
  - Delete everything requires typing DELETE.
  - Delete person names the person and what will be lost.
  - Delete session and recording are confirmed.
  - Stop session says what is saved.
  - Dialogs open with focus on the safe choice.
- **Screen reader and keyboard:**
  - Live regions are restrained: only the guidance line (polite) and the signal chip (status). 0 announcements were sampled over 10 s of a running replay.
  - The replay-finished banner is `role=status`.
  - Visible focus: a 3 px accent outline on every focusable element checked.
  - `lang="en"` is set.
  - Icon-only controls have names (readout close, eyes-closed overlay).
  - Rating buttons have full labels ("How calm do you feel? 3 of 5").
  - The fit meter is a labelled progressbar.
  - The head diagram has alt text.
  - The fit coach gives text ("usable" / "not usable" badges) as well as the coloured dots, so colour is not the only carrier.
  - History charts are `role=img` with labels.
- **Motion and layout:**
  - Reduced motion follows the system (`data-motion=reduced` with `prefers-reduced-motion`) and can be overridden in Settings.
  - Nothing in the shell animates on its own.
  - No horizontal page scroll at 320, 360, 412 or 720 px (but see m9: some content is clipped rather than scrolled).
  - 200% zoom equivalent (720x450) reflows with nothing lost on all content screens.
- **Robustness:**
  - No page or console errors in any run.
  - The offline shell and replay work (checked by the existing `e2e/ui-verify.cjs`; not repeated here).
- **Empty states:**
  - History, Ready, Session and Discover say what to do next.
  - Disabled start buttons have a reason next to them ("Connect a device on the Home screen first.").

## Not tested

- **Live Bluetooth flows** (headless Chromium has no Web Bluetooth): connecting, the device chooser, reconnecting, the "signal lost" and "reconnecting" notes, fit coaching with real contact changes, starting a real program, block transitions, the in-session rating sheet, Mark moment and Skip block during a live session, and the post-session journal flow. Fit coaching and live panels were seen only with replayed frames.
- **Real audio:** gentleness, the absence of sudden changes, bloom distinctness, the sound-only experience, and Bluetooth headphone latency. Only the code paths were read.
- **Real devices:** a small Android phone (touch precision, Android font scaling and text-size-adjust, wake lock, battery), Windows 11 Chrome with Narrator or NVDA, and high-contrast or forced-colours mode.
- **A real screen reader:** semantics were judged from the accessibility tree, axe and the DOM, not from listening to NVDA, TalkBack or Narrator.
- **WebGL storm colours** for colour-vision deficiency. Golden against octave against both in the picture uses shape (arms, ring, combined) as well as colour. This was not checked with simulation.
- **Export and import:** files were not downloaded and re-imported. The buttons and labels were reviewed.
- **Discovery, Signatures and Anchors flows that need recorded sessions** (estimates, signature tests, anchor pairing). Only their empty and first-run states were seen.
