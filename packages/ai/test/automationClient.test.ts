// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { OperationLog } from "@chili3d/core";
import { rs } from "@rstest/core";
import {
    AutomationClient,
    dispatchAutomationCall,
    type EventSourceLike,
} from "../src/automation/automationClient";
import type { Tool } from "../src/llm/types";

function tool(name: string, handler: Tool["handler"]): Tool {
    return { name, description: `${name}.`, parameters: { type: "object", properties: {} }, handler };
}

const lastEvent = () => OperationLog.snapshot().at(-1)!;

describe("dispatchAutomationCall", () => {
    test("runs the tool and records one automation.call event with its source", async () => {
        const handler = rs.fn(async (args: Record<string, unknown>) => JSON.stringify({ got: args["x"] }));

        const result = await dispatchAutomationCall([tool("probe", handler)], {
            id: "c1",
            tool: "probe",
            args: { x: 2 },
            client: "mcp",
        });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ content: '{"got":2}', isError: false });
        const event = lastEvent();
        expect(event.operation).toBe("automation.call");
        expect(event.outcome).toBe("success");
        expect(event.context).toMatchObject({
            tool: "probe",
            callId: "c1",
            source: "automation-bridge",
            client: "mcp",
        });
    });

    test("passes images through and flags an { error } answer as a failure", async () => {
        const images = [{ mediaType: "image/png", data: "AAAA" }];
        const shot = await dispatchAutomationCall([tool("shot", async () => ({ content: "{}", images }))], {
            id: "c2",
            tool: "shot",
            args: {},
        });
        expect(shot.images).toEqual(images);
        expect(shot.isError).toBe(false);

        const failed = await dispatchAutomationCall(
            [tool("bad", async () => JSON.stringify({ error: "no active view" }))],
            { id: "c3", tool: "bad", args: {} },
        );
        expect(failed.isError).toBe(true);
        expect(lastEvent().outcome).toBe("error");
    });

    test("an unknown tool and a throwing handler are error results", async () => {
        const unknown = await dispatchAutomationCall([], { id: "c4", tool: "nope", args: {} });
        expect(unknown.isError).toBe(true);
        expect(JSON.parse(unknown.content).error).toContain('no tool "nope"');

        const thrown = await dispatchAutomationCall(
            [
                tool("boom", async () => {
                    throw new Error("kaput");
                }),
            ],
            { id: "c5", tool: "boom", args: {} },
        );
        expect(JSON.parse(thrown.content).error).toBe("boom failed: kaput");
        expect(lastEvent().error?.message).toBe("kaput");
    });
});

/** An EventSource the test drives: emit() delivers server events, fail() drops the connection. */
class FakeEventSource implements EventSourceLike {
    onerror: ((event: Event) => void) | null = null;
    closed = false;
    private readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();
    constructor(readonly url: string) {}
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    emit(type: string, data: unknown) {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(new MessageEvent(type, { data: JSON.stringify(data) }));
        }
    }
    fail() {
        this.onerror?.(new Event("error"));
    }
    close() {
        this.closed = true;
    }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AutomationClient", () => {
    function setup() {
        const sources: FakeEventSource[] = [];
        const posts: { url: string; body: any }[] = [];
        const fetch = rs.fn(async (url: string | URL | Request, init?: RequestInit) => {
            posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            return new Response("{}", { status: 200 });
        });
        const client = new AutomationClient({
            url: "http://127.0.0.1:7782/",
            sessionId: "tab-unit",
            tools: () => [tool("echo", async (args) => JSON.stringify(args))],
            info: () => ({ documentName: "Doc" }),
            eventSource: (url) => {
                const source = new FakeEventSource(url);
                sources.push(source);
                return source;
            },
            fetch: fetch as unknown as typeof globalThis.fetch,
            backoff: { first: 10, max: 40 },
        });
        return { client, sources, posts };
    }

    test("connects, registers its tools after hello, and answers calls with the key", async () => {
        const { client, sources, posts } = setup();
        client.start();
        expect(sources[0].url).toBe("http://127.0.0.1:7782/tab/connect?session=tab-unit");
        expect(client.state).toBe("connecting");

        sources[0].emit("hello", { session: "tab-unit", key: "k1" });
        await flush();
        expect(client.state).toBe("connected");
        expect(posts[0].url).toBe("http://127.0.0.1:7782/tab/register");
        expect(posts[0].body).toMatchObject({
            session: "tab-unit",
            key: "k1",
            info: { documentName: "Doc" },
        });
        expect(posts[0].body.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);

        sources[0].emit("call", { id: "c9", tool: "echo", args: { a: 1 }, client: "http" });
        await flush();
        await flush();
        expect(posts[1]).toEqual({
            url: "http://127.0.0.1:7782/tab/result",
            body: {
                session: "tab-unit",
                key: "k1",
                id: "c9",
                result: { content: '{"a":1}', isError: false },
            },
        });
        expect(client.lastCall).toMatchObject({ tool: "echo", isError: false });
        client.stop();
    });

    test("reconnects with growing delays after the stream drops, and stops cleanly", () => {
        rs.useFakeTimers();
        try {
            const { client, sources } = setup();
            client.start();
            sources[0].fail();
            expect(sources[0].closed).toBe(true);
            expect(client.state).toBe("connecting");

            rs.advanceTimersByTime(10);
            expect(sources).toHaveLength(2);
            sources[1].fail();
            rs.advanceTimersByTime(19);
            // The second delay doubled to 20 ms.
            expect(sources).toHaveLength(2);
            rs.advanceTimersByTime(1);
            expect(sources).toHaveLength(3);

            client.stop();
            expect(client.state).toBe("off");
            expect(sources[2].closed).toBe(true);
            rs.advanceTimersByTime(1000);
            expect(sources).toHaveLength(3);
        } finally {
            rs.useRealTimers();
        }
    });
});
