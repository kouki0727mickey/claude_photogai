import { flatten } from './compositor';
import { Doc } from './doc';
import { ctxOf, newRasterLayer, renderText, reserveIds, type Layer, type TextProps } from './layer';

const APP_ID = 'claude_photogai';
const FORMAT_VERSION = 1;
export const PROJECT_EXT = '.photogai.json';

interface ProjectLayer {
  name: string;
  kind: Layer['kind'];
  visible: boolean;
  opacity: number;
  blend: GlobalCompositeOperation;
  x: number;
  y: number;
  text?: TextProps;
  /** PNG の data URL */
  data: string;
}

interface ProjectFile {
  app: typeof APP_ID;
  version: number;
  name: string;
  width: number;
  height: number;
  activeIndex: number;
  layers: ProjectLayer[];
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像の書き出しに失敗しました'))), type, quality),
  );
}

export async function exportImage(doc: Doc, format: 'png' | 'jpeg'): Promise<void> {
  const canvas = format === 'jpeg' ? flatten(doc, '#ffffff') : flatten(doc);
  const blob = await toBlob(canvas, `image/${format}`, format === 'jpeg' ? 0.92 : undefined);
  download(blob, `${doc.name}.${format === 'jpeg' ? 'jpg' : 'png'}`);
}

export function saveProject(doc: Doc): void {
  const file: ProjectFile = {
    app: APP_ID,
    version: FORMAT_VERSION,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    activeIndex: doc.indexOf(doc.activeId),
    layers: doc.layers.map((l) => ({
      name: l.name,
      kind: l.kind,
      visible: l.visible,
      opacity: l.opacity,
      blend: l.blend,
      x: l.x,
      y: l.y,
      text: l.text,
      data: l.canvas.toDataURL('image/png'),
    })),
  };
  download(new Blob([JSON.stringify(file)], { type: 'application/json' }), `${doc.name}${PROJECT_EXT}`);
}

export async function fileToImage(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file);
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

export async function loadProject(file: File): Promise<Doc> {
  const json = JSON.parse(await file.text()) as Partial<ProjectFile>;
  if (json.app !== APP_ID || !json.width || !json.height || !Array.isArray(json.layers)) {
    throw new Error('このアプリのプロジェクトファイルではありません');
  }
  if ((json.version ?? 0) > FORMAT_VERSION) {
    throw new Error('新しい版のアプリで保存されたファイルです');
  }
  const doc = new Doc(json.width, json.height);
  doc.name = json.name || file.name.replace(PROJECT_EXT, '');
  for (const pl of json.layers) {
    const layer = newRasterLayer(doc.width, doc.height, pl.name);
    Object.assign(layer, {
      kind: pl.kind,
      visible: pl.visible,
      opacity: pl.opacity,
      blend: pl.blend,
      x: pl.x,
      y: pl.y,
      text: pl.text && { ...pl.text },
    });
    if (layer.kind === 'text') {
      renderText(layer);
    } else {
      ctxOf(layer.canvas).drawImage(await loadImage(pl.data), 0, 0);
    }
    doc.layers.push(layer);
  }
  reserveIds(Math.max(...doc.layers.map((l) => l.id)));
  doc.activeId = doc.layers[json.activeIndex ?? 0]?.id ?? doc.layers[0]?.id ?? 0;
  return doc;
}
