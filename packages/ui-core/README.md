# @shikhon/ui-core

Framework-agnostic view logic. Zero runtime dependencies.

## Why a state machine, not components

`AttendanceGrid` is pure, synchronous state. That makes the product claim —
*a 60-student section marked in under 30 seconds* — something a test can
assert as a **tap budget** rather than something a designer asserts in a deck.

The rules it encodes, and the reason for each:

| Rule | Why |
|---|---|
| Everyone starts **present** | 3–5 students are typically absent. Marking exceptions is ~4 taps; marking everyone is 60. |
| **Tap-to-cycle** present → absent → late | One tap per change. No modal, no picker, nothing that scrolls away. |
| **Roll numbers**, not names | Teachers call the roll, and Bangla names are ~3× wider — names would cut the grid from 5 columns to 2. |
| **Undo**, not confirm | A confirmation dialog on a 30-second task is a 20% time tax. |
| Payload always contains **every** student | A partial register is worse than none: missing rows are indistinguishable from "not yet marked". |

## Numerals

`parseUserNumber()` exists because `Number('৬৫')` is `NaN`. Teachers type Latin
digits on a Bangla keyboard and vice versa; without normalisation the symptom
is "the marks didn't save". Identifiers and money are **always** rendered in
Latin — a roll number shown as `১২` cannot be checked against a paper register.

`smsSegments()` measures what an SMS actually costs. Bangla forces UCS-2 at
70 characters per segment against 160 for GSM-7, and SMS is roughly 80% of this
product's infrastructure bill, so templates are measured rather than guessed.

```bash
npm test    # 36 assertions
```
