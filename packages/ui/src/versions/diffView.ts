// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DetailChange,
    type DocumentDiff,
    type DocumentVersionControl,
    describeDetail,
    I18n,
    type NodeDiff,
    type ObjectHash,
    type UnifiedLine,
    unifiedDiff,
} from "@chili3d/core";
import { button, div, li, span, ul } from "@chili3d/element";
import { showFloatPanel } from "../floatPanel";
import style from "./versions.module.css";

/** Opens the change view between two commits (`to` defaults to the current head). */
export function showDiffView(control: DocumentVersionControl, from: ObjectHash, to?: ObjectHash): void {
    const target = to ?? control.head;
    const diff = control.diff(from, target);
    showFloatPanel({
        title: "versions.compareTitle",
        content: diffView(diff, `${control.label(from)}  →  ${control.label(target)}`),
        width: 640,
        height: 520,
        minWidth: 360,
        minHeight: 240,
        x: Math.max(20, window.innerWidth / 2 - 320),
        y: 80,
        document: control.document,
    });
}

/** The change tree of a diff; Feature Studio sources render as a unified or side-by-side text diff. */
export function diffView(diff: DocumentDiff, title: string): HTMLElement {
    let sideBySide = false;
    const body = div({ className: style.viewBody });
    const render = () => {
        body.replaceChildren(...diffSections(diff, sideBySide));
    };
    const toggle = button({
        className: style.button,
        textContent: I18n.translate("versions.sideBySide"),
        onclick: () => {
            sideBySide = !sideBySide;
            toggle.textContent = I18n.translate(sideBySide ? "versions.unified" : "versions.sideBySide");
            render();
        },
    });
    render();
    return div(
        { className: style.view },
        div({ className: style.viewHeader }, div({ className: style.viewTitle, textContent: title }), toggle),
        body,
    );
}

function diffSections(diff: DocumentDiff, sideBySide: boolean): HTMLElement[] {
    const sections: HTMLElement[] = [];
    if (diff.nodes.length > 0) {
        sections.push(
            section(
                I18n.translate("versions.compareTitle"),
                diff.nodes.map((n) => nodeGroup(n, sideBySide)),
            ),
        );
    }
    const collections: [string, readonly DetailChange[]][] = [
        ["Variables", diff.variables],
        ["Materials", diff.materials],
        ["Components", diff.components],
        ["Document", diff.meta],
    ];
    for (const [name, details] of collections) {
        if (details.length > 0) sections.push(section(name, [detailList(details, sideBySide)]));
    }
    if (sections.length === 0)
        sections.push(div({ className: style.empty, textContent: I18n.translate("versions.noChanges") }));
    return sections;
}

function section(title: string, children: HTMLElement[]): HTMLElement {
    return div(
        { className: style.section },
        div({ className: style.sectionTitle, textContent: title }),
        ...children,
    );
}

const STATUS = {
    added: { key: "versions.added", className: style.added },
    removed: { key: "versions.removed", className: style.removed },
    changed: { key: "versions.changed", className: style.changed },
} as const;

function nodeGroup(node: NodeDiff, sideBySide: boolean): HTMLElement {
    const status = STATUS[node.status];
    const notes: string[] = [];
    if (node.renamedFrom !== undefined) notes.push(`Renamed from ${node.renamedFrom}`);
    if (node.moved?.reordered) notes.push("Reordered");
    else if (node.moved !== undefined) notes.push(`Moved to ${node.moved.to ?? "top level"}`);
    return div(
        { className: style.group },
        div(
            { className: style.groupTitle },
            span({
                className: `${style.status} ${status.className}`,
                textContent: I18n.translate(status.key),
            }),
            span({ textContent: node.name }),
        ),
        ...(notes.length > 0
            ? [ul({ className: style.changeList }, ...notes.map((n) => li({ textContent: n })))]
            : []),
        ...(node.changes.length > 0 ? [detailList(node.changes, sideBySide)] : []),
    );
}

function detailList(details: readonly DetailChange[], sideBySide: boolean): HTMLElement {
    return ul(
        { className: style.changeList },
        ...details.map((detail) =>
            detail.kind === "text"
                ? li(
                      { textContent: `${detail.property}: ${describeDetail(detail)}` },
                      textDiff(detail.before, detail.after, sideBySide),
                  )
                : li({ textContent: describeDetail(detail) }),
        ),
    );
}

/** A unified or side-by-side line diff. */
export function textDiff(before: string, after: string, sideBySide: boolean): HTMLElement {
    const lines = unifiedDiff(before, after);
    if (!sideBySide) return div({ className: style.code }, ...lines.map((line) => codeLine(line)));
    const left: (UnifiedLine | undefined)[] = [];
    const right: (UnifiedLine | undefined)[] = [];
    let removed: UnifiedLine[] = [];
    let added: UnifiedLine[] = [];
    const flush = () => {
        const count = Math.max(removed.length, added.length);
        for (let i = 0; i < count; i++) {
            left.push(removed[i]);
            right.push(added[i]);
        }
        removed = [];
        added = [];
    };
    for (const line of lines) {
        if (line.kind === "remove") removed.push(line);
        else if (line.kind === "add") added.push(line);
        else {
            flush();
            left.push(line);
            right.push(line);
        }
    }
    flush();
    const cells: HTMLElement[] = [];
    left.forEach((line, i) => {
        cells.push(codeLine(line, "old"), codeLine(right[i], "new"));
    });
    return div({ className: `${style.code} ${style.sideBySide}` }, ...cells);
}

function codeLine(line: UnifiedLine | undefined, side?: "old" | "new"): HTMLElement {
    if (line === undefined)
        return div({ className: style.codeLine }, span({ className: style.lineNo }), span());
    const kindClass =
        line.kind === "add"
            ? style.lineAdd
            : line.kind === "remove"
              ? style.lineRemove
              : line.kind === "skip"
                ? style.lineSkip
                : "";
    const number =
        side === "new" ? line.newLine : side === "old" ? line.oldLine : (line.newLine ?? line.oldLine);
    const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
    return div(
        { className: `${style.codeLine} ${kindClass}` },
        span({ className: style.lineNo, textContent: number === undefined ? "" : String(number) }),
        span({
            className: style.lineText,
            textContent: line.kind === "skip" ? line.text : `${marker} ${line.text}`,
        }),
    );
}
