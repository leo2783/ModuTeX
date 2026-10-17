# ModuTeX Tauri desktop host

Windows x64 Tauri 2 host for the ModuTeX frontend. Apache-2.0. Original build icons (no vendor art): `node apps/desktop-tauri/scripts/generate-icon.mjs`.

From the repository root:

```powershell
npm run frontend:build
cargo test --manifest-path apps/desktop-tauri/src-tauri/Cargo.toml
cargo run --manifest-path apps/desktop-tauri/src-tauri/Cargo.toml
```

## Implemented foundation

- Tauri 2 crate, single `main` window, restrictive CSP, bundle disabled.
- `host_health` command, window-scoped via `allow-host-health`; owner comes from the trusted window.
- Strict DesktopPort DTOs (`protocol.rs`): exact fields, validated IDs, safe integers, compile status union.
- Owner-checked workspace session registry (`sessions.rs`) with revoke on window destroy.
- Dialog plugin registered, with no renderer permission granted.

## Next

- Native open/save dialogs and recent documents.
- File IO: list, read, write, watch, revisions.
- Compile service and cancellation.
