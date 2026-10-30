export type FormatId = "short" | "long";
export type FitMode = "cover" | "contain";
export type CaptionPlace = "bottom" | "middle" | "top";
export type CaptionPlate = "outline" | "bar";
export type CaptionSize = "s" | "m" | "l";

export type CaptionCue = {
  id: string;
  start: number;
  end: number;
  text: string;
};

export type Word = {
  text: string;
  start: number;
  end: number;
};

export type Look = {
  place: CaptionPlace;
  plate: CaptionPlate;
  size: CaptionSize;
};

export const FORMATS = {
  short: { label: "Short", detail: "1080×1920", width: 1080, height: 1920 },
  long: { label: "Long", detail: "1920×1080", width: 1920, height: 1080 },
} as const;

export const DEFAULT_LOOK: Look = {
  place: "bottom",
  plate: "outline",
  size: "m",
};

let cueSerial = 0;

export function cueId(): string {
  cueSerial += 1;
  return `c${cueSerial}-${Math.random().toString(36).slice(2, 7)}`;
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const mins = Math.floor(seconds / 60);
  const secs = seconds - mins * 60;
  return `${mins}:${secs.toFixed(1).padStart(4, "0")}`;
}

export function cueAt(cues: CaptionCue[], time: number): CaptionCue | undefined {
  return cues.find((cue) => time >= cue.start && time < cue.end);
}

export function wordsToCues(words: Word[]): CaptionCue[] {
  const maxChars = 42;
  const maxDur = 4;
  const gapLimit = 0.4;
  const cues: CaptionCue[] = [];
  let buf: Word[] = [];

  const flush = () => {
    if (!buf.length) return;
    const text = buf
      .map((word) => word.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      const start = buf[0].start;
      const end = Math.max(buf[buf.length - 1].end, start + 0.35);
      cues.push({ id: cueId(), start, end, text });
    }
    buf = [];
  };

  for (const raw of words) {
    const token = raw.text.trim();
    if (!token || !Number.isFinite(raw.start) || !Number.isFinite(raw.end)) continue;
    const word = { text: token, start: raw.start, end: Math.max(raw.end, raw.start + 0.05) };
    if (!buf.length) {
      buf.push(word);
      continue;
    }
    const prev = buf[buf.length - 1];
    const joined = `${buf.map((item) => item.text).join(" ")} ${word.text}`;
    const gap = word.start - prev.end;
    const dur = word.end - buf[0].start;
    const sentence = /[.!?…]$/.test(prev.text);
    if (gap > gapLimit || joined.length > maxChars || dur > maxDur || (sentence && buf.length >= 3)) {
      flush();
    }
    buf.push(word);
  }
  flush();

  for (let i = 0; i < cues.length - 1; i++) {
    const gap = cues[i + 1].start - cues[i].end;
    if (gap > 0 && gap < 0.2) cues[i].end = cues[i + 1].start;
  }
  return cues;
}

export function splitCue(cue: CaptionCue, at: number): [CaptionCue, CaptionCue] | null {
  if (at <= cue.start + 0.12 || at >= cue.end - 0.12) return null;
  const words = cue.text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return [
      { id: cueId(), start: cue.start, end: at, text: cue.text },
      { id: cueId(), start: at, end: cue.end, text: cue.text },
    ];
  }
  const ratio = (at - cue.start) / (cue.end - cue.start);
  const count = Math.min(words.length - 1, Math.max(1, Math.round(words.length * ratio)));
  return [
    { id: cueId(), start: cue.start, end: at, text: words.slice(0, count).join(" ") },
    { id: cueId(), start: at, end: cue.end, text: words.slice(count).join(" ") },
  ];
}
