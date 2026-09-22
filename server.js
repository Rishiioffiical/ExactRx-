const http = require("node:http");

const port = Number.parseInt(process.env.PORT || "8080", 10);
const maxRequestBytes = 10 * 1024 * 1024;
const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const geminiConfigured = Boolean(geminiApiKey);

function sendJson(response, statusCode, body) {
    const payload = JSON.stringify(body);
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    response.end(payload);
}

function readRequestBody(request, response) {
    return new Promise((resolve, reject) => {
        let bodyBytes = 0;
        const chunks = [];

        request.on("data", (chunk) => {
            bodyBytes += chunk.length;
            if (bodyBytes > maxRequestBytes) {
                sendJson(response, 413, { error: "Request body is too large." });
                request.destroy();
                reject(new Error("Request body is too large."));
                return;
            }
            chunks.push(chunk);
        });

        request.on("end", () => resolve(Buffer.concat(chunks)));
        request.on("error", reject);
    });
}

function parseJsonBody(body) {
    try {
        return JSON.parse(body.toString("utf8"));
    } catch {
        return null;
    }
}

function isSyntheticDemoRequest(body) {
    return body && body.syntheticDemo === true && body.mimeType === "image/png" &&
        typeof body.imageBase64 === "string" && body.imageBase64.length > 0;
}

function extractGeminiCandidates(payload) {
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") return null;

    try {
        const result = JSON.parse(text);
        if (!Array.isArray(result.candidates)) return null;

        const candidates = result.candidates.filter((candidate) => {
            return candidate && typeof candidate.name === "string" &&
                typeof candidate.strength === "string" &&
                typeof candidate.dosageForm === "string" &&
                ["low", "medium", "high"].includes(candidate.confidence);
        }).map((candidate) => ({
            name: candidate.name,
            strength: candidate.strength,
            dosageForm: candidate.dosageForm,
            confidence: candidate.confidence
        }));

        if (candidates.length === 0) return null;
        return { candidates, requiresUserConfirmation: true, simulatedInput: true };
    } catch {
        return null;
    }
}

async function requestGeminiCandidates(body) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
    const prompt = [
        "You are supporting a medication verification prototype.",
        "This is a synthetic demo image, not patient data.",
        "Return only possible medicine candidates, never a definitive identification.",
        "Do not diagnose, prescribe, recommend starting or stopping a medicine, change dosage, or make a safety conclusion.",
        "Every candidate must include uncertainty through confidence: low, medium, or high.",
        "Return JSON matching the requested schema."
    ].join(" ");

    const apiResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{
                parts: [
                    { text: prompt },
                    { inline_data: { mime_type: body.mimeType, data: body.imageBase64 } }
                ]
            }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        candidates: {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    name: { type: "STRING" },
                                    strength: { type: "STRING" },
                                    dosageForm: { type: "STRING" },
                                    confidence: { type: "STRING", enum: ["low", "medium", "high"] }
                                },
                                required: ["name", "strength", "dosageForm", "confidence"]
                            }
                        }
                    },
                    required: ["candidates"]
                }
            }
        })
    });

    if (!apiResponse.ok) {
        throw new Error(`Gemini request failed with status ${apiResponse.status}.`);
    }

    return extractGeminiCandidates(await apiResponse.json());
}

const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/health" && request.method === "GET") {
        sendJson(response, 200, {
            ok: true,
            geminiConfigured,
            verificationEnabled: geminiConfigured
        });
        return;
    }

    if (requestUrl.pathname === "/api/verify-image") {
        if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            sendJson(response, 405, { error: "Method not allowed." });
            return;
        }

        if (!geminiConfigured) {
            sendJson(response, 503, { error: "Server is not configured for verification." });
            return;
        }

        try {
            const body = parseJsonBody(await readRequestBody(request, response));
            if (!isSyntheticDemoRequest(body)) {
                sendJson(response, 400, {
                    error: "Only explicitly marked synthetic demo images are accepted by this prototype."
                });
                return;
            }

            const result = await requestGeminiCandidates(body);
            if (!result) {
                sendJson(response, 502, { error: "Gemini returned no valid candidate data." });
                return;
            }

            sendJson(response, 200, result);
        } catch {
            sendJson(response, 502, { error: "Gemini verification is temporarily unavailable." });
            return;
        }
    }

    sendJson(response, 404, { error: "Not found." });
});

server.listen(port, () => {
    console.log(`ExactRx backend listening on port ${port}.`);
});
