// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** `items` grouped into connected sets: `linked(i, j)` joins items i and j (union–find, first item order kept). */
export function connectedGroups<T>(items: readonly T[], linked: (i: number, j: number) => boolean): T[][] {
    const parent = items.map((_, i) => i);
    const find = (i: number): number => {
        let root = i;
        while (parent[root] !== root) root = parent[root];
        for (let k = i; parent[k] !== root; ) {
            const next = parent[k];
            parent[k] = root;
            k = next;
        }
        return root;
    };
    for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            if (find(i) !== find(j) && linked(i, j)) parent[find(j)] = find(i);
        }
    }
    const groups = new Map<number, T[]>();
    items.forEach((item, i) => {
        const root = find(i);
        const group = groups.get(root);
        if (group === undefined) groups.set(root, [item]);
        else group.push(item);
    });
    return [...groups.values()];
}
