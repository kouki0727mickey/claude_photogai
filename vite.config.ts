import { defineConfig, type Plugin } from 'vite';

/**
 * 同梱フォントの CSS から古い形式（woff）の指定を消し、woff2 だけを出力する。
 * 対象のブラウザと WebView2 はすべて woff2 に対応しているので、出力が半分近く減る。
 */
function woff2Only(): Plugin {
  return {
    name: 'woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@fontsource') || !id.endsWith('.css')) return null;
      return code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, '');
    },
  };
}

export default defineConfig({
  // GitHub Pages のサブパス（/claude_photogai/）でも、デスクトップ版でも動くよう相対パスで出力する
  base: './',
  plugins: [woff2Only()],
  // Tauri の開発モード（npm run tauri dev）用
  clearScreen: false,
  server: { port: 5173, strictPort: true },
});
