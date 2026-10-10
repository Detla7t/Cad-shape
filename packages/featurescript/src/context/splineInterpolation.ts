// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { XYZ } from "@chili3d/core";
import { fail } from "../lang/values";

/**
 * Cubic interpolation: natural ends unless clamped, periodic C2 closure for closed curves.
 * Solves for first derivatives in O(n), including the cyclic system by a rank-one correction.
 * Endpoint derivatives replace natural boundary conditions when supplied.
 */
export function interpolationDerivatives(
    points: XYZ[],
    parameters: number[],
    fixed: (XYZ | undefined)[],
    closed: boolean,
): XYZ[] {
    const n = points.length;
    const h = parameters.slice(1).map((t, i) => t - parameters[i]);
    const delta = h.map((step, i) => points[(i + 1) % n].sub(points[i]).multiply(1 / step));
    const lower = new Array<number>(n).fill(0);
    const diagonal = new Array<number>(n).fill(0);
    const upper = new Array<number>(n).fill(0);
    const rhs = points.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
        let value: XYZ;
        if (fixed[i]) {
            diagonal[i] = 1;
            value = fixed[i]!;
        } else if (!closed && (i === 0 || i === n - 1)) {
            diagonal[i] = 2;
            if (i === 0) upper[i] = 1;
            else lower[i] = 1;
            value = delta[i === 0 ? 0 : n - 2].multiply(3);
        } else {
            const previous = (i + n - 1) % n;
            lower[i] = h[i];
            diagonal[i] = 2 * (h[previous] + h[i]);
            upper[i] = h[previous];
            value = delta[previous].multiply(3 * h[i]).add(delta[i].multiply(3 * h[previous]));
        }
        rhs[i] = [value.x, value.y, value.z, 0];
    }
    const cornerTop = closed ? lower[0] : 0;
    const cornerBottom = closed ? upper[n - 1] : 0;
    const gamma = -diagonal[0];
    if (closed) {
        diagonal[0] -= gamma;
        diagonal[n - 1] -= (cornerTop * cornerBottom) / gamma;
        rhs[0][3] = gamma;
        rhs[n - 1][3] = cornerBottom;
    }
    for (let i = 1; i < n; i++) {
        if (Math.abs(diagonal[i - 1]) < 1e-15) fail("opFitSpline: singular interpolation");
        const factor = lower[i] / diagonal[i - 1];
        diagonal[i] -= factor * upper[i - 1];
        for (let c = 0; c < 4; c++) rhs[i][c] -= factor * rhs[i - 1][c];
    }
    for (let i = n - 1; i >= 0; i--) {
        if (Math.abs(diagonal[i]) < 1e-15) fail("opFitSpline: singular interpolation");
        for (let c = 0; c < 4; c++)
            rhs[i][c] = (rhs[i][c] - (i + 1 < n ? upper[i] * rhs[i + 1][c] : 0)) / diagonal[i];
    }
    if (closed) {
        const denominator = 1 + rhs[0][3] + (cornerTop / gamma) * rhs[n - 1][3];
        for (let c = 0; c < 3; c++) {
            const factor = (rhs[0][c] + (cornerTop / gamma) * rhs[n - 1][c]) / denominator;
            for (let i = 0; i < n; i++) rhs[i][c] -= factor * rhs[i][3];
        }
    }
    return rhs.map(([x, y, z]) => new XYZ(x, y, z));
}
