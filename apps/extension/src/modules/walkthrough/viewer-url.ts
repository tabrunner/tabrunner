/**
 * The full-page walkthrough viewer's address. One helper because three callers
 * build it (the chat card, Settings, and the viewer's own reload), and a
 * hand-typed query key would drift.
 */
export function viewerUrl(recordingId: string): string {
  return `${chrome.runtime.getURL("/walkthrough.html")}?r=${encodeURIComponent(recordingId)}`;
}

/** The id this viewer was opened for, or null when the link was malformed. */
export function recordingIdFromUrl(href: string): string | null {
  try {
    return new URL(href).searchParams.get("r");
  } catch {
    return null;
  }
}
