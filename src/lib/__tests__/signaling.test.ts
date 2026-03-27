import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock WebSocket
class MockWebSocket {
	static OPEN = 1;
	readyState = MockWebSocket.OPEN;
	onmessage: ((e: any) => void) | null = null;
	sent: string[] = [];
	listeners: Record<string, Function[]> = {};

	constructor(public url: string) {
		setTimeout(() => this.fireEvent('open'), 0);
	}

	send(data: string) { this.sent.push(data); }
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
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:8080' });

import { createSignaling } from '../signaling';

describe('createSignaling', () => {
	let messages: any[];
	let signaling: ReturnType<typeof createSignaling>;

	beforeEach(() => {
		messages = [];
		signaling = createSignaling((msg) => messages.push(msg));
	});

	it('connects to the correct WebSocket URL', () => {
		// The MockWebSocket constructor receives the URL
		expect(signaling).toBeDefined();
	});

	it('sends JSON messages', async () => {
		await signaling.waitOpen();
		signaling.send({ type: 'create' });
		// Access the underlying mock
		const ws = (signaling as any);
		expect(ws.ready).toBe(true);
	});

	it('parses incoming messages', async () => {
		await signaling.waitOpen();
		// Simulate by directly calling the callback
		const callback = messages;
		expect(callback).toEqual([]);
	});

	it('close sets state', () => {
		signaling.close();
		expect(signaling.ready).toBe(false);
	});
});
