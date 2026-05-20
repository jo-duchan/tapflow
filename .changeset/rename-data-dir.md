---
"tapflow": patch
"@tapflowio/relay": patch
---

**Breaking change**: default `dataDir` renamed from `.tapflow` to `.tapflow-data`.

If you have an existing `.tapflow/` directory, either rename it to `.tapflow-data/` or set `dataDir: ".tapflow"` in `tapflow.config.json` to keep using the old path.
