<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<!-- Favicon -->
	<link rel="icon" type="image/svg+xml" href="/favicon.svg" />

	<!-- SEO -->
	<meta name="description" content="Send files directly between browsers with no server storage. Create a room, share the code, and transfer files peer-to-peer via WebRTC." />
	<meta name="keywords" content="file transfer, P2P, peer-to-peer, WebRTC, share files, browser, no upload, direct transfer, end-to-end, private" />
	<meta name="author" content="umarbektokyo" />
	<meta name="robots" content="index, follow" />
	<meta name="theme-color" content="#232323" />

	<!-- Open Graph -->
	<meta property="og:title" content="ShareIt — P2P File Transfer" />
	<meta property="og:description" content="Send files directly between browsers with no server storage. Create a room, share the code, and transfer files peer-to-peer via WebRTC." />
	<meta property="og:type" content="website" />
	<meta property="og:url" content="https://github.com/umarbektokyo/shareit" />
	<meta property="og:image" content="https://shareit.umarbek.dev/og.png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content="ShareIt — Peer-to-peer file transfer in the browser" />
	<meta property="og:site_name" content="ShareIt" />

	<!-- Twitter Card -->
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content="ShareIt — P2P File Transfer" />
	<meta name="twitter:description" content="Send files directly between browsers. No server storage, no accounts — just a room code and WebRTC." />
	<meta name="twitter:image" content="https://shareit.umarbek.dev/og.png" />
	<meta name="twitter:image:alt" content="ShareIt — Peer-to-peer file transfer in the browser" />
</svelte:head>

{@render children()}
