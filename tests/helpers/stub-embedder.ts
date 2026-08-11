/**
 * A local embedding service, in about thirty lines.
 *
 * The tests that matter most around vectors - the automatic repair, the
 * workspace-wide rebuild - only exist because a real embedder makes writes and
 * lookups fail in ways nothing else does. Those tests cannot depend on Ollama
 * running: a machine without it, or a CI runner, would either skip them (so the
 * paths go untested exactly where they are hardest to reason about) or fail the
 * build over a missing service.
 *
 * So the service is provided. It speaks the OpenAI embeddings shape, which is
 * what plugmem's host sends, and returns a deterministic vector derived from the
 * text - deterministic because a random one would make "the same sentence has
 * the same meaning" false, and several tests rest on exactly that.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubEmbedder {
	url: string;
	dim: number;
	/** How many texts have been embedded since it started. */
	embedded(): number;
	close(): Promise<void>;
}

/**
 * A vector whose direction depends only on the text.
 *
 * Text with no words gets a fixed unit vector rather than the zero vector the
 * arithmetic would otherwise produce. That case is real, not hypothetical:
 * `reembed()` on a database with nothing in it sends one request whose input is
 * the empty string, and the engine then rejects a zero vector in reply with
 * "invalid input: vector must be nonzero". Measured against plugmem 0.9.0.
 */
function vectorFor(text: string, dim: number): number[] {
	const vector = new Array<number>(dim).fill(0);
	const words = text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word !== "");
	if (words.length === 0)
		return vector.map((_, index) => (index === 0 ? 1 : 0));
	for (const word of words) {
		let hash = 0;
		for (const character of word) {
			hash = (hash * 31 + character.charCodeAt(0)) % 2147483647;
		}
		vector[hash % dim] = (vector[hash % dim] ?? 0) + 1;
	}
	const length = Math.hypot(...vector) || 1;
	return vector.map((value) => value / length);
}

export async function startStubEmbedder(dim = 32): Promise<StubEmbedder> {
	let count = 0;
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const parsed =
				body === "" ? {} : (JSON.parse(body) as { input?: unknown });
			const inputs = Array.isArray(parsed.input)
				? parsed.input.map(String)
				: [String(parsed.input ?? "")];
			count += inputs.length;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					object: "list",
					data: inputs.map((text, index) => ({
						object: "embedding",
						index,
						embedding: vectorFor(text, dim),
					})),
				}),
			);
		});
	});
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/v1/embeddings`,
		dim,
		embedded: () => count,
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections();
				server.close(() => done());
			}),
	};
}
