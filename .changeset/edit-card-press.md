---
"@tapflowio/relay": patch
---

Flow Capture's Edit step: a click anywhere on a step's card selects it again in Chrome, not only on its label. The dashboard's press nudge (`transform` on `button:active`) made the label button the containing block of the `::after` box stretched over the card, so the box shrank to the label as the button was pressed and the release landed off it. Buttons marked `data-stretched` are left out of the nudge. The run video's timeline markers now really opt out of it: their `active:transform-none` lost to the base rule on specificity, so it is `!`-marked.

<!-- changelog: internal — fixes the Edit step of the Flow Capture dialog (#1146), which no release has shipped yet; its Added entry stands. The timeline markers only lose a 1 px nudge on press -->
