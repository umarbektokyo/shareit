export type SignalMessage =
	| { type: 'create' }
	| { type: 'join'; code: string }
	| { type: 'created'; code: string }
	| { type: 'peer-joined'; count: number }
	| { type: 'peer-left' }
	| { type: 'error'; message: string }
	| { type: 'offer'; sdp: RTCSessionDescriptionInit }
	| { type: 'answer'; sdp: RTCSessionDescriptionInit }
	| { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
	| { type: 'relay-meta'; name: string; size: number; mimeType: string }
	| { type: 'relay-end' };

export function createSignaling(
	onMessage: (msg: SignalMessage) => void,
	onBinary?: (data: ArrayBuffer) => void
) {
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const ws = new WebSocket(`${proto}//${location.host}/ws`);
	ws.binaryType = 'arraybuffer';

	ws.onmessage = (e) => {
		if (e.data instanceof ArrayBuffer) {
			onBinary?.(e.data);
			return;
		}
		try {
			onMessage(JSON.parse(e.data));
		} catch { /* ignore */ }
	};

	function send(msg: SignalMessage) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	}

	function sendBinary(data: ArrayBuffer) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(data);
		}
	}

	function waitOpen(): Promise<void> {
		if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
		return new Promise((resolve, reject) => {
			ws.addEventListener('open', () => resolve(), { once: true });
			ws.addEventListener('error', () => reject(new Error('WebSocket failed')), { once: true });
		});
	}

	return {
		send,
		sendBinary,
		waitOpen,
		close: () => ws.close(),
		get ready() { return ws.readyState === WebSocket.OPEN; }
	};
}
