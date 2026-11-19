---
"@tapflowio/flow-runner": minor
"@tapflowio/relay": minor
---

Flow Capture's Match replays an iOS tap that the app named when it was recorded on that element, through the engine's own `tapOn` (and `scroll { until }` in the direction of the swipe before it, then back), instead of at the recorded point; such a tap and the swipe before it are judged by the element, not by the picture. A tap made while a list was still moving is left out before the replay (`RawStep.dropped: 'stopped-scroll'`, skipped as `stopped-scroll`), shown dimmed in Range and named when the step after it differs. `segment` joins each touch with the app's report (`touched`); flow-runner exports `recordedTarget`, `recordedSelector`, `scrollDirectionOf` and `selectorFor` for the dashboard.
