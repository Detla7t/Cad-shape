// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { FeatureItem, IDocument, IFeatureListNode, NodeDependencies } from "../src";
import { Node } from "../src/model/node";

/**
 * Stand-ins for Part Studio timeline tests: a node that names what it reads (a sketch) and a
 * feature-list node (a body) with a runtime rollback, both without any kernel.
 */
export class TestStepNode extends Node {
    nodeIds: string[] = [];
    anchors?: Record<string, number>;
    icon = "icon-sketchEdit";

    constructor(document: IDocument, name: string) {
        super(document, name, name);
    }

    protected onVisibleChanged(): void {}
    protected onParentVisibleChanged(): void {}

    dependencies(): NodeDependencies {
        return { nodeIds: this.nodeIds, variables: [], anchors: this.anchors };
    }
}

export interface TestFeature {
    readonly id: string;
    readonly nodeIds?: string[];
    readonly error?: string;
    readonly icon?: string;
}

export class TestFeatureListNode extends Node implements IFeatureListNode {
    rollbackIndex: number | undefined;
    /** Rollback positions the "kernel" cannot rebuild. */
    readonly failing = new Set<number>();

    constructor(
        document: IDocument,
        name: string,
        public features: TestFeature[],
    ) {
        super(document, name, name);
    }

    protected onVisibleChanged(): void {}
    protected onParentVisibleChanged(): void {}

    get featuresJson(): string {
        return JSON.stringify(this.features);
    }

    setRollbackIndex(index: number | undefined): boolean {
        if (index !== undefined && this.failing.has(index)) return false;
        this.rollbackIndex = index;
        this.emitPropertyChanged("featuresJson", this.featuresJson);
        return true;
    }

    featureItems(): readonly FeatureItem[] {
        return this.features.map((feature) => ({
            id: feature.id,
            display: "common.name",
            name: feature.id,
            icon: feature.icon,
            error: feature.error,
            nodeIds: feature.nodeIds,
            parameters: [],
        }));
    }

    setFeatures(features: TestFeature[]): void {
        const old = this.featuresJson;
        this.features = features;
        this.emitPropertyChanged("featuresJson", old);
    }

    setFeatureParameter(): void {}
    setFeatureSuppressed(): void {}
    moveFeature(): void {}
    removeFeature(): void {}
}
