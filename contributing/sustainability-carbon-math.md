---
type: reference
topics: [sustainability, carbon, measurement, methodology]
status: living
updated: 2026-11-04
related: [streaming-latency-log, agent-keep-awake, workshop-lab-fork-observations, relay-resource-rejection]
---

# Sustainability carbon math — inputs, measurements, and what we deliberately do not claim

The engineering backing for [`docs/reference/sustainability.md`](../docs/reference/sustainability.md).
That page states the conclusion; this one shows the arithmetic, the sources, the
measurement conditions, and the arguments we tested and threw away.

> **Headline.** Replacing four physical test devices with one Mac the team already
> owns comes out **3.4–4.3× lower** in annual CO2e across every assumption we tried.
> The margin is created entirely by **production** (55.5 vs 0 kg/yr). Operation is
> roughly a wash and can go either way — tapflow may even lose it.
>
> **The claim only holds for a Mac you already have.** Buying one adds production
> carbon; see [New hardware](#new-hardware--the-honest-case) for when it pays back.

---

## Two frames, kept apart

These answer different questions and must never be merged into one number.

| Frame | Question | Counts avoided emissions? |
|---|---|---|
| **Avoided-emissions comparison** (this document) | Is it lower-carbon than buying test devices? | Yes — that is the whole point |
| **SCI score** (ISO/IEC 21031:2024) | What does tapflow itself emit? | **No** |

The SCI specification explicitly forbids lowering a score through offsets or
market-based measures, and its software boundary names *testing* and *idle machines*
as in-scope. SCI is not an electricity-only metric: a score carries both the energy
drawn (`O = E × I`) and the embodied carbon of the hardware allocated to the software
(`M`), so the agent Mac's manufacturing footprint does land in tapflow's score, pro
rata. What never appears is a **negative** term for a device nobody bought — avoided
emissions are outside the model entirely.

So a published SCI score and the comparison below are separate claims. Presenting the
avoided-emissions result *as* an SCI figure would be wrong, and obviously so to anyone
who knows the spec.

### The SCI score itself

Computed once and self-certified with the Green Software Foundation as
[GSF-SCI-2026-00003](https://badges.greensoftware.foundation/awards/sci/gsf-sci-2026-00003)
(issued 2026-11-03, valid until 2027-11-03, measured on v0.18.0). Functional
unit `R` = one QA session-hour. `E` = (idle + measured increment × 30% active) × 1 h,
`I` = 417.3 gCO₂e/kWh, `M = TE × (1/35,040 h) × (1/4 slots)` using Apple's four-year
lifespan and four concurrent simulators.

| Agent host | O (energy) | M (embodied) | **SCI** | M share |
|---|---:|---:|---:|---:|
| Mac mini M4 | 2.30 g | 0.198 g | 2.50 gCO₂e / session-hour | 7.9% |
| MacBook Pro 14" M2 Pro | 2.39 g | 1.404 g | **3.79 gCO₂e / session-hour** (certified) | 37.0% |

Only the MacBook Pro figure is certified, because the active increment was measured on
that machine. The Mac mini figure is in the disclosure as a model, not as a certified
score: it would carry the M2 Pro's increment over to a different chip.

For scale, one QA session-hour is about a third of charging a phone once (~6.8 g).

**Why the score is now in the docs.** This file used to keep it out. The score is a
faithful SCI figure that measures the wrong thing for our case: it accounts for what
tapflow consumes and reserves, while not buying four test devices registers as exactly
zero. And SCI was self-declared, with no registry, no badge and no reviewer, so there
was nothing to gain in exchange for foregrounding it.

The certificate changed the second half. It is a public registry entry, and GSF checked
the disclosure for completeness, so the Sustainability page now states the score in its
intro. The first half still holds, which is how the page states it: as tapflow's own
footprint, with the comparison kept to its own section, as
[Two frames, kept apart](#two-frames-kept-apart) requires.

What GSF checked is completeness, not the calculation. The signed attestation says so
(item 7), and also commits us to the "self-certified" qualifier on every claim of
conformity (item 8). Docs and README copy keep both: GSF's own wording is "verified by
the Green Software Foundation", and the Korean docs translate it as 확인, not 검증,
because 검증 reads as validation of the figure.

The certificate expires on 2027-11-03, and the score has not been re-measured since
v0.18.0. Renewing means re-measuring, not re-submitting the same figure.

It is worth having ready for three situations: an enterprise buyer asking for an ESG
figure, a Blue Angel DE-UZ 215 application (which needs a legal entity we do not have),
or a conversation with the GSF community. Recomputing from scratch each time would be
wasteful, and the reasoning above should not have to be re-argued.

---

## Measurement — the session increment

Measured 2026-08-03 on a MacBook Pro 14" (M2 Pro, 32 GB, macOS 26.5.2), one iOS
simulator, relay + iOS agent on the same host, dashboard served from the relay's
built `public/` (no Vite). 60 one-second samples per point via
`powermetrics --samplers cpu_power`, reading `Combined Power (CPU + GPU + ANE)`.

| Point | State | SoC power | Increment |
|---|---|---:|---:|
| **A** | No session | 0.66 W (sd 0.14) | — |
| **B** | Session open, screen static | 0.64 W (sd 0.29) | **≈ 0** |
| **C** | Session open, continuous scrolling | 5.16 W (sd 1.99, peak 15.98) | **+4.52 W** |

Two findings matter more than the numbers.

**Holding a stream open is free.** A and B differ by −0.02 W, well inside the noise.
The H.264 encoder does almost nothing when the screen does not change, which matches
the Still-vs-Scroll gap already recorded in
[`streaming-latency-log.md`](./streaming-latency-log.md) (235 KB / ~1.97 MB/s still vs
~590 KB / 12–16 MB/s scrolling). Cost appears only while someone is actively
interacting, and a QA session is mostly looking, not touching.

**The increment is small.** 4.52 W of SoC at the busiest possible moment. Converted to
wall power with the 89.5% adapter efficiency printed in the MacBook Pro PER, that is
**5.05 W**. Earlier drafts of this analysis assumed 30 W and reached a much narrower
conclusion; the assumption was wrong by a factor of six.

### Why SoC-only is the right instrument here

`powermetrics` excludes display, SSD, and fans. That is a feature for an *increment*:
the platform draw is constant across A/B/C and cancels in the difference. Absolute
system draw comes from Apple's published wall-power figures instead, which already
include it. For reference, the same idle state read 4.84 W on whole-system battery
telemetry versus 0.66 W on SoC — the 4.2 W delta is that platform constant.

---

## Inputs

### Embodied carbon (Apple Product Environmental Reports)

| Device | Config | Total LCA | Production share | Production (derived) |
|---|---|---:|---:|---:|
| iPhone 17 | 256 GB | 55 kg | 76% | ~41.8 kg |
| iPad (A16) | 128 GB | 74 kg | 74% | ~54.8 kg |
| Mac mini (M4) | 16 GB / 256 GB | 32 kg | 74% | ~23.7 kg |
| MacBook Pro 14" (M2 Pro) | 512 GB | 243 kg | 79% | ~192 kg |

Sources: [iPhone 17](https://www.apple.com/environment/pdf/products/iphone/iPhone_17_PER_Sept2025.pdf) ·
[iPad A16](https://www.apple.com/environment/pdf/products/ipad/iPad_A16_PER_MAR2025.pdf) ·
[Mac mini M4](https://www.apple.com/environment/pdf/products/desktops/Mac_mini_PER_Oct2024.pdf) ·
[MacBook Pro 14" M2](https://www.apple.com/environment/pdf/products/notebooks/14-inch_MacBook_Pro_PER_Jan2023.pdf)

Two cautions on these numbers. **Production absolutes are derived**, not printed —
Apple's post-2025 report format dropped the numeric stage table and gives only a donut
chart, so `total × share` carries roughly ±1 kg of rounding. And **TE (embodied) is
production + transport + end-of-life, excluding use**: the use stage is computed
separately below with a Korean grid factor, so including it in TE would double-count.
Mac mini TE is therefore **27.8 kg**, not the headline 32 kg.

### Grid intensity

**417.3 gCO2eq/kWh** — Korea, consumption-side combined, 2023 factor, confirmed by the
national GHG statistics committee on 2025-12-17. Combustion-based, not lifecycle. Use
the consumption-side figure for Scope 2; the generation-side value (384.4) is a
different quantity and the two are easy to confuse.

### Device power

| Device | Idle (wall) | Max | Source |
|---|---:|---:|---|
| Mac mini M4 | 4.00 W | 65 W | [support.apple.com/103253](https://support.apple.com/en-us/103253) |
| MacBook Pro 14" M2 Pro | 4.21 W | not published | PER power table (100 V) |

Apple publishes idle *and* max only for desktops. For notebooks the PER gives
Off/Sleep/Idle and nothing else, so a laptop agent host has no official load figure —
another reason the increment above was measured rather than looked up. Notably the two
idle values are within 0.2 W of each other: **using a laptop as the agent host is not a
power penalty.**

---

## The comparison

**Scenario.** A team needs coverage equivalent to four test devices (3 iPhone + 1 iPad).
Either they buy them, or they run four simulators on one Mac they already own. Four is
the practical ceiling for a 32 GB host per the third-party reading in
[`workshop-lab-fork-observations.md`](./workshop-lab-fork-observations.md) (4 comfortable,
6 borderline, 8 unusable).

**Horizon.** Everything is annualised. Charging a full production figure against a
single year while the device lasts three would inflate the hardware side, so production
is divided by expected lifespan: iPhone 3 years, iPad and Mac 4 years (Apple's own LCA
assumptions).

**Session load assumption.** 1,000 session-hours per year (4 h/day × 250 days), of which
30% is active interaction — 300 hours at the measured increment.

| | 4 physical devices | tapflow (Mac already owned) |
|---|---:|---:|
| Production, annualised | **55.5 kg** | **0 kg** |
| Operation | 12.7 kg (30.4 kWh) | 17.9 kg (42.9 kWh) |
| **Total** | **68.2 kg/yr** | **17.9 kg/yr** |
| | | **3.8×** |

Device charging assumes a full cycle every day (iPhone 13.9 Wh, iPad 29 Wh, 85% charge
efficiency) — an upper bound that favours our side, so the realistic case is also given
in the sensitivity table below.

### Sensitivity

Two inputs are weak: how much the four-simulator increment scales, and how often test
devices are charged. Neither changes the answer.

| Simulator increment | Device charging | tapflow | Devices | Ratio |
|---|---|---:|---:|---:|
| ×1 (justified by B ≈ A) | daily | 16.0 kg | 68.2 kg | 4.3× |
| ×2 | daily | 16.7 kg | 68.2 kg | 4.1× |
| **×4 (linear, most conservative)** | daily | 17.9 kg | 68.2 kg | **3.8×** |
| ×4 | 3×/week | 17.9 kg | 60.9 kg | 3.4× |

Scaling the increment fourfold barely moves the total because **86% of the Mac's energy
is standing idle** (36.9 kWh of 42.9). Measuring the two- and four-simulator cases was
considered and dropped: it would change the third significant figure and nothing else.

### What the numbers actually say

**Production decides it; operation is a coin flip.** tapflow *loses* the operation axis
under the daily-charging assumption (17.9 vs 12.7 kg) and wins it under weekly charging.
Either way the 55.5 kg production gap swamps the difference. Any version of this
document that leads with energy efficiency is arguing the weak half of its own case.

---

## Lifespan asymmetry

The two sides do not age the same way, and the difference is structural rather than
incidental.

| | What ends its service life |
|---|---|
| **Test devices** | OS support windows and the need to validate new OS versions force replacement (Apple assumes 3 years for iPhone) |
| **Agent Mac** | Little pressure — an agent host is memory-bound, not CPU-bound, and runs headless. The ceiling is macOS support, roughly 7–8 years |

Over an 8-year horizon a team replacing four devices spends 444 kg while one MacBook
Pro cost 196.8 kg once — **2.3×**, before counting any operational energy.

---

## New hardware — the honest case

Buying a Mac to act as the agent host is not disqualifying; it front-loads production
carbon that then amortises.

| Mac lifespan | MacBook Pro 14" | Mac mini M4 |
|---:|---:|---:|
| 4 years | 49.2 kg/yr | 7.0 kg/yr |
| 6 years | 32.8 kg/yr | 4.6 kg/yr |
| 8 years | 24.6 kg/yr | 3.5 kg/yr |

Against the four devices' 55.5 kg/yr, the break-even is **3.5 years for a MacBook Pro
and about 6 months for a Mac mini.** Even Apple's conservative 4-year first-owner
assumption clears it.

The practical guidance is therefore *prefer the Mac you already have; if you must buy,
a Mac mini's embodied carbon is roughly one seventh of a MacBook Pro's* — laptops carry
a display and a battery that an agent host never needs.

---

## Limits

- **SoC-only instrumentation.** Display, SSD, and fans are excluded. Valid for the
  increment, not for absolute draw.
- **Mixed hardware.** The increment was measured on a MacBook Pro M2 Pro; the absolute
  idle figure comes from Apple's published values. Two machines, one calculation.
- **The increment is an upper bound.** The browser decoded the stream on the same Mac.
  In real use the browser runs on the tester's own machine and the agent host only
  encodes.
- **Sixty seconds of continuous scrolling** is harsher than real QA, so the interaction
  figure is overstated.
- **Derived production values.** ±1 kg from donut-chart rounding in post-2025 PERs.
- **Multi-simulator scaling is unmeasured.** Treated as linear (worst case).
- **Korean grid factor.** A team on a cleaner grid gets a smaller operation number on
  both sides; the production comparison is unaffected.

Every one of these errs against tapflow, which is why a 3.4× margin survives them.

---

## Arguments we tested and dropped

Recording these so nobody re-walks them.

**Total power vs cloud device farms.** Appealing — a device farm runs a cloud layer
*and* Mac hosts, while tapflow's relay and agent can share one machine, and the stream
never leaves the LAN. It is unusable as a *quantitative* claim because Appetize and
BrowserStack publish neither PUE, nor regional grid mix, nor sessions per host. A
comparison whose other half cannot be sourced reads as unsupported even if nobody
rebuts it. The structural point (one fewer layer, LAN-local transport) is fine as
qualitative text; the kilogram figure is not.

**CPU utilisation as a power proxy.** Rejected after considering DVFS, P/E core
asymmetry (`os.cpus()` reports both identically), and — decisively — that H.264
encoding runs on the VideoToolbox hardware encoder, whose draw barely registers in CPU
percentage. Interpolating Mac mini's 4 W–65 W range by CPU% would have missed tapflow's
main load entirely.

**Battery-gauge sampling.** `ioreg`'s `InstantAmperage` gives whole-system power without
root, which is attractive. But **the gauge only refreshes every 60 seconds**, so a
30-second run yields one or two distinct values. An early 46.67 W reading was a single
sample caught during simulator boot. Usable only for runs of 10+ minutes; discarded in
favour of powermetrics for increment work. (Also note `ioreg` reports discharge as an
unsigned 64-bit wrap of a negative number, which bash arithmetic mishandles silently.)

---

## Reproducing this

```sh
# Session increment (needs sudo; measure A/B/C separately)
sudo powermetrics --samplers cpu_power -i 1000 -n 60 \
  | grep 'Combined Power (CPU + GPU + ANE)'

# Whole-system power, no sudo — only meaningful over 10+ minutes (60 s gauge refresh)
ioreg -a -rn AppleSmartBattery      # InstantAmperage × Voltage, AC unplugged
```

The agent host's own CPU/RAM series is available from tapflow's Mac resource monitoring,
so a team can check these figures on their own hardware rather than taking ours.
