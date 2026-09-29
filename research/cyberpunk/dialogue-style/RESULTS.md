# Dialogue prompting pilot: recorded run

Model: **fast-gemma-4-31b-it**. Completed 36 measured text replies in 18 two-turn exchanges. TTS, microphone, lipsync and local GPU inference were disabled. No production profile was changed.

## Timing

Client-observed text timing begins when the user text is sent; connection setup is separate. These numbers do not measure speech latency or isolated model inference.

| Character | Replies | Median first text | Median complete text | First text range | Median words |
| --- | ---: | ---: | ---: | ---: | ---: |
| johnny-silverhand | 12 | 890 ms | 1468 ms | 521–1459 ms | 27.5 |
| judy-alvarez | 12 | 804 ms | 1357 ms | 547–1332 ms | 28.5 |
| panam-palmer | 12 | 933 ms | 1405 ms | 552–1518 ms | 31.5 |

Across all replies: median first text **869 ms**, completed text **1432 ms**. New connection setup median: **3160 ms**.

| Within exchange | Median first text | Median complete text |
| --- | ---: | ---: |
| Turn 1 | 1046 ms | 1563 ms |
| Turn 2 | 571 ms | 1263 ms |

## Isolation and cleanup

All 10 disposable profiles were removed with fresh absence readbacks. Every profile had its selected model, separate description fields and disabled memory verified before use. Each measured pair used one session; all 18 sessions were distinct.

The run dispatched 37 text turns. One in-flight reply was abandoned when the operator changed synthetic-ID reuse policy; its output was not recorded or inspected. One replacement was explicitly authorized, in a new session, without repeating any Core mutation. Eight previously completed replies were retained. Five synthetic IDs had been allocated before the stop; subsequent exchanges reused the first. See [cleanup receipt summary](CLEANUP.md) and [design](DESIGN.md).

## Style evaluation

No winner is declared in this timing report. The separate reviewer froze all scores before unblinding. See the [condition comparison](COMPARISON.md) and [reviewer interpretation](UNBLINDED_REVIEW.md); both preserve the original scores. One generation per cell and one model-authored reviewer cannot establish a universal best prompt or human preference.

The references and review rubric separate factual fidelity, selective disclosure, register, emotional specificity and adaptation to V's next turn. A response can be factually right while still sounding like a biography. A short answer can also be generic or evasive.
