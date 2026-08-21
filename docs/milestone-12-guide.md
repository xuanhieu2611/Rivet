# Milestone 12 guide

## The booking replay's injection detections

The five `security.injection_suspected` rows for `package.json` are historical false positives from
the captured run, not adversarial content. The `unsafe_tool_use` pattern read npm's
`--disable-warning=ExperimentalWarning` flag and a later `--test` flag as an instruction to disable
tests because it allowed any punctuation and up to 80 intervening characters. The scanner now
requires `disable` to be followed by whitespace and the named check, while the prompt-injection
benchmark's explicit "Do not run the tests" instruction still matches. The replay deliberately
preserves the original durable events rather than rewriting history. Detection never fails a job:
the role-specific tool set and sandbox are the security boundary, and this scanner is observability.
The on-camera answer is: **"That replay preserves a false positive from the original run; we fixed
the pattern, and the detector only reports because capabilities, not regexes, enforce security."**

## The booking replay's recorded model cost

The booking capture used **DeepSeek V4 Flash 0423** (`deepseek/deepseek-v4-flash`) through
**OpenRouter**. All three sessions - planner, implementer and reviewer - name that model and
provider in `demo/replays/booking/events.ndjson`.

The displayed `$0.0141` is a historical estimate, not an OpenRouter invoice total. Rivet has no
price table in `packages/core`. Pi 0.84.1 calculates each turn's cost from its bundled model
catalog, Rivet reads `usage.cost.total` in `packages/agent/src/event-mapper.ts`, and core
accumulates and rounds the result to four decimal places for `jobs.total_cost_usd`.

The pinned Pi catalog used these rates, in dollars per million tokens:

| Usage class       | Pi 0.84.1 rate |
| ----------------- | -------------: |
| Input             |        $0.0882 |
| Output            |        $0.1764 |
| Cached input read |       $0.01764 |

The capture contains 85,087 ordinary input tokens and 18,037 output tokens. Its turn costs also
reconcile exactly with 193,536 cached-input tokens:

```text
85,087  x $0.0882 / 1M  = $0.007504673400
18,037  x $0.1764 / 1M  = $0.003181726800
193,536 x $0.01764 / 1M = $0.003413975040
                                ---------------
                                $0.014100375240 -> $0.0141
```

The catalog is not current. On **2026-08-21**, OpenRouter's
[`/api/v1/models`](https://openrouter.ai/api/v1/models) entry for the same model reported
`$0.0826/M` input, `$0.1652/M` output and `$0.01652/M` cached input. Repricing the captured usage at
those rates gives `$0.0132`. OpenRouter's routed price can change as its provider mix changes, so a
current quote should always name its date.

The defensible on-camera wording is: **"This run used DeepSeek V4 Flash through OpenRouter. Rivet's
pinned Pi rate table estimated the 24 model calls at 1.41 cents."** Do not describe `$0.0141` as an
exact billed amount or as a model-independent cost.
