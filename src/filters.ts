export interface Adjustments {
  /** -100〜100 */
  brightness: number;
  /** -100〜100 */
  contrast: number;
  /** -100〜100 */
  saturation: number;
  /** -180〜180（度） */
  hue: number;
}

export const NO_ADJUSTMENTS: Adjustments = { brightness: 0, contrast: 0, saturation: 0, hue: 0 };

type Mat3 = [number, number, number, number, number, number, number, number, number];

function multiply(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r as Mat3;
}

/** CSS の saturate() と同じ行列 */
function saturationMatrix(s: number): Mat3 {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
}

/** CSS の hue-rotate() と同じ行列 */
function hueMatrix(deg: number): Mat3 {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
}

/** 明るさ・コントラスト・彩度・色相を src に適用して dst に書く（透明度は変えない） */
export function applyAdjustments(src: ImageData, dst: ImageData, a: Adjustments): void {
  const m = multiply(hueMatrix(a.hue), saturationMatrix(1 + a.saturation / 100));
  const bright = a.brightness * 2.55;
  const c = a.contrast * 2.55;
  const k = (259 * (c + 255)) / (255 * (259 - c));
  const s = src.data;
  const d = dst.data;
  for (let i = 0; i < s.length; i += 4) {
    const r = s[i];
    const g = s[i + 1];
    const b = s[i + 2];
    d[i] = k * (m[0] * r + m[1] * g + m[2] * b + bright - 128) + 128;
    d[i + 1] = k * (m[3] * r + m[4] * g + m[5] * b + bright - 128) + 128;
    d[i + 2] = k * (m[6] * r + m[7] * g + m[8] * b + bright - 128) + 128;
    d[i + 3] = s[i + 3];
  }
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * 塗りつぶし（上下左右につながった、似た色の範囲）。
 * tolerance は各チャンネル（RGBA）の差の上限。塗ったら true。
 */
export function floodFill(
  img: ImageData,
  sx: number,
  sy: number,
  fill: [number, number, number, number],
  tolerance: number,
): boolean {
  const { width: w, height: h, data: d } = img;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;
  const start = (sy * w + sx) * 4;
  const target = [d[start], d[start + 1], d[start + 2], d[start + 3]];
  if (target.every((v, i) => v === fill[i])) return false;

  const matches = (p: number): boolean => {
    const i = p * 4;
    return (
      Math.abs(d[i] - target[0]) <= tolerance &&
      Math.abs(d[i + 1] - target[1]) <= tolerance &&
      Math.abs(d[i + 2] - target[2]) <= tolerance &&
      Math.abs(d[i + 3] - target[3]) <= tolerance
    );
  };

  const visited = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  visited[sy * w + sx] = 1;
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % w;
    const neighbors = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
    for (const q of neighbors) {
      if (q < 0 || q >= w * h || visited[q] || !matches(q)) continue;
      visited[q] = 1;
      stack.push(q);
    }
    const i = p * 4;
    d[i] = fill[0];
    d[i + 1] = fill[1];
    d[i + 2] = fill[2];
    d[i + 3] = fill[3];
  }
  return true;
}
