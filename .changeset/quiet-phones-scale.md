---
"@tapflowio/relay": patch
---

Make the QA session simulator viewer responsive on narrow (mobile) browser viewports (#679).

The viewer previously kept its desktop sizing regardless of the browser window, forcing horizontal
scroll on a phone. `IOSViewer`/`AndroidViewer` now also shrink to fit the measured available width
(not just the existing height cap), the session panel stacks below the viewer instead of beside it
below the `lg` breakpoint, and the fixed-width toolbar/info-card rows do the same — so the whole
session view fits a narrow viewport without horizontal scroll.
