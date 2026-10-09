// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    HighlightStyle,
    LanguageSupport,
    StreamLanguage,
    type StreamParser,
    syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";

/**
 * G-code for CodeMirror: a line-based streaming tokenizer — comments in `( )` and after
 * `;`, `%` tape marks, `/` block delete, `N` sequence numbers, G and M codes, axis words,
 * feeds/speeds/tools, `#` parameters and `[ ]` expressions, o-words and macro keywords —
 * and a highlight style in the app's colours (light and dark through CSS variables).
 */

interface GcodeState {
    /** Inside a `( )` comment that has not closed on this line. */
    comment: boolean;
}

const AXES = new Set(["X", "Y", "Z", "A", "B", "C", "U", "V", "W", "E"]);
const ARC = new Set(["I", "J", "K", "R"]);
const SETTINGS = new Set(["F", "S", "T", "H", "D", "P", "Q", "L"]);
const KEYWORDS =
    /^(IF|THEN|GOTO|WHILE|DO\d*|END\d*|SUB|ENDSUB|CALL|ELSEIF|ELSE|ENDIF|ENDWHILE|REPEAT|ENDREPEAT|RETURN|BREAK|CONTINUE)\b/i;
const OPERATORS =
    /^(EQ|NE|GT|GE|LT|LE|AND|OR|XOR|MOD|SIN|COS|TAN|ASIN|ACOS|ATAN|SQRT|ABS|ROUND|FIX|FUP|LN|EXP|EXISTS)\b/i;

export const gcodeParser: StreamParser<GcodeState> = {
    name: "gcode",
    startState: () => ({ comment: false }),
    copyState: (state) => ({ ...state }),
    token(stream, state) {
        if (state.comment) {
            if (stream.skipTo(")")) {
                stream.next();
                state.comment = false;
            } else {
                stream.skipToEnd();
            }
            return "comment";
        }
        if (stream.eatSpace()) return null;
        const sol = stream.sol() || /^\s*$/.test(stream.string.slice(0, stream.pos));
        const ch = stream.peek() ?? "";
        if (ch === "(") {
            stream.next();
            if (stream.skipTo(")")) stream.next();
            else {
                stream.skipToEnd();
                state.comment = true;
            }
            return "comment";
        }
        if (ch === ";") {
            stream.skipToEnd();
            return "comment";
        }
        if (ch === "%" && sol) {
            stream.skipToEnd();
            return "meta";
        }
        if (ch === "/" && sol) {
            stream.next();
            stream.match(/^\d/);
            return "meta";
        }
        if (stream.match(/^[Nn]\s*\d+/)) return sol ? "lineComment" : "number";
        if (stream.match(/^[Oo]\s*(\d+|<[^>]*>)/)) return "labelName";
        if (stream.match(KEYWORDS)) return "controlKeyword";
        if (stream.match(OPERATORS)) return "operatorKeyword";
        if (stream.match(/^#\s*(<[^>]*>|\d+)/)) return "variableName";
        if (stream.match(/^[Gg]\s*\d+(\.\d+)?/)) return "keyword";
        if (stream.match(/^[Mm]\s*\d+(\.\d+)?/)) return "atom";
        if (stream.match(/^[A-Za-z_]{2,}[A-Za-z0-9_]*/)) return "macroName"; // TRAORI, CYCLE800, PRINT_START
        const letter = ch.toUpperCase();
        if (/[A-Z]/.test(letter)) {
            stream.next();
            stream.eatSpace();
            stream.match(/^[-+]?(\d+\.?\d*|\.\d+)/);
            if (AXES.has(letter)) return "propertyName";
            if (ARC.has(letter)) return "attributeName";
            if (SETTINGS.has(letter)) return "typeName";
            return "string";
        }
        if (stream.match(/^[-+]?(\d+\.?\d*|\.\d+)/)) return "number";
        if (stream.match(/^"[^"]*"?/)) return "string";
        if (stream.match(/^[[\]]/)) return "bracket";
        stream.next();
        return "operator";
    },
    languageData: { commentTokens: { line: ";", block: { open: "(", close: ")" } } },
};

export const gcodeLanguage = StreamLanguage.define(gcodeParser);

const highlight = HighlightStyle.define([
    { tag: tags.comment, color: "var(--nc-comment, #6a8a6a)", fontStyle: "italic" },
    { tag: tags.meta, color: "var(--nc-meta, #9a7bb5)" },
    { tag: tags.lineComment, color: "var(--foreground-muted-color, #888)" },
    { tag: tags.keyword, color: "var(--nc-g, #2f6fd6)", fontWeight: "600" },
    { tag: tags.atom, color: "var(--nc-m, #c2410c)", fontWeight: "600" },
    { tag: tags.propertyName, color: "var(--nc-axis, #0f766e)" },
    { tag: tags.attributeName, color: "var(--nc-arc, #7c3aed)" },
    { tag: tags.typeName, color: "var(--nc-setting, #a16207)" },
    { tag: tags.variableName, color: "var(--nc-variable, #be185d)" },
    { tag: [tags.controlKeyword, tags.operatorKeyword, tags.labelName], color: "var(--nc-control, #b91c1c)" },
    { tag: tags.macroName, color: "var(--nc-macro, #0369a1)" },
    { tag: tags.number, color: "var(--foreground-color)" },
    { tag: tags.string, color: "var(--foreground-secondary-color, #666)" },
]);

/** The G-code language with its highlighting. */
export function gcode(): Extension {
    return [new LanguageSupport(gcodeLanguage), syntaxHighlighting(highlight)];
}
