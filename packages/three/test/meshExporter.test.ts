// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { VisualNode } from "@chili3d/core";
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { ThreeMeshExporter } from "../src/meshExporter";
import { createThreeMockVisualContext } from "./mocks";

describe("ThreeMeshExporter", () => {
    let meshesToDispose: Mesh[] = [];

    afterEach(() => {
        for (const mesh of meshesToDispose) {
            mesh.geometry?.dispose();
            (mesh.material as MeshBasicMaterial)?.dispose();
        }
        meshesToDispose = [];
    });

    test("exportToObj returns a Result", () => {
        const context = createThreeMockVisualContext();
        const exporter = new ThreeMeshExporter(context);

        const result = exporter.exportToObj([]);
        expect(result.isOk).toBe(true);
        expect(typeof result.unchecked()).toBe("string");
    });

    test("exportToStl returns a Result with binary mode", () => {
        const context = createThreeMockVisualContext();
        const exporter = new ThreeMeshExporter(context);

        const result = exporter.exportToStl([], false);
        expect(result.isOk).toBe(true);
    });

    test("exportToStl returns a Result with ascii mode", () => {
        const context = createThreeMockVisualContext();
        const exporter = new ThreeMeshExporter(context);

        const result = exporter.exportToStl([], true);
        expect(result.isOk).toBe(true);
    });

    test("exportToPly returns ok for empty input", () => {
        const context = createThreeMockVisualContext();
        const exporter = new ThreeMeshExporter(context);

        const result = exporter.exportToPly([], false);
        expect(result.isOk).toBe(true);
    });

    test("export includes meshes from visual objects", () => {
        const mockNode = { id: "test-node-1" } as unknown as VisualNode;
        const geo = new BufferGeometry();
        geo.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), 3));
        geo.computeBoundingBox();

        const mesh = new Mesh(geo, new MeshBasicMaterial());
        meshesToDispose.push(mesh);

        const parent = new Group();
        parent.add(mesh);

        const visualMap = new Map<VisualNode, Mesh>();
        visualMap.set(mockNode, parent as any);

        const context = createThreeMockVisualContext(visualMap);
        const exporter = new ThreeMeshExporter(context);

        const result = exporter.exportToObj([mockNode]);
        expect(result.isOk).toBe(true);
        expect(typeof result.unchecked()).toBe("string");
    });

    function createTriangleContext(positions: number[], index?: number[]) {
        const mockNode = { id: "test-node-triangle" } as unknown as VisualNode;
        const geo = new BufferGeometry();
        geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
        if (index) geo.setIndex(index);

        const mesh = new Mesh(geo, new MeshBasicMaterial());
        meshesToDispose.push(mesh);

        const parent = new Group();
        parent.add(mesh);

        const visualMap = new Map<VisualNode, Mesh>();
        visualMap.set(mockNode, parent as any);

        return { mockNode, exporter: new ThreeMeshExporter(createThreeMockVisualContext(visualMap)) };
    }

    test("exportToObj output contains the expected vertex coordinates", () => {
        const { mockNode, exporter } = createTriangleContext([0, 0, 0, 2, 0, 0, 0, 2, 0]);

        const result = exporter.exportToObj([mockNode]);

        expect(result.isOk).toBe(true);
        const obj = result.unchecked() as string;
        expect(obj).toContain("v 0 0 0");
        expect(obj).toContain("v 2 0 0");
        expect(obj).toContain("v 0 2 0");
        expect(obj).toContain("f 1 2 3");
    });

    test("exportToStl ascii output contains the expected vertex coordinates", () => {
        const { mockNode, exporter } = createTriangleContext([0, 0, 0, 2, 0, 0, 0, 2, 0]);

        const result = exporter.exportToStl([mockNode], true);

        expect(result.isOk).toBe(true);
        const stl = result.unchecked() as string;
        expect(stl).toContain("facet normal");
        expect(stl).toContain("vertex 0 0 0");
        expect(stl).toContain("vertex 2 0 0");
        expect(stl).toContain("vertex 0 2 0");
    });

    test("exportToPly returns err when indices are not divisible by 3", () => {
        const { mockNode, exporter } = createTriangleContext([0, 0, 0, 2, 0, 0, 0, 2, 0], [0, 1]);

        const result = exporter.exportToPly([mockNode], true);

        expect(result.isOk).toBe(false);
        expect(result.error).toBe("can not export to ply");
    });

    describe("exportToGltf", () => {
        /** Two model nodes: a red triangle placed at x = 10 and a blue one, each its own visual. */
        function gltfContext() {
            const nodes: VisualNode[] = [];
            const visualMap = new Map<VisualNode, Mesh>();
            for (const [name, color, x] of [
                ["Duct", 0xff0000, 10],
                ["Flange", 0x0000ff, 0],
            ] as const) {
                const node = { id: name, name } as unknown as VisualNode;
                const geometry = new BufferGeometry();
                geometry.setAttribute(
                    "position",
                    new BufferAttribute(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), 3),
                );
                const mesh = new Mesh(geometry, new MeshBasicMaterial({ color }));
                meshesToDispose.push(mesh);
                const parent = new Group();
                parent.position.x = x;
                parent.add(mesh);
                visualMap.set(node, parent as any);
                nodes.push(node);
            }
            return { nodes, exporter: new ThreeMeshExporter(createThreeMockVisualContext(visualMap)) };
        }

        test("writes a GLB: header, JSON chunk with named nodes, colors and placements, binary chunk", async () => {
            const { nodes, exporter } = gltfContext();
            const result = await exporter.exportToGltf(nodes, true);
            expect(result.isOk).toBe(true);
            const buffer = result.value as ArrayBuffer;
            expect(buffer).toBeInstanceOf(ArrayBuffer);

            const view = new DataView(buffer);
            expect(view.getUint32(0, true)).toBe(0x46546c67); // "glTF"
            expect(view.getUint32(4, true)).toBe(2);
            expect(view.getUint32(8, true)).toBe(buffer.byteLength);
            const jsonLength = view.getUint32(12, true);
            expect(view.getUint32(16, true)).toBe(0x4e4f534a); // "JSON"
            const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
            expect(view.getUint32(20 + jsonLength + 4, true)).toBe(0x004e4942); // "BIN"

            expect(json.asset.version).toBe("2.0");
            const names = json.nodes.map((node: { name: string }) => node.name);
            expect(names).toEqual(["Chili3D", "Duct", "Flange"]);
            // The root turns Z-up millimetres into glTF's Y-up metres.
            const root = json.nodes[0];
            expect(root.children).toEqual([1, 2]);
            expect(root.matrix[0]).toBeCloseTo(0.001, 9);
            expect(root.matrix[6]).toBeCloseTo(-0.001, 9);
            expect(json.nodes[1].matrix[12]).toBe(10);
            expect(json.nodes[2].matrix).toBeUndefined();
            const colors = json.nodes
                .slice(1)
                .map(
                    (node: { mesh: number }) => json.materials[json.meshes[node.mesh].primitives[0].material],
                )
                .map(
                    (material: { pbrMetallicRoughness: { baseColorFactor: number[] } }) =>
                        material.pbrMetallicRoughness.baseColorFactor,
                );
            expect(colors).toEqual([
                [1, 0, 0, 1],
                [0, 0, 1, 1],
            ]);
            expect(json.accessors[json.meshes[0].primitives[0].attributes.POSITION].count).toBe(3);
        });

        test("writes .gltf JSON with the buffers embedded", async () => {
            const { nodes, exporter } = gltfContext();
            const result = await exporter.exportToGltf(nodes, false);
            expect(result.isOk).toBe(true);
            const json = JSON.parse(result.value as string);
            expect(json.nodes.map((node: { name: string }) => node.name)).toEqual([
                "Chili3D",
                "Duct",
                "Flange",
            ]);
            expect(json.buffers[0].uri).toMatch(/^data:application\/octet-stream;base64,/);
        });

        test("exports a body that is also a node list (a parametric body) from its own visual", async () => {
            // A parametric body lists the consumed tools it hides as children; its geometry is its own.
            // Own data properties: the class's `name` accessor would need a document.
            const body = Object.create(VisualNode.prototype, {
                id: { value: "body" },
                name: { value: "Parametric Body1" },
                firstChild: { value: undefined },
                add: { value: () => {} },
            }) as VisualNode;
            const geometry = new BufferGeometry();
            geometry.setAttribute(
                "position",
                new BufferAttribute(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), 3),
            );
            const mesh = new Mesh(geometry, new MeshBasicMaterial({ color: 0x00ff00 }));
            meshesToDispose.push(mesh);
            const exporter = new ThreeMeshExporter(
                createThreeMockVisualContext(new Map([[body, mesh as any]])),
            );
            const result = await exporter.exportToGltf([body], false);
            expect(result.isOk).toBe(true);
            const json = JSON.parse(result.value as string);
            expect(json.nodes.map((node: { name: string }) => node.name)).toEqual([
                "Chili3D",
                "Parametric Body1",
            ]);
            expect(json.meshes).toHaveLength(1);
        });
    });
});
