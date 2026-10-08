// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { isHistoryHidden, Transaction } from "@chili3d/core";
import { appendSketch, copySketch, sketchClipboard } from "../sketchClipboard";
import { editSketch } from "./editSketch";
import { showSketchDiagnostics } from "./sketchDiagnostics";
import type { SketchEditor } from "./sketchEditor";
import style from "./sketchPanel.module.css";

export function showSketchContextMenu(editor: SketchEditor, event: PointerEvent): void {
    document.querySelector("[data-sketch-context-menu]")?.remove();
    const menu = document.createElement("div");
    menu.className = style.contextMenu;
    menu.dataset["sketchContextMenu"] = "true";
    menu.setAttribute("role", "menu");
    const close = () => {
        menu.remove();
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", key, true);
    };
    const outside = (e: Event) => {
        if (!menu.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    };
    const item = (label: string, run: () => void, enabled = true) => {
        const button = document.createElement("button");
        button.textContent = label;
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.disabled = !enabled;
        button.onclick = () => {
            close();
            run();
        };
        menu.append(button);
    };
    const separator = () => menu.append(document.createElement("hr"));
    item(`Confirm ${editor.node.name}`, () => editor.exit());
    item(editor.selectedEntityIds.length ? "Copy selected sketch entities" : "Copy sketch", () =>
        copySketch(editor.solver.toData(), editor.selectedEntityIds),
    );
    item(
        "Paste sketch entities",
        () => {
            const data = sketchClipboard();
            if (data) editSketch(editor, (target) => appendSketch(target, data));
        },
        !!sketchClipboard(),
    );
    separator();
    item("Show all", () => {
        editor.solver.setLayers(editor.solver.sketchLayers().map((l) => ({ ...l, visible: true })));
        Transaction.execute(editor.document, "show all", () => {
            for (const n of editor.document.modelManager.findNodes()) {
                if (!isHistoryHidden(n) && "visible" in n && !("suppressed" in n && n.suppressed))
                    n.visible = true;
            }
        });
        editor.commit();
    });
    item("Profile inspector…", () => showSketchDiagnostics(editor, "profiles"));
    item("Constraint manager…", () => showSketchDiagnostics(editor, "constraints"));
    item("Curve/surface analysis…", () =>
        editor.view.dom?.querySelector<HTMLButtonElement>('[aria-label="Show analysis tools"]')?.click(),
    );
    separator();
    item("Zoom to fit", () => editor.view.cameraController.fitContent());
    item("View normal to sketch plane", () => editor.normalView());
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    document.body.append(menu);
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - bounds.width - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - bounds.height - 4))}px`;
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    menu.querySelector("button")?.focus();
}
