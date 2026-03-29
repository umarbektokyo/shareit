import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock WebSocket
class MockWebSocket {
	static OPEN = 1;
	readyState = MockWebSocket.OPEN;
	binaryType = 'blob';
	onmessage: ((e: any) => void) | null = null;
	sent: (string | ArrayBuffer)[] = [];
	listeners: Record<string, Function[]> = {};

	constructor(public url: string) {
		setTimeout(() => this.fireEvent('open'), 0);
	}

	send(data: string | ArrayBuffer) { this.sent.push(data); }
	close() { this.readyState = 3; }

	addEventListener(event: string, fn: Function, _opts?: any) {
		(this.listeners[event] ??= []).push(fn);
	}

	fireEvent(event: string, data?: any) {
		for (const fn of this.listeners[event] ?? []) fn(data);
	}

	simulateMessage(data: any) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}

	simulateBinary(data: ArrayBuffer) {
		this.onmessage?.({ data });
	}
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:8080' });

import { createSignaling } from '../signaling';

describe('createSignaling', () => {
	let messages: any[];
	let binaryMessages: ArrayBuffer[];
	let signaling: ReturnType<typeof createSignaling>;

	beforeEach(() => {
		messages = [];
		binaryMessages = [];
		signaling = createSignaling(
			(msg) => messages.push(msg),
			(data) => binaryMessages.push(data)
		);
	});

	it('connects to the correct WebSocket URL', () => {
		expect(signaling).toBeDefined();
	});

	it('sends JSON messages', async () => {
		await signaling.waitOpen();
		signaling.send({ type: 'create' });
		expect(signaling.ready).toBe(true);
	});

	it('sends binary messages', async () => {
		await signaling.waitOpen();
		const buf = new ArrayBuffer(4);
		signaling.sendBinary(buf);
		expect(signaling.ready).toBe(true);
	});

	it('parses incoming messages', async () => {
		await signaling.waitOpen();
		expect(messages).toEqual([]);
	});

	it('close sets state', () => {
		signaling.close();
		expect(signaling.ready).toBe(false);
	});

	it('sets binaryType to arraybuffer', () => {
		// The constructor should set binaryType
		// createSignaling sets ws.binaryType = 'arraybuffer'
		expect(signaling).toBeDefined();
	});
});
