import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "../types";

vi.mock("@/modules/browser/cdp-driver", () => ({
  isAttached: vi.fn(),
  tabOwner: vi.fn(),
  captureFrame: vi.fn(),
}));
vi.mock("@/modules/browser/capture", () => ({ captureVisibleTab: vi.fn() }));
vi.mock("@/modules/browser/indicator", () => ({
  withMarksHidden: (_tabId: number, act: () => Promise<unknown>) => act(),
}));
vi.mock("../store", () => ({
  MAX_FRAMES: 100,
  MAX_RECORDING_BYTES: 1_000_000,
  enforceBudget: vi.fn(async () => {}),
  patchRecording: vi.fn(async () => {}),
  putFrame: vi.fn(async (_frame: Frame) => {}),
  putRecording: vi.fn(async () => {}),
  settleFrame: vi.fn(async () => {}),
}));

import { captureFrame, isAttached, tabOwner } from "@/modules/browser/cdp-driver";
import { captureVisibleTab } from "@/modules/browser/capture";
import { putFrame } from "../store";
import { createRecorder } from "../recorder";

const jpeg = "data:image/jpeg;base64,AA==";
let activeTabId = 1;
const get = vi.fn(async (id: number) => ({
  id,
  windowId: 40,
  url: `https://tab${id}.example/`,
  title: `Tab ${id}`,
}));
const query = vi.fn(async () => [{ id: activeTabId, windowId: 40 }]);
const activationListeners = new Set<(info: chrome.tabs.OnActivatedInfo) => void>();
const onActivated = {
  addListener: (listener: (info: chrome.tabs.OnActivatedInfo) => void) =>
    activationListeners.add(listener),
  removeListener: (listener: (info: chrome.tabs.OnActivatedInfo) => void) =>
    activationListeners.delete(listener),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  activeTabId = 1;
  activationListeners.clear();
  (globalThis as Record<string, unknown>).chrome = { tabs: { get, query, onActivated } };
  vi.mocked(tabOwner).mockImplementation((id) => (id === 1 ? "a" : "b"));
  vi.mocked(isAttached).mockReturnValue(false);
  vi.mocked(captureFrame).mockResolvedValue({
    dataUrl: jpeg,
    viewport: { width: 800, height: 600 },
  });
  vi.mocked(captureVisibleTab).mockImplementation(async () => ({
    dataUrl: jpeg,
    tabId: activeTabId,
    title: `Tab ${activeTabId}`,
    url: `https://tab${activeTabId}.example/`,
  }));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const frames = () => vi.mocked(putFrame).mock.calls.map(([frame]) => frame);

const recorder = () =>
  createRecorder("chat", "Document this page", undefined, { ownerId: "a", tabId: () => 1 });

describe("recorder target isolation", () => {
  it("captures only its own attached target even when another tab is active", async () => {
    activeTabId = 2;
    vi.mocked(isAttached).mockReturnValue(true);
    await recorder().arm();
    expect(captureFrame).toHaveBeenCalledWith(1, 70);
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(frames()[0]).toMatchObject({
      url: "https://tab1.example/",
      viewport: { width: 800, height: 600 },
    });
    expect(frames()[0]?.blob).toBeInstanceOf(Blob);
  });

  it("does not capture a target claimed by another owner", async () => {
    vi.mocked(tabOwner).mockReturnValue("b");
    vi.mocked(isAttached).mockReturnValue(true);
    await recorder().arm();
    expect(captureFrame).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(frames()[0]?.gap).toBe("unattached");
  });

  it("records a gap before attach when a different tab is visible", async () => {
    activeTabId = 2;
    await recorder().arm();
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(frames()[0]?.gap).toBe("unattached");
  });

  it("captures the target's own window without attaching", async () => {
    await recorder().arm();
    expect(captureVisibleTab).toHaveBeenCalledWith(40);
    expect(captureFrame).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith({ active: true, windowId: 40 });
    expect(frames()[0]?.blob).toBeInstanceOf(Blob);
  });

  it("discards a visible screenshot if the user switches tabs while it is taken", async () => {
    vi.mocked(captureVisibleTab).mockImplementationOnce(async () => {
      activeTabId = 2;
      return { dataUrl: jpeg, tabId: 1, title: "Tab 1", url: "https://tab1.example/" };
    });
    await recorder().arm();
    expect(frames()[0]?.gap).toBe("unattached");
    expect(frames()[0]?.blob).toBeUndefined();
  });

  it("discards a screenshot after a transient switch even if the target is active again", async () => {
    vi.mocked(captureVisibleTab).mockImplementationOnce(async () => {
      for (const listener of activationListeners) listener({ tabId: 2, windowId: 40 });
      for (const listener of activationListeners) listener({ tabId: 1, windowId: 40 });
      return { dataUrl: jpeg, tabId: 1, title: "Tab 1", url: "https://tab1.example/" };
    });
    await recorder().arm();
    expect(frames()[0]?.gap).toBe("unattached");
    expect(frames()[0]?.blob).toBeUndefined();
    expect(activationListeners.size).toBe(0);
  });

  it("holds one target through capture and metadata lookup when the driver switches", async () => {
    let targetTabId = 1;
    vi.mocked(isAttached).mockReturnValue(true);
    vi.mocked(captureFrame).mockImplementationOnce(async () => {
      targetTabId = 2;
      return { dataUrl: jpeg, viewport: { width: 800, height: 600 } };
    });
    const run = createRecorder("chat", "Document this page", undefined, {
      ownerId: "a",
      tabId: () => targetTabId,
    });
    await run.arm();
    expect(captureFrame).toHaveBeenCalledWith(1, 70);
    expect(frames()[0]?.url).toBe("https://tab1.example/");
  });
});
