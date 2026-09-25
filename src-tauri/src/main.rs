// リリース版では、起動時にコンソール画面を出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        // 保存ダイアログと、選んだ場所への書き込み（src/io.ts の download）
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("アプリを起動できませんでした");
}
