fn main() {
    println!("cargo:rerun-if-changed=windows/admin.manifest");
    let mut attributes = tauri_build::Attributes::new();
    // Release builds run as administrator: the IIS steps (clone, app pool recycle, delete) and
    // Visual Studio with IIS web projects need it, and inherit it without UAC prompts.
    // Debug builds (`tauri dev`) stay unelevated so they start from a normal terminal.
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        attributes = attributes.windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows/admin.manifest")),
        );
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
