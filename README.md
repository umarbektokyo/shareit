# ShareIt

Peer-to-peer file transfer in the browser. Both users open the site, enter the same room code, and files transfer directly between them via WebRTC — the server only relays the initial handshake.

## Features

- **True P2P** — files transfer directly between browsers via WebRTC DataChannels, never touching the server
- **Room codes** — 6-character codes to pair two peers, no accounts or sign-ups
- **Any file type or size** — chunked transfer with backpressure handling
- **Zero server storage** — the server only relays WebSocket signaling messages (a few KB per session)
- **Mobile friendly** — responsive UI with touch-sized targets
- **Blender-style UI** — dark theme with beveled widgets and the Inter typeface
- **Auto-cleanup** — rooms are destroyed when peers disconnect; heartbeat detects zombie connections

## How It Works

1. Person A clicks **Create Room** and gets a 6-character code
2. Person B enters the code and clicks **Join**
3. The server relays WebRTC signaling (SDP offers/answers, ICE candidates) over WebSocket
4. A direct peer-to-peer DataChannel opens between the two browsers
5. Files are chunked (64KB) and sent through the DataChannel
6. The server's job is done — all file data flows directly between peers

## Quick Start

```bash
# Install dependencies
npm install

# Build and run
make start
# Open http://localhost:8080
```

## Development

```bash
# Dev server with hot reload
make dev
# Open http://localhost:5173
```

## Run Tests

```bash
make test
```

Tests cover:
- Room creation and code generation
- Room joining and peer notification
- Invalid/full room error handling
- Signaling relay (offers, answers, ICE candidates)
- Peer disconnect notification
- Empty room cleanup
- Case-insensitive room codes
- Malformed message handling

## Project Structure

```
shareit/
├── src/
│   ├── routes/
│   │   └── +page.svelte         # Main UI (Blender-style)
│   ├── lib/
│   │   ├── signaling.ts         # WebSocket signaling client
│   │   ├── peer.ts              # WebRTC DataChannel file transfer
│   │   └── __tests__/
│   │       ├── server.test.ts   # Signaling server integration tests
│   │       └── signaling.test.ts # Signaling client unit tests
│   └── app.html
├── static/
│   └── favicon.svg              # Share-nodes icon (Blender orange)
├── server.js                    # Node server: SvelteKit handler + WebSocket signaling
├── svelte.config.js
├── vite.config.ts
├── Dockerfile                   # Multi-stage: build SvelteKit → slim Node runtime
├── Makefile
├── LICENSE
└── README.md
```

## Configuration

| Environment Variable | Default | Description                    |
|---------------------|---------|--------------------------------|
| `PORT`              | `8080`  | Port the server listens on     |

## Docker

```bash
# Using docker compose
docker compose up --build

# Or build and run manually
docker build -t shareit .
docker run -p 8080:8080 shareit
```

### Docker Compose (for your umbrella setup)

```yaml
shareit:
  container_name: shareit
  build:
    context: https://github.com/umarbektokyo/shareit.git#main
  expose:
    - "${PORT_SHAREIT:-8080}"
  environment:
    - PORT=${PORT_SHAREIT:-8080}
  networks:
    - umbrella
  healthcheck:
    test: ["CMD-SHELL", "wget -qO- http://localhost:${PORT_SHAREIT:-8080} || exit 1"]
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 15s
  restart: unless-stopped
```

## Tech Stack

- **Frontend**: SvelteKit, Svelte 5, Vite
- **Signaling**: WebSocket (via `ws` library)
- **Transfer**: WebRTC DataChannels (browser-native, no dependencies)
- **STUN**: Google public STUN servers
- **UI**: Blender-inspired dark theme with Inter typeface

## Limitations

- **TURN fallback**: ~15% of connections behind strict NATs will fail without a TURN server. Add [coturn](https://github.com/coturn/coturn) or [Cloudflare TURN](https://developers.cloudflare.com/calls/turn/) for full coverage.
- **Two peers max**: Each room supports exactly two peers. For multi-peer, the signaling logic would need a mesh or SFU.
- **Browser tab must stay open**: Closing the tab ends the WebRTC connection and any in-progress transfers.

## License

MIT
