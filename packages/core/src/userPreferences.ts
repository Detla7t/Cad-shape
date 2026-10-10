// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandKeys } from "./command/commandKeys";
import type { GraphicsPreferences } from "./graphicsPreferences";
import type { Navigation3DType } from "./navigation";
import type { DocumentUnits } from "./parameters/documentUnits";

/** Factors convert display units to SI; geometry continues to use mm and degrees. */
export const QUANTITY_UNITS = {
    acceleration: {
        label: "Linear acceleration",
        units: [
            ["m/s²", "Metre per second squared", 1],
            ["ft/s²", "Foot per second squared", 0.3048],
            ["in/s²", "Inch per second squared", 0.0254],
        ],
    },
    angularVelocity: {
        label: "Angular velocity",
        units: [
            ["deg/s", "Degree per second", Math.PI / 180],
            ["rad/s", "Radian per second", 1],
            ["rpm", "Revolution per minute", Math.PI / 30],
        ],
    },
    mass: {
        label: "Mass",
        units: [
            ["kg", "Kilogram", 1],
            ["g", "Gram", 0.001],
            ["lb", "Pound", 0.45359237],
            ["oz", "Ounce", 0.028349523125],
        ],
    },
    density: {
        label: "Density",
        units: [
            ["kg/m³", "Kilogram per cubic metre", 1],
            ["g/cm³", "Gram per cubic centimetre", 1000],
            ["lb/in³", "Pound per cubic inch", 27679.904710203],
        ],
    },
    force: {
        label: "Force",
        units: [
            ["N", "Newton", 1],
            ["kN", "Kilonewton", 1000],
            ["lbf", "Pound-force", 4.4482216152605],
        ],
    },
    frequency: {
        label: "Frequency",
        units: [
            ["Hz", "Hertz", 1],
            ["kHz", "Kilohertz", 1000],
        ],
    },
    moment: {
        label: "Moment",
        units: [
            ["N·m", "Newton-metre", 1],
            ["N·mm", "Newton-millimetre", 0.001],
            ["in·lbf", "Inch-pound", 0.1129848290276167],
            ["ft·lbf", "Foot-pound", 4.4482216152605 * 0.3048],
        ],
    },
    pressure: {
        label: "Pressure",
        units: [
            ["Pa", "Pascal", 1],
            ["kPa", "Kilopascal", 1000],
            ["MPa", "Megapascal", 1e6],
            ["bar", "Bar", 1e5],
            ["psi", "Pound per square inch", 6894.757293168],
        ],
    },
    energy: {
        label: "Energy",
        units: [
            ["J", "Joule", 1],
            ["kJ", "Kilojoule", 1000],
            ["ft·lbf", "Foot-pound force", 4.4482216152605 * 0.3048],
        ],
    },
} as const;
export type QuantityKind = keyof typeof QUANTITY_UNITS;
export type QuantityPreferences = Record<QuantityKind, { unit: string; precision: number }>;
export type ShortcutContext = "Part Studio" | "Sketch" | "Assembly" | "Drawing";
export interface MousePreferences {
    reverseZoom: boolean;
    constrainedRotation: boolean;
    penAsMouse: boolean;
}
export interface EnvironmentProfile {
    id: string;
    name: string;
    navigation: Navigation3DType;
    mouse: MousePreferences;
    pixelDensity: UserPreferences["pixelDensity"];
    graphics: GraphicsPreferences;
}
export interface MaterialLibrary {
    id: string;
    name: string;
    fileName: string;
    materials: { name: string; color: string; opacity: number }[];
}
export interface ExportRule {
    extension: string;
    template: string;
}
/** The local desktop bridge (`scripts/desktop-bridge.mjs`) that opens exports in desktop programs. */
export interface DesktopPreferences {
    /** Where the bridge listens. */
    bridgeUrl: string;
    /**
     * Hand exports to the bridge, which saves them to its folder and opens them in the default
     * program, instead of the browser download (when the bridge is running and opens the type).
     */
    openExports: boolean;
}
export const DEFAULT_DESKTOP_PREFERENCES: Readonly<DesktopPreferences> = {
    bridgeUrl: "http://127.0.0.1:7781",
    openExports: false,
};
/**
 * The local automation bridge (`scripts/automation-bridge.mjs`): when enabled, this tab connects
 * to it so Claude Code (or a shell with the bridge's token) can drive the app like the user.
 */
export interface AutomationPreferences {
    enabled: boolean;
    bridgeUrl: string;
}
export const DEFAULT_AUTOMATION_PREFERENCES: Readonly<AutomationPreferences> = {
    enabled: false,
    bridgeUrl: "http://127.0.0.1:7782",
};
/**
 * A drawing template: the sheet layout a new drawing starts from — its size and title
 * block fields — and, imported from a DXF, art drawn behind the sheet (a company frame).
 */
export interface DrawingTemplate {
    name: string;
    /** `A4` or `A` (ANSI A). */
    sheet: string;
    drawnBy?: string;
    number?: string;
    revision?: string;
    /** A DXF whose geometry is drawn behind the sheet. */
    frameDxf?: string;
}

export interface UserPreferences {
    decimalComma: boolean;
    defaultUnits: DocumentUnits;
    quantities: QuantityPreferences;
    timeFormat: "12" | "24";
    mouse: MousePreferences;
    pixelDensity: "automatic" | "device" | "standard";
    profiles: EnvironmentProfile[];
    assemblyProperties: boolean;
    shortcutToolbars: Partial<Record<ShortcutContext, CommandKeys[]>>;
    drawingBackground: "dark" | "light";
    materialLibraries: MaterialLibrary[];
    exportRules: ExportRule[];
    /** Write a recovery save of each document shortly after every change. */
    autosave: boolean;
    /**
     * Colour the model tree's rows by what uses them (Fusion's component colour cycling):
     * each solid result, each top-level part, or not at all.
     */
    treeOwnerColors: "off" | "solid" | "part";
    /** Show the Part Studio timeline (Fusion's history bar) along the bottom of the viewport. */
    showTimeline: boolean;
    /** Drawing templates; the first is what a new drawing uses. */
    drawingTemplates: DrawingTemplate[];
    desktop: DesktopPreferences;
    automation: AutomationPreferences;
}

export function defaultUserPreferences(): UserPreferences {
    return {
        decimalComma: false,
        defaultUnits: { length: "mm", angle: "deg", lengthPrecision: 2, anglePrecision: 1 },
        quantities: Object.fromEntries(
            Object.entries(QUANTITY_UNITS).map(([key, data]) => [
                key,
                { unit: key === "density" ? "g/cm³" : data.units[0][0], precision: 3 },
            ]),
        ) as QuantityPreferences,
        timeFormat: "24",
        mouse: { reverseZoom: false, constrainedRotation: false, penAsMouse: false },
        pixelDensity: "automatic",
        profiles: [],
        assemblyProperties: true,
        shortcutToolbars: {},
        drawingBackground: "dark",
        materialLibraries: [],
        exportRules: [],
        autosave: true,
        treeOwnerColors: "solid",
        showTimeline: true,
        drawingTemplates: [],
        desktop: { ...DEFAULT_DESKTOP_PREFERENCES },
        automation: { ...DEFAULT_AUTOMATION_PREFERENCES },
    };
}

/** Merge additions without resetting preferences saved by an earlier application version. */
export function mergeUserPreferences(value?: Partial<UserPreferences>): UserPreferences {
    const defaults = defaultUserPreferences();
    // An earlier version stored the tree colouring as a boolean.
    const owners = (value as { treeOwnerColors?: unknown } | undefined)?.treeOwnerColors;
    const treeOwnerColors =
        owners === true
            ? "solid"
            : owners === false
              ? "off"
              : owners === "off" || owners === "part"
                ? owners
                : "solid";
    return {
        ...defaults,
        ...value,
        treeOwnerColors,
        defaultUnits: { ...defaults.defaultUnits, ...value?.defaultUnits },
        quantities: { ...defaults.quantities, ...value?.quantities },
        mouse: { ...defaults.mouse, ...value?.mouse },
        desktop: { ...defaults.desktop, ...value?.desktop },
        automation: { ...defaults.automation, ...value?.automation },
    };
}

export function displayPixelRatio(mode: UserPreferences["pixelDensity"], deviceRatio: number): number {
    const ratio = Math.max(1, Number.isFinite(deviceRatio) ? deviceRatio : 1);
    return mode === "standard" ? 1 : mode === "device" ? Math.min(4, ratio) : Math.min(2, ratio);
}

/**
 * Resolves the extra placeholders of an export name — `{document}`, `{#variable}`,
 * `{config:Input}`, `{config}`, `{format}` — for one document; undefined leaves the
 * placeholder as written.
 */
export type ExportNameResolver = (placeholder: string) => string | undefined;

/** Every placeholder a template may use, for the rules editor's check and hint. */
export const EXPORT_NAME_PLACEHOLDER =
    /\{(name|date|document|format|#[A-Za-z_]\w*|config(?::[A-Za-z_]\w*)?)\}/g;

/**
 * A file name from the export rules: the rule for `extension` (its template, `{name}` when
 * there is none) with `{name}` and `{date}` filled in, the document's placeholders through
 * `resolve`, and every character a file system refuses replaced.
 */
export function exportFileName(
    name: string,
    extension: string,
    rules: ExportRule[],
    date = new Date(),
    resolve?: ExportNameResolver,
): string {
    const suffix = extension.startsWith(".") ? extension : `.${extension}`;
    const rule = rules.find(
        (rule) => rule.extension.toLowerCase().replace(/^\./, "") === suffix.slice(1).toLowerCase(),
    );
    const template = rule?.template.trim() || "{name}";
    return formatExportName(template, name, suffix, date, resolve);
}

/** `template` with its placeholders filled in and `suffix` appended, as a safe file name. */
export function formatExportName(
    template: string,
    name: string,
    suffix: string,
    date = new Date(),
    resolve?: ExportNameResolver,
): string {
    const base = template.replace(EXPORT_NAME_PLACEHOLDER, (whole, key: string) => {
        if (key === "name") return name;
        if (key === "date") return date.toISOString().slice(0, 10);
        if (key === "format") return suffix.replace(/^\./, "").toUpperCase();
        return resolve?.(key) ?? whole;
    });
    const clean = [...base]
        .map((char) => (char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? "_" : char))
        .join("");
    return `${clean.trim() || "export"}${suffix}`;
}
