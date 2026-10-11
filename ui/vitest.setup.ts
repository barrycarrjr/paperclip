const storageEntries = new Map<string, string>();

function installStorageMock(target: Record<string, unknown>) {
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storageEntries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageEntries.set(key, String(value));
      },
      removeItem: (key: string) => {
        storageEntries.delete(key);
      },
      clear: () => {
        storageEntries.clear();
      },
    },
  });
}

if (
  typeof globalThis.localStorage?.getItem !== "function"
  || typeof globalThis.localStorage?.setItem !== "function"
  || typeof globalThis.localStorage?.removeItem !== "function"
  || typeof globalThis.localStorage?.clear !== "function"
) {
  installStorageMock(globalThis);
}

if (typeof window !== "undefined" && window.localStorage !== globalThis.localStorage) {
  installStorageMock(window as unknown as Record<string, unknown>);
}

// The rich markdown editor's package loads a code sandbox whose styling library
// adds the rule "--sxs{--sxs:6}" as it loads. Browsers take it but jsdom cannot
// parse it, so tests that load the real editor would fail before they start. A
// rule jsdom can parse stands in for any rule it cannot.
if (typeof CSSStyleSheet !== "undefined") {
  const insertRule = CSSStyleSheet.prototype.insertRule;
  CSSStyleSheet.prototype.insertRule = function (rule: string, index?: number) {
    try {
      return insertRule.call(this, rule, index);
    } catch {
      return insertRule.call(this, ".jsdom-unparsable-rule{}", index);
    }
  };
}

// jsdom doesn't ship ResizeObserver, but radix-ui's popover/tooltip primitives
// register one as soon as they mount. A noop class is enough for tests that
// just need the components to render without throwing.
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: NoopResizeObserver,
  });
}
