import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveRun } from "@/modules/agent/active-runs";
import { buildConversationHistory } from "@/modules/agent/history";
import { listQueue, submitRun } from "@/modules/agent/run-queue";
import { startAgentRun } from "@/modules/agent/start-run";
import { flushConversationWrites, getMessages } from "@/modules/conversation/conversations";
import type { Message } from "@/modules/conversation/types";
import { alarmNameFor } from "../alarms";
import { onScheduleAlarm } from "../scheduler";
import { getSchedule, saveSchedule } from "../store";
import type { Schedule } from "../types";

vi.mock("@/modules/agent/active-runs", () => ({ getActiveRun: vi.fn() }));
vi.mock("@/modules/agent/run-queue", () => ({
  listQueue: vi.fn(),
  submitRun: vi.fn(),
  cancelQueued: vi.fn(),
}));
vi.mock("@/modules/agent/start-run", () => ({ startAgentRun: vi.fn() }));

const at = (h: number, min: number) => new Date(2026, 7, 20, h, min).getTime();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(12, 17));
  vi.mocked(getActiveRun).mockReturnValue(null);
  vi.mocked(listQueue).mockReturnValue([]);
  vi.mocked(startAgentRun).mockResolvedValue({ ok: true });
  vi.mocked(submitRun).mockImplementation((entry) => {
    entry.launch();
    return { started: true };
  });
});

afterEach(async () => {
  await flushConversationWrites();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function seed(): Promise<Schedule> {
  const schedule: Schedule = {
    id: "hourly",
    task: "Find new invoices",
    url: "https://example.com/invoices",
    recurrence: { kind: "interval", everyMinutes: 60, minuteOfHour: 17 },
    conversationId: "invoice-checks",
    nextFireAt: at(12, 17),
    createdAt: at(11, 0),
  };
  await saveSchedule(schedule);
  return schedule;
}

async function fire(schedule: Schedule, launches: number): Promise<void> {
  onScheduleAlarm(alarmNameFor(schedule.id));
  await vi.waitFor(() => expect(startAgentRun).toHaveBeenCalledTimes(launches));
  await vi.mocked(startAgentRun).mock.results.at(-1)?.value;
  await flushConversationWrites();
}

describe("scheduled conversation history", () => {
  it("stores the task before launch and replays only previous fires", async () => {
    const storedAtLaunch: Message[][] = [];
    const histories: ReturnType<typeof buildConversationHistory>[] = [];
    vi.mocked(startAgentRun).mockImplementation(async (opts) => {
      const transcript = await getMessages(opts.conversationId);
      storedAtLaunch.push(transcript);
      histories.push(buildConversationHistory(transcript));
      opts.emit({ type: "done", summary: "Found invoice INV-42" });
      return { ok: true };
    });
    const schedule = await seed();

    await fire(schedule, 1);
    expect(storedAtLaunch[0]).toEqual([
      expect.objectContaining({ role: "user", content: schedule.task }),
    ]);
    expect(histories[0]).toEqual([]);
    await vi.waitFor(async () =>
      expect((await getSchedule(schedule.id))?.nextFireAt).toBe(at(13, 17)),
    );

    const current = await getSchedule(schedule.id);
    expect(current).toBeDefined();
    const nextTask = "Find invoices added after INV-42";
    await saveSchedule({ ...current!, task: nextTask });
    vi.setSystemTime(at(13, 17));
    await fire(schedule, 2);

    expect(storedAtLaunch[1]?.at(-1)).toMatchObject({ role: "user", content: nextTask });
    expect(histories[1]).toEqual([
      { role: "user", content: schedule.task },
      { role: "assistant", content: "Found invoice INV-42" },
    ]);
    expect(histories[1]?.some((message) => message.content === nextTask)).toBe(false);
  });

  it("stores a queued task before its launch is allowed to run", async () => {
    vi.mocked(submitRun).mockReturnValue({ queued: 1, id: "queued-check" });
    const schedule = await seed();

    onScheduleAlarm(alarmNameFor(schedule.id));
    await vi.waitFor(() => expect(submitRun).toHaveBeenCalledOnce());
    expect(startAgentRun).not.toHaveBeenCalled();
    expect(await getMessages(schedule.conversationId)).toEqual([
      expect.objectContaining({ role: "user", content: schedule.task }),
    ]);
    vi.mocked(submitRun).mock.calls[0]?.[0].launch();
    expect(startAgentRun).toHaveBeenCalledOnce();
  });
});

describe("hourly alarm advancement", () => {
  it("keeps the fixed minute after late delivery and stores the late note with the task", async () => {
    const armed = vi.spyOn(chrome.alarms, "create");
    const schedule = await seed();
    vi.setSystemTime(at(14, 41));

    await fire(schedule, 1);
    await vi.waitFor(async () =>
      expect((await getSchedule(schedule.id))?.nextFireAt).toBe(at(15, 17)),
    );
    expect(armed).toHaveBeenCalledWith(alarmNameFor(schedule.id), { when: at(15, 17) });
    const task = vi.mocked(startAgentRun).mock.calls[0]?.[0].task;
    expect(task).toContain(schedule.task);
    expect(task).toContain("starting late");
    expect((await getMessages(schedule.conversationId)).at(-1)?.content).toBe(task);
  });

  it("skips an overlapping run without appending a new task or losing the fixed minute", async () => {
    const schedule = await seed();
    vi.mocked(getActiveRun).mockReturnValue({
      conversationId: schedule.conversationId,
      owner: "schedule",
      controller: new AbortController(),
      injectedQueue: [],
      usage: { input: 0, output: 0, contextTokens: 0 },
    });
    vi.setSystemTime(at(12, 41));

    onScheduleAlarm(alarmNameFor(schedule.id));
    await vi.waitFor(async () =>
      expect((await getSchedule(schedule.id))?.nextFireAt).toBe(at(13, 17)),
    );
    expect(submitRun).not.toHaveBeenCalled();
    expect(await getMessages(schedule.conversationId)).toEqual([]);
  });
});
