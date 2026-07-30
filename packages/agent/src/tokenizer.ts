function estimateTokens(text: string) {
	return (Buffer.byteLength(text, "utf-8") + 3) >> 2;
}

export function countTokens(text: string | string[]): number {
	if (Array.isArray(text)) {
		return text.reduce((sum, t) => sum + estimateTokens(t), 0);
	} else {
		return estimateTokens(text);
	}
}

export function countTokensConservatively(text: string | string[]): number {
	if (Array.isArray(text)) {
		return text.reduce((sum, value) => sum + Buffer.byteLength(value, "utf-8"), 0);
	} else {
		return Buffer.byteLength(text, "utf-8");
	}
}
