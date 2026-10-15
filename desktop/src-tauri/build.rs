fn main() {
    println!("cargo:rerun-if-changed=../web-ui");
    tauri_build::build();
}
