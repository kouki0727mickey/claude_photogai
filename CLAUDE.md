# CLAUDE.md — claude_photogai

サムネイル・イラスト制作用の画像編集アプリ。TypeScript + Vite + Canvas 2D。ブラウザ版（GitHub Pages）と Windows 版（Tauri）を同じコードから作る。
ユーザーとは日本語で話す。UI の文言も日本語。

## コマンド
- `npm run dev` — 開発サーバー
- `npm run build` — 型チェック（tsc）と本番ビルド。変更後は必ず通す
- `npm run tauri dev` / `npm run tauri build` — Windows 版の開発・ビルド（Rust が必要）。`src-tauri/` を変えたら `cd src-tauri && cargo check` を通す

## 設計の決まりごと
- レイヤーの canvas は常にドキュメントと同じ大きさ。移動は `layer.x / y` を変えるだけで、ピクセルは動かさない
- ピクセルを変えたら `touch(layer)` を呼び、操作が確定したら `App.commit()` で履歴に積む。入力中（スライダーを動かしている間など）は積まず、`change` で積む
- 描いている途中のストロークや図形は `LiveOverlay` に描き、確定時にレイヤーへ書き込む（ストローク内で不透明度が重ならないように）
- ファイルの保存は `io.ts` の `download` を通す（ブラウザはダウンロード、デスクトップは保存ダイアログ）。Tauri に新しい権限が要るときは `src-tauri/capabilities/default.json` に最小限だけ足す
- フォントは `src/fonts.ts` で同梱。追加するときは太字の太さを `layer.ts` の `FONTS` に書く（無い太さを指定すると崩れる）
- プロジェクトファイル（`.photogai.json`）の形式を変えるときは `io.ts` の `FORMAT_VERSION` を上げ、古い形式も読めるようにする

## 検証
UI を変えたら、ブラウザで実際に操作して確かめる（Playwright で描画・元に戻す・保存と読み込みの往復を試す）。
