// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { sketchProfiles } from "../../features/profileBuilder";
import {
    ConstraintKind,
    dimensionDisplaySource,
    resolveDatumSource,
    type SketchConstraintRole,
    type SketchData,
} from "../sketchModel";
import { SketchSolver } from "../solver";
import { formatDatum } from "./dimensionLayout";
import { badgeSymbol, constraintBadgeIcon } from "./sketchAnnotations";
import type { SketchEditor } from "./sketchEditor";
import style from "./sketchPanel.module.css";

/** Constraint names as the toolbar calls them (the solver's kinds are its own). */
const CONSTRAINT_NAMES: Partial<Record<ConstraintKind, string>> = {
    [ConstraintKind.P2PCoincident]: "Coincident",
    [ConstraintKind.PointOnLine]: "Coincident",
    [ConstraintKind.PointOnCircle]: "Coincident",
    [ConstraintKind.PointOnArc]: "Coincident",
    [ConstraintKind.Horizontal]: "Horizontal",
    [ConstraintKind.HorizontalAlign]: "Horizontal",
    [ConstraintKind.Vertical]: "Vertical",
    [ConstraintKind.VerticalAlign]: "Vertical",
    [ConstraintKind.Parallel]: "Parallel",
    [ConstraintKind.Perpendicular]: "Perpendicular",
    [ConstraintKind.Equal]: "Equal",
    [ConstraintKind.EqualLength]: "Equal",
    [ConstraintKind.EqualRadius]: "Equal",
    [ConstraintKind.EqualArcRadius]: "Equal",
    [ConstraintKind.TangentLineCircle]: "Tangent",
    [ConstraintKind.TangentCircleCircle]: "Tangent",
    [ConstraintKind.TangentLineArc]: "Tangent",
    [ConstraintKind.TangentArcArc]: "Tangent",
    [ConstraintKind.TangentCircleArc]: "Tangent",
    [ConstraintKind.Midpoint]: "Midpoint",
    [ConstraintKind.Symmetric]: "Symmetric",
    [ConstraintKind.Fix]: "Fix",
    [ConstraintKind.P2PDistance]: "Distance",
    [ConstraintKind.P2LDistance]: "Distance",
    [ConstraintKind.HorizontalDistance]: "Horizontal distance",
    [ConstraintKind.VerticalDistance]: "Vertical distance",
    [ConstraintKind.Radius]: "Radius",
    [ConstraintKind.Angle]: "Angle",
};
const ROLE_NAMES: Record<SketchConstraintRole, string> = {
    concentric: "Concentric",
    normal: "Normal",
    curvature: "Curvature",
};
/** Text glyphs for the dimension kinds, which have no toolbar constraint icon. */
const DIMENSION_GLYPHS: Partial<Record<ConstraintKind, string>> = {
    [ConstraintKind.P2PDistance]: "↔",
    [ConstraintKind.P2LDistance]: "↔",
    [ConstraintKind.HorizontalDistance]: "↔",
    [ConstraintKind.VerticalDistance]: "↕",
    [ConstraintKind.Radius]: "R",
    [ConstraintKind.Angle]: "∠",
};

export function constraintDisplayName(kind: ConstraintKind, role?: SketchConstraintRole): string {
    return role === undefined
        ? (CONSTRAINT_NAMES[kind] ?? ConstraintKind[kind] ?? String(kind))
        : ROLE_NAMES[role];
}

/** The row's glyph: the badge artwork of a symbol constraint, a text mark of a dimension. */
function constraintGlyph(kind: ConstraintKind, role?: SketchConstraintRole): HTMLElement {
    const glyph = document.createElement("span");
    glyph.className = style.constraintGlyph;
    glyph.setAttribute("aria-hidden", "true");
    const symbol = badgeSymbol(kind, role);
    const graphic = symbol === undefined ? undefined : constraintBadgeIcon(symbol);
    if (graphic !== undefined) glyph.append(graphic);
    else glyph.textContent = DIMENSION_GLYPHS[kind] ?? symbol?.label ?? "•";
    return glyph;
}

export function openEndpoints(data: SketchData): { id: number; point: [number, number] }[] {
    const ends = data.entities
        .filter((e) => !e.construction && e.type !== "circle" && e.type !== "point")
        .flatMap((e) => {
            const p = e.params,
                start = e.type === "arc" ? 2 : 0;
            return [
                { id: e.id, point: [p[start], p[start + 1]] as [number, number] },
                { id: e.id, point: p.slice(-2) as [number, number] },
            ];
        });
    return ends.filter(
        (a, i) =>
            !ends.some(
                (b, j) => i !== j && Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1]) < 1e-5,
            ),
    );
}
export function showSketchDiagnostics(editor: SketchEditor, mode: "profiles" | "constraints"): void {
    editor.view.dom?.querySelector("[data-sketch-diagnostics]")?.remove();
    const panel = document.createElement("section");
    panel.className = style.panel;
    panel.dataset["sketchDiagnostics"] = "true";
    panel.style.left = "228px";
    panel.style.width = "350px";
    panel.style.zIndex = "20";
    const header = document.createElement("header"),
        title = document.createElement("strong"),
        close = document.createElement("button");
    title.textContent = mode === "profiles" ? "Profile inspector" : "Constraint manager";
    close.textContent = "×";
    close.ariaLabel = "Close diagnostics";
    close.onclick = () => {
        editor.highlightEntities([]);
        editor.annotations.setHoveredConstraint(undefined);
        panel.remove();
    };
    header.append(title, close);
    panel.append(header);
    for (const name of ["pointerdown", "pointermove", "wheel"])
        panel.addEventListener(name, (e) => e.stopPropagation());
    const list = document.createElement("div");
    const row = (label: string, ids: number[], run?: () => void) => {
        const button = document.createElement("button");
        button.textContent = label;
        button.style.display = "block";
        button.style.width = "100%";
        button.style.textAlign = "left";
        button.onpointerenter = () => editor.highlightEntities(ids);
        button.onpointerleave = () => editor.highlightEntities([]);
        button.onclick = run ?? (() => editor.highlightEntities(ids));
        list.append(button);
        return button;
    };
    if (mode === "profiles") {
        const data = editor.solver.toData(),
            ends = openEndpoints(data),
            profiles = sketchProfiles(editor.node);
        const status = document.createElement("p");
        status.textContent = profiles.isOk
            ? `${profiles.value.outer.length} closed outer profiles · ${ends.length} open endpoints`
            : `Profile error: ${profiles.error}`;
        panel.append(status);
        ends.forEach((e) =>
            row(`Open endpoint · entity ${e.id} (${e.point.map((x) => x.toFixed(3)).join(", ")})`, [e.id]),
        );
        if (profiles.isOk)
            profiles.value.outerEntities.forEach((ids, i) => row(`Closed profile ${i + 1}`, ids ?? []));
        const seen = new Map<string, number>();
        for (const e of data.entities) {
            const key = `${e.type}:${e.params.map((x) => x.toFixed(6)).join(",")}`,
                duplicate = seen.get(key);
            if (duplicate !== undefined) row(`Duplicate geometry · ${duplicate}, ${e.id}`, [duplicate, e.id]);
            else seen.set(key, e.id);
        }
    } else {
        const filter = document.createElement("input");
        filter.placeholder = "Filter by type or entity";
        filter.ariaLabel = "Filter constraints";
        const selected = new Set<number>();
        const only = document.createElement("label"),
            check = document.createElement("input");
        check.type = "checkbox";
        only.append(check, document.createTextNode("Only selected entities"));
        const errors = new Map(editor.solver.datumErrors);
        const data = editor.solver.toData();
        if (!editor.lastSolveOutcome.result.startsWith("Ok") && data.constraints.length <= 150) {
            for (const constraint of data.constraints) {
                const copy = structuredClone(data);
                copy.constraints = copy.constraints.filter((c) => c.id !== constraint.id);
                const probe = new SketchSolver(
                    editor.node.plane,
                    copy,
                    editor.document.variables.evaluate().scope,
                );
                try {
                    if (probe.solve(true).result.startsWith("Ok"))
                        errors.set(constraint.id, "Removing this constraint resolves the conflict");
                } finally {
                    probe.dispose();
                }
            }
        }
        // Where the sketch is still free: Onshape's blue geometry, listed so each can be found.
        const freedom = document.createElement("div");
        freedom.className = style.freedom;
        const renderFreedom = () => {
            freedom.replaceChildren();
            const { dofs, result } = editor.lastSolveOutcome;
            const status = document.createElement("p");
            status.textContent = !result.startsWith("Ok")
                ? `Not solved · ${result}`
                : dofs === 0
                  ? "Fully constrained"
                  : `${dofs} degree${dofs === 1 ? "" : "s"} of freedom`;
            freedom.append(status);
            if (dofs === 0 || !result.startsWith("Ok")) return;
            const free = editor.solver
                .toData()
                .entities.filter((entity) => !editor.fullyConstrainedEntities.has(entity.id));
            for (const entity of free) {
                const button = document.createElement("button");
                button.className = style.freeEntity;
                button.textContent = `Under-constrained · ${entity.type} ${entity.id}`;
                button.title = "Select it, then apply a constraint or dimension from the toolbar";
                button.onpointerenter = () => editor.highlightEntities([entity.id]);
                button.onpointerleave = () => editor.highlightEntities([]);
                // Selecting it is the quick way to constrain it: the constraint tools act on the selection.
                button.onclick = () => editor.selectEntities([entity.id]);
                freedom.append(button);
            }
        };
        const hover = (ids: number[], id: number | undefined) => {
            editor.highlightEntities(ids);
            editor.annotations.setHoveredConstraint(id);
        };
        const render = () => {
            list.replaceChildren();
            const selectedEntities = new Set(editor.selectedEntityIds);
            for (const c of editor.solver.toData().constraints) {
                const kindName = ConstraintKind[c.kind] ?? String(c.kind),
                    name = constraintDisplayName(c.kind, c.role),
                    ids = [...new Set(c.refs.map((r) => r.entityId))],
                    error = errors.get(c.id);
                if (check.checked && !ids.some((id) => selectedEntities.has(id))) continue;
                if (
                    !`${name} ${kindName} ${ids.join(" ")} ${error ?? ""}`
                        .toLowerCase()
                        .includes(filter.value.toLowerCase())
                )
                    continue;
                const line = document.createElement("label"),
                    toggle = document.createElement("input");
                line.className = style.constraintRow;
                line.dataset["constraintId"] = String(c.id);
                line.dataset["constraintKind"] = kindName;
                toggle.type = "checkbox";
                toggle.checked = selected.has(c.id);
                toggle.onchange = () => {
                    toggle.checked ? selected.add(c.id) : selected.delete(c.id);
                };
                const text = document.createElement("span");
                text.textContent = `${name} · ${ids.join(", ")}${c.datum === undefined ? "" : ` = ${formatDatum(c.kind, c.datum, editor.document)}`}${error ? ` · ${error}` : ""}`;
                text.title = `${kindName} ${c.id}`;
                if (error) text.style.color = "#d43e3e";
                line.append(toggle, constraintGlyph(c.kind, c.role), text);
                line.onpointerenter = () => hover(ids, c.id);
                line.onpointerleave = () => hover([], undefined);
                line.ondblclick = () => editor.editDatum(c.id);
                list.append(line);
            }
            renderFreedom();
        };
        const remove = () => {
            editor.deleteConstraints(selected);
            selected.clear();
            render();
        };
        const button = document.createElement("button");
        button.textContent = "Delete selected constraints";
        button.onclick = remove;
        panel.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Delete" && e.target !== filter) {
                e.preventDefault();
                remove();
            }
        });
        filter.oninput = render;
        check.onchange = render;
        panel.append(filter, only, button, freedom);
        render();
    }
    panel.append(list);
    editor.view.dom?.append(panel);
}

export function displayConstraintDatum(editor: SketchEditor, id: number): string {
    const c = editor.solver.toData().constraints.find((c) => c.id === id);
    if (!c) return "";
    const resolved = resolveDatumSource(c.kind, c.datum ?? 0, editor.document.variables.evaluate().scope);
    return resolved.isOk
        ? formatDatum(
              c.kind,
              dimensionDisplaySource(resolved.value, editor.dimensionAnchors.get(id)),
              editor.document,
          )
        : String(c.datum ?? 0);
}
