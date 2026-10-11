import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus } from "lucide-react";
import { SPACE_PAGE_TITLE_MAX, type Space, type SpacePage, type UpdateSpacePage } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { spacesApi } from "../api/spaces";
import { useAutosaveIndicator } from "../hooks/useAutosaveIndicator";
import { queryKeys } from "../lib/queryKeys";
import { brandWarningText } from "../lib/status-colors";
import { cn, relativeTime } from "../lib/utils";
import { EmptyState } from "./EmptyState";
import { InfoPopoverButton } from "./InfoPopoverButton";
import { InlineBanner } from "./InlineBanner";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor } from "./MarkdownEditor";
import { Button } from "@/components/ui/button";

/** The title a new page starts with. */
export const NEW_SPACE_PAGE_TITLE = "Untitled";

/** How long after typing stops a change is saved. */
export const SPACE_PAGE_AUTOSAVE_DELAY_MS = 900;

/** Kept text older than this is dropped when a page opens, so a closed tab's text does not stay for ever. */
export const KEPT_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const KEPT_DRAFT_KEY_PREFIX = "paperclip:space-page-draft:";
const TAB_ID_KEY = "paperclip:tab-id";

/**
 * Text written on a page that has not reached the server yet, kept in this
 * browser so a failed save, a closed tab or a lost connection costs nothing.
 *
 * Each tab keeps its own, under the signed-in person's id. With one entry per
 * page, a second tab's save threw away the first tab's unsaved text, and on a
 * shared browser one person's text came back as the next person's.
 */
export interface KeptSpacePageDraft {
  title: string;
  body: string;
  /** The version the text was written on. */
  baseRevisionId: string | null;
  /** When it was kept, in milliseconds. */
  keptAt: number;
}

let fallbackTabId: string | null = null;

function newTabId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** This tab's own id. It is kept in sessionStorage, so a reload of the tab keeps it and a new tab gets its own. */
export function browserTabId(): string {
  try {
    const existing = window.sessionStorage.getItem(TAB_ID_KEY);
    if (existing) return existing;
    const created = newTabId();
    window.sessionStorage.setItem(TAB_ID_KEY, created);
    return created;
  } catch {
    fallbackTabId ??= newTabId();
    return fallbackTabId;
  }
}

function keptDraftKeyPrefix(userId: string, pageId: string) {
  return `${KEPT_DRAFT_KEY_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(pageId)}:`;
}

/** Where one tab keeps one person's unsaved text for one page. */
export function keptSpacePageDraftKey(userId: string, pageId: string, tabId: string) {
  return `${keptDraftKeyPrefix(userId, pageId)}${encodeURIComponent(tabId)}`;
}

function storedKeys(): string[] {
  try {
    const storage = window.localStorage;
    if (typeof storage.length !== "number" || typeof storage.key !== "function") return [];
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function readKeptDraft(key: string): KeptSpacePageDraft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KeptSpacePageDraft>;
    if (typeof parsed.title !== "string" || typeof parsed.body !== "string" || typeof parsed.keptAt !== "number") {
      return null;
    }
    return {
      title: parsed.title,
      body: parsed.body,
      baseRevisionId: typeof parsed.baseRevisionId === "string" ? parsed.baseRevisionId : null,
      keptAt: parsed.keptAt,
    };
  } catch {
    return null;
  }
}

/** Keeps the text, and says whether it could: storage can be full or switched off. */
function keepDraft(key: string, draft: KeptSpacePageDraft): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

function forgetDraft(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

/** Drops kept text older than KEPT_DRAFT_MAX_AGE_MS, and any that cannot be read. */
export function dropOldKeptSpacePageDrafts(now = Date.now()) {
  for (const key of storedKeys()) {
    if (!key.startsWith(KEPT_DRAFT_KEY_PREFIX)) continue;
    const kept = readKeptDraft(key);
    if (!kept || now - kept.keptAt > KEPT_DRAFT_MAX_AGE_MS) forgetDraft(key);
  }
}

/**
 * The kept text to open a page with: this tab's own, or else the newest that
 * another tab of the same person kept for the page (a tab that was closed, or
 * crashed, before its text saved).
 */
export function findKeptSpacePageDraft(
  userId: string,
  pageId: string,
  tabId: string,
): { key: string; draft: KeptSpacePageDraft } | null {
  const ownKey = keptSpacePageDraftKey(userId, pageId, tabId);
  const own = readKeptDraft(ownKey);
  if (own) return { key: ownKey, draft: own };
  const prefix = keptDraftKeyPrefix(userId, pageId);
  let newest: { key: string; draft: KeptSpacePageDraft } | null = null;
  for (const key of storedKeys()) {
    if (key === ownKey || !key.startsWith(prefix)) continue;
    const draft = readKeptDraft(key);
    if (draft && (!newest || draft.keptAt > newest.draft.keptAt)) newest = { key, draft };
  }
  return newest;
}

type Draft = { title: string; body: string };

/** What the server has, as far as this editor knows, and the version it is. */
type SavedState = { title: string; body: string; revisionId: string | null; updatedAt: number };

function savedStateOf(page: SpacePage): SavedState {
  return {
    title: page.title,
    body: page.body,
    revisionId: page.latestRevisionId,
    updatedAt: new Date(page.updatedAt).getTime(),
  };
}

/** An emptied title field keeps the page's title rather than saving none. */
function titleToSave(draft: Draft, saved: SavedState) {
  return draft.title.trim() || saved.title;
}

function hasUnsavedText(draft: Draft | null, saved: SavedState | null) {
  if (!draft || !saved) return false;
  return titleToSave(draft, saved) !== saved.title || draft.body !== saved.body;
}

/** A save refused because the page moved on. Said by its own notice, not as a failed save. */
class PageMovedOn extends Error {}

type Conflict = { theirs: SpacePage; showTheirs: boolean };

interface SpacePageEditorProps {
  space: Space;
  pageId: string;
  canWrite: boolean;
  /** The signed-in person, whose unsaved text this browser keeps. */
  currentUserId: string | null;
  onAddSubpage?: () => void;
  addingSubpage?: boolean;
}

/**
 * One page of a Space: its title and text, saved a moment after typing stops.
 *
 * Every save names the version it was written on. When someone else saved in
 * the meantime the server refuses it, and the person chooses: load the newer
 * version, or keep theirs and save it on top. Until a save works, the text is
 * also kept in this browser, and comes back the next time the page opens.
 */
export function SpacePageEditor({
  space,
  pageId,
  canWrite,
  currentUserId,
  onAddSubpage,
  addingSubpage,
}: SpacePageEditorProps) {
  const queryClient = useQueryClient();
  const pageQueryKey = queryKeys.spaces.page(space.id, pageId);
  const pageQuery = useQuery({
    queryKey: pageQueryKey,
    queryFn: () => spacesApi.getPage(space.id, pageId),
  });
  const page = pageQuery.data;
  const { state: autosaveState, markDirty, reset, runSave } = useAutosaveIndicator();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflictState] = useState<Conflict | null>(null);
  // Set when this browser could not keep the text (storage full or off).
  const [keepFailed, setKeepFailed] = useState(false);
  const draftRef = useRef<Draft | null>(draft);
  draftRef.current = draft;
  const conflictRef = useRef<Conflict | null>(conflict);
  const savedRef = useRef<SavedState | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  // The next save comes straight after a conflict choice instead of after the
  // usual pause, and keeps the version it lands on until it has worked.
  const saveSoonRef = useRef(false);
  const keepPreviousRef = useRef(false);

  const [tabId] = useState(() => browserTabId());
  const keepsText = canWrite && currentUserId !== null;
  const ownKey = keptSpacePageDraftKey(currentUserId ?? "", pageId, tabId);
  // The kept text this tab opened the page with: its own, or another tab's.
  const usedKeyRef = useRef<string | null>(null);

  const setConflict = useCallback((next: Conflict | null) => {
    conflictRef.current = next;
    setConflictState(next);
  }, []);

  // Lets go of this tab's kept text and of the text it opened the page with,
  // and only those: another tab's text stays until that tab is done with it.
  const forgetUsedDrafts = useCallback(() => {
    forgetDraft(ownKey);
    if (usedKeyRef.current && usedKeyRef.current !== ownKey) forgetDraft(usedKeyRef.current);
    usedKeyRef.current = null;
    setKeepFailed(false);
  }, [ownKey]);

  // Keeps the text in this browser while it differs from what is saved, and
  // lets it go once it is saved. It records the version the text was written
  // on, so text kept across a newer save still asks before it overwrites.
  const syncKeptDraft = useCallback(() => {
    const saved = savedRef.current;
    const current = draftRef.current;
    if (!keepsText || !saved || !current) return;
    if (hasUnsavedText(current, saved)) {
      const kept = keepDraft(ownKey, {
        title: current.title,
        body: current.body,
        baseRevisionId: saved.revisionId,
        keptAt: Date.now(),
      });
      setKeepFailed(!kept);
    } else {
      forgetUsedDrafts();
    }
  }, [forgetUsedDrafts, keepsText, ownKey]);

  useEffect(() => {
    if (!page) return;
    const saved = savedRef.current;
    if (!saved) {
      savedRef.current = savedStateOf(page);
      let kept: { key: string; draft: KeptSpacePageDraft } | null = null;
      if (keepsText) {
        dropOldKeptSpacePageDrafts();
        kept = findKeptSpacePageDraft(currentUserId ?? "", page.id, tabId);
      }
      if (kept && (kept.draft.title !== page.title || kept.draft.body !== page.body)) {
        usedKeyRef.current = kept.key;
        setDraft({ title: kept.draft.title, body: kept.draft.body });
        if (kept.draft.baseRevisionId !== page.latestRevisionId) {
          // The page moved on while this text waited in the browser. The
          // version it was written on stays the one it is kept against.
          savedRef.current = { ...savedRef.current, revisionId: kept.draft.baseRevisionId };
          setConflict({ theirs: page, showTheirs: false });
        }
      } else {
        if (kept) forgetDraft(kept.key);
        setDraft({ title: page.title, body: page.body });
      }
      return;
    }
    // A later fetch, such as on coming back to the window.
    if (new Date(page.updatedAt).getTime() <= saved.updatedAt || page.latestRevisionId === saved.revisionId) return;
    const current = conflictRef.current;
    if (current) {
      if (current.theirs.latestRevisionId !== page.latestRevisionId) setConflict({ ...current, theirs: page });
      return;
    }
    // Take the newer version only while nothing written here waits to be saved.
    if (!hasUnsavedText(draftRef.current, saved)) {
      savedRef.current = savedStateOf(page);
      setDraft({ title: page.title, body: page.body });
    }
  }, [currentUserId, keepsText, page, setConflict, tabId]);

  // A page just made starts with its title picked, ready to be typed over.
  const pickedFreshTitleRef = useRef(false);
  useEffect(() => {
    if (!draft || !page || pickedFreshTitleRef.current) return;
    pickedFreshTitleRef.current = true;
    if (canWrite && page.latestRevisionNumber === 1 && page.title === NEW_SPACE_PAGE_TITLE && page.body === "") {
      titleInputRef.current?.select();
    }
  }, [canWrite, draft, page]);

  const saveNow = useCallback(async () => {
    const saved = savedRef.current;
    const current = draftRef.current;
    if (!saved?.revisionId || !current || conflictRef.current || !hasUnsavedText(current, saved)) return;
    const title = titleToSave(current, saved);
    const change: UpdateSpacePage = { baseRevisionId: saved.revisionId };
    if (title !== saved.title) change.title = title;
    if (current.body !== saved.body) change.body = current.body;
    if (keepPreviousRef.current) change.keepPrevious = true;
    try {
      const updated = await spacesApi.updatePage(space.id, pageId, change);
      keepPreviousRef.current = false;
      savedRef.current = savedStateOf(updated);
      queryClient.setQueryData(queryKeys.spaces.page(space.id, pageId), updated);
      if (change.title !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.spaces.pageTree(space.id) });
      }
      syncKeptDraft();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const theirs = await spacesApi.getPage(space.id, pageId);
        const mine = draftRef.current;
        const theirsSaved = savedStateOf(theirs);
        if (mine && !hasUnsavedText(mine, theirsSaved)) {
          // The newer version already says what this one would (this same
          // text, saved from a moment ago), so there is nothing to choose.
          savedRef.current = theirsSaved;
          queryClient.setQueryData(queryKeys.spaces.page(space.id, pageId), theirs);
          syncKeptDraft();
          return;
        }
        setConflict({ theirs, showTheirs: false });
        throw new PageMovedOn();
      }
      throw error;
    }
  }, [pageId, queryClient, setConflict, space.id, syncKeptDraft]);

  // Saves run one after another, each from the version the last one made, so
  // a save started while another is on its way cannot trip over it.
  const queueSave = useCallback((options: { quiet?: boolean } = {}) => {
    const job = async () => {
      if (conflictRef.current || !hasUnsavedText(draftRef.current, savedRef.current)) return;
      if (options.quiet) {
        await saveNow().catch(() => undefined);
        return;
      }
      try {
        await runSave(saveNow);
      } catch (error) {
        // Any other failure is said by the save line. The text stays kept.
        if (error instanceof PageMovedOn) reset();
      }
    };
    const next = saveQueueRef.current.then(job, job);
    saveQueueRef.current = next;
    return next;
  }, [reset, runSave, saveNow]);
  const queueSaveRef = useRef(queueSave);
  queueSaveRef.current = queueSave;

  useEffect(() => {
    if (!canWrite || !draft) return;
    syncKeptDraft();
    const soon = saveSoonRef.current;
    saveSoonRef.current = false;
    if (conflict || !hasUnsavedText(draft, savedRef.current)) return;
    markDirty();
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void queueSaveRef.current();
    }, soon ? 0 : SPACE_PAGE_AUTOSAVE_DELAY_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
    };
  }, [canWrite, conflict, draft, markDirty, syncKeptDraft]);

  // Leaving the page with text not yet saved still saves it.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    void queueSaveRef.current({ quiet: true });
  }, []);

  const saveRightAway = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    void queueSave();
  };

  const loadNewerVersion = () => {
    const current = conflictRef.current;
    if (!current) return;
    savedRef.current = savedStateOf(current.theirs);
    queryClient.setQueryData(pageQueryKey, current.theirs);
    keepPreviousRef.current = false;
    setConflict(null);
    setDraft({ title: current.theirs.title, body: current.theirs.body });
    forgetUsedDrafts();
    reset();
  };

  // Saves this person's text on top of the newer version, which stays as an
  // older version of the page: the save says so (keepPrevious), because that
  // version can be this same person's text from another tab, which a save
  // within ten minutes of it would otherwise fold away.
  const keepMine = () => {
    const current = conflictRef.current;
    if (!current) return;
    savedRef.current = savedStateOf(current.theirs);
    queryClient.setQueryData(pageQueryKey, current.theirs);
    keepPreviousRef.current = true;
    if (usedKeyRef.current && usedKeyRef.current !== ownKey) forgetDraft(usedKeyRef.current);
    usedKeyRef.current = null;
    // The save goes straight away, from the effect that sees the choice made.
    saveSoonRef.current = true;
    setConflict(null);
  };

  if (pageQuery.isLoading || (page && !draft)) {
    return <p className="text-sm text-muted-foreground">Loading the page…</p>;
  }
  if (!page || !draft) {
    return (
      <EmptyState
        icon={FileText}
        message={pageQuery.error ? pageQuery.error.message : "This page could not be found."}
      />
    );
  }

  const failed = autosaveState === "error";
  // "Kept" only when this browser really kept a copy: storage can be full or
  // switched off, and then the text is on this screen alone.
  const notSavedLine = keepFailed
    ? "Not saved. Keep this page open: this browser could not keep a copy."
    : "Not saved, your text is kept";
  const saveLine = conflict || failed
    ? notSavedLine
    : autosaveState === "saving"
      ? "Saving…"
      : autosaveState === "saved"
        ? "Saved"
        : "";

  return (
    <article className="min-w-0 max-w-3xl space-y-3">
      <input
        ref={titleInputRef}
        aria-label="Page title"
        value={draft.title}
        onChange={(event) => {
          const title = event.target.value;
          setDraft((current) => (current ? { ...current, title } : current));
        }}
        readOnly={!canWrite}
        placeholder={NEW_SPACE_PAGE_TITLE}
        maxLength={SPACE_PAGE_TITLE_MAX}
        className="w-full min-w-0 bg-transparent text-xl font-bold outline-none placeholder:text-muted-foreground/50"
      />

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="shrink-0">Updated {relativeTime(page.updatedAt)}</span>
          {!canWrite && <span className="shrink-0">Read only</span>}
          {/* On the page even while empty, so a screen reader hears each change. */}
          <span
            role="status"
            className={cn(conflict ? brandWarningText : failed ? "text-destructive" : "text-muted-foreground")}
          >
            {saveLine}
          </span>
          {failed && !conflict && (
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={saveRightAway}
            >
              Try again
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onAddSubpage && (
            // Only the icon on a phone, so the save line and this stay on one row.
            <Button
              size="sm"
              variant="ghost"
              onClick={onAddSubpage}
              disabled={addingSubpage}
              title="Add a subpage"
            >
              <Plus className="h-3.5 w-3.5 sm:mr-1" />
              <span className="max-sm:sr-only">{addingSubpage ? "Adding…" : "Add a subpage"}</span>
            </Button>
          )}
          <InfoPopoverButton
            title="Page versions"
            side="bottom"
            align="end"
            info={
              <>
                <p>
                  Every saved version of this page is kept. One version holds up to ten minutes
                  of your writing: what you save in that time counts as one version, and your
                  next save after it starts a new one.
                </p>
                <p>Looking at and restoring older versions, and moving or deleting pages, come in a later update.</p>
              </>
            }
          />
        </div>
      </div>

      {/* Always on the page, so a screen reader hears the notice when it appears. */}
      <div role="status">
        {conflict && (
          <InlineBanner
            tone="warning"
            title="This page changed while you were writing"
            actions={(
              <>
                <Button size="sm" variant="outline" onClick={loadNewerVersion}>
                  Load the newer version
                </Button>
                <Button size="sm" onClick={keepMine}>
                  Keep mine
                </Button>
              </>
            )}
          >
            <p>
              Your text is kept here, not saved. Load the newer version to drop your changes, or keep
              yours to save it as the newest version. The other one stays as an older version.
            </p>
            <button
              type="button"
              className="mt-1 underline underline-offset-2"
              onClick={() => setConflict({ ...conflict, showTheirs: !conflict.showTheirs })}
            >
              {conflict.showTheirs ? "Hide the newer version" : "Show the newer version"}
            </button>
          </InlineBanner>
        )}
      </div>
      {conflict?.showTheirs && (
        <section aria-label="The newer version" className="rounded-md border border-border bg-muted/30 p-3">
          <p className="mb-2 text-xs text-muted-foreground">
            The newer version, saved {relativeTime(conflict.theirs.updatedAt)}
          </p>
          <p className="mb-2 text-sm font-semibold">{conflict.theirs.title}</p>
          <MarkdownBody className="paperclip-edit-in-place-content" softBreaks={false}>
            {conflict.theirs.body}
          </MarkdownBody>
        </section>
      )}

      {canWrite ? (
        <MarkdownEditor
          value={draft.body}
          onChange={(body) => setDraft((current) => (current ? { ...current, body } : current))}
          placeholder="Write here. It saves as you type."
          bordered={false}
          className="bg-transparent"
          contentClassName="paperclip-edit-in-place-content min-h-[320px]"
          onSubmit={saveRightAway}
        />
      ) : draft.body.trim() ? (
        <MarkdownBody className="paperclip-edit-in-place-content" softBreaks={false}>
          {draft.body}
        </MarkdownBody>
      ) : (
        <p className="text-sm text-muted-foreground">This page is empty.</p>
      )}
    </article>
  );
}
