// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, type UseMutationResult } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { useSaveMutation, type UseSaveMutationOptions } from "./useSaveMutation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

type Saved = { name: string };
type Options = UseSaveMutationOptions<Saved, Error, string>;

/**
 * A save the person asked for has to say whether it worked. A form keeps
 * showing what was typed, so without a message a save that worked looks
 * exactly like one that never happened.
 */
describe("useSaveMutation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mutation: UseMutationResult<Saved, Error, string> | null = null;

  function Harness({ options }: { options: Options }) {
    mutation = useSaveMutation(options);
    return null;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    mutation = null;
    vi.useRealTimers();
  });

  async function render(options: Options, { withToasts = true } = {}) {
    const queryClient = new QueryClient();
    const harness = <Harness options={options} />;
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          {withToasts ? (
            <ToastProvider>
              {harness}
              <ToastViewport />
            </ToastProvider>
          ) : (
            harness
          )}
        </QueryClientProvider>,
      );
    });
  }

  async function save(value: string) {
    await act(async () => {
      mutation?.mutate(value);
    });
    await flushReact();
  }

  /**
   * The live region, taken before anything is said. It has to be on the page
   * already: a screen reader often misses a region that appears together with
   * its first message. Reading the same element afterwards also fails if the
   * region was swapped for a new one.
   */
  function liveRegion() {
    const region = container.querySelector('[aria-live="polite"]');
    expect(region, "the live region is on the page before the save").not.toBeNull();
    return region as HTMLElement;
  }

  function messages() {
    return container.querySelectorAll('[data-testid="toast-stack"] > li');
  }

  it("says the save worked once the request succeeds, and not before", async () => {
    let finish: (saved: Saved) => void = () => {};
    await render({
      mutationFn: () =>
        new Promise<Saved>((resolve) => {
          finish = resolve;
        }),
      successMessage: "Settings saved",
    });
    const region = liveRegion();

    await save("Pat");
    expect(mutation?.isPending).toBe(true);
    expect(region.textContent).not.toContain("Settings saved");

    await act(async () => {
      finish({ name: "Pat" });
    });
    await flushReact();

    expect(region.textContent).toContain("Settings saved");
  });

  it("hands the page's own onSuccess the result and what was sent", async () => {
    const onSuccess = vi.fn();
    await render({
      mutationFn: async (name) => ({ name }),
      successMessage: "Settings saved",
      onSuccess,
    });
    const region = liveRegion();

    await save("Pat");

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0]?.[0]).toEqual({ name: "Pat" });
    expect(onSuccess.mock.calls[0]?.[1]).toBe("Pat");
    expect(region.textContent).toContain("Settings saved");
  });

  it("says nothing about saving when the save fails, and leaves the failure to the page", async () => {
    const onError = vi.fn();
    await render({
      mutationFn: () => Promise.reject(new Error("Name is taken")),
      successMessage: "Settings saved",
      onError,
    });

    await save("Pat");

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(container.textContent).not.toContain("Settings saved");
    // The page already shows its own errors here, so nothing is said twice.
    expect(container.textContent).not.toContain("Name is taken");
  });

  it("does not confirm a save whose follow-up on the page failed", async () => {
    await render({
      mutationFn: async (name) => ({ name }),
      successMessage: "Settings saved",
      onSuccess: () => {
        throw new Error("Could not refresh the list");
      },
    });

    await save("Pat");

    expect(mutation?.isError).toBe(true);
    expect(container.textContent).not.toContain("Settings saved");
  });

  it("can word the message from what was saved, or say nothing for one call", async () => {
    await render({
      mutationFn: async (name) => ({ name }),
      successMessage: (saved) => (saved.name === "quiet" ? null : `Saved ${saved.name}`),
    });
    const region = liveRegion();

    await save("quiet");
    expect(container.textContent).not.toContain("Saved");

    await save("Pat");
    expect(region.textContent).toContain("Saved Pat");
  });

  it("still counts a save that reached the server when its message cannot be worded", async () => {
    // An empty reply (a 204, say) reaches the wording function as undefined.
    const onError = vi.fn();
    await render({
      mutationFn: async () => undefined as unknown as Saved,
      successMessage: (saved) => `${saved.name} saved`,
      onError,
    });
    const region = liveRegion();

    await save("Pat");

    expect(mutation?.isSuccess).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(region.textContent).toContain("Saved");
  });

  it("shows a second save straight after the first as a new message of its own", async () => {
    vi.useFakeTimers();
    await render({ mutationFn: async (name) => ({ name }), successMessage: "Settings saved" });
    const region = liveRegion();

    await act(async () => {
      mutation?.mutate("Pat");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(messages()).toHaveLength(1);
    const first = messages()[0];

    // Shortly before the first message would fade, save again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      mutation?.mutate("Pat again");
      await vi.advanceTimersByTimeAsync(0);
    });

    // One message, not two, and a new one: an item left as it was would not
    // move or be read out, which is what a second save used to get.
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).not.toBe(first);
    expect(region.textContent).toContain("Settings saved");

    // Past the point the first message would have gone on its own, the
    // second one is still up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(messages()).toHaveLength(1);
    expect(region.textContent).toContain("Settings saved");
  });

  it("takes back its saved message when the next try fails", async () => {
    const mutationFn = vi
      .fn<(name: string) => Promise<Saved>>()
      .mockResolvedValueOnce({ name: "Pat" })
      .mockRejectedValueOnce(new Error("The budget is locked"));
    await render({
      mutationFn,
      successMessage: "Budget saved",
      errorMessage: "Could not save the budget",
    });
    const region = liveRegion();

    await save("Pat");
    expect(region.textContent).toContain("Budget saved");

    // Within the few seconds the first message is up.
    await save("Pat");

    expect(region.textContent).not.toContain("Budget saved");
    expect(region.textContent).toContain("Could not save the budget");
    expect(region.textContent).toContain("The budget is locked");
  });

  it("takes back its failure message when the next try works", async () => {
    const mutationFn = vi
      .fn<(name: string) => Promise<Saved>>()
      .mockRejectedValueOnce(new Error("The budget is locked"))
      .mockResolvedValueOnce({ name: "Pat" });
    await render({
      mutationFn,
      successMessage: "Budget saved",
      errorMessage: "Could not save the budget",
    });
    const region = liveRegion();

    await save("Pat");
    expect(region.textContent).toContain("Could not save the budget");

    // A failure stays until it is closed, so without this it sat next to
    // "Budget saved" after the retry worked.
    await save("Pat");

    expect(region.textContent).toContain("Budget saved");
    expect(region.textContent).not.toContain("Could not save the budget");
    expect(messages()).toHaveLength(1);
  });

  it("takes back its failure message when the next try works but has nothing to say", async () => {
    const mutationFn = vi
      .fn<(name: string) => Promise<Saved>>()
      .mockRejectedValueOnce(new Error("The budget is locked"))
      .mockResolvedValueOnce({ name: "quiet" });
    await render({
      mutationFn,
      successMessage: (saved) => (saved.name === "quiet" ? null : `Saved ${saved.name}`),
      errorMessage: "Could not save the budget",
    });
    const region = liveRegion();

    await save("Pat");
    expect(region.textContent).toContain("Could not save the budget");

    await save("quiet");

    expect(mutation?.isSuccess).toBe(true);
    expect(messages()).toHaveLength(0);
  });

  it("shows the same failure again when it happens again straight away", async () => {
    vi.useFakeTimers();
    await render({
      mutationFn: () => Promise.reject(new Error("Name is taken")),
      successMessage: "Settings saved",
      errorMessage: "Could not save settings",
    });
    const region = liveRegion();

    await act(async () => {
      mutation?.mutate("Pat");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(messages()).toHaveLength(1);
    const first = messages()[0];

    // A second try a moment later fails the same way. It used to be taken for
    // a duplicate of the first and dropped, so nothing moved and nothing was
    // read out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      mutation?.mutate("Pat");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).not.toBe(first);
    expect(region.textContent).toContain("Could not save settings");

    // Closed, then failing again within the same few seconds, it comes back.
    // It used to show nothing at all.
    await act(async () => {
      container
        .querySelector('button[aria-label="Dismiss notification"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(messages()).toHaveLength(0);
    await act(async () => {
      mutation?.mutate("Pat");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(messages()).toHaveLength(1);
    expect(region.textContent).toContain("Could not save settings");
    expect(region.textContent).toContain("Name is taken");
  });

  it("keeps one item's failure when the same hook then saves another item", async () => {
    // One hook for every budget card: Ada's card fails and keeps its typed
    // amount, then Bo's card saves fine.
    const mutationFn = vi
      .fn<(name: string) => Promise<Saved>>()
      .mockRejectedValueOnce(new Error("The budget is locked"))
      .mockResolvedValueOnce({ name: "Bo" })
      .mockResolvedValueOnce({ name: "Ada" });
    await render({
      mutationFn,
      successMessage: "Budget saved",
      errorMessage: (_error, name) => `Could not save the budget for ${name}`,
      saveKey: (name) => name,
    });
    const region = liveRegion();

    await save("Ada");
    expect(region.textContent).toContain("Could not save the budget for Ada");

    await save("Bo");

    // Bo's save took back Ada's failure, so Ada's card looked saved while it
    // still showed an amount that never went through.
    expect(region.textContent).toContain("Budget saved");
    expect(region.textContent).toContain("Could not save the budget for Ada");
    expect(region.textContent).toContain("The budget is locked");

    // Ada's own save that works still takes it back.
    await save("Ada");
    expect(region.textContent).not.toContain("Could not save the budget for Ada");
    expect(messages()).toHaveLength(1);
  });

  it("keeps another save's failure that has the same words", async () => {
    // Two saves on the page, as the costs page and an agent's budget both say
    // "Could not save the budget". Each failure used to be named by its words,
    // so the second replaced the first, and either save working took it back.
    const saves: Array<UseMutationResult<Saved, Error, string> | null> = [null, null];
    function TwoSaves({ first, second }: { first: Options; second: Options }) {
      saves[0] = useSaveMutation(first);
      saves[1] = useSaveMutation(second);
      return null;
    }
    const failsThenWorks = () =>
      vi
        .fn<(name: string) => Promise<Saved>>()
        .mockRejectedValueOnce(new Error("The budget is locked"))
        .mockResolvedValueOnce({ name: "Pat" });
    const options = (): Options => ({
      mutationFn: failsThenWorks(),
      successMessage: "Budget saved",
      errorMessage: "Could not save the budget",
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ToastProvider>
            <TwoSaves first={options()} second={options()} />
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    const region = liveRegion();
    async function saveWith(index: 0 | 1) {
      await act(async () => {
        saves[index]?.mutate("Pat");
      });
      await flushReact();
    }

    await saveWith(0);
    await saveWith(1);
    expect(messages()).toHaveLength(2);

    await saveWith(1);

    expect(region.textContent).toContain("Budget saved");
    expect(region.textContent).toContain("Could not save the budget");
    expect(messages()).toHaveLength(2);
  });

  /**
   * Leaving a page and coming back draws its save again from nothing, while
   * the message viewport, and a failure on it, stays on screen: a failure
   * stays until it is closed. The save on the next visit has to treat that
   * failure as its own.
   */
  describe("across visits to the page", () => {
    const budgetOptions = (mutationFn: Options["mutationFn"]): Options => ({
      mutationFn,
      successMessage: "Budget saved",
      errorMessage: (_error, name) => `Could not save the budget for ${name}`,
      saveName: "budgets",
      saveKey: (name) => name,
    });

    /** Draws the page's save inside the viewport, and returns a way to leave the page and come back. */
    async function renderVisits(options: Options) {
      const queryClient = new QueryClient();
      const draw = (onPage: boolean) =>
        act(async () => {
          root.render(
            <QueryClientProvider client={queryClient}>
              <ToastProvider>
                {onPage ? <Harness options={options} /> : null}
                <ToastViewport />
              </ToastProvider>
            </QueryClientProvider>,
          );
        });
      await draw(true);
      return {
        leaveAndComeBack: async () => {
          await draw(false);
          await draw(true);
        },
      };
    }

    it("takes back a failure said before the page was left once the same item saves", async () => {
      const mutationFn = vi
        .fn<(name: string) => Promise<Saved>>()
        .mockRejectedValueOnce(new Error("The budget is locked"))
        .mockResolvedValueOnce({ name: "Ada" });
      const { leaveAndComeBack } = await renderVisits(budgetOptions(mutationFn));
      const region = liveRegion();

      await save("Ada");
      expect(region.textContent).toContain("Could not save the budget for Ada");

      await leaveAndComeBack();
      await save("Ada");

      // It used to stay up beside "Budget saved", as if Ada's budget had not
      // saved.
      expect(region.textContent).toContain("Budget saved");
      expect(region.textContent).not.toContain("Could not save the budget for Ada");
      expect(messages()).toHaveLength(1);
    });

    it("replaces a failure said before the page was left when the same item fails again", async () => {
      const { leaveAndComeBack } = await renderVisits(
        budgetOptions(() => Promise.reject(new Error("The budget is locked"))),
      );
      const region = liveRegion();

      await save("Ada");
      expect(messages()).toHaveLength(1);

      await leaveAndComeBack();
      await save("Ada");

      // It used to add a second message, the same as the first.
      expect(messages()).toHaveLength(1);
      expect(region.textContent).toContain("Could not save the budget for Ada");
      expect(region.textContent).toContain("The budget is locked");
    });
  });

  it("still says a failure when its wording trips", async () => {
    const onError = vi.fn();
    await render({
      mutationFn: () => Promise.reject(new Error("Name is taken")),
      successMessage: "Settings saved",
      errorMessage: () => {
        throw new Error("no name to word it with");
      },
      onError,
    });
    const region = liveRegion();

    await save("Pat");

    expect(region.textContent).toContain("Could not save");
    expect(region.textContent).toContain("Name is taken");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("shows the reason a save failed when the page shows failures nowhere else", async () => {
    const onError = vi.fn();
    await render({
      mutationFn: () => Promise.reject(new Error("Name is taken")),
      successMessage: "Settings saved",
      errorMessage: "Could not save settings",
      onError,
    });
    const region = liveRegion();

    await save("Pat");

    expect(region.textContent).toContain("Could not save settings");
    expect(region.textContent).toContain("Name is taken");
    expect(region.textContent).not.toContain("Settings saved");
    expect(onError).toHaveBeenCalledTimes(1);
    // A failure stays on screen until it is closed.
    expect(
      container.querySelector('button[aria-label="Dismiss notification"]')?.getAttribute("data-stays"),
    ).toBe("true");
  });

  it("still saves where there is nowhere to show a message", async () => {
    const onSuccess = vi.fn();
    await render(
      { mutationFn: async (name) => ({ name }), successMessage: "Settings saved", onSuccess },
      { withToasts: false },
    );

    await save("Pat");

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(mutation?.isSuccess).toBe(true);
  });
});
