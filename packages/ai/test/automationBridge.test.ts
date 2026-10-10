// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
    AutomationHub,
    createAutomationServer,
    createMcpServer,
    LocalBackend,
    PROTOCOL_VERSIONS,
} from "../../../scripts/automation-bridge.mjs";

const TOKEN = "test-token-123";
const ORIGIN = "http://localhost:8080";

interface Reply {
    status: number;
    body: any;
}

function request(
    port: number,
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    let body: unknown = text;
                    try {
                        body = text ? JSON.parse(text) : undefined;
                    } catch {
                        /* not JSON */
                    }
                    resolve({ status: res.statusCode ?? 0, body });
                });
            },
        );
        req.on("error", reject);
        if (init.body !== undefined) req.write(JSON.stringify(init.body));
        req.end();
    });
}

/**
 * The bridge is plain JavaScript; its inferred reply union is too narrow for field-by-field
 * assertions, so the tests read replies as untyped JSON-RPC messages.
 */
function mcpServer(options: { backend: object; send: (message: unknown) => void }): {
    handle(message: unknown): Promise<any>;
    handleLine(line: string): Promise<any>;
} {
    return createMcpServer(options as any);
}

/** A fake browser tab: an SSE connection read by hand, plus the tab's POSTs. */
class FakeTab {
    readonly events: { event: string; data: any }[] = [];
    private waiters: (() => void)[] = [];
    private response?: http.IncomingMessage;
    private req?: http.ClientRequest;
    key = "";

    constructor(
        private readonly port: number,
        readonly session: string,
    ) {}

    connect(origin = ORIGIN): Promise<number> {
        return new Promise((resolve, reject) => {
            this.req = http.get(
                {
                    host: "127.0.0.1",
                    port: this.port,
                    path: `/tab/connect?session=${this.session}`,
                    headers: { Origin: origin, Accept: "text/event-stream" },
                },
                (res) => {
                    this.response = res;
                    let buffer = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk: string) => {
                        buffer += chunk;
                        let end = buffer.indexOf("\n\n");
                        while (end >= 0) {
                            const block = buffer.slice(0, end);
                            buffer = buffer.slice(end + 2);
                            const event = /^event: (.*)$/m.exec(block)?.[1];
                            const data = /^data: (.*)$/m.exec(block)?.[1];
                            if (event && data) {
                                this.events.push({ event, data: JSON.parse(data) });
                                if (event === "hello") this.key = JSON.parse(data).key;
                                this.waiters.splice(0).forEach((wake) => {
                                    wake();
                                });
                            }
                            end = buffer.indexOf("\n\n");
                        }
                    });
                    resolve(res.statusCode ?? 0);
                },
            );
            this.req.on("error", reject);
        });
    }

    async next(event: string): Promise<any> {
        for (;;) {
            const found = this.events.find((e) => e.event === event);
            if (found) {
                this.events.splice(this.events.indexOf(found), 1);
                return found.data;
            }
            await new Promise<void>((resolve) => this.waiters.push(resolve));
        }
    }

    post(path: string, body: Record<string, unknown>, origin = ORIGIN) {
        return request(this.port, path, {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: { session: this.session, key: this.key, ...body },
        });
    }

    close() {
        this.response?.destroy();
        this.req?.destroy();
    }
}

const ECHO_TOOL = {
    name: "echo",
    description: "Echo the args.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

describe("automation bridge: MCP protocol", () => {
    function fakeBackend(tools = [ECHO_TOOL], sessions: unknown[] = [{ id: "tab-1" }]) {
        const listeners = new Set<() => void>();
        const calls: { name: string; args: unknown }[] = [];
        return {
            calls,
            listeners,
            backend: {
                sessions: async () => sessions,
                useSession: async (id: string) =>
                    id === "tab-1" ? undefined : `no connected tab has session "${id}"`,
                tools: async () => tools,
                call: async (name: string, args: unknown) => {
                    calls.push({ name, args });
                    return {
                        content: JSON.stringify({ echoed: args }),
                        images: [{ mediaType: "image/png", data: "iVBORw0K" }],
                        isError: false,
                    };
                },
                onChange: (listener: () => void) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            },
        };
    }

    test("initialize echoes a supported protocol version and offers the newest otherwise", async () => {
        const mcp = mcpServer({ backend: fakeBackend().backend, send: () => {} });

        const known = await mcp.handle({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "t", version: "1" },
            },
        });
        expect(known.result.protocolVersion).toBe("2025-03-26");
        expect(known.result.capabilities).toEqual({ tools: { listChanged: true } });
        expect(known.result.serverInfo.name).toBe("chili3d-automation");

        const unknown = await mcp.handle({
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: { protocolVersion: "1999-01-01" },
        });
        expect(unknown.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    });

    test("tools/list is the tab's tools plus list_sessions and use_session", async () => {
        const mcp = mcpServer({ backend: fakeBackend().backend, send: () => {} });

        const answer = await mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });

        expect(answer.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
            "list_sessions",
            "use_session",
            "echo",
        ]);
    });

    test("tools/call forwards to the tab and returns text then image content", async () => {
        const { backend, calls } = fakeBackend();
        const mcp = mcpServer({ backend, send: () => {} });

        const answer = await mcp.handle({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "echo", arguments: { text: "hi" } },
        });

        expect(calls).toEqual([{ name: "echo", args: { text: "hi" } }]);
        expect(answer.result.isError).toBe(false);
        expect(answer.result.content).toEqual([
            { type: "text", text: JSON.stringify({ echoed: { text: "hi" } }) },
            { type: "image", data: "iVBORw0K", mimeType: "image/png" },
        ]);
    });

    test("use_session reports an unknown session as a tool error", async () => {
        const mcp = mcpServer({ backend: fakeBackend().backend, send: () => {} });

        const answer = await mcp.handle({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: { name: "use_session", arguments: { session: "nope" } },
        });

        expect(answer.result.isError).toBe(true);
        expect(JSON.parse(answer.result.content[0].text).error).toBe('no connected tab has session "nope"');
    });

    test.each([
        ["{not json", -32700],
        [JSON.stringify({ id: 6, method: "tools/list" }), -32600],
        [JSON.stringify({ jsonrpc: "2.0", id: 7, method: "resources/list" }), -32601],
        [JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} }), -32602],
        [
            JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "missing" } }),
            -32602,
        ],
        [JSON.stringify([]), -32600],
    ])("answers %s with JSON-RPC error %i", async (line, code) => {
        const mcp = mcpServer({ backend: fakeBackend().backend, send: () => {} });

        const answer = await mcp.handleLine(line);

        expect(answer.error.code).toBe(code);
        expect(answer.jsonrpc).toBe("2.0");
    });

    test("notifications get no answer, and a batch answers only its requests", async () => {
        const mcp = mcpServer({ backend: fakeBackend().backend, send: () => {} });

        expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
        const batch = await mcp.handle([
            { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
            { jsonrpc: "2.0", id: 10, method: "ping" },
        ]);
        expect(batch).toEqual([{ jsonrpc: "2.0", id: 10, result: {} }]);
    });

    test("sends tools/list_changed once initialized, when the tab's tools change", async () => {
        const { backend, listeners } = fakeBackend();
        let current = [ECHO_TOOL];
        backend.tools = async () => current;
        const sent: unknown[] = [];
        const mcp = mcpServer({ backend, send: (message: unknown) => sent.push(message) });
        await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" });

        current = [ECHO_TOOL, { ...ECHO_TOOL, name: "echo2" }];
        for (const listener of listeners) listener();
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(sent).toEqual([{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }]);
    });
});

describe("automation bridge: routing and security", () => {
    let hub: InstanceType<typeof AutomationHub>;
    let server: http.Server;
    let port: number;
    const tabs: FakeTab[] = [];

    beforeEach(async () => {
        hub = new AutomationHub();
        server = createAutomationServer({ hub, token: TOKEN });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
        tabs.splice(0).forEach((tab) => {
            tab.close();
        });
        hub.close();
        await new Promise((resolve) => server.close(resolve));
    });

    async function connectTab(session = "tab-test") {
        const tab = new FakeTab(port, session);
        tabs.push(tab);
        expect(await tab.connect()).toBe(200);
        await tab.next("hello");
        const registered = await tab.post("/tab/register", {
            info: { url: "http://localhost:8080/", documentName: "Doc 1" },
            tools: [ECHO_TOOL],
        });
        expect(registered.status).toBe(200);
        return tab;
    }

    const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

    test("a caller's /call reaches the tab and the tab's answer comes back", async () => {
        const tab = await connectTab();

        const pending = request(port, "/call", {
            method: "POST",
            headers: auth,
            body: { tool: "echo", args: { n: 1 } },
        });
        const call = await tab.next("call");
        expect(call).toMatchObject({ tool: "echo", args: { n: 1 }, client: "http" });
        const answered = await tab.post("/tab/result", {
            id: call.id,
            result: { content: '{"n":1}', isError: false },
        });
        expect(answered.status).toBe(200);

        const reply = await pending;
        expect(reply.status).toBe(200);
        expect(reply.body).toMatchObject({
            ok: true,
            session: "tab-test",
            content: '{"n":1}',
            isError: false,
        });
    });

    test("an MCP client over the local backend reaches the same tab", async () => {
        const tab = await connectTab();
        const mcp = mcpServer({ backend: new LocalBackend(hub), send: () => {} });

        const pending = mcp.handle({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "echo", arguments: {} },
        });
        const call = await tab.next("call");
        expect(call.client).toBe("mcp");
        await tab.post("/tab/result", {
            id: call.id,
            result: { content: "done", images: [{ mediaType: "image/png", data: "AAAA" }] },
        });

        const answer = await pending;
        expect(answer.result.content).toEqual([
            { type: "text", text: "done" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
        ]);
    });

    test("/sessions and /tools list the registered tab", async () => {
        await connectTab();

        const sessions = await request(port, "/sessions", { headers: auth });
        const tools = await request(port, "/tools", { headers: auth });

        expect(sessions.body.sessions).toEqual([
            expect.objectContaining({ id: "tab-test", documentName: "Doc 1", tools: 1, current: true }),
        ]);
        expect(tools.body).toMatchObject({ ok: true, session: "tab-test", tools: [ECHO_TOOL] });
    });

    test("a call without any tab is an error result, not a hang", async () => {
        const reply = await request(port, "/call", { method: "POST", headers: auth, body: { tool: "echo" } });

        expect(reply.body.isError).toBe(true);
        expect(reply.body.content).toContain("no Chili3d tab is connected");
    });

    test.each([
        ["no token", {}],
        ["a wrong token", { Authorization: "Bearer wrong" }],
    ])("refuses a caller with %s", async (_label, headers) => {
        const reply = await request(port, "/sessions", { headers });

        expect(reply.status).toBe(401);
        expect(reply.body.ok).toBe(false);
    });

    test("refuses browser requests on caller routes even with the token", async () => {
        const reply = await request(port, "/call", {
            method: "POST",
            headers: { ...auth, Origin: ORIGIN },
            body: { tool: "echo" },
        });

        expect(reply.status).toBe(403);
    });

    test("refuses tabs from other origins and requests for another Host", async () => {
        const evil = new FakeTab(port, "tab-evil");
        tabs.push(evil);
        expect(await evil.connect("https://evil.example")).toBe(403);

        const noOrigin = await request(port, "/tab/register", { method: "POST", body: {} });
        expect(noOrigin.status).toBe(403);

        const rebinding = await request(port, "/health", { headers: { Host: `evil.example:${port}` } });
        expect(rebinding.status).toBe(403);
        expect(hub.registeredSessions()).toHaveLength(0);
    });

    test("a tab posting with a wrong key cannot register or answer", async () => {
        const tab = await connectTab();
        tab.key = "forged";

        const reply = await tab.post("/tab/register", { tools: [] });

        expect(reply.status).toBe(404);
        expect(hub.tools()).toEqual([ECHO_TOOL]);
    });

    test("the call times out with an error when the tab never answers", async () => {
        const quiet = new AutomationHub({ callTimeoutMs: 1000 });
        const sent: unknown[] = [];
        const session = quiet.openTab("tab-quiet", {
            send: (_e: string, d: unknown) => sent.push(d),
            close: () => {},
        });
        quiet.register("tab-quiet", session.key, { info: {}, tools: [ECHO_TOOL] });

        const result = await quiet.call("echo", {});

        expect(sent).toHaveLength(2);
        expect(result.isError).toBe(true);
        expect(result.content).toContain("did not answer within 1 s");
    });
});
