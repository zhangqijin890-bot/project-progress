// 集成测试：用 mock ctx 驱动 dsh-project-progress 插件，验证自动建项目/记进展。
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, apply } from "../lib/index.js";

const tmp = mkdtempSync(join(tmpdir(), "pp-test-"));
const handlers = {};
const registered = { tools: [], commands: [], sections: [] };
// 历史持久化会话模拟：测试中途可往里塞数据，backfill 会读取它们
const persistedHeaders = [];
const persistedInspections = {};
const ctx = {
	on(name, fn) { handlers[name] = fn; },
	logger: { warn(...args) { console.warn("[warn]", ...args); }, info() {} },
	agents: { roots: () => [] },
	sessions: { list: () => [] },
	sessionPersistence: {
		list: async () => [...persistedHeaders],
		inspect: async (id) => persistedInspections[id] ?? { meta: {}, events: [] }
	},
	systemPrompt: { section(s) { registered.sections.push(s); } },
	tools: { register(t) { registered.tools.push(t); } },
	commands: { register(c) { registered.commands.push(c); } },
	llm: {
		async stream() {
			// 模拟 LLM 摘要流（两段文本块 + 完成）
			return (async function* () {
				yield { type: "text", text: "项目正在" };
				yield { type: "text", text: "开发 DSH 插件。" };
				yield { type: "finish", finish: { kind: "stop" } };
			})();
		}
	},
	effect() {}
};

const config = Config({ projectsDir: tmp, llmDigest: true, digestMinIntervalMs: 1000 });
apply(ctx, config);

const now = "2026-08-17T01:00:00.000Z";
const mkEvent = (type, data) => ({ type, data, seq: 0, time: now });
const session = {
	id: "session-test-1",
	header: { cwd: "/tmp/插件测试项目" },
	events: [
		mkEvent("session/title", { title: "插件测试项目" }),
		mkEvent("turn/start", { turn: 1 }),
		mkEvent("user/message", { content: "帮我写一个自动同步项目进展的插件", source: { kind: "user" } }),
		mkEvent("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "好的，我来设计插件架构。" }], source: { provider: "deepseek-official", model: "deepseek-v4-flash" } } }),
		mkEvent("tool/call", { turn: 1, step: 2, callId: "c1", name: "bash", arguments: "{}" }),
		mkEvent("assistant/message", { turn: 1, step: 2, message: { content: [{ type: "text", text: "插件已创建。" }], source: { provider: "deepseek-official", model: "deepseek-v4-flash" } } }),
		mkEvent("turn/end", { turn: 1, reason: "completed" })
	]
};

// 1) session/created → 自动创建项目
handlers["session/created"](session);

// 2) turn/end → 记录进展
handlers["session/event"](session, { type: "turn/end" });

// 等写入队列与摘要完成
await new Promise((r) => setTimeout(r, 800));

// 断言
const dirs = [];
import { readdirSync } from "node:fs";
for (const d of readdirSync(tmp)) dirs.push(d);
console.log("projects dirs:", dirs);

const projectDir = join(tmp, dirs[0]);
const progress = existsSync(join(projectDir, "progress.md")) ? readFileSync(join(projectDir, "progress.md"), "utf8") : "";
const log = existsSync(join(projectDir, "log.json")) ? JSON.parse(readFileSync(join(projectDir, "log.json"), "utf8")) : [];
const meta = existsSync(join(projectDir, "project.json")) ? JSON.parse(readFileSync(join(projectDir, "project.json"), "utf8")) : null;
const digest = existsSync(join(projectDir, "digest.txt")) ? readFileSync(join(projectDir, "digest.txt"), "utf8") : "";

console.log("--- project.json ---");
console.log(JSON.stringify(meta, null, 2).slice(0, 800));
console.log("--- log.json entries:", log.length, "---");
console.log(JSON.stringify(log[0], null, 2).slice(0, 600));
console.log("--- digest.txt ---");
console.log(digest);
console.log("--- progress.md ---");
console.log(progress.slice(0, 1500));

// 3) 工具注册与命令注册
console.log("tools:", registered.tools.map((t) => t.name).join(","));
console.log("commands:", registered.commands.map((c) => c.name).join(","));
console.log("systemPrompt sections:", registered.sections.map((s) => s.name).join(","));

// 4) 测试 update_project_progress 工具的执行
const exec = { agent: { session } };
const noteResult = await registered.tools.find((t) => t.name === "update_project_progress").execute({ note: "下一步：接入 LLM 摘要" }, exec);
console.log("note result:", JSON.stringify(noteResult));
await new Promise((r) => setTimeout(r, 300));
const progress2 = readFileSync(join(projectDir, "progress.md"), "utf8");
console.log("note in progress.md:", progress2.includes("下一步：接入 LLM 摘要"));

// 5) 测试 get_project_progress 工具
const getResult = await registered.tools.find((t) => t.name === "get_project_progress").execute({}, exec);
console.log("get progress ok:", typeof getResult.progress === "string" && getResult.progress.length > 0, "| updatedAt:", getResult.updatedAt);

// 6) 测试 /project 命令 handler
const cmdHandler = registered.commands.find((c) => c.name === "project").handler;
const show = await cmdHandler({ agent: { session }, rawInput: "" });
console.log("command show kind:", show.kind, "| has 项目:", show.text.includes("项目"));
const pathResult = await cmdHandler({ agent: { session }, rawInput: "path" });
console.log("command path:", pathResult.text);

// 7) 历史会话补建：模拟一个插件安装前就存在的持久化会话
const histEvents = [
	mkEvent("session/title", { title: "历史项目" }),
	mkEvent("turn/start", { turn: 1 }),
	mkEvent("user/message", { content: "历史问题一", source: { kind: "user" } }),
	mkEvent("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "历史答复一" }], source: {} } }),
	mkEvent("turn/end", { turn: 1, reason: "completed" }),
	mkEvent("turn/start", { turn: 2 }),
	mkEvent("user/message", { content: "历史问题二", source: { kind: "user" } }),
	mkEvent("assistant/message", { turn: 2, step: 1, message: { content: [{ type: "text", text: "历史答复二" }], source: {} } }),
	mkEvent("turn/end", { turn: 2, reason: "completed" })
];
persistedHeaders.push({ id: "session-hist-1", cwd: "/tmp/历史项目" });
persistedInspections["session-hist-1"] = { meta: { id: "session-hist-1", cwd: "/tmp/历史项目" }, events: histEvents };

const backfillResult = await cmdHandler({ agent: { session }, rawInput: "backfill" });
console.log("--- backfill ---");
console.log(backfillResult.text);

const histDir = readdirSync(tmp).find((d) => d.includes("历史项目"));
const histLog = existsSync(join(tmp, histDir, "log.json")) ? JSON.parse(readFileSync(join(tmp, histDir, "log.json"), "utf8")) : [];
console.log("历史项目 log 条数:", histLog.length, "| 回合1请求:", histLog[0]?.request, "| 回合2请求:", histLog[1]?.request);
const histProgress = readFileSync(join(tmp, histDir, "progress.md"), "utf8");
console.log("历史项目 progress 含回合2:", histProgress.includes("历史问题二"));

// 8) 幂等性：再跑一次 backfill，不应新增重复条目
const before = histLog.length;
const backfillResult2 = await cmdHandler({ agent: { session }, rawInput: "backfill" });
const histLog2 = existsSync(join(tmp, histDir, "log.json")) ? JSON.parse(readFileSync(join(tmp, histDir, "log.json"), "utf8")) : [];
console.log("二次 backfill 新增条数:", histLog2.length - before, "（应为 0）");

// 9) 旧版本目录合并：同一工作区两个不同标题的目录 → 合并成一个
import { mkdirSync, writeFileSync } from "node:fs";
const legacyPath = "/tmp/旧版工作区";
const legacyA = join(tmp, "会话A标题-ed1e5e");
const legacyB = join(tmp, "会话B标题-ed1e5e");
mkdirSync(legacyA, { recursive: true });
mkdirSync(legacyB, { recursive: true });
writeFileSync(join(legacyA, "project.json"), JSON.stringify({
	version: 1, id: "会话A标题-ed1e5e", title: "会话A标题", path: legacyPath,
	createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z",
	sessions: [{ id: "s-a", title: "会话A标题", createdAt: "2026-08-01T00:00:00.000Z", lastActivityAt: "2026-08-02T00:00:00.000Z", turns: 2, maxTurn: 2 }],
	counters: { turns: 2 }
}));
writeFileSync(join(legacyA, "log.json"), JSON.stringify([
	{ time: "2026-08-01T00:00:00.000Z", sessionId: "s-a", sessionTitle: "会话A标题", turn: 1, request: "A问题1", outcome: "A答复1", tools: [], reason: "completed" },
	{ time: "2026-08-02T00:00:00.000Z", sessionId: "s-a", sessionTitle: "会话A标题", turn: 2, request: "A问题2", outcome: "A答复2", tools: [], reason: "completed" }
]));
writeFileSync(join(legacyA, "notes.json"), JSON.stringify([{ time: "2026-08-02T00:00:00.000Z", sessionId: "s-a", note: "A 的交接笔记" }]));
writeFileSync(join(legacyA, "digest.txt"), "A 目录的旧摘要");
writeFileSync(join(legacyB, "project.json"), JSON.stringify({
	version: 1, id: "会话B标题-ed1e5e", title: "会话B标题", path: legacyPath,
	createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
	sessions: [{ id: "s-b", title: "会话B标题", createdAt: "2026-08-03T00:00:00.000Z", lastActivityAt: "2026-08-04T00:00:00.000Z", turns: 1, maxTurn: 1 }],
	counters: { turns: 1 }
}));
writeFileSync(join(legacyB, "log.json"), JSON.stringify([
	{ time: "2026-08-04T00:00:00.000Z", sessionId: "s-b", sessionTitle: "会话B标题", turn: 1, request: "B问题", outcome: "B答复", tools: [], reason: "completed" }
]));
const mergeResult = await cmdHandler({ agent: { session }, rawInput: "merge" });
console.log("--- merge ---");
console.log(mergeResult.text);
const mergedDir = readdirSync(tmp).find((d) => d.includes("旧版工作区"));
const mergedMeta = JSON.parse(readFileSync(join(tmp, mergedDir, "project.json"), "utf8"));
const mergedLog = JSON.parse(readFileSync(join(tmp, mergedDir, "log.json"), "utf8"));
console.log("合并目录:", mergedDir, "| 会话数:", mergedMeta.sessions.length, "| 回合数:", mergedMeta.counters.turns);
console.log("合并日志条数:", mergedLog.length, "（应为 3：A1+A2+B1）");
console.log("含 A 与 B 的请求:", mergedLog.some((e) => e.request === "A问题1") && mergedLog.some((e) => e.request === "B问题"));
console.log("旧目录已删除:", !existsSync(legacyA) && !existsSync(legacyB));
const mergedNotes = JSON.parse(readFileSync(join(tmp, mergedDir, "notes.json"), "utf8"));
console.log("合并笔记含 A 的:", mergedNotes.some((n) => n.note === "A 的交接笔记"));
console.log("digest 已保留:", existsSync(join(tmp, mergedDir, "digest.txt")));

console.log("\nALL OK");
