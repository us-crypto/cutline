import type { CaptionPlate, CaptionPlace, CaptionSize, FormatId, Look } from "@/lib/captions";

const SIZE: Record<CaptionSize, number> = { s: 0.034, m: 0.044, l: 0.056 };

function wrap(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

function anchorY(place: CaptionPlace, format: FormatId, height: number, block: number): number {
  if (place === "middle") return (height - block) / 2;
  if (place === "top") return height * 0.12;
  return height * (format === "short" ? 0.7 : 0.78) - block;
}

export function paintCaption(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  look: Look,
  format: FormatId,
) {
  const fontSize = Math.max(18, Math.round(height * SIZE[look.size]));
  ctx.font = `600 ${fontSize}px Outfit, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const maxWidth = width * 0.86;
  const lines = wrap(ctx, text, maxWidth);
  if (!lines.length) return;
  const lineHeight = fontSize * 1.25;
  const block = lines.length * lineHeight;
  const top = Math.max(fontSize, Math.min(height - block - fontSize, anchorY(look.place, format, height, block)));
  const plate: CaptionPlate = look.plate;

  if (plate === "bar") {
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const padX = fontSize * 0.5;
    const padY = fontSize * 0.32;
    const boxW = widest + padX * 2;
    const boxH = block + padY * 2;
    const x = (width - boxW) / 2;
    const y = top - padY;
    ctx.fillStyle = "rgba(18, 17, 14, 0.72)";
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, fontSize * 0.35);
    ctx.fill();
  }

  lines.forEach((line, index) => {
    const y = top + index * lineHeight;
    const x = width / 2;
    if (plate === "outline") {
      ctx.lineWidth = Math.max(2, fontSize * 0.14);
      ctx.strokeStyle = "#12110e";
      ctx.lineJoin = "round";
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = "#f4efe4";
    ctx.fillText(line, x, y);
  });
}
