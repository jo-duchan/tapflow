---
type: rationale
topics: [relay, config, secrets]
status: stable
---

# Why the relay loads `.env` before evaluating config

> Read this before moving the `.env` load, or before adding a secret that is read at
> module-load time. Load order is load-bearing here: config is a module singleton evaluated on
> import, so a `.env` loaded too late is ignored.

## The problem

The relay's config is evaluated at module-load time (`export const config = load()`). The old
`server.ts` imported `config` before it called `loadDataDirEnv()`, so config and `jwtSecret`
read `process.env` *before* `.env` was loaded. As a result `.env` worked for the cert-issuance
tokens (read later, at runtime) but was silently ignored for `JWT_SECRET` and `SMTP_*`. Secrets
ended up scattered across four places.

## The design

`.env` is now loaded inside `load()`, right after `dataDir` is resolved and just before any
other `process.env` reads:

```
load():
  1. read tapflow.config.json
  2. resolve dataDir   (config.json ?? default, then TAPFLOW_DATA_DIR from the shell)
  3. loadDataDirEnv(dataDir)   ← fills process.env from .env (shell wins)
  4. read the remaining process.env values + jwtSecret
```

`.tapflow-data/.env` becomes the single default home for every relay secret, so the mental model
is one line: "secrets live in `.tapflow-data/.env`."

## Decisions worth keeping

- **Precedence is shell > `.env` > config/default.** `process.loadEnvFile` does not overwrite an
  existing `process.env` key, so the file only fills blanks and the shell stays an override. A
  regression test pins this so a Node version change cannot flip it.
- **`dataDir` is the one value `.env` cannot set** (chicken-and-egg: you need `dataDir` to find
  `.env`). It comes only from `config.json` or `TAPFLOW_DATA_DIR`.
- The old `loadDataDirEnv` call in `server.ts` was removed so the file is not loaded twice.
