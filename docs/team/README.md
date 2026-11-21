# The team

Ten specialist roles. Each is a standing agent with its own brief in [`.claude/agents/`](../../.claude/agents), so the same expert picks up its area every time. The plan listed nine. The training methods researcher was added at the owner's request.

| Role | Owns | Model |
| --- | --- | --- |
| [Signal architect](../../.claude/agents/signal-architect.md) | Engine design, the hard signal maths, the method bake-off, review of engine code | Fable |
| [Muse device engineer](../../.claude/agents/muse-device-engineer.md) | Bluetooth link, Classic and Athena decoding, timing, recording and replay | Opus |
| [Training methods researcher](../../.claude/agents/training-methods-researcher.md) | Evidence on inducing each state, the technique library, user profiling, emotional states and sound anchors | Opus, reviewed by Fable |
| [Neurofeedback protocol designer](../../.claude/agents/neurofeedback-protocol-designer.md) | Runnable training programs, baselines, thresholds, session flow | Opus, reviewed by Fable |
| [Sonification engineer](../../.claude/agents/sonification-engineer.md) | The gliding tone, the slow chord bloom, heartbeat sound, anchors | Opus |
| [Visualizer engineer](../../.claude/agents/visualizer-engineer.md) | The hurricane and its binding to measurements | Opus |
| [Heart and breath engineer](../../.claude/agents/heart-breath-engineer.md) | Polar H10, pulse, heart rate variability, breath, brain and heart coupling | Opus, coupling reviewed by Fable |
| [Skeptic](../../.claude/agents/skeptic.md) | The test battery, chance baselines, the fake test, audits of every claim | Fable designs, Sonnet runs |
| [App engineer](../../.claude/agents/app-engineer.md) | Screens, settings, storage, replay, export, onboarding | Sonnet |
| [Librarian](../../.claude/agents/librarian.md) | Lookups, docs, changelogs, fixtures, tidy-up | Haiku |

## Which model does what

The owner's split: Fable decides and checks, Opus builds, Sonnet and Haiku handle the simple work.

| Model | Use it for |
| --- | --- |
| Fable | Planning. The hard signal maths: peak confirmation, uncertainty, ratio evidence, surrogates, thresholds. Designing the skeptic's tests. A review at every milestone before work builds on that layer. Any bug in the signal path nobody else can find |
| Opus | Most implementation, once the design is settled: the engine code, device decoding, audio, the shader, heart measures, training logic, research synthesis |
| Sonnet | Well-specified work with clear right answers: screens, storage, export, unit tests, running test suites, lab notebooks, routine code review |
| Haiku | Small mechanical work: lookups, renames, formatting, changelogs, fixtures |

Rules of thumb:

- Use the cheapest model that can finish the task without supervision. Move up one tier only after a task has failed twice.
- Anything touching golden ratio statistics, chance levels or thresholds gets a Fable review, whoever wrote it.
- Write the specification before the code. A cheaper model with a precise spec beats an expensive one guessing.
- Work from recorded sessions, so no task needs a person wearing the headset.

## Milestone reviews

Each roadmap phase ends in a gate. At each gate the signal architect reviews the layer for correctness and the skeptic tries to break it. Both happen at the Fable tier. The gate passes when the skeptic's tests pass and the review has no open findings.

## How to hand a task to a role

Give the role the goal, the files and spec sections that matter, what is already ruled out, and what "done" means. Keep it narrow. The brief supplies the standing knowledge, so the task does not need to repeat it.
