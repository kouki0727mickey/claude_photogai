export type LayerKind = 'raster' | 'text';

export interface TextProps {
  text: string;
  fontFamily: string;
  size: number;
  color: string;
  bold: boolean;
  strokeColor: string;
  strokeWidth: number;
  shadow: boolean;
}

/**
 * レイヤー。canvas は常にドキュメントと同じ大きさで、x / y は表示位置のずらし量。
 * 移動ツールは x / y だけを変えるので、画像の外にはみ出した部分も失われない。
 */
export interface Layer {
  id: number;
  name: string;
  kind: LayerKind;
  canvas: HTMLCanvasElement;
  visible: boolean;
  opacity: number;
  blend: GlobalCompositeOperation;
  x: number;
  y: number;
  /** ピクセルが変わるたびに増える番号。履歴が変更のないレイヤーを複製しないために使う */
  version: number;
  text?: TextProps;
}

export const BLEND_MODES: [GlobalCompositeOperation, string][] = [
  ['source-over', '通常'],
  ['multiply', '乗算'],
  ['screen', 'スクリーン'],
  ['overlay', 'オーバーレイ'],
  ['darken', '比較（暗）'],
  ['lighten', '比較（明）'],
  ['color-dodge', '覆い焼きカラー'],
  ['color-burn', '焼き込みカラー'],
  ['hard-light', 'ハードライト'],
  ['soft-light', 'ソフトライト'],
  ['difference', '差の絶対値'],
  ['exclusion', '除外'],
  ['hue', '色相'],
  ['saturation', '彩度'],
  ['color', 'カラー'],
  ['luminosity', '輝度'],
];

export const FONTS: [string, string][] = [
  ['"Noto Sans JP", sans-serif', 'Noto Sans JP（ゴシック）'],
  ['"Dela Gothic One", sans-serif', 'Dela Gothic One（極太）'],
  ['"M PLUS Rounded 1c", sans-serif', 'M PLUS Rounded 1c（丸ゴシック）'],
  ['"Zen Old Mincho", serif', 'Zen Old Mincho（明朝）'],
];

export const DEFAULT_TEXT: TextProps = {
  text: 'テキスト',
  fontFamily: FONTS[0][0],
  size: 96,
  color: '#ffffff',
  bold: true,
  strokeColor: '#000000',
  strokeWidth: 8,
  shadow: true,
};

let nextId = 1;
let nextVersion = 1;

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function ctxOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D が使えません');
  return ctx;
}

export function copyCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = createCanvas(src.width, src.height);
  ctxOf(canvas).drawImage(src, 0, 0);
  return canvas;
}

/** ピクセルを変えたあとに呼ぶ */
export function touch(layer: Layer): void {
  layer.version = nextVersion++;
}

export function newRasterLayer(width: number, height: number, name: string): Layer {
  return {
    id: nextId++,
    name,
    kind: 'raster',
    canvas: createCanvas(width, height),
    visible: true,
    opacity: 1,
    blend: 'source-over',
    x: 0,
    y: 0,
    version: nextVersion++,
  };
}

export function newTextLayer(width: number, height: number, x: number, y: number, props: TextProps): Layer {
  const layer = newRasterLayer(width, height, props.text.split('\n')[0] || 'テキスト');
  layer.kind = 'text';
  layer.x = x;
  layer.y = y;
  layer.text = { ...props };
  renderText(layer);
  return layer;
}

export function cloneLayer(src: Layer, name = `${src.name} のコピー`): Layer {
  return {
    ...src,
    id: nextId++,
    name,
    canvas: copyCanvas(src.canvas),
    text: src.text ? { ...src.text } : undefined,
    version: nextVersion++,
  };
}

/** 文字の外側に縁取りと影が入るよう、左上に余白をとる */
function textPadding(t: TextProps): number {
  return t.strokeWidth + Math.ceil(t.size * 0.1);
}

export function renderText(layer: Layer): void {
  const t = layer.text;
  if (!t) return;
  const ctx = ctxOf(layer.canvas);
  ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  ctx.font = `${t.bold ? '900' : '400'} ${t.size}px ${t.fontFamily}`;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  const pad = textPadding(t);
  const lineHeight = t.size * 1.2;
  t.text.split('\n').forEach((line, i) => {
    const y = pad + i * lineHeight;
    ctx.save();
    if (t.shadow) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = t.size * 0.08;
      ctx.shadowOffsetX = t.size * 0.05;
      ctx.shadowOffsetY = t.size * 0.05;
    }
    if (t.strokeWidth > 0) {
      ctx.strokeStyle = t.strokeColor;
      ctx.lineWidth = t.strokeWidth * 2;
      ctx.strokeText(line, pad, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = t.color;
    ctx.fillText(line, pad, y);
    ctx.restore();
  });
  touch(layer);
}

/** クリック位置が文字の左上に来るよう、余白の分だけ位置をずらす */
export function textOrigin(x: number, y: number, t: TextProps): { x: number; y: number } {
  const pad = textPadding(t);
  return { x: Math.round(x - pad), y: Math.round(y - pad) };
}

/** 読み込んだプロジェクトの ID と重ならないようにする */
export function reserveIds(maxId: number): void {
  nextId = Math.max(nextId, maxId + 1);
}
