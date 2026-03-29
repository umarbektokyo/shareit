export class SpeedTracker {
	private samples: { time: number; bytes: number }[] = [];
	private windowMs = 2000;

	update(received: number): number {
		const now = performance.now();
		this.samples.push({ time: now, bytes: received });
		const cutoff = now - this.windowMs;
		this.samples = this.samples.filter((s) => s.time >= cutoff);
		if (this.samples.length < 2) return 0;
		const first = this.samples[0];
		const last = this.samples[this.samples.length - 1];
		const dt = (last.time - first.time) / 1000;
		if (dt === 0) return 0;
		return (last.bytes - first.bytes) / dt;
	}

	reset() {
		this.samples = [];
	}
}
