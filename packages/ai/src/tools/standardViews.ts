// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { XYZLike } from "@chili3d/core";

/**
 * The view cube's orientations by name: its 6 faces ("front"), 12 edges ("top front") and 8
 * corners ("top front right"), plus "iso" (= top front right). Words may come in any order.
 * `direction` points from the target to the eye (Z-up world), as the cube's region normals do;
 * looking straight down or up keeps +Y / -Y up on screen, like the cube.
 */

const WORDS: Record<string, [number, number, number]> = {
    left: [-1, 0, 0],
    right: [1, 0, 0],
    front: [0, -1, 0],
    back: [0, 1, 0],
    bottom: [0, 0, -1],
    top: [0, 0, 1],
};
const AXIS_OF: Record<string, number> = { left: 0, right: 0, front: 1, back: 1, bottom: 2, top: 2 };
/** Canonical word order, as the cube labels its corners: "Top Front Right". */
const ORDER = [2, 1, 0];

export interface StandardView {
    readonly name: string;
    readonly direction: XYZLike;
    readonly up: XYZLike;
}

const capitalize = (word: string) => word[0].toUpperCase() + word.slice(1);

export function standardView(name: string): StandardView | string {
    const raw = name.trim().toLowerCase();
    const words = raw === "iso" || raw === "isometric" ? ["top", "front", "right"] : raw.split(/[\s_+,-]+/);
    if (words.length === 0 || words.length > 3 || words.some((word) => !(word in WORDS))) {
        return `unknown view "${name}": use a view cube face (front, back, left, right, top, bottom), edge ("top front") or corner ("top front right"), or iso`;
    }
    const axes = words.map((word) => AXIS_OF[word]);
    if (new Set(axes).size !== axes.length) return `"${name}" names two sides along one axis`;
    const vector = [0, 0, 0];
    for (const word of words) WORDS[word].forEach((v, i) => (vector[i] += v));
    const length = Math.hypot(...vector);
    const direction = { x: vector[0] / length, y: vector[1] / length, z: vector[2] / length };
    const vertical = vector[0] === 0 && vector[1] === 0;
    const up = vertical ? { x: 0, y: Math.sign(vector[2]), z: 0 } : { x: 0, y: 0, z: 1 };
    const sorted = ORDER.flatMap((axis) => words.filter((word) => AXIS_OF[word] === axis));
    return { name: sorted.map(capitalize).join(" "), direction, up };
}

/** Every named orientation, faces first. */
export function standardViewNames(): string[] {
    const names: string[] = [];
    const sides = [
        ["top", "bottom"],
        ["front", "back"],
        ["left", "right"],
    ];
    for (const a of sides.flat()) names.push(a);
    for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++)
            for (const a of sides[i]) for (const b of sides[j]) names.push(`${a} ${b}`);
    for (const a of sides[0])
        for (const b of sides[1]) for (const c of sides[2]) names.push(`${a} ${b} ${c}`);
    return names;
}

/** The named orientation whose direction is within `toleranceDeg` of this one, if any. */
export function nearestStandardView(direction: XYZLike, toleranceDeg = 0.5): string | undefined {
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const limit = Math.cos((toleranceDeg * Math.PI) / 180);
    for (const name of standardViewNames()) {
        const view = standardView(name) as StandardView;
        const dot =
            (view.direction.x * direction.x +
                view.direction.y * direction.y +
                view.direction.z * direction.z) /
            length;
        if (dot >= limit) return view.name;
    }
    return undefined;
}
