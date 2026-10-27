# Screenshot provenance

The six README screenshots were captured from the actual Windows release application after `dev` passed CI. They use the [example document](../examples/frontend-tour/main.tex); the table values are illustrative, not benchmark results.

| Item               | Evidence                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Source baseline    | `074c5da6d107afd85ee9ca180dd6ea0bd5dc9f97`                                                                 |
| Successful dev CI  | [Run 40440515573](https://github.com/leo2783/ModuTeX/actions/runs/40440515573)                             |
| Build              | `npm run build` on Windows; Tauri release executable                                                       |
| Executable SHA-256 | `cade3da4b0753f9296f6c218c1c938db7872f47ddeef7972723fa4625c01cc41`                                         |
| Capture time       | 2026-10-27 13:12 Asia/Taipei                                                                               |
| Capture method     | Playwright connected to the release application's WebView2 over an isolated loopback CDP endpoint          |
| Viewport           | 1600 × 1000, light theme; English and Traditional Chinese                                                  |
| PDF                | Generated through the desktop application's Compile PDF action; status: Compilation completed, PDF updated |
| Renderer           | Actual PDF.js canvas, 628 × 813 pixels; no uncaught frontend errors                                        |

The captures use the real desktop host and compiler. They do not use a browser preview, a mocked desktop adapter, or edited UI content. Native window borders are outside the captured WebView content. Compiler diagnostics remain visible as reported by the application; success does not imply an empty diagnostic list.

| Files                                             | View                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `workbench.png`, `workbench-en.png`               | Visual draft beside the compiled PDF                                             |
| `source-editor.png`, `source-editor-en.png`       | LaTeX source mode beside the same PDF                                            |
| `compile-settings.png`, `compile-settings-en.png` | Main file, compiler profile, date controls, and the beginning of margin settings |

The [video recording guide](RECORDING.md) is separate: the maintainer will record the video, and this change does not include one.
