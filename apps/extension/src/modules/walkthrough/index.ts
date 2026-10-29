/**
 * Page-safe surface only. `recorder.ts` is deliberately NOT re-exported here:
 * it reaches into the CDP driver, and a barrel that drags the debugger into
 * every importer would put it in the panel bundle, the viewer bundle, and the
 * background entrypoint's build-time evaluation. Its one consumer imports it
 * by path.
 */
export { buildSteps } from "./caption";
export { buildDocHtml, docFilename } from "./doc-html";
export { recordingIdFromUrl } from "./viewer-url";
export { loadRecording, recoverInterrupted, removeRecordingsFor } from "./store";
export type { DocStep, Recording } from "./types";
