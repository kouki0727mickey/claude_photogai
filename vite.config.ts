import { defineConfig } from 'vite';

// GitHub Pages のサブパス（/claude_photogai/）でも動くよう相対パスで出力する
export default defineConfig({
  base: './',
});
