// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { difference, intersection, offset, opening, type Paths, union } from "../geometry/polygons";
import type { SlicerSettings } from "../prusa/settings";
import type { LayerRegions } from "./regions";

/**
 * Simple support columns. A layer's overhang is what it holds beyond the layer below grown by
 * the distance a wall at the threshold angle (from horizontal) advances per layer. Overhangs
 * project straight down as columns, `contactDistance` below them (whole layers), keeping
 * `xyGap` from the part; a column stops (with the same gap) where it meets the part below,
 * or is dropped there entirely when only the build plate may carry supports. The top
 * `interfaceLayers` of each column are dense interface.
 */
export interface SupportLayer {
    readonly area: Paths;
    readonly interface: Paths;
}

export function planSupports(layers: readonly LayerRegions[], settings: SlicerSettings): SupportLayer[] {
    const n = layers.length;
    const empty: SupportLayer = { area: [], interface: [] };
    if (!settings.supports.enabled || n < 2) return layers.map(() => empty);
    const s = settings.supports;
    const angle = (Math.max(1, Math.min(89, s.thresholdAngle)) * Math.PI) / 180;
    const overhangs: Paths[] = layers.map((layer, i) => {
        if (i === 0) return [];
        const allowed = layer.spec.height / Math.tan(angle);
        const held = offset(layers[i - 1].slices, allowed);
        return opening(difference(layer.slices, held), settings.widths.support / 2);
    });
    const gapLayers = Math.max(0, Math.round(s.contactDistance / settings.layerHeight));
    const result: SupportLayer[] = layers.map(() => empty);
    let column: Paths = [];
    let shadow: Paths[] = [];
    if (s.buildPlateOnly) {
        // shadow[j]: the part anywhere below layer j.
        shadow = new Array(n);
        let below: Paths = [];
        for (let j = 0; j < n; j++) {
            shadow[j] = below;
            below = union(below, layers[j].slices);
        }
    }
    for (let j = n - 1; j >= 0; j--) {
        const k = j + 1 + gapLayers;
        if (k < n && overhangs[k].length > 0) column = union(column, overhangs[k]);
        if (column.length === 0) continue;
        let area = difference(column, offset(layers[j].slices, s.xyGap));
        // Keep the contact distance above the part a column lands on.
        for (let m = Math.max(0, j - gapLayers); m < j; m++) area = difference(area, layers[m].slices);
        if (s.buildPlateOnly) area = difference(area, shadow[j]);
        area = opening(area, settings.widths.support / 4);
        column = difference(column, layers[j].slices);
        if (area.length === 0) continue;
        const contact: Paths = [];
        for (let m = 0; m < s.interfaceLayers; m++) {
            const above = j + 1 + gapLayers + m;
            if (above < n) contact.push(...overhangs[above]);
        }
        const interfaceArea = contact.length > 0 ? intersection(area, union(contact)) : [];
        result[j] = { area: difference(area, interfaceArea), interface: interfaceArea };
    }
    return result;
}
