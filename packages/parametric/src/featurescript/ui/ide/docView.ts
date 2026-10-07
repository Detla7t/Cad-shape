// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n } from "@chili3d/core";
import { formatSignature, type Signature } from "./declarations";
import type { ParsedDoc } from "./docComment";
import style from "./ide.module.css";
import type { SignatureHelp, Target } from "./navigation";
import type { SymbolInfo, SymbolTable } from "./symbols";

/**
 * Renders documentation as DOM: std's markdown-lite (inline code, `[links]`, fenced
 * code, paragraphs) and the symbol cards hover, completion info and signature help show.
 */

function translate(key: Parameters<typeof I18n.translate>[0], ...args: unknown[]): string {
    return I18n.translate(key, ...(args as never[])) ?? String(key);
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** Inline markdown-lite: `code`, [name] references, **bold**. */
function inline(text: string, into: HTMLElement): void {
    const pattern = /`([^`]+)`|\[([A-Za-z_][\w.]*)\]|\*\*([^*]+)\*\*/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index > last) into.append(text.slice(last, match.index));
        if (match[1] !== undefined) into.append(el("code", undefined, match[1]));
        else if (match[2] !== undefined) into.append(el("code", undefined, match[2]));
        else into.append(el("strong", undefined, match[3]));
        last = match.index + match[0].length;
    }
    if (last < text.length) into.append(text.slice(last));
}

/** Block markdown-lite: paragraphs and ``` fenced code. */
export function renderMarkdown(text: string, into: HTMLElement): void {
    const parts = text.split(/```/);
    parts.forEach((part, index) => {
        if (index % 2 === 1) {
            into.append(el("pre", undefined, part.replace(/^\w*\n/, "").replace(/^\n+|\n+$/g, "")));
            return;
        }
        for (const paragraph of part.split(/\n{2,}/)) {
            if (paragraph.trim() === "") continue;
            const p = el("p");
            inline(paragraph.trim(), p);
            into.append(p);
        }
    });
}

function signatureLine(
    name: string,
    signature: Signature | undefined,
    kind: string,
    active?: number,
): HTMLElement {
    const line = el("div", style.docSignature);
    if (signature === undefined || active === undefined) {
        line.append(formatSignature(name, signature));
    } else {
        line.append(`${name}(`);
        signature.params.forEach((param, index) => {
            if (index > 0) line.append(", ");
            const text = param.type ? `${param.name} is ${param.type}` : param.name;
            line.append(index === active ? el("span", style.docActive, text) : text);
        });
        line.append(signature.returns ? `) returns ${signature.returns}` : ")");
    }
    line.append(el("span", style.docKind, kind));
    return line;
}

function originLabel(symbol: SymbolInfo, index = 0): string {
    const origin = symbol.origin;
    if (origin.kind === "std")
        return `${symbol.kind} · onshape/std/${symbol.modules?.[index] ?? origin.module}`;
    if (origin.kind === "studio") return `${symbol.kind} · ${origin.studioName}`;
    return symbol.kind;
}

function docBody(
    doc: ParsedDoc | undefined,
    into: HTMLElement,
    options: { activeParam?: string } = {},
): void {
    if (doc === undefined) return;
    if (doc.internal) into.append(el("div", style.docInternal, "@internal"));
    if (doc.summary !== "") renderMarkdown(doc.summary, into);
    const params =
        options.activeParam !== undefined
            ? doc.params.filter((p) => p.name === options.activeParam)
            : doc.params;
    const describedParams = params.filter(
        (param) => param.text !== "" || param.fields.length > 0 || param.autocomplete,
    );
    if (describedParams.length > 0) {
        into.append(el("div", style.docSection, translate("featurescript.ide.doc.parameters")));
        for (const param of describedParams) {
            const item = el("div", style.docItem);
            item.append(el("span", style.docItemName, param.name));
            const flags = [param.type, param.optional ? "optional" : undefined].filter(Boolean).join(", ");
            if (flags !== "") item.append(el("span", style.docMuted, ` {${flags}}`));
            if (param.text !== "") {
                item.append(" — ");
                inline(param.text, item);
            }
            if (param.autocomplete) {
                const eg = el("span", style.docMuted, " e.g. ");
                inline(param.autocomplete, eg);
                item.append(eg);
            }
            for (const field of param.fields.slice(0, 40)) {
                const row = el("div", style.docItem);
                row.append(el("span", style.docItemName, `"${field.name}"`));
                const flags = [field.type, field.optional ? "optional" : undefined]
                    .filter(Boolean)
                    .join(", ");
                if (flags !== "") row.append(el("span", style.docMuted, ` {${flags}}`));
                if (field.text !== "") {
                    row.append(" — ");
                    inline(field.text, row);
                }
                if (field.requiredIf !== undefined) {
                    const required = el(
                        "span",
                        style.docMuted,
                        ` ${translate("featurescript.ide.doc.requiredIf")} `,
                    );
                    inline(field.requiredIf, required);
                    row.append(required);
                }
                item.append(row);
            }
            into.append(item);
        }
    }
    if (options.activeParam !== undefined) return;
    if (doc.returns !== undefined && (doc.returns.text !== "" || doc.returns.type)) {
        into.append(el("div", style.docSection, translate("featurescript.ide.doc.returns")));
        const item = el("div", style.docItem);
        if (doc.returns.type) item.append(el("span", style.docMuted, `{${doc.returns.type}} `));
        inline(doc.returns.text, item);
        into.append(item);
    }
    if (doc.examples.length > 0) {
        into.append(el("div", style.docSection, translate("featurescript.ide.doc.examples")));
        for (const example of doc.examples.slice(0, 6)) {
            const item = el("div", style.docItem);
            renderMarkdown(example, item);
            into.append(item);
        }
    }
    if (doc.seeAlso.length > 0) {
        const item = el("div", style.docMuted);
        item.append(`${translate("featurescript.ide.doc.seeAlso")} `);
        inline(doc.seeAlso.join(", "), item);
        into.append(item);
    }
}

/** A symbol's card: its signatures (overloads), where it comes from, and its documentation. */
export function renderSymbol(symbol: SymbolInfo, table: SymbolTable): HTMLElement {
    const root = el("div", style.doc);
    const shown = symbol.declarations.slice(0, 6);
    shown.forEach((declaration, index) => {
        const kind = index === 0 ? originLabel(symbol, index) : "";
        if (declaration.kind === "feature") {
            const label = declaration.annotation?.get("Feature Type Name");
            root.append(
                signatureLine(symbol.name, declaration.signature, label ? `feature "${label}"` : kind),
            );
        } else if (
            declaration.kind === "const" ||
            declaration.kind === "type" ||
            declaration.kind === "enum"
        ) {
            const type = declaration.type ? ` is ${declaration.type}` : "";
            root.append(signatureLine(`${declaration.kind} ${symbol.name}${type}`, undefined, kind));
        } else {
            root.append(signatureLine(symbol.name, declaration.signature, kind));
        }
    });
    if (symbol.declarations.length > shown.length) {
        root.append(
            el(
                "div",
                style.docMuted,
                translate(
                    "featurescript.ide.doc.moreOverloads{0}",
                    symbol.declarations.length - shown.length,
                ),
            ),
        );
    }
    const doc = table.doc(symbol);
    docBody(doc, root);
    const declaration = symbol.declarations[0];
    if (
        declaration.kind === "enum" &&
        declaration.members !== undefined &&
        (doc === undefined || doc.values.size === 0)
    ) {
        root.append(el("div", style.docSection, translate("featurescript.ide.doc.values")));
        root.append(el("div", style.docItem, declaration.members.map((m) => m.name).join(", ")));
    }
    if (declaration.kind === "feature" && declaration.fields !== undefined && declaration.fields.length > 0) {
        root.append(el("div", style.docSection, translate("featurescript.ide.doc.featureParameters")));
        for (const field of declaration.fields.slice(0, 30)) {
            const row = el("div", style.docItem);
            row.append(el("span", style.docItemName, field.name));
            const parts = [field.label ? `"${field.label}"` : undefined, field.type, field.bounds].filter(
                Boolean,
            );
            if (parts.length > 0) row.append(el("span", style.docMuted, ` ${parts.join(" · ")}`));
            root.append(row);
        }
    }
    return root;
}

/** The card for whatever `targetAt` found. */
export function renderTarget(target: Target, table: SymbolTable): HTMLElement {
    switch (target.kind) {
        case "symbol":
            return renderSymbol(target.symbol, table);
        case "local": {
            const root = el("div", style.doc);
            const type = target.local.type ? ` is ${target.local.type}` : "";
            const keyword =
                target.local.kind === "constant" ? "const" : target.local.kind === "variable" ? "var" : "";
            root.append(
                signatureLine(`${keyword} ${target.local.name}${type}`.trim(), undefined, target.local.kind),
            );
            return root;
        }
        case "enumMember": {
            const root = el("div", style.doc);
            const label = target.member.label !== undefined ? `"${target.member.label}"` : "";
            root.append(
                signatureLine(
                    `${target.symbol.name}.${target.member.name}`,
                    undefined,
                    `enum value ${label}`.trim(),
                ),
            );
            if (target.text !== undefined) renderMarkdown(target.text, root);
            return root;
        }
        case "field": {
            const root = el("div", style.doc);
            const field = target.field;
            const parts = [field.type, field.bounds].filter(Boolean).join(" · ");
            root.append(
                signatureLine(`definition.${field.name}`, undefined, `parameter of ${target.feature.name}`),
            );
            if (field.label !== undefined) root.append(el("p", undefined, `"${field.label}"`));
            if (parts !== "") root.append(el("p", style.docMuted, parts));
            return root;
        }
        case "docField": {
            const root = el("div", style.doc);
            const field = target.field;
            root.append(signatureLine(`"${field.name}"`, undefined, `field of ${target.symbol.name}`));
            const flags = [field.type, field.optional ? "optional" : undefined].filter(Boolean).join(", ");
            if (flags !== "") root.append(el("p", style.docMuted, `{${flags}}`));
            if (field.text !== "") renderMarkdown(field.text, root);
            if (field.requiredIf !== undefined) {
                const p = el("p", style.docMuted, `${translate("featurescript.ide.doc.requiredIf")} `);
                inline(field.requiredIf, p);
                root.append(p);
            }
            if (field.examples.length > 0) {
                const p = el("p", style.docMuted, "e.g. ");
                inline(field.examples.join(", "), p);
                root.append(p);
            }
            return root;
        }
        case "annotationKey": {
            const root = el("div", style.doc);
            root.append(signatureLine(`"${target.key}"`, undefined, "annotation key"));
            renderMarkdown(target.info, root);
            return root;
        }
    }
}

/** Signature help: the overloads with the active parameter marked, and that parameter's docs. */
export function renderSignatureHelp(help: SignatureHelp): HTMLElement {
    const root = el("div", style.doc);
    help.signatures.slice(0, 4).forEach((signature, index) => {
        const active = index === help.active ? help.argument : undefined;
        root.append(
            signatureLine(help.symbol.name, signature, index === 0 ? originLabel(help.symbol) : "", active),
        );
    });
    if (help.signatures.length > 4)
        root.append(
            el(
                "div",
                style.docMuted,
                translate("featurescript.ide.doc.moreOverloads{0}", help.signatures.length - 4),
            ),
        );
    const activeName = help.signatures[help.active]?.params[help.argument]?.name;
    const param = help.doc?.params.find((candidate) => candidate.name === activeName);
    if (param === undefined) return root;
    const item = el("div", style.docItem);
    item.append(el("span", style.docItemName, param.name));
    if (param.text !== "") {
        item.append(" — ");
        inline(param.text, item);
    }
    if (param.autocomplete) {
        const eg = el("span", style.docMuted, " e.g. ");
        inline(param.autocomplete, eg);
        item.append(eg);
    }
    root.append(item);
    if (param.fields.length > 0) {
        // The field docs are in the completion list; here just which keys the map takes.
        const fields = el("div", style.docItem);
        param.fields.forEach((field, index) => {
            if (index > 0) fields.append(", ");
            fields.append(el("code", field.optional ? style.docMuted : undefined, field.name));
        });
        root.append(fields);
    }
    return root;
}

/** Plain markdown-lite text as a doc card (annotation keys, definition fields in completion info). */
export function renderText(text: string): HTMLElement {
    const root = el("div", style.doc);
    renderMarkdown(text, root);
    return root;
}
