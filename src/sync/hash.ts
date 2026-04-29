// Web Crypto, not node:crypto. Obsidian's iOS/Android targets are Capacitor
// WebViews where node:crypto is not exposed; subtle.digest is universally
// available across desktop electron + mobile webview.

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return bufferToHex(buf);
}

function bufferToHex(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	const out = new Array<string>(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		out[i] = bytes[i]!.toString(16).padStart(2, "0");
	}
	return out.join("");
}
