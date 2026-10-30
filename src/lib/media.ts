import { shapeEnglish, transcribeChunk } from "@/lib/ai.functions";
import { paintCaption } from "@/lib/burn";
import {
  cueAt,
  cueId,
  languageName,
  looksEnglish,
  outputBitrate,
  outputSize,
  QUALITIES,
  wordsToCues,
  type CaptionCue,
  type FitMode,
  type FormatId,
  type FpsId,
  type Look,
  type QualityId,
  type Word,
} from "@/lib/captions";

const CHUNK_SECONDS = 110;
export const MAX_READ_SECONDS = 30 * 60;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the audio."));
    reader.readAsDataURL(blob);
  });
}

async function extractChunk(file: File, start: number, end: number): Promise<Blob> {
  const { ALL_FORMATS, Input, BlobSource, Output, WebMOutputFormat, BufferTarget, Conversion, Quality } =
    await import("mediabunny");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const target = new BufferTarget();
    const output = new Output({ format: new WebMOutputFormat(), target });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: { discard: true },
      audio: {
        codec: "opus",
        numberOfChannels: 1,
        sampleRate: 16000,
        forceTranscode: true,
        quality: new Quality({ bitrate: 24_000 }),
      },
      trim: { start, end: Math.max(end, start + 0.2) },
      showWarnings: false,
    });
    if (!conversion.isValid) {
      const missing = conversion.discardedTracks.some(
        (track) => track.reason === "unknown_source_codec" || track.reason === "undecodable_source_codec",
      );
      throw new Error(
        missing
          ? "This browser couldn't pull the audio out. Try Chrome, or type the lines."
          : "No speech track in this video. Type the lines, then export.",
      );
    }
    await conversion.execute();
    if (!target.buffer) throw new Error("The audio extract was empty.");
    return new Blob([target.buffer], { type: "audio/webm" });
  } finally {
    input.dispose();
  }
}

function cuesFromLines(words: Word[], lines: { from: number; to: number; text: string }[]): CaptionCue[] | null {
  if (!lines.length) return [];
  const cues: CaptionCue[] = [];
  let cursor = 0;
  for (const line of lines) {
    const from = line.from;
    const to = line.to;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from !== cursor || to < from || to >= words.length) {
      return null;
    }
    if (line.text) {
      cues.push({
        id: cueId(),
        start: words[from].start,
        end: Math.max(words[to].end, words[from].start + 0.3),
        text: line.text,
      });
    }
    cursor = to + 1;
  }
  if (cursor < words.length) return null;
  return cues;
}

async function writeEnglish(words: Word[]): Promise<CaptionCue[]> {
  const cues: CaptionCue[] = [];
  for (let index = 0; index < words.length; index += 180) {
    const slice = words.slice(index, index + 180);
    const shaped = await shapeEnglish({ data: { words: slice.map((word) => ({ text: word.text })) } });
    if (!shaped.ok || !shaped.english) {
      cues.push(...wordsToCues(slice));
      continue;
    }
    const next = cuesFromLines(slice, shaped.lines);
    cues.push(...(next ?? wordsToCues(slice)));
  }
  return cues;
}

export async function readSpeech(
  file: File,
  start: number,
  end: number,
  onProgress: (message: string) => void,
): Promise<{ cues: CaptionCue[]; language: string; skipped: string }> {
  const span = Math.max(0, end - start);
  if (span < 0.3) throw new Error("That trim is too short to read.");
  if (span > MAX_READ_SECONDS + 0.25) {
    throw new Error("Speech reading covers 30 minutes at a time. Pull the out point in, then read again.");
  }
  const total = Math.ceil(span / CHUNK_SECONDS);
  const cues: CaptionCue[] = [];
  const skipped: string[] = [];
  let language = "";
  for (let index = 0; index < total; index++) {
    const chunkStart = start + index * CHUNK_SECONDS;
    const chunkEnd = Math.min(end, chunkStart + CHUNK_SECONDS);
    onProgress(`Hearing section ${index + 1} of ${total}`);
    const audio = await extractChunk(file, chunkStart, chunkEnd);
    const audioBase64 = await blobToBase64(audio);
    const detected = await transcribeChunk({ data: { audioBase64, offset: chunkStart, mode: "detect" } });
    if (!detected.ok) throw new Error(detected.error);
    if (!language && detected.language) language = detected.language;
    const heard = detected.words.map((word) => word.text).join(" ") || detected.text;
    if (!heard.trim()) continue;
    if (!looksEnglish(heard, detected.language)) {
      skipped.push(`${languageName(detected.language)} ${formatSpan(chunkStart, chunkEnd)}`);
      continue;
    }
    onProgress(`Writing English captions ${index + 1} of ${total}`);
    const formatted = await transcribeChunk({ data: { audioBase64, offset: chunkStart, mode: "english" } });
    const words = formatted.ok && formatted.words.length ? formatted.words : detected.words;
    if (!words.length) continue;
    cues.push(...(await writeEnglish(words)));
  }
  onProgress("Captions ready");
  return {
    cues,
    language,
    skipped: skipped.length ? `Skipped non-English speech: ${skipped.join(", ")}.` : "",
  };
}

function formatSpan(start: number, end: number): string {
  const clock = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };
  return `${clock(start)}–${clock(end)}`;
}

export async function exportCaptionedMp4(options: {
  file: File;
  format: FormatId;
  fit: FitMode;
  look: Look;
  quality: QualityId;
  fps: FpsId;
  cues: CaptionCue[];
  trimStart: number;
  trimEnd: number;
  onProgress: (ratio: number) => void;
}): Promise<Blob> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("This browser can't encode MP4. Open Cutline in Chrome or Edge.");
  }
  await document.fonts.load("600 64px Outfit");
  const attempts = ["no-preference", "prefer-software"] as const;
  let last: unknown;
  for (const hardwareAcceleration of attempts) {
    try {
      return await encodeMp4(options, hardwareAcceleration);
    } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : "";
      if (!/unsupported configuration|isConfigSupported/i.test(message)) throw error;
    }
  }
  const label = QUALITIES[options.quality].label;
  if (last instanceof Error && /unsupported configuration|isConfigSupported/i.test(last.message)) {
    throw new Error(`${label} at ${options.fps} fps isn't supported on this device. Choose a lower size or frame rate.`);
  }
  throw last instanceof Error ? last : new Error("Couldn't encode that video.");
}

async function encodeMp4(
  options: {
    file: File;
    format: FormatId;
    fit: FitMode;
    look: Look;
    quality: QualityId;
    fps: FpsId;
    cues: CaptionCue[];
    trimStart: number;
    trimEnd: number;
    onProgress: (ratio: number) => void;
  },
  hardwareAcceleration: "no-preference" | "prefer-software",
): Promise<Blob> {
  const { ALL_FORMATS, Input, BlobSource, Output, Mp4OutputFormat, BufferTarget, Conversion, Quality } =
    await import("mediabunny");
  const { width, height } = outputSize(options.format, options.quality);
  const fps = Number(options.fps);
  const input = new Input({ source: new BlobSource(options.file), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("That file has no video track.");

    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });
    let canvas: OffscreenCanvas | null = null;
    let ctx: OffscreenCanvasRenderingContext2D | null = null;

    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      trim: {
        start: options.trimStart,
        end: Math.max(options.trimEnd, options.trimStart + 0.2),
      },
      showWarnings: false,
      tags: { title: "Cutline", creationTime: null },
      video: {
        codec: "avc",
        width,
        height,
        fit: options.fit,
        frameRate: fps,
        allowTransformationMetadata: false,
        hardwareAcceleration,
        keyFrameInterval: 2,
        quality: new Quality({ bitrate: outputBitrate(options.quality, fps), bitrateMode: "variable" }),
        processedWidth: width,
        processedHeight: height,
        process: (sample) => {
          if (!canvas || !ctx) {
            canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Couldn't open a drawing surface.");
            ctx = context;
          }
          ctx.fillStyle = "#000000";
          ctx.fillRect(0, 0, width, height);
          sample.draw(ctx, 0, 0, width, height);
          const sourceTime = sample.timestamp + options.trimStart;
          const cue = cueAt(options.cues, sourceTime);
          const text = cue?.text.trim() ?? "";
          if (text) paintCaption(ctx, width, height, text, options.look, options.format);
          return canvas;
        },
      },
    });

    if (!conversion.isValid) {
      const blocked = conversion.discardedTracks.some(
        (track) => track.reason === "no_encodable_target_codec" || track.reason === "undecodable_source_codec",
      );
      throw new Error(
        blocked
          ? "This browser can't encode that video. Try Chrome or Edge."
          : "Couldn't build an MP4 from this file.",
      );
    }

    conversion.onProgress = (progress) => {
      options.onProgress(progress);
    };
    await conversion.execute();
    if (!target.buffer) throw new Error("Export finished empty.");
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    input.dispose();
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function saveToGallery(blob: Blob, filename: string): Promise<"shared" | "downloaded"> {
  const file = new File([blob], filename, { type: "video/mp4" });
  const payload = { files: [file], title: filename };
  if (typeof navigator.share === "function" && navigator.canShare?.(payload)) {
    await navigator.share(payload);
    return "shared";
  }
  downloadBlob(blob, filename);
  return "downloaded";
}
