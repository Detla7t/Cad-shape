// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Registers the shared `@chili3d/core` mock used by the property tests:
// Localize/Binding/PathBinding/Transaction/ObservableCollection stubs plus a
// no-op PubSub. `isPropertyChanged` is stubbed to false because the real
// implementation loops over prototypes (`while (isPropertyChanged(proto))` in
// property/input.ts); `XY`/`XYZ` are stubbed with same-named classes because
// property/input.ts only uses them as converter-map keys (`XYZ.name`).
// Import this module BEFORE the module under test.

import { rs } from "@rstest/core";

rs.mock("@chili3d/core", () => {
    const actual = rs.hoisted(() => require("@chili3d/core"));
    // The configured-value and configuration helpers are pure; the mid-init snapshot of core
    // can miss them (see `coreMocks.ts`), so they come straight from their modules.
    const configuredValue = rs.hoisted(() => require("../../../core/src/parameters/configuredValue"));
    const configuration = rs.hoisted(() => require("../../../core/src/parameters/configuration"));
    const documentUnits = rs.hoisted(() => require("../../../core/src/parameters/documentUnits"));
    // The shared evaluation vocabulary and its Part Studio adapter (feature-list indicators).
    const evaluationState = rs.hoisted(() => require("../../../core/src/model/evaluationState"));
    const featureEvaluation = rs.hoisted(() => require("../../../core/src/model/featureEvaluation"));
    const {
        LocalizeMock,
        BindingMock,
        PathBindingMock,
        TransactionMock,
        ObservableCollectionMock,
        PubSubMock,
        I18nMock,
    } = rs.hoisted(() => require("./coreMocks"));
    return {
        ...actual,
        ...configuredValue,
        ...configuration,
        ...documentUnits,
        ...evaluationState,
        ...featureEvaluation,
        Localize: LocalizeMock,
        Binding: BindingMock,
        PathBinding: PathBindingMock,
        Transaction: TransactionMock,
        ObservableCollection: ObservableCollectionMock,
        PubSub: PubSubMock,
        I18n: I18nMock,
        isPropertyChanged: () => false,
        XY: class {},
        XYZ: class {},
    };
});
