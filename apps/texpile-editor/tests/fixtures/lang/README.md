# Language / font fixtures

Real engine output, captured by `node scripts/capture-lang-fixtures.mjs` through the exact job
string `draft-service.ts` builds. `<case>.jsonl` is the page's records, `<case>.pages.json` its
manifest.

They exist because live preview was broken for every document that loaded a font through
fontspec, and nothing in the suite would have noticed: luaotfload quotes the font name it
reports whenever the family has a space, the walker interpolated that name into JSON raw, and
the renderer parsed a page one JSON.parse per line -- so `\setmainfont{Times New Roman}` blanked
the page. Hand-written records could not have caught it; only the engine's own output does.

Font paths inside the fixtures are absolute and machine-specific. The tests assert on record
SHAPE and never on a path. Cases naming a font this machine lacks are skipped by the capture
script with a message, so a partial regeneration is visible rather than silent.
