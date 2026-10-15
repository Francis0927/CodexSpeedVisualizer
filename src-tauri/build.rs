fn main() {
    let package: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string("../package.json").expect("package.json"))
            .expect("valid package.json");
    assert_eq!(
        package["version"].as_str().unwrap(),
        std::env::var("CARGO_PKG_VERSION").unwrap(),
        "Cargo and package.json versions must match"
    );
    println!("cargo:rerun-if-changed=../package.json");
    tauri_build::build()
}
