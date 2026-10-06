/* @ts-self-types="./texpile_typst_syntax_wasm.d.ts" */
import * as wasm from "./texpile_typst_syntax_wasm_bg.wasm";
import { __wbg_set_wasm } from "./texpile_typst_syntax_wasm_bg.js";

__wbg_set_wasm(wasm);

export {
    TypstSyntax
} from "./texpile_typst_syntax_wasm_bg.js";
