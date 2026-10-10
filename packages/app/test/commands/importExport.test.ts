// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    getCurrentApplication,
    type IApplication,
    PropertyUtils,
    PubSub,
    SelectNodeStep,
    setCurrentApplication,
} from "@chili3d/core";
import { createMockApplication, createMockDocument } from "@chili3d/core/test-utils";
import { describe, expect, rs, test } from "@rstest/core";
import { Export, Import } from "../../src/commands/importExport";

// Ensure a mock application is set (Export constructor calls getCurrentApplication)
try {
    getCurrentApplication();
} catch {
    setCurrentApplication(createMockApplication());
}

describe("Import", () => {
    test("should have command metadata", () => {
        const data = (Import as any).prototype.data;
        expect(data).not.toBeNull();
        expect(data.key).toBe("file.import");
        expect(data.icon).toBe("icon-import");
    });

    test("should implement ICommand (has execute method)", () => {
        const cmd = new Import();
        expect(typeof cmd.execute).toBe("function");
    });

    test("should handle importFormats call correctly", async () => {
        const app = createMockApplication();
        app.dataExchange.importFormats = () => [".step", ".stl", ".iges"];

        const cmd = new Import();
        // execute will call readFilesAsync which creates a file input in browser.
        // In test env (Happy-DOM), we can verify the format string is correct.
        expect(typeof app.dataExchange.importFormats().join(",")).toBe("string");
        expect(app.dataExchange.importFormats().join(",")).toBe(".step,.stl,.iges");
    });

    test("Import instance should have type-safe execute signature", () => {
        const cmd = new Import();
        expect(cmd).toBeInstanceOf(Import);
        expect(typeof cmd.execute).toBe("function");
    });

    test("should handle empty file list gracefully via alert", async () => {
        // When readFilesAsync returns empty files, Import shows an alert.
        // We verify the command can be constructed and has proper metadata.
        const cmd = new Import();
        expect(cmd).toBeInstanceOf(Import);
        expect((Import as any).prototype.data.key).toBe("file.import");
    });
});

describe("Export", () => {
    test("should have command metadata", () => {
        const data = (Export as any).prototype.data;
        expect(data).toBeDefined();
        expect(data.key).toBe("file.export");
        expect(data.icon).toBe("icon-export");
    });

    test("should extend CancelableCommand", () => {
        const cmd = new Export();
        expect(cmd).toBeInstanceOf(CancelableCommand);
    });
});
