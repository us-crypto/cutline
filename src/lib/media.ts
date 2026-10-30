import { transcribeChunk } from "@/lib/ai.functions";
import { paintCaption } from "@/lib/burn";
import { cueAt, type CaptionCue, type FitMode, type FormatId, type Look, type Word, FORMATS } from "@/lib/captions";

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

export async function readSpeech(
  file: File,
  start: number,
  end: number,
  onProgress: (done: number, total: number) => void,
): Promise<{ words: Word[]; language: string; fallbackText: { text: string; start: number; end: number }[] }> {
  const span = Math.max(0, end - start);
  if (span < 0.3) throw new Error("That trim is too short to read.");
  if (span > MAX_READ_SECONDS + 0.25) {
    throw new Error("Speech reading covers 30 minutes at a time. Pull the out point in, then read again.");
  }
  const total = Math.ceil(span / CHUNK_SECONDS);
  const words: Word[] = [];
  const fallbackText: { text: string; start: number; end: number }[] = [];
  let language = "";
  for (let index = 0; index < total; index++) {
    const chunkStart = start + index * CHUNK_SECONDS;
    const chunkEnd = Math.min(end, chunkStart + CHUNK_SECONDS);
    onProgress(index, total);
    const audio = await extractChunk(file, chunkStart, chunkEnd);
    const audioBase64 = await blobToBase64(audio);
    const result = await transcribeChunk({ data: { audioBase64, offset: chunkStart } });
    if (!result.ok) throw new Error(result.error);
    if (!language && result.language) language = result.language;
    if (result.words.length) words.push(...result.words);
    else if (result.text.trim()) {
      fallbackText.push({ text: result.text.trim(), start: chunkStart, end: chunkEnd });
    }
  }
  onProgress(total, total);
  return { words, language, fallbackText };
}

export async function exportCaptionedMp4(options: {
  file: File;
  format: FormatId;
  fit: FitMode;
  look: Look;
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
  throw last instanceof Error ? last : new Error("Couldn't encode that video.");
}

async function encodeMp4(
  options: {
    file: File;
    format: FormatId;
    fit: FitMode;
    look: Look;
    cues: CaptionCue[];
    trimStart: number;
    trimEnd: number;
    onProgress: (ratio: number) => void;
  },
  hardwareAcceleration: "no-preference" | "prefer-software",
): Promise<Blob> {
  const { ALL_FORMATS, Input, BlobSource, Output, Mp4OutputFormat, BufferTarget, Conversion, Quality } =
    await import("mediabunny");
  const spec = FORMATS[options.format];
  const input = new Input({ source: new BlobSource(options.file), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("That file has no video track.");
    let frameRate: number | undefined;
    try {
      const stats = await videoTrack.computePacketStats(30);
      if (stats.averagePacketRate > 40) frameRate = 30;
    } catch {
      frameRate = undefined;
    }

    const width = spec.width;
    const height = spec.height;
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
        frameRate,
        allowTransformationMetadata: false,
        hardwareAcceleration,
        keyFrameInterval: 2,
        quality: new Quality({ bitrate: 8_000_000, bitrateMode: "variable" }),
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
