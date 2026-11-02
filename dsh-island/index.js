// Host half of the desktop island.
//
// Responsibilities:
//   1. fold the host's durable session events into a small state snapshot,
//   2. serve that snapshot over a loopback-only HTTP endpoint,
//   3. keep one island window process alive against that feed.
//
// The folding is per-session: every session (including ones touched by background
// agents) gets its own record, and exactly one record is published at a time so the
// card never flips between unrelated conversations.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXE_DEFAULT = join(
	process.env.LOCALAPPDATA || homedir(),
	"dsh-island-win",
	"dsh-island.exe",
);
const RESTART_MIN_MS = 3000;
// How long a finished turn stays on screen as "done" before relaxing back to idle.
const DONE_HOLD_MS = 20000;
// A session that claims to be running but has not said anything for this long is stale.
const STALE_RUNNING_MS = 10 * 60 * 1000;
// A stream chunk counts as "still writing" only while chunks keep arriving; silence
// means the model went back to thinking, not that it is still typing.
const STREAM_FRESH_MS = 1200;

const TOOL_LABELS = {
	ops_bash: "执行命令",
	ops_read_files: "读取文件",
	ops_grep: "搜索内容",
	ops_glob: "查找文件",
	ops_inspect_local_file: "查看文件",
	ops_result: "整理结果",
	ops_discover_tools: "查找工具",
	web_search: "联网搜索",
	web_fetch: "抓取网页",
	"task/subagent": "派发子任务",
	subagent: "派发子任务",
	workflow: "运行工作流",
	"todo_write": "更新计划",
	ask_user_question: "等待回答",
	"plugin_manager": "管理插件",
	cordis_inspect_query: "查询运行时",
	cordis_inspect_list: "查询运行时",
};

/** Human wording for a tool name; unknown tools fall back to a readable snake_case render. */
function toolLabel(name) {
	if (typeof name !== "string" || name === "") return "";
	const mapped = TOOL_LABELS[name];
	if (mapped !== undefined) return mapped;
	const stripped = name.replace(/^(ops_|dsh_)/, "").replace(/_/g, " ");
	return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function now() {
	return Date.now();
}

/** What the window polls; every field must survive JSON.stringify. */
function createState() {
	return {
		phase: "idle",
		tone: "idle",
		label: "",
		running: false,
		startedAt: 0,
		sessionId: "",
		title: "",
		cwd: "",
		activity: "",
		step: 0,
		turn: 0,
		tools: 0,
		tokens: 0,
		agents: 0,
		generation: 1,
	};
}

const TONE_BY_PHASE = {
	working: "working",
	done: "done",
	error: "error",
	idle: "idle",
	"waiting-approval": "waiting",
	"waiting-question": "waiting",
	"waiting-plan": "waiting",
};

function sessionKeyOf(session) {
	const candidates = [session?.header?.id, session?.id, session?.sessionId, session?.header?.sessionId];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate !== "") return candidate;
	}
	return "";
}

export function apply(ctx, config) {
	const options = config ?? {};
	if (options.enabled === false) return;

	const exePath =
		typeof options.exe === "string" && options.exe !== ""
			? options.exe
			: typeof process.env.DSH_ISLAND_EXE === "string" && process.env.DSH_ISLAND_EXE !== ""
				? process.env.DSH_ISLAND_EXE
				: EXE_DEFAULT;

	const state = createState();
	/** sessionId -> per-session record; the card renders whichever one wins focus. */
	const registry = new Map();
	let focusId = "";
	let currentSession = null;
	let server = null;
	let child = null;
	let disposed = false;
	let restartTimer = null;
	let feedUrl = "";
	let agentCount = 0;
	let agentCountAt = 0;

	function log(message) {
		try {
			const logger = typeof ctx.logger === "function" ? ctx.logger("dsh-island") : null;
			if (logger && typeof logger.info === "function") logger.info(message);
			else console.log(`[dsh-island] ${message}`);
		} catch {
			/* logging must never break the plugin */
		}
	}

	function warn(message) {
		try {
			const logger = typeof ctx.logger === "function" ? ctx.logger("dsh-island") : null;
			if (logger && typeof logger.warn === "function") logger.warn(message);
			else console.warn(`[dsh-island] ${message}`);
		} catch {
			/* ignore */
		}
	}

	function service(name) {
		try {
			return typeof ctx.get === "function" ? ctx.get(name) : undefined;
		} catch {
			return undefined;
		}
	}

	// ---------------------------------------------------------------- session records

	function recordOf(session) {
		const id = sessionKeyOf(session);
		if (id === "") return null;
		let record = registry.get(id);
		if (record) {
			record.touchedAt = now();
			return record;
		}
		record = {
			id,
			title: "",
			cwd: "",
			running: false,
			waiting: "",
			error: false,
			startedAt: 0,
			finishedAt: 0,
			step: 0,
			turn: 0,
			tools: 0,
			tokens: 0,
			toolName: "",
			streaming: false,
			streamKind: "",
			lastChunkAt: 0,
			root: false,
			touchedAt: now(),
			updatedAt: now(),
		};
		registry.set(id, record);
		if (registry.size > 40) {
			// Keep the map from growing without bound across a long-lived host.
			const oldest = [...registry.values()]
				.filter((entry) => entry.id !== focusId)
				.sort((a, b) => a.updatedAt - b.updatedAt)
				.slice(0, 8);
			for (const entry of oldest) registry.delete(entry.id);
		}
		return record;
	}

	/** Title / working directory live on the session, not on the event stream. */
	function describeSession(session) {
		if (!session) return null;
		currentSession = session;
		const record = recordOf(session);
		if (!record) return null;
		const header = session.header ?? session;
		const cwd = header.cwd ?? session.cwd ?? header.projectDir ?? header.directory ?? header.workdir;
		if (typeof cwd === "string" && cwd !== "" && record.cwd !== cwd) {
			record.cwd = cwd;
			record.updatedAt = now();
		}
		let title = "";
		const titles = service("sessionTitle");
		if (titles && typeof titles.get === "function") {
			try {
				const snapshot = titles.get(session);
				title = snapshot?.title ?? snapshot?.displayTitle ?? snapshot?.text ?? snapshot?.name ?? "";
			} catch {
				title = "";
			}
		}
		if (title === "") title = header.title ?? session.title ?? session.name ?? "";
		if (typeof title === "string" && title !== "" && title !== "New session" && record.title !== title) {
			record.title = title;
			record.updatedAt = now();
		}
		return record;
	}

	function markStarted(record, at) {
		record.running = true;
		record.error = false;
		record.waiting = "";
		record.streaming = false;
		record.finishedAt = 0;
		if (record.startedAt === 0) record.startedAt = at ?? now();
		record.updatedAt = now();
	}

	function markFinished(record) {
		record.running = false;
		record.streaming = false;
		record.toolName = "";
		record.startedAt = 0;
		record.finishedAt = now();
		record.updatedAt = now();
	}

	// ---------------------------------------------------------------- durable events

	function onSessionEvent(session, event) {
		const type = event?.type;
		if (typeof type !== "string") return;
		const record = describeSession(session);
		if (!record) return;
		const data = event.data ?? {};

		switch (type) {
			case "user/message": {
				record.root = true;
				focusId = record.id;
				record.step = 0;
				record.tools = 0;
				record.tokens = 0;
				record.turn += 1;
				markStarted(record);
				break;
			}
			case "turn/start": {
				record.step = 0;
				record.tools = 0;
				record.streaming = false;
				record.toolName = "";
				const turn = Number(data.turn ?? event.turn ?? 0);
				if (Number.isFinite(turn) && turn > 0) record.turn = turn;
				markStarted(record);
				break;
			}
			case "step/start": {
				record.streaming = false;
				record.toolName = "";
				const step = Number(data.step ?? event.step ?? 0);
				if (Number.isFinite(step) && step > 0) record.step = step;
				record.updatedAt = now();
				break;
			}
			case "tool/call": {
				const name = typeof data.name === "string" ? data.name : "";
				if (name !== "") record.toolName = name;
				record.tools += 1;
				record.streaming = false;
				const step = Number(data.step ?? event.step ?? 0);
				if (Number.isFinite(step) && step > 0) record.step = step;
				markStarted(record);
				break;
			}
			case "tool/result": {
				record.toolName = "";
				record.updatedAt = now();
				break;
			}
			case "assistant/message": {
				const usage = data.message?.usage ?? data.usage;
				const total = usage?.totalTokens ?? usage?.total ?? usage?.outputTokens;
				if (Number.isFinite(total) && total > 0) record.tokens = Math.round(total);
				record.streaming = false;
				record.toolName = "";
				record.updatedAt = now();
				break;
			}
			case "turn/end":
			case "turn/stopped": {
				markFinished(record);
				break;
			}
			default:
				break;
		}
		publish();
	}

	// ---------------------------------------------------------------- focus + publish

	/** Which session the card speaks for: waiting > running > last focused. */
	function pickFocus() {
		const list = [...registry.values()];
		if (list.length === 0) return "";
		const attention = list.filter((entry) => entry.waiting).sort((a, b) => b.touchedAt - a.touchedAt)[0];
		if (attention) return attention.id;
		const current = registry.get(focusId);
		const fresh = (entry) => now() - entry.updatedAt < STALE_RUNNING_MS;
		const running = list.filter((entry) => entry.running && fresh(entry)).sort((a, b) => b.touchedAt - a.touchedAt);
		if (current && current.running && fresh(current)) return current.id;
		const runningRoot = running.filter((entry) => entry.root)[0];
		if (runningRoot) return runningRoot.id;
		if (running.length > 0) return running[0].id;
		if (current) return current.id;
		return list.sort((a, b) => b.touchedAt - a.touchedAt)[0].id;
	}

	function activityOf(record) {
		if (!record.running) return "";
		if (record.toolName !== "") return toolLabel(record.toolName);
		if (record.streaming && now() - record.lastChunkAt < STREAM_FRESH_MS) {
			if (record.streamKind === "text") return "输出中";
			if (record.streamKind === "tool") return "准备工具";
			return "思考中";
		}
		return "思考中";
	}

	function phaseOf(record) {
		if (record.waiting !== "") return record.waiting;
		if (record.error) return "error";
		if (record.running) return "working";
		if (record.finishedAt > 0 && now() - record.finishedAt < DONE_HOLD_MS) return "done";
		return "idle";
	}

	function publish() {
		focusId = pickFocus();
		const record = registry.get(focusId) ?? null;
		if (!record) {
			state.phase = "idle";
			state.tone = "idle";
			state.running = false;
			state.activity = "";
			state.startedAt = 0;
			state.step = 0;
			return;
		}
		state.sessionId = record.id;
		if (record.title !== "") state.title = record.title;
		if (record.cwd !== "") state.cwd = record.cwd;
		state.running = record.running;
		state.startedAt = record.startedAt;
		state.step = record.step;
		state.turn = record.turn;
		state.tools = record.tools;
		state.tokens = record.tokens;
		state.activity = activityOf(record);
		state.phase = phaseOf(record);
		state.tone = TONE_BY_PHASE[state.phase] ?? "idle";
		state.label = "";
	}

	// ---------------------------------------------------------------- subscriptions

	const disposers = [];
	function subscribe(name, handler) {
		try {
			const dispose = ctx.on(name, handler);
			if (typeof dispose === "function") disposers.push(dispose);
		} catch (error) {
			warn(`cannot subscribe to ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	subscribe("session/event", (session, event) => {
		try {
			onSessionEvent(session, event);
		} catch (error) {
			warn(`session/event handler failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	subscribe("agent/status", (payload) => {
		try {
			const record = describeSession(payload?.agent?.session ?? payload?.agent);
			if (!record) return;
			if (payload?.status === "running") markStarted(record);
			else if (payload?.status === "idle") {
				record.running = false;
				record.streaming = false;
				record.toolName = "";
				record.startedAt = 0;
				if (record.finishedAt === 0) record.finishedAt = now();
				record.updatedAt = now();
			}
			publish();
		} catch {
			/* ignore */
		}
	});

	subscribe("agent/assistant-stream", (payload) => {
		try {
			const record = describeSession(payload?.agent?.session ?? payload?.agent);
			const frame = payload?.frame;
			if (!record || !frame) return;
			if (frame.type === "start") {
				record.streaming = true;
				record.streamKind = "";
				record.lastChunkAt = now();
				record.updatedAt = now();
				publish();
				return;
			}
			if (frame.type === "end") {
				record.streaming = false;
				record.streamKind = "";
				record.updatedAt = now();
				publish();
				return;
			}
			const chunk = frame.chunk;
			if (!chunk) return;
			if (chunk.type === "reasoning-delta" || (chunk.type === "block-start" && chunk.blockType === "reasoning")) {
				record.streamKind = "reasoning";
			} else if (chunk.type === "text-delta" || (chunk.type === "block-start" && chunk.blockType === "text")) {
				record.streamKind = "text";
			} else if (chunk.type === "tool-call-delta" || (chunk.type === "block-start" && chunk.blockType === "tool-call")) {
				record.streamKind = "tool";
			} else if (chunk.type === "finish") {
				record.streaming = false;
				record.streamKind = "";
			}
			record.streaming = true;
			record.lastChunkAt = now();
			record.updatedAt = now();
			publish();
		} catch {
			/* ignore */
		}
	});

	subscribe("approval/request", (payload) => {
		try {
			const record = describeSession(payload?.agent?.session ?? payload?.agent);
			if (!record) return;
			record.waiting = "waiting-approval";
			record.running = true;
			record.updatedAt = now();
			focusId = record.id;
			publish();
		} catch {
			/* ignore */
		}
	});

	subscribe("user-questions/request", (payload) => {
		try {
			const record = describeSession(payload?.agent?.session ?? payload?.agent);
			if (!record) return;
			record.waiting = "waiting-question";
			record.running = true;
			record.updatedAt = now();
			focusId = record.id;
			publish();
		} catch {
			/* ignore */
		}
	});

	subscribe("agent/error", (payload) => {
		try {
			const record = describeSession(payload?.agent?.session ?? payload?.agent);
			if (!record) return;
			record.error = true;
			record.waiting = "";
			record.running = false;
			record.toolName = "";
			record.finishedAt = now();
			record.updatedAt = now();
			publish();
		} catch {
			/* ignore */
		}
	});

	subscribe("api-session/status", (payload) => {
		try {
			const id = typeof payload?.sessionId === "string" ? payload.sessionId : "";
			const record = id === "" ? null : registry.get(id);
			if (!record) return;
			if (payload?.running === true) markStarted(record);
			else if (payload?.running === false) {
				record.running = false;
				record.streaming = false;
				record.toolName = "";
				record.startedAt = 0;
				if (record.finishedAt === 0) record.finishedAt = now();
				record.updatedAt = now();
			}
			publish();
		} catch {
			/* ignore */
		}
	});

	// ---------------------------------------------------------------- loopback feed

	function runningAgentCount() {
		const at = now();
		if (at - agentCountAt < 900) return agentCount;
		agentCountAt = at;
		try {
			const list = service("agents")?.list?.() ?? [];
			agentCount = Array.isArray(list) ? list.filter((agent) => agent?.status === "running").length : 0;
		} catch {
			agentCount = 0;
		}
		return agentCount;
	}

	function snapshot() {
		// Re-derive on every poll so time-based phases (done -> idle) advance without events.
		publish();
		const duration =
			state.running && state.startedAt > 0 ? Math.max(0, Math.floor((now() - state.startedAt) / 1000)) : 0;
		const record = registry.get(focusId);
		return {
			...state,
			agents: runningAgentCount(),
			elapsed: duration,
			updatedAt: now(),
			tool: record?.toolName ?? "",
			streaming: record?.streaming === true && now() - (record?.lastChunkAt ?? 0) < STREAM_FRESH_MS,
			streamKind: record?.streamKind ?? "",
		};
	}

	function debugInfo() {
		const info = {
			exe: exePath,
			feedUrl,
			focus: focusId,
			state: snapshot(),
			sessions: [...registry.values()].map((record) => ({
				id: record.id,
				title: record.title,
				cwd: record.cwd,
				running: record.running,
				waiting: record.waiting,
				error: record.error,
				step: record.step,
				turn: record.turn,
				tools: record.tools,
				toolName: record.toolName,
				streaming: record.streaming,
				startedAt: record.startedAt,
				finishedAt: record.finishedAt,
				updatedAt: record.updatedAt,
				root: record.root,
			})),
		};
		return info;
	}

	server = createServer((request, response) => {
		const url = request.url ?? "/";
		if (url.startsWith("/debug")) {
			const body = JSON.stringify(debugInfo());
			response.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
				"access-control-allow-origin": "*",
			});
			response.end(body);
			return;
		}
		if (url.startsWith("/state") || url === "/") {
			const body = JSON.stringify(snapshot());
			response.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
				"access-control-allow-origin": "*",
			});
			response.end(body);
			return;
		}
		if (url.startsWith("/health")) {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("ok");
			return;
		}
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("not found");
	});

	// ---------------------------------------------------------------- child process

	function launch() {
		if (disposed) return;
		if (!existsSync(exePath)) {
			warn(`island binary not found at ${exePath}; run tools/make-island-host.ps1 first`);
			return;
		}
		if (feedUrl === "") {
			warn("feed server is not listening yet; skipping launch");
			return;
		}
		const env = { ...process.env };
		// The host child process carries ELECTRON_RUN_AS_NODE=1; without clearing it the binary
		// degrades into plain Node and exits with "bad option: --feed".
		delete env.ELECTRON_RUN_AS_NODE;
		try {
			child = spawn(exePath, [`--feed=${feedUrl}`], {
				detached: false,
				stdio: "ignore",
				windowsHide: false,
				env,
			});
		} catch (error) {
			warn(`cannot launch island: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		child.on("exit", (code, signal) => {
			child = null;
			if (disposed) return;
			warn(`island exited (code=${code}, signal=${signal}); scheduling relaunch`);
			restartTimer = setTimeout(() => {
				restartTimer = null;
				launch();
			}, RESTART_MIN_MS);
			if (typeof restartTimer.unref === "function") restartTimer.unref();
		});
		child.on("error", (error) => {
			warn(`island process error: ${error.message}`);
		});
		log(`island launched from ${exePath} -> ${feedUrl}`);
	}

	server.on("error", (error) => {
		warn(`feed server error: ${error.message}`);
	});

	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		if (!port) {
			warn("feed server did not report a port");
			return;
		}
		feedUrl = `http://127.0.0.1:${port}/state`;
		log(`feed listening on ${feedUrl}`);
		launch();
	});

	// ---------------------------------------------------------------- teardown

	function teardown() {
		if (disposed) return;
		disposed = true;
		if (restartTimer) {
			clearTimeout(restartTimer);
			restartTimer = null;
		}
		if (child !== null) {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			child = null;
		}
		try {
			server?.close();
		} catch {
			/* ignore */
		}
		for (const dispose of disposers.splice(0)) {
			try {
				dispose();
			} catch {
				/* ignore */
			}
		}
	}

	if (typeof ctx.effect === "function") ctx.effect(() => teardown);
	else if (typeof ctx.on === "function") {
		const dispose = ctx.on("dispose", teardown);
		if (typeof dispose === "function") disposers.push(dispose);
	}
}
