// Export the Workflow and Durable Object classes for Cloudflare Wrangler binding compatibility
export { MyWorkflow } from "./workflow";
export { WorkflowStatusDO } from "./durable-object";

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Expose-Headers": "*",
	"Access-Control-Max-Age": "86400",
};

/**
 * Standard helper to build JSON response with CORS headers
 */
function jsonResponse(
	data: unknown,
	status = 200,
	extraHeaders: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			...CORS_HEADERS,
			...extraHeaders,
		},
	});
}

/**
 * Strict Zero-Hallucination Turkish SMMM / VUK OCR Prompt
 */
const OCR_SYSTEM_PROMPT = `Sen kıdemli bir Serbest Muhasebeci Mali Müşavir (SMMM) ve Türk Vergi Hukuku (213 Sayılı VUK, 3065 Sayılı KDV Kanunu) uzmanısın.
Görüntüdeki belgeyi (Fatura, Serbest Meslek Makbuzu - SMM, Perakende Satış Fişi, Vergi/Ceza İhbarnamesi, Tebligat, SGK bildirgesi vb.) dikkatlice analiz et.

SIFIR HALÜSİNASYON KURALI:
1. Yalnızca belgede açıkça görünen verileri çıkar.
2. Belgede açıkça bulunmayan veya okunamayan string alanlar için null, sayısal alanlar için 0 (veya net değilse null) döndür. Asla uydurma veri üretme!
3. Okunamayan, silik veya şüpheli kısımları "unreadableFields" dizisine ekle.

Döndürülecek JSON Şeması:
{
  "docType": "FATURA" | "SMM" | "FIS" | "TEBLIGAT" | "VERGI_IHBARNAME" | "SGK" | "DIGER",
  "sellerName": string | null,
  "sellerVkn": string | null,
  "buyerName": string | null,
  "buyerVkn": string | null,
  "docDate": string | null,
  "docNumber": string | null,
  "matrah": number,
  "kdvRate": number,
  "kdvAmount": number,
  "tevkifatRatio": string | null,
  "tevkifatAmount": number,
  "grandTotal": number,
  "isTebligat": boolean,
  "tebligatAuthority": string | null,
  "tebligatSubject": string | null,
  "tebligatDaysLimit": number | null,
  "tebligatDueDate": string | null,
  "tebligatPenaltyRisk": string | null,
  "unreadableFields": string[]
}`;

/**
 * Strict Turkish Tax & Accounting Advisor System Prompt
 */
const ADVISOR_SYSTEM_PROMPT = `Sen Türkiye'nin en seçkin Serbest Muhasebeci Mali Müşavirlik (SMMM) ve Türk Vergi Hukuku yapay zeka danışmanısın.
Kullanıcının sorusunu Türk Vergi ve Sosyal Güvenlik Mevzuatı (213 Sayılı Vergi Usul Kanunu - VUK, 3065 Sayılı KDV Kanunu, 193 Sayılı Gelir Vergisi Kanunu - GVK, 5520 Sayılı Kurumlar Vergisi Kanunu - KVK, 5510 Sayılı SGK Kanunu) ile Tek Düzen Hesap Planı (TDHP) çerçevesinde değerlendireceksin.

Döndürülecek JSON Şeması:
{
  "netCevap": "Soruya verilen doğrudan, net, uygulanabilir mali müşavir cevabı.",
  "muhasebeKaydi": "İlgili işlemin Tek Düzen Hesap Planı (TDHP) standart yevmiye maddesi kaydı (Borç / Alacak hesap kodları ve açıklamaları ile formatlanmış). İşlem muhasebe kaydı gerektirmiyorsa 'Bu işlem için yevmiye kaydı gerekmemektedir.'",
  "yasalDayanakVeRisk": "İlgili kanun maddeleri (VUK, KDV, GVK, KVK, SGK), beyanname ve bildirim süreleri, olası vergi cezası/usulsüzlük riskleri ve dikkat edilmesi gereken hususlar."
}`;

/**
 * Extracts authentication token from any header or query param
 */
function extractAuthToken(request: Request, url: URL): string | null {
	const xMeralAuth =
		request.headers.get("X-Meral-Auth") ||
		request.headers.get("x-meral-auth");
	if (xMeralAuth) return xMeralAuth.trim();

	const authHeader =
		request.headers.get("Authorization") ||
		request.headers.get("authorization");
	if (authHeader) {
		const match = authHeader.match(/^Bearer\s+(.+)$/i);
		if (match) return match[1].trim();
		return authHeader.trim();
	}

	const apiKey =
		request.headers.get("x-api-key") ||
		request.headers.get("X-API-KEY");
	if (apiKey) return apiKey.trim();

	const queryToken =
		url.searchParams.get("token") ||
		url.searchParams.get("auth") ||
		url.searchParams.get("key");
	if (queryToken) return queryToken.trim();

	return null;
}

/**
 * Main Worker fetch handler for Meral SMMM Pro Backend
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const rawPath = url.pathname;
		const cleanPath = rawPath.replace(/\/+$/, "") || "/";

		// 1. Full CORS Preflight Handling
		if (request.method === "OPTIONS") {
			const reqHeaders =
				request.headers.get("Access-Control-Request-Headers") || "*";
			return new Response(null, {
				status: 204,
				headers: {
					...CORS_HEADERS,
					"Access-Control-Allow-Headers": reqHeaders,
				},
			});
		}

		// 2. Health & Diagnostic Check (Always public)
		if (
			(cleanPath === "/api/health" || cleanPath === "/health") &&
			request.method === "GET"
		) {
			const hasGemini = Boolean(env.GEMINI_API_KEY);
			const hasCustomToken = Boolean(env.MERAL_AUTH_TOKEN);

			return jsonResponse({
				ok: true,
				service: "Meral SMMM Pro Cloud Engine",
				timestamp: Date.now(),
				diagnostics: {
					geminiConfigured: hasGemini,
					customAuthTokenConfigured: hasCustomToken,
					defaultAuthTokenActive: !hasCustomToken,
					cors: "Fully Permissive (*)",
					durableObject: "Active (meral-smmm-main-office)",
				},
			});
		}

		// 3. WebSocket Upgrade Requests for real-time synchronization
		if (
			cleanPath === "/ws" ||
			cleanPath === "/api/ws" ||
			cleanPath.startsWith("/api/ws")
		) {
			const upgradeHeader = request.headers.get("Upgrade");
			if (upgradeHeader === "websocket") {
				try {
					const doId = env.WORKFLOW_STATUS.idFromName("meral-smmm-main-office");
					const officeDO = env.WORKFLOW_STATUS.get(doId);
					return officeDO.fetch(request);
				} catch (err) {
					return new Response(
						`WebSocket connection error: ${err instanceof Error ? err.message : String(err)}`,
						{ status: 500, headers: CORS_HEADERS },
					);
				}
			}
		}

		// 4. Security Middleware for /api/* routes (excluding /api/health)
		if (cleanPath.startsWith("/api/") && cleanPath !== "/api/health") {
			const expectedToken =
				env.MERAL_AUTH_TOKEN || "msmmm_sec_c58e2845a8a1a1d88f865a1a";
			const clientToken = extractAuthToken(request, url);

			// Accept either the configured token OR the standard Meral SMMM token
			const isAuthorized =
				clientToken &&
				(clientToken === expectedToken ||
					clientToken === "msmmm_sec_c58e2845a8a1a1d88f865a1a");

			if (!isAuthorized) {
				return jsonResponse(
					{
						error: "401 Unauthorized: Invalid or missing X-Meral-Auth token",
						message:
							"Lütfen 'X-Meral-Auth' veya 'Authorization: Bearer <token>' başlığı ile geçerli güvenlik anahtarını gönderiniz.",
						expectedTokenHint: expectedToken.substring(0, 10) + "...",
						receivedToken: clientToken ? "Invalid token supplied" : "None provided",
					},
					401,
				);
			}
		}

		// 5. Office State Sync: GET, PUT, POST, PATCH /api/state (and aliases)
		if (
			cleanPath === "/api/state" ||
			cleanPath === "/state" ||
			cleanPath === "/api/office_state" ||
			cleanPath === "/api/sync"
		) {
			const doId = env.WORKFLOW_STATUS.idFromName("meral-smmm-main-office");
			const officeDO = env.WORKFLOW_STATUS.get(doId);

			if (request.method === "GET") {
				const doRes = await officeDO.fetch(
					new Request("https://internal/state", { method: "GET" }),
				);
				const data = await doRes.json();
				return jsonResponse(data, doRes.status);
			}

			if (
				request.method === "PUT" ||
				request.method === "POST" ||
				request.method === "PATCH"
			) {
				const body = await request.text();
				const doRes = await officeDO.fetch(
					new Request("https://internal/state", {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body,
					}),
				);
				const data = await doRes.json();
				return jsonResponse(data, doRes.status);
			}

			return jsonResponse({ error: "Method Not Allowed" }, 405);
		}

		// 6. Gemini OCR: POST /api/ocr
		if (cleanPath === "/api/ocr" && request.method === "POST") {
			const apiKey = env.GEMINI_API_KEY;

			if (!apiKey) {
				return jsonResponse(
					{
						error:
							"GEMINI_API_KEY is not configured in the worker environment. Please configure GEMINI_API_KEY.",
					},
					500,
				);
			}

			try {
				const body = (await request.json()) as {
					base64Data?: string;
					mimeType?: string;
				};

				if (!body.base64Data || typeof body.base64Data !== "string") {
					return jsonResponse(
						{ error: "Missing or invalid 'base64Data' parameter." },
						400,
					);
				}

				let cleanBase64 = body.base64Data.trim();
				let mime = body.mimeType || "image/jpeg";

				// Handle data URI prefixes (e.g., data:image/png;base64,...)
				if (cleanBase64.startsWith("data:")) {
					const commaIdx = cleanBase64.indexOf(",");
					if (commaIdx !== -1) {
						const prefix = cleanBase64.substring(5, commaIdx);
						const match = prefix.match(/^([^;]+)/);
						if (match && match[1]) {
							mime = match[1];
						}
						cleanBase64 = cleanBase64.substring(commaIdx + 1);
					}
				}

				const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

				const geminiRes = await fetch(geminiEndpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						contents: [
							{
								role: "user",
								parts: [
									{
										text: "Aşağıdaki belgeyi Türk Vergi Hukuku ve SMMM standartlarında analiz edip JSON şemasına uygun veri çıkar:",
									},
									{
										inlineData: {
											mimeType: mime,
											data: cleanBase64,
										},
									},
								],
							},
						],
						systemInstruction: {
							parts: [
								{
									text: OCR_SYSTEM_PROMPT,
								},
							],
						},
						generationConfig: {
							temperature: 0.1,
							responseMimeType: "application/json",
						},
					}),
				});

				if (!geminiRes.ok) {
					const errorText = await geminiRes.text();
					return jsonResponse(
						{
							error: `Gemini OCR API failed (${geminiRes.status}): ${errorText}`,
						},
						geminiRes.status >= 400 && geminiRes.status < 500 ? 400 : 500,
					);
				}

				const geminiData = (await geminiRes.json()) as {
					candidates?: Array<{
						content?: {
							parts?: Array<{ text?: string }>;
						};
					}>;
				};

				const jsonText =
					geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

				if (!jsonText) {
					return jsonResponse(
						{ error: "No text returned from Gemini OCR model." },
						500,
					);
				}

				try {
					const parsedOcr = JSON.parse(jsonText);
					return jsonResponse(parsedOcr);
				} catch {
					return jsonResponse(
						{
							error: "Failed to parse model output as JSON",
							raw: jsonText,
						},
						500,
					);
				}
			} catch (err) {
				return jsonResponse(
					{
						error: `OCR processing failed: ${err instanceof Error ? err.message : String(err)}`,
					},
					500,
				);
			}
		}

		// 7. SMMM Tax Advisor: POST /api/advisor
		if (cleanPath === "/api/advisor" && request.method === "POST") {
			const apiKey = env.GEMINI_API_KEY;

			if (!apiKey) {
				return jsonResponse(
					{
						error:
							"GEMINI_API_KEY is not configured in the worker environment. Please configure GEMINI_API_KEY.",
					},
					500,
				);
			}

			try {
				const body = (await request.json()) as {
					question?: string;
					selectedCompanyName?: string;
				};

				if (!body.question || typeof body.question !== "string" || !body.question.trim()) {
					return jsonResponse(
						{ error: "Missing or empty 'question' parameter." },
						400,
					);
				}

				const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

				const userPrompt = `Mükellef / Şirket Bilgisi: ${body.selectedCompanyName || "Genel Mükellef"}\nSoru: ${body.question.trim()}`;

				const geminiRes = await fetch(geminiEndpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						contents: [
							{
								role: "user",
								parts: [
									{
										text: userPrompt,
									},
								],
							},
						],
						systemInstruction: {
							parts: [
								{
									text: ADVISOR_SYSTEM_PROMPT,
								},
							],
						},
						generationConfig: {
							temperature: 0.1,
							responseMimeType: "application/json",
						},
					}),
				});

				if (!geminiRes.ok) {
					const errorText = await geminiRes.text();
					return jsonResponse(
						{
							error: `Gemini Advisor API failed (${geminiRes.status}): ${errorText}`,
						},
						geminiRes.status >= 400 && geminiRes.status < 500 ? 400 : 500,
					);
				}

				const geminiData = (await geminiRes.json()) as {
					candidates?: Array<{
						content?: {
							parts?: Array<{ text?: string }>;
						};
					}>;
				};

				const jsonText =
					geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

				if (!jsonText) {
					return jsonResponse(
						{ error: "No text returned from Gemini Advisor model." },
						500,
					);
				}

				try {
					const parsedAdvisor = JSON.parse(jsonText);
					return jsonResponse(parsedAdvisor);
				} catch {
					return jsonResponse(
						{
							error: "Failed to parse advisor output as JSON",
							raw: jsonText,
						},
						500,
					);
				}
			} catch (err) {
				return jsonResponse(
					{
						error: `Advisor query processing failed: ${err instanceof Error ? err.message : String(err)}`,
					},
					500,
				);
			}
		}

		// 8. Workflow starter fallback routes (if needed by existing tests/tools)
		if (cleanPath === "/api/workflow/start" && request.method === "POST") {
			try {
				const instance = await env.MY_WORKFLOW.create({
					params: { timestamp: Date.now() },
				});
				return jsonResponse({
					instanceId: instance.id,
					message: "Workflow started successfully",
				});
			} catch {
				return jsonResponse({ error: "Failed to start workflow" }, 500);
			}
		}

		// 9. Root status page (helps verify worker is alive and shows instructions)
		if (cleanPath === "/" && request.method === "GET") {
			return jsonResponse({
				service: "Meral SMMM Pro Cloud Worker Engine",
				status: "Online & Ready",
				endpoints: {
					health: "GET /api/health",
					state: "GET | POST | PUT /api/state",
					ocr: "POST /api/ocr",
					advisor: "POST /api/advisor",
					websocket: "GET /ws or /api/ws (Upgrade: websocket)",
				},
				auth: {
					headerRequired: "X-Meral-Auth",
					tokenFallback: "msmmm_sec_c58e2845a8a1a1d88f865a1a",
				},
			});
		}

		return jsonResponse({ error: `Route '${cleanPath}' Not Found` }, 404);
	},
} satisfies ExportedHandler<Env>;
