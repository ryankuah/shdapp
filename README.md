# SHD Speedrun Overlay

A Division 2 speedrunning overlay app (Electron) with a WebSocket server for syncing "Ready" state across connected users.

## Project Structure

```
shdapp/
├── app/                    # Electron overlay app
│   ├── src/
│   │   ├── main/           # Electron main process
│   │   └── renderer/       # Window UI (connect + overlay)
│   └── icons/              # App icons
│
├── server/                 # Fastify WebSocket server
│   ├── src/
│   │   └── index.ts        # Server entry point
│   ├── Dockerfile          # Docker build config
│   └── fly.toml            # Fly.io deployment config
│
└── README.md
```

## Features

- **Ready Overlay**: Press `Ctrl+Shift+R` to toggle Ready state for all connected users
- **WebSocket Sync**: Real-time state synchronization across all connected clients
- **Always-on-top Overlay**: Transparent overlay visible over any application
- **Connection Window**: Desktop window to connect to the server

## Quick Start

### Server (Local Development)

```bash
cd server
npm install
npm run dev
```

The server will start on `http://localhost:3000` with WebSocket endpoint at `ws://localhost:3000/ws`.

### Desktop App (Electron)

```bash
cd app
npm install
npm start
```

This builds and launches the Electron app.

## Server Deployment (Fly.io)

### Prerequisites

1. Install [Fly CLI](https://fly.io/docs/getting-started/installing-flyctl/)
2. Sign up / log in: `fly auth login`

### Deploy

```bash
cd server

# Create a new Fly app (first time only)
fly apps create shd-overlay-server

# Deploy
fly deploy
```

Your server will be available at `https://shd-overlay-server.fly.dev` with WebSocket at `wss://shd-overlay-server.fly.dev/ws`.

### Monitor

```bash
# View logs
fly logs

# Check status
fly status

# Open dashboard
fly dashboard
```

## Usage

1. Start the server (locally or deploy to Fly.io)
2. Run the desktop app: `cd app && npm start`
3. In the Connect window, enter your server URL:
   - Local: `ws://localhost:3000/ws`
   - Fly.io: `wss://your-app.fly.dev/ws`
4. Click Connect
5. The overlay appears in the top-right corner (always on top)
6. Press `Ctrl+Shift+R` to trigger Ready state for all connected users

## Message Protocol

### Client → Server

```json
{ "type": "ready", "value": true }
```

### Server → Client

```json
{ "type": "ready", "value": true }
{ "type": "connected", "message": "...", "clients": 3 }
{ "type": "pong", "timestamp": 1234567890 }
```

## Configuration

### Hotkey

The default hotkey is `Ctrl+Shift+R`. To change it, edit `app/src/main/index.ts` and modify the `globalShortcut.register()` call.

### Server Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server host |
| `NODE_ENV` | `development` | Environment |

## Desktop App Distribution & Auto-Updates

The app uses `electron-builder` for packaging and `electron-updater` for automatic updates via GitHub Releases.

### Build the Windows Installer

```bash
cd app
npm install
npm run dist
```

This creates a Windows installer in `app/release/`.

### Publishing a Release (Manual)

1. Update the version in `app/package.json`:
   ```json
   "version": "1.0.1"
   ```

2. Create a GitHub personal access token with `repo` scope at https://github.com/settings/tokens

3. Set the token as an environment variable:
   ```powershell
   $env:GH_TOKEN = "your_github_token"
   ```

4. Build and publish:
   ```bash
   cd app
   npm run publish
   ```

5. Go to https://github.com/ryankuah/shdapp/releases and publish the draft release.

### Publishing a Release (CI/CD with GitHub Actions)

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        working-directory: app
        run: npm ci

      - name: Build and publish
        working-directory: app
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npm run publish
```

Then push a version tag to trigger the release:

```bash
git tag v1.0.1
git push origin v1.0.1
```

### How Auto-Updates Work

- When the packaged app starts, it checks GitHub Releases for newer versions.
- If an update is found, it downloads automatically in the background.
- When the download completes, a dialog prompts the user to restart now or later.
- The update installs on the next app restart.

## Development Notes

- The overlay window is transparent and click-through by default
- The overlay auto-hides after 5 seconds
- WebSocket client automatically reconnects on disconnect
- Server broadcasts Ready state to ALL connected clients (including sender)
- Auto-updates only run in packaged builds (skipped in development)

## License

MIT
