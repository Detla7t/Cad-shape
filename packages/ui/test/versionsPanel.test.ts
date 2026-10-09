// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentVersionControl, FolderNode, PubSub, type PubSubEventMap, Transaction } from "@chili3d/core";
import { createMockApplication, createMockView, TestDocument } from "@chili3d/core/test-utils";
import { closeVersionsMenu } from "../src/versions/versionsMenu";
import { relativeTime, VersionsPanel } from "../src/versions/versionsPanel";

function clickText(root: ParentNode, text: string) {
    const button = [...root.querySelectorAll("button")].find((b) => b.textContent === text);
    expect(button).not.toBeUndefined();
    button!.click();
}

test("commits expand independently and selected fields can be reverted through the preview", () => {
    const doc = new TestDocument();
    const node = new FolderNode({ document: doc, name: "Original" });
    doc.modelManager.rootNode.add(node);
    const control = DocumentVersionControl.create(doc);
    Transaction.execute(doc, "Rename and hide", () => {
        node.name = "Edited";
        node.visible = false;
    });
    control.flush();
    const edited = control.head;
    const checkpoint = control.createCommit("Review checkpoint");
    expect(checkpoint.isOk).toBe(true);
    const app = createMockApplication();
    app.activeView = createMockView({ document: doc });
    const panel = new VersionsPanel(app);
    document.body.append(panel);
    try {
        for (const id of [checkpoint.value, edited]) {
            const disclosure = panel.querySelector<HTMLButtonElement>(
                `[data-commit="${id}"] button[aria-expanded]`,
            );
            expect(disclosure).not.toBeNull();
            disclosure!.click();
        }
        expect(panel.querySelectorAll('button[aria-expanded="true"]')).toHaveLength(2);
        const row = panel.querySelector(`[data-commit="${edited}"]`);
        expect(row).not.toBeNull();
        const rename = [...row!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((c) =>
            c.ariaLabel?.endsWith(" › name"),
        );
        expect(rename).not.toBeUndefined();
        rename!.click();
        clickText(row!, "versions.revertSelected");
        const preview = document.querySelector<HTMLDialogElement>(
            'dialog[aria-label="Revert selected changes"]',
        );
        expect(preview).not.toBeNull();
        expect(node.name).toBe("Edited");
        clickText(preview!, "Apply");
        expect(node.name).toBe("Original");
        expect(node.visible).toBe(false);
        expect(document.querySelector('dialog[aria-label="Revert selected changes"]')).toBeNull();
        doc.history.undo();
        expect(node.name).toBe("Edited");
    } finally {
        panel.remove();
        document.querySelector('dialog[aria-label="Revert selected changes"]')?.remove();
        control.dispose();
        doc.dispose();
    }
});

/** Opens a history entry's context menu through its ⋯ button. */
function openMenu(panel: HTMLElement, commit: string) {
    const button = panel.querySelector<HTMLButtonElement>(
        `[data-commit="${commit}"] button[aria-haspopup="menu"]`,
    );
    expect(button).not.toBeNull();
    button!.click();
}

function menu(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[role="menu"]');
    expect(element).not.toBeNull();
    return element!;
}

function panelFor(doc: TestDocument) {
    const app = createMockApplication();
    app.activeView = createMockView({ document: doc });
    const panel = new VersionsPanel(app);
    document.body.append(panel);
    return panel;
}

/** Captures the next PubSub dialog the panel opens: its form and its confirm callback. */
function captureDialog() {
    const captured: { content?: HTMLElement; confirm?: () => void } = {};
    const listener: PubSubEventMap["showDialog"] = (_title, content, buttons) => {
        captured.content = content;
        captured.confirm = typeof buttons === "function" ? buttons : undefined;
    };
    PubSub.default.sub("showDialog", listener);
    return { captured, dispose: () => PubSub.default.remove("showDialog", listener) };
}

function addFolder(doc: TestDocument, name: string) {
    Transaction.execute(doc, `add ${name}`, () =>
        doc.modelManager.rootNode.add(new FolderNode({ document: doc, name })),
    );
}

test("uncommitted operations fold into one pending row and commit as one squashed commit", () => {
    const doc = new TestDocument();
    const control = DocumentVersionControl.create(doc);
    expect(control.createCommit("Start").isOk).toBe(true);
    for (const name of ["A", "B", "C"]) {
        addFolder(doc, name);
        control.flush();
    }
    const pending = control.pendingOperations().map((c) => c.id);
    expect(pending).toHaveLength(3);
    const panel = panelFor(doc);
    const dialog = captureDialog();
    try {
        const row = panel.querySelector<HTMLElement>("[data-pending]");
        expect(row).not.toBeNull();
        // translations are identity in tests: the key with its argument substituted
        expect(row!.textContent).toContain("versions.pending3");
        // the three operations are not separate commit rows
        for (const id of pending) expect(panel.querySelector(`[data-commit="${id}"]`)).toBeNull();
        row!.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click();
        const expanded = panel.querySelector<HTMLElement>("[data-pending]")!;
        expect(expanded.querySelectorAll("[data-commit]")).toHaveLength(3);
        clickText(expanded, "versions.commitEllipsis");
        expect(dialog.captured.content).not.toBeUndefined();
        // the element helper sets the ariaLabel property, which happy-dom does not reflect as an attribute
        const inputs = [...dialog.captured.content!.querySelectorAll<HTMLInputElement>("input")];
        const message = inputs.find((x) => x.ariaLabel === "Commit message")!;
        expect(message).not.toBeUndefined();
        message.value = "Three folders";
        const squash = inputs.find((x) => x.ariaLabel === "Squash pending changes")!;
        expect(squash).not.toBeUndefined();
        expect(squash.checked).toBe(true);
        dialog.captured.confirm!();
        expect(control.headCommit()).toMatchObject({ kind: "checkpoint", message: "Three folders" });
        expect(control.log().map((c) => c.message)).toEqual(["Three folders", "Start", "Document created"]);
        expect(panel.querySelector("[data-pending]")).toBeNull();
        expect(doc.modelManager.findNodes().map((n) => n.name)).toEqual(["A", "B", "C"]);
    } finally {
        closeVersionsMenu();
        dialog.dispose();
        panel.remove();
        control.dispose();
        doc.dispose();
    }
});

test("Squash to here folds every later commit into one", () => {
    const doc = new TestDocument();
    const control = DocumentVersionControl.create(doc);
    const base = control.createCommit("Base");
    expect(base.isOk).toBe(true);
    for (const name of ["A", "B"]) {
        addFolder(doc, name);
        control.flush();
        expect(control.createCommit(`Added ${name}`).isOk).toBe(true);
    }
    const panel = panelFor(doc);
    const dialog = captureDialog();
    try {
        openMenu(panel, base.value);
        clickText(menu(), "versions.squashToHere");
        const field = dialog.captured.content!.querySelector<HTMLInputElement>("input")!;
        expect(field.value).toBe("Added B");
        field.value = "A and B";
        dialog.captured.confirm!();
        expect(control.log().map((c) => c.message)).toEqual(["A and B", "Base", "Document created"]);
        expect(control.headCommit().parents).toEqual([base.value]);
        // the head row offers no squash
        openMenu(panel, control.head);
        const squash = [...menu().querySelectorAll("button")].find(
            (b) => b.textContent === "versions.squashToHere",
        )!;
        expect(squash.disabled).toBe(true);
    } finally {
        closeVersionsMenu();
        dialog.dispose();
        panel.remove();
        control.dispose();
        doc.dispose();
    }
});

function key(target: HTMLElement, name: string, init: KeyboardEventInit = {}) {
    target.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }),
    );
}

function item(panel: HTMLElement, commit: string): HTMLElement {
    const element = panel.querySelector<HTMLElement>(`[role="treeitem"][data-commit="${commit}"]`);
    expect(element).not.toBeNull();
    return element!;
}

/** Base → (A, B folded) checkpoint "Two folders" → version V1 named on it. */
function versionedHistory() {
    const doc = new TestDocument();
    const control = DocumentVersionControl.create(doc);
    const base = control.createCommit("Base");
    expect(base.isOk).toBe(true);
    const operations: string[] = [];
    for (const name of ["A", "B"]) {
        addFolder(doc, name);
        control.flush();
        operations.push(control.head);
    }
    const checkpoint = control.createCommit("Two folders");
    expect(checkpoint.isOk).toBe(true);
    const version = control.createVersion("V1", "First release");
    expect(version.isOk).toBe(true);
    return {
        doc,
        control,
        base: base.value,
        checkpoint: checkpoint.value,
        version: version.value,
        operations,
    };
}

test("versions stand out with their description and the filter shows only them", () => {
    const { doc, control, base, version } = versionedHistory();
    const panel = panelFor(doc);
    try {
        const row = item(panel, version.commit);
        expect(row.getAttribute("aria-label")).toBe("V1");
        expect(row.textContent).toContain("First release");
        expect(row.textContent).toContain("versions.current");
        const filter = panel.querySelector<HTMLButtonElement>(
            'button[aria-pressed][aria-label="versions.versionsOnly"]',
        );
        expect(filter).not.toBeNull();
        filter!.click();
        expect(filter!.getAttribute("aria-pressed")).toBe("true");
        const shown = [...panel.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="1"]')];
        expect(shown.map((x) => x.dataset["commit"])).toEqual([version.commit]);
        filter!.click();
        expect(panel.querySelector(`[data-commit="${base}"]`)).not.toBeNull();
    } finally {
        panel.remove();
        control.dispose();
        doc.dispose();
    }
});

test("search matches messages, version descriptions and folded changes", () => {
    const { doc, control, base, checkpoint, version } = versionedHistory();
    const panel = panelFor(doc);
    const search = panel.querySelector<HTMLInputElement>('input[type="search"]')!;
    const rows = () =>
        [...panel.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="1"]')].map(
            (x) => x.dataset["commit"],
        );
    try {
        expect(search).not.toBeNull();
        search.value = "first release";
        search.dispatchEvent(new Event("input"));
        expect(rows()).toEqual([version.commit]);
        // "add A" is a folded operation of the checkpoint: the checkpoint row matches
        search.value = "add a";
        search.dispatchEvent(new Event("input"));
        expect(rows()).toEqual([checkpoint]);
        search.value = "no such entry";
        search.dispatchEvent(new Event("input"));
        expect(rows()).toEqual([]);
        expect(panel.textContent).toContain("versions.noMatches");
        search.value = "";
        search.dispatchEvent(new Event("input"));
        expect(rows()).toContain(base);
    } finally {
        panel.remove();
        control.dispose();
        doc.dispose();
    }
});

test("the history is a keyboard-navigable tree", () => {
    const { doc, control, checkpoint, version, operations } = versionedHistory();
    const panel = panelFor(doc);
    try {
        const first = item(panel, version.commit);
        expect(first.tabIndex).toBe(0);
        first.focus();
        key(first, "ArrowDown");
        expect(document.activeElement).toBe(item(panel, checkpoint));
        // Right expands the folded changes, then moves into them
        key(item(panel, checkpoint), "ArrowRight");
        expect(item(panel, checkpoint).getAttribute("aria-expanded")).toBe("true");
        expect(document.activeElement).toBe(item(panel, checkpoint));
        key(item(panel, checkpoint), "ArrowRight");
        const newest = item(panel, operations[1]);
        expect(document.activeElement).toBe(newest);
        expect(newest.getAttribute("aria-level")).toBe("2");
        // Left from a child goes back to its parent, then collapses it
        key(newest, "ArrowLeft");
        expect(document.activeElement).toBe(item(panel, checkpoint));
        key(item(panel, checkpoint), "ArrowLeft");
        expect(item(panel, checkpoint).getAttribute("aria-expanded")).toBe("false");
        expect(panel.querySelector(`[data-commit="${operations[1]}"]`)).toBeNull();
        // Enter selects the entry and shows its details
        key(item(panel, checkpoint), "Enter");
        expect(item(panel, checkpoint).getAttribute("aria-selected")).toBe("true");
        expect(document.activeElement).toBe(item(panel, checkpoint));
        expect(item(panel, checkpoint).textContent).toContain("versions.restore");
    } finally {
        panel.remove();
        control.dispose();
        doc.dispose();
    }
});

test("the context menu restores an entry and Escape returns focus to it", () => {
    const { doc, control, base } = versionedHistory();
    const panel = panelFor(doc);
    try {
        const row = item(panel, base);
        row.focus();
        key(row, "F10", { shiftKey: true });
        const items = [...menu().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        expect(items.map((b) => b.textContent)).toContain("versions.copyId");
        expect(document.activeElement).toBe(items[0]);
        key(items[0], "ArrowDown");
        expect(document.activeElement?.textContent).toBe("versions.restore");
        key(document.activeElement as HTMLElement, "Escape");
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(item(panel, base));

        row.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
        );
        clickText(menu(), "versions.restore");
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(doc.modelManager.findNodes().map((n) => n.name)).toEqual([]);
        expect(control.headCommit().message).toContain("Restored to");
    } finally {
        closeVersionsMenu();
        panel.remove();
        control.dispose();
        doc.dispose();
    }
});

test.each([
    [0, "now"],
    [-5 * 60_000, "5 min. ago"],
    [-3 * 3_600_000, "3 hr. ago"],
    [-86_400_000, "yesterday"],
])("relative time %d ms reads %s", (offset, expected) => {
    const now = Date.UTC(2026, 0, 15, 12);
    expect(relativeTime(now + offset, now)).toBe(expected);
});
