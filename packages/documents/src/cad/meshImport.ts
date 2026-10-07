// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { GroupNode, type IDocument, type INode, Material, Mesh, MeshNode, Result } from "@chili3d/core";
import type { BufferGeometry, MeshStandardMaterial, Object3D, Mesh as ThreeMesh } from "three";

/**
 * Mesh formats Three.js reads — Wavefront OBJ, glTF / GLB and 3MF — as `MeshNode`s: one
 * per mesh, world transforms baked in, millimetres (glTF is in metres, 3MF declares its
 * unit), one material per distinct color. The loaders are their own lazily loaded chunk.
 * Meshes are display geometry: they render, measure and export, but no B-rep operation
 * (fillet, boolean) applies to them.
 */

export type MeshFormat = "obj" | "gltf" | "glb" | "3mf";

/** Millimetres per unit of a 3MF `unit` attribute. */
const THREE_MF_UNITS: Record<string, number> = {
    micron: 0.001,
    millimeter: 1,
    centimeter: 10,
    inch: 25.4,
    foot: 304.8,
    meter: 1000,
};

async function threeMfUnit(bytes: Uint8Array): Promise<number> {
    try {
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(bytes);
        const entry = Object.values(zip.files).find((file) => file.name.toLowerCase() === "3d/3dmodel.model");
        const xml = entry === undefined ? "" : await entry.async("string");
        const unit = /<model[^>]*\sunit="([a-z]+)"/i.exec(xml)?.[1]?.toLowerCase();
        return THREE_MF_UNITS[unit ?? "millimeter"] ?? 1;
    } catch {
        return 1;
    }
}

/** Parses a mesh file into a Three.js scene graph and its unit (millimetres per unit). */
async function loadScene(format: MeshFormat, bytes: Uint8Array): Promise<{ scene: Object3D; toMm: number }> {
    const buffer = bytes.slice().buffer;
    if (format === "obj") {
        const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
        return { scene: new OBJLoader().parse(new TextDecoder().decode(bytes)), toMm: 1 };
    }
    if (format === "3mf") {
        const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
        return { scene: new ThreeMFLoader().parse(buffer), toMm: await threeMfUnit(bytes) };
    }
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().parseAsync(buffer, "");
    return { scene: gltf.scene, toMm: 1000 };
}

function colorOf(mesh: ThreeMesh): number {
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
        | MeshStandardMaterial
        | undefined;
    return material?.color?.getHex?.() ?? 0xb0b0b0;
}

function meshOf(geometry: BufferGeometry, color: number): Mesh | undefined {
    const position = geometry.getAttribute("position");
    if (position === undefined || position.count < 3) return undefined;
    if (geometry.getAttribute("normal") === undefined) geometry.computeVertexNormals();
    const normal = geometry.getAttribute("normal");
    const positions = new Float32Array(position.count * 3);
    const normals = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
        positions.set([position.getX(i), position.getY(i), position.getZ(i)], i * 3);
        normals.set([normal.getX(i), normal.getY(i), normal.getZ(i)], i * 3);
    }
    const index = geometry.getIndex();
    const indices =
        index === null
            ? Uint32Array.from({ length: position.count - (position.count % 3) }, (_, i) => i)
            : Uint32Array.from({ length: index.count }, (_, i) => index.getX(i));
    if (indices.length < 3) return undefined;
    return new Mesh({ meshType: "surface", position: positions, normal: normals, index: indices, color });
}

/** The surface meshes of `scene` in world coordinates, scaled to millimetres. */
export async function readMeshFile(
    format: MeshFormat,
    bytes: Uint8Array,
): Promise<Result<{ name: string; mesh: Mesh }[]>> {
    let loaded: { scene: Object3D; toMm: number };
    try {
        loaded = await loadScene(format, bytes);
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
    const { Matrix4 } = await import("three");
    const scale = new Matrix4().makeScale(loaded.toMm, loaded.toMm, loaded.toMm);
    loaded.scene.updateMatrixWorld(true);
    const meshes: { name: string; mesh: Mesh }[] = [];
    loaded.scene.traverse((object) => {
        const mesh = object as ThreeMesh;
        if (mesh.isMesh !== true || mesh.geometry === undefined) return;
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(scale.clone().multiply(mesh.matrixWorld));
        const converted = meshOf(geometry, colorOf(mesh));
        geometry.dispose();
        if (converted !== undefined) meshes.push({ name: mesh.name, mesh: converted });
    });
    if (meshes.length === 0) return Result.err("The file holds no surface mesh");
    return Result.ok(meshes);
}

/**
 * Adds the meshes of a mesh file to `document`: one `MeshNode`, or a group named after
 * the file when there are several. Returns the added top-level node.
 */
export async function importMeshFile(
    document: IDocument,
    name: string,
    format: MeshFormat,
    bytes: Uint8Array,
): Promise<Result<INode[]>> {
    const meshes = await readMeshFile(format, bytes);
    if (!meshes.isOk) return Result.err(meshes.error);
    const materials = new Map<number, string>();
    const materialId = (color: number) => {
        let id = materials.get(color);
        if (id === undefined) {
            const hex = `#${color.toString(16).padStart(6, "0")}`;
            const material = new Material({ document, name: hex, color });
            document.modelManager.materials.push(material);
            id = material.id;
            materials.set(color, id);
        }
        return id;
    };
    const nodes = meshes.value.map(
        ({ name: meshName, mesh }, i) =>
            new MeshNode({
                document,
                name: meshName || (meshes.value.length === 1 ? name : `${name} ${i + 1}`),
                mesh,
                materialId: materialId(mesh.color as number),
            }),
    );
    if (nodes.length === 1) {
        nodes[0].name = name;
        document.modelManager.addNode(nodes[0]);
        return Result.ok(nodes);
    }
    const group = new GroupNode({ document, name });
    for (const node of nodes) group.add(node);
    document.modelManager.addNode(group);
    return Result.ok([group]);
}
