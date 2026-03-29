/** File System Access API utilities for streaming large files to disk */

export function isStreamSaveSupported(): boolean {
	return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

export async function createFileWriter(
	fileName: string,
	mimeType?: string
): Promise<FileSystemWritableFileStream | null> {
	if (!isStreamSaveSupported()) return null;
	try {
		const handle = await (window as any).showSaveFilePicker({
			suggestedName: fileName,
			types: [
				{
					description: fileName,
					accept: { [mimeType || 'application/octet-stream']: [] }
				}
			]
		});
		return await handle.createWritable();
	} catch {
		// User cancelled the picker or API error
		return null;
	}
}
