import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { handler } from './build/handler.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

const server = createServer(handler);

// --- Signaling Server ---
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const rooms = new Map();

function generateCode() {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code = '';
	for (let i = 0; i < 6; i++) code += chars[(Math.random() * chars.length) | 0];
	return code;
}

function send(ws, data) {
	if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

wss.on('connection', (ws) => {
	ws.isAlive = true;
	ws.on('pong', () => { ws.isAlive = true; });

	let currentRoom = null;

	ws.on('message', (raw, isBinary) => {
		// Binary frame: relay to the other peer in the room
		if (isBinary) {
			if (!currentRoom) return;
			const room = rooms.get(currentRoom);
			if (!room) return;
			for (const peer of room) {
				if (peer !== ws && peer.readyState === 1) {
					peer.send(raw, { binary: true });
				}
			}
			return;
		}

		let msg;
		try { msg = JSON.parse(raw.toString()); } catch { return; }

		switch (msg.type) {
			case 'create': {
				let code = generateCode();
				while (rooms.has(code)) code = generateCode();
				rooms.set(code, new Set([ws]));
				currentRoom = code;
				send(ws, { type: 'created', code });
				break;
			}

			case 'join': {
				const code = (msg.code || '').toUpperCase().trim();
				const room = rooms.get(code);
				if (!room) {
					send(ws, { type: 'error', message: 'Room not found' });
					break;
				}
				if (room.size >= 2) {
					send(ws, { type: 'error', message: 'Room is full' });
					break;
				}
				room.add(ws);
				currentRoom = code;
				// Notify both peers
				for (const peer of room) {
					send(peer, { type: 'peer-joined', count: room.size });
				}
				break;
			}

			// WebRTC signaling + relay control messages
			case 'offer':
			case 'answer':
			case 'ice-candidate':
			case 'relay-meta':
			case 'relay-end': {
				if (!currentRoom) break;
				const room = rooms.get(currentRoom);
				if (!room) break;
				for (const peer of room) {
					if (peer !== ws) send(peer, msg);
				}
				break;
			}
		}
	});

	ws.on('close', () => {
		if (!currentRoom) return;
		const room = rooms.get(currentRoom);
		if (!room) return;
		room.delete(ws);
		if (room.size === 0) {
			rooms.delete(currentRoom);
		} else {
			for (const peer of room) {
				send(peer, { type: 'peer-left' });
			}
		}
	});
});

// Heartbeat: detect dead connections every 30s
setInterval(() => {
	for (const ws of wss.clients) {
		if (!ws.isAlive) { ws.terminate(); continue; }
		ws.isAlive = false;
		ws.ping();
	}
}, 30_000);

// Cleanup stale rooms every 5 minutes
setInterval(() => {
	for (const [code, room] of rooms) {
		if (room.size === 0) rooms.delete(code);
	}
}, 5 * 60 * 1000);

server.listen(PORT, () => {
	console.log(`ShareIt running on port ${PORT}`);
});
