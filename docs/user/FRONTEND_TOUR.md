# Frontend walkthrough

[繁體中文](FRONTEND_TOUR.zh-TW.md) · [README](../../README.md)

This walkthrough follows a short research note through the ModuTeX 0.3.0 workspace. Use the [example document](../examples/frontend-tour/main.tex) to try the same content. Copy it into its own folder before compiling so generated files stay outside the repository.

![Visual draft and PDF preview](../images/workbench-en.png)

## 1. Create and save a document

Start with a blank document or an included template, or open the example `.tex` file. Choose **Save** to give a new draft a local `.tex` path. Editing in either mode changes the same document; it does not create a separate visual-format file.

## 2. Write and undo

In **Visual** mode, click a text cell and write directly. Press Enter to continue on the next line. Use the cell's **Above** or **Below** control when you want a separate cell; adding a cell does not duplicate the current text or its blank lines.

Use Ctrl+Z to undo and Ctrl+Shift+Z to redo with the default shortcuts. Visual and source modes share this history. You can change shortcuts in Settings.

## 3. Add structured content

The toolbar opens equation, table, code, and image tools. Use the math templates to build a formula or matrix, then finish the equation to apply it. Table controls let you edit rows, columns, and widths; code blocks keep their text and selected language.

Visual mode is an editable draft. It helps you work with content and structure; final typography, spacing, and page breaks come from the PDF.

## 4. Check the source

Switch the editor to **Source** to inspect packages, change the preamble, or work with custom LaTeX macros. The PDF remains on the right. Switch back to **Visual** to continue with content that the editor recognizes; unsupported syntax can still be edited in source mode.

![Source mode with the PDF still visible](../images/source-editor-en.png)

## 5. Choose the title date

Open **Settings → Compilation** and find **Document date**. Pick a preset, then choose **Apply date settings** to update the main TeX document. Applying a date is a document edit; save it before compiling.

| Choice                     | Result                                                                        |
| -------------------------- | ----------------------------------------------------------------------------- |
| Hide date                  | Keeps an explicit empty date so TeX does not add today's date.                |
| Automatic: YYYY-MM-DD      | Numeric year, month, day, separated by hyphens.                               |
| Automatic: YYYY/MM/DD      | Numeric year, month, day, separated by slashes.                               |
| Automatic: DD/MM/YYYY      | Numeric day, month, year, separated by slashes.                               |
| Automatic: document format | Uses TeX's date format; the document and its packages determine the language. |

An existing custom date appears as **Keep existing custom date**. It is preserved rather than rewritten through that disabled choice; edit custom date syntax in Source mode. The three numeric presets do not add language-specific month names.

![Workspace compilation settings](../images/compile-settings-en.png)

## 6. Compile and review

Click **Compile PDF** to run the local compiler. The bundled Tectonic engine may download missing TeX resources, so the first compilation or a newly used package may need an internet connection.

Review the PDF on the right after a successful build. If a build fails, inspect the diagnostics; the previous successful PDF remains visible. After further edits, compile again to check the latest document.

See [compilation](COMPILATION.md) for diagnostics and [known limitations](KNOWN_LIMITATIONS.md) for supported editing boundaries. The [recording guide](../media/RECORDING.md) follows this same sequence.
