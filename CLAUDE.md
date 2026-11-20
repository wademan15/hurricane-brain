# Hurricane Brain

A brainwave and heart biofeedback app for Muse headsets and the Polar H10. Web app in Chrome (Windows and Android) over Web Bluetooth. Signal engine in Rust compiled to WebAssembly. TypeScript and React shell. Python reference lab.

## Read first

- `docs/spec/signal-engine.md`: what the engine measures and outputs. Sections 1, 2 and 9 are required reading for every role.
- `docs/team/README.md`: the roles and which model does what. Briefs are in `.claude/agents/`.

## Rules for all work

1. Measured or null. Nothing on screen or in the headphones moves unless a measured value moved. No idle animation, no decorative randomness, no held or invented values.
2. No peak without confirmation against the background. No tone without a confirmed peak.
3. Golden ratio alignment is always shown beside octave alignment and the chance level, and the chance level is computed by the same procedure.
4. Deterministic. The same recorded session gives the same output every time.
5. Sound is gentle. No beeps, chimes or sudden changes. State is a slow change in a continuous sound.
6. No binaural, monaural or isochronic entrainment in this app.
7. No medical claims. The UI label is "golden ratio alignment". Interpretations are offered as readings, not facts.
8. All user data stays on the device unless the user exports it.
9. Provisional numbers live in the parameter table (spec section 14), never scattered through code.

## Model split

Fable for planning, hard signal maths and milestone reviews. Opus for most implementation. Sonnet or Haiku for simple work. Details in `docs/team/README.md`.
