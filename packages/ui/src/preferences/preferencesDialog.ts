// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CommandStore,
    Config,
    DEFAULT_AUTOMATION_PREFERENCES,
    DEFAULT_DESKTOP_PREFERENCES,
    DEFAULT_GRAPHICS,
    type DesktopBridgeInfo,
    type DocumentUnits,
    defaultUserPreferences,
    documentQuantityUnits,
    documentUnits,
    EXPORT_NAME_PLACEHOLDER,
    effectiveShortcuts,
    formatShortcutKey,
    I18n,
    type IDocument,
    Material,
    type MaterialLibrary,
    Navigation3D,
    Navigation3DTypes,
    PubSub,
    probeDesktopBridge,
    QUANTITY_UNITS,
    type QuantityKind,
    type QuantityPreferences,
    type Ribbon,
    type ShortcutContext,
    setDocumentQuantityUnits,
    setDocumentUnits,
    Transaction,
    type UserPreferences,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import { automationSession } from "../automation/automationSession";
import { exportDelivery } from "../desktop/exportDelivery";
import { RibbonCustomization, toolCategories } from "../ribbon/customization";
import style from "./preferencesDialog.module.css";
import { defaultShortcutTools, shortcutBindingCommand, shortcutCategory } from "./shortcutToolbar";

type Choices = readonly (readonly [string, string])[];
const lengths: Choices = [
    ["mm", "Millimetre"],
    ["cm", "Centimetre"],
    ["m", "Metre"],
    ["in", "Inch"],
    ["ft", "Foot"],
];
const angles: Choices = [
    ["deg", "Degree"],
    ["rad", "Radian"],
];
const decimals: Choices = Array.from({ length: 9 }, (_, i) => [
    String(i),
    i === 0 ? "0" : `0.${"12345678".slice(0, i)}`,
]);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
}
function action(text: string, run: () => void, primary = false) {
    const button = element("button", text, primary ? style.primary : "");
    button.type = "button";
    button.onclick = run;
    return button;
}
function choice(label: string, options: Choices, value: string) {
    const select = element("select");
    select.setAttribute("aria-label", label);
    for (const [id, text] of options) {
        const option = element("option", text);
        option.value = id;
        select.add(option);
    }
    select.value = value;
    return select;
}
function field(label: string, control: HTMLElement) {
    const row = element("label", label, style.field);
    row.append(control);
    return row;
}
function check(label: string, checked: boolean) {
    const input = element("input");
    input.type = "checkbox";
    input.checked = checked;
    const row = element("label", "", style.check);
    row.append(input, document.createTextNode(label));
    return { row, input };
}
function note(text: string) {
    return element("p", text, style.note);
}
function patchPreferences(patch: Partial<UserPreferences>) {
    Config.instance.preferences = { ...Config.instance.preferences, ...patch };
    Config.instance.saveToStorage();
}

/** Section drafts are independent. Closing discards only unsaved controls; saved sections apply live. */
export class PreferencesDialog {
    readonly dialog = element("dialog", "", style.dialog);
    private readonly navigation = element("nav", "", style.navigation);
    private readonly content = element("div", "", style.content);
    private readonly sections = new Map<string, HTMLElement>();
    private readonly cleanup: (() => void)[] = [];
    private readonly customization: RibbonCustomization;

    constructor(
        private readonly ribbon: Ribbon,
        private readonly resetToolbar: () => void,
        private readonly model?: IDocument,
    ) {
        this.customization = new RibbonCustomization(ribbon);
        this.dialog.setAttribute("aria-label", "Preferences");
        this.navigation.setAttribute("aria-label", "Preference sections");
        const header = element("header", "", style.header);
        const title = element("div");
        title.append(
            element("h2", "Preferences"),
            note(model ? `Open in ${model.name}` : "Your workspace settings"),
        );
        header.append(
            title,
            action("Close", () => this.dialog.close()),
        );
        const layout = element("div", "", style.layout);
        layout.append(this.navigation, this.content);
        this.dialog.append(header, layout);
        this.dialog.addEventListener("keydown", (event) => event.stopPropagation());
        this.dialog.addEventListener("close", () => this.dispose(), { once: true });
        if (model) this.unitsSection("document", "Current document", true);
        this.language();
        this.theme();
        this.decimalFormat();
        this.unitsSection("units", "Units", false);
        this.mouse();
        this.environment();
        this.assembly();
        this.modelTree();
        this.saving();
        this.shortcuts();
        this.toolbars();
        this.drawings();
        this.materials();
        this.exports();
        this.desktop();
        this.automation();
        const labs = this.section("labs", "Chili3D Labs");
        labs.append(note("No experimental features are currently installed."));
    }

    show(section?: string) {
        document.body.append(this.dialog);
        this.dialog.showModal();
        if (section) this.goTo(section);
        return this;
    }

    dispose() {
        this.cleanup.splice(0).forEach((dispose) => {
            dispose();
        });
        this.customization.dispose();
        this.dialog.remove();
    }

    private goTo(id: string) {
        const target = this.sections.get(id);
        if (!target) return;
        this.content.scrollTop = target.offsetTop - 20;
        this.navigation.querySelectorAll("button").forEach((button) => {
            button.setAttribute("aria-current", String(button.dataset["section"] === id));
        });
    }

    private section(id: string, title: string) {
        const section = element("section", "", style.section);
        section.dataset["section"] = id;
        section.append(element("h3", title));
        this.sections.set(id, section);
        const link = action(title, () => this.goTo(id));
        link.dataset["section"] = id;
        this.navigation.append(link);
        this.content.append(section);
        return section;
    }

    private save(section: HTMLElement, label: string, run: () => void) {
        const status = element("span", "", style.status);
        status.setAttribute("role", "status");
        const button = action(
            label,
            () => {
                try {
                    run();
                    Config.instance.saveToStorage();
                    button.disabled = true;
                    section.dataset["dirty"] = "false";
                    status.textContent = "Saved";
                } catch (error) {
                    status.textContent = error instanceof Error ? error.message : String(error);
                }
            },
            true,
        );
        button.disabled = true;
        const dirty = () => {
            section.dataset["dirty"] = "true";
            button.disabled = false;
            status.textContent = "Unsaved changes";
        };
        section.addEventListener("input", dirty);
        section.addEventListener("change", dirty);
        const footer = element("div", "", style.actions);
        footer.append(button, status);
        section.append(footer);
        return dirty;
    }

    private language() {
        const section = this.section("language", "Language");
        const language = choice(
            "Display language",
            I18n.getLanguages().map((item) => [item.language, item.display]),
            Config.instance.language,
        );
        section.append(field("Display language", language));
        this.save(section, "Save language", () => {
            Config.instance.language = language.value;
        });
    }

    private theme() {
        const section = this.section("theme", "Theming");
        let theme = Config.instance.themeMode;
        for (const [id, label, description] of [
            ["light", "Light mode", "Dark text and tools on light backgrounds."],
            ["dark", "Dark mode", "Light text and tools on dark backgrounds."],
            ["system", "Use system setting", "Follow your device’s appearance."],
        ] as const) {
            const radio = check(label, theme === id);
            radio.input.type = "radio";
            radio.input.name = "preferences-theme";
            radio.input.onchange = () => {
                theme = id;
            };
            section.append(radio.row, note(description));
        }
        this.save(section, "Save theme", () => {
            Config.instance.themeMode = theme;
        });
    }

    private decimalFormat() {
        const section = this.section("decimal", "Decimal format");
        const comma = check("Use comma as decimal separator", Config.instance.preferences.decimalComma);
        section.append(
            comma.row,
            note("Applies to dimension values. Expressions retain commas between function arguments."),
        );
        this.save(section, "Save decimal format", () => {
            patchPreferences({ decimalComma: comma.input.checked });
            if (this.model) {
                PubSub.default.pub("documentUnitsChanged", this.model);
                this.model.visual.update();
            }
        });
    }

    private unitsSection(id: string, title: string, current: boolean) {
        const section = this.section(id, title);
        const units = current ? documentUnits(this.model!) : Config.instance.preferences.defaultUnits;
        const quantities = current
            ? documentQuantityUnits(this.model!)
            : Config.instance.preferences.quantities;
        section.append(
            note(
                current
                    ? "Change units and display precision for this document. Model geometry retains its exact size. Changes are undoable."
                    : "Default units for newly created documents. Existing documents retain their own units.",
            ),
        );
        const grid = element("div", "", style.units);
        const length = choice(`${title} length unit`, lengths, units.length);
        const angle = choice(`${title} angle unit`, angles, units.angle);
        const lp = choice(`${title} length decimals`, decimals, String(units.lengthPrecision));
        const ap = choice(`${title} angle decimals`, decimals, String(units.anglePrecision));
        grid.append(
            field("Length unit", length),
            field("Display decimals", lp),
            field("Angle unit", angle),
            field("Display decimals", ap),
        );
        const quantityFields = new Map<QuantityKind, [HTMLSelectElement, HTMLSelectElement]>();
        for (const [key, data] of Object.entries(QUANTITY_UNITS)) {
            const kind = key as QuantityKind;
            const select = choice(
                `${title} ${data.label.toLowerCase()} unit`,
                data.units.map(([id, label]) => [id, label]),
                quantities[kind].unit,
            );
            const precision = choice(
                `${title} ${data.label.toLowerCase()} decimals`,
                decimals,
                String(quantities[kind].precision),
            );
            grid.append(field(`${data.label} unit`, select), field("Display decimals", precision));
            quantityFields.set(kind, [select, precision]);
        }
        section.append(grid);
        const time = choice(
            "Time format",
            [
                ["24", "24 hour"],
                ["12", "12 hour"],
            ],
            Config.instance.preferences.timeFormat,
        );
        if (!current) section.append(field("Time format", time));
        this.save(section, current ? "Save document units" : "Save default units", () => {
            const value: DocumentUnits = {
                length: length.value as DocumentUnits["length"],
                angle: angle.value as DocumentUnits["angle"],
                lengthPrecision: Number(lp.value),
                anglePrecision: Number(ap.value),
            };
            const quantityValue = Object.fromEntries(
                [...quantityFields].map(([key, [unit, precision]]) => [
                    key,
                    { unit: unit.value, precision: Number(precision.value) },
                ]),
            ) as QuantityPreferences;
            if (current)
                Transaction.execute(this.model!, "Change document units", () => {
                    setDocumentUnits(this.model!, value);
                    setDocumentQuantityUnits(this.model!, quantityValue);
                });
            else
                patchPreferences({
                    defaultUnits: value,
                    quantities: quantityValue,
                    timeFormat: time.value as "12" | "24",
                });
        });
    }

    private mouse() {
        const section = this.section("mouse", "Mouse controls");
        const profile = choice(
            "View settings",
            Navigation3DTypes.map((value) => [
                value,
                value === "Chili3d" ? "Chili3D (Onshape controls)" : value,
            ]),
            Config.instance.navigation3D,
        );
        const controls = element("table", "", style.controls);
        const render = () => {
            const map = Navigation3D.navigationKeyMap(profile.value as typeof Config.instance.navigation3D);
            controls.replaceChildren();
            for (const [action, model, drawing] of [
                ["", "3D Part & Assembly", "2D Drawing"],
                ["Rotate", `${map.rotate} mouse button drag`, "Not applicable"],
                ["Constrained rotate", "Alt + Right mouse button drag", "Not applicable"],
                [
                    "Pan",
                    `${map.pan} mouse button drag or Ctrl + Right drag`,
                    "Drag with left, middle or right mouse button",
                ],
                ["Zoom", "Scroll wheel in/out", "Scroll wheel in/out"],
            ]) {
                const row = element("tr");
                row.append(
                    element("th", action),
                    element(action ? "td" : "th", model),
                    element(action ? "td" : "th", drawing),
                );
                controls.append(row);
            }
        };
        profile.onchange = render;
        render();
        const mouse = Config.instance.preferences.mouse;
        const reverse = check("Reverse scroll wheel zoom direction", mouse.reverseZoom);
        const constrained = check(
            "Set default rotation behavior to constrained rotate",
            mouse.constrainedRotation,
        );
        const pen = check("Use pen input as mouse", mouse.penAsMouse);
        const sync = (key: keyof Config) => {
            if (section.dataset["dirty"] === "true" || (key !== "preferences" && key !== "navigation3D"))
                return;
            const current = Config.instance.preferences.mouse;
            profile.value = Config.instance.navigation3D;
            reverse.input.checked = current.reverseZoom;
            constrained.input.checked = current.constrainedRotation;
            pen.input.checked = current.penAsMouse;
            render();
        };
        Config.instance.onPropertyChanged(sync);
        this.cleanup.push(() => Config.instance.removePropertyChanged(sync));
        section.append(field("View settings", profile), controls, reverse.row, constrained.row, pen.row);
        this.save(section, "Save mouse controls", () => {
            Config.instance.navigation3D = profile.value as typeof Config.instance.navigation3D;
            patchPreferences({
                mouse: {
                    reverseZoom: reverse.input.checked,
                    constrainedRotation: constrained.input.checked,
                    penAsMouse: pen.input.checked,
                },
            });
        });
    }

    private environment() {
        const section = this.section("environment", "Environment profile settings");
        const profile = choice(
            "Environment profile",
            [
                ["", "Current settings"],
                ["default", "Chili3D (default)"],
                ...Config.instance.preferences.profiles.map((item): [string, string] => [item.id, item.name]),
            ],
            "",
        );
        const density = choice(
            "Pixel density",
            [
                ["automatic", "Automatic (default)"],
                ["device", "Match display (up to 4×)"],
                ["standard", "Standard (1×)"],
            ],
            Config.instance.preferences.pixelDensity,
        );
        const name = element("input");
        name.placeholder = "Profile name";
        name.setAttribute("aria-label", "New environment profile name");
        const status = note("");
        const create = action("Create profile", () => {
            if (!name.value.trim()) {
                status.textContent = "Enter a profile name.";
                return;
            }
            const id = crypto.randomUUID();
            const prefs = Config.instance.preferences;
            patchPreferences({
                profiles: [
                    ...prefs.profiles,
                    {
                        id,
                        name: name.value.trim(),
                        navigation: Config.instance.navigation3D,
                        mouse: { ...prefs.mouse },
                        graphics: { ...Config.instance.graphics },
                        pixelDensity: prefs.pixelDensity,
                    },
                ],
            });
            const option = element("option", name.value.trim());
            option.value = id;
            profile.add(option);
            profile.value = id;
            remove.disabled = false;
            name.value = "";
            status.textContent = "Profile created from saved mouse and graphics settings.";
        });
        const remove = action("Delete profile", () => {
            patchPreferences({
                profiles: Config.instance.preferences.profiles.filter((item) => item.id !== profile.value),
            });
            profile.selectedOptions[0]?.remove();
            profile.value = "";
            remove.disabled = true;
            status.textContent = "Profile deleted.";
        });
        remove.disabled = true;
        profile.onchange = () => {
            remove.disabled = !profile.value || profile.value === "default";
            density.value =
                profile.value === "default"
                    ? "automatic"
                    : (Config.instance.preferences.profiles.find((item) => item.id === profile.value)
                          ?.pixelDensity ?? Config.instance.preferences.pixelDensity);
        };
        const row = element("div", "", style.actions);
        row.append(name, create, remove);
        section.append(
            field("Environment profile", profile),
            row,
            status,
            field("Match pixel density on high resolution displays", density),
            note(
                "Higher pixel density can affect performance. Profiles capture saved mouse controls and graphics preferences.",
            ),
        );
        this.save(section, "Save profile settings", () => {
            const selected = Config.instance.preferences.profiles.find((item) => item.id === profile.value);
            if (selected || profile.value === "default") {
                Config.instance.navigation3D = selected?.navigation ?? "Chili3d";
                Config.instance.graphics = selected?.graphics ?? { ...DEFAULT_GRAPHICS };
                patchPreferences({ mouse: selected?.mouse ?? defaultUserPreferences().mouse });
            }
            patchPreferences({ pixelDensity: density.value as UserPreferences["pixelDensity"] });
        });
    }

    private modelTree() {
        const section = this.section("tree", "Model tree");
        const owners = choice(
            "Colour features by what uses them",
            [
                ["off", "Off"],
                ["solid", "Per solid (each sketch or body)"],
                ["part", "Per part (each top-level part)"],
            ],
            Config.instance.preferences.treeOwnerColors,
        );
        section.append(field("Colour features by what uses them", owners));
        section.append(
            note(
                "Each owner takes a colour and a lane on the left of the tree; a feature shows a bar for every owner that uses it, so bars of different owners never share a lane.",
            ),
        );
        const timeline = check(
            "Show the timeline under the viewport",
            Config.instance.preferences.showTimeline,
        );
        section.append(timeline.row);
        this.save(section, "Save model tree settings", () =>
            patchPreferences({
                treeOwnerColors: owners.value as "off" | "solid" | "part",
                showTimeline: timeline.input.checked,
            }),
        );
    }

    private assembly() {
        const section = this.section("assembly", "Assembly settings");
        const props = check(
            "Display instance list properties",
            Config.instance.preferences.assemblyProperties,
        );
        section.append(props.row);
        this.save(section, "Save assembly settings", () =>
            patchPreferences({ assemblyProperties: props.input.checked }),
        );
    }

    private saving() {
        const section = this.section("saving", "Saving");
        const autosave = check("Autosave documents", Config.instance.preferences.autosave);
        section.append(
            autosave.row,
            note(
                "A recovery save is written shortly after every change. The version history keeps every change; use Commit in Versions & History to name a set of changes, and Save to publish the document to links that follow it.",
            ),
        );
        this.save(section, "Save saving settings", () =>
            patchPreferences({ autosave: autosave.input.checked }),
        );
    }

    private shortcuts() {
        const section = this.section("shortcuts", "Keyboard shortcuts");
        const tabs = element("div", "", style.tabs);
        const list = element("div", "", style.shortcutList);
        const search = element("input");
        search.type = "search";
        search.placeholder = "Find a command";
        search.setAttribute("aria-label", "Find a keyboard shortcut");
        let active = "General";
        const render = () => {
            const shortcuts = effectiveShortcuts(
                Config.instance.navigation3D,
                Config.instance.customShortcuts,
            );
            const commands = CommandStore.getAllCommands().filter(
                ({ key }) =>
                    shortcutCategory(key) === active &&
                    I18n.translate(`command.${key}`).toLowerCase().includes(search.value.toLowerCase()),
            );
            list.replaceChildren(
                ...commands
                    .sort((a, b) =>
                        I18n.translate(`command.${a.key}`).localeCompare(I18n.translate(`command.${b.key}`)),
                    )
                    .map(({ key }) => {
                        const binding = shortcutBindingCommand(key);
                        const fallback =
                            key === "sketch.construction" ? "q" : key === "sketch.normal" ? "n" : undefined;
                        const shortcut = shortcuts[binding] ?? fallback;
                        const value = Array.isArray(shortcut)
                            ? shortcut.map(formatShortcutKey).join(" or ")
                            : shortcut
                              ? formatShortcutKey(shortcut)
                              : undefined;
                        const modified = Object.hasOwn(Config.instance.customShortcuts, binding);
                        const button = action(value ?? (modified ? "Disabled" : "Unassigned"), () =>
                            this.customization.assignShortcut(binding, fallback),
                        );
                        button.title = `Change shortcut for ${I18n.translate(`command.${key}`)}`;
                        if (binding !== key)
                            button.title += ` (shared with ${I18n.translate(`command.${binding}`)})`;
                        button.dataset["state"] = modified ? "custom" : "default";
                        const row = element("div", "", style.shortcutRow);
                        row.append(button, element("span", I18n.translate(`command.${key}`)));
                        return row;
                    }),
            );
            if (commands.length === 0) list.append(note("No matching commands."));
            tabs.querySelectorAll("button").forEach((button) => {
                button.setAttribute("aria-selected", String(button.textContent === active));
            });
        };
        for (const category of ["General", "Part Studio", "Assembly", "3D view", "Sketch", "Drawing"]) {
            const button = action(category, () => {
                active = category;
                render();
            });
            button.setAttribute("role", "tab");
            tabs.append(button);
        }
        tabs.setAttribute("role", "tablist");
        const layout = element("div", "", style.shortcutLayout);
        const legend = element("aside", "", style.legend);
        legend.append(
            note("Click a shortcut to customize it."),
            element("p", "Blue outline · Customized"),
            element("p", "Grey outline · Default"),
            element("p", "Disabled · No key assigned"),
            note("Conflicting assignments are identified before saving."),
            action(
                "Reset all",
                () => {
                    Config.instance.customShortcuts = {};
                    Config.instance.saveToStorage();
                },
                true,
            ),
        );
        layout.append(list, legend);
        search.oninput = render;
        const changed = (key: keyof Config) => {
            if (key === "customShortcuts" || key === "navigation3D") render();
        };
        Config.instance.onPropertyChanged(changed);
        this.cleanup.push(() => Config.instance.removePropertyChanged(changed));
        section.append(tabs, search, layout);
        render();
    }

    private toolbars() {
        const section = this.section("shortcut-toolbars", "Shortcut toolbars");
        const contexts: ShortcutContext[] = ["Part Studio", "Sketch", "Assembly", "Drawing"];
        const context = choice(
            "Shortcut toolbar context",
            contexts.map((key) => [key, key]),
            "Sketch",
        );
        const selected = structuredClone(Config.instance.preferences.shortcutToolbars);
        const list = element("div", "", style.toolList);
        const preview = element("div", "", style.toolbarPreview);
        const catalog = toolCategories(this.ribbon);
        const commands = CommandStore.getAllCommands().filter(({ key }) => catalog.has(key));
        const tools = () =>
            selected[context.value as ShortcutContext] ??
            defaultShortcutTools(context.value as ShortcutContext);
        const renderPreview = () => {
            preview.replaceChildren(
                ...tools().flatMap((key) => {
                    const data = CommandStore.getComandData(key);
                    if (!data) return [];
                    const icon = element("span");
                    icon.title = I18n.translate(`command.${key}`);
                    icon.append(createCadIcon(key, data.icon));
                    return [icon];
                }),
            );
        };
        const render = () => {
            list.replaceChildren(
                ...commands
                    .filter(({ key }) => shortcutCategory(key) === context.value)
                    .map(({ key, icon }) => {
                        const item = check(I18n.translate(`command.${key}`), tools().includes(key));
                        item.row.insertBefore(createCadIcon(key, icon), item.row.lastChild);
                        item.input.onchange = () => {
                            selected[context.value as ShortcutContext] = item.input.checked
                                ? [...tools(), key]
                                : tools().filter((value) => value !== key);
                            renderPreview();
                        };
                        return item.row;
                    }),
            );
            if (!list.childElementCount) list.append(note("No tools installed for this context."));
            renderPreview();
        };
        context.onchange = render;
        const layout = element("div", "", style.shortcutLayout);
        layout.append(list, preview);
        section.append(
            context,
            note("Press Shift + Space in the viewport to open your shortcut toolbar."),
            layout,
        );
        this.save(section, "Save shortcut toolbar settings", () =>
            patchPreferences({ shortcutToolbars: selected }),
        );
        render();
        const toolbar = this.section("toolbars", "Toolbars");
        toolbar.append(
            note("Restore the installed toolbar layout, tabs and pinned tools."),
            action("Reset to defaults", this.resetToolbar, true),
        );
    }

    private drawings() {
        const section = this.section("drawings", "Drawings");
        const background = choice(
            "Drawing model space background",
            [
                ["dark", "Dark view (default)"],
                ["light", "Light view"],
            ],
            Config.instance.preferences.drawingBackground,
        );
        section.append(field("Background color of model space (imported DWG and DXF files)", background));
        this.save(section, "Save drawing settings", () =>
            patchPreferences({ drawingBackground: background.value as "dark" | "light" }),
        );
    }

    private materials() {
        const section = this.section("materials", "Material libraries");
        const list = element("table", "", style.libraries);
        const status = note("");
        status.setAttribute("role", "status");
        const install = (library: MaterialLibrary) => {
            if (!this.model) return;
            Transaction.execute(this.model, "Add material library", () => {
                for (const item of library.materials) {
                    const name = `${library.name} · ${item.name}`;
                    if (this.model!.modelManager.materials.find((material) => material.name === name))
                        continue;
                    const material = new Material({ document: this.model!, name, color: item.color });
                    material.opacity = item.opacity;
                    this.model!.modelManager.materials.push(material);
                }
            });
            status.textContent = `Added ${library.name} to this document’s appearance palette.`;
        };
        const render = () => {
            const heading = element("tr");
            for (const label of ["Library", "File", "Materials", ""]) heading.append(element("th", label));
            list.replaceChildren(heading);
            for (const library of Config.instance.preferences.materialLibraries) {
                const row = element("tr");
                row.append(
                    element("td", library.name),
                    element("td", library.fileName),
                    element("td", String(library.materials.length)),
                );
                const actions = element("td");
                if (this.model) actions.append(action("Add to document", () => install(library)));
                actions.append(
                    action("Remove", () => {
                        patchPreferences({
                            materialLibraries: Config.instance.preferences.materialLibraries.filter(
                                (value) => value.id !== library.id,
                            ),
                        });
                        render();
                    }),
                );
                row.append(actions);
                list.append(row);
            }
        };
        const file = element("input");
        file.type = "file";
        file.accept = ".json,application/json";
        file.hidden = true;
        file.onchange = async () => {
            const selected = file.files?.[0];
            if (!selected) return;
            try {
                const value = JSON.parse(await selected.text());
                if (
                    typeof value.name !== "string" ||
                    !value.name.trim() ||
                    !Array.isArray(value.materials) ||
                    !value.materials.length
                )
                    throw new Error("Expected a library name and a non-empty materials array.");
                const materials = value.materials.map(
                    (entry: { name?: unknown; color?: unknown; opacity?: unknown }) => {
                        if (
                            typeof entry.name !== "string" ||
                            typeof entry.color !== "string" ||
                            !/^#[\da-f]{6}$/i.test(entry.color)
                        )
                            throw new Error("Each material needs a name and a #RRGGBB color.");
                        const opacity = entry.opacity === undefined ? 1 : Number(entry.opacity);
                        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
                            throw new Error("Opacity must be between 0 and 1.");
                        return { name: entry.name, color: entry.color, opacity };
                    },
                );
                patchPreferences({
                    materialLibraries: [
                        ...Config.instance.preferences.materialLibraries,
                        { id: crypto.randomUUID(), name: value.name, fileName: selected.name, materials },
                    ],
                });
                render();
                status.textContent = "Library saved. New documents include these appearances automatically.";
            } catch (error) {
                status.textContent = error instanceof Error ? error.message : String(error);
            }
            file.value = "";
        };
        section.append(
            list,
            note(
                "Import a JSON appearance library. Saved libraries are included in new documents; add them to the current document below.",
            ),
            element(
                "code",
                '{"name":"My materials","materials":[{"name":"Steel","color":"#8899aa","opacity":1}]}',
            ),
            file,
            action("Add material library…", () => file.click(), true),
            status,
        );
        render();
    }

    private exports() {
        const section = this.section("exports", "User export rules");
        const rules = structuredClone(Config.instance.preferences.exportRules);
        const list = element("div");
        section.append(
            note(
                "Customize CAD export filenames. Use {name} for the part or drawing name, {date} for today’s date, {document} for the document, {format} for the file type, {#variable} for a variable’s value and {config:Input} or {config} for the active configuration. The file extension is added automatically.",
            ),
            list,
        );
        const render = () => {
            list.replaceChildren(
                ...rules.map((rule, i) => {
                    const row = element("div", "", style.actions);
                    const extension = choice(
                        `Export format ${i + 1}`,
                        ["step", "iges", "brep", "stl", "dxf", "dwg", "svg"].map((key) => [
                            key,
                            key.toUpperCase(),
                        ]),
                        rule.extension,
                    );
                    const template = element("input");
                    template.value = rule.template;
                    template.setAttribute("aria-label", `Filename template ${i + 1}`);
                    extension.onchange = () => {
                        rule.extension = extension.value;
                    };
                    template.oninput = () => {
                        rule.template = template.value;
                    };
                    row.append(
                        extension,
                        template,
                        action("Remove rule", () => {
                            rules.splice(i, 1);
                            render();
                            dirty();
                        }),
                    );
                    return row;
                }),
            );
            if (!rules.length) list.append(note("You have not added any export rules."));
        };
        section.append(
            action("Add export rule…", () => {
                rules.push({ extension: "step", template: "{name}" });
                render();
                dirty();
            }),
        );
        const dirty = this.save(section, "Save export rules", () => {
            if (new Set(rules.map((rule) => rule.extension)).size !== rules.length)
                throw new Error("Use one rule per export format.");
            // Every `{…}` must be a known placeholder: name, date, document, format, a variable, a configuration input.
            if (
                rules.some(
                    (rule) =>
                        !rule.template.trim() ||
                        rule.template.replace(EXPORT_NAME_PLACEHOLDER, "").includes("{"),
                )
            )
                throw new Error(
                    "Use a filename with {name}, {date}, {document}, {format}, {#variable}, {config:Input} or {config} placeholders.",
                );
            patchPreferences({ exportRules: rules });
        });
        render();
    }

    private desktop() {
        const section = this.section("desktop", "Desktop apps");
        const current = Config.instance.preferences.desktop;
        const url = element("input");
        url.value = current.bridgeUrl;
        url.placeholder = DEFAULT_DESKTOP_PREFERENCES.bridgeUrl;
        url.setAttribute("aria-label", "Desktop bridge URL");
        const auto = check(
            "Open exports in the desktop app automatically: the bridge saves the file to its folder and opens it in the default program instead of a browser download.",
            current.openExports,
        );
        const status = element("p", "", style.note);
        status.setAttribute("role", "status");
        const describe = (info: DesktopBridgeInfo) =>
            `Connected. Exports are saved to ${info.exportsDir}. Programs found: ${
                info.apps.map((app) => app.name).join(", ") || "none (the default program only)"
            }.`;
        const probe = action("Check connection", async () => {
            status.textContent = "Checking…";
            const result = await probeDesktopBridge(url.value, { timeoutMs: 3000 });
            status.textContent = result.isOk ? describe(result.value) : `Not connected: ${result.error}`;
        });
        const row = element("div", "", style.actions);
        row.append(probe);
        section.append(
            note(
                'Run "node scripts/desktop-bridge.mjs" on this computer and exported files can open in FreeCAD, PrusaSlicer, Bambu Studio, OrcaSlicer, Cura, LibreCAD, Inkscape, … or in the system\'s default program. After each export a message offers the programs the bridge found.',
            ),
            field("Bridge URL", url),
            auto.row,
            row,
            status,
        );
        this.save(section, "Save desktop settings", () => {
            const bridgeUrl = url.value.trim().replace(/\/+$/, "") || DEFAULT_DESKTOP_PREFERENCES.bridgeUrl;
            let parsed: URL;
            try {
                parsed = new URL(bridgeUrl);
            } catch {
                throw new Error("Enter the bridge URL, e.g. http://127.0.0.1:7781.");
            }
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                throw new Error("The bridge URL must start with http:// or https://.");
            }
            url.value = bridgeUrl;
            patchPreferences({ desktop: { bridgeUrl, openExports: auto.input.checked } });
            exportDelivery.refresh();
        });
    }

    private automation() {
        const section = this.section("automation", "Automation");
        const current = Config.instance.preferences.automation;
        const url = element("input");
        url.value = current.bridgeUrl;
        url.placeholder = DEFAULT_AUTOMATION_PREFERENCES.bridgeUrl;
        url.setAttribute("aria-label", "Automation bridge URL");
        const enabled = check(
            "Let the local automation bridge drive this app: Claude Code (or a shell with the bridge's token) can then use every tool the in-app assistant has, click and type in the UI, move the camera and run scripts in this tab.",
            current.enabled,
        );
        const status = element("p", "", style.note);
        status.setAttribute("role", "status");
        const describe = () => {
            const state = automationSession.state;
            status.textContent =
                state === "connected"
                    ? "Connected to the bridge."
                    : state === "connecting"
                      ? "Waiting for the bridge (start it with npm run automation, or let Claude Code start it)."
                      : "Off.";
        };
        describe();
        section.append(
            note(
                'Run "npm run automation" (or open Claude Code in the project, which starts it from .mcp.json). Adding ?automation=1 to the address enables it for one session only. A badge shows while the bridge is connected, with a Disconnect button.',
            ),
            field("Bridge URL", url),
            enabled.row,
            status,
        );
        this.save(section, "Save automation settings", () => {
            const bridgeUrl =
                url.value.trim().replace(/\/+$/, "") || DEFAULT_AUTOMATION_PREFERENCES.bridgeUrl;
            let parsed: URL;
            try {
                parsed = new URL(bridgeUrl);
            } catch {
                throw new Error("Enter the bridge URL, e.g. http://127.0.0.1:7782.");
            }
            if (
                parsed.protocol !== "http:" ||
                !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
            ) {
                throw new Error("The automation bridge runs on this computer: use http://127.0.0.1:<port>.");
            }
            url.value = bridgeUrl;
            patchPreferences({ automation: { bridgeUrl, enabled: enabled.input.checked } });
            automationSession.apply();
            describe();
        });
    }
}
