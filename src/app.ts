import { Compositor, type LiveOverlay } from './compositor';
import { Doc } from './doc';
import { applyAdjustments, floodFill, hexToRgb, rgbToHex, type Adjustments } from './filters';
import { History } from './history';
import { exportImage, fileToImage, loadProject, PROJECT_EXT, saveProject } from './io';
import {
  BLEND_MODES,
  cloneLayer,
  createCanvas,
  ctxOf,
  DEFAULT_TEXT,
  FONTS,
  newRasterLayer,
  newTextLayer,
  renderText,
  textOrigin,
  touch,
  type Layer,
  type TextProps,
} from './layer';

type Tool = 'move' | 'brush' | 'eraser' | 'fill' | 'rect' | 'ellipse' | 'text' | 'eyedropper';

type Point = { x: number; y: number };

type Drag =
  | { kind: 'pan'; startX: number; startY: number; panX: number; panY: number }
  | { kind: 'move'; start: Point; layerX: number; layerY: number; moved: boolean }
  | { kind: 'stroke'; last: Point }
  | { kind: 'shape'; start: Point }
  | { kind: 'pick' };

const TOOL_KEYS: Record<string, Tool> = {
  v: 'move',
  b: 'brush',
  e: 'eraser',
  g: 'fill',
  u: 'rect',
  o: 'ellipse',
  t: 'text',
  i: 'eyedropper',
};

const SWATCHES = ['#ffffff', '#000000', '#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#5e5ce6', '#ff2d92', '#8e8e93'];

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`要素がありません: ${selector}`);
  return el;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

export class App {
  private doc: Doc;
  private history: History;
  private compositor = new Compositor();
  private view = $<HTMLCanvasElement>('#view');
  private viewCtx = ctxOf(this.view);
  private stage = $('#stage');
  private checker: CanvasPattern | null = null;

  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private dpr = window.devicePixelRatio || 1;

  private tool: Tool = 'brush';
  private color = '#ff3b30';
  private size = 12;
  private opacity = 1;
  private tolerance = 32;
  private shapeFill = true;

  private liveCanvas = createCanvas(1, 1);
  private live: LiveOverlay | null = null;
  private drag: Drag | null = null;
  private pointer: Point | null = null;
  private spaceDown = false;
  private dirty = false;
  private renderQueued = false;

  constructor() {
    this.doc = Doc.create(1280, 720, '#ffffff');
    this.history = new History(this.doc);
    this.bindTopbar();
    this.bindToolOptions();
    this.bindTextOptions();
    this.bindLayerPanel();
    this.bindCanvas();
    this.bindKeys();
    this.bindFiles();
    this.bindDialogs();
    new ResizeObserver(() => this.resize()).observe(this.stage);
    this.resize();
    this.fit();
    this.setTool('brush');
    this.syncAll();
    // Web フォントが後から届いたら、文字レイヤーを描き直す
    document.fonts.addEventListener('loadingdone', () => this.rerenderTexts());
    window.addEventListener('beforeunload', (e) => {
      if (this.dirty) e.preventDefault();
    });
  }

  // ───────────── ドキュメントと履歴 ─────────────

  private setDoc(doc: Doc): void {
    this.doc = doc;
    this.history.reset(doc);
    this.live = null;
    this.drag = null;
    this.dirty = false;
    this.fit();
    this.syncAll();
  }

  private commit(): void {
    if (this.history.commit()) this.dirty = true;
    this.syncAll();
  }

  private undo(): void {
    if (this.history.undo()) this.syncAll();
  }

  private redo(): void {
    if (this.history.redo()) this.syncAll();
  }

  private confirmDiscard(): boolean {
    return !this.dirty || confirm('保存していない変更があります。破棄してよいですか？');
  }

  private rerenderTexts(): void {
    const texts = this.doc.layers.filter((l) => l.kind === 'text');
    texts.forEach(renderText);
    if (texts.length > 0) this.syncAll();
  }

  // ───────────── 表示 ─────────────

  private resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.stage;
    this.view.width = Math.max(1, Math.round(w * this.dpr));
    this.view.height = Math.max(1, Math.round(h * this.dpr));
    this.requestRender();
  }

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.stage;
    const margin = 40;
    this.zoom = Math.max(MIN_ZOOM, Math.min((w - margin) / this.doc.width, (h - margin) / this.doc.height));
    this.centerView();
  }

  private setZoom(zoom: number, anchor?: Point): void {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const a = anchor ?? { x: this.stage.clientWidth / 2, y: this.stage.clientHeight / 2 };
    this.panX = a.x - ((a.x - this.panX) * z) / this.zoom;
    this.panY = a.y - ((a.y - this.panY) * z) / this.zoom;
    this.zoom = z;
    this.requestRender();
    this.syncStatus();
  }

  private centerView(): void {
    this.panX = Math.round((this.stage.clientWidth - this.doc.width * this.zoom) / 2);
    this.panY = Math.round((this.stage.clientHeight - this.doc.height * this.zoom) / 2);
    this.requestRender();
    this.syncStatus();
  }

  private requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.draw();
    });
  }

  private draw(): void {
    const ctx = this.viewCtx;
    const merged = this.compositor.render(this.doc, this.live);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.view.width, this.view.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const w = this.doc.width * this.zoom;
    const h = this.doc.height * this.zoom;
    ctx.fillStyle = this.checkerPattern();
    ctx.fillRect(this.panX, this.panY, w, h);
    ctx.imageSmoothingEnabled = this.zoom < 2;
    ctx.drawImage(merged, this.panX, this.panY, w, h);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(this.panX - 0.5, this.panY - 0.5, w + 1, h + 1);

    // ブラシの大きさを示す円
    if (this.pointer && (this.tool === 'brush' || this.tool === 'eraser') && !this.spaceDown) {
      const r = Math.max(1, (this.size * this.zoom) / 2);
      ctx.beginPath();
      ctx.arc(this.pointer.x, this.pointer.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(this.pointer.x, this.pointer.y, r + 1, 0, Math.PI * 2);
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }
  }

  private checkerPattern(): CanvasPattern {
    if (!this.checker) {
      const tile = createCanvas(16, 16);
      const t = ctxOf(tile);
      t.fillStyle = '#ccc';
      t.fillRect(0, 0, 16, 16);
      t.fillStyle = '#fff';
      t.fillRect(0, 0, 8, 8);
      t.fillRect(8, 8, 8, 8);
      this.checker = this.viewCtx.createPattern(tile, 'repeat')!;
    }
    return this.checker;
  }

  private screenPoint(e: MouseEvent): Point {
    const rect = this.view.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private docPoint(e: MouseEvent): Point {
    const s = this.screenPoint(e);
    return { x: (s.x - this.panX) / this.zoom, y: (s.y - this.panY) / this.zoom };
  }

  // ───────────── ツール ─────────────

  private setTool(tool: Tool): void {
    this.tool = tool;
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    document.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => {
      el.hidden = !el.dataset.for!.split(' ').includes(tool);
    });
    this.updateCursor();
    this.requestRender();
  }

  private updateCursor(): void {
    const cursors: Partial<Record<Tool, string>> = { move: 'move', text: 'text', brush: 'none', eraser: 'none' };
    this.view.style.cursor = this.drag?.kind === 'pan' ? 'grabbing' : this.spaceDown ? 'grab' : (cursors[this.tool] ?? 'crosshair');
  }

  private setColor(color: string): void {
    this.color = color;
    $<HTMLInputElement>('#opt-color').value = color;
  }

  /** 描画できるレイヤーか確かめ、だめなら理由を表示する */
  private drawableLayer(): Layer | null {
    const layer = this.doc.active;
    if (!layer) return null;
    if (layer.kind !== 'raster') {
      this.toast('文字レイヤーには描けません。ラスタライズするか、別のレイヤーを選んでください');
      return null;
    }
    if (!layer.visible) {
      this.toast('非表示のレイヤーには描けません');
      return null;
    }
    return layer;
  }

  private beginLive(layer: Layer, mode: GlobalCompositeOperation): void {
    if (this.liveCanvas.width !== this.doc.width || this.liveCanvas.height !== this.doc.height) {
      this.liveCanvas.width = this.doc.width;
      this.liveCanvas.height = this.doc.height;
    }
    ctxOf(this.liveCanvas).clearRect(0, 0, this.doc.width, this.doc.height);
    this.live = { layerId: layer.id, canvas: this.liveCanvas, alpha: this.opacity, mode };
  }

  private endLive(): void {
    const live = this.live;
    this.live = null;
    const layer = live && this.doc.layers.find((l) => l.id === live.layerId);
    if (!live || !layer) return;
    const ctx = ctxOf(layer.canvas);
    ctx.globalAlpha = live.alpha;
    ctx.globalCompositeOperation = live.mode;
    ctx.drawImage(live.canvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    touch(layer);
    this.commit();
  }

  private local(p: Point, layer: Layer): Point {
    return { x: p.x - layer.x, y: p.y - layer.y };
  }

  private strokeTo(from: Point, to: Point, pressure: number): void {
    const ctx = ctxOf(this.liveCanvas);
    ctx.strokeStyle = this.tool === 'eraser' ? '#000' : this.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(0.5, this.size * pressure);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  private drawShape(start: Point, end: Point, square: boolean): void {
    const ctx = ctxOf(this.liveCanvas);
    ctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
    let w = end.x - start.x;
    let h = end.y - start.y;
    if (square) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    ctx.beginPath();
    if (this.tool === 'rect') {
      ctx.rect(start.x, start.y, w, h);
    } else {
      ctx.ellipse(start.x + w / 2, start.y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
    }
    if (this.shapeFill) {
      ctx.fillStyle = this.color;
      ctx.fill();
    } else {
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.size;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  private fill(layer: Layer, p: Point): void {
    const lp = this.local(p, layer);
    const ctx = ctxOf(layer.canvas);
    const img = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
    const [r, g, b] = hexToRgb(this.color);
    if (floodFill(img, Math.floor(lp.x), Math.floor(lp.y), [r, g, b, Math.round(this.opacity * 255)], this.tolerance)) {
      ctx.putImageData(img, 0, 0);
      touch(layer);
      this.commit();
    }
  }

  private pickColor(p: Point): void {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= this.doc.width || y >= this.doc.height) return;
    const [r, g, b] = ctxOf(this.compositor.render(this.doc)).getImageData(x, y, 1, 1).data;
    this.setColor(rgbToHex(r, g, b));
  }

  private addText(p: Point): void {
    const props: TextProps = { ...DEFAULT_TEXT, color: this.color };
    const o = textOrigin(p.x, p.y, props);
    const layer = newTextLayer(this.doc.width, this.doc.height, o.x, o.y, props);
    this.doc.insertAboveActive(layer);
    this.commit();
    const textarea = $<HTMLTextAreaElement>('#txt-text');
    textarea.focus();
    textarea.select();
  }

  // ───────────── キャンバスの操作 ─────────────

  private bindCanvas(): void {
    this.view.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.view.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.view.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.view.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.view.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.requestRender();
    });
    this.view.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey || !e.shiftKey) {
          this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0015), this.screenPoint(e));
        } else {
          this.panX -= e.deltaY;
          this.requestRender();
        }
      },
      { passive: false },
    );
    this.view.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onPointerDown(e: PointerEvent): void {
    this.view.setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, panX: this.panX, panY: this.panY };
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    const p = this.docPoint(e);
    const active = this.doc.active;
    if (!active) return;

    switch (this.tool) {
      case 'eyedropper':
        this.pickColor(p);
        this.drag = { kind: 'pick' };
        break;
      case 'move':
        this.drag = { kind: 'move', start: p, layerX: active.x, layerY: active.y, moved: false };
        break;
      case 'text':
        this.addText(p);
        break;
      case 'fill': {
        const layer = this.drawableLayer();
        if (layer) this.fill(layer, p);
        break;
      }
      case 'brush':
      case 'eraser': {
        const layer = this.drawableLayer();
        if (!layer) return;
        this.beginLive(layer, this.tool === 'eraser' ? 'destination-out' : 'source-over');
        const lp = this.local(p, layer);
        this.strokeTo(lp, lp, this.pressure(e));
        this.drag = { kind: 'stroke', last: lp };
        break;
      }
      case 'rect':
      case 'ellipse': {
        const layer = this.drawableLayer();
        if (!layer) return;
        this.beginLive(layer, 'source-over');
        this.drag = { kind: 'shape', start: this.local(p, layer) };
        break;
      }
    }
    this.requestRender();
  }

  private onPointerMove(e: PointerEvent): void {
    this.pointer = this.screenPoint(e);
    const p = this.docPoint(e);
    $('#status-pos').textContent = `${Math.floor(p.x)}, ${Math.floor(p.y)}`;
    const drag = this.drag;
    const layer = this.doc.active;
    if (drag && layer) {
      switch (drag.kind) {
        case 'pan':
          this.panX = drag.panX + e.clientX - drag.startX;
          this.panY = drag.panY + e.clientY - drag.startY;
          break;
        case 'move':
          layer.x = Math.round(drag.layerX + p.x - drag.start.x);
          layer.y = Math.round(drag.layerY + p.y - drag.start.y);
          drag.moved = true;
          break;
        case 'stroke':
          // ペンの細かい動きも拾って線をなめらかにする
          for (const ev of e.getCoalescedEvents?.() ?? [e]) {
            const lp = this.local(this.docPoint(ev), layer);
            this.strokeTo(drag.last, lp, this.pressure(ev));
            drag.last = lp;
          }
          break;
        case 'shape':
          this.drawShape(drag.start, this.local(p, layer), e.shiftKey);
          break;
        case 'pick':
          this.pickColor(p);
          break;
      }
    }
    this.requestRender();
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.view.hasPointerCapture(e.pointerId)) this.view.releasePointerCapture(e.pointerId);
    const drag = this.drag;
    this.drag = null;
    if (drag?.kind === 'stroke' || drag?.kind === 'shape') this.endLive();
    if (drag?.kind === 'move' && drag.moved) this.commit();
    this.updateCursor();
    this.requestRender();
  }

  /** マウスは常に 1、ペンは筆圧 */
  private pressure(e: PointerEvent): number {
    return e.pointerType === 'pen' ? Math.max(0.05, e.pressure) : 1;
  }

  // ───────────── キーボード ─────────────

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 's') {
        e.preventDefault();
        this.save();
        return;
      }
      if (isTyping(e.target)) return;
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        this.redo();
      } else if (mod && key === '0') {
        e.preventDefault();
        this.fit();
      } else if (mod && key === '1') {
        e.preventDefault();
        this.setZoom(1);
      } else if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        this.spaceDown = true;
        this.updateCursor();
        this.requestRender();
      } else if (key === '[' || key === ']') {
        this.setSize(this.size + (key === ']' ? 1 : -1) * Math.max(1, Math.round(this.size * 0.15)));
      } else if (!mod && !e.altKey && TOOL_KEYS[key]) {
        this.setTool(TOOL_KEYS[key]);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.updateCursor();
        this.requestRender();
      }
    });
  }

  // ───────────── パネル ─────────────

  private bindTopbar(): void {
    const actions: Record<string, () => void> = {
      new: () => this.openNewDialog(),
      open: () => $<HTMLInputElement>('#file-open').click(),
      save: () => this.save(),
      'add-image': () => $<HTMLInputElement>('#file-image').click(),
      'export-png': () => void exportImage(this.doc, 'png').catch((err) => this.toast(String(err))),
      'export-jpeg': () => void exportImage(this.doc, 'jpeg').catch((err) => this.toast(String(err))),
      undo: () => this.undo(),
      redo: () => this.redo(),
      adjust: () => this.openAdjustDialog(),
      'zoom-in': () => this.setZoom(this.zoom * 1.25),
      'zoom-out': () => this.setZoom(this.zoom / 1.25),
      'zoom-fit': () => this.fit(),
      'zoom-100': () => this.setZoom(1),
      'layer-add': () => this.addLayer(),
      'layer-dup': () => this.duplicateLayer(),
      'layer-up': () => this.moveLayer(1),
      'layer-down': () => this.moveLayer(-1),
      'layer-merge': () => this.mergeDown(),
      'layer-delete': () => this.deleteLayer(),
    };
    document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) => {
      b.addEventListener('click', () => actions[b.dataset.action!]?.());
    });
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.addEventListener('click', () => this.setTool(b.dataset.tool as Tool));
    });
  }

  private bindToolOptions(): void {
    const color = $<HTMLInputElement>('#opt-color');
    color.value = this.color;
    color.addEventListener('input', () => (this.color = color.value));

    const swatches = $('#swatches');
    for (const c of SWATCHES) {
      const b = document.createElement('button');
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => this.setColor(c));
      swatches.append(b);
    }

    this.bindRange('#opt-size', this.size, (v) => this.setSize(v));
    this.bindRange('#opt-opacity', this.opacity * 100, (v) => (this.opacity = v / 100));
    this.bindRange('#opt-tolerance', this.tolerance, (v) => (this.tolerance = v));

    const shapeFill = $<HTMLInputElement>('#opt-shape-fill');
    shapeFill.checked = this.shapeFill;
    shapeFill.addEventListener('change', () => (this.shapeFill = shapeFill.checked));
  }

  /** スライダーと、隣の数値表示をつなぐ */
  private bindRange(selector: string, initial: number, onInput: (v: number) => void, onChange?: () => void): HTMLInputElement {
    const input = $<HTMLInputElement>(selector);
    const out = input.parentElement?.querySelector('output');
    input.value = String(initial);
    if (out) out.textContent = input.value;
    input.addEventListener('input', () => {
      if (out) out.textContent = input.value;
      onInput(Number(input.value));
    });
    if (onChange) input.addEventListener('change', onChange);
    return input;
  }

  private setSize(size: number): void {
    this.size = Math.min(300, Math.max(1, size));
    const input = $<HTMLInputElement>('#opt-size');
    input.value = String(this.size);
    $('#opt-size-out').textContent = input.value;
    this.requestRender();
  }

  private bindTextOptions(): void {
    const font = $<HTMLSelectElement>('#txt-font');
    for (const [value, label] of FONTS) font.add(new Option(label, value));

    // 入力中は見た目だけ更新し、確定（change）したときに履歴へ積む
    const bind = (selector: string, update: (t: TextProps, el: HTMLInputElement) => void) => {
      const el = $<HTMLInputElement>(selector);
      el.addEventListener('input', () => {
        const layer = this.doc.active;
        if (!layer?.text) return;
        update(layer.text, el);
        renderText(layer);
        this.requestRender();
      });
      el.addEventListener('change', () => {
        const layer = this.doc.active;
        if (!layer?.text) return;
        if (selector === '#txt-text') layer.name = layer.text.text.split('\n')[0] || 'テキスト';
        this.commit();
      });
    };
    bind('#txt-text', (t, el) => (t.text = el.value));
    bind('#txt-font', (t, el) => (t.fontFamily = el.value));
    bind('#txt-size', (t, el) => (t.size = Math.max(4, Number(el.value) || t.size)));
    bind('#txt-color', (t, el) => (t.color = el.value));
    bind('#txt-bold', (t, el) => (t.bold = el.checked));
    bind('#txt-stroke-color', (t, el) => (t.strokeColor = el.value));
    bind('#txt-stroke-width', (t, el) => {
      t.strokeWidth = Number(el.value);
      $('#txt-stroke-width-out').textContent = el.value;
    });
    bind('#txt-shadow', (t, el) => (t.shadow = el.checked));

    $('#txt-rasterize').addEventListener('click', () => {
      const layer = this.doc.active;
      if (!layer?.text) return;
      layer.kind = 'raster';
      layer.text = undefined;
      this.commit();
    });
  }

  private bindLayerPanel(): void {
    const blend = $<HTMLSelectElement>('#layer-blend');
    for (const [value, label] of BLEND_MODES) blend.add(new Option(label, value));
    blend.addEventListener('change', () => {
      const layer = this.doc.active;
      if (!layer) return;
      layer.blend = blend.value as GlobalCompositeOperation;
      this.commit();
    });
    this.bindRange(
      '#layer-opacity',
      100,
      (v) => {
        const layer = this.doc.active;
        if (!layer) return;
        layer.opacity = v / 100;
        this.requestRender();
      },
      () => this.commit(),
    );
  }

  private addLayer(): void {
    const n = this.doc.layers.length + 1;
    this.doc.insertAboveActive(newRasterLayer(this.doc.width, this.doc.height, `レイヤー ${n}`));
    this.commit();
  }

  private duplicateLayer(): void {
    const layer = this.doc.active;
    if (!layer) return;
    this.doc.insertAboveActive(cloneLayer(layer));
    this.commit();
  }

  private moveLayer(dir: 1 | -1): void {
    const i = this.doc.indexOf(this.doc.activeId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.doc.layers.length) return;
    const layers = this.doc.layers;
    [layers[i], layers[j]] = [layers[j], layers[i]];
    this.commit();
  }

  private deleteLayer(): void {
    if (this.doc.layers.length <= 1) {
      this.toast('最後のレイヤーは削除できません');
      return;
    }
    const i = this.doc.indexOf(this.doc.activeId);
    this.doc.layers.splice(i, 1);
    this.doc.activeId = this.doc.layers[Math.max(0, i - 1)].id;
    this.commit();
  }

  private mergeDown(): void {
    const i = this.doc.indexOf(this.doc.activeId);
    const upper = this.doc.layers[i];
    const lower = this.doc.layers[i - 1];
    if (!upper || !lower) {
      this.toast('下にレイヤーがありません');
      return;
    }
    if (lower.kind !== 'raster') {
      this.toast('下が文字レイヤーのときは、先にラスタライズしてください');
      return;
    }
    if (upper.visible) {
      const ctx = ctxOf(lower.canvas);
      ctx.globalAlpha = upper.opacity;
      ctx.globalCompositeOperation = upper.blend;
      ctx.drawImage(upper.canvas, upper.x - lower.x, upper.y - lower.y);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      touch(lower);
    }
    this.doc.layers.splice(i, 1);
    this.doc.activeId = lower.id;
    this.commit();
  }

  // ───────────── ファイル ─────────────

  private bindFiles(): void {
    const open = $<HTMLInputElement>('#file-open');
    open.addEventListener('change', () => {
      const file = open.files?.[0];
      open.value = '';
      if (file) void this.openFile(file);
    });
    const image = $<HTMLInputElement>('#file-image');
    image.addEventListener('change', () => {
      const files = [...(image.files ?? [])];
      image.value = '';
      void this.addImages(files);
    });

    this.stage.addEventListener('dragover', (e) => e.preventDefault());
    this.stage.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      const project = files.find((f) => f.name.endsWith('.json'));
      if (project) void this.openFile(project);
      else void this.addImages(files);
    });
    window.addEventListener('paste', (e) => {
      if (isTyping(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length > 0) {
        e.preventDefault();
        void this.addImages(files);
      }
    });
  }

  /** プロジェクトならそのまま開き、画像ならその大きさの新しい画像として開く */
  private async openFile(file: File): Promise<void> {
    if (!this.confirmDiscard()) return;
    try {
      if (file.name.endsWith('.json')) {
        this.setDoc(await loadProject(file));
        return;
      }
      const img = await fileToImage(file);
      const doc = Doc.create(img.width, img.height, null);
      doc.name = file.name.replace(/\.[^.]+$/, '');
      doc.layers[0].name = doc.name;
      ctxOf(doc.layers[0].canvas).drawImage(img, 0, 0);
      touch(doc.layers[0]);
      this.setDoc(doc);
    } catch (err) {
      this.toast(`開けませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 画像をレイヤーとして追加する。大きすぎる画像は画面に収まるよう縮める */
  private async addImages(files: File[]): Promise<void> {
    let added = 0;
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const img = await fileToImage(file);
        const { width: W, height: H } = this.doc;
        const s = Math.min(1, W / img.width, H / img.height);
        const w = Math.round(img.width * s);
        const h = Math.round(img.height * s);
        const layer = newRasterLayer(W, H, file.name.replace(/\.[^.]+$/, '') || '画像');
        ctxOf(layer.canvas).drawImage(img, 0, 0, w, h);
        layer.x = Math.round((W - w) / 2);
        layer.y = Math.round((H - h) / 2);
        this.doc.insertAboveActive(layer);
        added++;
      } catch {
        this.toast(`読み込めない画像です: ${file.name}`);
      }
    }
    if (added > 0) {
      this.commit();
      this.setTool('move');
    }
  }

  private save(): void {
    saveProject(this.doc);
    this.dirty = false;
    this.toast(`${this.doc.name}${PROJECT_EXT} を保存しました`);
  }

  // ───────────── ダイアログ ─────────────

  private bindDialogs(): void {
    const preset = $<HTMLSelectElement>('#new-preset');
    const width = $<HTMLInputElement>('#new-width');
    const height = $<HTMLInputElement>('#new-height');
    const applyPreset = () => {
      if (preset.value === 'custom') return;
      const [w, h] = preset.value.split('x');
      width.value = w;
      height.value = h;
    };
    preset.addEventListener('change', applyPreset);
    const toCustom = () => (preset.value = 'custom');
    width.addEventListener('input', toCustom);
    height.addEventListener('input', toCustom);
    applyPreset();

    const newDialog = $<HTMLDialogElement>('#new-dialog');
    newDialog.addEventListener('close', () => {
      if (newDialog.returnValue !== 'ok') return;
      const w = Math.min(8000, Math.max(1, Math.round(Number(width.value))));
      const h = Math.min(8000, Math.max(1, Math.round(Number(height.value))));
      if (!w || !h || !this.confirmDiscard()) return;
      this.setDoc(Doc.create(w, h, $<HTMLSelectElement>('#new-bg').value || null));
    });

    const adjust = $<HTMLDialogElement>('#adjust-dialog');
    adjust.addEventListener('close', () => {
      const session = this.adjustSession;
      this.adjustSession = null;
      if (!session) return;
      if (adjust.returnValue === 'ok') {
        touch(session.layer);
        this.commit();
      } else {
        ctxOf(session.layer.canvas).putImageData(session.original, 0, 0);
        this.requestRender();
      }
    });
    const keys: (keyof Adjustments)[] = ['brightness', 'contrast', 'saturation', 'hue'];
    for (const key of keys) {
      this.bindRange(`#adj-${key}`, 0, (v) => {
        const session = this.adjustSession;
        if (!session) return;
        session.values[key] = v;
        applyAdjustments(session.original, session.work, session.values);
        ctxOf(session.layer.canvas).putImageData(session.work, 0, 0);
        this.requestRender();
      });
    }
  }

  private adjustSession: { layer: Layer; original: ImageData; work: ImageData; values: Adjustments } | null = null;

  private openNewDialog(): void {
    const dialog = $<HTMLDialogElement>('#new-dialog');
    dialog.returnValue = '';
    dialog.showModal();
  }

  private openAdjustDialog(): void {
    const layer = this.drawableLayer();
    if (!layer) return;
    const { width, height } = layer.canvas;
    const original = ctxOf(layer.canvas).getImageData(0, 0, width, height);
    this.adjustSession = {
      layer,
      original,
      work: new ImageData(width, height),
      values: { brightness: 0, contrast: 0, saturation: 0, hue: 0 },
    };
    for (const key of ['brightness', 'contrast', 'saturation', 'hue']) {
      const input = $<HTMLInputElement>(`#adj-${key}`);
      input.value = '0';
      const out = input.parentElement?.querySelector('output');
      if (out) out.textContent = '0';
    }
    const dialog = $<HTMLDialogElement>('#adjust-dialog');
    dialog.returnValue = '';
    dialog.showModal();
  }

  // ───────────── 表示の同期 ─────────────

  private syncAll(): void {
    this.syncLayers();
    this.syncTextOptions();
    this.syncStatus();
    $<HTMLButtonElement>('[data-action="undo"]').disabled = !this.history.canUndo;
    $<HTMLButtonElement>('[data-action="redo"]').disabled = !this.history.canRedo;
    document.title = `${this.dirty ? '● ' : ''}${this.doc.name} - claude_photogai`;
    this.requestRender();
  }

  private syncStatus(): void {
    $('#status-size').textContent = `${this.doc.width} × ${this.doc.height}`;
    $('#status-zoom').textContent = `${Math.round(this.zoom * 100)}%`;
  }

  private syncLayers(): void {
    const list = $('#layer-list');
    list.replaceChildren();
    const thumbW = 48;
    const thumbH = Math.max(8, Math.round((thumbW * this.doc.height) / this.doc.width));
    const s = thumbW / this.doc.width;
    for (const layer of [...this.doc.layers].reverse()) {
      const li = document.createElement('li');
      li.className = 'layer';
      li.classList.toggle('active', layer.id === this.doc.activeId);
      li.classList.toggle('hidden-layer', !layer.visible);

      const eye = document.createElement('button');
      eye.className = 'eye';
      eye.textContent = layer.visible ? '表示' : '非表示';
      eye.title = '表示・非表示';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        this.commit();
      });

      const thumb = createCanvas(thumbW, Math.min(thumbH, 64));
      ctxOf(thumb).drawImage(layer.canvas, layer.x * s, layer.y * s, layer.canvas.width * s, layer.canvas.height * s);

      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = layer.name;
      name.title = 'ダブルクリックで名前を変更';
      name.addEventListener('dblclick', () => {
        const next = prompt('レイヤー名', layer.name);
        if (next && next !== layer.name) {
          layer.name = next;
          this.commit();
        }
      });

      li.append(eye, thumb, name);
      if (layer.kind === 'text') {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '文字';
        li.append(badge);
      }
      li.addEventListener('click', () => {
        this.doc.activeId = layer.id;
        this.syncAll();
      });
      list.append(li);
    }

    const active = this.doc.active;
    $<HTMLSelectElement>('#layer-blend').value = active?.blend ?? 'source-over';
    const opacity = String(Math.round((active?.opacity ?? 1) * 100));
    $<HTMLInputElement>('#layer-opacity').value = opacity;
    $('#layer-opacity-out').textContent = opacity;
  }

  private syncTextOptions(): void {
    const t = this.doc.active?.text;
    $('#text-options').hidden = !t;
    if (!t) return;
    $<HTMLTextAreaElement>('#txt-text').value = t.text;
    $<HTMLSelectElement>('#txt-font').value = t.fontFamily;
    $<HTMLInputElement>('#txt-size').value = String(t.size);
    $<HTMLInputElement>('#txt-color').value = t.color;
    $<HTMLInputElement>('#txt-bold').checked = t.bold;
    $<HTMLInputElement>('#txt-stroke-color').value = t.strokeColor;
    $<HTMLInputElement>('#txt-stroke-width').value = String(t.strokeWidth);
    $('#txt-stroke-width-out').textContent = String(t.strokeWidth);
    $<HTMLInputElement>('#txt-shadow').checked = t.shadow;
  }

  private toastTimer = 0;

  private toast(message: string): void {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), 2800);
  }
}
