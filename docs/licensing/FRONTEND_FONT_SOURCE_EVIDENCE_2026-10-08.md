# MathLive font source evidence

Installed package: `mathlive@0.110.0`. Official version commit:
[`b0a4b033997d897970e40da9ad9a0ad90358a198`](https://github.com/arnog/mathlive/tree/b0a4b033997d897970e40da9ad9a0ad90358a198/css/fonts).

All 20 installed WOFF2 files have the same Git blob IDs as `css/fonts/` in that
commit. This was checked using the GitHub tree API and local
`git hash-object --no-filters`; no Git objects or package files were changed.
The installed `LICENSE.txt` also matches the commit's license blob
`97ba1353dc3d2a84eb6e064a39b3e92664d7f09c`; that text is included in frontend notices.

| Font basename (all `.woff2`) | Git blob ID |
|---|---|
| KaTeX_AMS-Regular | `0acaaff03d4bb7606de02a827aeee338e5a86910` |
| KaTeX_Caligraphic-Bold | `f390922eceffe1f6dfb81a3dc086a92d98171b02` |
| KaTeX_Caligraphic-Regular | `75344a1f98e37e2c631e178065854c3a81fb842f` |
| KaTeX_Fraktur-Bold | `395f28beac23c7b0f7f3a1e714bd8dac253dd3bc` |
| KaTeX_Fraktur-Regular | `735f6948d63c8cc7f8233735bb9c8d843c83d804` |
| KaTeX_Main-Bold | `ab2ad21da6fbe6c171bb869240954d0ead8f68fd` |
| KaTeX_Main-BoldItalic | `5931794de4a2a485fa70099bf2659b145976d043` |
| KaTeX_Main-Italic | `b50920e138807f385d0b0359f4f0f09891f18406` |
| KaTeX_Main-Regular | `eb24a7ba282b03d830fa6c63ee897d92a5188736` |
| KaTeX_Math-BoldItalic | `29657023adc09956249f6295746c8ce4469b50d3` |
| KaTeX_Math-Italic | `215c143fd7805a5c2b222bd7892a1a2b09610020` |
| KaTeX_SansSerif-Bold | `cfaa3bda59246b49e94298478d6de3b3208066c8` |
| KaTeX_SansSerif-Italic | `349c06dc609f896392fd5bc8b364d3bc3efc9330` |
| KaTeX_SansSerif-Regular | `a90eea85f6f7bded69ff5d40114447a6d8b48cfe` |
| KaTeX_Script-Regular | `b3048fc115681ee6c1bc86b0aa158cfbbf59daa3` |
| KaTeX_Size1-Regular | `c5a8462fbfe2c39a7c1857b9e296e62500a8a8a5` |
| KaTeX_Size2-Regular | `e1bccfe2403a4ed770c1697ae7c15b9e1cd9bc4e` |
| KaTeX_Size3-Regular | `249a28662218a7a17ad8bd1fe072169ecb666a49` |
| KaTeX_Size4-Regular | `680c13085076a2f6c5a7e695935ec3f21cddb65f` |
| KaTeX_Typewriter-Regular | `771f1af705f5cef5f578b3a1e7d8eff66f9b76b0` |

## Limits

The installed package and reviewed MathLive tree have no standalone font-license
document. This did not establish the absence of embedded declarations.
On 2026-10-08 the actual WOFF2 name tables were decoded using fontTools:
all 20 have copyright (name ID 0), an explicit SIL OFL 1.1 declaration and
Reserved Font Name (ID 13), and license URL (ID 14).
Exact declarations and SHA-256 bindings are in
[frontend-font-metadata.json](frontend-font-metadata.json); the reproducible
read-only extraction is [font-metadata.py](../../scripts/licensing/font-metadata.py).

Those declarations and the official full OFL text were added to
[frontend notices](../../apps/frontend/THIRD_PARTY_NOTICES.md), which are already
shipped as readable application data. The license body is preserved in
[OFL-1.1.txt](../../LICENSES/OFL-1.1.txt), from
[SIL's official text](https://openfontlicense.org/documents/OFL.txt).
Fonts are unchanged; neither project Apache metadata nor MathLive code MIT
relicenses them. Independent source/distribution review remains pending.

The archive tree of `KaTeX/katex-fonts` at
`56e79c93c88c9054b017cc92e496b383e0bf82d7` contains different font blobs; it is not
byte-identical evidence for these files. The OFL declarations above come from
the installed binaries themselves, not filenames or that unrelated archive.
