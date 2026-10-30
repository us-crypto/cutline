import type { CaptionPlate, CaptionPlace, CaptionSize, FormatId, Look } from "@/lib/captions";

const SIZE: Record<CaptionSize, number> = { s: 0.034, m: 0.044, l: 0.056 };

function anchorY(place: CaptionPlace, format: FormatId, height: number, block: number): number {
  if (place === "middle") return (height - block) / 2;
  if (place === "top") return height * 0.12;
  return height * (format === "short" ? 0.7 : 0.78) - block;
}

export function paintCaption(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  words: string[],
  activeIndex: number,
  look: Look,
  format: FormatId,
) {
  const tokens = words.map((word) => word.trim()).filter(Boolean);
  if (!tokens.length) return;
  const fontSize = Math.max(18, Math.round(height * SIZE[look.size]));
  ctx.font = `600 ${fontSize}px Outfit, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const maxWidth = width * 0.86;
  const space = ctx.measureText(" ").width;
  const lines: { text: string; index: number; x: number; width: number }[][] = [];
  let line: { text: string; index: number; x: number; width: number }[] = [];
  let lineWidth = 0;
  tokens.forEach((text, index) => {
    const wordWidth = ctx.measureText(text).width;
    const next = line.length ? lineWidth + space + wordWidth : wordWidth;
    if (line.length && next > maxWidth) {
      lines.push(line);
      line = [];
      lineWidth = 0;
    }
    const x = line.length ? lineWidth + space : 0;
    line.push({ text, index, x, width: wordWidth });
    lineWidth = x + wordWidth;
  });
  if (line.length) lines.push(line);
  const shown = lines.slice(0, 3);
  if (!shown.length) return;
  const lineHeight = fontSize * 1.25;
  const block = shown.length * lineHeight;
  const top = Math.max(fontSize, Math.min(height - block - fontSize, anchorY(look.place, format, height, block)));
  const plate: CaptionPlate = look.plate;
  const widest = Math.max(...shown.map((row) => row[row.length - 1].x + row[row.length - 1].width));

  if (plate === "bar") {
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

  shown.forEach((row, lineIndex) => {
    const rowWidth = row[row.length - 1].x + row[row.length - 1].width;
    const origin = (width - rowWidth) / 2;
    const y = top + lineIndex * lineHeight;
    row.forEach((word) => {
      const x = origin + word.x;
      if (word.index === activeIndex) {
        const padX = fontSize * 0.14;
        const padY = fontSize * 0.06;
        ctx.fillStyle = "#e39b12";
        ctx.beginPath();
        ctx.roundRect(x - padX, y - padY, word.width + padX * 2, fontSize + padY * 2, fontSize * 0.16);
        ctx.fill();
        ctx.fillStyle = "#12110e";
        ctx.fillText(word.text, x, y);
        return;
      }
      if (plate === "outline") {
        ctx.lineWidth = Math.max(2, fontSize * 0.14);
        ctx.strokeStyle = "#12110e";
        ctx.lineJoin = "round";
        ctx.strokeText(word.text, x, y);
      }
      ctx.fillStyle = "#f4efe4";
      ctx.fillText(word.text, x, y);
    });
  });
}
