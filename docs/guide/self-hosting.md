# Self-Hosting the Relay

The relay is a lightweight Node.js server. It only routes WebSocket traffic and serves the dashboard — no heavy compute needed.

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

Then create the first admin account from any machine that can reach the relay:

```sh
tapflow init --relay http://your-server:4000
```

## Manual (Node.js)

```sh
npm install -g tapflow
tapflow relay start
```

The relay reads `tapflow.config.json` from the working directory. See [Configuration](/reference/configuration).

After starting, create the admin account:

```sh
tapflow init
```

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
