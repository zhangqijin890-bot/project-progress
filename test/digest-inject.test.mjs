// 补充测试：LLM 摘要路径 + 新会话自动注入路径
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, apply } from "../lib/index.js";

const tmp = mkdtempSync(join(tmpdir(), "pp-test2-"));
const handlers = {};
const chunks = [
	{ type: "block-start", index: 0, blockType: "text" },
	{ type: "text-delta", index: 0, text: "项目正在" },
	{ type: "text-delta", index: 0, text: "开发插件，已完成自动记录。" },
	{ type: "block-end", index: 0, block: { type: "text", text: "项目正在开发插件，已完成自动记录。" } },
	{ type: "finish", reason: { kind: "stop" } }
];
const ctx = {
	on(name, fn) { handlers[name] = fn; },
	logger: { warn: (...a) => console.warn("[warn]", ...a), info() {} },
	agents: { roots: () => roots },
	sessions: { list: () => [] },
	sessionPersistence: { list: async () => [], inspect: async () => ({ meta: {}, events: [] }) },
	systemPrompt: { section() {} },
	tools: { register() {} },
	commands: { register() {} },
	llm: { async *stream() { for (const c of chunks) yield c; } },
	effect() {}
};
// 根代理集合：测试里由 pre-step 传入的 agent 对象提前注册，模拟真实 roots()
const roots = [];

const config = Config({ projectsDir: tmp, llmDigest: true, digestMinIntervalMs: 1000 });
apply(ctx, config);

const now = "2026-08-17T02:00:00.000Z";
const session = {
	id: "session-llm-1",
	header: { cwd: "/tmp/llm摘要项目" },
	events: [
		{ type: "session/title", data: { title: "llm摘要项目" }, seq: 0, time: now },
		{ type: "request/header", data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash" } } }, seq: 1, time: now },
		{ type: "turn/start", data: { turn: 1 }, seq: 2, time: now },
		{ type: "user/message", data: { content: "写个插件", source: { kind: "user" } }, seq: 3, time: now },
		{ type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "完成" }], source: {} } }, seq: 4, time: now },
		{ type: "turn/end", data: { turn: 1, reason: "completed" }, seq: 5, time: now }
	]
};

handlers["session/created"](session);
handlers["session/event"](session, { type: "turn/end" });
await new Promise((r) => setTimeout(r, 600));

// 动态定位项目目录（key 里的哈希由路径计算，不要硬编码）
import { readdirSync } from "node:fs";
const projectDirs = readdirSync(tmp).filter((d) => d.includes("llm摘要项目"));
console.log("project dirs:", projectDirs);
const dir = join(tmp, projectDirs[0]);
const digest = existsSync(join(dir, "digest.txt")) ? readFileSync(join(dir, "digest.txt"), "utf8") : "";
console.log("digest.txt:", JSON.stringify(digest));
const progress = readFileSync(join(dir, "progress.md"), "utf8");
console.log("progress has digest:", progress.includes("开发插件，已完成自动记录。"));

// 自动注入路径：新会话（无历史回合）首步
const freshSession = {
	id: "session-fresh-1",
	header: { cwd: "/tmp/llm摘要项目" },
	events: [
		{ type: "session/title", data: { title: "llm摘要项目" }, seq: 0, time: now },
		{ type: "turn/start", data: { turn: 1 }, seq: 1, time: now },
		{ type: "user/message", data: { content: "继续上次的工作", source: { kind: "user" } }, seq: 2, time: now }
	]
};
const freshAgent = { session: freshSession };
roots.push(freshAgent);
const preStep = handlers["agent/pre-step"];
if (preStep) {
	const claimed = [freshSession.events[2]];
	const decision = await preStep(
		{ agent: freshAgent, messages: claimed, step: 1, signal: new AbortController().signal },
		async () => ({ kind: "enter", messages: [...claimed] })
	);
	console.log("pre-step decision kind:", decision.kind);
	const injected = decision.messages.find((m) => typeof m.content === "string" && m.content.includes("进展摘要"));
	console.log("injected digest message:", injected !== void 0 ? "YES" : "NO");
	console.log("message count after inject:", decision.messages.length);
	console.log("inject source:", JSON.stringify(injected?.source));
} else {
	console.log("agent/pre-step handler NOT registered");
}

console.log("\nDONE");
