#!/usr/bin/env node
// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Chili3d's automation bridge: lets Claude Code (or a shell) drive a running Chili3d browser tab
 * with the same tool registry the in-app assistant uses (`packages/ai/src/tools`). It is two
 * things in one process:
 *
 *   (a) an MCP server over stdio (JSON-RPC 2.0: initialize, ping, tools/list, tools/call,
 *       notifications/tools/list_changed). Its tools are the connected tab's tools plus
 *       `list_sessions` and `use_session`.
 *   (b) a local HTTP endpoint on 127.0.0.1 that tabs connect OUT to (Server-Sent Events down,
 *       fetch up) and that a shell can call with the per-run token:
 *
 *         GET  /health                         → { ok, automation: true, sessions }   (no token)
 *         GET  /sessions                       → { revision, sessions: [...] }        (token)
 *         GET  /tools?session=<id>             → { session, tools: [...] }            (token)
 *         POST /call { tool, args, session?, timeoutMs? }
 *                                              → { ok, session, content, images, isError } (token)
 *
 *       Tabs (browser origins only): GET /tab/connect?session=<id> (SSE: `hello`, `call`),
 *       POST /tab/register { session, key, info, tools }, POST /tab/result { session, key, id, result }.
 *
 *   node scripts/automation-bridge.mjs          MCP over stdio + the HTTP listener (what .mcp.json runs)
 *   node scripts/automation-bridge.mjs --http   the HTTP listener only (npm run automation)
 *        [--port 7782] [--origin https://your.chili3d.host]... [--timeout 120]
 *
 * Security: listens on 127.0.0.1 only and checks the Host header (no DNS rebinding). Tab routes
 * accept only the app's browser origins (localhost / 127.0.0.1 on 8080, 8081 and the 8096
 * preview, plus --origin / CHILI3D_ORIGINS). Caller routes (/sessions, /tools, /call) need the
 * per-run token (`Authorization: Bearer <token>` or `X-Chili3d-Token`) and refuse any request
 * that carries an Origin header, so no web page can call them. The token is printed and written
 * to `chili3d-automation-<port>.json` in $XDG_RUNTIME_DIR (or the OS temp directory), mode 0600.
 * Tools run only in tabs whose user enabled automation (Preferences ▸ Automation or ?automation=1).
 *
 * When another bridge already owns the port, an MCP instance becomes a client of it (reading the
 * token file), so several Claude sessions share one bridge; it takes the port over if that
 * owner goes away.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

export const DEFAULT_PORT = 7782;
export const DEFAULT_ORIGINS = [8080, 8081, 8096].flatMap((port) => [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
]);
/** Newest first: the version answered when a client asks for one this server does not know. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = {
    name: "chili3d-automation",
    title: "Chili3d automation bridge",
    version: "1.0.0",
};

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const MAX_CALL_TIMEOUT_MS = 600_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

const INSTRUCTIONS = [
    "Drives the user's running Chili3d tab (browser CAD). Every tool runs in the tab, through the",
    "same code paths as the user's own input, and is recorded in the tab's OperationLog.",
    "Start with list_sessions (a tab connects when the user opens Chili3d with ?automation=1 or",
    "enables Preferences ▸ Automation). Then get_app_state, ui_snapshot and capture_screenshot show",
    "where things are; execute_command, view_pointer, ui_click/ui_type and press_key act; wait_for",
    "and get_operation_log verify the outcome. Units are millimetres and degrees.",
].join(" ");

// ---------------------------------------------------------------------------------------------
// Token file

/** Where the per-run token of the bridge on `port` is written. */
export function tokenFilePath(port, env = process.env) {
    const dir = env.XDG_RUNTIME_DIR && fs.existsSync(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : os.tmpdir();
    return path.join(dir, `chili3d-automation-${port}.json`);
}

export function writeTokenFile(file, data) {
    fs.writeFileSync(file, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
}

export function readTokenFile(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        return typeof data?.token === "string" ? data : undefined;
    } catch {
        return undefined;
    }
}

const sameSecret = (a, b) => {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------------------------------------------------------------------------------------
// Hub: sessions (tabs) and call routing

const asText = (value, max = 500) => (typeof value === "string" ? value.slice(0, max) : undefined);

function normalizeTool(tool) {
    if (typeof tool?.name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(tool.name)) return undefined;
    const schema = tool.inputSchema ?? tool.parameters;
    return {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema:
            typeof schema === "object" && schema !== null && !Array.isArray(schema)
                ? { type: "object", ...schema }
                : { type: "object", properties: {} },
    };
}

/** A tab's answer in the one shape every caller gets: text, images, and whether it failed. */
export function normalizeResult(result) {
    if (typeof result === "string") return { content: result, images: [], isError: false };
    const content = typeof result?.content === "string" ? result.content : JSON.stringify(result ?? null);
    const images = Array.isArray(result?.images)
        ? result.images
              .filter((image) => typeof image?.data === "string")
              .map((image) => ({
                  mediaType: typeof image.mediaType === "string" ? image.mediaType : "image/png",
                  data: image.data,
              }))
        : [];
    return { content, images, isError: result?.isError === true };
}

const failure = (message) => ({ content: JSON.stringify({ error: message }), images: [], isError: true });

export class AutomationHub {
    /** @param {{ callTimeoutMs?: number, log?: (...args: unknown[]) => void }} [options] */
    constructor({ callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS, log = () => {} } = {}) {
        this.callTimeoutMs = callTimeoutMs;
        this.log = log;
        /** @type {Map<string, any>} */
        this.sessions = new Map();
        this.revision = 0;
        this.listeners = new Set();
        this.nextCall = 1;
    }

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    changed() {
        this.revision++;
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log("change listener failed:", error);
            }
        }
    }

    /** A tab opened its event stream: replaces an earlier stream of the same session (a reload). */
    openTab(id, stream) {
        const previous = this.sessions.get(id);
        if (previous) this.dropSession(previous, "the tab reconnected");
        const session = {
            id,
            key: crypto.randomBytes(18).toString("base64url"),
            stream,
            info: {},
            tools: [],
            registered: false,
            connectedAt: Date.now(),
            lastCallAt: undefined,
            pending: new Map(),
        };
        this.sessions.set(id, session);
        stream.send("hello", { session: id, key: session.key });
        return session;
    }

    /** The stream of `id` ended. Only the stream that is current closes the session. */
    closeTab(id, key) {
        const session = this.sessions.get(id);
        if (!session || session.key !== key) return false;
        this.dropSession(session, "the tab disconnected");
        return true;
    }

    dropSession(session, reason) {
        this.sessions.delete(session.id);
        for (const [, call] of session.pending) {
            clearTimeout(call.timer);
            call.resolve(failure(`${reason} before answering ${call.tool}`));
        }
        session.pending.clear();
        session.stream.close();
        if (session.registered) {
            this.log(`tab ${session.id} left (${reason})`);
            this.changed();
        }
    }

    authorized(id, key) {
        const session = this.sessions.get(id);
        return session && sameSecret(session.key, key) ? session : undefined;
    }

    register(id, key, { info, tools } = {}) {
        const session = this.authorized(id, key);
        if (!session) return false;
        session.info = {
            url: asText(info?.url, 2000),
            title: asText(info?.title),
            documentName: asText(info?.documentName),
            documentId: asText(info?.documentId),
            appVersion: asText(info?.appVersion, 50),
        };
        session.tools = (Array.isArray(tools) ? tools : []).map(normalizeTool).filter(Boolean);
        const first = !session.registered;
        session.registered = true;
        if (first)
            this.log(`tab ${id} connected: ${session.info.url ?? "?"} (${session.tools.length} tools)`);
        this.changed();
        return true;
    }

    resolveResult(id, key, callId, result) {
        const session = this.authorized(id, key);
        const call = session?.pending.get(callId);
        if (!call) return false;
        session.pending.delete(callId);
        clearTimeout(call.timer);
        call.resolve(normalizeResult(result));
        return true;
    }

    registeredSessions() {
        return [...this.sessions.values()].filter((session) => session.registered);
    }

    /** The session used when a caller names none: the most recently connected tab. */
    defaultSession() {
        return this.registeredSessions().sort((a, b) => b.connectedAt - a.connectedAt)[0];
    }

    /** The session `id`, or the default one; a string says why there is none. */
    pick(id) {
        if (id !== undefined && id !== null && id !== "") {
            return this.sessions.get(String(id))?.registered
                ? this.sessions.get(String(id))
                : `no connected Chili3d tab has session "${id}" — see list_sessions`;
        }
        return (
            this.defaultSession() ??
            "no Chili3d tab is connected: open the app with ?automation=1 (or turn on Preferences ▸ Automation) while the bridge runs"
        );
    }

    list(current) {
        const fallback = this.defaultSession()?.id;
        return this.registeredSessions().map((session) => ({
            id: session.id,
            ...session.info,
            tools: session.tools.length,
            connectedAt: new Date(session.connectedAt).toISOString(),
            lastCallAt: session.lastCallAt ? new Date(session.lastCallAt).toISOString() : undefined,
            current: session.id === (current ?? fallback),
        }));
    }

    tools(id) {
        const session = this.pick(id);
        return typeof session === "string" ? [] : session.tools;
    }

    /**
     * Runs `tool` in a tab and resolves with its normalized result; never rejects — an
     * unreachable tab or a timeout is an error result.
     */
    call(tool, args, { session: id, timeoutMs, client } = {}) {
        const session = this.pick(id);
        if (typeof session === "string") return Promise.resolve(failure(session));
        if (!session.tools.some((t) => t.name === tool)) {
            return Promise.resolve(
                failure(`the tab has no tool "${tool}" (tools/list, or GET /tools, lists what it offers)`),
            );
        }
        const limit = Math.min(
            MAX_CALL_TIMEOUT_MS,
            Math.max(1000, Number(timeoutMs) || 0, this.callTimeoutMs, waitBudget(args)),
        );
        const callId = `c${this.nextCall++}`;
        session.lastCallAt = Date.now();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                session.pending.delete(callId);
                resolve(failure(`${tool} did not answer within ${Math.round(limit / 1000)} s`));
            }, limit);
            session.pending.set(callId, { tool, resolve, timer });
            session.stream.send("call", { id: callId, tool, args: args ?? {}, client: client ?? "bridge" });
        });
    }

    close() {
        for (const session of [...this.sessions.values()]) this.dropSession(session, "the bridge stopped");
    }
}

/** A tool that waits by itself (wait_for, timeoutMs arguments) gets that long plus a margin. */
function waitBudget(args) {
    const value = Number(args?.timeoutMs);
    return Number.isFinite(value) && value > 0 ? value + 5000 : 0;
}

// ---------------------------------------------------------------------------------------------
// HTTP server

function readBody(request, maxBytes) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxBytes) tooLarge = true;
            else chunks.push(chunk);
        });
        request.on("end", () => {
            if (tooLarge) return resolve({ status: 413, error: "the request is too large" });
            try {
                const text = Buffer.concat(chunks).toString("utf8");
                const body = text.trim() === "" ? {} : JSON.parse(text);
                if (typeof body !== "object" || body === null || Array.isArray(body))
                    return resolve({ status: 400, error: "expected a JSON object" });
                resolve({ body });
            } catch {
                resolve({ status: 400, error: "the body is not JSON" });
            }
        });
        request.on("error", (error) => resolve({ status: 400, error: error.message }));
    });
}

/**
 * The bridge's HTTP server (not yet listening).
 * @param {{ hub: AutomationHub, token: string, origins?: string[], log?: (...args: unknown[]) => void,
 *           maxBodyBytes?: number }} options
 */
export function createAutomationServer({
    hub,
    token,
    origins = [],
    log = () => {},
    maxBodyBytes = MAX_BODY_BYTES,
}) {
    const allowed = new Set([...DEFAULT_ORIGINS, ...origins]);
    const allowAny = allowed.has("*");
    let server;

    const send = (response, status, body, headers = {}) => {
        response.writeHead(status, {
            ...headers,
            "Cache-Control": "no-store",
            ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
        });
        response.end(body === undefined ? "" : JSON.stringify(body));
    };

    const hostAllowed = (host) => {
        const port = server?.address()?.port;
        return (
            typeof host === "string" &&
            [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase())
        );
    };

    const corsFor = (request) => {
        const origin = request.headers.origin;
        const cors = {
            Vary: "Origin",
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "600",
        };
        if (request.headers["access-control-request-private-network"] === "true")
            cors["Access-Control-Allow-Private-Network"] = "true";
        return cors;
    };

    const callerAuthorized = (request) => {
        const header = request.headers.authorization;
        const bearer =
            typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
        return sameSecret(bearer ?? request.headers["x-chili3d-token"], token);
    };

    const tabConnect = (request, response, url, cors) => {
        const id = url.searchParams.get("session") ?? "";
        if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) {
            send(response, 400, { ok: false, error: "expected ?session=<id>" }, cors);
            return;
        }
        response.writeHead(200, {
            ...cors,
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        response.write(": chili3d automation bridge\n\n");
        let open = true;
        const stream = {
            send(event, data) {
                if (open) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            },
            close() {
                if (!open) return;
                open = false;
                clearInterval(heartbeat);
                response.end();
            },
        };
        const heartbeat = setInterval(() => {
            if (open) response.write(": ping\n\n");
        }, HEARTBEAT_MS);
        heartbeat.unref?.();
        const session = hub.openTab(id, stream);
        request.on("close", () => {
            open = false;
            clearInterval(heartbeat);
            hub.closeTab(id, session.key);
        });
    };

    const tabPost = async (request, response, pathname, cors) => {
        const { body, status, error } = await readBody(request, maxBodyBytes);
        if (!body) return send(response, status, { ok: false, error }, cors);
        const ok =
            pathname === "/tab/register"
                ? hub.register(String(body.session), String(body.key), body)
                : hub.resolveResult(String(body.session), String(body.key), String(body.id), body.result);
        send(response, ok ? 200 : 404, ok ? { ok } : { ok, error: "unknown session, key or call" }, cors);
    };

    const caller = async (request, response, url) => {
        if (request.headers.origin !== undefined) {
            send(response, 403, { ok: false, error: "browser requests are not accepted on this route" });
            return;
        }
        if (!callerAuthorized(request)) {
            send(response, 401, {
                ok: false,
                error: "missing or wrong token (Authorization: Bearer <token>; the bridge prints it and writes it to its token file)",
            });
            return;
        }
        if (request.method === "GET" && url.pathname === "/sessions") {
            send(response, 200, { ok: true, revision: hub.revision, sessions: hub.list() });
        } else if (request.method === "GET" && url.pathname === "/tools") {
            const session = hub.pick(url.searchParams.get("session") ?? undefined);
            if (typeof session === "string") return send(response, 404, { ok: false, error: session });
            send(response, 200, { ok: true, session: session.id, tools: session.tools });
        } else if (request.method === "POST" && url.pathname === "/call") {
            const { body, status, error } = await readBody(request, maxBodyBytes);
            if (!body) return send(response, status, { ok: false, error });
            if (typeof body.tool !== "string") {
                return send(response, 400, {
                    ok: false,
                    error: 'expected { tool: "name", args?: {}, session? }',
                });
            }
            if (body.tool === "list_sessions") {
                const content = JSON.stringify({ sessions: hub.list() });
                return send(response, 200, { ok: true, content, images: [], isError: false });
            }
            const picked = hub.pick(body.session);
            const result = await hub.call(body.tool, body.args ?? {}, {
                session: body.session,
                timeoutMs: body.timeoutMs,
                client: "http",
            });
            send(response, 200, {
                ok: !result.isError,
                session: typeof picked === "string" ? undefined : picked.id,
                ...result,
            });
        } else {
            send(response, 404, { ok: false, error: `no ${request.method} ${url.pathname}` });
        }
    };

    server = http.createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        try {
            if (!hostAllowed(request.headers.host)) {
                send(response, 403, { ok: false, error: "unexpected Host header" });
                return;
            }
            const origin = request.headers.origin;
            if (url.pathname === "/health" && request.method === "GET") {
                const cors =
                    origin !== undefined && (allowAny || allowed.has(origin)) ? corsFor(request) : {};
                send(
                    response,
                    200,
                    {
                        ok: true,
                        automation: true,
                        name: SERVER_INFO.name,
                        version: SERVER_INFO.version,
                        sessions: hub.registeredSessions().length,
                    },
                    cors,
                );
                return;
            }
            if (url.pathname.startsWith("/tab/")) {
                if (origin === undefined || !(allowAny || allowed.has(origin))) {
                    send(response, 403, {
                        ok: false,
                        error: `origin ${origin ?? "(none)"} is not allowed (start the bridge with --origin ${origin ?? "<origin>"})`,
                    });
                    return;
                }
                const cors = corsFor(request);
                if (request.method === "OPTIONS") send(response, 204, undefined, cors);
                else if (request.method === "GET" && url.pathname === "/tab/connect")
                    tabConnect(request, response, url, cors);
                else if (
                    request.method === "POST" &&
                    (url.pathname === "/tab/register" || url.pathname === "/tab/result")
                )
                    await tabPost(request, response, url.pathname, cors);
                else send(response, 404, { ok: false, error: `no ${request.method} ${url.pathname}` }, cors);
                return;
            }
            await caller(request, response, url);
        } catch (error) {
            log("request failed:", error);
            if (!response.headersSent)
                send(response, 500, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            else response.end();
        }
    });
    return server;
}

// ---------------------------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 over stdio)

const META_TOOLS = [
    {
        name: "list_sessions",
        description:
            "List the Chili3d browser tabs connected to the bridge (session id, URL, document, tool count) and which one tool calls go to.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "use_session",
        description: "Send the following tool calls to the tab with this session id (see list_sessions).",
        inputSchema: {
            type: "object",
            properties: { session: { type: "string", description: "Session id from list_sessions" } },
            required: ["session"],
        },
    },
];

const rpcError = (id, code, message, data) => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
});

/** A tab's result as MCP content: its text, then its images. */
export function toMcpContent(result) {
    return {
        content: [
            { type: "text", text: result.content },
            ...result.images.map((image) => ({ type: "image", data: image.data, mimeType: image.mediaType })),
        ],
        isError: result.isError === true,
    };
}

/** Routes calls to this process's hub, remembering which tab this MCP client chose. */
export class LocalBackend {
    constructor(hub) {
        this.hub = hub;
        this.current = undefined;
    }
    effectiveSession() {
        return this.current && this.hub.sessions.get(this.current)?.registered ? this.current : undefined;
    }
    async sessions() {
        return this.hub.list(this.effectiveSession());
    }
    async useSession(id) {
        if (!this.hub.sessions.get(id)?.registered) return `no connected tab has session "${id}"`;
        this.current = id;
        return undefined;
    }
    async tools() {
        return this.hub.tools(this.effectiveSession());
    }
    call(name, args) {
        return this.hub.call(name, args, { session: this.effectiveSession(), client: "mcp" });
    }
    onChange(listener) {
        return this.hub.onChange(listener);
    }
    close() {}
}

/** Routes calls to the bridge that owns the port, over its authenticated HTTP endpoint. */
export class RemoteBackend {
    constructor({ baseUrl, tokenFile, pollMs = 2000, onLost }) {
        this.baseUrl = baseUrl;
        this.tokenFile = tokenFile;
        this.current = undefined;
        this.listeners = new Set();
        this.revision = undefined;
        this.failures = 0;
        this.onLost = onLost;
        this.timer = setInterval(() => void this.poll(), pollMs);
        this.timer.unref?.();
    }
    token() {
        return readTokenFile(this.tokenFile)?.token ?? "";
    }
    async request(method, pathname, body) {
        const response = await fetch(`${this.baseUrl}${pathname}`, {
            method,
            headers: { Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = await response.json().catch(() => ({ ok: false, error: `answered ${response.status}` }));
        if (response.status === 401) throw new Error(json.error ?? "the bridge refused the token");
        return json;
    }
    async poll() {
        try {
            const { revision } = await this.request("GET", "/sessions");
            this.failures = 0;
            if (revision !== this.revision) {
                this.revision = revision;
                for (const listener of [...this.listeners]) listener();
            }
        } catch {
            if (++this.failures >= 2) this.onLost?.();
        }
    }
    async sessions() {
        const { sessions = [] } = await this.request("GET", "/sessions");
        const current = sessions.some((s) => s.id === this.current) ? this.current : undefined;
        if (current === undefined) return sessions;
        return sessions.map((s) => ({ ...s, current: s.id === current }));
    }
    async useSession(id) {
        const sessions = await this.sessions();
        if (!sessions.some((s) => s.id === id)) return `no connected tab has session "${id}"`;
        this.current = id;
        return undefined;
    }
    async tools() {
        const query = this.current ? `?session=${encodeURIComponent(this.current)}` : "";
        const answer = await this.request("GET", `/tools${query}`);
        return answer.ok ? answer.tools : [];
    }
    async call(name, args) {
        try {
            const answer = await this.request("POST", "/call", { tool: name, args, session: this.current });
            return normalizeResult(answer);
        } catch (error) {
            return failure(`the bridge that owns the port did not answer: ${error.message}`);
        }
    }
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    close() {
        clearInterval(this.timer);
    }
}

/**
 * The MCP protocol layer. `send` writes one JSON-RPC message (used for notifications);
 * `handle` answers one parsed message (or a batch) and returns the response, if any.
 */
export function createMcpServer({ backend, send, log = () => {} }) {
    let current = backend;
    let initialized = false;
    let toolKey = "";
    let unsubscribe = current.onChange(() => void notifyIfChanged());

    const keyOf = (tools) => tools.map((tool) => `${tool.name}:${tool.description.length}`).join("|");

    async function listTools() {
        const tools = await current.tools().catch(() => []);
        return [
            ...META_TOOLS,
            ...tools.filter((tool) => !META_TOOLS.some((meta) => meta.name === tool.name)),
        ];
    }

    async function notifyIfChanged() {
        const key = keyOf(await listTools());
        if (key === toolKey) return;
        toolKey = key;
        if (initialized) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }

    async function callTool(name, args) {
        if (name === "list_sessions") {
            const sessions = await current.sessions().catch((error) => ({ error: error.message }));
            return toMcpContent(normalizeResult(JSON.stringify({ sessions })));
        }
        if (name === "use_session") {
            const problem = await current.useSession(String(args?.session ?? ""));
            if (problem) return toMcpContent(failure(problem));
            void notifyIfChanged();
            return toMcpContent(normalizeResult(JSON.stringify({ ok: true, session: args.session })));
        }
        return toMcpContent(await current.call(name, args ?? {}));
    }

    async function handleOne(message) {
        if (typeof message !== "object" || message === null || Array.isArray(message)) {
            return rpcError(null, -32600, "Invalid Request");
        }
        const { id, method, params } = message;
        const isNotification = !("id" in message);
        if (message.jsonrpc !== "2.0" || typeof method !== "string") {
            return isNotification && message.jsonrpc === "2.0"
                ? undefined
                : rpcError(id, -32600, "Invalid Request");
        }
        if (isNotification) {
            if (method === "notifications/initialized") {
                initialized = true;
                toolKey = keyOf(await listTools());
            }
            return undefined;
        }
        try {
            switch (method) {
                case "initialize": {
                    const requested = params?.protocolVersion;
                    const protocolVersion = PROTOCOL_VERSIONS.includes(requested)
                        ? requested
                        : PROTOCOL_VERSIONS[0];
                    return {
                        jsonrpc: "2.0",
                        id,
                        result: {
                            protocolVersion,
                            capabilities: { tools: { listChanged: true } },
                            serverInfo: SERVER_INFO,
                            instructions: INSTRUCTIONS,
                        },
                    };
                }
                case "ping":
                    return { jsonrpc: "2.0", id, result: {} };
                case "tools/list":
                    return { jsonrpc: "2.0", id, result: { tools: await listTools() } };
                case "tools/call": {
                    if (typeof params?.name !== "string") return rpcError(id, -32602, "Invalid params: name");
                    if (
                        params.arguments !== undefined &&
                        (typeof params.arguments !== "object" || params.arguments === null)
                    )
                        return rpcError(id, -32602, "Invalid params: arguments must be an object");
                    const known = (await listTools()).some((tool) => tool.name === params.name);
                    const anyTab = (await current.sessions().catch(() => [])).length > 0;
                    if (!known && anyTab) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
                    return { jsonrpc: "2.0", id, result: await callTool(params.name, params.arguments) };
                }
                default:
                    return rpcError(id, -32601, `Method not found: ${method}`);
            }
        } catch (error) {
            log("request failed:", error);
            return rpcError(id, -32603, error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * @param {unknown} message
     * @returns {Promise<any>} the JSON-RPC response (an array for a batch), or undefined for notifications
     */
    async function handle(message) {
        if (Array.isArray(message)) {
            if (message.length === 0) return rpcError(null, -32600, "Invalid Request");
            const answers = (await Promise.all(message.map(handleOne))).filter(
                (answer) => answer !== undefined,
            );
            return answers.length ? answers : undefined;
        }
        return handleOne(message);
    }

    /**
     * One line of the stdio transport.
     * @param {string} line
     * @returns {Promise<any>}
     */
    async function handleLine(line) {
        if (line.trim() === "") return undefined;
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            return rpcError(null, -32700, "Parse error");
        }
        return handle(message);
    }

    function setBackend(next) {
        unsubscribe();
        current.close?.();
        current = next;
        unsubscribe = current.onChange(() => void notifyIfChanged());
        void notifyIfChanged();
    }

    return {
        handle,
        handleLine,
        setBackend,
        get backend() {
            return current;
        },
    };
}

// ---------------------------------------------------------------------------------------------
// Process

/** Starts the bridge that owns `port`; undefined when another process has it. */
export async function startOwner({ port, host = "127.0.0.1", origins = [], log, callTimeoutMs, token }) {
    const hub = new AutomationHub({ log, callTimeoutMs });
    const secret = token ?? crypto.randomBytes(24).toString("base64url");
    const server = createAutomationServer({ hub, token: secret, origins, log });
    const listening = await new Promise((resolve, reject) => {
        server.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(false) : reject(error)));
        server.listen(port, host, () => resolve(true));
    });
    if (!listening) return undefined;
    const actualPort = server.address().port;
    const tokenFile = tokenFilePath(actualPort);
    writeTokenFile(tokenFile, {
        port: actualPort,
        token: secret,
        pid: process.pid,
        startedAt: new Date().toISOString(),
    });
    const close = () => {
        hub.close();
        server.close();
        if (readTokenFile(tokenFile)?.pid === process.pid) fs.rmSync(tokenFile, { force: true });
    };
    return { hub, server, token: secret, tokenFile, port: actualPort, close };
}

async function probeBridge(port) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(2000),
        });
        const body = await response.json();
        return body?.automation === true;
    } catch {
        return false;
    }
}

function parseArgs(argv) {
    const options = { origins: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
            return argv[++i];
        };
        if (arg === "--port") options.port = Number(value());
        else if (arg === "--origin") options.origins.push(value());
        else if (arg === "--timeout") options.callTimeoutMs = Number(value()) * 1000;
        else if (arg === "--http") options.http = true;
        else if (arg === "--help" || arg === "-h") options.help = true;
        else throw new Error(`unknown option ${arg}`);
    }
    return options;
}

const USAGE = `usage: node scripts/automation-bridge.mjs [--http] [options]
  (no flag)            MCP server over stdio for Claude Code, plus the HTTP listener
  --http               only the HTTP listener (npm run automation)
  --port 7782          port on 127.0.0.1 (CHILI3D_AUTOMATION_PORT)
  --origin <url>       allow another app origin (CHILI3D_ORIGINS, comma-separated); may repeat
  --timeout <seconds>  default longest a tool call may take (120)`;

export async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        console.error(USAGE);
        return;
    }
    const env = process.env;
    const port = options.port ?? Number(env.CHILI3D_AUTOMATION_PORT || DEFAULT_PORT);
    const origins = [
        ...(env.CHILI3D_ORIGINS
            ? env.CHILI3D_ORIGINS.split(",")
                  .map((o) => o.trim())
                  .filter(Boolean)
            : []),
        ...options.origins,
    ];
    // stdout is the MCP channel: everything human-readable goes to stderr.
    const log = (...args) => console.error("[chili3d-automation]", ...args);
    const start = () => startOwner({ port, origins, log, callTimeoutMs: options.callTimeoutMs });
    let owner = await start();
    const describe = (o) =>
        `Chili3d automation bridge on http://127.0.0.1:${o.port}\n  token:   ${o.token}\n  token file: ${o.tokenFile}\n  origins: ${[...DEFAULT_ORIGINS, ...origins].join(", ")}`;

    const shutdown = () => {
        owner?.close();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    if (options.http) {
        if (!owner) {
            log(`port ${port} is in use${(await probeBridge(port)) ? " by another automation bridge" : ""}`);
            process.exit(1);
        }
        console.log(describe(owner));
        console.log(
            `  try:     curl -s -H "Authorization: Bearer ${owner.token}" http://127.0.0.1:${owner.port}/sessions`,
        );
        return;
    }

    let mcp;
    const remote = () =>
        new RemoteBackend({
            baseUrl: `http://127.0.0.1:${port}`,
            tokenFile: tokenFilePath(port),
            onLost: async () => {
                if (owner) return;
                owner = await start().catch(() => undefined);
                if (owner) {
                    log(`the previous bridge went away; this instance now owns port ${port}`);
                    mcp.setBackend(new LocalBackend(owner.hub));
                }
            },
        });
    let backend;
    if (owner) {
        log(describe(owner));
        backend = new LocalBackend(owner.hub);
    } else if (await probeBridge(port)) {
        log(`another automation bridge owns port ${port}; sharing it (token file ${tokenFilePath(port)})`);
        backend = remote();
    } else {
        log(`port ${port} is taken by something that is not an automation bridge; tools will report it`);
        backend = remote();
    }
    const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
    mcp = createMcpServer({ backend, send: write, log });
    if (process.stdin.isTTY) log("waiting for MCP JSON-RPC on stdin (use --http for the HTTP endpoint only)");
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
        void mcp.handleLine(line).then((answer) => {
            if (answer !== undefined) write(answer);
        });
    });
    lines.on("close", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
