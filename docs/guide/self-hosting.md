# Self-Hosting the Relay

The relay is a lightweight Node.js server. It only routes WebSocket traffic and serves the dashboard — no heavy compute needed.

## fly.io (recommended)

```sh
tapflow deploy
# Select fly.io → follow prompts
# ✓ Relay deployed: wss://tapflow-myteam.fly.dev
```

Cost: ~$5/month on the `shared-cpu-1x` plan.

## Docker

```sh
git clone https://github.com/jo-duchan/tapflow.git
cd tapflow
docker build -t tapflow .
docker run -d \
  -p 4000:4000 \
  -v $(pwd)/.tapflow:/app/.tapflow \
  -e JWT_SECRET=your_long_random_secret \
  tapflow
```

## Manual (Node.js)

```sh
npm install -g tapflow
tapflow relay start
```

The relay reads `tapflow.config.json` from the working directory. See [Configuration](/reference/configuration).

## Data directory

By default the relay stores all data in `.tapflow/`:

```
.tapflow/
  tapflow.db      ← SQLite database
  uploads/
    builds/       ← .app.zip and .apk files
    avatars/
    comments/
```

Back up this directory to preserve all data.
