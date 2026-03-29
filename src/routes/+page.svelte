<script lang="ts">
	import { createSignaling, type SignalMessage } from '$lib/signaling';
	import { createPeerConnection, type TransferProgress, type FileMetadata } from '$lib/peer';
	import { SpeedTracker } from '$lib/speed';
	import { isStreamSaveSupported, createFileWriter } from '$lib/stream-saver';

	const CHUNK_SIZE = 64 * 1024;

	type State = 'idle' | 'waiting' | 'connecting' | 'connected' | 'disconnected';

	interface QueueItem {
		name: string;
		size: number;
		status: 'pending' | 'sending' | 'done';
		sent: number;
	}

	interface ReceivedFile {
		name: string;
		url: string;
		size: number;
		blob: Blob | null; // kept for save-to-disk; null after saving
	}

	let state = $state<State>('idle');
	let roomCode = $state('');
	let joinInput = $state('');
	let error = $state('');
	let receivedFiles = $state<ReceivedFile[]>([]);
	let recvProgress = $state<TransferProgress | null>(null);
	let recvSpeed = $state(0);
	let isDragging = $state(false);
	let relayMode = $state(false);
	let canSaveToDisk = $state(false);

	// Send queue state
	let sendQueue = $state<{ items: QueueItem[]; totalBytes: number; totalSent: number } | null>(null);
	let sendSpeed = $state(0);

	let signaling: ReturnType<typeof createSignaling> | null = null;
	let peer: ReturnType<typeof createPeerConnection> | null = null;
	let isInitiator = false;

	// Speed trackers
	const sendSpeedTracker = new SpeedTracker();
	const recvSpeedTracker = new SpeedTracker();

	// Relay receive state
	let relayMeta: FileMetadata | null = null;
	let relayChunks: (Blob | ArrayBuffer)[] = [];
	let relayReceived = 0;
	let relayUnflushed = 0;
	const FLUSH_THRESHOLD = 32 * 1024 * 1024;

	// Check FSAA support on load
	if (typeof window !== 'undefined') {
		canSaveToDisk = isStreamSaveSupported();
	}

	function cleanup() {
		peer?.destroy();
		signaling?.close();
		peer = null;
		signaling = null;
		relayMode = false;
	}

	function handleRelayBinary(data: ArrayBuffer) {
		relayChunks.push(data);
		relayReceived += data.byteLength;
		relayUnflushed += data.byteLength;
		if (relayUnflushed >= FLUSH_THRESHOLD) {
			const flushed = new Blob(relayChunks);
			relayChunks = [flushed];
			relayUnflushed = 0;
		}
		if (relayMeta) {
			recvSpeed = recvSpeedTracker.update(relayReceived);
			recvProgress = { fileName: relayMeta.name, total: relayMeta.size, received: relayReceived, done: false };
		}
	}

	function handleSignalMessage(msg: SignalMessage) {
		switch (msg.type) {
			case 'created':
				roomCode = msg.code;
				state = 'waiting';
				break;
			case 'peer-joined':
				if (msg.count === 2) {
					state = 'connecting';
					peer = createPeerConnection(
						isInitiator,
						(m) => signaling?.send(m),
						handleReceivedFile,
						handleRecvProgress,
						() => { state = 'connected'; },
						() => { state = 'disconnected'; },
						() => {
							relayMode = true;
							state = 'connected';
						}
					);
					if (isInitiator) peer.createOffer();
				}
				break;
			case 'peer-left':
				state = 'disconnected';
				peer?.destroy();
				peer = null;
				break;
			case 'error':
				error = msg.message;
				break;
			case 'offer':
			case 'answer':
			case 'ice-candidate':
				peer?.handleSignal(msg);
				break;
			case 'relay-meta':
				relayMeta = { name: msg.name, size: msg.size, mimeType: msg.mimeType };
				relayChunks = [];
				relayReceived = 0;
				relayUnflushed = 0;
				recvSpeedTracker.reset();
				recvProgress = { fileName: msg.name, total: msg.size, received: 0, done: false };
				break;
			case 'relay-end':
				if (relayMeta) {
					const blob = new Blob(relayChunks, { type: relayMeta.mimeType || 'application/octet-stream' });
					const file = new File([blob], relayMeta.name, { type: blob.type });
					recvProgress = { fileName: relayMeta.name, total: relayMeta.size, received: relayMeta.size, done: true };
					handleReceivedFile(file);
					relayMeta = null;
					relayChunks = [];
					relayReceived = 0;
					relayUnflushed = 0;
					setTimeout(() => { recvProgress = null; }, 1500);
				}
				break;
		}
	}

	function handleReceivedFile(file: File) {
		const url = URL.createObjectURL(file);
		receivedFiles = [...receivedFiles, { name: file.name, url, size: file.size, blob: file }];
	}

	function handleRecvProgress(p: TransferProgress) {
		// Reset speed tracker when a new file starts
		if (p.received === 0) {
			recvSpeedTracker.reset();
		}
		recvSpeed = recvSpeedTracker.update(p.received);
		recvProgress = p;
		if (p.done) {
			setTimeout(() => { recvProgress = null; }, 1500);
		}
	}

	async function saveToDisk(index: number) {
		const file = receivedFiles[index];
		if (!file.blob) return;
		const writer = await createFileWriter(file.name, file.blob.type);
		if (!writer) return; // user cancelled
		try {
			await writer.write(file.blob);
			await writer.close();
			// Free the blob and object URL from memory
			URL.revokeObjectURL(file.url);
			receivedFiles[index] = { ...file, blob: null, url: '' };
			receivedFiles = [...receivedFiles];
		} catch {
			try { await writer.close(); } catch { /* ignore */ }
		}
	}

	async function createRoom() {
		error = '';
		isInitiator = true;
		signaling = createSignaling(handleSignalMessage, handleRelayBinary);
		await signaling.waitOpen();
		signaling.send({ type: 'create' });
	}

	async function joinRoom() {
		error = '';
		const code = joinInput.toUpperCase().trim();
		if (code.length !== 6) {
			error = 'Code must be 6 characters';
			return;
		}
		isInitiator = false;
		signaling = createSignaling(handleSignalMessage, handleRelayBinary);
		await signaling.waitOpen();
		signaling.send({ type: 'join', code });
	}

	async function sendFileViaRelay(file: File, onProgress: (p: TransferProgress) => void) {
		if (!signaling?.ready) return;
		signaling.send({ type: 'relay-meta', name: file.name, size: file.size, mimeType: file.type });

		let offset = 0;
		while (offset < file.size) {
			const slice = file.slice(offset, offset + CHUNK_SIZE);
			const buffer = await slice.arrayBuffer();
			signaling.sendBinary(buffer);
			offset += buffer.byteLength;
			onProgress({ fileName: file.name, total: file.size, received: offset, done: false });
			if (offset % (CHUNK_SIZE * 16) === 0) {
				await new Promise((r) => setTimeout(r, 0));
			}
		}

		signaling.send({ type: 'relay-end' });
	}

	async function handleFiles(files: FileList | null) {
		if (!files) return;
		if (!relayMode && !peer?.connected) return;
		if (relayMode && !signaling?.ready) return;

		const validFiles = Array.from(files).filter(f => f.size > 0 || f.type !== '');
		if (validFiles.length === 0) {
			error = 'Folders are not supported — please select individual files (or zip the folder first)';
			return;
		}
		error = '';

		const items: QueueItem[] = validFiles.map(f => ({ name: f.name, size: f.size, status: 'pending' as const, sent: 0 }));
		const totalBytes = validFiles.reduce((sum, f) => sum + f.size, 0);
		sendQueue = { items, totalBytes, totalSent: 0 };

		for (let i = 0; i < validFiles.length; i++) {
			sendQueue.items[i] = { ...sendQueue.items[i], status: 'sending' };
			sendQueue = { ...sendQueue };
			sendSpeedTracker.reset();

			const file = validFiles[i];
			const onProgress = (p: TransferProgress) => {
				sendSpeed = sendSpeedTracker.update(p.received);
				sendQueue!.items[i] = { ...sendQueue!.items[i], sent: p.received };
				sendQueue!.totalSent = sendQueue!.items.reduce((s, item) => s + item.sent, 0);
				sendQueue = { ...sendQueue! };
			};

			if (relayMode) {
				await sendFileViaRelay(file, onProgress);
			} else {
				await peer!.sendFile(file, (p) => onProgress(p));
			}

			sendQueue.items[i] = { ...sendQueue.items[i], status: 'done', sent: file.size };
			sendQueue.totalSent = sendQueue.items.reduce((s, item) => s + item.sent, 0);
			sendQueue = { ...sendQueue };
		}

		await new Promise((r) => setTimeout(r, 2000));
		sendQueue = null;
		sendSpeed = 0;
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		handleFiles(e.dataTransfer?.files ?? null);
	}

	function onDragOver(e: DragEvent) {
		e.preventDefault();
		isDragging = true;
	}

	function formatSize(bytes: number) {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}

	function formatSpeed(bytesPerSec: number): string {
		if (bytesPerSec <= 0) return '';
		if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
		if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
		return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
	}

	function disconnect() {
		cleanup();
		state = 'idle';
		roomCode = '';
		joinInput = '';
		// Revoke all object URLs
		for (const f of receivedFiles) {
			if (f.url) URL.revokeObjectURL(f.url);
		}
		receivedFiles = [];
		sendQueue = null;
		sendSpeed = 0;
		recvSpeed = 0;
		recvProgress = null;
	}

	function copyCode() {
		navigator.clipboard.writeText(roomCode);
	}
</script>

<div class="app">
	<!-- Header bar -->
	<div class="header">
		<div class="header-left">
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
				<circle cx="4" cy="8" r="2" fill="#E87D0D"/>
				<circle cx="12" cy="4" r="2" fill="#E87D0D"/>
				<circle cx="12" cy="12" r="2" fill="#E87D0D"/>
				<path d="M5.8 7.1l4.4-2.2M5.8 8.9l4.4 2.2" stroke="#E87D0D" stroke-width="1.1" stroke-linecap="round" opacity="0.7"/>
			</svg>
			<span class="header-title">ShareIt</span>
			<span class="header-sep">|</span>
			<span class="header-sub">P2P File Transfer</span>
		</div>
		<div class="header-right">
			{#if state !== 'idle'}
				<button class="bw btn-sm" onclick={disconnect}>Disconnect</button>
			{/if}
			<a href="https://github.com/umarbektokyo/shareit" target="_blank" rel="noopener noreferrer" class="gh-link" title="GitHub">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
					<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
				</svg>
			</a>
		</div>
	</div>

	<!-- Main content -->
	<div class="main">
		{#if state === 'idle'}
			<div class="center-panel">
				<div class="panel">
					<div class="panel-header">
						<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
							<circle cx="8" cy="8" r="6" stroke="#5a9fd4" stroke-width="1.2"/>
							<path d="M8 5v6M5 8h6" stroke="#5a9fd4" stroke-width="1.2" stroke-linecap="round"/>
						</svg>
						<span>New Session</span>
					</div>
					<div class="panel-body">
						<p class="hint">Create a room and share the code with your peer, or join an existing room.</p>

						<button class="bw btn-full" onclick={createRoom}>Create Room</button>

						<div class="divider">
							<span>or</span>
						</div>

						<div class="join-row">
							<input
								class="input"
								type="text"
								placeholder="Enter code"
								maxlength="6"
								bind:value={joinInput}
								onkeydown={(e) => e.key === 'Enter' && joinRoom()}
							/>
							<button class="bw" onclick={joinRoom}>Join</button>
						</div>

						{#if error}
							<div class="error-msg">{error}</div>
						{/if}
					</div>
				</div>
			</div>

		{:else if state === 'waiting'}
			<div class="center-panel">
				<div class="panel">
					<div class="panel-header">
						<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
							<circle cx="8" cy="8" r="6" stroke="#e6a817" stroke-width="1.2"/>
							<path d="M8 5v4l2.5 1.5" stroke="#e6a817" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
						<span>Waiting for peer</span>
					</div>
					<div class="panel-body">
						<p class="hint">Share this code with the other person:</p>
						<div class="code-display">
							<span class="code-text">{roomCode}</span>
							<button class="bw icon-sq" onclick={copyCode} title="Copy code">
								<svg class="copy-icon" width="11" height="11" viewBox="0 0 11 11"><path d="M7 .5H3.5A1.5 1.5 0 002 2v6M4.5 3H9a1.5 1.5 0 011.5 1.5v4.5A1.5 1.5 0 019 10.5H4.5A1.5 1.5 0 013 9V4.5A1.5 1.5 0 014.5 3z" stroke="currentColor" fill="none" stroke-width=".9"/></svg>
							</button>
						</div>
						<div class="spinner-row">
							<div class="spinner"></div>
							<span>Waiting...</span>
						</div>
					</div>
				</div>
			</div>

		{:else if state === 'connecting'}
			<div class="center-panel">
				<div class="panel">
					<div class="panel-header">
						<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
							<circle cx="8" cy="8" r="6" stroke="#e6a817" stroke-width="1.2"/>
						</svg>
						<span>Establishing P2P connection...</span>
					</div>
					<div class="panel-body">
						<div class="spinner-row">
							<div class="spinner"></div>
							<span>Connecting directly to peer...</span>
						</div>
					</div>
				</div>
			</div>

		{:else if state === 'connected'}
			<div class="connected-layout">
				<!-- Status bar -->
				<div class="status-bar">
					<div class="status-dot connected"></div>
					<span>Connected to peer{relayMode ? ' (relayed)' : ' (P2P)'}</span>
					<span class="status-code">Room: {roomCode || joinInput.toUpperCase()}</span>
				</div>

				<!-- Drop zone -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="drop-zone"
					class:dragging={isDragging}
					ondrop={onDrop}
					ondragover={onDragOver}
					ondragleave={() => isDragging = false}
				>
					<svg width="36" height="36" viewBox="0 0 24 24" fill="none">
						<path d="M12 3v12M8 11l4 4 4-4" stroke="#555" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
						<path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="#555" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
					<p class="drop-text-desktop">Drop files here or click to select</p>
					<p class="drop-text-mobile">Tap to select files</p>
					<input
						type="file"
						multiple
						class="file-input"
						onchange={(e) => handleFiles((e.target as HTMLInputElement).files)}
					/>
				</div>

				<!-- Send queue -->
				{#if sendQueue}
					{@const overallPct = sendQueue.totalBytes > 0 ? Math.round((sendQueue.totalSent / sendQueue.totalBytes) * 100) : 0}
					{@const allDone = sendQueue.items.every(i => i.status === 'done')}
					<div class="queue-wrap">
						<div class="queue-header">
							<svg width="11" height="11" viewBox="0 0 11 11"><path d="M5.5 1v6M3 5l2.5 2.5L8 5" stroke="#4b76c2" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
							{#if allDone}
								<span class="transfer-done">Sent {sendQueue.items.length} file{sendQueue.items.length > 1 ? 's' : ''}</span>
							{:else}
								<span>Sending {sendQueue.items.length} file{sendQueue.items.length > 1 ? 's' : ''}</span>
							{/if}
							<span class="progress-stats">
								{formatSize(sendQueue.totalSent)} / {formatSize(sendQueue.totalBytes)} · {overallPct}%{#if sendSpeed > 0 && !allDone} · {formatSpeed(sendSpeed)}{/if}
							</span>
						</div>
						<div class="progress-track">
							<div class="progress-fill" class:done={allDone} style="width: {overallPct}%"></div>
						</div>
						{#if sendQueue.items.length > 1}
							<div class="queue-items">
								{#each sendQueue.items as item}
									<div class="queue-item" class:active={item.status === 'sending'} class:done={item.status === 'done'}>
										<span class="queue-icon">
											{#if item.status === 'done'}
												<svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 8l3 3 5-6" stroke="#27ae60" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
											{:else if item.status === 'sending'}
												<svg width="10" height="10" viewBox="0 0 11 11"><path d="M5.5 1v6M3 5l2.5 2.5L8 5" stroke="#4b76c2" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
											{:else}
												<span class="queue-dot"></span>
											{/if}
										</span>
										<span class="file-name">{item.name}</span>
										<span class="file-size">
											{#if item.status === 'sending'}
												{formatSize(item.sent)} / {formatSize(item.size)}
											{:else}
												{formatSize(item.size)}
											{/if}
										</span>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				<!-- Receive progress -->
				{#if recvProgress}
					{@const pct = Math.round((recvProgress.received / recvProgress.total) * 100)}
					<div class="progress-bar-wrap">
						<div class="progress-label">
							<svg width="11" height="11" viewBox="0 0 11 11"><path d="M5.5 10V4M3 6l2.5-2.5L8 6" stroke="#27ae60" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
							{#if recvProgress.done}
								<span class="transfer-done">Received: {recvProgress.fileName}</span>
							{:else}
								Receiving: {recvProgress.fileName}
							{/if}
							<span class="progress-stats">
								{formatSize(recvProgress.received)} / {formatSize(recvProgress.total)} · {pct}%{#if recvSpeed > 0 && !recvProgress.done} · {formatSpeed(recvSpeed)}{/if}
							</span>
						</div>
						<div class="progress-track">
							<div class="progress-fill recv" class:done={recvProgress.done} style="width: {pct}%"></div>
						</div>
					</div>
				{/if}

				<!-- Received files -->
				{#if receivedFiles.length > 0}
					<div class="file-list">
						<div class="file-list-header">
							<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
								<path d="M2 4.5h5l1.5-2H14v10H2z" stroke="#5a9fd4" stroke-width="1.1" fill="#5a9fd4" fill-opacity="0.1"/>
							</svg>
							<span>Received Files</span>
							<span class="file-count">{receivedFiles.length}</span>
						</div>
						{#each receivedFiles as file, idx}
							{#if file.blob === null && !file.url}
								<div class="file-item no-link saved">
									<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
										<path d="M4 8l3 3 5-6" stroke="#27ae60" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
									</svg>
									<span class="file-name">{file.name}</span>
									<span class="file-size saved-label">Saved to disk</span>
								</div>
							{:else}
								<div class="file-item-row">
									<a href={file.url} download={file.name} class="file-item">
										<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
											<rect x="3" y="1.5" width="10" height="13" rx="1.5" stroke="#888" stroke-width="1"/>
											<path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="#666" stroke-width="0.8" stroke-linecap="round"/>
										</svg>
										<span class="file-name">{file.name}</span>
										<span class="file-size">{formatSize(file.size)}</span>
									</a>
									{#if canSaveToDisk}
										<button class="save-btn" onclick={() => saveToDisk(idx)} title="Save to disk">
											<svg width="11" height="11" viewBox="0 0 16 16" fill="none">
												<path d="M3 14h10M8 2v9M5 8l3 3 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
											</svg>
										</button>
									{/if}
								</div>
							{/if}
						{/each}
					</div>
				{/if}
			</div>

		{:else if state === 'disconnected'}
			<div class="center-panel">
				<div class="panel">
					<div class="panel-header">
						<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
							<circle cx="8" cy="8" r="6" stroke="#c25050" stroke-width="1.2"/>
							<path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#c25050" stroke-width="1.2" stroke-linecap="round"/>
						</svg>
						<span>Disconnected</span>
					</div>
					<div class="panel-body">
						<p class="hint">Peer has disconnected.</p>
						<button class="bw btn-full" onclick={disconnect}>New Session</button>

						{#if receivedFiles.length > 0}
							<div class="file-list" style="margin-top: 12px;">
								<div class="file-list-header">
									<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
										<path d="M2 4.5h5l1.5-2H14v10H2z" stroke="#5a9fd4" stroke-width="1.1" fill="#5a9fd4" fill-opacity="0.1"/>
									</svg>
									<span>Received Files</span>
								</div>
								{#each receivedFiles as file, idx}
									{#if file.blob === null && !file.url}
										<div class="file-item no-link saved">
											<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
												<path d="M4 8l3 3 5-6" stroke="#27ae60" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
											</svg>
											<span class="file-name">{file.name}</span>
											<span class="file-size saved-label">Saved to disk</span>
										</div>
									{:else}
										<div class="file-item-row">
											<a href={file.url} download={file.name} class="file-item">
												<span class="file-name">{file.name}</span>
												<span class="file-size">{formatSize(file.size)}</span>
											</a>
											{#if canSaveToDisk}
												<button class="save-btn" onclick={() => saveToDisk(idx)} title="Save to disk">
													<svg width="11" height="11" viewBox="0 0 16 16" fill="none">
														<path d="M3 14h10M8 2v9M5 8l3 3 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
													</svg>
												</button>
											{/if}
										</div>
									{/if}
								{/each}
							</div>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	/* === Blender-style globals === */
	:global(*) {
		margin: 0;
		padding: 0;
		box-sizing: border-box;
	}
	:global(body) {
		background: #232323;
		color: #e6e6e6;
		font-family: 'Inter', sans-serif;
		font-size: 11px;
		line-height: 1.35;
		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
	}
	:global(::selection) {
		background: #4772b3;
		color: #fff;
	}
	:global(::-webkit-scrollbar) { width: 6px; height: 6px; }
	:global(::-webkit-scrollbar-track) { background: transparent; }
	:global(::-webkit-scrollbar-thumb) { background: #555; border-radius: 3px; }
	:global(::-webkit-scrollbar-thumb:hover) { background: #666; }

	/* === Blender button === */
	.bw {
		font-family: 'Inter', sans-serif;
		font-size: 11px;
		background: #545454;
		border: none;
		border-radius: 6px;
		color: #e6e6e6;
		cursor: pointer;
		outline: none;
		box-shadow: 0 1px 0 0 #2a2a2a, inset 0 1px 0 0 #666;
		transition: background 0.08s;
		padding: 5px 12px;
	}
	.bw:hover { background: #606060; }
	.bw:active {
		background: #4a4a4a;
		box-shadow: 0 1px 0 0 #2a2a2a, inset 0 1px 2px 0 #333;
	}

	/* === Layout === */
	.app {
		height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.header {
		height: 30px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 10px;
		background: #303030;
		border-bottom: 1px solid #1a1a1a;
		flex-shrink: 0;
	}
	.header-left {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.header-title {
		font-weight: 600;
		font-size: 11.5px;
		color: #e6e6e6;
	}
	.header-sep { color: #444; }
	.header-sub { color: #888; font-size: 10.5px; }
	.header-right { display: flex; gap: 6px; }

	.btn-sm { padding: 3px 10px; font-size: 10.5px; }

	.gh-link {
		display: flex;
		align-items: center;
		color: #888;
		transition: color 0.15s;
	}
	.gh-link:hover { color: #e6e6e6; }

	.main {
		flex: 1;
		display: flex;
		overflow: auto;
	}

	/* === Center panel (idle/waiting/connecting) === */
	.center-panel {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.panel {
		width: 340px;
		background: #303030;
		border-radius: 8px;
		border: 1px solid #1a1a1a;
		overflow: hidden;
	}
	.panel-header {
		height: 28px;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px;
		background: #383838;
		border-bottom: 1px solid #1a1a1a;
		font-weight: 500;
		font-size: 11px;
		color: #ccc;
	}
	.panel-body {
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.hint {
		color: #999;
		font-size: 11px;
		line-height: 1.5;
	}

	.btn-full { width: 100%; padding: 7px 12px; }

	.divider {
		display: flex;
		align-items: center;
		gap: 10px;
		color: #555;
		font-size: 10px;
	}
	.divider::before, .divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: #3a3a3a;
	}

	.join-row {
		display: flex;
		gap: 6px;
	}

	.input {
		flex: 1;
		font-family: 'Inter', sans-serif;
		font-size: 13px;
		font-weight: 500;
		letter-spacing: 2px;
		text-transform: uppercase;
		text-align: center;
		background: #1e1e1e;
		border: 1px solid #3a3a3a;
		border-radius: 6px;
		color: #e6e6e6;
		padding: 6px 10px;
		outline: none;
		transition: border-color 0.15s;
	}
	.input:focus {
		border-color: #4b76c2;
	}
	.input::placeholder {
		color: #555;
		letter-spacing: 0;
		font-size: 11px;
		text-transform: none;
	}

	.error-msg {
		color: #c25050;
		font-size: 10.5px;
		padding: 4px 8px;
		background: #c2505015;
		border-radius: 4px;
	}

	/* === Code display === */
	.code-display {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 10px;
		background: #1e1e1e;
		border-radius: 6px;
		border: 1px solid #3a3a3a;
	}
	.code-text {
		font-size: 22px;
		font-weight: 600;
		letter-spacing: 6px;
		color: #4b76c2;
		font-family: 'Inter', monospace;
	}
	.icon-sq {
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}

	/* === Spinner === */
	.spinner-row {
		display: flex;
		align-items: center;
		gap: 8px;
		color: #888;
		font-size: 10.5px;
		justify-content: center;
	}
	.spinner {
		width: 12px;
		height: 12px;
		border: 2px solid #444;
		border-top-color: #4b76c2;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	/* === Connected layout === */
	.connected-layout {
		flex: 1;
		display: flex;
		flex-direction: column;
		padding: 0;
		overflow-y: auto;
		min-height: 0;
	}

	.status-bar {
		height: 26px;
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 0 12px;
		background: #2a2a2a;
		border-bottom: 1px solid #1a1a1a;
		font-size: 10.5px;
		color: #999;
	}
	.status-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #555;
	}
	.status-dot.connected {
		background: #27ae60;
		box-shadow: 0 0 4px #27ae6066;
	}
	.status-code {
		margin-left: auto;
		color: #666;
		font-size: 10px;
	}

	/* === Drop zone === */
	.drop-zone {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		border: 2px dashed #3a3a3a;
		margin: 16px;
		border-radius: 8px;
		color: #555;
		font-size: 12px;
		transition: border-color 0.15s, background 0.15s;
		position: relative;
		cursor: pointer;
		min-height: 200px;
	}
	.drop-zone:hover, .drop-zone.dragging {
		border-color: #4b76c2;
		background: #4b76c208;
	}
	.drop-zone.dragging {
		background: #4b76c215;
	}
	.file-input {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}
	.drop-text-mobile {
		display: none;
	}

	/* === Progress & Queue === */
	.progress-bar-wrap, .queue-wrap {
		padding: 10px 14px;
		margin: 0 16px 8px;
		background: #2a2a2a;
		border-radius: 8px;
		border: 1px solid #1a1a1a;
	}
	.progress-label, .queue-header {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 10.5px;
		color: #aaa;
		margin-bottom: 6px;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.progress-stats {
		margin-left: auto;
		color: #777;
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}
	.transfer-done {
		color: #27ae60;
	}
	.progress-track {
		height: 6px;
		background: #1e1e1e;
		border-radius: 3px;
		overflow: hidden;
	}
	.progress-fill {
		height: 100%;
		background: #4b76c2;
		border-radius: 3px;
		transition: width 0.15s;
	}
	.progress-fill.recv {
		background: #27ae60;
	}
	.progress-fill.done {
		background: #27ae60;
	}
	.queue-items {
		margin-top: 8px;
		max-height: 180px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.queue-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 0;
		font-size: 10.5px;
		color: #777;
	}
	.queue-item.active { color: #ccc; }
	.queue-item.done { color: #888; }
	.queue-icon {
		width: 14px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.queue-dot {
		width: 4px;
		height: 4px;
		background: #555;
		border-radius: 50%;
	}

	/* === File list === */
	.file-list {
		margin: 0 16px 16px;
		background: #2a2a2a;
		border-radius: 6px;
		border: 1px solid #1a1a1a;
		overflow: hidden;
	}
	.file-list-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		background: #333;
		border-bottom: 1px solid #1a1a1a;
		font-size: 10.5px;
		font-weight: 500;
		color: #bbb;
	}
	.file-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid #222;
		text-decoration: none;
		color: #ccc;
		transition: background 0.08s;
	}
	.file-item:last-child { border-bottom: none; }
	.file-item:hover { background: #353535; }
	.file-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
	}
	.file-size {
		color: #666;
		font-size: 10px;
		flex-shrink: 0;
	}
	.file-count {
		margin-left: auto;
		background: #444;
		color: #aaa;
		font-size: 9px;
		padding: 1px 6px;
		border-radius: 8px;
	}
	.file-item.no-link {
		cursor: default;
	}
	.file-item.no-link:hover {
		background: transparent;
	}
	.file-item-row {
		display: flex;
		align-items: center;
		border-bottom: 1px solid #222;
	}
	.file-item-row:last-child { border-bottom: none; }
	.file-item-row .file-item {
		flex: 1;
		border-bottom: none;
	}
	.save-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		margin-right: 6px;
		background: #3a3a3a;
		border: none;
		border-radius: 5px;
		color: #999;
		cursor: pointer;
		transition: background 0.08s, color 0.08s;
		flex-shrink: 0;
	}
	.save-btn:hover { background: #4b76c2; color: #fff; }
	.file-item.saved {
		color: #999;
	}
	.saved-label {
		color: #27ae60;
		font-size: 10px;
	}

	/* === Mobile === */
	@media (max-width: 480px) {
		:global(body) {
			font-size: 14px;
		}
		.app {
			padding-top: env(safe-area-inset-top);
			padding-bottom: env(safe-area-inset-bottom);
		}
		.header {
			height: 48px;
			padding: 0 16px;
		}
		.header-title { font-size: 15px; }
		.header-sub { font-size: 12px; }
		.btn-sm { padding: 8px 14px; font-size: 13px; }

		.center-panel {
			align-items: flex-start;
			padding: 16px;
		}
		.panel {
			width: 100%;
		}
		.panel-header {
			height: 40px;
			font-size: 14px;
			padding: 0 14px;
		}
		.panel-body {
			padding: 20px 16px;
			gap: 16px;
		}
		.hint { font-size: 14px; }

		.bw {
			font-size: 15px;
			padding: 12px 16px;
			border-radius: 10px;
		}
		.btn-full { padding: 14px 16px; }

		.input {
			font-size: 16px;
			padding: 12px 14px;
			border-radius: 10px;
		}
		.input::placeholder { font-size: 14px; }

		.divider { font-size: 12px; }

		.code-display { padding: 16px; border-radius: 10px; }
		.code-text { font-size: 28px; letter-spacing: 8px; }
		.icon-sq { width: 40px; height: 40px; border-radius: 10px; }
		.copy-icon { width: 18px; height: 18px; }

		.spinner-row { font-size: 14px; gap: 10px; }
		.spinner { width: 18px; height: 18px; }

		.error-msg { font-size: 13px; padding: 10px 12px; border-radius: 8px; }

		.status-bar {
			height: 40px;
			font-size: 13px;
			padding: 0 16px;
		}
		.status-dot { width: 9px; height: 9px; }
		.status-code { font-size: 12px; }

		.drop-zone {
			margin: 12px;
			min-height: 160px;
			font-size: 15px;
			gap: 12px;
			border-radius: 12px;
			border-width: 2px;
		}
		.drop-text-desktop { display: none; }
		.drop-text-mobile { display: block; }

		.progress-bar-wrap, .queue-wrap {
			padding: 12px;
			margin: 0 12px 8px;
			border-radius: 10px;
		}
		.progress-label, .queue-header {
			font-size: 13px;
			gap: 6px;
			flex-wrap: wrap;
			white-space: normal;
		}
		.progress-stats { font-size: 11px; }
		.progress-track { height: 8px; border-radius: 4px; }
		.queue-items { max-height: 200px; }
		.queue-item { padding: 8px 0; font-size: 13px; }

		.file-list { margin: 0 12px 12px; border-radius: 10px; }
		.file-list-header { font-size: 13px; padding: 12px 14px; }
		.file-count { font-size: 10px; padding: 2px 7px; }
		.file-item { padding: 14px; gap: 10px; }
		.save-btn { width: 36px; height: 36px; margin-right: 10px; border-radius: 8px; }
		.file-name { font-size: 14px; }
		.file-size { font-size: 12px; }
	}
</style>
