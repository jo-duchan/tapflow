# Sustainability

tapflow makes better use of the Macs a team already owns and lowers the need for new hardware, which makes mobile QA more sustainable.

A significant share of a phone or laptop's carbon is emitted during manufacturing rather than during use, as Apple's own [product environmental reports](https://www.apple.com/environment/reports/) show. This is embodied carbon, and [Software Carbon Intensity (SCI)](https://sci.greensoftware.foundation/), now an international standard, weighs it alongside energy consumption. Keeping existing hardware in service longer and buying fewer new devices can therefore help reduce the burden from manufacturing.

## Using Macs you already have

tapflow turns Macs that a team already owns, but does not use continuously, into shared QA infrastructure. Instead of building out a device farm or a dedicated test server, you make better use of hardware you already own.

## Less reliance on physical devices

Maintaining coverage across OS versions usually means keeping several devices and pinning each one to a specific version. On iOS this is especially common, since rolling back to an earlier version is effectively impossible. Simulators and emulators give you the same OS coverage without additional devices.

Simulators alone, though, do not carry that benefit across a team — only people with a development environment installed can use them. tapflow shares simulators and emulators through a browser, so PMs, designers, and backend engineers without a mobile development environment can work in the same test environment. That can reduce the need to add physical devices at the team level.

## Extending hardware lifetime

When new machines are issued, the ones they replace are left over. Running one as an agent host keeps it in service instead of sending it for disposal. A simulator host often depends more on having enough memory than on CPU speed, so a Mac a generation or two behind can still handle the role reliably. The agent does need an [Apple Silicon Mac](/operate/requirements), though.

Test devices and agent hosts also age on different clocks. Test devices are replaced on a schedule set by OS support windows and the need to validate new OS releases. An agent host faces little of that pressure and can stay in service until macOS stops supporting it. Over eight years, repeatedly replacing devices costs more than twice the manufacturing carbon of keeping one Mac.

## What we measured

We compared operating four test devices (3 iPhone + 1 iPad) against running four simulators on one Mac a team already owns. Manufacturing carbon is divided by each device's expected service life and expressed as an annual figure; emissions from electricity use Korea's grid factor of 417.3 gCO₂e/kWh (2023).

| | 4 test devices | tapflow |
|---|---:|---:|
| Manufacturing (annualised) | 55.5 kg | 0 kg |
| Electricity | 12.7 kg | 17.9 kg |
| Total | 68.2 kg/yr | 17.9 kg/yr |

Varying the assumptions does not change the outcome much: across every scenario, tapflow came out 3.4 to 4.3 times lower in annual CO₂e.

On electricity alone, tapflow uses more. Keeping a Mac powered draws more than charging a few test devices. What creates the difference in this comparison is not energy efficiency but the absence of manufacturing carbon, since no additional hardware is purchased.

Power measurements support this. With a session open, the added draw stayed within measurement noise, and only active interaction raised it by about 4.5 W, because the H.264 encoder has almost nothing to do while the screen is static. In real QA most of the time is spent looking at the screen and interaction happens intermittently, so average draw is lower still.

The formulas, input sources, measurement conditions, and the comparisons we considered and rejected are documented in [sustainability-carbon-math.md](https://github.com/jo-duchan/tapflow/blob/main/contributing/sustainability-carbon-math.md).

## Limits

- **It draws power.** A Mac left on running simulators consumes electricity. In the comparison above, the electricity line favours physical devices.
- **A Mac bought to be an agent host has an upfront cost.** Manufacturing carbon is zero only when you reuse a Mac you already have. If you do buy one, a Mac mini breaks even in roughly six months and a MacBook Pro in about three and a half years. Laptops carry a display and a battery, so their manufacturing carbon is far higher than a desktop's.
- **It does not replace every physical device.** tapflow cannot test features that depend on device hardware, such as camera, NFC, or biometrics.
- **Old Macs have a floor.** The iOS simulator requires a recent Xcode, which requires a recent macOS. A Mac past that line cannot run as an agent. See [Requirements](/operate/requirements).
- **Grid factors vary by region.** The figures above are for Korea. On a cleaner grid both electricity lines shrink, while the manufacturing comparison stays the same.
