// Small localStorage helpers for filter state that needs to survive page
// refresh. Used by the Portfolio* pages so operators don't have to re-apply
// status/role/company filters every time they navigate back.

export function readLsFilter<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLsFilter(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}
