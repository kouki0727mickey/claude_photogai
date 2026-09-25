import type { Doc } from './doc';
import { copyCanvas, renderText, type Layer } from './layer';

type LayerState = Omit<Layer, 'canvas'> & { bitmap: HTMLCanvasElement };

interface Snapshot {
  layers: LayerState[];
  activeId: number;
}

/** レイヤーの並び・設定・画像（version）がすべて同じか */
function sameLayers(a: Snapshot, b: Snapshot): boolean {
  const meta = (s: Snapshot) => JSON.stringify(s.layers.map(({ bitmap: _, ...m }) => m));
  return meta(a) === meta(b);
}

/**
 * 元に戻す・やり直す。確定した状態ごとにスナップショットを持つ。
 * version が前回と同じレイヤーは画像を共有するので、変更したレイヤーの分だけメモリを使う。
 */
export class History {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private current: Snapshot;

  constructor(
    private doc: Doc,
    private limit = 50,
  ) {
    this.current = this.capture(null);
  }

  reset(doc: Doc): void {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.current = this.capture(null);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 変更がなければ履歴を積まずに false を返す */
  commit(): boolean {
    const next = this.capture(this.current);
    if (sameLayers(next, this.current)) {
      this.current.activeId = next.activeId;
      return false;
    }
    this.undoStack.push(this.current);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.current = next;
    this.redoStack = [];
    return true;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.current);
    this.current = prev;
    this.restore(prev);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.current);
    this.current = next;
    this.restore(next);
    return true;
  }

  private capture(prev: Snapshot | null): Snapshot {
    const prevById = new Map(prev?.layers.map((s) => [s.id, s]));
    const layers = this.doc.layers.map((layer): LayerState => {
      const { canvas, ...meta } = layer;
      const p = prevById.get(layer.id);
      const bitmap = p && p.version === layer.version ? p.bitmap : copyCanvas(canvas);
      return { ...meta, text: meta.text && { ...meta.text }, bitmap };
    });
    return { layers, activeId: this.doc.activeId };
  }

  private restore(s: Snapshot): void {
    this.doc.layers = s.layers.map(({ bitmap, ...meta }) => {
      const layer: Layer = { ...meta, text: meta.text && { ...meta.text }, canvas: copyCanvas(bitmap) };
      if (layer.text) {
        // 保存時にはフォントが届いていなかったかもしれないので、文字は設定から描き直す。
        // 中身は同じ設定なので version は戻して、次の履歴で複製しないようにする
        renderText(layer);
        layer.version = meta.version;
      }
      return layer;
    });
    this.doc.activeId = this.doc.indexOf(s.activeId) >= 0 ? s.activeId : (this.doc.layers.at(-1)?.id ?? 0);
  }
}
