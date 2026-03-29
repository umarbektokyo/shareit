import type { SignalMessage } from './signaling';

const CHUNK_SIZE = 64 * 1024; // 64KB chunks

export interface FileMetadata {
	name: string;
	size: number;
	mimeType: string;
}

export interface TransferProgress {
	fileName: string;
	total: number;
	received: number;
	done: boolean;
}

export function createPeerConnection(
	isInitiator: boolean,
	sendSignal: (msg: SignalMessage) => void,
	onFile: (file: File) => void,
	onProgress: (progress: TransferProgress) => void,
	onConnected: () => void,
	onDisconnected: () => void,
	onP2PFailed: () => void
) {
	const config: RTCConfiguration = {
		iceServers: [
			{ urls: 'stun:stun.l.google.com:19302' },
			{ urls: 'stun:stun1.l.google.com:19302' }
		]
	};

	// If WebRTC doesn't connect in 5s, fall back to relay
	let connected = false;
	const timeout = setTimeout(() => {
		if (!connected) onP2PFailed();
	}, 5000);

	const pc = new RTCPeerConnection(config);
	let dataChannel: RTCDataChannel | null = null;

	// Incoming file assembly state
	let incomingMeta: FileMetadata | null = null;
	let incomingChunks: ArrayBuffer[] = [];
	let incomingReceived = 0;

	function setupChannel(ch: RTCDataChannel) {
		dataChannel = ch;
		ch.binaryType = 'arraybuffer';

		ch.onopen = () => { connected = true; clearTimeout(timeout); onConnected(); };
		ch.onclose = () => onDisconnected();

		ch.onmessage = (e) => {
			if (typeof e.data === 'string') {
				const msg = JSON.parse(e.data);
				if (msg.type === 'file-meta') {
					incomingMeta = msg;
					incomingChunks = [];
					incomingReceived = 0;
					onProgress({ fileName: msg.name, total: msg.size, received: 0, done: false });
				} else if (msg.type === 'file-end') {
					if (incomingMeta) {
						const blob = new Blob(incomingChunks, { type: incomingMeta.mimeType || 'application/octet-stream' });
						const file = new File([blob], incomingMeta.name, { type: blob.type });
						onProgress({ fileName: incomingMeta.name, total: incomingMeta.size, received: incomingMeta.size, done: true });
						onFile(file);
						incomingMeta = null;
						incomingChunks = [];
						incomingReceived = 0;
					}
				}
			} else {
				// Binary chunk
				incomingChunks.push(e.data);
				incomingReceived += e.data.byteLength;
				if (incomingMeta) {
					onProgress({ fileName: incomingMeta.name, total: incomingMeta.size, received: incomingReceived, done: false });
				}
			}
		};
	}

	if (isInitiator) {
		const ch = pc.createDataChannel('file-transfer', { ordered: true });
		setupChannel(ch);
	} else {
		pc.ondatachannel = (e) => setupChannel(e.channel);
	}

	pc.onicecandidate = (e) => {
		if (e.candidate) {
			sendSignal({ type: 'ice-candidate', candidate: e.candidate.toJSON() });
		}
	};

	async function createOffer() {
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		sendSignal({ type: 'offer', sdp: pc.localDescription! });
	}

	async function handleSignal(msg: SignalMessage) {
		if (msg.type === 'offer') {
			await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			sendSignal({ type: 'answer', sdp: pc.localDescription! });
		} else if (msg.type === 'answer') {
			await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
		} else if (msg.type === 'ice-candidate') {
			await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
		}
	}

	async function sendFile(file: File) {
		if (!dataChannel || dataChannel.readyState !== 'open') return;

		// Send metadata
		dataChannel.send(JSON.stringify({
			type: 'file-meta',
			name: file.name,
			size: file.size,
			mimeType: file.type
		}));

		// Send chunks
		let offset = 0;
		while (offset < file.size) {
			const slice = file.slice(offset, offset + CHUNK_SIZE);
			const buffer = await slice.arrayBuffer();

			// Backpressure: wait if buffered amount is too high
			while (dataChannel.bufferedAmount > 2 * 1024 * 1024) {
				await new Promise((r) => setTimeout(r, 20));
			}

			dataChannel.send(buffer);
			offset += buffer.byteLength;
		}

		dataChannel.send(JSON.stringify({ type: 'file-end' }));
	}

	function destroy() {
		clearTimeout(timeout);
		dataChannel?.close();
		pc.close();
	}

	return {
		createOffer,
		handleSignal,
		sendFile,
		destroy,
		get connected() { return dataChannel?.readyState === 'open'; }
	};
}
