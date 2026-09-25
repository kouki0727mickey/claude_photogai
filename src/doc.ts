import { ctxOf, newRasterLayer, type Layer } from './layer';

/** 編集中の画像。layers は下から上の順 */
export class Doc {
  layers: Layer[] = [];
  activeId = 0;
  name = '無題';

  constructor(
    public width: number,
    public height: number,
  ) {}

  static create(width: number, height: number, background: string | null): Doc {
    const doc = new Doc(width, height);
    const layer = newRasterLayer(width, height, '背景');
    if (background) {
      const ctx = ctxOf(layer.canvas);
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    doc.layers.push(layer);
    doc.activeId = layer.id;
    return doc;
  }

  get active(): Layer | undefined {
    return this.layers.find((l) => l.id === this.activeId);
  }

  indexOf(id: number): number {
    return this.layers.findIndex((l) => l.id === id);
  }

  insertAboveActive(layer: Layer): void {
    const i = this.indexOf(this.activeId);
    this.layers.splice(i + 1, 0, layer);
    this.activeId = layer.id;
  }
}
