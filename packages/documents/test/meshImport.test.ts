// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { detectFileFormat, GroupNode, MeshNode } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import JSZip from "jszip";
import { importMeshFile, readMeshFile } from "../src/cad/meshImport";
import { MESH_IMPORTER } from "../src/importers";

const text = (value: string) => new TextEncoder().encode(value);

/** A unit square as two triangles, positions as little-endian floats, indices as uint16. */
function squareBuffers() {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const buffer = new Uint8Array(positions.byteLength + indices.byteLength);
    buffer.set(new Uint8Array(positions.buffer), 0);
    buffer.set(new Uint8Array(indices.buffer), positions.byteLength);
    return { buffer, positionsLength: positions.byteLength, indicesLength: indices.byteLength };
}

function gltfJson(uri?: string) {
    const { buffer, positionsLength, indicesLength } = squareBuffers();
    return {
        json: {
            asset: { version: "2.0" },
            scene: 0,
            scenes: [{ nodes: [0] }],
            nodes: [{ mesh: 0, translation: [0, 0, 0.5], name: "Panel" }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
            materials: [],
            buffers: [{ byteLength: buffer.length, ...(uri === undefined ? {} : { uri }) }],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: positionsLength },
                { buffer: 0, byteOffset: positionsLength, byteLength: indicesLength },
            ],
            accessors: [
                {
                    bufferView: 0,
                    componentType: 5126,
                    count: 4,
                    type: "VEC3",
                    min: [0, 0, 0],
                    max: [1, 1, 0],
                },
                { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" },
            ],
        },
        buffer,
    };
}

function glb(): Uint8Array {
    const { json, buffer } = gltfJson();
    let jsonBytes = text(JSON.stringify(json));
    const pad = (4 - (jsonBytes.length % 4)) % 4;
    jsonBytes = new Uint8Array([...jsonBytes, ...new Array(pad).fill(0x20)]);
    const binPad = (4 - (buffer.length % 4)) % 4;
    const bin = new Uint8Array([...buffer, ...new Array(binPad).fill(0)]);
    const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true); // "glTF"
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonBytes.length, true);
    view.setUint32(16, 0x4e4f534a, true); // "JSON"
    out.set(jsonBytes, 20);
    view.setUint32(20 + jsonBytes.length, bin.length, true);
    view.setUint32(24 + jsonBytes.length, 0x004e4942, true); // "BIN"
    out.set(bin, 28 + jsonBytes.length);
    return out;
}

const bounds = (positions: Float32Array) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], positions[i + k]);
            max[k] = Math.max(max[k], positions[i + k]);
        }
    }
    return { min, max };
};

describe("mesh import", () => {
    test("OBJ: quads are triangulated, objects become meshes", async () => {
        const obj =
            "o cube_face\nv 0 0 0\nv 10 0 0\nv 10 10 0\nv 0 10 0\nf 1 2 3 4\no tri\nv 0 0 5\nv 1 0 5\nv 0 1 5\nf 5 6 7\n";
        expect(detectFileFormat("model.obj", text(obj))).toMatchObject({ id: "obj" });
        const meshes = await readMeshFile("obj", text(obj));
        expect(meshes.isOk).toBe(true);
        expect(meshes.value.map((mesh) => mesh.name)).toEqual(["cube_face", "tri"]);
        expect(meshes.value[0].mesh.index).toHaveLength(6);
        expect(meshes.value[0].mesh.meshType).toBe("surface");
        expect(bounds(meshes.value[0].mesh.position!)).toEqual({ min: [0, 0, 0], max: [10, 10, 0] });
        expect(meshes.value[0].mesh.normal).toHaveLength(meshes.value[0].mesh.position!.length);
    });

    test("glTF (embedded buffer): metres become millimetres, node transforms are applied", async () => {
        const { json, buffer } = gltfJson();
        const embedded = {
            ...json,
            buffers: [
                {
                    ...json.buffers[0],
                    uri: `data:application/octet-stream;base64,${Buffer.from(buffer).toString("base64")}`,
                },
            ],
        };
        const bytes = text(JSON.stringify(embedded));
        expect(detectFileFormat("panel.gltf", bytes)).toMatchObject({ id: "gltf", by: "content" });
        const meshes = await readMeshFile("gltf", bytes);
        expect(meshes.isOk).toBe(true);
        expect(meshes.value).toHaveLength(1);
        const { min, max } = bounds(meshes.value[0].mesh.position!);
        expect(min.map((v) => Math.round(v))).toEqual([0, 0, 500]);
        expect(max.map((v) => Math.round(v))).toEqual([1000, 1000, 500]);
        expect(Array.from(meshes.value[0].mesh.index!)).toEqual([0, 1, 2, 0, 2, 3]);
    });

    test("GLB is recognized by its magic and reads like glTF", async () => {
        const bytes = glb();
        expect(detectFileFormat("model.bin", bytes)).toMatchObject({ id: "glb", by: "content" });
        const meshes = await readMeshFile("glb", bytes);
        expect(meshes.isOk).toBe(true);
        expect(bounds(meshes.value[0].mesh.position!).max.map((v) => Math.round(v))).toEqual([
            1000, 1000, 500,
        ]);
    });

    test("3MF honors its unit", async () => {
        const zip = new JSZip();
        zip.file(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
        );
        zip.file(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
        );
        zip.file(
            "3D/3dmodel.model",
            '<?xml version="1.0" encoding="UTF-8"?><model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>',
        );
        const bytes = await zip.generateAsync({ type: "uint8array" });
        expect(detectFileFormat("part.zip", bytes)).toMatchObject({ id: "3mf", by: "content" });
        const meshes = await readMeshFile("3mf", bytes);
        expect(meshes.isOk).toBe(true);
        expect(bounds(meshes.value[0].mesh.position!).max.map((v) => Math.round(v * 1000) / 1000)).toEqual([
            25.4, 25.4, 25.4,
        ]);
    });

    test("a file without surfaces is an error", async () => {
        expect((await readMeshFile("obj", text("# nothing\n"))).isOk).toBe(false);
        expect((await readMeshFile("glb", new Uint8Array([1, 2, 3]))).isOk).toBe(false);
    });

    test("the importer adds one MeshNode, or a group named after the file, with a material per color", async () => {
        const document = new TestDocument();
        const single = text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
        const one = await MESH_IMPORTER.import(document, {
            name: "Tri.obj",
            bytes: single,
            format: detectFileFormat("Tri.obj", single),
        });
        expect(one.isOk).toBe(true);
        expect(one.value[0]).toBeInstanceOf(MeshNode);
        expect(one.value[0].name).toBe("Tri");
        const materials = document.modelManager.materials.length;

        const two = await importMeshFile(
            document,
            "Pair",
            "obj",
            text("o a\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\no b\nv 0 0 1\nv 1 0 1\nv 0 1 1\nf 4 5 6\n"),
        );
        expect(two.value[0]).toBeInstanceOf(GroupNode);
        expect(two.value[0].name).toBe("Pair");
        expect(document.modelManager.materials.length).toBe(materials + 1); // both meshes share the default color
    });
});
