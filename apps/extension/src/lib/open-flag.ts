/**
 * A module-level boolean with subscribe semantics — the open state of a
 * singleton dialog, shared so non-component code (slash commands, menus,
 * gestures) can flip what one component renders. React-free on purpose: the
 * owning file pairs `subscribe`/`get` with `useSyncExternalStore` itself.
 */
export function createOpenFlag() {
  let open = false;
  const listeners = new Set<() => void>();
  return {
    get: (): boolean => open,
    set(next: boolean): void {
      if (open === next) return;
      open = next;
      for (const l of listeners) l();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
