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
    };
}

/** Merge additions without resetting preferences saved by an earlier application version. */
export function mergeUserPreferences(value?: Partial<UserPreferences>): UserPreferences {
    const defaults = defaultUserPreferences();
    return {
        ...defaults,
        ...value,
        defaultUnits: { ...defaults.defaultUnits, ...value?.defaultUnits },
        quantities: { ...defaults.quantities, ...value?.quantities },
        mouse: { ...defaults.mouse, ...value?.mouse },
    };
}

export function displayPixelRatio(mode: UserPreferences["pixelDensity"], deviceRatio: number): number {
    const ratio = Math.max(1, Number.isFinite(deviceRatio) ? deviceRatio : 1);
    return mode === "standard"
        ? 1
        : mode === "device"
          ? Math.min(4, ratio)
          : Math.min(2, Math.max(1.5, ratio));
}

export function exportFileName(
    name: string,
    extension: string,
    rules: ExportRule[],
    date = new Date(),
): string {
    const suffix = extension.startsWith(".") ? extension : `.${extension}`;
    const rule = rules.find(
        (rule) => rule.extension.toLowerCase().replace(/^\./, "") === suffix.slice(1).toLowerCase(),
    );
    const template = rule?.template.trim() || "{name}";
    const base = template.replace(/\{(name|date)\}/g, (_, key) =>
        key === "name" ? name : date.toISOString().slice(0, 10),
    );
    const clean = [...base]
        .map((char) => (char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? "_" : char))
        .join("");
    return `${clean.trim() || "export"}${suffix}`;
}
