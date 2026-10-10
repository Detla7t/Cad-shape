// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub } from "../foundation/pubsub";

/**
 * The size of a screen pixel in model units at the active view's target, kept in bands (a
 * factor 1.5 apart) so that display geometry drawn to a pixel scale — a construction line's
 * dash pattern — rebuilds on a real zoom change and not on every frame. The view reports
 * every camera change; subscribers of `displayScaleChanged` hear only band changes.
 */
export class DisplayScale {
    private static _value = 0.1;

    /** Model units per pixel, as last reported (quantized). */
    static get value(): number {
        return DisplayScale._value;
    }

    /** The band `pixel` falls in: 0.1 × 1.5ⁿ. */
    static band(pixel: number): number {
        if (!Number.isFinite(pixel) || pixel <= 0) return DisplayScale._value;
        return 0.1 * 1.5 ** Math.round(Math.log(pixel / 0.1) / Math.log(1.5));
    }

    /** Called by the view after a camera change; publishes and returns true when the band changed. */
    static update(pixel: number): boolean {
        const band = DisplayScale.band(pixel);
        if (band === DisplayScale._value) return false;
        DisplayScale._value = band;
        PubSub.default.pub("displayScaleChanged", band);
        return true;
    }

    /**
     * World units per preference pixel for a dash pattern whose period is `periodPixels`
     * pixels when drawn to the pixel size `pixel`: the period is snapped to 1, 2 or 5 × 10ⁿ
     * model units, so a construction line's dashes stretch with the zoom until the next
     * step and the pattern stays tied to the model's units (Onshape's construction lines),
     * between about 0.6× and 1.6× the preference on screen.
     */
    static dashUnit(pixel: number, periodPixels: number): number {
        if (!(pixel > 0) || !(periodPixels > 0)) return pixel;
        const raw = periodPixels * pixel;
        const exponent = Math.floor(Math.log10(raw));
        const mantissa = raw / 10 ** exponent;
        const nice = mantissa < 1.5 ? 1 : mantissa < 3.5 ? 2 : mantissa < 7.5 ? 5 : 10;
        return (nice * 10 ** exponent) / periodPixels;
    }

    /** Test support: the initial band. */
    static reset(): void {
        DisplayScale._value = 0.1;
    }
}
