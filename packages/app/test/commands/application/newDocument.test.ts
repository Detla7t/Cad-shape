// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub } from "@chili3d/core";
import { createMockApplication } from "@chili3d/core/test-utils";
import { describe, expect, test } from "@rstest/core";
import { NewDocument } from "../../../src/commands/application/newDocument";

describe("NewDocument", () => {
    test("should have command metadata", () => {
        const data = (NewDocument as any).prototype.data;
        expect(data).not.toBeNull();
        expect(data.key).toBe("doc.new");
        expect(data.icon).toBe("icon-new");
    });

    test("should have isApplicationCommand flag", () => {
        const data = (NewDocument as any).prototype.data;
        expect(data.isApplicationCommand).toBe(true);
    });

    test("requests the new document form without creating an unconfigured document", async () => {
        const app = createMockApplication();
        let requested = 0;
        let created = 0;
        app.newDocument = async () => {
            created++;
            return {} as any;
        };
        const onRequest = () => {
            requested++;
        };
        PubSub.default.sub("openNewDocument", onRequest);
        try {
            await new NewDocument().execute(app);
            expect(requested).toBe(1);
            expect(created).toBe(0);
        } finally {
            PubSub.default.remove("openNewDocument", onRequest);
        }
    });
});
