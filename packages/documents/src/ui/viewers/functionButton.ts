// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { formulaCompletion, insertFunctionCall } from "@chili3d/sheet/formulaSuggestions";
import { functionDoc } from "@chili3d/sheet/functionInfo";
import style from "../spreadsheet.module.css";
import { createFunctionBrowser } from "./functionBrowser";
import { sheetButton } from "./sheetControls";

export interface FunctionButtonContext {
    formulaInput: HTMLInputElement;
    /** The formula bar row: the browser opens under it, and presses inside it do not dismiss it. */
    formulaBar(): HTMLElement;
    /** The functions the engine evaluates. */
    names(): readonly string[];
    /** What the formula bar shows for the active cell when it is not being edited. */
    storedText(): string;
    /** Ends an open in-cell edit without committing it and returns its text and caret. */
    takeCellEditor(): { text: string; cursor: number } | undefined;
    /** Replaces the active cell's formula (or the pending formula bar formula) with its value, as one undo step. */
    toValue(): void;
    /** Drops the formula bar edit, optionally returning focus to the grid. */
    revert(focusGrid: boolean): void;
    /** Commits the formula bar edit. */
    commit(): void;
    /** The formula bar text changed programmatically. */
    edited(): void;
    /** Shows the argument hint for the call at the formula bar caret. */
    showHint(): void;
    hideHint(): void;
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?%?$/;
const REFERENCE = /^(?:(?:'[^']+'|[A-Za-z_][\w.]*)!)?\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/;

/**
 * The formula bar's fx button. Pressed (aria-pressed) while the formula bar holds a
 * formula. Clicking it on a value starts a formula — `=` (a number or reference is kept as
 * `=value`, which becomes the first argument of the function inserted next) — and opens the
 * function browser; clicking it on the cell's stored formula replaces the formula with its
 * value (one undo step); on a formula still being typed it opens the browser to insert at
 * the caret; on an untouched `=` it undoes the start. Shift+F3 always opens the browser.
 */
export function createFunctionButton(ctx: FunctionButtonContext) {
    const input = ctx.formulaInput;
    /** The formula fx started from a value (`=12`): untouched, the next function wraps it. */
    let started: string | undefined;
    let caret = 0;

    const button = sheetButton("Insert function", "fx", toggle);
    button.className = style.fxButton;
    const browser = createFunctionBrowser({
        names: ctx.names,
        insert(name) {
            const wrapRest = started !== undefined && input.value === started && caret === 1;
            const result = insertFunctionCall(input.value, caret, name, {
                names: ctx.names(),
                zeroArgs: functionDoc(name).zeroArgs,
                wrapRest,
            });
            started = undefined;
            input.value = result.text;
            input.focus();
            input.setSelectionRange(result.cursor, result.cursor);
            ctx.edited();
            ctx.showHint();
            sync();
        },
        cancel() {
            input.focus();
            input.setSelectionRange(caret, caret);
            sync();
        },
        dismiss() {
            const untouched = input.value.trim() === "=" || input.value === started;
            started = undefined;
            if (untouched) ctx.revert(false);
            else if (input.value !== ctx.storedText()) ctx.commit();
            sync();
        },
    });

    function sync(): void {
        const formula = input.value.trimStart().startsWith("=");
        button.setAttribute("aria-pressed", String(formula));
        button.title = formula
            ? "Formula: click to replace it with its value (Shift+F3 browses functions)"
            : "Insert function (Shift+F3)";
    }

    /** Puts the edit in the formula bar, starting a formula if needed, and remembers the caret. */
    function begin(moved = ctx.takeCellEditor()): void {
        if (moved) {
            input.value = moved.text;
            caret = moved.cursor;
        } else
            caret =
                document.activeElement === input
                    ? (input.selectionStart ?? input.value.length)
                    : input.value.length;
        if (!input.value.trimStart().startsWith("=")) {
            const value = input.value.trim();
            const operand = NUMBER.test(value) || REFERENCE.test(value);
            input.value = operand ? `=${value}` : "=";
            started = operand ? input.value : undefined;
            caret = 1;
            ctx.edited();
        }
        input.focus();
        input.setSelectionRange(caret, caret);
        sync();
    }

    function openBrowser(moved?: { text: string; cursor: number }): void {
        begin(moved);
        ctx.hideHint();
        const completion = formulaCompletion(input.value, caret);
        const query = completion ? input.value.slice(completion.start, caret) : "";
        browser.open(ctx.formulaBar(), ctx.formulaBar(), query);
    }

    function toggle(): void {
        const moved = ctx.takeCellEditor();
        if (moved) input.value = moved.text;
        const text = input.value;
        if (!text.trimStart().startsWith("=")) {
            openBrowser(moved);
            return;
        }
        if (text.trim() === "=" || text === started) {
            browser.close();
            started = undefined;
            ctx.revert(true);
            sync();
        } else if (text === ctx.storedText()) {
            browser.close();
            started = undefined;
            ctx.toValue();
            sync();
        } else if (!browser.isOpen()) openBrowser(moved);
    }

    input.addEventListener("input", sync);
    return {
        button,
        sync,
        openBrowser: () => openBrowser(),
        /** While open, focus sits in the browser; the formula bar must not commit on blur. */
        browsing: () => browser.isOpen(),
        /** Shift+F3 from the grid, the in-cell editor or the formula bar. */
        handleKey(event: KeyboardEvent): boolean {
            if (event.key !== "F3" || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
                return false;
            event.preventDefault();
            openBrowser();
            return true;
        },
        dispose() {
            input.removeEventListener("input", sync);
            browser.dispose();
        },
    };
}
