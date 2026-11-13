fn main() {
    tauri_build::build();

    // 仅在 Windows 上设置子系统为 WINDOWS，避免命令行窗口。
    // 必须用 `-bins` 限定：不带后缀的 `rustc-link-arg` 对包内所有 target 生效，
    // 包括 `cargo test --lib` 生成的测试二进制；测试入口是 main 而非 WinMain，
    // 强行指定 WINDOWS 子系统会报 LNK2019: 无法解析的外部符号 WinMain。
    // （bin 自身还有 main.rs 的 `#![windows_subsystem = "windows"]` 兜底。）
    //
    // 链接参数语法随目标环境区分：msvc 的 link.exe 用 `/SUBSYSTEM:WINDOWS`，
    // gnu（mingw ld）不认识 MSVC 语法，会把整串当文件名找（cannot find
    // /SUBSYSTEM:WINDOWS），需要用 `-Wl,--subsystem,windows` 透传。
    #[cfg(target_os = "windows")]
    {
        if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu") {
            println!("cargo:rustc-link-arg-bins=-Wl,--subsystem,windows");
        } else {
            println!("cargo:rustc-link-arg-bins=/SUBSYSTEM:WINDOWS");
        }
    }
}