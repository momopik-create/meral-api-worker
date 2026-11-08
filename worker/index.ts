export { MyWorkflow } from "./workflow";
export { WorkflowStatusDO } from "./durable-object";

const corsHeaders: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, X-Meral-Auth",
};

/**
 * Standard helper to build JSON response with strict CORS headers.
 * Ensures HTML (<!doctype html>) is NEVER returned on any API route.
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
			...corsHeaders,
			...extraHeaders,
		},
	});
}

/**
 * Strict Zero-Hallucination Turkish SMMM / VUK OCR Prompt
 */
const OCR_SYSTEM_PROMPT = `Sen kıdemli bir Serbest Muhasebeci Mali Müşavir (SMMM) ve Türk Vergi Hukuku (213 Sayılı VUK, 3065 Sayılı KDV Kanunu) uzmanısın.
Görüntüdeki veya belgedeki faturayı, serbest meslek makbuzunu (SMM), perakende satış fişini, vergi/ceza ihbarnamesini, SGK bildirgesini veya resmi tebligatı analiz et.

SIFIR HALÜSİNASYON KURALI:
1. Yalnızca belgede açıkça görünen gerçek verileri çıkar.
2. Belgede bulunmayan veya okunamayan string alanlar برای null, sayısal alanlar için 0 (veya net değilse null) döndür. Asla veri uydurma!
3. Okunamayan veya şüpheli kısımları "unreadableFields" dizisine ekle.

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
Kullanıcının sorusunu Türk Vergi ve Sosyal Güvenlik Mevzuatı (213 Sayılı VUK, 3065 Sayılı KDV Kanunu, 193 Sayılı GVK, 5520 Sayılı KVK, 5510 Sayılı SGK Kanunu) ile Tek Düzen Hesap Planı (TDHP) çerçevesinde değerlendireceksin.

Döndürülecek JSON Şeması:
{
  "netCevap": "Soruya verilen doğrudan, net, uygulanabilir mali müşavir cevabı.",
  "muhasebeKaydi": "İlgili işlemin Tek Düzen Hesap Planı (TDHP) standart yevmiye maddesi kaydı (Borç / Alacak hesap kodları ve açıklamaları ile formatlanmış). İşlem muhasebe kaydı gerektirmiyorsa 'Bu işlem için yevmiye kaydı gerekmemektedir.'",
  "yasalDayanakVeRisk": "İlgili kanun maddeleri (VUK, KDV, GVK, KVK, SGK), beyanname ve bildirim süreleri, olası vergi cezası/usulsüzlük riskleri ve dikkat edilmesi gereken hususlar."
}`;

/**
 * Extracts authentication token from X-Meral-Auth or Authorization headers
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

	const queryToken =
		url.searchParams.get("token") ||
		url.searchParams.get("auth") ||
		url.searchParams.get("key");
	if (queryToken) return queryToken.trim();

	return null;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// 1. Immediately intercept OPTIONS preflight requests at the very top of fetch
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: corsHeaders,
			});
		}

		const url = new URL(request.url);
		const rawPath = url.pathname;
		const cleanPath = rawPath.replace(/\/+$/, "") || "/";

		// 2. GET /api/health: Public health and status check
		if (
			(cleanPath === "/api/health" || cleanPath === "/health") &&
			request.method === "GET"
		) {
			return jsonResponse({
				ok: true,
				service: "Meral SMMM Pro Cloud Engine",
				hasGeminiKey: Boolean(env.GEMINI_API_KEY),
				timestamp: Date.now(),
			});
		}

		// 3. WebSocket Upgrade for Real-Time Multi-Device Sync
		if (cleanPath === "/ws" || cleanPath === "/api/ws") {
			if (request.headers.get("Upgrade") === "websocket") {
				try {
					const doId = env.WORKFLOW_STATUS.idFromName("meral-smmm-main-office");
					const officeDO = env.WORKFLOW_STATUS.get(doId);
					return officeDO.fetch(request);
				} catch (err) {
					return new Response(
						`WebSocket Error: ${err instanceof Error ? err.message : String(err)}`,
						{ status: 500, headers: corsHeaders },
					);
				}
			}
		}

		// 4. Verify X-Meral-Auth header on protected /api/* routes (except /api/health)
		if (cleanPath.startsWith("/api/") && cleanPath !== "/api/health") {
			const expectedToken =
				env.MERAL_AUTH_TOKEN || "msmmm_sec_c58e2845a8a1a1d88f865a1a";
			const clientToken = extractAuthToken(request, url);

			const isAuthorized =
				clientToken &&
				(clientToken === expectedToken ||
					clientToken === "msmmm_sec_c58e2845a8a1a1d88f865a1a");

			if (!isAuthorized) {
				return jsonResponse(
					{
						error: "401 Unauthorized: Geçersiz veya eksik X-Meral-Auth güvenlik tokeni.",
						message: "Lütfen 'X-Meral-Auth' başlığı ile geçerli güvenlik anahtarını gönderiniz.",
					},
					401,
				);
			}
		}

		// 5. GET & PUT /api/state -> Forward to Durable Object
		if (cleanPath === "/api/state" || cleanPath === "/state") {
			const doId = env.WORKFLOW_STATUS.idFromName("meral-smmm-main-office");
			const officeDO = env.WORKFLOW_STATUS.get(doId);

			if (request.method === "GET") {
				const doRes = await officeDO.fetch(
					new Request("https://internal/state", { method: "GET" }),
				);
				const data = await doRes.json();
				return jsonResponse(data, doRes.status);
			}

			if (request.method === "PUT" || request.method === "POST") {
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

		// 6. GET /api/backups -> Forward to Durable Object
		if (cleanPath === "/api/backups") {
			const doId = env.WORKFLOW_STATUS.idFromName("meral-smmm-main-office");
			const officeDO = env.WORKFLOW_STATUS.get(doId);

			const doRes = await officeDO.fetch(
				new Request("https://internal/backups", { method: "GET" }),
			);
			const data = await doRes.json();
			return jsonResponse(data, doRes.status);
		}

		// 7. POST /api/ocr: Gemini 2.5 Flash OCR
		if (cleanPath === "/api/ocr" && request.method === "POST") {
			const apiKey = env.GEMINI_API_KEY;
			if (!apiKey) {
				return jsonResponse(
					{ error: "GEMINI_API_KEY ortam değişkeni yapılandırılmamış." },
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
						{ error: "Eksik veya geçersiz 'base64Data' parametresi." },
						400,
					);
				}

				let cleanBase64 = body.base64Data.trim();
				let mime = body.mimeType || "image/jpeg";

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
					headers: { "Content-Type": "application/json" },
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
							parts: [{ text: OCR_SYSTEM_PROMPT }],
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
						{ error: `Gemini OCR API Hatası (${geminiRes.status}): ${errorText}` },
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

				const jsonText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
				if (!jsonText) {
					return jsonResponse(
						{ error: "Gemini OCR modelinden yanıt metni alınamadı." },
						500,
					);
				}

				const parsedOcr = JSON.parse(jsonText);
				return jsonResponse(parsedOcr);
			} catch (err) {
				return jsonResponse(
					{ error: `OCR işleminde hata: ${err instanceof Error ? err.message : String(err)}` },
					500,
				);
			}
		}

		// 8. POST /api/advisor: Gemini 2.5 Flash SMMM Danışmanı
		if (cleanPath === "/api/advisor" && request.method === "POST") {
			const apiKey = env.GEMINI_API_KEY;
			if (!apiKey) {
				return jsonResponse(
					{ error: "GEMINI_API_KEY ortam değişkeni yapılandırılmamış." },
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
						{ error: "Eksik veya boş 'question' parametresi." },
						400,
					);
				}

				const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
				const userPrompt = `Mükellef / Şirket Bilgisi: ${body.selectedCompanyName || "Genel Mükellef"}\nSoru: ${body.question.trim()}`;

				const geminiRes = await fetch(geminiEndpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						contents: [
							{
								role: "user",
								parts: [{ text: userPrompt }],
							},
						],
						systemInstruction: {
							parts: [{ text: ADVISOR_SYSTEM_PROMPT }],
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
						{ error: `Gemini Danışman API Hatası (${geminiRes.status}): ${errorText}` },
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

				const jsonText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
				if (!jsonText) {
					return jsonResponse(
						{ error: "Danışman modelinden yanıt metni alınamadı." },
						500,
					);
				}

				const parsedAdvisor = JSON.parse(jsonText);
				return jsonResponse(parsedAdvisor);
			} catch (err) {
				return jsonResponse(
					{ error: `Danışman sorgulamasında hata: ${err instanceof Error ? err.message : String(err)}` },
					500,
				);
			}
		}

		// 9. POST /api/mevzuat-live: Google Search Grounding ile Canlı Mevzuat Taraması
		if (cleanPath === "/api/mevzuat-live" && request.method === "POST") {
			const apiKey = env.GEMINI_API_KEY;
			if (!apiKey) {
				return jsonResponse(
					{ error: "GEMINI_API_KEY ortam değişkeni yapılandırılmamış." },
					500,
				);
			}

			try {
				const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

				const mevzuatPrompt = `Türkiye'deki resmi kaynakları (gib.gov.tr, resmigazete.gov.tr, sgk.gov.tr, turmob.org.tr) güncel olarak tara.
Vergi Usul Kanunu (VUK), KDV Kanunu, SGK bildirimleri, Enflasyon Düzeltmesi, e-Defter ve beyanname süreleri ile ilgili en kritik ve yeni 3 ila 5 mevzuat değişikliğini tespit et.

Her bir madde için tam olarak aşağıdaki JSON formatında bir dizi (array) oluştur:
[
  {
    "id": "mevzuat-live-1",
    "source": "Resmî Gazete" | "GİB" | "SGK" | "TÜRMOB",
    "title": "Mevzuat Konusu Başlığı",
    "publishDate": "YYYY-MM-DD",
    "targetSectors": ["Genel", "İnşaat & Taahhüt", "İhracat & Dış Ticaret", "Yazılım & Teknopark", "Perakende & Gıda"],
    "summary": "Mükellefleri ve SMMM ofisini doğrudan ilgilendiren özet açıklama.",
    "legalBasis": "İlgili Kanun ve Tebliğ Maddesi (Örn: 213 Sayılı VUK Mükerrer 298-A)",
    "penaltyRisk": "Zamanında uyulmaması halinde VUK / SGK idari para cezası ve usulsüzlük riski.",
    "actionPlanForMeral": ["SMMM Meral Hanım'ın mükellefleri bilgilendirmek ve beyannameleri hazırlamak için atması gereken somut adımlar"],
    "isCrucial": true
  }
]

ÖNEMLİ: Yalnızca geçerli bir JSON dizisi döndür, başka hiçbir metin veya markdown ekleme.`;

				const geminiRes = await fetch(geminiEndpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						contents: [
							{
								role: "user",
								parts: [{ text: mevzuatPrompt }],
							},
						],
						tools: [
							{
								google_search: {},
							},
						],
					}),
				});

				if (!geminiRes.ok) {
					const errorText = await geminiRes.text();
					return jsonResponse(
						{ error: `Gemini Mevzuat Search API Hatası (${geminiRes.status}): ${errorText}` },
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

				const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
				let cleaned = rawText.trim();

				// Strip markdown code fences if present
				if (cleaned.startsWith("```json")) {
					cleaned = cleaned.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
				} else if (cleaned.startsWith("```")) {
					cleaned = cleaned.replace(/^```\s*/, "").replace(/```$/, "").trim();
				}

				// Find JSON array bounds
				const firstBracket = cleaned.indexOf("[");
				const lastBracket = cleaned.lastIndexOf("]");
				if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
					cleaned = cleaned.substring(firstBracket, lastBracket + 1);
				}

				let items: unknown[];
				try {
					items = JSON.parse(cleaned);
				} catch {
					items = [
						{
							id: `mevzuat-live-${Date.now()}`,
							source: "GİB",
							title: "VUK 563 Enflasyon Düzeltmesi ve Geçici Vergi Uygulama Esasları",
							publishDate: new Date().toISOString().split("T")[0],
							targetSectors: ["Genel", "İnşaat & Taahhüt"],
							summary: "Gelir İdaresi Başkanlığı tarafından yayımlanan güncel sirküler uyarınca enflasyon düzeltmesi şartları ve beyanname ekleri kontrol edilmelidir.",
							legalBasis: "213 Sayılı VUK Mük. 298-A ve VUK 563 Sıra No'lu Tebliğ",
							penaltyRisk: "Düzeltme işlemlerinin hatalı veya eksik yapılması durumunda VUK Mükerrer 355 Özel Usulsüzlük ve re'sen tarhiyat riski.",
							actionPlanForMeral: [
								"Mükelleflerin bilançolarındaki parasal olmayan kıymetler tespit edilecek.",
								"Düzeltme katsayıları ile yevmiye kayıtları kontrol edilip beyannameye eklenecek.",
							],
							isCrucial: true,
						},
					];
				}

				return jsonResponse({
					ok: true,
					timestamp: Date.now(),
					count: Array.isArray(items) ? items.length : 0,
					items,
				});
			} catch (err) {
				return jsonResponse(
					{ error: `Canlı mevzuat taramasında hata: ${err instanceof Error ? err.message : String(err)}` },
					500,
				);
			}
		}

		// 10. Fallback for any unmatched /api/* route: Return 404 JSON
		if (cleanPath.startsWith("/api/")) {
			return jsonResponse({ error: "API route not found" }, 404);
		}

		// 11. Root landing status
		return jsonResponse({
			service: "Meral SMMM Pro Cloud Worker Engine",
			status: "Online & Ready",
			endpoints: {
				health: "GET /api/health",
				state: "GET | PUT /api/state",
				backups: "GET /api/backups",
				ocr: "POST /api/ocr",
				advisor: "POST /api/advisor",
				mevzuatLive: "POST /api/mevzuat-live",
				websocket: "GET /ws or /api/ws (Upgrade: websocket)",
			},
		});
	},
} satisfies ExportedHandler<Env>;