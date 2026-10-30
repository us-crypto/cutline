import { createServerFn } from "@tanstack/react-start";

type Word = { text: string; start: number; end: number };

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

function fail(error: string): Err {
  return { ok: false, error };
}

function apiKey(): string | null {
  return process.env.XAI_API_KEY ?? null;
}

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("The reply wasn't readable. Try again.");
  }
}

async function grok(system: string, user: string, maxTokens: number): Promise<string> {
  const key = apiKey();
  if (!key) throw new Error("AI isn't available right now. You can still type the lines.");
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: "grok-4.5",
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error("The editor didn't answer. Try again.");
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("The editor came back empty. Try again.");
  return text;
}

export const transcribeChunk = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Bad request");
    const data = input as { audioBase64?: unknown; offset?: unknown };
    if (typeof data.audioBase64 !== "string" || data.audioBase64.length < 32) {
      throw new Error("No audio in that section.");
    }
    if (data.audioBase64.length > 5_500_000) throw new Error("That audio piece is too large.");
    const offset = Number(data.offset);
    if (!Number.isFinite(offset) || offset < 0 || offset > 60 * 60 * 6) {
      throw new Error("Bad time offset.");
    }
    return { audioBase64: data.audioBase64, offset };
  })
  .handler(async ({ data }): Promise<Ok<{ words: Word[]; language: string; text: string }> | Err> => {
    const key = apiKey();
    if (!key) return fail("Speech reading isn't available right now. Type the lines, then export.");
    try {
      const bytes = decodeBase64(data.audioBase64);
      const file = new File([bytes], "speech.webm", { type: "audio/webm" });
      const form = new FormData();
      form.append("model", "grok-voice-transcribe-2.0");
      form.append("language", "en");
      form.append("format", "true");
      form.append("file", file);
      const res = await fetch("https://api.x.ai/v1/stt", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) return fail("Couldn't read the speech. Try a shorter section.");
      const body = (await res.json()) as {
        text?: string;
        language?: string;
        words?: { text?: string; start?: number; end?: number }[];
      };
      const words: Word[] = [];
      if (Array.isArray(body.words)) {
        for (const word of body.words) {
          const text = String(word?.text ?? "").trim();
          const start = Number(word?.start);
          const end = Number(word?.end);
          if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
          words.push({
            text,
            start: start + data.offset,
            end: Math.max(end, start) + data.offset,
          });
        }
      }
      return {
        ok: true,
        words,
        language: typeof body.language === "string" ? body.language : "",
        text: typeof body.text === "string" ? body.text : "",
      };
    } catch {
      return fail("Speech reading stalled. Try again.");
    }
  });

export const cleanLines = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Bad request");
    const lines = (input as { lines?: unknown }).lines;
    if (!Array.isArray(lines) || lines.length < 1 || lines.length > 60) {
      throw new Error("Clean 1 to 60 lines at a time.");
    }
    return {
      lines: lines.map((line) => {
        if (typeof line !== "string") throw new Error("Each line must be text.");
        return line.slice(0, 220);
      }),
    };
  })
  .handler(async ({ data }): Promise<Ok<{ lines: string[] }> | Err> => {
    try {
      const text = await grok(
        "You fix English caption lines. Correct spelling, punctuation, and obvious mishears. Keep each line's meaning and rough length. Do not merge, split, or reorder. Return JSON only: {\"lines\":[...]} with exactly the same number of strings.",
        JSON.stringify({ lines: data.lines }),
        1800,
      );
      const parsed = extractJson(text) as { lines?: unknown };
      if (!Array.isArray(parsed.lines) || parsed.lines.length !== data.lines.length) {
        return fail("Cleanup didn't keep the same number of lines. Nothing was changed.");
      }
      return {
        ok: true,
        lines: parsed.lines.map((line) => String(line).slice(0, 220)),
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Couldn't clean those lines.");
    }
  });

export const suggestCut = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Bad request");
    const data = input as { duration?: unknown; cues?: unknown };
    const duration = Number(data.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 60 * 60 * 6) {
      throw new Error("Bad duration.");
    }
    if (!Array.isArray(data.cues) || data.cues.length < 1 || data.cues.length > 80) {
      throw new Error("Need 1 to 80 caption lines.");
    }
    const cues = data.cues.map((cue) => {
      if (!cue || typeof cue !== "object") throw new Error("Bad caption.");
      const row = cue as { start?: unknown; end?: unknown; text?: unknown };
      const start = Number(row.start);
      const end = Number(row.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Bad caption time.");
      return {
        start,
        end,
        text: String(row.text ?? "").slice(0, 160),
      };
    });
    return { duration, cues };
  })
  .handler(async ({ data }): Promise<Ok<{ start: number; end: number; why: string }> | Err> => {
    try {
      const text = await grok(
        "You are a YouTube editor. Pick one continuous in and out that keeps the strongest stretch. Prefer the whole piece when it is already tight. Times are seconds. Return JSON only: {\"start\":number,\"end\":number,\"why\":\"one sentence\"}.",
        JSON.stringify(data),
        220,
      );
      const parsed = extractJson(text) as { start?: unknown; end?: unknown; why?: unknown };
      let start = Number(parsed.start);
      let end = Number(parsed.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return fail("No cut came back. The trim stays as it is.");
      }
      start = Math.min(Math.max(0, start), data.duration);
      end = Math.min(Math.max(start + 0.5, end), data.duration);
      const why = String(parsed.why ?? "A tighter window around the strongest lines.").slice(0, 180);
      return { ok: true, start, end, why };
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Couldn't suggest a cut.");
    }
  });
