const http = require("node:http");
const fs = require("node:fs");

const port = Number.parseInt(process.env.PORT || "8080", 10);
const maxRequestBytes = 15 * 1024 * 1024;
const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
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

function providerError(code, message, retryable = true) {
    const error = new Error(message);
    error.code = code;
    error.retryable = retryable;
    return error;
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

function isImageRequest(body) {
    return body && ["image/png", "image/jpeg", "image/webp"].includes(body.mimeType) &&
        typeof body.imageBase64 === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(body.imageBase64) &&
        body.imageBase64.length > 0;
}

function uncertainCandidate(reason) {
    return {
        name: "uncertain/unreadable",
        strength: "not readable",
        dosageForm: "not readable",
        confidence: "low",
        uncertaintyReason: reason || "The medicine identity could not be read confidently from the image."
    };
}

function extractGeminiCandidates(payload) {
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") return { candidates: [uncertainCandidate()] };

    try {
        const result = JSON.parse(text);
        if (!Array.isArray(result.candidates)) return { candidates: [uncertainCandidate()] };

        const candidates = result.candidates.filter((candidate) => {
            return candidate && typeof candidate.name === "string" &&
                typeof candidate.strength === "string" &&
                typeof candidate.dosageForm === "string" &&
                ["low", "medium", "high"].includes(candidate.confidence) &&
                typeof candidate.uncertaintyReason === "string";
        }).map((candidate) => ({
            name: candidate.name.trim() || "uncertain/unreadable",
            strength: candidate.strength.trim() || "not readable",
            dosageForm: candidate.dosageForm.trim() || "not readable",
            confidence: candidate.confidence,
            uncertaintyReason: candidate.uncertaintyReason.trim() || "The image is unclear."
        })).slice(0, 5);

        return {
            candidates: candidates.length > 0 ? candidates : [uncertainCandidate()],
            requiresUserConfirmation: true,
            simulatedInput: false
        };
    } catch {
        return { candidates: [uncertainCandidate("Gemini returned an unreadable result for this image.")] };
    }
}

async function requestGeminiCandidates(body) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
    const prompt = [
        "You are supporting a medication verification prototype by reading a prescription or medicine image.",
        "Return only possible medicine candidates, never a definitive identification.",
        "If the image is unclear, handwritten text cannot be read, or no medicine is visible, return one candidate named exactly uncertain/unreadable.",
        "Never guess or invent a medicine.",
        "For each candidate, include the medicine name, strength only if readable, dosage form only if readable, confidence, and the uncertainty reason.",
        "Do not diagnose, prescribe, recommend starting or stopping a medicine, change dosage, or make a safety conclusion.",
        "Every candidate must include uncertainty through confidence: low, medium, or high.",
        "Return JSON matching the requested schema, with no extra commentary."
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
                                    confidence: { type: "STRING", enum: ["low", "medium", "high"] },
                                    uncertaintyReason: { type: "STRING" }
                                },
                                required: ["name", "strength", "dosageForm", "confidence", "uncertaintyReason"]
                            }
                        }
                    },
                    required: ["candidates"]
                }
            }
        })
    });

    if (!apiResponse.ok) {
        if (apiResponse.status === 401 || apiResponse.status === 403) {
            throw providerError("GEMINI_AUTHENTICATION_FAILED", "Gemini verification is not authorized.", false);
        }
        if (apiResponse.status === 404) {
            throw providerError("GEMINI_MODEL_UNAVAILABLE", "The configured Gemini model is unavailable.", false);
        }
        throw providerError("GEMINI_UNAVAILABLE", "Gemini verification is temporarily unavailable.");
    }

    return extractGeminiCandidates(await apiResponse.json());
}

const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/" && request.method === "GET") {
    const html = fs.readFileSync("index.html", "utf8");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html);
    return;
  }

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
            if (!isImageRequest(body)) {
                sendJson(response, 400, {
                    error: "A PNG, JPG, or WEBP image is required."
                });
                return;
            }

            const result = await requestGeminiCandidates(body);
            sendJson(response, 200, result);
            return;
        } catch (error) {
            sendJson(response, error.code === "GEMINI_AUTHENTICATION_FAILED" || error.code === "GEMINI_MODEL_UNAVAILABLE" ? 502 : 503, {
                error: {
                    code: error.code || "GEMINI_UNAVAILABLE",
                    message: error.message || "Gemini verification is temporarily unavailable.",
                    retryable: error.retryable !== false
                }
            });
            return;
        }
    }

    sendJson(response, 404, { error: "Not found." });
});

server.listen(port, () => {
    console.log(`ExactRx backend listening on port ${port}.`);
});
