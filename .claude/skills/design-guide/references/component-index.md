# Paperclip Component Index

Complete inventory of all UI components. Update this file when adding new reusable components.

---

## Table of Contents

1. [shadcn/ui Primitives](#shadcnui-primitives)
2. [Custom Components](#custom-components)
3. [Layout Components](#layout-components)
4. [Dialog & Form Components](#dialog--form-components)
5. [Property Panel Components](#property-panel-components)
6. [Agent Configuration](#agent-configuration)
7. [Utilities & Hooks](#utilities--hooks)

---

## shadcn/ui Primitives

Location: `ui/src/components/ui/`

These are shadcn/ui base components. Do not modify directly — extend via composition.

| Component | File | Key Props | Notes |
|-----------|------|-----------|-------|
| Button | `button.tsx` | `variant` (default, secondary, outline, ghost, destructive, link), `size` (xs, sm, default, lg, icon, icon-xs, icon-sm, icon-lg) | Primary interactive element. Uses CVA. |
| Card | `card.tsx` | CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter | Compound component. `py-6` default padding. |
| Input | `input.tsx` | `disabled` | Standard text input. |
| Badge | `badge.tsx` | `variant` (default, secondary, outline, destructive, ghost) | Generic label/tag. For status, use StatusBadge instead. |
| Label | `label.tsx` | — | Form label, wraps Radix Label. |
| Select | `select.tsx` | Trigger, Content, Item, etc. | Radix-based dropdown select. |
| Separator | `separator.tsx` | `orientation` (horizontal, vertical) | Divider line. |
| Checkbox | `checkbox.tsx` | `checked`, `onCheckedChange` | Radix checkbox with indicator. |
| Textarea | `textarea.tsx` | Standard textarea props | Multi-line input. |
| Avatar | `avatar.tsx` | `size` (sm, default, lg). Includes AvatarGroup, AvatarGroupCount | Image or fallback initials. |
| Breadcrumb | `breadcrumb.tsx` | BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator, BreadcrumbPage | Navigation breadcrumbs. |
| Command | `command.tsx` | CommandInput, CommandList, CommandGroup, CommandItem | Command palette / search. Based on cmdk. |
| Dialog | `dialog.tsx` | DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter | Modal overlay. |
| DropdownMenu | `dropdown-menu.tsx` | Trigger, Content, Item, Separator, etc. | Context/action menus. |
| Popover | `popover.tsx` | PopoverTrigger, PopoverContent | Floating content panel. |
| Tabs | `tabs.tsx` | `variant` (pill, line). TabsList, TabsTrigger, TabsContent | Tabbed navigation. Pill = default, line = underline style. |
| Tooltip | `tooltip.tsx` | TooltipTrigger, TooltipContent | Hover tooltips. App is wrapped in TooltipProvider. |
| ScrollArea | `scroll-area.tsx` | — | Custom scrollable container. |
| Collapsible | `collapsible.tsx` | CollapsibleTrigger, CollapsibleContent | Expand/collapse sections. |
| Skeleton | `skeleton.tsx` | className for sizing | Loading placeholder with shimmer. |
| Sheet | `sheet.tsx` | SheetTrigger, SheetContent, SheetHeader, etc. | Side panel overlay. |

---

## Custom Components

Location: `ui/src/components/`

### StatusBadge

**File:** `StatusBadge.tsx`
**Props:** `status: string`
**Usage:** Colored pill showing entity status. Supports 20+ statuses with mapped colors.

```tsx
<StatusBadge status="in_progress" />
```

Use for displaying status in properties panels, entity rows, and list views. Never hardcode status colors — always use this component.

### StatusIcon

**File:** `StatusIcon.tsx`
**Props:** `status: string`, `onChange?: (status: string) => void`
**Usage:** Circle icon representing issue status. When `onChange` provided, opens a popover picker.

```tsx
<StatusIcon status="todo" onChange={setStatus} />
```

Supports: backlog, todo, in_progress, in_review, done, cancelled, blocked. Use in entity row leading slots and grouped list headers.

### PriorityIcon

**File:** `PriorityIcon.tsx`
**Props:** `priority: string`, `onChange?: (priority: string) => void`
**Usage:** Priority indicator icon. Interactive when `onChange` provided.

```tsx
<PriorityIcon priority="high" onChange={setPriority} />
```

Supports: critical, high, medium, low. Use alongside StatusIcon in entity row leading slots.

### EntityRow

**File:** `EntityRow.tsx`
**Props:** `leading`, `identifier`, `title`, `subtitle?`, `trailing?`, `onClick?`, `selected?`
**Usage:** Standard list row for issues, agents, projects. Supports hover highlight and selected state.

```tsx
<EntityRow
  leading={<><StatusIcon status="todo" /><PriorityIcon priority="medium" /></>}
  identifier="PAP-003"
  title="Write API documentation"
  trailing={<StatusBadge status="todo" />}
  onClick={() => navigate(`/issues/${id}`)}
/>
```

Wrap multiple EntityRows in a `border border-border rounded-md` container.

### MetricCard

**File:** `MetricCard.tsx`
**Props:** `icon: LucideIcon`, `value: string | number`, `label: string`, `description?: string`
**Usage:** Dashboard stat card with icon, large value, label, and optional description.

```tsx
<MetricCard icon={Bot} value={12} label="Active Agents" description="+3 this week" />
```

Always use in a responsive grid: `grid md:grid-cols-2 xl:grid-cols-4 gap-4`.

### EmptyState

**File:** `EmptyState.tsx`
**Props:** `icon: LucideIcon`, `message: string`, `action?: string`, `onAction?: () => void`
**Usage:** Empty list placeholder with icon, message, and optional CTA button.

```tsx
<EmptyState icon={Inbox} message="No items yet." action="Create Item" onAction={handleCreate} />
```

### FilterBar

**File:** `FilterBar.tsx`
**Props:** `filters: FilterValue[]`, `onRemove: (key) => void`, `onClear: () => void`
**Type:** `FilterValue = { key: string; label: string; value: string }`
**Usage:** Filter chip display with remove buttons and clear all.

```tsx
<FilterBar filters={filters} onRemove={handleRemove} onClear={() => setFilters([])} />
```

### MailSearchBar

**File:** `MailSearchBar.tsx`
**Props:** `value: string`, `onChange: (value) => void`, `onSubmit: () => void`, `onClear: () => void`, `placeholder?: string`, `summary?: string | null`, `busy?: boolean`, `note?: ReactNode`, `className?: string`, `aria-label?: string`
**Usage:** Search input for the mail panes (IMAP and Help Scout). Submit-driven, not search-as-you-type: the query runs server-side across folders and accounts, so it fires on Enter or the magnifier. Escape and the inline X both call `onClear`. Put the result count in `summary`, and use `note` to say when coverage was incomplete (folders skipped or unreadable) so a thin result set is not read as a definitive "not there".

```tsx
<MailSearchBar
  value={searchInput}
  onChange={setSearchInput}
  onSubmit={submitSearch}
  onClear={clearSearch}
  summary="12 results"
  busy={isFetching}
  note="Could not search personal/Archive. Results may be incomplete."
/>
```

### EmailStateIcons

**File:** `email/EmailStateIcons.tsx`
**Props:** `answered?: boolean`, `forwarded?: boolean`, `showLabels?: boolean`, `className?: string`
**Usage:** The replied and forwarded marks on an email, read from the mailbox (the `\Answered` flag and the `$Forwarded` keyword), so they match Outlook whichever program replied. Every email list row and every open message uses it: icon-only in a row, grouped with the time on the right of the sender line; `showLabels` on an open message. Renders nothing when neither applies. Uses a native `title` rather than a Tooltip because list rows are already tooltip triggers.

```tsx
<span className="flex shrink-0 items-center gap-1.5">
  <EmailStateIcons answered={msg.answered} forwarded={msg.forwarded} />
  <span className="text-[10px] text-muted-foreground">{timeAgo(new Date(msg.date))}</span>
</span>
```

### RowHoverToolbar

**File:** `email/RowHoverToolbar.tsx`
**Props:** `children: ReactNode`, `forceVisible?: boolean`, `className?: string`; plus the `ROW_WITH_HOVER_TOOLBAR` class string for the row.
**Usage:** Quick actions for one list row (every email list uses it: the company Email page, Portfolio Email, the Help Scout panel). It floats over the row's right end while that row is hovered or has keyboard focus, and takes no width otherwise, so the row's text keeps the whole row in a narrow column. The row must carry `ROW_WITH_HOVER_TOOLBAR` (`relative group/row`); the named group matters, because a plain `group-hover` fires for any hovered `group` ancestor and lit up every row when the list column was one. Pass `forceVisible` while a menu opened from the toolbar is open. Keep it short in a narrow column (two or three buttons plus a "More actions" menu): it appears under the pointer, so wherever it covers the row a click presses a button instead of opening the row. It reveals on keyboard focus (`:focus-visible`), not plain focus, so a clicked button does not leave it stuck open.

```tsx
<div className={cn(ROW_WITH_HOVER_TOOLBAR, "flex items-center gap-2 px-3 py-2.5")}>
  {/* row text: sender, time, subject */}
  <RowHoverToolbar forceVisible={menuOpen}>
    <Button size="icon-sm" variant="ghost" aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
  </RowHoverToolbar>
</div>
```

### Identity

**File:** `Identity.tsx`
**Props:** `name: string`, `avatarUrl?: string`, `initials?: string`, `size?: "sm" | "default" | "lg"`
**Usage:** Avatar + name display for users and agents. Derives initials from name automatically. Three sizes matching Avatar sizes.

```tsx
<Identity name="Agent Alpha" size="sm" />
<Identity name="CEO Agent" />
<Identity name="Backend Service" size="lg" avatarUrl="/img/bot.png" />
```

Use in property rows, comment headers, assignee displays, and anywhere a user/agent reference is shown.

### InlineEditor

**File:** `InlineEditor.tsx`
**Props:** `value: string`, `onSave: (val: string) => void`, `as?: string`, `className?: string`
**Usage:** Click-to-edit text. Renders as display text, clicking enters edit mode. Enter saves, Escape cancels.

```tsx
<InlineEditor value={title} onSave={updateTitle} as="h2" className="text-xl font-bold" />
```

### DraftInstructionsField

**File:** `DraftInstructionsField.tsx`
**Props:** `value: string`, `onChange: (val: string) => void`, `onSubmit: () => void`, `refining?: boolean`, `disabled?: boolean`, `className?: string`
**Usage:** Steering box for an AI Draft button — the operator types what the reply should say, then presses Enter or clicks the button. Sits directly above a reply composer. Set `refining` once there is draft text to change, which switches the placeholder from "what to say" to "what to change".

```tsx
<DraftInstructionsField
  value={draftInstructions}
  onChange={setDraftInstructions}
  onSubmit={runDraft}
  refining={hasDraft}
  disabled={draftMutation.isPending}
/>
```

Used by the Help Scout and IMAP reply composers on the Email page, and by the reply box in the email pop-out (`email/EmailPopoutDialog.tsx`), which the Portfolio Email list opens. Pair it with `DraftModelSelect` and take the model from `hooks/useDraftModel.ts`, so every composer drafts with the same pick.

### PageSkeleton

**File:** `PageSkeleton.tsx`
**Props:** `variant: "list" | "detail"`
**Usage:** Full-page loading skeleton matching list or detail layout.

```tsx
<PageSkeleton variant="list" />
```

### CommentThread

**File:** `CommentThread.tsx`
**Usage:** Comment list with add-comment form. Used on issue and entity detail views.

### GoalTree

**File:** `GoalTree.tsx`
**Usage:** Hierarchical goal tree with expand/collapse. Used on the goals page.

### CompanySwitcher

**File:** `CompanySwitcher.tsx`
**Usage:** Company selector dropdown in sidebar header.

---

## Layout Components

### Layout

**File:** `Layout.tsx`
**Usage:** Main app shell. Three-zone layout: Sidebar + Main content + Properties panel. Wraps all routes.

### Sidebar

**File:** `Sidebar.tsx`
**Usage:** Left navigation sidebar (`w-60`). Contains CompanySwitcher, search button, new issue button, and SidebarSections.

### SidebarSection

**File:** `SidebarSection.tsx`
**Usage:** Collapsible sidebar group with header label and chevron toggle.

### SidebarNavItem

**File:** `SidebarNavItem.tsx`
**Props:** Icon, label, optional badge count
**Usage:** Individual nav item within a SidebarSection.

### BreadcrumbBar

**File:** `BreadcrumbBar.tsx`
**Usage:** Top breadcrumb navigation spanning main content + properties panel.

### PageTabBar

**File:** `PageTabBar.tsx`
**Props:** `label` (required), `items`, `value`, `onValueChange`, `align`
**Usage:** The tab strip on a page, rendered inside a `Tabs` root. Below the phone
breakpoint it draws a plain dropdown instead of the strip, which is why `label` is
required: it is the accessible name for both, and without it a screen reader announces
the dropdown with no name at all. Write it as what the tabs choose between, in plain
words, such as "Work section".

When the tabs move to another address rather than switching local state, also set
`activationMode="manual"` on the `Tabs` root. Left on its default the strip asks to
change tab twice for one click, once on mouse down and once when the button takes focus,
so one click puts two entries in the browser history and the back button needs two
presses. Work.tsx and Team.tsx do this.

### PropertiesPanel

**File:** `PropertiesPanel.tsx`
**Usage:** Right-side properties panel (`w-80`). Closeable. Shown on detail views.

### CommandPalette

**File:** `CommandPalette.tsx`
**Usage:** Cmd+K global search modal. Searches issues, projects, agents.

---

## Dialog & Form Components

### NewIssueDialog

**File:** `NewIssueDialog.tsx`
**Usage:** Create new issue with project/assignee/priority selection. Supports draft saving.

### NewProjectDialog

**File:** `NewProjectDialog.tsx`
**Usage:** Create new project dialog.

### NewAgentDialog

**File:** `NewAgentDialog.tsx`
**Usage:** Create new agent dialog.

### OnboardingWizard

**File:** `OnboardingWizard.tsx`
**Usage:** Multi-step onboarding flow for new users/companies.

---

## Property Panel Components

These render inside the PropertiesPanel for different entity types:

| Component | File | Entity |
|-----------|------|--------|
| IssueProperties | `IssueProperties.tsx` | Issues |
| AgentProperties | `AgentProperties.tsx` | Agents |
| ProjectProperties | `ProjectProperties.tsx` | Projects |
| GoalProperties | `GoalProperties.tsx` | Goals |

All follow the property row pattern: `text-xs text-muted-foreground` label on left, value on right, `py-1.5` spacing.

---

## Agent Configuration

### agent-config-primitives

**File:** `agent-config-primitives.tsx`
**Exports:** Field, ToggleField, ToggleWithNumber, CollapsibleSection, AutoExpandTextarea, DraftInput
**Usage:** Reusable form field primitives for agent configuration forms.

### AgentConfigForm

**File:** `AgentConfigForm.tsx`
**Usage:** Full agent creation/editing form with adapter type selection.

### ModelPicker

**File:** `ModelPicker.tsx`
**Props:** `models` (or `groups` for one heading per provider), `value`, `onChange`, `emptyOption?` (a first row such as "Default"), `creatable?`, `loading?`, `onRefreshModels?`, `onDetectModel?`
**Usage:** The one model picker used everywhere a model is chosen: agent settings, new agent, onboarding, issue overrides, Agent Defaults, Clippy and email drafts. Keeps the server's order (current models first, retiring next), folds `status: "legacy"` models under "Older models (N)" (opened when the saved model is one of them), tags rows with ModelLifecycleBadge, and shows a saved model the provider no longer lists as "Not available" rather than dropping it. Do not build a new model dropdown; use this.

### ModelLifecycleBadge

**File:** `ModelLifecycleBadge.tsx`
**Props:** `model` (the lifecycle fields: `status`, `isNew`, `isDefault`, `retiresAt`), `unavailable?`
**Usage:** Small tags beside a model name: "New", "Used by default", "Retires <date>" in the warning tone, or "Not available". Renders nothing for a plain current model. Wording lives in `lib/model-display.ts`.

### SavedModelNotice

**File:** `SavedModelNotice.tsx`
**Props:** `models`, `value` (the saved model id), `onSwitch(id)`, `disabled?`
**Usage:** One line under a model picker when the saved model has been replaced, is retiring, or is no longer offered, with a "Switch to <model>" button. Driven by `describeSavedModel` from `@paperclipai/shared`, so it follows a provider's named successor on to a current model. Renders nothing when the saved model is fine.

### AttachmentChipList

**File:** `attachments/AttachmentChipList.tsx`
**Props:** `attachments: ReceivedAttachment[]`, `fetchContent`, `onError?`, `className?`
**Usage:** Received-attachment chips with click-to-download. Fetches the file bytes through the given bridge call on click, shows a per-chip spinner, and turns the chip destructive on failure. Used by the Email page, the email pop-out, and the Help Scout thread view.

```tsx
<AttachmentChipList
  attachments={[{ key: "2", name: "invoice.pdf", mime: "application/pdf", size: 20480 }]}
  fetchContent={async (att) => api.getAttachment(...)}
  onError={showToast}
/>
```

### AttachmentComposer (+ useComposeAttachments)

**File:** `attachments/AttachmentComposer.tsx`
**Props:** `state: ComposeAttachmentsState` (from `useComposeAttachments(maxBytes)`), `disabled?`, `className?`
**Usage:** "Attach files" control for outgoing mail: multi-file picker plus a chip per file with read status, size, and a remove button. Files are read to base64 on pick; over-limit files become error chips and are never sent. Gate the send button on `state.allReady`. Pure state transitions live in `ui/src/lib/attachments.ts`.

```tsx
const attachments = useComposeAttachments(EMAIL_ATTACHMENT_MAX_BYTES);
<AttachmentComposer state={attachments} />
<Button disabled={!attachments.allReady} onClick={() => send(toEmailSendAttachments(attachments.attachments))} />
```

---

## Utilities & Hooks

### cn() — Class Name Merger

**File:** `ui/src/lib/utils.ts`
**Usage:** Merges class names with clsx + tailwind-merge. Use in every component.

```tsx
import { cn } from "@/lib/utils";
<div className={cn("base-classes", conditional && "extra", className)} />
```

### Formatting Utilities

**File:** `ui/src/lib/utils.ts`

| Function | Usage |
|----------|-------|
| `formatCents(cents)` | Money display: `$12.34` |
| `formatDate(date)` | Date display: `Jan 15, 2025` |
| `relativeTime(date)` | Relative time: `2m ago`, `Jan 15` |
| `formatTokens(count)` | Token counts: `1.2M`, `500k` |

### useKeyboardShortcuts

**File:** `ui/src/hooks/useKeyboardShortcuts.ts`
**Usage:** Global keyboard shortcut handler. Registers Cmd+K, C, [, ], Cmd+Enter.

### Query Keys

**File:** `ui/src/lib/queryKeys.ts`
**Usage:** Structured React Query key factories for cache management.

### groupBy

**File:** `ui/src/lib/groupBy.ts`
**Usage:** Generic array grouping utility.
