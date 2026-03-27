import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// Inline a minimal signaling server for testing (mirrors server.js logic)
function createSignalingServer(port: number) {
	const server = createServer((_req, res) => {
		res.writeHead(200);
		res.end('ok');
	});

	const wss = new WebSocketServer({ server, path: '/ws' });
	const rooms = new Map<string, Set<WebSocket>>();

	function generateCode() {
		const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
		let code = '';
		for (let i = 0; i < 6; i++) code += chars[(Math.random() * chars.length) | 0];
		return code;
	}

	function send(ws: WebSocket, data: any) {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
	}

	wss.on('connection', (ws) => {
		let currentRoom: string | null = null;

		ws.on('message', (raw) => {
			let msg: any;
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
					if (!room) { send(ws, { type: 'error', message: 'Room not found' }); break; }
					if (room.size >= 2) { send(ws, { type: 'error', message: 'Room is full' }); break; }
					room.add(ws);
					currentRoom = code;
					for (const peer of room) send(peer, { type: 'peer-joined', count: room.size });
					break;
				}
				case 'offer':
				case 'answer':
				case 'ice-candidate': {
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
			if (room.size === 0) rooms.delete(currentRoom);
			else for (const peer of room) send(peer, { type: 'peer-left' });
		});
	});

	return new Promise<{ server: ReturnType<typeof createServer>; wss: WebSocketServer; rooms: typeof rooms }>((resolve) => {
		server.listen(port, () => resolve({ server, wss, rooms }));
	});
}

function connectWs(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${port}/ws`);
		ws.on('open', () => resolve(ws));
		ws.on('error', reject);
	});
}

function waitMessage(ws: WebSocket): Promise<any> {
	return new Promise((resolve) => {
		ws.once('message', (data) => resolve(JSON.parse(data.toString())));
	});
}

const PORT = 9876;
let serverCtx: Awaited<ReturnType<typeof createSignalingServer>>;

beforeAll(async () => {
	serverCtx = await createSignalingServer(PORT);
});

afterAll(() => {
	serverCtx.wss.close();
	serverCtx.server.close();
});

describe('Signaling Server', () => {
	it('creates a room and returns a 6-char code', async () => {
		const ws = await connectWs(PORT);
		const msgP = waitMessage(ws);
		ws.send(JSON.stringify({ type: 'create' }));
		const msg = await msgP;

		expect(msg.type).toBe('created');
		expect(msg.code).toMatch(/^[A-Z2-9]{6}$/);

		ws.close();
	});

	it('joins an existing room', async () => {
		const ws1 = await connectWs(PORT);
		const createP = waitMessage(ws1);
		ws1.send(JSON.stringify({ type: 'create' }));
		const { code } = await createP;

		const ws2 = await connectWs(PORT);
		const joinP1 = waitMessage(ws1);
		const joinP2 = waitMessage(ws2);
		ws2.send(JSON.stringify({ type: 'join', code }));

		const msg1 = await joinP1;
		const msg2 = await joinP2;
		expect(msg1.type).toBe('peer-joined');
		expect(msg1.count).toBe(2);
		expect(msg2.type).toBe('peer-joined');
		expect(msg2.count).toBe(2);

		ws1.close();
		ws2.close();
	});

	it('returns error for invalid room code', async () => {
		const ws = await connectWs(PORT);
		const msgP = waitMessage(ws);
		ws.send(JSON.stringify({ type: 'join', code: 'ZZZZZZ' }));
		const msg = await msgP;

		expect(msg.type).toBe('error');
		expect(msg.message).toBe('Room not found');

		ws.close();
	});

	it('returns error when room is full', async () => {
		const ws1 = await connectWs(PORT);
		const createP = waitMessage(ws1);
		ws1.send(JSON.stringify({ type: 'create' }));
		const { code } = await createP;

		const ws2 = await connectWs(PORT);
		const joinP = waitMessage(ws2);
		ws2.send(JSON.stringify({ type: 'join', code }));
		await joinP;

		const ws3 = await connectWs(PORT);
		const errP = waitMessage(ws3);
		ws3.send(JSON.stringify({ type: 'join', code }));
		const msg = await errP;

		expect(msg.type).toBe('error');
		expect(msg.message).toBe('Room is full');

		ws1.close();
		ws2.close();
		ws3.close();
	});

	it('relays signaling messages between peers', async () => {
		const ws1 = await connectWs(PORT);
		const createP = waitMessage(ws1);
		ws1.send(JSON.stringify({ type: 'create' }));
		const { code } = await createP;

		const ws2 = await connectWs(PORT);
		// Set up listeners for peer-joined on BOTH before sending join
		const joinP1 = waitMessage(ws1);
		const joinP2 = waitMessage(ws2);
		ws2.send(JSON.stringify({ type: 'join', code }));
		await joinP1;
		await joinP2;

		// ws1 sends an offer, ws2 should receive it
		const offerP = waitMessage(ws2);
		ws1.send(JSON.stringify({ type: 'offer', sdp: { type: 'offer', sdp: 'fake-sdp' } }));
		const offer = await offerP;

		expect(offer.type).toBe('offer');
		expect(offer.sdp.sdp).toBe('fake-sdp');

		// ws2 sends an answer, ws1 should receive it
		const answerP = waitMessage(ws1);
		ws2.send(JSON.stringify({ type: 'answer', sdp: { type: 'answer', sdp: 'fake-answer' } }));
		const answer = await answerP;

		expect(answer.type).toBe('answer');
		expect(answer.sdp.sdp).toBe('fake-answer');

		ws1.close();
		ws2.close();
	});

	it('notifies peer-left when a peer disconnects', async () => {
		const ws1 = await connectWs(PORT);
		const createP = waitMessage(ws1);
		ws1.send(JSON.stringify({ type: 'create' }));
		const { code } = await createP;

		const ws2 = await connectWs(PORT);
		// Set up listeners for peer-joined on BOTH before sending join
		const joinP1 = waitMessage(ws1);
		const joinP2 = waitMessage(ws2);
		ws2.send(JSON.stringify({ type: 'join', code }));
		await joinP1;
		await joinP2;

		const leftP = waitMessage(ws1);
		ws2.close();
		const msg = await leftP;

		expect(msg.type).toBe('peer-left');

		ws1.close();
	});

	it('cleans up empty rooms after disconnect', async () => {
		const ws = await connectWs(PORT);
		const createP = waitMessage(ws);
		ws.send(JSON.stringify({ type: 'create' }));
		const { code } = await createP;

		ws.close();
		// Wait a tick for close handler
		await new Promise((r) => setTimeout(r, 100));

		expect(serverCtx.rooms.has(code)).toBe(false);
	});

	it('handles case-insensitive room codes', async () => {
		const ws1 = await connectWs(PORT);
		const createP = waitMessage(ws1);
		ws1.send(JSON.stringify({ type: 'create' }));
		const { code } = await createP;

		const ws2 = await connectWs(PORT);
		const joinP = waitMessage(ws2);
		ws2.send(JSON.stringify({ type: 'join', code: code.toLowerCase() }));
		const msg = await joinP;

		expect(msg.type).toBe('peer-joined');

		ws1.close();
		ws2.close();
	});

	it('ignores malformed JSON', async () => {
		const ws = await connectWs(PORT);
		// Should not crash
		ws.send('not-json{{{');
		await new Promise((r) => setTimeout(r, 100));
		expect(ws.readyState).toBe(WebSocket.OPEN);
		ws.close();
	});

	it('relays ICE candidates', async () => {
		const ws1 = await connectWs(PORT);
		const createP = waitMessage(ws1);
		ws1.send(JSON.stringify({ type: 'create' }));
		const { code } = await createP;

		const ws2 = await connectWs(PORT);
		const joinP1 = waitMessage(ws1);
		const joinP2 = waitMessage(ws2);
		ws2.send(JSON.stringify({ type: 'join', code }));
		await joinP1;
		await joinP2;

		const iceP = waitMessage(ws2);
		ws1.send(JSON.stringify({ type: 'ice-candidate', candidate: { candidate: 'fake', sdpMid: '0' } }));
		const ice = await iceP;

		expect(ice.type).toBe('ice-candidate');
		expect(ice.candidate.candidate).toBe('fake');

		ws1.close();
		ws2.close();
	});
});
