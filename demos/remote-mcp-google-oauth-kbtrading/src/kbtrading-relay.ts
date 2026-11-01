import { isAllowedEmail, normalizeEmail } from "./access";
import {
	blockedMethodResult,
	blockedToolCallResult,
	createSseToolsListFilter,
	filterToolsListPayload,
	type InspectedPayload,
	inspectJsonRpcPayload,
} from "./mcp-policy";
import { type Props, readBody } from "./utils";

/**
 * Relay from this Worker's `/mcp` to the KB Trading Odoo MCP server, over the MCP Streamable
 * HTTP transport. The OAuth provider calls it only with a valid access token issued for
 * this Worker's resource; the relay adds the shared secret that the KB Trading Nginx expects.
 *
 * Streamable HTTP is plain HTTP (POST for client messages, GET for the server's event
 * stream, DELETE to end a session, `Mcp-Session-Id` to name the session), so it can be
 * relayed without terminating the protocol here. Sessions stay on the KB Trading server.
 */

// The only destinations the relay may reach. KBTRADING_MCP_URL must be exactly one of them,
// so a configuration mistake fails closed instead of sending the KB Trading secret anywhere
// else (the AMAT server included). The path with a trailing slash is the one
// mcp-server-odoo documents.
export const ALLOWED_UPSTREAM_URLS: ReadonlySet<string> = new Set([
	"https://mcp-kbtrading.nasta-univers.com/mcp",
	"https://mcp-kbtrading.nasta-univers.com/mcp/",
]);

export type RelayLimits = {
	maxRequestBytes: number;
	maxResponseBytes: number;
	/** POST and DELETE: until the upstream response has been fully relayed. */
	requestTimeoutMs: number;
	/** GET: how long the server's event stream is relayed before it is closed. */
	streamTimeoutMs: number;
};

export const DEFAULT_LIMITS: RelayLimits = {
	maxRequestBytes: 1024 * 1024,
	maxResponseBytes: 10 * 1024 * 1024,
	requestTimeoutMs: 120_000,
	streamTimeoutMs: 300_000,
};

const ALLOWED_HTTP_METHODS = "GET, POST, DELETE";

// Client headers forwarded upstream, besides the MCP ones (`Mcp-Session-Id`,
// `MCP-Protocol-Version`, ...). Authorization, Cookie and everything else stay here.
const FORWARDED_REQUEST_HEADERS = new Set(["accept", "content-type", "last-event-id"]);
// Responses always carry `Cache-Control: no-store`, whatever KB Trading sends.
const FORWARDED_RESPONSE_HEADERS = new Set(["content-type"]);

// Upstream errors the MCP client has to see as they are: 404 means the session expired and
// must be re-initialized, 405 that the server offers no standalone event stream.
const PASSTHROUGH_ERROR_STATUSES = new Set([400, 404, 405, 406, 409, 413, 415, 422, 429]);

function isForwardedHeader(name: string, allowed: Set<string>): boolean {
	const lower = name.toLowerCase();
	return allowed.has(lower) || lower.startsWith("mcp-");
}

function rpcError(
	status: number,
	code: number,
	message: string,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
		status,
		headers: { "Cache-Control": "no-store", "Content-Type": "application/json", ...headers },
	});
}

function resolveUpstreamUrl(configured: unknown): string | null {
	if (typeof configured !== "string") return null;
	const url = configured.trim();
	return ALLOWED_UPSTREAM_URLS.has(url) ? url : null;
}

// Longer than any token Nginx would compare against: a secret this long was pasted wrong.
const MAX_ACCESS_TOKEN_LENGTH = 512;

/**
 * Why the KBTRADING_ACCESS_TOKEN secret cannot be sent, or null when it can. The secret holds
 * the token alone, in printable ASCII: whitespace (an already prefixed "Bearer …", a pasted
 * line break) or any other character (an invisible one copied along) would make the request
 * invalid before it reaches Nginx. Never includes the value itself.
 */
function accessTokenIssue(secret: unknown): string | null {
	if (typeof secret !== "string" || secret.trim().length === 0) return "missing";
	const token = secret.trim();
	if (/\s/.test(token)) return "contains_whitespace";
	if (!/^[\x21-\x7e]+$/.test(token)) return "non_printable_ascii";
	if (token.length > MAX_ACCESS_TOKEN_LENGTH) return "too_long";
	return null;
}

/** The X-Access-Token value the KB Trading Nginx expects: `Bearer <token>`. */
function accessTokenHeader(secret: unknown): string | null {
	return accessTokenIssue(secret) === null ? `Bearer ${(secret as string).trim()}` : null;
}

/** Ends the response, and cancels the KB Trading response, once it exceeds `maxBytes`. */
function createByteLimit(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
	let total = 0;
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			total += chunk.byteLength;
			if (total > maxBytes) {
				console.error("relay_response_too_large", { maxBytes });
				controller.terminate();
				return;
			}
			controller.enqueue(chunk);
		},
	});
}

/**
 * `source` through `transform`. When `source` fails (a timeout, a lost connection) the
 * stream is closed for the client rather than errored: an MCP client treats a closed event
 * stream as a disconnect and resumes it with Last-Event-ID. When the client goes away or
 * `transform` ends early, `source` is cancelled so KB Trading stops sending.
 *
 * A manual pump rather than pipeTo(), which in workerd leaves a promise rejection unhandled
 * whenever its source fails.
 */
function pipe(
	source: ReadableStream<Uint8Array>,
	transform: TransformStream<Uint8Array, Uint8Array>,
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	const writer = transform.writable.getWriter();
	reader.closed.catch(() => {});
	writer.closed.catch(() => {});
	void (async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				await writer.write(value);
			}
			await writer.close();
		} catch (error) {
			console.warn("relay_stream_interrupted", {
				reason: error instanceof Error ? error.name : "unknown",
			});
			reader.cancel().catch(() => {});
			writer.close().catch(() => {});
		}
	})();
	return transform.readable;
}

/** Answers a single blocked request itself; a batch holding one is refused as a whole. */
function blockedResponse(inspected: InspectedPayload): Response {
	const [blocked] = inspected.blocked;
	const { id } = blocked;
	if (!inspected.isBatch && (typeof id === "string" || typeof id === "number")) {
		const result =
			blocked.kind === "tool"
				? blockedToolCallResult(id, blocked.name)
				: blockedMethodResult(id);
		return new Response(JSON.stringify(result), {
			headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
		});
	}
	return rpcError(400, -32600, "This read-only connector does not forward this request");
}

export function createKbTradingRelay(limits: RelayLimits = DEFAULT_LIMITS) {
	return {
		async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
			// Defense in depth: tokens are only issued to allowed accounts, and checking again
			// here revokes a removed account on the next deploy instead of at token expiry.
			const props = (ctx as ExecutionContext & { props?: Partial<Props> }).props;
			const email = typeof props?.email === "string" ? normalizeEmail(props.email) : "";
			if (!isAllowedEmail(email)) {
				console.warn("relay_denied", { reason: "email_not_allowed", email });
				return rpcError(403, -32001, "This account is not allowed to use this MCP server");
			}

			if (new URL(request.url).pathname !== "/mcp") {
				return rpcError(404, -32601, "Not found");
			}
			if (
				request.method !== "GET" &&
				request.method !== "POST" &&
				request.method !== "DELETE"
			) {
				return rpcError(405, -32601, "Method not allowed", { Allow: ALLOWED_HTTP_METHODS });
			}

			const upstreamUrl = resolveUpstreamUrl(env.KBTRADING_MCP_URL);
			const accessToken = accessTokenHeader(env.KBTRADING_ACCESS_TOKEN);
			if (!upstreamUrl || !accessToken) {
				console.error("relay_misconfigured", {
					kbtradingAccessTokenIssue: accessTokenIssue(env.KBTRADING_ACCESS_TOKEN),
					kbtradingAccessTokenValid: accessToken !== null,
					kbtradingMcpUrlAllowed: upstreamUrl !== null,
				});
				return rpcError(500, -32603, "The MCP relay is not configured");
			}

			let body: string | undefined;
			let inspected: InspectedPayload | undefined;
			if (request.method === "POST") {
				const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
				if (!/^application\/json\s*(;|$)/.test(contentType)) {
					return rpcError(415, -32000, "Content-Type must be application/json");
				}
				const read = await readBody(request, limits.maxRequestBytes);
				if ("error" in read) {
					return read.error === "too_large"
						? rpcError(413, -32000, "Request body too large")
						: rpcError(400, -32700, "Parse error");
				}
				inspected = inspectJsonRpcPayload(read.text) ?? undefined;
				if (!inspected) return rpcError(400, -32700, "Parse error");
				if (inspected.blocked.length > 0) {
					console.warn("relay_blocked", {
						blocked: inspected.blocked.map(({ kind, name }) => `${kind}:${name}`),
						email,
					});
					return blockedResponse(inspected);
				}
				body = inspected.body;
			}

			const headers = new Headers();
			for (const [name, value] of request.headers) {
				if (isForwardedHeader(name, FORWARDED_REQUEST_HEADERS)) headers.set(name, value);
			}
			headers.set("X-Access-Token", accessToken);

			let upstream: Response;
			try {
				upstream = await fetch(upstreamUrl, {
					body,
					headers,
					method: request.method,
					// Never follow a redirect: it would carry X-Access-Token to another URL.
					redirect: "manual",
					signal: AbortSignal.timeout(
						request.method === "GET" ? limits.streamTimeoutMs : limits.requestTimeoutMs,
					),
				});
			} catch (error) {
				const reason = error instanceof Error ? error.name : "unknown";
				console.error("relay_upstream_unreachable", { reason });
				return reason === "TimeoutError"
					? rpcError(504, -32000, "The KB Trading MCP server did not answer in time")
					: rpcError(502, -32000, "The KB Trading MCP server is unreachable");
			}

			const { status } = upstream;
			const passthrough = status < 300 || PASSTHROUGH_ERROR_STATUSES.has(status);
			const declaredLength = Number(upstream.headers.get("content-length"));
			const tooLarge =
				Number.isFinite(declaredLength) && declaredLength > limits.maxResponseBytes;
			if (!passthrough || tooLarge) {
				await upstream.body?.cancel();
				// 401/403 mean the shared secret was refused. They must not reach the MCP client,
				// which would take them as a problem with its own OAuth token.
				const reason = tooLarge
					? "response_too_large"
					: status >= 300 && status < 400
						? "redirect_refused"
						: status === 401 || status === 403
							? "shared_secret_refused"
							: "upstream_error";
				console.error("relay_upstream_failed", { reason, status });
				return rpcError(502, -32000, "The KB Trading MCP server returned an error");
			}

			const responseHeaders = new Headers({ "Cache-Control": "no-store" });
			for (const [name, value] of upstream.headers) {
				if (isForwardedHeader(name, FORWARDED_RESPONSE_HEADERS))
					responseHeaders.set(name, value);
			}

			console.log("relay_request", {
				email,
				httpMethod: request.method,
				rpcMethods: inspected?.methods ?? [],
				tools: inspected?.tools ?? [],
				status,
			});

			if (!upstream.body || status === 204 || status === 205) {
				return new Response(null, { status, headers: responseHeaders });
			}

			let responseBody = pipe(upstream.body, createByteLimit(limits.maxResponseBytes));

			// A 4xx the MCP server sends itself (bad request, expired session, ...) reaches the
			// client unchanged; its message is also logged, so the cause shows up in the Worker
			// logs. These are protocol errors from the server, not Odoo data or credentials.
			if (status >= 400) {
				const text = await new Response(responseBody).text();
				console.warn("relay_upstream_rejected", {
					detail: text.replace(/\s+/g, " ").slice(0, 300),
					email,
					// Who answered (Nginx, Cloudflare, the MCP server) and what was sent: header
					// names only, never their values.
					forwardedHeaders: [...headers.keys()],
					responseContentLength: upstream.headers.get("content-length"),
					responseContentType: upstream.headers.get("content-type"),
					responseServer: upstream.headers.get("server"),
					rpcMethods: inspected?.methods ?? [],
					status,
				});
				return new Response(text, { status, headers: responseHeaders });
			}

			const toolsListIds = inspected?.toolsListIds;
			if (toolsListIds && toolsListIds.size > 0) {
				const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
				if (contentType.startsWith("text/event-stream")) {
					responseBody = pipe(responseBody, createSseToolsListFilter(toolsListIds));
				} else if (contentType.startsWith("application/json")) {
					let text: string;
					try {
						text = await new Response(responseBody).text();
					} catch {
						return rpcError(
							502,
							-32000,
							"The KB Trading MCP server returned an invalid response",
						);
					}
					return new Response(filterToolsListPayload(text, toolsListIds) ?? text, {
						status,
						headers: responseHeaders,
					});
				}
			}
			return new Response(responseBody, { status, headers: responseHeaders });
		},
	};
}
