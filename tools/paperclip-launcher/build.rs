// Bake a light-stroke variant of the paperclip favicon into the exe as its
// embedded icon resource, so File Explorer's icon column actually shows the
// paperclip mark on a dark Windows 11 taskbar / Explorer background.
//
// Windows doesn't theme-swap embedded icon resources at runtime — what's
// baked in is what you see. The repo's `ui/public/favicon.ico` ships with
// the SVG's light-theme stroke (#18181b, near-black) since that's what the
// browser uses for tab favicons. We decode each size in the ICO, recolor
// dark stroke pixels to #e4e4e7 (the SVG's dark-theme stroke) while
// preserving anti-aliased alpha, re-encode, and hand the result to
// winresource for embedding.

use std::env;
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "windows" {
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let src_ico = manifest_dir.join("..").join("..").join("ui").join("public").join("favicon.ico");
    println!("cargo:rerun-if-changed={}", src_ico.display());
    println!("cargo:rerun-if-changed=build.rs");

    let recolored_ico = match recolor_ico(&src_ico) {
        Ok(path) => path,
        Err(e) => {
            // Don't break the build — fall back to embedding the original
            // (dark-stroke) favicon. The exe is still functional, the user
            // just sees a poorly-visible icon on dark Explorer.
            println!(
                "cargo:warning=Could not recolor {}: {}. Embedding original.",
                src_ico.display(),
                e
            );
            src_ico.clone()
        }
    };

    let mut res = winresource::WindowsResource::new();
    res.set_icon(recolored_ico.to_str().unwrap());
    res.set("ProductName", "Paperclip");
    res.set("FileDescription", "Paperclip Launcher");
    if let Err(e) = res.compile() {
        println!("cargo:warning=winresource compile failed: {}", e);
    }
}

fn recolor_ico(src: &PathBuf) -> Result<PathBuf, String> {
    let ico_bytes = fs::read(src).map_err(|e| format!("read source ico: {}", e))?;
    let src_dir = ico::IconDir::read(Cursor::new(ico_bytes))
        .map_err(|e| format!("parse source ico: {}", e))?;

    let mut new_dir = ico::IconDir::new(ico::ResourceType::Icon);

    for entry in src_dir.entries() {
        let img = entry
            .decode()
            .map_err(|e| format!("decode ico entry: {}", e))?;
        let (w, h) = (img.width(), img.height());
        let mut pixels: Vec<u8> = img.rgba_data().to_vec();

        // Recolor: dark stroke pixel + non-zero alpha → light grey.
        // Threshold at brightness < 240 covers anti-aliased edges as well as
        // the core stroke without bleeding into anything mid-grey (there
        // isn't anything mid-grey in this icon, but the threshold leaves
        // room for future variants).
        for chunk in pixels.chunks_mut(4) {
            let brightness = chunk[0] as u16 + chunk[1] as u16 + chunk[2] as u16;
            if chunk[3] > 0 && brightness < 240 {
                chunk[0] = 0xe4;
                chunk[1] = 0xe4;
                chunk[2] = 0xe7;
            }
        }

        let new_img = ico::IconImage::from_rgba_data(w, h, pixels);
        let new_entry =
            ico::IconDirEntry::encode(&new_img).map_err(|e| format!("encode ico entry: {}", e))?;
        new_dir.add_entry(new_entry);
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let out_path = out_dir.join("paperclip-light.ico");
    let mut out_file =
        fs::File::create(&out_path).map_err(|e| format!("create output ico: {}", e))?;
    new_dir
        .write(&mut out_file)
        .map_err(|e| format!("write output ico: {}", e))?;

    Ok(out_path)
}
