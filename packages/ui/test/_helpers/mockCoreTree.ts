// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Registers the `@chili3d/core` mock for the tree test: marker classes for
// instanceof checks, immediate Transaction, no-op Binding, NodeUtils stubs.
// Lives in a helper module instead of inline in the test file so the test can
// import `@chili3d/core/test-utils` FIRST — inline `rs.mock` calls are hoisted
// above the imports and would feed test-utils a half-initialized core namespace.
// Import this module BEFORE the module under test (but AFTER the test-utils import).

import { rs } from "@rstest/core";

import type { PubSubRecorder } from "./coreMocks";

const pubSubRecorder = rs.hoisted((): PubSubRecorder => {
    const { createPubSubRecorder } = require("./coreMocks");
    return createPubSubRecorder();
});

/** PubSub publications recorded through the mocked core. */
export function getPubSubPubs() {
    return pubSubRecorder.pubs;
}

rs.mock("@chili3d/core", () => {
    const actual = rs.hoisted(() => require("@chili3d/core"));
    const { setHistoryHidden } = rs.hoisted(() => require("../../../core/src/model/historyPreview"));
    // The shared evaluation vocabulary, its Part Studio adapter and the ShapeNode class the
    // tree's indicator checks: the partial `actual` snapshot can miss them.
    const evaluationState = rs.hoisted(() => require("../../../core/src/model/evaluationState"));
    const featureEvaluation = rs.hoisted(() => require("../../../core/src/model/featureEvaluation"));
    const { ShapeNode } = rs.hoisted(() => require("../../../core/src/model/shapeNode"));
    const {
        BindingMock,
        TransactionMock,
        I18nMock,
        isFeatureListNodeMock,
        isNodeIconMock,
        isNodeScenelessMock,
        isNodeWarningMock,
    } = rs.hoisted(() => require("./coreMocks"));
    class VisualNode {}
    class ReferencePlaneNode extends VisualNode {}
    class Annotation {}
    class NodeSelectionHandler {}
    class ShapeSelectionHandler {
        constructor(readonly shapeType: unknown) {}
    }
    // Marker class for tree.ts's folder checks: parametric bodies are linked-list
    // nodes too, but only folders accept drops and become the current node.
    class FolderNode {
        static [Symbol.hasInstance](node: { isFolder?: boolean }) {
            return node?.isFolder === true;
        }
    }
    return {
        ...actual,
        Binding: BindingMock,
        Transaction: TransactionMock,
        ...evaluationState,
        ...featureEvaluation,
        ShapeNode,
        // The hoisted `actual` snapshots core mid-initialization, so PubSub must be stubbed.
        PubSub: pubSubRecorder.stub,
        I18n: I18nMock,
        isFeatureListNode: isFeatureListNodeMock,
        isNodeIcon: isNodeIconMock,
        isNodeSceneless: isNodeScenelessMock,
        isNodeWarning: isNodeWarningMock,
        VisualNode,
        ReferencePlaneNode,
        Annotation,
        FolderNode,
        NodeSelectionHandler,
        ShapeSelectionHandler,
        setHistoryHidden,
        // a node flagged `hiddenInTree` stands for a file element (a drawing, an attached document)
        DocumentElements: {
            hiddenInTree: (node: { hiddenInTree?: boolean }) => node?.hiddenInTree === true,
            kindOf: () => undefined,
        },
        NodeUtils: {
            isLinkedListNode: (node: { isGroup?: boolean }) => node.isGroup === true,
            getNodesBetween: () => [],
            findTopLevelNodes: (nodes: unknown[]) => Array.from(nodes),
            containsDescendant: () => false,
        },
    };
});
