import { DurableObject } from "cloudflare:workers";

/**
 * Meral SMMM Pro - Accounting Office State Schema
 */
export interface MeralOfficeState {
	companies: unknown[];
	tasks: unknown[];
	documents: unknown[];
	notes: unknown[];
	radarItems?: unknown[];
	chatMessages: unknown[];
	updatedAt: number | string;
	[key: string]: unknown;
}

export const DEFAULT_OFFICE_STATE: MeralOfficeState = {
	companies: [],
	tasks: [],
	documents: [],
	notes: [],
	radarItems: [],
	chatMessages: [],
	updatedAt: 0,
};

/**
 * WorkflowStatusDO - Production Cloudflare Durable Object for Meral SMMM Pro
 *
 * Responsibilities:
 * - Persist Meral's entire accounting office state under key "office_state"
 * - Automatically create daily rolling backup snapshots ("backup_YYYY-MM-DD") before overwriting
 * - Return { initialized: false } when empty so clients know to initialize
 * - Expose GET /backups to inspect historical office state snapshots
 * - WebSocket broadcast for multi-device synchronization (PC & Mobile Telegram)
 */
export class WorkflowStatusDO extends DurableObject {
	private cachedState: MeralOfficeState | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		ctx.blockConcurrencyWhile(async () => {
			this.cachedState =
				(await ctx.storage.get<MeralOfficeState>("office_state")) ?? null;
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname.replace(/\/+$/, "") || "/";

		// 1. WebSocket Upgrade for Real-Time Sync
		if (request.headers.get("Upgrade") === "websocket") {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			this.ctx.acceptWebSocket(server);

			const currentState =
				this.cachedState ??
				(await this.ctx.storage.get<MeralOfficeState>("office_state")) ??
				{ initialized: false };

			server.send(
				JSON.stringify({
					type: "state_synced",
					data: currentState,
					timestamp: Date.now(),
				}),
			);

			return new Response(null, { status: 101, webSocket: client });
		}

		// 2. GET /backups: Return list of available daily backup snapshots
		if (pathname.endsWith("/backups")) {
			const backupMap = await this.ctx.storage.list<MeralOfficeState>({ prefix: "backup_" });
			const backups: Array<{ key: string; date: string; updatedAt?: unknown; recordCount?: number; data?: MeralOfficeState }> = [];

			for (const [key, val] of backupMap.entries()) {
				const datePart = key.replace("backup_", "");
				const companiesCount = Array.isArray(val?.companies) ? val.companies.length : 0;
				const tasksCount = Array.isArray(val?.tasks) ? val.tasks.length : 0;
				backups.push({
					key,
					date: datePart,
					updatedAt: val?.updatedAt,
					recordCount: companiesCount + tasksCount,
					data: val,
				});
			}

			// Sort by newest date descending
			backups.sort((a, b) => b.key.localeCompare(a.key));
			return Response.json({ ok: true, count: backups.length, backups });
		}

		// 2.1 POST /backups/restore/:key -> Restore a specific historical snapshot
		if (pathname.includes("/backups/restore/")) {
			const key = pathname.split("/backups/restore/")[1];
			const lookupKey = key.startsWith("backup_") ? key : `backup_${key}`;
			const backup = await this.ctx.storage.get<MeralOfficeState>(lookupKey);
			if (!backup) {
				return Response.json({ error: `Yedek bulunamadı: ${lookupKey}` }, { status: 404 });
			}
			await this.ctx.storage.put("office_state", backup);
			this.cachedState = backup;
			this.broadcast({ type: "state_synced", data: backup, updatedAt: Date.now() });
			return Response.json({ ok: true, message: "Yedek başarıyla geri yüklendi", restoredKey: lookupKey, data: backup });
		}

		// 3. /state (GET, PUT, POST)
		if (
			pathname.endsWith("/state") ||
			pathname.endsWith("/sync") ||
			pathname.endsWith("/office_state") ||
			pathname === "" ||
			pathname === "/"
		) {
			// GET /state: Return stored office_state or { initialized: false } if empty
			if (request.method === "GET") {
				const state =
					this.cachedState ??
					(await this.ctx.storage.get<MeralOfficeState>("office_state"));

				if (!state || (!Array.isArray(state.companies) && !Array.isArray(state.tasks))) {
					return Response.json({ initialized: false });
				}

				return Response.json(state);
			}

			// PUT /state: Daily rolling backup snapshot before overwriting
			if (
				request.method === "PUT" ||
				request.method === "POST" ||
				request.method === "PATCH"
			) {
				try {
					const body = (await request.json()) as Partial<MeralOfficeState>;
					const validatedState = this.sanitizeState(body);

					// Safety backup: Save existing state to daily snapshot before overwriting
					const currentState =
						this.cachedState ??
						(await this.ctx.storage.get<MeralOfficeState>("office_state"));

					if (currentState && (Array.isArray(currentState.companies) || Array.isArray(currentState.tasks))) {
						const todayStr = new Date().toISOString().split("T")[0];
						const backupKey = `backup_${todayStr}`;
						await this.ctx.storage.put(backupKey, currentState);
					}

					// Persist new state under office_state
					await this.ctx.storage.put("office_state", validatedState);
					this.cachedState = validatedState;

					// Broadcast state_synced to all connected WebSockets
					this.broadcast({
						type: "state_synced",
						updatedAt: Date.now(),
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
	async getState(): Promise<MeralOfficeState | { initialized: false }> {
		if (this.cachedState) return this.cachedState;
		const state = (await this.ctx.storage.get<MeralOfficeState>("office_state")) ?? null;
		if (!state) return { initialized: false };
		this.cachedState = state;
		return this.cachedState;
	}

	/**
	 * RPC Method: Put Office State
	 */
	async putState(body: Partial<MeralOfficeState>): Promise<MeralOfficeState> {
		const validatedState = this.sanitizeState(body);

		const currentState =
			this.cachedState ??
			(await this.ctx.storage.get<MeralOfficeState>("office_state"));

		if (currentState) {
			const todayStr = new Date().toISOString().split("T")[0];
			await this.ctx.storage.put(`backup_${todayStr}`, currentState);
		}

		await this.ctx.storage.put("office_state", validatedState);
		this.cachedState = validatedState;

		this.broadcast({
			type: "state_synced",
			updatedAt: Date.now(),
		});

		return validatedState;
	}

	/**
	 * RPC Method: Update Workflow Step (called by MyWorkflow in workflow.ts)
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
						{ initialized: false };
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

	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		ws.close(code, reason);
	}

	private broadcast(message: object): void {
		const sockets = this.ctx.getWebSockets();
		const json = JSON.stringify(message);

		for (const socket of sockets) {
			try {
				socket.send(json);
			} catch {
				// Socket might be disconnected
			}
		}
	}

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
			radarItems: Array.isArray(body.radarItems)
				? body.radarItems
				: body.radarItems
					? [body.radarItems]
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