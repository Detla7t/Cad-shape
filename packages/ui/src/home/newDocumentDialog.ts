// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    DocumentLibrary,
    type DocumentUnits,
    type IApplication,
    type IDocument,
    PubSub,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import homeStyle from "./home.module.css";
import { button, el, homeForm, iconButton } from "./homeControls";
import style from "./newDocumentDialog.module.css";

export async function showNewDocumentDialog(
    app: IApplication,
    initial: { folderId?: string; labels?: string[] } = {},
): Promise<HTMLDialogElement> {
    const existing = document.querySelector<HTMLDialogElement>('dialog[aria-label="New document"]');
    if (existing) {
        existing.focus();
        return existing;
    }
    const library = new DocumentLibrary(app.storage);
    const snapshot = await library.list();
    const form = homeForm("New document");
    form.dialog.classList.add(style.dialog);
    form.dialog.querySelector("h2")!.append(iconButton("Close", "close", () => form.dialog.close()));
    const field = (name: string, control: HTMLElement) => {
        const label = el("label", homeStyle.field);
        label.append(el("strong", "", name), control);
        form.content.append(label);
        return label;
    };
    const name = el("input");
    name.value = "Untitled document";
    name.required = true;
    name.maxLength = 160;
    name.setAttribute("aria-label", "Document name");
    field("Document name", name);

    const labels = new Set(initial.labels ?? []);
    const labelSearch = el("input");
    labelSearch.type = "search";
    labelSearch.placeholder = "Search labels";
    labelSearch.setAttribute("aria-label", "Search labels");
    field("Document labels", labelSearch);
    const choices = el("div", style.labels);
    const renderLabels = () => {
        choices.replaceChildren();
        const query = labelSearch.value.trim().toLocaleLowerCase();
        const matches = snapshot.labels.filter((item) => item.name.toLocaleLowerCase().includes(query));
        for (const item of matches) {
            const row = el("label", style.label);
            const check = el("input");
            check.type = "checkbox";
            check.checked = labels.has(item.id);
            check.onchange = () => {
                if (check.checked) labels.add(item.id);
                else labels.delete(item.id);
            };
            const dot = el("i", homeStyle.labelDot);
            dot.style.backgroundColor = item.color;
            row.append(check, dot, el("span", "", item.name));
            choices.append(row);
        }
        choices.hidden = !matches.length && !query;
        if (!matches.length && query) choices.append(el("span", style.muted, "No matching labels"));
    };
    labelSearch.oninput = renderLabels;
    form.content.append(choices);
    renderLabels();

    const defaults = Config.instance.preferences.defaultUnits;
    const units = { ...defaults };
    const unitsRow = el("div", style.units);
    const unitSelect = (title: string, values: readonly (readonly [string, string])[], current: string) => {
        const select = el("select");
        select.setAttribute("aria-label", title);
        for (const [value, text] of values) {
            const option = el("option", "", text);
            option.value = value;
            select.append(option);
        }
        select.value = current;
        const label = el("label", homeStyle.field);
        label.append(el("strong", "", title), select);
        unitsRow.append(label);
        return select;
    };
    const length = unitSelect(
        "Length units",
        [
            ["mm", "Millimeter"],
            ["cm", "Centimeter"],
            ["m", "Meter"],
            ["in", "Inch"],
            ["ft", "Foot"],
        ],
        units.length,
    );
    const angle = unitSelect(
        "Angle units",
        [
            ["deg", "Degree"],
            ["rad", "Radian"],
        ],
        units.angle,
    );
    form.content.append(unitsRow);

    form.content.append(el("strong", style.locationLabel, "Document location"));
    const location = el("section", style.location);
    location.setAttribute("aria-label", "Document location");
    const breadcrumb = el("div", style.breadcrumb);
    const folders = el("div", style.folders);
    let folderId = snapshot.folders.some((folder) => folder.id === initial.folderId)
        ? initial.folderId
        : undefined;
    let ascending = true;
    const renderLocation = () => {
        breadcrumb.replaceChildren(
            iconButton("Owned by me", "homeOwned", () => {
                folderId = undefined;
                renderLocation();
            }),
            (() => {
                const up = button(
                    "‹",
                    () => {
                        folderId = undefined;
                        renderLocation();
                    },
                    style.up,
                );
                up.setAttribute("aria-label", "Up one folder");
                return up;
            })(),
            button(
                "Owned by me",
                () => {
                    folderId = undefined;
                    renderLocation();
                },
                style.crumb,
            ),
        );
        const folder = snapshot.folders.find((item) => item.id === folderId);
        if (folder) breadcrumb.append(el("span", "", "›"), el("strong", "", folder.name));
        const sort = iconButton(
            ascending ? "Sort folders descending" : "Sort folders ascending",
            "tabsSort",
            () => {
                ascending = !ascending;
                renderLocation();
            },
        );
        sort.classList.add(style.sort);
        breadcrumb.append(sort);
        folders.replaceChildren();
        const visible = folderId
            ? []
            : [...snapshot.folders].sort((a, b) => (ascending ? 1 : -1) * a.name.localeCompare(b.name));
        for (const item of visible) {
            const row = button(
                item.name,
                () => {
                    folderId = item.id;
                    renderLocation();
                },
                style.folder,
            );
            row.prepend(createCadIcon("folder"));
            row.setAttribute("aria-label", `Open folder ${item.name}`);
            folders.append(row);
        }
        if (!visible.length) folders.append(el("div", style.empty, "No additional folders"));
    };
    location.append(breadcrumb, folders);
    form.content.append(location);
    renderLocation();

    // Retain a created document if storage fails so retrying Save cannot create duplicates.
    let created: IDocument | undefined;
    const create = form.action("Create document", async () => {
        if (!name.value.trim()) throw new Error("Enter a document name.");
        const selectedUnits: DocumentUnits = {
            ...units,
            length: length.value as DocumentUnits["length"],
            angle: angle.value as DocumentUnits["angle"],
        };
        created ??= await app.newDocument(name.value.trim(), selectedUnits);
        created.name = name.value.trim();
        created.userData = { ...created.userData, displayUnits: { ...selectedUnits } };
        PubSub.default.pub("documentUnitsChanged", created);
        await created.save();
        await library.update(created.id, { folderId, labels: [...labels], lastOpened: Date.now() });
        PubSub.default.pub("displayHome", false);
    });
    create.parentElement!.prepend(create);
    name.focus();
    name.select();
    return form.dialog;
}
