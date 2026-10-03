/** Visibility only: hiding controls must never turn off workspace isolation. */
export function useWorkspaceIsolationControls() {
  return { visible: true, loaded: true };
}
