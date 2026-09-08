import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Clock3,
  Cpu,
  Download,
  FlaskConical,
  KeyRound,
  Network,
  Puzzle,
  ScrollText,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";

/**
 * The settings destinations, so the Everything page and the search box can
 * offer them.
 *
 * Why this exists. The scope document
 * (docs/plans/2026-09-02-ux-control-center-scope.md, "A small primary
 * navigation") asks for Administration to stay "discoverable through stable
 * entries/catalog paths". The two stable entries have always been there: the
 * company name at the top of the sidebar opens a menu with Company settings,
 * and your own name at the bottom opens a menu with Instance settings. What
 * was missing is the catalog half. The Everything page promises "every
 * workspace this company can reach", and the search box finds every other
 * page in the app, and neither of them knew a single settings page existed.
 * Typing "plugins", "secrets" or "MCP" found nothing.
 *
 * Why it is not in workspace-catalog.ts. That file's entries are pinnable and
 * every one of its routeRoot values has to be a real company-scoped route
 * root, which a test enforces. Settings paths are neither: "/instance/..."
 * is not company-scoped at all, and "/company/settings/access" is three
 * segments rather than a root. Pushing them into that list would have meant
 * loosening an invariant that is doing useful work, so they get their own
 * small list with its own shape instead. workspace-catalog.ts's own comment
 * used to call this "future scope"; this is that scope, done separately.
 *
 * What this deliberately is NOT. There is no Administration page and no new
 * menu line. The mockup shows both (docs/plans/2026-09-07-mockup-vs-app.md,
 * difference 15), but the main menu was cut to eight entries on purpose on
 * 2026-09-07, and a hub page whose only content is links to pages that
 * already have their own navigation would be the "manufactured page" the
 * scope document rules out. Every path below is the real screen, reached
 * directly.
 */
export type SettingsScope = "company" | "instance";

export interface SettingsCatalogEntry {
  id: string;
  label: string;
  /**
   * Absolute path. A "/company/..." path picks up the company prefix from the
   * Link wrapper in lib/router.tsx; an "/instance/..." path never does,
   * because "instance" is a global route root (lib/company-routes.ts).
   */
  path: string;
  icon: LucideIcon;
  scope: SettingsScope;
  /**
   * Extra words someone might type when hunting for this, beyond the label.
   * Search only. Never shown on screen, so it can hold the old name of a
   * thing without renaming anything.
   */
  keywords?: string;
}

/**
 * How each scope is described wherever these entries are listed.
 *
 * The scope document is explicit that a system wide setting must not look
 * like it applies only to the company you are in, so the two lists are never
 * merged into one "Administration" heap: they are shown as two groups, each
 * with its sentence, and every row also carries the short version.
 */
export const SETTINGS_SCOPE_COPY: Record<
  SettingsScope,
  { title: string; description: string; rowNote: string }
> = {
  company: {
    title: "Company settings",
    description: "Just the company you are in. Changing these leaves every other company alone.",
    rowNote: "This company",
  },
  instance: {
    title: "Instance settings",
    description: "Every company on this instance, not only the one you are in.",
    rowNote: "Every company",
  },
};

/**
 * Labels match what each destination already calls itself in its own
 * breadcrumb and in the Instance Settings menu. This list is not license to
 * rename anything, the same rule workspace-catalog.ts records.
 */
export const SETTINGS_CATALOG: SettingsCatalogEntry[] = [
  {
    id: "company-settings",
    label: "Company settings",
    path: "/company/settings",
    icon: Settings,
    scope: "company",
    keywords: "identity branding name environments",
  },
  {
    id: "company-access",
    label: "Access",
    path: "/company/settings/access",
    icon: Users,
    scope: "company",
    keywords: "members people permissions roles who can",
  },
  {
    id: "company-invites",
    label: "Invites",
    path: "/company/settings/invites",
    icon: UserPlus,
    scope: "company",
    keywords: "invite people join link",
  },
  {
    id: "company-secrets",
    label: "Secrets",
    path: "/company/settings/secrets",
    icon: KeyRound,
    scope: "company",
    keywords: "keys api tokens credentials",
  },
  {
    id: "company-export",
    label: "Export",
    path: "/company/export",
    icon: Download,
    scope: "company",
    keywords: "download package copy this company",
  },
  {
    id: "company-import",
    label: "Import",
    path: "/company/import",
    icon: Upload,
    scope: "company",
    keywords: "upload package restore bring in a company",
  },
  {
    id: "instance-general",
    label: "General",
    path: "/instance/settings/general",
    icon: SlidersHorizontal,
    scope: "instance",
    keywords: "instance name outbound approval retention",
  },
  {
    id: "instance-access",
    label: "Access",
    path: "/instance/settings/access",
    icon: Shield,
    scope: "instance",
    keywords: "users permissions sign in",
  },
  {
    id: "instance-heartbeats",
    label: "Heartbeats",
    path: "/instance/settings/heartbeats",
    icon: Clock3,
    scope: "instance",
    keywords: "liveness health checks",
  },
  {
    id: "instance-templates",
    label: "Templates",
    path: "/instance/settings/templates",
    icon: Sparkles,
    scope: "instance",
    keywords: "agent templates starting points",
  },
  {
    id: "instance-plugins",
    label: "Plugins",
    path: "/instance/settings/plugins",
    icon: Puzzle,
    scope: "instance",
    keywords: "add-ons extensions install integrations",
  },
  {
    id: "instance-adapters",
    label: "Adapters",
    path: "/instance/settings/adapters",
    icon: Cpu,
    scope: "instance",
    keywords: "models providers claude codex",
  },
  {
    id: "instance-agent-defaults",
    label: "Agent defaults",
    path: "/instance/settings/agent-defaults",
    icon: Bot,
    scope: "instance",
    keywords: "default model budget for new agents",
  },
  {
    id: "instance-external-mcp",
    label: "MCP servers",
    path: "/instance/settings/external-mcp",
    icon: Network,
    scope: "instance",
    keywords: "external mcp model context protocol tools",
  },
  {
    id: "instance-experimental",
    label: "Experimental",
    path: "/instance/settings/experimental",
    icon: FlaskConical,
    scope: "instance",
    keywords: "flags switches isolated workspaces preview",
  },
  {
    id: "instance-logs",
    label: "Logs",
    path: "/instance/settings/logs",
    icon: ScrollText,
    scope: "instance",
    keywords: "diagnostics errors output",
  },
];

/** The entries for one scope, in the order they are listed above. */
export function settingsCatalogForScope(scope: SettingsScope): SettingsCatalogEntry[] {
  return SETTINGS_CATALOG.filter((entry) => entry.scope === scope);
}

/**
 * What a search box should match this entry against.
 *
 * Includes the scope's own words so that typing "instance access" reaches the
 * instance one and "company access" reaches the company one, even though both
 * are called Access by the screens themselves.
 */
export function settingsSearchValue(entry: SettingsCatalogEntry): string {
  const copy = SETTINGS_SCOPE_COPY[entry.scope];
  return [copy.title, entry.label, copy.rowNote, entry.keywords ?? ""]
    .join(" ")
    .trim()
    .toLowerCase();
}
