import type { Doc } from './doc';
import { createCanvas, ctxOf } from './layer';

/** 描いている途中のストロークや図形。確定するまでレイヤーには書き込まない */
export interface LiveOverlay {
  layerId: number;
  canvas: HTMLCanvasElement;
  alpha: number;
  mode: GlobalCompositeOperation;
}

/** レイヤーを重ねて 1 枚の画像にする */
export class Compositor {
  readonly canvas = createCanvas(1, 1);
  private scratch = createCanvas(1, 1);

  render(doc: Doc, live: LiveOverlay | null = null): HTMLCanvasElement {
    const { width, height } = doc;
    for (const c of [this.canvas, this.scratch]) {
      if (c.width !== width || c.height !== height) {
        c.width = width;
        c.height = height;
      }
    }
    const out = ctxOf(this.canvas);
    out.clearRect(0, 0, width, height);
    for (const layer of doc.layers) {
      if (!layer.visible) continue;
      let src = layer.canvas;
      if (live && live.layerId === layer.id) {
        const s = ctxOf(this.scratch);
        s.clearRect(0, 0, width, height);
        s.drawImage(layer.canvas, 0, 0);
        s.globalAlpha = live.alpha;
        s.globalCompositeOperation = live.mode;
        s.drawImage(live.canvas, 0, 0);
        s.globalAlpha = 1;
        s.globalCompositeOperation = 'source-over';
        src = this.scratch;
      }
      out.globalAlpha = layer.opacity;
      out.globalCompositeOperation = layer.blend;
      out.drawImage(src, layer.x, layer.y);
    }
    out.globalAlpha = 1;
    out.globalCompositeOperation = 'source-over';
    return this.canvas;
  }
}

/** 書き出し用に、別の canvas へ統合する。background を渡すと下地を塗る（JPEG 用） */
export function flatten(doc: Doc, background: string | null = null): HTMLCanvasElement {
  const merged = new Compositor().render(doc);
  if (!background) return merged;
  const out = createCanvas(doc.width, doc.height);
  const ctx = ctxOf(out);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, doc.width, doc.height);
  ctx.drawImage(merged, 0, 0);
  return out;
}
