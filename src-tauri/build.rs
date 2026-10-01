fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=icons");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    if target_os == "windows" {
        let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
        let lib_dir = manifest_dir.join("lib");

        if !lib_dir.exists() {
            tauri_build::build();
            return;
        }

        println!("cargo:rerun-if-changed={}", lib_dir.display());

        println!("cargo:rustc-link-search=native={}", lib_dir.display());

        // Copy DLLs to target directory
        let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
        let dest_dir = out_dir.ancestors().nth(3).unwrap().to_path_buf();

        std::fs::create_dir_all(&dest_dir).ok();

        fn should_copy(src: &std::path::Path, dest: &std::path::Path) -> bool {
            if !dest.exists() {
                return true;
            }

            let src_meta = match std::fs::metadata(src) {
                Ok(m) => m,
                Err(_) => return true,
            };
            let dest_meta = match std::fs::metadata(dest) {
                Ok(m) => m,
                Err(_) => return true,
            };

            if src_meta.len() != dest_meta.len() {
                return true;
            }

            let src_modified = src_meta.modified().ok();
            let dest_modified = dest_meta.modified().ok();
            match (src_modified, dest_modified) {
                (Some(src_time), Some(dest_time)) => src_time > dest_time,
                _ => true,
            }
        }

        fn copy_dll_with_retry(src: &std::path::Path, dest: &std::path::Path) -> bool {
            use std::time::Duration;

            let mut last_err: Option<std::io::Error> = None;
            for _ in 0..6 {
                match std::fs::copy(src, dest) {
                    Ok(_) => return true,
                    Err(err) => {
                        // Windows file lock (ERROR_SHARING_VIOLATION = 32)
                        if err.raw_os_error() == Some(32) {
                            last_err = Some(err);
                            std::thread::sleep(Duration::from_millis(120));
                            continue;
                        }
                        last_err = Some(err);
                        break;
                    }
                }
            }

            let err = last_err.expect("copy failed without error");
            if err.raw_os_error() == Some(32) {
                panic!(
                    "Native runtime file is locked (close the running app/dev server first): {} -> {}: {err}",
                    src.display(),
                    dest.display()
                );
            }

            panic!("Failed to copy DLL: {err}");
        }

        // Single verified libmpv/wrapper pair: fail closed on missing,
        // duplicate, or unexpected natives so CI (which bypasses the
        // PowerShell guard) can never ship or test against mixed natives.
        // Hash verification stays in scripts/build-tauri.ps1 to keep every
        // cargo check/clippy/test invocation fast.
        let mut staged_dlls: Vec<std::path::PathBuf> = Vec::new();
        for entry in std::fs::read_dir(&lib_dir).expect("Failed to read lib directory") {
            let path = entry.expect("Failed to read entry").path();
            if path.extension().is_some_and(|ext| ext == "dll") {
                staged_dlls.push(path);
            }
        }
        let mut staged_dll_names: Vec<String> = staged_dlls
            .iter()
            .map(|path| {
                path.file_name()
                    .expect("DLL entry has a file name")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        staged_dll_names.sort();
        if staged_dll_names != ["libmpv-2.dll".to_string(), "libmpv-wrapper.dll".to_string()] {
            panic!(
                "Expected exactly one libmpv-2.dll plus one libmpv-wrapper.dll in {}, found: {}",
                lib_dir.display(),
                if staged_dll_names.is_empty() {
                    "(none)".to_string()
                } else {
                    staged_dll_names.join(", ")
                }
            );
        }

        for path in &staged_dlls {
            println!("cargo:rerun-if-changed={}", path.display());
            let file_name = path.file_name().unwrap();
            let dest = dest_dir.join(file_name);
            if should_copy(path, &dest) && copy_dll_with_retry(path, &dest) {
                println!(
                    "cargo:warning=Copied {} to {}",
                    file_name.to_string_lossy(),
                    dest.display()
                );
            }
        }
    }
    tauri_build::build()
}
