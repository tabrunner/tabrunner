/**
 * The trigger's answer to "what runs the next task", split at the seam the
 * composer squeezes on. Auto names its resolution so it never reads as a pinned
 * choice; effort rides only when the user set one ("default" = the knob is
 * never sent, and stays unsaid).
 *
 * `model` truncates and `effort` does not: a model id abbreviates fine
 * ("claude-3-5-sonnet-2024…" still reads), but an effort clipped off the end
 * doesn't degrade — it just disappears, and a setting the user pinned by hand
 * silently stops being on screen. `full` keeps both for the tooltip, which has
 * no width to run out of.
 */
export interface EngineLabel {
  model: string;
  effort?: string;
  full: string;
}

export function engineLabel(opts: {
  auto: boolean;
  modelName?: string;
  autoText: string;
  effortLabel?: string;
}): EngineLabel {
  const model = opts.auto
    ? opts.modelName
      ? `${opts.autoText} · ${opts.modelName}`
      : opts.autoText
    : (opts.modelName ?? "");
  return {
    model,
    ...(opts.effortLabel ? { effort: opts.effortLabel } : {}),
    full: opts.effortLabel ? `${model} · ${opts.effortLabel}` : model,
  };
}
