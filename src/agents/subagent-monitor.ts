import type { ChannelId } from "../channels/plugins/types.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { loadChannelOutboundAdapter } from "../channels/plugins/outbound/load.js";
import { loadConfig } from "../config/config.js";
import { onAgentEvent } from "../infra/agent-events.js";

type MonitorSession = {
  runId: string;
  label?: string;
  task: string;
  origin: DeliveryContext;
  startedAt: number;
  currentTool?: { name: string; toolCallId: string };
  delayTimer?: NodeJS.Timeout;
  progressTimer?: NodeJS.Timeout;
  unsubscribe?: () => void;
  stopped: boolean;
};

const sessions = new Map<string, MonitorSession>();

function formatElapsed(startedAt: number): string {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  return `${elapsed}s`;
}

function buildProgressMessage(session: MonitorSession): string {
  const label = session.label ?? session.runId.slice(0, 8);
  const elapsed = formatElapsed(session.startedAt);
  const action = session.currentTool ? `正在执行: ${session.currentTool.name}` : "思考中...";
  return `⏳ [${label}] ${action} | 已运行 ${elapsed}`;
}

async function sendProgress(session: MonitorSession): Promise<void> {
  if (session.stopped) {
    return;
  }
  const { origin } = session;
  const channel = origin.channel as ChannelId | undefined;
  const to = origin.to;
  if (!channel || !to) {
    return;
  }

  try {
    const adapter = await loadChannelOutboundAdapter(channel);
    if (!adapter?.sendText) {
      console.error(`[subagent-monitor] no sendText adapter for channel=${channel}`);
      return;
    }
    const cfg = loadConfig();
    const text = buildProgressMessage(session);
    await adapter.sendText({
      cfg,
      to,
      text,
      accountId: origin.accountId ?? null,
      threadId: origin.threadId ?? null,
    });
  } catch (err) {
    console.error(`[subagent-monitor] sendProgress error:`, err);
  }
}

function startProgressTimer(session: MonitorSession, intervalSeconds: number): void {
  if (session.stopped) {
    return;
  }
  session.progressTimer = setInterval(() => {
    void sendProgress(session);
  }, intervalSeconds * 1000);
  session.progressTimer.unref?.();
}

export function startSubagentMonitor(params: {
  runId: string;
  label?: string;
  task: string;
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

  const delaySeconds = monitorConfig.delaySeconds ?? 5;
  const intervalSeconds = monitorConfig.intervalSeconds ?? 10;

  const session: MonitorSession = {
    runId: params.runId,
    label: params.label,
    task: params.task,
    origin: params.origin,
    startedAt: Date.now(),
    stopped: false,
  };

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
        session.currentTool = { name, toolCallId };
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

  // Start with a delay; only begin progress ticks if the subagent is still running.
  session.delayTimer = setTimeout(() => {
    if (session.stopped) {
      return;
    }
    // Send the first progress message immediately after the delay.
    void sendProgress(session);
    startProgressTimer(session, intervalSeconds);
  }, delaySeconds * 1000);
  session.delayTimer.unref?.();

  sessions.set(params.runId, session);
}

export function stopSubagentMonitor(runId: string): void {
  const session = sessions.get(runId);
  if (!session) {
    return;
  }
  session.stopped = true;
  if (session.delayTimer) {
    clearTimeout(session.delayTimer);
    session.delayTimer = undefined;
  }
  if (session.progressTimer) {
    clearInterval(session.progressTimer);
    session.progressTimer = undefined;
  }
  if (session.unsubscribe) {
    session.unsubscribe();
    session.unsubscribe = undefined;
  }
  sessions.delete(runId);
}

export function cleanupAllSubagentMonitors(): void {
  for (const runId of sessions.keys()) {
    stopSubagentMonitor(runId);
  }
}
