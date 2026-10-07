// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * A minimal 3MF writer (3MF Core Specification 1.x): the OPC package parts
 * (`[Content_Types].xml`, `_rels/.rels`) and one `3D/3dmodel.model` with an object per
 * mesh, in millimetres, colored through a base-materials group. Vertices shared by
 * adjacent triangles are welded, so a closed B-rep mesh stays a closed (manifold) 3MF mesh.
 */

export interface ThreeMfMesh {
    readonly name: string;
    /** 0xRRGGBB. */
    readonly color?: number;
    /** x, y, z triples in millimetres. */
    readonly positions: ArrayLike<number>;
    /** Counter-clockwise (outward) triangles, three vertex indices each. */
    readonly indices: ArrayLike<number>;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;

const RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

const escapeXml = (text: string) =>
    text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

const number = (value: number) => {
    const text = (Math.round(value * 1e6) / 1e6).toString();
    return text === "-0" ? "0" : text;
};

const hexColor = (color: number) => `#${(color & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;

/** Welds coincident vertices (within 10 nm) and drops the triangles that collapse. */
export function weldMesh(mesh: ThreeMfMesh): { vertices: number[]; triangles: number[] } {
    const vertices: number[] = [];
    const remap = new Map<string, number>();
    const indexOf = (i: number) => {
        const x = mesh.positions[i * 3];
        const y = mesh.positions[i * 3 + 1];
        const z = mesh.positions[i * 3 + 2];
        const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
        let index = remap.get(key);
        if (index === undefined) {
            index = vertices.length / 3;
            remap.set(key, index);
            vertices.push(x, y, z);
        }
        return index;
    };
    const triangles: number[] = [];
    for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
        const a = indexOf(mesh.indices[t]);
        const b = indexOf(mesh.indices[t + 1]);
        const c = indexOf(mesh.indices[t + 2]);
        if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
    }
    return { vertices, triangles };
}

export function threeMfModel(meshes: readonly ThreeMfMesh[]): string {
    const colors = [...new Set(meshes.map((mesh) => mesh.color ?? 0xdedede))];
    const lines = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`,
        `  <metadata name="Application">Chili3D</metadata>`,
        `  <resources>`,
        `    <basematerials id="1">`,
        ...colors.map((color) => `      <base name="${hexColor(color)}" displaycolor="${hexColor(color)}"/>`),
        `    </basematerials>`,
    ];
    const items: string[] = [];
    meshes.forEach((mesh, i) => {
        const { vertices, triangles } = weldMesh(mesh);
        if (triangles.length === 0) return;
        const id = i + 2;
        const pindex = colors.indexOf(mesh.color ?? 0xdedede);
        lines.push(
            `    <object id="${id}" type="model" name="${escapeXml(mesh.name)}" pid="1" pindex="${pindex}">`,
        );
        lines.push(`      <mesh>`, `        <vertices>`);
        for (let v = 0; v < vertices.length; v += 3) {
            lines.push(
                `          <vertex x="${number(vertices[v])}" y="${number(vertices[v + 1])}" z="${number(vertices[v + 2])}"/>`,
            );
        }
        lines.push(`        </vertices>`, `        <triangles>`);
        for (let t = 0; t < triangles.length; t += 3) {
            lines.push(
                `          <triangle v1="${triangles[t]}" v2="${triangles[t + 1]}" v3="${triangles[t + 2]}"/>`,
            );
        }
        lines.push(`        </triangles>`, `      </mesh>`, `    </object>`);
        items.push(`    <item objectid="${id}"/>`);
    });
    lines.push(`  </resources>`, `  <build>`, ...items, `  </build>`, `</model>`, ``);
    return lines.join("\n");
}

/** The `.3mf` package bytes. */
export async function write3mf(meshes: readonly ThreeMfMesh[]): Promise<Uint8Array> {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("[Content_Types].xml", CONTENT_TYPES);
    zip.file("_rels/.rels", RELATIONSHIPS);
    zip.file("3D/3dmodel.model", threeMfModel(meshes));
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
