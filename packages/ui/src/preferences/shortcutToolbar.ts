// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    CommandStore,
    Config,
    I18n,
    PubSub,
    type Ribbon,
    type ShortcutContext,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import style from "./shortcutToolbar.module.css";

/** These actions use the same binding as their viewport command aliases. */
export function shortcutBindingCommand(key: CommandKeys): CommandKeys {
    if (Object.hasOwn(Config.instance.customShortcuts, key)) return key;
    return (
        (
            {
                "sketch.line": "create.line",
                "sketch.trim": "modify.trim",
                "sketch.offset": "create.offset",
                "sketch.fillet": "modify.fillet",
                "sketch.chamfer": "modify.chamfer",
                "sketch.transform": "modify.move",
                "sketch.rectangle": "create.rect",
                "sketch.circle": "create.circle",
                "sketch.arc": "create.arc",
                "feature.extrude": "create.extrude",
                "feature.revolve": "create.revol",
                "feature.fillet": "modify.fillet",
                "feature.chamfer": "modify.chamfer",
                "feature.fuse": "boolean.join",
                "feature.cut": "boolean.cut",
                "feature.common": "boolean.common",
            } as Partial<Record<CommandKeys, CommandKeys>>
        )[key] ?? key
    );
}

export function shortcutCategory(key: CommandKeys): string {
    if (/^(sketch|constraint|dimension)\./.test(key)) return "Sketch";
    if (/^assembly\./.test(key)) return "Assembly";
    if (/^(view|workingPlane)\./.test(key)) return "3D view";
    if (/^(drawing|documents)\./.test(key)) return "Drawing";
    if (/^(create|modify|feature|featurescript|boolean|plane|sheetMetal|link)\./.test(key))
        return "Part Studio";
    return "General";
}

export function defaultShortcutTools(context: ShortcutContext): CommandKeys[] {
    const tools = {
        Sketch: [
            "sketch.line",
            "sketch.rectangle",
            "sketch.circle",
            "sketch.arc",
            "sketch.spline",
            "sketch.point",
            "sketch.trim",
            "dimension.distance",
        ],
        "Part Studio": [
            "sketch.create",
            "feature.extrude",
            "feature.revolve",
            "feature.fillet",
            "feature.chamfer",
            "feature.variable",
        ],
        Assembly: ["assembly.insert", "assembly.mate"],
        Drawing: [],
    };
    return (tools[context] as CommandKeys[]).filter((key) => CommandStore.getComandData(key));
}

/** The shortcut palette is additive: existing single-key CAD bindings stay intact. */
export class ShortcutToolbar {
    private menu?: HTMLElement;
    private x = 400;
    private y = 200;
    constructor(private readonly ribbon: Ribbon) {}
    start() {
        window.addEventListener("keydown", this.keyDown, true);
        document.addEventListener("pointerdown", this.outside);
        document.addEventListener("pointermove", this.pointer);
    }
    dispose() {
        window.removeEventListener("keydown", this.keyDown, true);
        document.removeEventListener("pointerdown", this.outside);
        document.removeEventListener("pointermove", this.pointer);
        this.close();
    }
    private close = () => {
        this.menu?.remove();
        this.menu = undefined;
    };
    private pointer = (event: PointerEvent) => {
        this.x = event.clientX;
        this.y = event.clientY;
    };
    private outside = (event: PointerEvent) => {
        if (!this.menu?.contains(event.target as Node)) this.close();
    };
    private keyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && this.menu) {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.close();
            return;
        }
        if (
            event.code !== "Space" ||
            !event.shiftKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            event.repeat
        )
            return;
        const target = event.target as HTMLElement;
        if (target.closest?.("input,textarea,select,dialog,chili-home,[contenteditable=true]")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (this.menu) {
            this.close();
            return;
        }
        const tab = this.ribbon.contextTab ?? this.ribbon.activeTab;
        const context: ShortcutContext = tab?.tabName.includes("sketch")
            ? "Sketch"
            : tab?.tabName.includes("assembly")
              ? "Assembly"
              : tab?.tabName.includes("drawing")
                ? "Drawing"
                : "Part Studio";
        const tools = Config.instance.preferences.shortcutToolbars[context] ?? defaultShortcutTools(context);
        const menu = document.createElement("div");
        menu.className = style.menu;
        menu.setAttribute("role", "toolbar");
        menu.setAttribute("aria-label", `${context} shortcut toolbar`);
        for (const key of tools) {
            const data = CommandStore.getComandData(key);
            if (!data || !this.ribbon.isCommandAvailable(key)) continue;
            const button = document.createElement("button");
            button.title = I18n.translate(`command.${key}`);
            button.setAttribute("aria-label", button.title);
            button.append(createCadIcon(key, data.icon));
            button.onclick = () => {
                this.close();
                PubSub.default.pub("executeCommand", key);
            };
            menu.append(button);
        }
        const settings = document.createElement("button");
        settings.textContent = "…";
        settings.title = "Customize shortcut toolbar";
        settings.onclick = () => {
            this.close();
            PubSub.default.pub("openPreferences", undefined, "shortcut-toolbars");
        };
        menu.append(settings);
        document.body.append(menu);
        this.menu = menu;
        menu.style.left = `${Math.max(8, Math.min(this.x, window.innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(this.y, window.innerHeight - menu.offsetHeight - 8))}px`;
        menu.querySelector("button")?.focus();
    };
}
