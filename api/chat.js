// Repo mein: api/chat.js
// Vercel env variable: GEMINI_API_KEY   (optional: GEMINI_MODEL)

const FALLBACKS = ["gemini-3.8-flash", "gemini-4-hydrogen", "gemini-4-carbon", "gemini-4-argon"];
const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

function modelList() {
  const models = [];
  if (process.env.GEMINI_MODEL) models.push(process.env.GEMINI_MODEL);
  FALLBACKS.forEach((m) => { if (models.indexOf(m) < 0) models.push(m); });
  return models;
}

async function callGemini(model, key, payload, ms) {
  const r = await fetch(BASE + model + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(ms),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

function getText(data) {
  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && cand.content.parts
    ? cand.content.parts.filter((p) => !p.thought).map((p) => p.text || "").join("")
    : "";
  const why = (data.promptFeedback && data.promptFeedback.blockReason) || (cand && cand.finishReason) || "unknown";
  return { text, why };
}

module.exports = async function handler(req, res) {
  const key = process.env.GEMINI_API_KEY;

  // Test link: open /api/chat in the browser
  if (req.method === "GET") {
    if (!key) return res.status(200).json({ ok: false, problem: "GEMINI_API_KEY is NOT set on Vercel (or you did not redeploy after adding it)." });
    const probe = { contents: [{ role: "user", parts: [{ text: "Say hi in one word." }] }], generationConfig: { maxOutputTokens: 256 } };
    const out = await Promise.all(modelList().map(async (model) => {
      const t0 = Date.now();
      try {
        const r = await callGemini(model, key, probe, 20000);
        const g = getText(r.data);
        return {
          model, status: r.status, ms: Date.now() - t0,
          works: r.ok && !!g.text.trim(),
          note: r.ok ? (g.text.trim() ? g.text.trim().slice(0, 40) : "empty (" + g.why + ")") : ((r.data.error && r.data.error.message) || "error").slice(0, 160),
        };
      } catch (e) {
        return { model, status: 0, ms: Date.now() - t0, works: false, note: e.name === "TimeoutError" ? "timed out after 20s" : String(e.message || e) };
      }
    }));
    return res.status(200).json({ ok: out.some((o) => o.works), results: out });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Use POST" });
  }
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set on Vercel. Add it in Settings > Environment Variables, then Redeploy." });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const system = String(body.system || "").slice(0, 6000);
    const msgs = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
    if (!msgs.length) return res.status(400).json({ error: "No messages" });

    const contents = msgs.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "").slice(0, 8000) }],
    }));

    if (typeof body.image === "string") {
      const m = body.image.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
      if (m && m[2].length < 4000000) {
        for (let i = contents.length - 1; i >= 0; i--) {
          if (contents[i].role === "user") {
            contents[i].parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
            break;
          }
        }
      }
    }

    const payload = { contents, generationConfig: { maxOutputTokens: body.mode === "draw" ? 16384 : 8192 } };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };

    let lastErr = "No model worked";
    for (const model of modelList()) {
      try {
        const r = await callGemini(model, key, payload, 25000);
        if (!r.ok) { lastErr = model + ": " + ((r.data.error && r.data.error.message) || ("HTTP " + r.status)); continue; }
        const g = getText(r.data);
        if (g.text.trim()) return res.status(200).json({ reply: g.text });
        lastErr = model + ": empty reply (" + g.why + ")";
      } catch (e) {
        lastErr = model + ": " + (e.name === "TimeoutError" ? "timed out" : (e.message || e));
      }
    }
    return res.status(502).json({ error: lastErr });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e.message || e) });
  }
};
