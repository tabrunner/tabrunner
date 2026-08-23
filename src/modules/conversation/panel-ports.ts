/**
 * Every open side panel — an external agent starting work must reach them all —
 * mapped to the window it lives in (its `hello`, undefined until that lands).
 * The window matters: notifications are gated on whether the user can see the
 * panel, and "a panel is open" plus "a window is focused" can be two facts
 * about two different windows.
 *
 * It lives in the conversation module rather than in the background entrypoint
 * because two very different consumers ask it questions: the entrypoint, which
 * broadcasts to every panel and gates OS notifications, and a run, which asks
 * whether anybody is watching before it moves the user's screen. One map, so
 * there is no mirrored counter to drift out of sync with the real ports.
 */
export const panelPorts = new Map<chrome.runtime.Port, number | undefined>();

/**
 * Is anyone watching? The live answer that replaced a start-time flag: a run
 * brings a switched-to tab forward only while a panel is open, so closing the
 * panel mid-run stops the following exactly as dispatching the run unattended
 * would have. Foreground and background are the same run — the difference is
 * only whether the panel is still there.
 */
export function isPanelOpen(): boolean {
  return panelPorts.size > 0;
}
