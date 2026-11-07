import { DurableObject } from "cloudflare:workers";

/**
 * Meral SMMM Pro - Accounting Office State Schema
 */
export interface MeralOfficeState {
	companies: unknown[];
	tasks: unknown[];
	documents: unknown[];
	notes: unknown[];
	chatMessages: unknown[];
	updatedAt: number | string;
	[key: string]: unknown; // Allow extensible fields from frontend without dropping data
}

/**
 * Default empty state if not initialized yet
 */
export const DEFAULT_OFFICE_STATE: MeralOfficeState = {
	companies: [],
	tasks: [],
	documents: [],
	notes: [],
	chatMessages: [],
	updatedAt: 0,
};

/**
 * WorkflowStatusDO - Production Durable Object for Meral SMMM Pro
 *
 * Responsibilities:
 * - Persist Meral's entire accounting office state under key "office_state"
 * - Provide HTTP endpoints (GET/PUT/POST /state) and RPC methods
 * - Manage real-time WebSocket synchronization across PC & Telegram Mobile devices
 * - Broadcast "state_synced" messages upon state changes
 */
export class WorkflowStatusDO extends DurableObject {
	private cachedState: MeralOfficeState | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		// Load state from durable storage
		ctx.blockConcurrencyWhile(async () => {
			this.cachedState =
				(await ctx.storage.get<MeralOfficeState>("office_state")) ?? null;
		});
	}

	/**
	 * HTTP fetch handler for Durable Object
	 * Handles WebSocket upgrades and direct /state HTTP requests
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname.replace(/\/+$/, ""); // normalize trailing slash

		// 1. WebSocket Upgrade for Real-Time Sync
		if (request.headers.get("Upgrade") === "websocket") {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			// Accept WebSocket connection using hibernation API
			this.ctx.acceptWebSocket(server);

			// Immediately send current state on connection
			const currentState =
				this.cachedState ??
				(await this.ctx.storage.get<MeralOfficeState>("office_state")) ??
				DEFAULT_OFFICE_STATE;

			server.send(
				JSON.stringify({
					type: "state_synced",
					data: currentState,
					timestamp: Date.now(),
				}),
			);

			return new Response(null, { status: 101, webSocket: client });
		}

		// 2. HTTP Routes: /state, /api/state, /sync, etc.
		if (
			pathname.endsWith("/state") ||
			pathname.endsWith("/sync") ||
			pathname.endsWith("/office_state") ||
			pathname === ""
		) {
			// GET /state
			if (request.method === "GET") {
				const state =
					this.cachedState ??
					(await this.ctx.storage.get<MeralOfficeState>("office_state")) ??
					null;
				return Response.json(state);
			}

			// PUT, POST, PATCH /state
			if (
				request.method === "PUT" ||
				request.method === "POST" ||
				request.method === "PATCH"
			) {
				try {
					const body = (await request.json()) as Partial<MeralOfficeState>;
					const validatedState = this.sanitizeState(body);

					await this.ctx.storage.put("office_state", validatedState);
					this.cachedState = validatedState;

					// Broadcast "state_synced" to all connected devices
					this.broadcast({
						type: "state_synced",
						data: validatedState,
						timestamp: Date.now(),
					});

					return Response.json(validatedState);
				} catch (err) {
					return Response.json(
						{
							error: "Invalid office state payload",
							details: err instanceof Error ? err.message : String(err),
						},
						{ status: 400 },
					);
				}
			}

			return new Response("Method Not Allowed", { status: 405 });
		}

		return new Response("Not Found", { status: 404 });
	}

	/**
	 * RPC Method: Get Office State
	 */
	async getState(): Promise<MeralOfficeState | null> {
		if (this.cachedState) return this.cachedState;
		this.cachedState =
			(await this.ctx.storage.get<MeralOfficeState>("office_state")) ?? null;
		return this.cachedState;
	}

	/**
	 * RPC Method: Put Office State
	 */
	async putState(
		body: Partial<MeralOfficeState>,
	): Promise<MeralOfficeState> {
		const validatedState = this.sanitizeState(body);
		await this.ctx.storage.put("office_state", validatedState);
		this.cachedState = validatedState;

		this.broadcast({
			type: "state_synced",
			data: validatedState,
			timestamp: Date.now(),
		});

		return validatedState;
	}

	/**
	 * RPC Method: Backward compatibility for workflow step tracking
	 */
	async updateStep(stepName: string, status: string): Promise<void> {
		await this.ctx.storage.put(`step_${stepName}`, status);
		this.broadcast({
			type: "step_updated",
			step: stepName,
			status,
			timestamp: Date.now(),
		});
	}

	/**
	 * WebSocket message handler (hibernation API)
	 */
	async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		try {
			if (typeof message === "string") {
				const parsed = JSON.parse(message);
				if (parsed.type === "get_state" || parsed.type === "ping") {
					const state =
						this.cachedState ??
						(await this.ctx.storage.get<MeralOfficeState>("office_state")) ??
						DEFAULT_OFFICE_STATE;
					ws.send(
						JSON.stringify({
							type: "state_synced",
							data: state,
							timestamp: Date.now(),
						}),
					);
				}
			}
		} catch {
			// Ignore malformed client messages
		}
	}

	/**
	 * WebSocket close handler (hibernation API)
	 */
	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		ws.close(code, reason);
	}

	/**
	 * Broadcast message to all active WebSocket connections
	 */
	private broadcast(message: object): void {
		const sockets = this.ctx.getWebSockets();
		const json = JSON.stringify(message);

		for (const socket of sockets) {
			try {
				socket.send(json);
			} catch {
				// Socket might be disconnected or erroring
			}
		}
	}

	/**
	 * Validate and sanitize office state payload
	 * Preserves all extra properties sent from the frontend while ensuring essential arrays exist
	 */
	private sanitizeState(body: Partial<MeralOfficeState>): MeralOfficeState {
		if (!body || typeof body !== "object") {
			return { ...DEFAULT_OFFICE_STATE, updatedAt: Date.now() };
		}

		return {
			...body,
			companies: Array.isArray(body.companies)
				? body.companies
				: body.companies
					? [body.companies]
					: [],
			tasks: Array.isArray(body.tasks)
				? body.tasks
				: body.tasks
					? [body.tasks]
					: [],
			documents: Array.isArray(body.documents)
				? body.documents
				: body.documents
					? [body.documents]
					: [],
			notes: Array.isArray(body.notes)
				? body.notes
				: body.notes
					? [body.notes]
					: [],
			chatMessages: Array.isArray(body.chatMessages)
				? body.chatMessages
				: body.chatMessages
					? [body.chatMessages]
					: [],
			updatedAt: body.updatedAt || Date.now(),
		};
	}
}
