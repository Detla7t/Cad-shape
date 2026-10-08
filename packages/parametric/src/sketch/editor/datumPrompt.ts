// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type ParameterValue, PubSub, Result } from "@chili3d/core";
import style from "./datumPrompt.module.css";

/**
 * The datum value dialogs: a single box (`promptDatum`) and the X/Y pair
 * (`promptDatumPair`), each published through `showDialog`.
 *
 * Split out of `SketchEditor` because a dialog is a different job from owning a session: these
 * build DOM, validate the typed text, and call back. They deliberately know nothing about the
 * solver — `onApplied` is where the caller re-solves and commits, and `options.resolve` is how
 * the caller supplies expression semantics (the dialog itself cannot tell a variable name from
 * a typo). That is also why `positiveOnly` is checked against the RESOLVED value: `-w` is a
 * negative input even though its text does not start with a minus.
 *
 * `SketchEditor.editDatum` stays where it is: it reads the constraint through the solver and
 * decides whether the value is signed or must be positive. That is editor policy, not dialog
 * mechanics.
 */

/**
 * The textbox's content as a parameter value: a number when it reads as one (so a plain
 * `50` stays a literal), otherwise the raw text, to be resolved as an expression.
 */
export function parseDatumInput(text: string): ParameterValue {
    const trimmed = text.trim();
    const value = Number(trimmed);
    return trimmed !== "" && Number.isFinite(value) ? value : trimmed;
}

/**
 * Shows the datum input in a modal dialog. A valid confirm runs `apply`, then `onApplied`.
 * Invalid input keeps the dialog open with an error message; cancelling runs `onCancel` and
 * changes nothing.
 */
export function promptDatum(
    initial: ParameterValue,
    apply: (value: ParameterValue) => void,
    onApplied: () => Result<void> | void,
    onCancel?: () => void,
    options?: {
        positiveOnly?: boolean;
        onAccepted?: () => void;
        inlineAt?: { x: number; y: number };
        initialText?: string;
        parse?: (text: string) => Result<ParameterValue>;
        /** Resolves an input to its display value — supplied by the editor, error text included. */
        resolve?: (input: ParameterValue) => Result<number>;
    },
): (() => void) | undefined {
    const textbox = document.createElement("input");
    const initialText = options?.initialText ?? (typeof initial === "number" ? initial.toFixed(2) : initial);
    textbox.value = initialText;
    textbox.autofocus = true;
    const error = createErrorLabel();
    const content = document.createElement("div");
    content.append(textbox, error);
    const confirm = () => {
        // Enter on the displayed (rounded) measurement accepts the exact original value.
        const parsed = validateDatumInput(
            textbox.value,
            textbox.value === initialText ? { ...options, parse: () => Result.ok(initial) } : options,
        );
        if (!parsed.isOk) {
            showDatumError(error, parsed.error);
            return false;
        }
        apply(parsed.value);
        const result = onApplied();
        if (result && !result.isOk) {
            showDatumError(error, result.error);
            return false;
        }
        options?.onAccepted?.();
        return true;
    };
    if (options?.inlineAt) {
        content.className = style.inline;
        content.setAttribute("role", "dialog");
        content.setAttribute("aria-label", "Edit dimension");
        textbox.setAttribute("aria-label", "Dimension value");
        const hint = document.createElement("small");
        hint.textContent = "Enter to apply · Esc to cancel";
        content.append(hint);
        content.style.left = `${Math.max(4, Math.min(options.inlineAt.x - 85, window.innerWidth - 180))}px`;
        content.style.top = `${Math.max(4, Math.min(options.inlineAt.y - 14, window.innerHeight - 90))}px`;
        let closed = false;
        const events = new AbortController();
        const close = (cancel: boolean) => {
            if (closed) return;
            closed = true;
            events.abort();
            content.remove();
            if (cancel) onCancel?.();
        };
        content.addEventListener("pointerdown", (event) => event.stopPropagation());
        content.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
                event.preventDefault();
                if (confirm()) close(false);
            }
            if (event.key === "Escape") {
                event.preventDefault();
                close(true);
            }
        });
        document.body.append(content);
        document.addEventListener(
            "pointerdown",
            (event) => {
                if (!content.contains(event.target as Node)) close(true);
            },
            { capture: true, signal: events.signal },
        );
        textbox.focus();
        textbox.select();
        return () => close(true);
    }
    PubSub.default.pub("showDialog", "dialog.title.enterValue", content, [
        { content: "common.confirm", shouldClose: confirm, onclick: () => {} },
        { content: "common.cancel", onclick: () => onCancel?.() },
    ]);
    setTimeout(() => textbox.select());
}

/**
 * Validates one textbox content, returning the input to apply or the message to show. A
 * literal is always acceptable (when `positiveOnly`, only a positive one); an expression
 * needs `resolve` to judge it, and is rejected outright when the caller supplied none.
 *
 * A `Result` rather than `value | message` because an expression IS a string — the two
 * would be indistinguishable.
 */
function validateDatumInput(
    text: string,
    options?: {
        positiveOnly?: boolean;
        parse?: (text: string) => Result<ParameterValue>;
        resolve?: (input: ParameterValue) => Result<number>;
    },
): Result<ParameterValue> {
    const parsed = options?.parse?.(text) ?? Result.ok(parseDatumInput(text));
    if (!parsed.isOk) return parsed;
    const input = parsed.value;
    if (input === "") return Result.err(invalidNumber());

    const resolved = options?.resolve?.(input) ?? (typeof input === "number" ? Result.ok(input) : undefined);
    if (resolved === undefined) return Result.err(invalidNumber());
    if (!resolved.isOk) return Result.err(resolved.error);
    if (options?.positiveOnly !== false && resolved.value <= 0) return Result.err(invalidNumber());
    return Result.ok(input);
}

/** Two-value variant of `promptDatum`, for multi-datum constraints (Fix = X, Y). */
export function promptDatumPair(
    initial: [ParameterValue, ParameterValue],
    apply: (x: ParameterValue, y: ParameterValue) => void,
    onApplied: () => Result<void> | void,
    options?: {
        positiveOnly?: boolean;
        resolve?: (input: ParameterValue) => Result<number>;
    },
): void {
    const { inputX, inputY, error, content } = createDatumPairInputs(initial);
    PubSub.default.pub("showDialog", "dialog.title.enterValue", content, [
        {
            content: "common.confirm",
            shouldClose: () => {
                const x = validateDatumInput(inputX.value, options);
                if (!x.isOk) {
                    showDatumError(error, x.error);
                    return false;
                }
                const y = validateDatumInput(inputY.value, options);
                if (!y.isOk) {
                    showDatumError(error, y.error);
                    return false;
                }
                apply(x.value, y.value);
                const result = onApplied();
                if (result && !result.isOk) {
                    showDatumError(error, result.error);
                    return false;
                }
                return true;
            },
            onclick: () => {},
        },
        { content: "common.cancel", onclick: () => {} },
    ]);
    setTimeout(() => inputX.select());
}

function invalidNumber(): string {
    return I18n.translate("error.input.invalidNumber") ?? "invalid number";
}

/** The hidden error line the datum prompts reveal when a typed value is rejected. */
function createErrorLabel(): HTMLLabelElement {
    const error = document.createElement("label");
    error.style.cssText = "color: red; font-size: 11px; display: none;";
    return error;
}

function showDatumError(error: HTMLLabelElement, message: string): void {
    error.textContent = message;
    error.style.display = "";
}

/** The X/Y number boxes plus the shared error label, wrapped in a dialog body. */
function createDatumPairInputs(initial: [ParameterValue, ParameterValue]): {
    inputX: HTMLInputElement;
    inputY: HTMLInputElement;
    error: HTMLLabelElement;
    content: HTMLElement;
} {
    const inputX = document.createElement("input");
    const inputY = document.createElement("input");
    inputX.value = typeof initial[0] === "number" ? initial[0].toFixed(2) : initial[0];
    inputY.value = typeof initial[1] === "number" ? initial[1].toFixed(2) : initial[1];
    inputX.autofocus = true;
    const error = createErrorLabel();
    const content = document.createElement("div");
    content.append(inputX, inputY, error);
    return { inputX, inputY, error, content };
}
