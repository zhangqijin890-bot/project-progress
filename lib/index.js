// dsh-project-progress — 自动记录每个项目的进展，让新会话快速接手。
//
// 功能：
//   1. 每个工作区（workspace / 项目目录）自动创建一个项目记录；
//   2. 每个会话的回合结束时自动同步进展（结构化日志 + 可选 LLM 摘要）；
//   3. 新会话自动注入项目进展摘要（/project 命令、get_project_progress 工具、
//      agent/pre-step 自动注入），上下文满了也能快速接手。
//
// 存储：$DSH_HOME/projects/<project-key>/ 下
//   project.json  元数据（标题、路径、会话列表、统计）
//   log.json      结构化回合日志（有界）
//   notes.json    交接笔记（模型/用户通过工具追加）
//   digest.txt    最新 LLM 摘要
//   progress.md   人类可读的进展文档（由上面几项生成）
//
// 插件形态：cordis 插件，导出 { name, inject, apply, Config }。

import z from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { BlockAssembler, createUserMessage, deepFreeze } from "@deepseek-ai/dsh-llm";
import { foldRequestHeader } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "project-progress";

const inject = [
	"agents",
	"commands",
	"llm",
	"sessionPersistence",
	"sessions",
	"systemPrompt",
	"tools"
];

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const Config = z.object({
	// 项目存储根目录。留空时按 $DSH_HOME/projects 解析。
	projectsDir: z.string(),
	// 回合日志保留条数上限。
	maxLogEntries: z.number().step(1).min(10).max(2000).default(200),
	// progress.md 中“最近活动”展示的条数。
	maxRecentActivity: z.number().step(1).min(3).max(100).default(10),
	// 回合日志中单条请求/回复截断长度（字符）。
	turnTextMaxChars: z.number().step(1).min(20).max(8000).default(300),
	// 新会话自动注入摘要的最大字符数；0 表示不注入。
	maxInjectChars: z.number().step(1).min(0).max(16000).default(4000),
	// 是否在新会话首个回合自动注入项目进展摘要。
	autoInject: z.boolean().default(true),
	// 是否用 LLM 生成“当前状态”摘要（失败时回退到规则摘要）。
	llmDigest: z.boolean().default(true),
	// 两次 LLM 摘要之间的最短间隔（毫秒），避免每个回合都调用。
	digestMinIntervalMs: z.number().step(1).min(1000).max(600000).default(60000),
	// 送入摘要器的日志输入上限（字符）。
	digestMaxInputChars: z.number().step(1).min(500).max(200000).default(20000),
	// 摘要输出 token 上限。
	maxDigestTokens: z.number().step(1).min(16).max(4096).default(512),
	// 摘要调用超时（毫秒）。
	digestTimeoutMs: z.number().step(1).min(1000).max(120000).default(30000),
	// 显式指定摘要模型路由；两者同时给出时优先于会话自身路由。
	provider: z.string(),
	model: z.string()
});

function resolveConfig(config) {
	const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
	return {
		...config,
		projectsDir: config.projectsDir || join(dshHome, "projects")
	};
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 最近事件时间，回退到 now。 */
function timeOf(event) {
	if (event && typeof event.time === "string" && event.time.length > 0) return event.time;
	return new Date().toISOString();
}

/** 从消息 content（字符串或块数组）提取纯文本。 */
function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block && block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
	}
	return "";
}

/** 截断到 maxChars，保留语义边界。 */
function truncate(text, maxChars) {
	if (text.length <= maxChars) return text;
	const head = text.slice(0, Math.max(1, maxChars - 1));
	return `${head}…`;
}

/** 单行化：压缩空白，去掉换行。 */
function oneLine(text, maxChars) {
	const flat = text.replace(/\s+/g, " ").trim();
	return truncate(flat, maxChars);
}

/** 稳定、文件系统安全的项目 key。 */
function projectKey(title, path) {
	const slug = String(title || "project")
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40) || "project";
	const digest = createHash("sha1").update(path).digest("hex").slice(0, 6);
	return `${slug}-${digest}`;
}

/** 读取 JSON，失败返回 undefined。 */
async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return void 0;
	}
}

/** 唯一临时后缀，避免并发写同一路径时 rename 互相踩踏。 */
function tmpSuffix() {
	return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 原子写 JSON。 */
async function writeJson(path, value) {
	const tmp = `${path}.tmp-${tmpSuffix()}`;
	await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
	await rename(tmp, path);
}

/** 原子写文本。 */
async function writeText(path, text) {
	const tmp = `${path}.tmp-${tmpSuffix()}`;
	await writeFile(tmp, text, "utf8");
	await rename(tmp, path);
}

/** 工具调用展示卡片（与 dsh 工具约定一致）。 */
function present(title, kind, rawInput) {
	return {
		card: "generic",
		title,
		kind,
		...rawInput === void 0 ? {} : { rawInput }
	};
}

// ---------------------------------------------------------------------------
// 会话 → 事件提取
// ---------------------------------------------------------------------------

/** 收集会话中已闭合的回合摘要。 */
function collectTurns(session) {
	const turns = [];
	let current = void 0;
	for (const event of session.events) {
		if (event.type === "turn/start") {
			current = {
				turn: event.data?.turn,
				startedAt: timeOf(event),
				requests: [],
				responses: [],
				tools: [],
				endReason: void 0,
				endedAt: void 0
			};
			continue;
		}
		if (current === void 0) continue;
		switch (event.type) {
			case "user/message": {
				const source = event.data?.source;
				// 只记录人类输入；goal/plugin 注入的上下文消息不计入“请求”。
				if (source && (source.kind === "user" || source.kind === void 0)) current.requests.push(textOf(event.data?.content));
				break;
			}
			case "assistant/message": {
				current.responses.push(textOf(event.data?.message?.content));
				break;
			}
			case "tool/call": {
				const toolName = event.data?.name;
				if (typeof toolName === "string" && toolName.length > 0) current.tools.push(toolName);
				break;
			}
			case "turn/end": {
				current.endReason = event.data?.reason;
				current.endedAt = timeOf(event);
				turns.push(current);
				current = void 0;
				break;
			}
			default: break;
		}
	}
	return turns;
}

/** 会话标题（从 session/title 事件折叠）。 */
function sessionTitle(session) {
	for (let i = session.events.length - 1; i >= 0; i -= 1) {
		const event = session.events[i];
		if (event.type === "session/title" && typeof event.data?.title === "string" && event.data.title.length > 0) {
			return event.data.title;
		}
	}
	return void 0;
}

/** 会话当前 LLM 路由（request/header 折叠，provider/model 在 config 下）。 */
function sessionRoute(session) {
	try {
		const header = foldRequestHeader(session.events);
		const config = header?.config;
		if (config && typeof config.provider === "string" && config.provider.length > 0 && typeof config.model === "string" && config.model.length > 0) {
			return { provider: config.provider, model: config.model };
		}
	} catch {
		// 忽略折叠错误，走配置路由
	}
	return void 0;
}

/** 会话是否已有历史回合（用于判断是否“全新会话”）。 */
function sessionHasPriorTurns(session) {
	let count = 0;
	for (const event of session.events) {
		if (event.type === "turn/start") count += 1;
		if (count > 1) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// 项目存储
// ---------------------------------------------------------------------------

/** 打开一个项目：按会话 cwd 定位工作区，必要时自动创建。 */
async function openProject(projectsDir, session, { create = false } = {}) {
	const cwd = session?.header?.cwd;
	if (typeof cwd !== "string" || cwd.length === 0) return void 0;
	const title = sessionTitle(session) || basename(cwd);
	const key = projectKey(title, cwd);
	const dir = join(projectsDir, key);
	const metaPath = join(dir, "project.json");
	const meta = await readJson(metaPath);
	if (meta) {
		if (create) {
			meta.updatedAt = new Date().toISOString();
		}
		return { key, dir, meta, metaPath, cwd, title };
	}
	if (!create) return void 0;
	await mkdir(dir, { recursive: true });
	// 并发创建保护：mkdir 后可能已有其他写入者创建了 meta，以已存在的为准。
	const existing = await readJson(metaPath);
	if (existing) return { key, dir, meta: existing, metaPath, cwd, title };
	const now = new Date().toISOString();
	const fresh = {
		version: 1,
		id: key,
		title,
		path: cwd,
		createdAt: now,
		updatedAt: now,
		sessions: [],
		counters: {
			turns: 0
		}
	};
	await writeJson(metaPath, fresh);
	return { key, dir, meta: fresh, metaPath, cwd, title };
}

/** 合并会话进入项目元数据。 */
function upsertSessionMeta(meta, session) {
	const id = session.id;
	const existing = meta.sessions.find((item) => item.id === id);
	const record = existing ?? {
		id,
		title: void 0,
		createdAt: new Date().toISOString(),
		lastActivityAt: void 0,
		turns: 0,
		maxTurn: 0
	};
	const title = sessionTitle(session);
	if (title !== void 0) record.title = title;
	meta.sessions = [record, ...meta.sessions.filter((item) => item.id !== id)];
	return record;
}

/** 把回合集合写入项目存储并重生成 progress.md（幂等：按 maxTurn + 日志去重）。 */
async function recordTurns(project, session, turns, config) {
	// 只处理已闭合的回合（turn/end 出现过）。
	const closed = turns.filter((turn) => turn.endedAt !== void 0);
	if (closed.length === 0) return;
	const record = upsertSessionMeta(project.meta, session);
	const log = (await readJson(join(project.dir, "log.json"))) ?? [];
	const seen = new Set(log.map((entry) => `${entry.sessionId}#${entry.turn}`));
	const additions = [];
	let lastActivity = record.lastActivityAt;
	let maxTurn = record.maxTurn ?? 0;
	for (const turn of closed) {
		const key = `${session.id}#${turn.turn}`;
		if (turn.turn <= maxTurn || seen.has(key)) continue;
		if (typeof turn.endedAt === "string" && (lastActivity === void 0 || turn.endedAt > lastActivity)) lastActivity = turn.endedAt;
		if (turn.turn > maxTurn) maxTurn = turn.turn;
		const toolCounts = new Map();
		for (const toolName of turn.tools) toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
		additions.push({
			time: turn.endedAt,
			sessionId: session.id,
			sessionTitle: record.title,
			turn: turn.turn,
			request: oneLine(turn.requests.join(" "), config.turnTextMaxChars),
			outcome: oneLine(turn.responses.join(" "), config.turnTextMaxChars),
			tools: [...toolCounts.entries()].map(([t, c]) => ({ name: t, count: c })),
			reason: turn.endReason
		});
	}
	if (additions.length > 0) {
		log.push(...additions);
	}
	record.maxTurn = maxTurn;
	record.turns = maxTurn;
	record.lastActivityAt = lastActivity;
	project.meta.counters.turns = project.meta.sessions.reduce((total, item) => total + (item.turns ?? 0), 0);
	project.meta.updatedAt = lastActivity ?? new Date().toISOString();
	const trimmed = log.slice(-config.maxLogEntries);
	await writeJson(join(project.dir, "log.json"), trimmed);
	await writeJson(project.metaPath, project.meta);
	await renderProgress(project, trimmed, config);
	return additions.length;
}

/** 追加一条交接笔记。 */
async function appendNote(project, session, note, config) {
	const notes = (await readJson(join(project.dir, "notes.json"))) ?? [];
	notes.push({
		time: new Date().toISOString(),
		sessionId: session?.id ?? void 0,
		note
	});
	await writeJson(join(project.dir, "notes.json"), notes.slice(-config.maxLogEntries));
	const log = (await readJson(join(project.dir, "log.json"))) ?? [];
	await renderProgress(project, log, config);
}

/** 规则摘要（LLM 不可用时的回退）：基于最近活动拼接。 */
function fallbackDigest(log, notes, maxEntries = 3) {
	const lines = [];
	for (const entry of [...log].slice(-maxEntries)) {
		lines.push(`- [${entry.time}] 会话「${entry.sessionTitle ?? entry.sessionId}」回合 ${entry.turn}：${entry.request || "(无请求文本)"}${entry.outcome ? ` → ${entry.outcome}` : ""}`);
	}
	if (notes.length > 0) {
		lines.push(`- 交接笔记 ${notes.length} 条（见下方）。`);
	}
	return lines.length > 0 ? lines.join("\n") : "暂无活动记录。";
}

/** 生成 progress.md。 */
async function renderProgress(project, log, config) {
	const meta = project.meta;
	const notes = (await readJson(join(project.dir, "notes.json"))) ?? [];
	const digest = await readFile(join(project.dir, "digest.txt"), "utf8").catch(() => void 0);
	const recent = [...log].slice(-config.maxRecentActivity).reverse();
	const lines = [];
	lines.push(`# 项目进展：${meta.title}`);
	lines.push("");
	lines.push(`- 项目路径：\`${meta.path}\``);
	lines.push(`- 项目 ID：${meta.id}`);
	lines.push(`- 创建时间：${meta.createdAt}`);
	lines.push(`- 最近更新：${meta.updatedAt}`);
	lines.push(`- 会话数：${meta.sessions.length}｜回合总数：${meta.counters.turns}`);
	const latestSession = [...meta.sessions].sort((a, b) => String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? "")))[0];
	if (latestSession) lines.push(`- 最近会话：${latestSession.title ?? latestSession.id}（${latestSession.lastActivityAt ?? "无活动"}）`);
	lines.push("");
	lines.push("## 当前状态");
	lines.push(digest && digest.trim().length > 0 ? digest.trim() : fallbackDigest(log, notes));
	lines.push("");
	lines.push("## 交接笔记");
	if (notes.length === 0) {
		lines.push("（无）");
	} else {
		for (const item of notes) {
			lines.push(`- [${item.time}] ${item.sessionId ? `会话 ${item.sessionId}：` : ""}${oneLine(item.note, 600)}`);
		}
	}
	lines.push("");
	lines.push("## 最近活动");
	if (recent.length === 0) {
		lines.push("（暂无）");
	} else {
		for (const entry of recent) {
			const title = entry.sessionTitle ?? entry.sessionId;
			lines.push(`- [${entry.time}] 会话「${title}」回合 ${entry.turn}：${entry.request || "(无请求文本)"}${entry.outcome ? ` → ${entry.outcome}` : ""}${entry.tools.length > 0 ? `｜工具：${entry.tools.map((t) => `${t.name}×${t.count}`).join("、")}` : ""}`);
		}
	}
	lines.push("");
	lines.push("## 会话");
	for (const item of meta.sessions) {
		lines.push(`- ${item.id}｜${item.title ?? "（未命名）"}｜创建 ${item.createdAt}｜回合 ${item.turns}｜${item.lastActivityAt ? `最后活动 ${item.lastActivityAt}` : "无活动"}`);
	}
	lines.push("");
	await writeText(join(project.dir, "progress.md"), lines.join("\n"));
}

/** 供注入/工具使用的紧凑摘要文本。 */
async function buildInjectText(project, config) {
	const log = (await readJson(join(project.dir, "log.json"))) ?? [];
	const notes = (await readJson(join(project.dir, "notes.json"))) ?? [];
	const digest = await readFile(join(project.dir, "digest.txt"), "utf8").catch(() => void 0);
	const recent = [...log].slice(-3).reverse();
	const lines = [];
	lines.push(`项目「${project.meta.title}」进展摘要（${project.meta.updatedAt}）`);
	lines.push(`项目路径：${project.meta.path}｜会话 ${project.meta.sessions.length} 个｜回合 ${project.meta.counters.turns} 个`);
	lines.push("");
	if (digest && digest.trim().length > 0) {
		lines.push("当前状态：");
		lines.push(digest.trim());
	} else {
		lines.push("当前状态：");
		lines.push(fallbackDigest(log, notes));
	}
	if (notes.length > 0) {
		lines.push("");
		lines.push("交接笔记：");
		for (const item of notes.slice(-5)) lines.push(`- ${oneLine(item.note, 400)}`);
	}
	if (recent.length > 0) {
		lines.push("");
		lines.push("最近活动：");
		for (const entry of recent) {
			lines.push(`- [${entry.time}] 回合 ${entry.turn}：${entry.request || "(无请求文本)"}${entry.outcome ? ` → ${entry.outcome}` : ""}`);
		}
	}
	const text = lines.join("\n");
	return truncate(text, config.maxInjectChars);
}

// ---------------------------------------------------------------------------
// LLM 摘要
// ---------------------------------------------------------------------------

function digestSystemPrompt() {
	return [
		"你是项目进展摘要器。根据给定的项目信息和最近活动日志，生成一段简洁的项目“当前状态”。",
		"要求：",
		"- 使用中文，3-8 句话，纯文本，不要 Markdown 标题、列表符号、代码块或前缀。",
		"- 依次覆盖：项目在做什么、已完成的关键事项、当前进展与遇到的问题、下一步建议、遗留问题/待确认事项。",
		"- 只基于给定信息，不要编造任何内容。",
		"- 直接输出摘要正文，不要任何解释。"
	].join("\n");
}

async function runDigest(ctx, config, project, sessionRouteOverride) {
	const log = (await readJson(join(project.dir, "log.json"))) ?? [];
	const notes = (await readJson(join(project.dir, "notes.json"))) ?? [];
	if (log.length === 0 && notes.length === 0) return void 0;
	const route = config.provider && config.model
		? { provider: config.provider, model: config.model }
		: sessionRouteOverride;
	if (route === void 0) {
		ctx.logger.warn(`project-progress: 无可用模型路由，跳过「${project.meta.title}」的摘要生成`);
		return void 0;
	}
	const input = truncate(
		[
			`项目标题：${project.meta.title}`,
			`项目路径：${project.meta.path}`,
			`会话数：${project.meta.sessions.length}，回合总数：${project.meta.counters.turns}`,
			"",
			"最近活动日志（时间 会话 回合：请求 → 回复｜工具）：",
			...[...log].slice(-40).map((entry) => `- [${entry.time}] ${entry.sessionTitle ?? entry.sessionId} #${entry.turn}：${entry.request || "(无请求文本)"}${entry.outcome ? ` → ${entry.outcome}` : ""}${entry.tools.length > 0 ? `｜工具：${entry.tools.map((t) => `${t.name}×${t.count}`).join("、")}` : ""}`),
			...notes.length > 0 ? ["", "交接笔记：", ...notes.map((item) => `- ${item.note}`)] : []
		].join("\n"),
		config.digestMaxInputChars
	);
	const messages = [createUserMessage({
		content: [{
			type: "text",
			text: `请生成项目「${project.meta.title}」的当前状态摘要：\n\n${input}`
		}],
		source: {
			kind: "plugin",
			plugin: name
		}
	})];
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("digest timeout")), config.digestTimeoutMs);
	try {
		const options = deepFreeze({
			provider: route.provider,
			model: route.model,
			messages,
			system: digestSystemPrompt(),
			maxTokens: config.maxDigestTokens,
			sessionId: project.meta.sessions[0]?.id,
			purpose: "project-progress-digest",
			signal: controller.signal
		});
		const assembler = new BlockAssembler();
		for await (const chunk of ctx.llm.stream(options)) {
			if (controller.signal.aborted) break;
			assembler.push(chunk);
		}
		if (controller.signal.aborted) throw controller.signal.reason ?? new Error("digest aborted");
		const finish = assembler.finish;
		if (finish.kind !== "stop") {
			if (finish.kind === "error" || finish.kind === "aborted") throw finish.failure ? new Error(finish.failure.message) : new Error("digest failed");
			throw new Error(`digest finished with ${String(finish.kind)}`);
		}
		const blocks = assembler.blocks();
		const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ").trim();
		if (text.length === 0) throw new Error("digest produced no text");
		await writeText(join(project.dir, "digest.txt"), text);
		// 摘要写入后重渲染 progress.md（调用方保证在项目写队列中串行执行）。
		const freshLog = (await readJson(join(project.dir, "log.json"))) ?? [];
		await renderProgress(project, freshLog, config);
		return text;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function apply(ctx, config) {
	const resolved = resolveConfig(config);
	const writeQueues = new Map();
	const lastDigestAt = new Map();

	/** 每个项目串行化文件写入，避免并发写坏 progress.md。 */
	function enqueue(key, task) {
		const tail = (writeQueues.get(key) ?? Promise.resolve())
			.then(task)
			.catch((error) => {
				ctx.logger.warn(`project-progress: 写入项目「${key}」失败: %o`, error);
			});
		writeQueues.set(key, tail);
		tail.finally(() => {
			if (writeQueues.get(key) === tail) writeQueues.delete(key);
		});
		return tail;
	}

	/** 打开项目（自动创建）并把写入任务入队。 */
	function withProject(session, fn, { create = true } = {}) {
		return openProject(resolved.projectsDir, session, { create }).then((project) => {
			if (project === void 0) return void 0;
			return enqueue(project.key, () => fn(project));
		});
	}

	/** 调度（去抖）一次 LLM 摘要；整个摘要+重渲染串行进项目写队列。 */
	function scheduleDigest(project, route) {
		if (!resolved.llmDigest) return;
		const key = project.key;
		const now = Date.now();
		const last = lastDigestAt.get(key) ?? 0;
		if (now - last < resolved.digestMinIntervalMs) return;
		lastDigestAt.set(key, now);
		enqueue(key, () => runDigest(ctx, resolved, project, route).catch((error) => {
			ctx.logger.warn(`project-progress: 摘要生成失败（项目「${project.meta.title}」）: %o`, error);
		}));
	}

	/** 回合结束 → 记录 + 调度摘要。 */
	function onTurnEnd(session) {
		const turns = collectTurns(session);
		if (turns.length === 0) return;
		const route = sessionRoute(session);
		withProject(session, (project) => recordTurns(project, session, turns, resolved)).then(() => {
			// 回合记录写入完成后再调度摘要，保证摘要读到最新 log.json。
			return openProject(resolved.projectsDir, session, { create: false }).then((project) => {
				if (project !== void 0) scheduleDigest(project, route);
			});
		}).catch((error) => {
			ctx.logger.warn(`project-progress: 回合记录/摘要调度失败: %o`, error);
		});
	}

	/**
	* 补建项目文件：为已存在的会话（含插件安装前的历史会话）生成项目进展记录。
	* liveOnly=true 只处理当前活跃会话（启动时自动跑）；false 则扫描全部持久化会话。
	* 幂等：已有记录按 maxTurn/日志去重，重复执行安全。
	*/
	async function backfill({ liveOnly = true } = {}) {
		const stats = { projects: 0, sessions: 0, turns: 0, skipped: 0 };
		const seenKeys = new Set();
		const processOne = async (sessionLike) => {
			if (typeof sessionLike?.header?.cwd !== "string" || sessionLike.header.cwd.length === 0) return;
			const key = `${sessionLike.header.cwd}\u0000${sessionLike.id}`;
			if (seenKeys.has(key)) return;
			seenKeys.add(key);
			try {
				const turns = collectTurns(sessionLike);
				const project = await openProject(resolved.projectsDir, sessionLike, { create: true });
				if (project === void 0) return;
				const added = await enqueue(project.key, () => recordTurns(project, sessionLike, turns, resolved));
				if (added > 0) {
					stats.projects += 1;
					stats.turns += added;
				}
				stats.sessions += 1;
			} catch (error) {
				stats.skipped += 1;
				ctx.logger.warn(`project-progress: 补建会话「${sessionLike.id}」失败: %o`, error);
			}
		};
		const pool = [];
		const run = (sessionLike) => {
			const task = processOne(sessionLike).finally(() => {
				const index = pool.indexOf(task);
				if (index >= 0) pool.splice(index, 1);
			});
			pool.push(task);
			return task;
		};
		const drain = async () => {
			while (pool.length >= 3) await Promise.race(pool);
		};
		if (liveOnly) {
			for (const session of ctx.sessions.list()) {
				await drain();
				run(session);
			}
		} else {
			let headers = [];
			try {
				headers = await ctx.sessionPersistence.list();
			} catch (error) {
				ctx.logger.warn(`project-progress: 无法枚举持久化会话: %o`, error);
			}
			for (const header of headers) {
				await drain();
				const sessionLike = {
					id: header.id,
					header: { cwd: header.cwd },
					events: []
				};
				// inspect 会补上完整事件（含会话标题），活跃会话走 inspectLive。
				try {
					const inspection = await ctx.sessionPersistence.inspect(header.id);
					sessionLike.events = inspection.events;
					if (inspection.meta?.cwd !== void 0) sessionLike.header.cwd = inspection.meta.cwd;
				} catch (error) {
					stats.skipped += 1;
					ctx.logger.warn(`project-progress: 读取会话「${header.id}」失败，跳过: %o`, error);
					continue;
				}
				run(sessionLike);
			}
		}
		await Promise.all(pool);
		return stats;
	}

	// 启动补建：插件激活后，为当前活跃会话补建项目文件（延迟片刻让启动稳定）。
	setTimeout(() => {
		backfill({ liveOnly: true }).then((stats) => {
			if (stats.sessions > 0) ctx.logger.info(`project-progress: 启动补建完成，处理 ${stats.sessions} 个活跃会话（新增 ${stats.turns} 条回合记录，跳过 ${stats.skipped}）`);
		}).catch((error) => {
			ctx.logger.warn(`project-progress: 启动补建失败: %o`, error);
		});
	}, 2000).unref?.();

	// ── 会话生命周期 ──────────────────────────────────────────────────────
	ctx.on("session/created", (session) => {
		try {
			withProject(session, async (project) => {
				upsertSessionMeta(project.meta, session);
				project.meta.updatedAt = new Date().toISOString();
				await writeJson(project.metaPath, project.meta);
			});
		} catch (error) {
			ctx.logger.warn(`project-progress: session/created 处理失败: %o`, error);
		}
	});

	ctx.on("session/event", (session, event) => {
		try {
			if (event.type === "turn/end") onTurnEnd(session);
		} catch (error) {
			ctx.logger.warn(`project-progress: session/event 处理失败: %o`, error);
		}
	});

	ctx.on("session/disposed", (session) => {
		try {
			withProject(session, async (project) => {
				project.meta.updatedAt = new Date().toISOString();
				await writeJson(project.metaPath, project.meta);
			}, { create: false });
		} catch (error) {
			ctx.logger.warn(`project-progress: session/disposed 处理失败: %o`, error);
		}
	});

	// ── 新会话自动注入进展摘要 ────────────────────────────────────────────
	ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject") return decision;
		try {
			if (step !== 1) return decision;
			if (!resolved.autoInject || resolved.maxInjectChars <= 0) return decision;
			if (agent?.session === void 0) return decision;
			if (sessionHasPriorTurns(agent.session)) return decision;
			let root = false;
			try {
				root = ctx.agents.roots().includes(agent);
			} catch {
				root = true;
			}
			if (!root) return decision;
			signal?.throwIfAborted();
			const project = await openProject(resolved.projectsDir, agent.session, { create: false });
			if (project === void 0) return decision;
			const log = (await readJson(join(project.dir, "log.json"))) ?? [];
			const notes = (await readJson(join(project.dir, "notes.json"))) ?? [];
			if (log.length === 0 && notes.length === 0) return decision;
			signal?.throwIfAborted();
			const text = await buildInjectText(project, resolved);
			if (text.length === 0) return decision;
			const desired = createUserMessage({
				content: text,
				source: {
					kind: "plugin",
					plugin: name,
					form: "notice",
					summary: "project progress digest"
				}
			});
			const already = decision.messages.some((message) => JSON.stringify(message.content) === JSON.stringify(desired.content));
			if (already) return decision;
			const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
			return {
				kind: "enter",
				messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
			};
		} catch (error) {
			ctx.logger.warn(`project-progress: 进展注入失败: %o`, error);
			return decision;
		}
	});

	// ── 系统提示：告知模型可用工具 ────────────────────────────────────────
	ctx.systemPrompt.section({
		name: "tool:project-progress",
		order: 210,
		text: "项目进展已由 dsh-project-progress 自动记录。需要了解本项目历史进展、或在上下文不足时接手项目，请调用 get_project_progress；需要给后续会话留交接说明，请调用 update_project_progress。"
	});

	// ── 工具 ──────────────────────────────────────────────────────────────
	const renderJson = (_args, value) => [{
		type: "text",
		text: JSON.stringify(value)
	}];

	ctx.tools.register(defineTool({
		name: "get_project_progress",
		description: "Read the current project progress document (what has been done, current state, handoff notes) for the caller's workspace, so a fresh session can quickly understand project history when context is limited or a previous session ran out of context.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					project: { type: "string", required: true },
					path: { type: "string", required: true },
					progress: { type: "string", required: true },
					updatedAt: { type: "string", required: true }
				}
			},
			render: renderJson
		},
		execute: async (_args, exec) => {
			const session = exec?.agent?.session;
			if (session === void 0) return { project: "", path: "", progress: "（无当前会话）", updatedAt: "" };
			const project = await openProject(resolved.projectsDir, session, { create: false });
			if (project === void 0) return { project: "", path: "", progress: "（该项目尚无进展记录）", updatedAt: "" };
			const progress = await readFile(join(project.dir, "progress.md"), "utf8").catch(() => "（progress.md 尚未生成）");
			return {
				project: project.meta.title,
				path: join(project.dir, "progress.md"),
				progress: truncate(progress, 20000),
				updatedAt: project.meta.updatedAt
			};
		},
		presentCall: () => present("Read project progress", "read")
	}));

	ctx.tools.register(defineTool({
		name: "update_project_progress",
		description: "Append a handoff note to the current project's progress record (e.g. decisions made, next steps, pending issues) so a later session can quickly pick up. The note is persisted and shown to new sessions in the same workspace.",
		parameters: {
			note: {
				type: "string",
				required: true,
				description: "A concise Chinese (or the project's language) note, one or two sentences, describing what a later session should know."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true }
				}
			},
			render: renderJson
		},
		execute: async (args, exec) => {
			const session = exec?.agent?.session;
			const note = typeof args?.note === "string" ? args.note.trim() : "";
			if (note.length === 0) return { ok: false, message: "note 不能为空" };
			if (session === void 0) return { ok: false, message: "（无当前会话）" };
			const project = await openProject(resolved.projectsDir, session, { create: true });
			if (project === void 0) return { ok: false, message: "无法定位项目工作区" };
			await enqueue(project.key, () => appendNote(project, session, note, resolved));
			return { ok: true, message: `已写入交接笔记（${project.meta.title}）` };
		},
		presentCall: (args) => present("Append project handoff note", "write", typeof args?.note === "string" ? args.note : void 0)
	}));

	// ── /project 命令 ─────────────────────────────────────────────────────
	ctx.commands.register({
		name: "project",
		description: "查看当前工作区的项目进展；`/project sync` 立即刷新摘要，`/project path` 输出进展文件路径，`/project backfill` 为历史会话补建项目文件",
		input: {
			hint: "[sync|path|backfill]"
		},
		handler: async (invocation) => {
			const agent = invocation?.agent;
			const session = agent?.session;
			const raw = String(invocation?.rawInput ?? "").trim().toLowerCase();
			if (session === void 0) return { kind: "error", text: "当前没有可用会话。" };
			const project = await openProject(resolved.projectsDir, session, { create: false });
			if (project === void 0) {
				return {
					kind: "success",
					text: "当前工作区还没有项目进展记录。发送第一条消息后会自动创建并开始记录。\n用法：/project（查看进展）｜/project sync（立即刷新摘要）｜/project path（进展文件路径）｜/project backfill（为历史会话补建项目文件）"
				};
			}
			if (raw === "path") {
				return { kind: "success", text: join(project.dir, "progress.md") };
			}
			if (raw === "sync") {
				enqueue(project.key, () => runDigest(ctx, resolved, project, sessionRoute(session)));
				return { kind: "success", text: `已触发「${project.meta.title}」的摘要刷新，稍后可用 /project 查看。` };
			}
			if (raw === "backfill") {
				const stats = await backfill({ liveOnly: false });
				return {
					kind: "success",
					text: [
						"历史补建完成：",
						`- 处理会话：${stats.sessions} 个`,
						`- 新增回合记录：${stats.turns} 条`,
						`- 涉及项目：${stats.projects} 个`,
						`- 跳过（无 cwd 或读取失败）：${stats.skipped} 个`,
						"",
						"用法：/project [sync|path|backfill]"
					].join("\n")
				};
			}
			if (raw.length > 0) return { kind: "error", text: `未知子命令：${raw}\n用法：/project [sync|path|backfill]` };
			const progress = await readFile(join(project.dir, "progress.md"), "utf8").catch(() => void 0);
			return {
				kind: "success",
				text: [
					`项目：${project.meta.title}`,
					`路径：${project.meta.path}`,
					`进展文件：${join(project.dir, "progress.md")}`,
					`最近更新：${project.meta.updatedAt}`,
					"",
					progress !== void 0 ? truncate(progress, 8000) : "（progress.md 尚未生成）",
					"",
					"用法：/project [sync|path|backfill]"
				].join("\n")
			};
		}
	});

	// 卸载清理
	ctx.effect(() => () => {
		writeQueues.clear();
		lastDigestAt.clear();
	}, "project-progress.cleanup");
}

export { Config, apply, inject, name };
