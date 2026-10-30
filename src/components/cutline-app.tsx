import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Captions,
  Download,
  Film,
  Pause,
  Play,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { clsx } from "clsx";
import { cleanLines, suggestCut } from "@/lib/ai.functions";
import {
  cueAt,
  cueId,
  DEFAULT_LOOK,
  formatClock,
  FRAME_RATES,
  matchFps,
  matchQuality,
  outputSize,
  QUALITIES,
  splitCue,
  type CaptionCue,
  type CaptionPlace,
  type CaptionPlate,
  type CaptionSize,
  type FitMode,
  type FormatId,
  type FpsId,
  type Look,
  type QualityId,
} from "@/lib/captions";
import { exportCaptionedMp4, MAX_READ_SECONDS, probeFrameRate, readSpeech, saveToGallery } from "@/lib/media";
import { APP_VERSION, fetchUpdate, isNewer, type RemoteUpdate } from "@/lib/updates";

type Clip = {
  file: File;
  url: string;
  name: string;
  duration: number;
  width: number;
  height: number;
};

type Busy = "read" | "clean" | "cut" | "export" | null;

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}

function probe(url: string): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.playsInline = true;
    video.onloadedmetadata = () => {
      const duration = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;
      video.removeAttribute("src");
      video.load();
      if (!Number.isFinite(duration) || duration <= 0 || !width || !height) {
        reject(new Error("Couldn't read that video. Try an MP4 or MOV."));
        return;
      }
      resolve({ duration, width, height });
    };
    video.onerror = () => reject(new Error("That file didn't open as a video."));
    video.src = url;
  });
}

export function CutlineApp() {
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [hot, setHot] = useState(false);
  const [format, setFormat] = useState<FormatId>("long");
  const [quality, setQuality] = useState<QualityId>("1080");
  const [fps, setFps] = useState<FpsId>("30");
  const [recommendedQuality, setRecommendedQuality] = useState<QualityId | null>(null);
  const [recommendedFps, setRecommendedFps] = useState<FpsId | null>(null);
  const [sourceFps, setSourceFps] = useState<number | null>(null);
  const [fit, setFit] = useState<FitMode>("cover");
  const [look, setLook] = useState<Look>(DEFAULT_LOOK);
  const [cues, setCues] = useState<CaptionCue[]>([]);
  const [trimIn, setTrimIn] = useState(0);
  const [trimOut, setTrimOut] = useState(0);
  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [suggestion, setSuggestion] = useState<{ start: number; end: number; why: string } | null>(null);
  const [cleanFrom, setCleanFrom] = useState(0);
  const [update, setUpdate] = useState<RemoteUpdate | null>(null);
  const [upToDate, setUpToDate] = useState(false);
  const cuesRef = useRef(cues);
  const loadGen = useRef(0);
  const fpsTouched = useRef(false);
  cuesRef.current = cues;

  useEffect(() => {
    try {
      const raw = localStorage.getItem("cutline-look");
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Look>;
      if (parsed.place && parsed.plate && parsed.size) {
        setLook({ place: parsed.place, plate: parsed.plate, size: parsed.size });
      }
    } catch {
      /* ignore stored look */
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("cutline-look", JSON.stringify(look));
  }, [look]);

  useEffect(() => {
    let stopped = false;
    const check = () => {
      void fetchUpdate()
        .then((remote) => {
          if (stopped || !remote) return;
          if (!isNewer(remote.version, APP_VERSION)) {
            setUpdate(null);
            setUpToDate(true);
            return;
          }
          setUpToDate(false);
          if (localStorage.getItem("cutline-update-dismiss") === remote.version) {
            setUpdate(null);
            return;
          }
          setUpdate(remote);
        })
        .catch(() => {
          /* stay quiet if the update feed is unreachable */
        });
    };
    check();
    const timer = window.setInterval(check, 30 * 60 * 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clip) return;
    let frame = 0;
    const publish = () => {
      const time = video.currentTime;
      setClock((prev) => (Math.abs(prev - time) > 0.15 ? time : prev));
      const next = cueAt(cuesRef.current, time)?.id ?? null;
      setActiveId((prev) => (prev === next ? prev : next));
      if (time >= trimOut) {
        video.pause();
        video.currentTime = Math.max(trimIn, trimOut - 0.05);
      }
    };
    const loop = () => {
      publish();
      if (!video.paused) frame = requestAnimationFrame(loop);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(frame);
      loop();
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      publish();
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onPause);
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onPause);
    };
  }, [clip, trimIn, trimOut]);

  useEffect(() => {
    if (!activeId) return;
    document.getElementById(`cue-${activeId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !clip) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      event.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (video.currentTime < trimIn || video.currentTime >= trimOut - 0.05) {
        video.currentTime = trimIn;
      }
      void video.play();
    } else {
      video.pause();
    }
  }

  function seek(time: number) {
    const video = videoRef.current;
    if (!video || !clip) return;
    const next = Math.min(Math.max(time, 0), clip.duration);
    video.currentTime = next;
    setClock(next);
    setActiveId(cueAt(cuesRef.current, next)?.id ?? null);
  }

  async function takeFile(file: File | undefined) {
    if (!file) return;
    if (cues.length && !window.confirm("Replace this video and drop the lines?")) return;
    setError("");
    setStatus("");
    setSuggestion(null);
    const url = URL.createObjectURL(file);
    try {
      const meta = await probe(url);
      setClip((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { file, url, name: file.name, ...meta };
      });
      setTrimIn(0);
      setTrimOut(meta.duration);
      setFormat(meta.height > meta.width ? "short" : "long");
      const qualityMatch = matchQuality(meta.width, meta.height);
      setQuality(qualityMatch);
      setRecommendedQuality(qualityMatch);
      setRecommendedFps(null);
      setSourceFps(null);
      fpsTouched.current = false;
      const generation = loadGen.current + 1;
      loadGen.current = generation;
      setCues([]);
      setCleanFrom(0);
      setClock(0);
      setPlaying(false);
      setActiveId(null);
      void probeFrameRate(file).then((rate) => {
        if (loadGen.current !== generation || !rate) return;
        const matched = matchFps(rate);
        setSourceFps(rate);
        setRecommendedFps(matched);
        if (!fpsTouched.current) setFps(matched);
      });
    } catch (reason) {
      URL.revokeObjectURL(url);
      setError(messageOf(reason));
    }
  }

  function addCue() {
    if (!clip) return;
    const start = Math.min(clock, Math.max(trimIn, clip.duration - 0.4));
    const end = Math.min(clip.duration, Math.max(start + 2, trimOut > start ? Math.min(trimOut, start + 2) : start + 2));
    const cue: CaptionCue = { id: cueId(), start, end: Math.max(end, start + 0.4), text: "" };
    setCues((prev) => [...prev, cue].sort((a, b) => a.start - b.start));
    setActiveId(cue.id);
  }

  async function onRead() {
    if (!clip || busy) return;
    setBusy("read");
    setError("");
    setStatus("Pulling the speech…");
    setSuggestion(null);
    try {
      const result = await readSpeech(clip.file, trimIn, trimOut, (message) => {
        setStatus(message);
      });
      if (!result.cues.length) {
        setError(result.skipped || "No English speech in that section. Type a line at the playhead.");
        setStatus("");
        return;
      }
      setCues(result.cues);
      setCleanFrom(0);
      setStatus(
        result.skipped
          ? `${result.cues.length} English lines. ${result.skipped}`
          : `${result.cues.length} English lines. Punctuation and line breaks are already in.`,
      );
    } catch (reason) {
      setError(messageOf(reason));
      setStatus("");
    } finally {
      setBusy(null);
    }
  }

  async function onClean() {
    if (!clip || busy || !cues.length) return;
    setBusy("clean");
    setError("");
    const from = cleanFrom >= cues.length ? 0 : cleanFrom;
    const slice = cues.slice(from, from + 60);
    try {
      const result = await cleanLines({ data: { lines: slice.map((cue) => cue.text) } });
      if (!result.ok) throw new Error(result.error);
      setCues((prev) =>
        prev.map((cue, index) => {
          const local = index - from;
          if (local < 0 || local >= result.lines.length) return cue;
          return { ...cue, text: result.lines[local] };
        }),
      );
      const nextFrom = from + slice.length >= cues.length ? 0 : from + slice.length;
      setCleanFrom(nextFrom);
      setStatus(
        nextFrom === 0
          ? "Lines cleaned. Read them once more."
          : `Cleaned ${from + 1}–${from + slice.length}. Tap again for the rest.`,
      );
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  async function onSuggest() {
    if (!clip || busy || !cues.length) return;
    setBusy("cut");
    setError("");
    try {
      const sampled =
        cues.length <= 80
          ? cues.map(({ start, end, text }) => ({ start, end, text }))
          : Array.from({ length: 80 }, (_, index) => {
              const cue = cues[Math.floor((index * cues.length) / 80)];
              return { start: cue.start, end: cue.end, text: cue.text };
            });
      const result = await suggestCut({ data: { duration: clip.duration, cues: sampled } });
      if (!result.ok) throw new Error(result.error);
      setSuggestion({ start: result.start, end: result.end, why: result.why });
      setStatus("A cut is ready. Apply it, or ignore it.");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  async function onExport() {
    if (!clip || busy) return;
    setBusy("export");
    setError("");
    const label = QUALITIES[quality].label;
    const long = trimOut - trimIn > 8 * 60;
    setStatus(
      long
        ? `Encoding ${label} at ${fps} fps. Long videos stay in memory — keep this tab open.`
        : `Encoding ${label} at ${fps} fps…`,
    );
    try {
      const blob = await exportCaptionedMp4({
        file: clip.file,
        format,
        fit,
        look,
        quality,
        fps,
        cues,
        trimStart: trimIn,
        trimEnd: trimOut,
        onProgress: (ratio) => {
          setStatus(`Encoding ${label} · ${Math.round(ratio * 100)}%`);
        },
      });
      const filename = `cutline-${format}-${label}-${fps}fps.mp4`;
      const saved = await saveToGallery(blob, filename);
      setStatus(
        saved === "shared"
          ? "Pick Gallery or Photos in the share sheet to keep the video."
          : "Saved to your downloads. On a phone, share that file into Gallery.",
      );
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") {
        setStatus("Save cancelled.");
        return;
      }
      setError(messageOf(reason));
      setStatus("");
    } finally {
      setBusy(null);
    }
  }

  const active = cues.find((cue) => cue.id === activeId);
  const readSpan = Math.max(0, trimOut - trimIn);

  return (
    <div className="min-h-dvh bg-ink text-paper">
      <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 pt-5 pb-28 md:px-8 md:pb-10">
        <header className="mb-6 flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium tracking-[0.18em] text-amber uppercase">Edit bay</p>
            <h1 className="font-display text-4xl leading-none font-medium text-paper">Cutline</h1>
            <p className="mt-2 text-xs text-mist">
              v{APP_VERSION}
              {upToDate ? " · Up to date" : ""}
              {" · © 2026 Cutline. All rights reserved."}
            </p>
          </div>
          {clip ? (
            <button
              type="button"
              className="inline-flex h-11 items-center gap-2 rounded-full bg-bay-2 px-4 text-sm ring-hairline"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="size-4" aria-hidden="true" />
              New video
            </button>
          ) : null}
        </header>

        {update ? (
          <div
            role="status"
            className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-card bg-bay px-4 py-3 ring-hairline"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-paper">Update {update.version} is ready</p>
              {update.notes ? <p className="mt-1 text-sm text-mist">{update.notes}</p> : null}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="inline-flex h-11 items-center rounded-full bg-bay-2 px-4 text-sm ring-hairline"
                onClick={() => {
                  localStorage.setItem("cutline-update-dismiss", update.version);
                  setUpdate(null);
                }}
              >
                Later
              </button>
              <button
                type="button"
                className="inline-flex h-11 items-center rounded-full bg-amber px-4 text-sm font-medium text-ink"
                onClick={() => {
                  localStorage.removeItem("cutline-update-dismiss");
                  window.location.reload();
                }}
              >
                Update now
              </button>
            </div>
          </div>
        ) : null}

        <input
          ref={fileRef}
          className="sr-only"
          type="file"
          accept="video/*,.mp4,.mov,.webm,.mkv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void takeFile(file);
          }}
        />

        {clip ? (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)]">
            <section className="min-w-0">
              <div className={clsx("stage mx-auto rounded-card", format === "short" ? "stage-short" : "stage-long")}>
                <video
                  ref={videoRef}
                  src={clip.url}
                  playsInline
                  preload="auto"
                  className={clsx("size-full", fit === "cover" ? "object-cover" : "object-contain")}
                  onClick={togglePlay}
                />
                {active?.text.trim() ? (
                  <div
                    className={clsx(
                      "pointer-events-none absolute inset-x-[7%] flex justify-center",
                      look.place === "top" && "top-[12%]",
                      look.place === "middle" && "top-1/2 -translate-y-1/2",
                      look.place === "bottom" && (format === "short" ? "bottom-[18%]" : "bottom-[10%]"),
                    )}
                  >
                    <p className="caption-text" data-size={look.size} data-plate={look.plate}>
                      {active.text}
                    </p>
                  </div>
                ) : null}
                <button
                  type="button"
                  aria-label={playing ? "Pause" : "Play"}
                  onClick={togglePlay}
                  className="absolute bottom-3 left-3 inline-flex size-11 items-center justify-center rounded-full bg-ink/80 text-paper ring-hairline"
                >
                  {playing ? (
                    <Pause className="size-5" aria-hidden="true" />
                  ) : (
                    <Play className="ml-0.5 size-5" aria-hidden="true" />
                  )}
                </button>
                <p className="pointer-events-none absolute right-3 bottom-3 rounded-full bg-ink/80 px-3 py-1 text-sm tabular-nums ring-hairline">
                  {formatClock(clock)} / {formatClock(clip.duration)}
                </p>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <Segment
                  label="Frame"
                  value={format}
                  onChange={setFormat}
                  options={[
                    { id: "short", label: "Short", detail: sizeLabel("short", quality) },
                    { id: "long", label: "Long", detail: sizeLabel("long", quality) },
                  ]}
                />
                <Segment
                  label="Fit"
                  value={fit}
                  onChange={setFit}
                  options={[
                    { id: "cover", label: "Fill" },
                    { id: "contain", label: "Fit" },
                  ]}
                />
              </div>

              <ChoiceRow
                label="Quality"
                value={quality}
                onChange={setQuality}
                options={(Object.keys(QUALITIES) as QualityId[]).map((id) => ({
                  id,
                  label: QUALITIES[id].label,
                  hint: id === recommendedQuality ? "Recommended" : undefined,
                }))}
              />
              <ChoiceRow
                label="Frame rate"
                value={fps}
                onChange={(next) => {
                  fpsTouched.current = true;
                  setFps(next);
                }}
                options={FRAME_RATES.map((id) => ({
                  id,
                  label: `${id} fps`,
                  hint: id === recommendedFps ? "Recommended" : undefined,
                }))}
              />
              <p className="mt-2 text-sm text-mist">
                Recommended follows this video
                {sourceFps ? ` · ${prettyRate(sourceFps)} fps` : ""}. You can still pick another size or frame rate.
              </p>

              <div className="mt-4 rounded-card bg-bay p-4 ring-hairline">
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <h2 className="text-sm font-medium tracking-wide text-mist uppercase">Trim</h2>
                  <p className="text-sm tabular-nums text-paper">{formatClock(readSpan)} selected</p>
                </div>
                <label className="mb-1 block text-sm text-mist" htmlFor="trim-in">
                  In {formatClock(trimIn)}
                </label>
                <input
                  id="trim-in"
                  type="range"
                  min={0}
                  max={clip.duration}
                  step={0.1}
                  value={trimIn}
                  onChange={(event) => setTrimIn(Math.min(Number(event.target.value), trimOut - 0.2))}
                />
                <label className="mt-2 mb-1 block text-sm text-mist" htmlFor="trim-out">
                  Out {formatClock(trimOut)}
                </label>
                <input
                  id="trim-out"
                  className="w-full"
                  type="range"
                  min={0}
                  max={clip.duration}
                  step={0.1}
                  value={trimOut}
                  onChange={(event) => setTrimOut(Math.max(Number(event.target.value), trimIn + 0.2))}
                />
                {readSpan > MAX_READ_SECONDS ? (
                  <p className="mt-2 text-sm text-amber">
                    Speech reading stops at 30 minutes. Pull the out point in, or type the rest.
                  </p>
                ) : null}
                {suggestion ? (
                  <div className="mt-3 rounded-xl bg-bay-2 p-3">
                    <p className="text-sm text-paper">{suggestion.why}</p>
                    <p className="mt-1 text-sm tabular-nums text-mist">
                      {formatClock(suggestion.start)} – {formatClock(suggestion.end)}
                    </p>
                    <button
                      type="button"
                      className="mt-2 inline-flex h-11 items-center rounded-full bg-amber px-4 text-sm font-medium text-ink"
                      onClick={() => {
                        setTrimIn(suggestion.start);
                        setTrimOut(Math.max(suggestion.end, suggestion.start + 0.2));
                        setSuggestion(null);
                        setStatus("Trim updated.");
                      }}
                    >
                      Apply cut
                    </button>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="min-w-0">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-medium">{clip.name}</h2>
                  <p className="text-sm text-mist tabular-nums">
                    {clip.width}×{clip.height}
                    {sourceFps ? ` · ${prettyRate(sourceFps)} fps` : ""} · {formatClock(clip.duration)}
                  </p>
                </div>
                <button
                  type="button"
                  className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-bay-2 px-4 text-sm ring-hairline"
                  onClick={addCue}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  Line
                </button>
              </div>

              {error ? (
                <p role="alert" className="mb-3 rounded-xl bg-bay-2 px-3 py-2 text-sm text-amber">
                  {error}
                </p>
              ) : null}
              {status ? (
                <p role="status" className="mb-3 text-sm text-mist">
                  {status}
                </p>
              ) : null}

              {cues.length === 0 ? (
                <div className="rounded-card bg-bay px-4 py-8 text-center ring-hairline">
                  <Captions className="mx-auto mb-3 size-6 text-amber" aria-hidden="true" />
                  <p className="text-paper">No lines yet.</p>
                  <p className="mt-1 text-sm text-mist">
                    Detects the language, keeps the English, and writes the captions.
                  </p>
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {cues.map((cue) => (
                    <li
                      key={cue.id}
                      id={`cue-${cue.id}`}
                      className={clsx("rounded-card bg-bay p-3 ring-hairline", cue.id === activeId && "cue-live")}
                    >
                      <div className="mb-2 flex items-center gap-2">
                        <button
                          type="button"
                          className="text-sm tabular-nums text-amber"
                          onClick={() => seek(cue.start)}
                        >
                          {formatClock(cue.start)}
                        </button>
                        <span className="text-mist">–</span>
                        <button
                          type="button"
                          className="text-sm tabular-nums text-mist"
                          onClick={() => seek(cue.end)}
                        >
                          {formatClock(cue.end)}
                        </button>
                        <span className="ml-auto flex gap-1">
                          <IconButton
                            label="Split at playhead"
                            onClick={() => {
                              const parts = splitCue(cue, clock);
                              if (!parts) {
                                setError("Park the playhead inside the line to split it.");
                                return;
                              }
                              setError("");
                              setCues((prev) =>
                                prev.flatMap((item) => (item.id === cue.id ? parts : item)),
                              );
                            }}
                          >
                            <Scissors className="size-4" aria-hidden="true" />
                          </IconButton>
                          <IconButton
                            label="Delete line"
                            onClick={() => setCues((prev) => prev.filter((item) => item.id !== cue.id))}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </IconButton>
                        </span>
                      </div>
                      <textarea
                        aria-label={`Caption at ${formatClock(cue.start)}`}
                        value={cue.text}
                        rows={2}
                        className="w-full resize-none rounded-xl bg-ink px-3 py-2 text-base text-paper ring-hairline"
                        onChange={(event) => {
                          const text = event.target.value;
                          setCues((prev) => prev.map((item) => (item.id === cue.id ? { ...item, text } : item)));
                        }}
                      />
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <label className="text-xs text-mist">
                          Start
                          <input
                            type="number"
                            min={0}
                            max={clip.duration}
                            step={0.1}
                            value={Number(cue.start.toFixed(1))}
                            className="mt-1 h-11 w-full rounded-xl bg-ink px-3 tabular-nums ring-hairline"
                            onChange={(event) => {
                              const start = Number(event.target.value);
                              if (!Number.isFinite(start)) return;
                              setCues((prev) =>
                                prev.map((item) =>
                                  item.id === cue.id
                                    ? { ...item, start: Math.max(0, Math.min(start, item.end - 0.1)) }
                                    : item,
                                ),
                              );
                            }}
                          />
                        </label>
                        <label className="text-xs text-mist">
                          End
                          <input
                            type="number"
                            min={0}
                            max={clip.duration}
                            step={0.1}
                            value={Number(cue.end.toFixed(1))}
                            className="mt-1 h-11 w-full rounded-xl bg-ink px-3 tabular-nums ring-hairline"
                            onChange={(event) => {
                              const end = Number(event.target.value);
                              if (!Number.isFinite(end)) return;
                              setCues((prev) =>
                                prev.map((item) =>
                                  item.id === cue.id
                                    ? { ...item, end: Math.min(clip.duration, Math.max(end, item.start + 0.1)) }
                                    : item,
                                ),
                              );
                            }}
                          />
                        </label>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <details className="mt-4 rounded-card bg-bay p-4 ring-hairline">
                <summary className="flex h-11 cursor-pointer items-center justify-between text-sm font-medium">
                  Caption look
                  <span className="text-mist">
                    {look.place} · {look.plate}
                  </span>
                </summary>
                <div className="mt-3 grid gap-3">
                  <Segment
                    label="Position"
                    value={look.place}
                    onChange={(place) => setLook((prev) => ({ ...prev, place }))}
                    options={[
                      { id: "bottom" as CaptionPlace, label: "Bottom" },
                      { id: "middle" as CaptionPlace, label: "Middle" },
                      { id: "top" as CaptionPlace, label: "Top" },
                    ]}
                  />
                  <Segment
                    label="Plate"
                    value={look.plate}
                    onChange={(plate) => setLook((prev) => ({ ...prev, plate }))}
                    options={[
                      { id: "outline" as CaptionPlate, label: "Stroke" },
                      { id: "bar" as CaptionPlate, label: "Bar" },
                    ]}
                  />
                  <Segment
                    label="Size"
                    value={look.size}
                    onChange={(size) => setLook((prev) => ({ ...prev, size }))}
                    options={[
                      { id: "s" as CaptionSize, label: "S" },
                      { id: "m" as CaptionSize, label: "M" },
                      { id: "l" as CaptionSize, label: "L" },
                    ]}
                  />
                  <p className="text-sm text-mist">
                    Cleanup rewrites the words. It does not restyle or regenerate the picture.
                  </p>
                </div>
              </details>
            </section>
          </div>
        ) : (
          <Landing hot={hot} setHot={setHot} onPick={() => fileRef.current?.click()} onFile={(file) => void takeFile(file)} error={error} />
        )}
      </div>

      {clip ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-ink/95 px-4 py-3 backdrop-blur md:static md:mx-auto md:w-full md:max-w-6xl md:border-0 md:bg-transparent md:px-8 md:pb-8">
          <div className="mx-auto grid max-w-6xl grid-cols-2 gap-2 md:grid-cols-4">
            <Action
              disabled={!!busy}
              onClick={() => void onRead()}
              label={busy === "read" ? "Reading" : "Read English"}
              icon={<Captions className="size-4" aria-hidden="true" />}
              primary
            />
            <Action
              disabled={!!busy || cues.length === 0}
              onClick={() => void onClean()}
              label={busy === "clean" ? "Cleaning" : "Clean lines"}
              icon={<Sparkles className="size-4" aria-hidden="true" />}
            />
            <Action
              disabled={!!busy || cues.length === 0}
              onClick={() => void onSuggest()}
              label={busy === "cut" ? "Thinking" : "Suggest cut"}
              icon={<Scissors className="size-4" aria-hidden="true" />}
            />
            <Action
              disabled={!!busy}
              onClick={() => void onExport()}
              label={busy === "export" ? "Saving" : "Save"}
              icon={<Download className="size-4" aria-hidden="true" />}
              primary
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Landing({
  hot,
  setHot,
  onPick,
  onFile,
  error,
}: {
  hot: boolean;
  setHot: (hot: boolean) => void;
  onPick: () => void;
  onFile: (file: File) => void;
  error: string;
}) {
  return (
    <main>
      <p className="max-w-xl text-lg text-mist">
        Drop an edited video. Cutline reads the spoken English, lets you fix every line, then exports a captioned
        1080p MP4 — vertical for Shorts, or wide for YouTube.
      </p>
      <button
        type="button"
        onClick={onPick}
        onDragOver={(event) => {
          event.preventDefault();
          setHot(true);
        }}
        onDragLeave={() => setHot(false)}
        onDrop={(event) => {
          event.preventDefault();
          setHot(false);
          const file = event.dataTransfer.files[0];
          if (file) onFile(file);
        }}
        className={clsx(
          "mt-6 flex w-full flex-col items-center justify-center rounded-card border border-dashed px-6 py-16 text-center",
          hot ? "border-amber bg-bay" : "border-line bg-bay",
        )}
      >
        <Film className="mb-4 size-8 text-amber" aria-hidden="true" />
        <span className="font-display text-3xl text-paper">Bring a video</span>
        <span className="mt-2 text-sm text-mist">MP4, MOV, or WebM from your gallery. The picture stays on this device.</span>
      </button>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-amber">
          {error}
        </p>
      ) : null}
      <ol className="mt-8 grid gap-3 md:grid-cols-3">
        {[
          ["01", "Frame it", "Short is vertical. Long is wide. Pick 4K down to 240p, and 120 fps down to 15."],
          ["02", "Read the English", "Language is detected first. Only English is written into timed captions."],
          ["03", "Save it", "Captions are burned in. The share sheet can drop the MP4 into your gallery."],
        ].map(([index, title, copy]) => (
          <li key={index} className="rounded-card bg-bay p-4 ring-hairline">
            <p className="font-display text-amber">{index}</p>
            <h2 className="mt-2 text-lg font-medium">{title}</h2>
            <p className="mt-1 text-sm text-mist">{copy}</p>
          </li>
        ))}
      </ol>
      <p className="mt-6 max-w-xl text-sm text-mist">
        Use it in Chrome on your phone. A chat model can't cut or render the picture — trims, framing, and the file
        are made here. Speech is sent only when you tap Read English.
      </p>
    </main>
  );
}

function prettyRate(rate: number): string {
  const rounded = Math.round(rate);
  return Math.abs(rate - rounded) < 0.15 ? String(rounded) : rate.toFixed(1);
}

function sizeLabel(format: FormatId, quality: QualityId): string {
  const size = outputSize(format, quality);
  return `${size.width}×${size.height}`;
}

function Segment<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; detail?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={clsx(
        "grid gap-1 rounded-full bg-bay-2 p-1 ring-hairline",
        options.length === 3 ? "grid-cols-3" : "grid-cols-2",
      )}
    >
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(option.id)}
            className={clsx(
              "min-h-11 rounded-full px-2 py-1 text-sm",
              on ? "bg-amber font-medium text-ink" : "text-mist",
            )}
          >
            {option.label}
            {option.detail ? (
              <span className={clsx("block text-xs tabular-nums", on ? "text-ink/70" : "text-mist")}>
                {option.detail}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function ChoiceRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="mt-3">
      <p className="mb-2 text-sm font-medium tracking-wide text-mist uppercase">{label}</p>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const on = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(option.id)}
              className={clsx(
                "inline-flex h-11 items-center gap-2 rounded-full px-3 text-sm",
                on ? "bg-amber font-medium text-ink" : "bg-bay-2 text-mist ring-hairline",
              )}
            >
              {option.label}
              {option.hint ? (
                <span className={clsx("text-xs", on ? "text-ink/70" : "text-amber")}>{option.hint}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Action({
  label,
  icon,
  onClick,
  disabled,
  primary,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "inline-flex h-12 items-center justify-center gap-2 rounded-full px-3 text-sm font-medium",
        primary ? "bg-amber text-ink" : "bg-bay-2 text-paper ring-hairline",
        disabled && "opacity-45",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex size-11 items-center justify-center rounded-full text-mist hover:text-paper"
    >
      {children}
    </button>
  );
}
