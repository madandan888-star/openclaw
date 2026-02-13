import type { ChannelId } from "../channels/plugins/types.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { loadChannelOutboundAdapter } from "../channels/plugins/outbound/load.js";
import { loadConfig } from "../config/config.js";
import { onAgentEvent } from "../infra/agent-events.js";

type MonitorSession = {
  runId: string;
  label?: string;
  task: string;
  model?: string;
  origin: DeliveryContext;
  startedAt: number;
  currentTool?: { name: string; toolCallId: string; args?: Record<string, unknown> };
  unsubscribe?: () => void;
  stopped: boolean;
};

const sessions = new Map<string, MonitorSession>();

let globalOrigin: DeliveryContext | undefined;
let globalDelayTimer: NodeJS.Timeout | undefined;
let globalIntervalTimer: NodeJS.Timeout | undefined;

function formatElapsed(startedAt: number): string {
  const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
  if (elapsedSeconds >= 60) {
    const m = Math.floor(elapsedSeconds / 60);
    const s = elapsedSeconds % 60;
    return `${m}m ${s}s`;
  }
  return `${elapsedSeconds}s`;
}

function shortModelName(model: string): string {
  // "gpt-5.3-codex" → "gpt5.3", "anthropic/claude-opus-4-6" → "opus4.6", etc.
  const m = model.includes("/") ? model.split("/").pop()! : model;
  if (m.includes("claude-opus")) {
    return m.replace(/claude-opus-(\S+)/, "opus$1");
  }
  if (m.includes("claude-sonnet")) {
    return m.replace(/claude-sonnet-(\S+)/, "sonnet$1");
  }
  if (m.startsWith("gpt-")) {
    return m.replace("gpt-", "gpt").replace("-codex", "");
  }
  if (m.startsWith("o")) {
    return m;
  } // o3, o4-mini, etc.
  return m;
}

function summarizeToolCall(name: string, args?: Record<string, unknown>): string {
  if (!args) {
    return `🔧 ${name}`;
  }
  switch (name) {
    case "read":
    case "Read": {
      const p = (args.path ?? args.file_path) as string | undefined;
      return p ? `📖 读取 ${truncPath(p)}` : `📖 读取文件`;
    }
    case "write":
    case "Write": {
      const p = (args.path ?? args.file_path) as string | undefined;
      return p ? `✏️ 写入 ${truncPath(p)}` : `✏️ 写入文件`;
    }
    case "edit":
    case "Edit": {
      const p = (args.path ?? args.file_path) as string | undefined;
      return p ? `✏️ 编辑 ${truncPath(p)}` : `✏️ 编辑文件`;
    }
    case "exec": {
      const cmd = args.command as string | undefined;
      return cmd ? `⚡ ${cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd}` : `⚡ 执行命令`;
    }
    case "web_search": {
      const q = args.query as string | undefined;
      return q ? `🔍 搜索: ${q.length > 40 ? q.slice(0, 37) + "..." : q}` : `🔍 网页搜索`;
    }
    case "web_fetch": {
      const url = args.url as string | undefined;
      return url ? `🌐 抓取 ${url.length > 50 ? url.slice(0, 47) + "..." : url}` : `🌐 抓取网页`;
    }
    case "message": {
      const action = args.action as string | undefined;
      return `💬 消息: ${action ?? "send"}`;
    }
    case "sessions_spawn":
      return `🐗 派遣半兽人`;
    case "memory_search":
      return `🧠 搜索记忆`;
    case "process": {
      const action = args.action as string | undefined;
      return `⚙️ 进程: ${action ?? "unknown"}`;
    }
    default:
      return `🔧 ${name}`;
  }
}

function truncPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 3) {
    return p;
  }
  return ".../" + parts.slice(-2).join("/");
}

function buildUnifiedProgressMessage(): string {
  const activeSessions = [...sessions.values()].filter((s) => !s.stopped);
  const header = `🔄 半兽人工作中（${activeSessions.length}路）`;
  if (activeSessions.length === 0) {
    return header;
  }

  activeSessions.sort((a, b) => a.startedAt - b.startedAt);

  const lines = activeSessions.map((session) => {
    const modelTag = session.model ? shortModelName(session.model) : "unknown";
    const label = session.label ?? session.runId.slice(0, 8);
    const elapsed = formatElapsed(session.startedAt);
    if (session.currentTool) {
      const detail = summarizeToolCall(session.currentTool.name, session.currentTool.args);
      return `• ${modelTag} | ${label} | ${detail} | ${elapsed}`;
    }
    return `• ${modelTag} | ${label} | 🤔 思考中... | ${elapsed}`;
  });

  return [header, ...lines].join("\n");
}

async function sendUnifiedProgress(): Promise<void> {
  if (!globalOrigin) {
    return;
  }
  const channel = globalOrigin.channel as ChannelId | undefined;
  const to = globalOrigin.to;
  if (!channel || !to) {
    return;
  }
  if (sessions.size === 0) {
    return;
  }

  try {
    const adapter = await loadChannelOutboundAdapter(channel);
    if (!adapter?.sendText) {
      console.error(`[subagent-monitor] no sendText adapter for channel=${channel}`);
      return;
    }
    const cfg = loadConfig();
    const text = buildUnifiedProgressMessage();
    await adapter.sendText({
      cfg,
      to,
      text,
      accountId: "subagent",
      threadId: globalOrigin.threadId ?? null,
    });
  } catch (err) {
    console.error(`[subagent-monitor] sendUnifiedProgress error:`, err);
  }
}

function maybeStartGlobalBroadcaster(delaySeconds: number, intervalSeconds: number): void {
  if (sessions.size === 0 || globalDelayTimer || globalIntervalTimer) {
    return;
  }

  globalDelayTimer = setTimeout(() => {
    globalDelayTimer = undefined;
    if (sessions.size === 0) {
      return;
    }

    void sendUnifiedProgress();

    globalIntervalTimer = setInterval(() => {
      void sendUnifiedProgress();
    }, intervalSeconds * 1000);
    globalIntervalTimer.unref?.();
  }, delaySeconds * 1000);
  globalDelayTimer.unref?.();
}

function stopGlobalBroadcasterIfIdle(): void {
  if (sessions.size !== 0) {
    return;
  }
  if (globalDelayTimer) {
    clearTimeout(globalDelayTimer);
    globalDelayTimer = undefined;
  }
  if (globalIntervalTimer) {
    clearInterval(globalIntervalTimer);
    globalIntervalTimer = undefined;
  }
  globalOrigin = undefined;
}

export function startSubagentMonitor(params: {
  runId: string;
  label?: string;
  task: string;
  model?: string;
  origin?: DeliveryContext;
}): void {
  const cfg = loadConfig();
  const monitorConfig = cfg.agents?.defaults?.subagents?.monitor;
  if (!monitorConfig?.enabled) {
    return;
  }
  if (!params.origin?.channel || !params.origin?.to) {
    return;
  }
  if (sessions.has(params.runId)) {
    return;
  }

  const delaySeconds = monitorConfig.delaySeconds ?? 5;
  const intervalSeconds = monitorConfig.intervalSeconds ?? 10;

  const session: MonitorSession = {
    runId: params.runId,
    label: params.label,
    task: params.task,
    model: params.model,
    origin: params.origin,
    startedAt: Date.now(),
    stopped: false,
  };

  // Capture the origin of the first registered session for the global broadcaster.
  if (sessions.size === 0 && !globalOrigin) {
    globalOrigin = params.origin;
  }

  // Subscribe to agent events for this run.
  session.unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== params.runId || session.stopped) {
      return;
    }

    if (evt.stream === "tool") {
      const phase = evt.data?.phase;
      if (phase === "start") {
        const name = typeof evt.data?.name === "string" ? evt.data.name : "unknown";
        const toolCallId = typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId : "";
        const args =
          evt.data?.args && typeof evt.data.args === "object"
            ? (evt.data.args as Record<string, unknown>)
            : undefined;
        session.currentTool = { name, toolCallId, args };
      } else if (phase === "result") {
        const toolCallId = typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId : "";
        if (session.currentTool && session.currentTool.toolCallId === toolCallId) {
          session.currentTool = undefined;
        }
      }
    } else if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        stopSubagentMonitor(params.runId);
      }
    }
  });

  sessions.set(params.runId, session);

  // One unified global broadcaster (no per-session timers).
  maybeStartGlobalBroadcaster(delaySeconds, intervalSeconds);
}

export function stopSubagentMonitor(runId: string): void {
  const session = sessions.get(runId);
  if (!session) {
    return;
  }
  session.stopped = true;
  if (session.unsubscribe) {
    session.unsubscribe();
    session.unsubscribe = undefined;
  }
  sessions.delete(runId);
  stopGlobalBroadcasterIfIdle();
}

export function cleanupAllSubagentMonitors(): void {
  for (const runId of sessions.keys()) {
    stopSubagentMonitor(runId);
  }
}
