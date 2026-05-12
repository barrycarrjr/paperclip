/**
 * Templates Library — install agent/routine/skill/bundle templates from the
 * configured paperclip-extensions GitHub release.
 *
 * Sibling to `plugin-registry` + the `/plugins/library` route: we fetch the
 * `templates-index.json` artifact from the latest release of the same
 * `PAPERCLIP_PLUGIN_LIBRARY_REPO` and use it to populate the
 * Instance Settings → Templates → Import-from-library picker.
 *
 * The flow:
 *   1. UI hits `/api/templates/library` → we fetch templates-index.json and
 *      enrich each entry with installed/update-available state.
 *   2. UI hits `/api/templates/library/install` (single) or
 *      `/api/templates/library/install-bundle` to perform the import.
 *   3. Imported rows carry a `source` JSONB pointing at the library
 *      template + version + content hash, used to detect future upstream
 *      changes.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentTemplates, routineTemplates, skillTemplates } from "@paperclipai/db";
import type {
  AgentTemplateDetail,
  CreateAgentTemplate,
  CreateRoutineTemplate,
  CreateSkillTemplate,
  RoutineTemplateDetail,
  RoutineVariable,
  SkillTemplateDetail,
  TemplateSource,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { templateService } from "./templates.js";

const DEFAULT_LIBRARY_REPO = "barrycarrjr/paperclip-extensions";
const LIBRARY_CACHE_TTL_MS = 60_000;

/** One entry from the upstream templates-index.json. */
export interface LibraryTemplateEntry {
  kind: "agent" | "routine" | "skill" | "bundle";
  name: string;
  displayName: string;
  description: string;
  frontmatter: Record<string, unknown>;
  body: string;
  contentHash: string;
  sourcePath: string;
}

interface LibraryFetchResult {
  repo: string;
  release: {
    tag: string;
    name: string;
    url: string;
    publishedAt: string | null;
  };
  templates: LibraryTemplateEntry[];
}

/** Enriched library entry as returned to the UI. */
export interface EnrichedLibraryEntry extends LibraryTemplateEntry {
  /** Whether a row with the same `source.name` (and matching kind for non-bundle) already exists. */
  installed: boolean;
  /** True if installed but the stored contentHash differs from the upstream. */
  updateAvailable: boolean;
  /** For bundles only — the resolved set of items the bundle would install. */
  expandsTo?: Array<{
    kind: "agent" | "routine" | "skill";
    name: string;
    found: boolean;
  }>;
  /** Plugin IDs this entry needs installed (from frontmatter). Surfaced as warnings. */
  requiresPlugins: string[];
  /** Of `requiresPlugins`, the ones not yet installed locally. */
  missingPlugins: string[];
}

export interface LibraryListResponse {
  repo: string;
  release: LibraryFetchResult["release"];
  templates: EnrichedLibraryEntry[];
}

export function templatesLibraryService(db: Db) {
  const tpl = templateService(db);
  const registry = pluginRegistryService(db);

  const LIBRARY_REPO =
    process.env.PAPERCLIP_PLUGIN_LIBRARY_REPO?.trim() || DEFAULT_LIBRARY_REPO;

  let cached: { fetchedAt: number; data: LibraryFetchResult } | null = null;

  async function fetchLibrary(force = false): Promise<LibraryFetchResult> {
    if (!force && cached && Date.now() - cached.fetchedAt < LIBRARY_CACHE_TTL_MS) {
      return cached.data;
    }
    const releaseUrl = `https://api.github.com/repos/${LIBRARY_REPO}/releases/latest`;
    const releaseRes = await fetch(releaseUrl, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!releaseRes.ok) {
      throw new Error(
        `Templates library: GitHub returned ${releaseRes.status} for ${releaseUrl}. ` +
          `Verify PAPERCLIP_PLUGIN_LIBRARY_REPO points at a public repo with at least one release.`,
      );
    }
    const release = (await releaseRes.json()) as {
      tag_name: string;
      name?: string | null;
      html_url?: string;
      published_at?: string;
      assets?: Array<{ name: string; browser_download_url: string }>;
    };
    const indexAsset = (release.assets ?? []).find((a) => a.name === "templates-index.json");
    if (!indexAsset) {
      throw new Error(
        `Templates library: release ${release.tag_name} for ${LIBRARY_REPO} has no ` +
          `templates-index.json asset. The release workflow should attach one alongside the .pcplugin files.`,
      );
    }
    const indexRes = await fetch(indexAsset.browser_download_url, {
      headers: { accept: "application/json" },
    });
    if (!indexRes.ok) {
      throw new Error(
        `Templates library: failed to fetch templates-index.json (${indexRes.status}).`,
      );
    }
    const parsed = (await indexRes.json()) as { templates?: LibraryTemplateEntry[] };
    const data: LibraryFetchResult = {
      repo: LIBRARY_REPO,
      release: {
        tag: release.tag_name,
        name: release.name ?? release.tag_name,
        url: release.html_url ?? "",
        publishedAt: release.published_at ?? null,
      },
      templates: parsed.templates ?? [],
    };
    cached = { fetchedAt: Date.now(), data };
    return data;
  }

  function findEntry(
    lib: LibraryFetchResult,
    kind: LibraryTemplateEntry["kind"],
    name: string,
  ): LibraryTemplateEntry | null {
    return lib.templates.find((t) => t.kind === kind && t.name === name) ?? null;
  }

  /** Return all rows from the matching table that came from the library, keyed by source.name. */
  async function loadInstalledByKind(
    kind: "agent" | "routine" | "skill",
  ): Promise<Map<string, { id: string; sourceContentHash: string | null }>> {
    const map = new Map<string, { id: string; sourceContentHash: string | null }>();
    if (kind === "agent") {
      const rows = await db.select({ id: agentTemplates.id, source: agentTemplates.source }).from(agentTemplates);
      for (const row of rows) {
        const src = (row.source ?? null) as TemplateSource | null;
        if (src?.name) map.set(src.name, { id: row.id, sourceContentHash: src.contentHash });
      }
    } else if (kind === "routine") {
      const rows = await db.select({ id: routineTemplates.id, source: routineTemplates.source }).from(routineTemplates);
      for (const row of rows) {
        const src = (row.source ?? null) as TemplateSource | null;
        if (src?.name) map.set(src.name, { id: row.id, sourceContentHash: src.contentHash });
      }
    } else {
      const rows = await db.select({ id: skillTemplates.id, source: skillTemplates.source }).from(skillTemplates);
      for (const row of rows) {
        const src = (row.source ?? null) as TemplateSource | null;
        if (src?.name) map.set(src.name, { id: row.id, sourceContentHash: src.contentHash });
      }
    }
    return map;
  }

  async function listLibrary(): Promise<LibraryListResponse> {
    const lib = await fetchLibrary();
    const installedAgents = await loadInstalledByKind("agent");
    const installedRoutines = await loadInstalledByKind("routine");
    const installedSkills = await loadInstalledByKind("skill");
    const installedPluginRows = await registry.listInstalled();
    const installedPluginKeys = new Set(installedPluginRows.map((p) => p.pluginKey));

    const indexByKindName = new Map<string, LibraryTemplateEntry>();
    for (const t of lib.templates) indexByKindName.set(`${t.kind}:${t.name}`, t);

    const enriched: EnrichedLibraryEntry[] = lib.templates.map((t) => {
      const requiresPlugins = Array.isArray(t.frontmatter.requiresPlugins)
        ? (t.frontmatter.requiresPlugins as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const missingPlugins = requiresPlugins.filter((p) => !installedPluginKeys.has(p));

      if (t.kind === "bundle") {
        const includes = (t.frontmatter.includes ?? {}) as Record<string, unknown>;
        const expandsTo: NonNullable<EnrichedLibraryEntry["expandsTo"]> = [];
        for (const subKind of ["agents", "routines", "skills"] as const) {
          const arr = Array.isArray(includes[subKind]) ? (includes[subKind] as unknown[]) : [];
          const singular = subKind === "agents" ? "agent" : subKind === "routines" ? "routine" : "skill";
          for (const item of arr) {
            if (typeof item !== "string") continue;
            const found = indexByKindName.has(`${singular}:${item}`);
            expandsTo.push({ kind: singular, name: item, found });
          }
        }
        return {
          ...t,
          installed: false,
          updateAvailable: false,
          expandsTo,
          requiresPlugins,
          missingPlugins,
        };
      }

      const map =
        t.kind === "agent" ? installedAgents : t.kind === "routine" ? installedRoutines : installedSkills;
      const existing = map.get(t.name);
      return {
        ...t,
        installed: !!existing,
        updateAvailable: !!existing && existing.sourceContentHash !== t.contentHash,
        requiresPlugins,
        missingPlugins,
      };
    });

    return { repo: lib.repo, release: lib.release, templates: enriched };
  }

  /** Convert a library entry's frontmatter into a CreateXTemplate payload. */
  function toCreatePayload(
    entry: LibraryTemplateEntry,
    libRelease: LibraryFetchResult["release"],
    bundleName?: string,
  ): {
    kind: "agent" | "routine" | "skill";
    payload: CreateAgentTemplate | CreateRoutineTemplate | CreateSkillTemplate;
  } {
    const fm = entry.frontmatter as Record<string, unknown>;
    const source: TemplateSource = {
      type: "paperclip-extensions",
      name: entry.name,
      kind: entry.kind === "bundle" ? "bundle" : entry.kind,
      version: libRelease.tag,
      contentHash: entry.contentHash,
      sourcePath: entry.sourcePath,
      importedAt: new Date().toISOString(),
      ...(bundleName ? { bundleName } : {}),
    };

    if (entry.kind === "agent") {
      const payload: CreateAgentTemplate = {
        name: String(fm.name ?? entry.name),
        description: typeof fm.description === "string" ? fm.description : null,
        agentName: String(fm.agentName ?? entry.name),
        role: String(fm.role ?? "general"),
        title: typeof fm.title === "string" ? fm.title : null,
        icon: typeof fm.icon === "string" ? fm.icon : null,
        // Use the markdown body as the agent's capabilities/system-prompt context.
        capabilities: entry.body && entry.body.length > 0 ? entry.body : (typeof fm.capabilities === "string" ? fm.capabilities : null),
        adapterType: String(fm.adapterType ?? "process"),
        adapterConfig: (fm.adapterConfig as Record<string, unknown>) ?? {},
        runtimeConfig: (fm.runtimeConfig as Record<string, unknown>) ?? {},
        permissions: (fm.permissions as Record<string, unknown>) ?? {},
        forbiddenWritePaths: Array.isArray(fm.forbiddenWritePaths)
          ? (fm.forbiddenWritePaths as unknown[]).filter((x): x is string => typeof x === "string")
          : [],
        budgetMonthlyCents: typeof fm.budgetMonthlyCents === "number" ? fm.budgetMonthlyCents : 0,
        source,
      };
      return { kind: "agent", payload };
    }

    if (entry.kind === "routine") {
      const rawTriggers = Array.isArray(fm.triggers) ? (fm.triggers as Array<Record<string, unknown>>) : [];
      const triggers: CreateRoutineTemplate["triggers"] = rawTriggers.map((t) => {
        const kind = String(t.kind ?? "schedule");
        if (kind === "schedule") {
          return {
            kind: "schedule" as const,
            label: typeof t.label === "string" ? t.label : null,
            enabled: typeof t.enabled === "boolean" ? t.enabled : true,
            cronExpression: String(t.cronExpression ?? "0 9 * * *"),
            timezone: typeof t.timezone === "string" ? t.timezone : "UTC",
          };
        }
        if (kind === "webhook") {
          const rawMode = typeof t.signingMode === "string" ? t.signingMode : "bearer";
          const signingMode: "bearer" | "hmac_sha256" | "github_hmac" | "none" =
            rawMode === "hmac_sha256" || rawMode === "github_hmac" || rawMode === "none"
              ? rawMode
              : "bearer";
          return {
            kind: "webhook" as const,
            label: typeof t.label === "string" ? t.label : null,
            enabled: typeof t.enabled === "boolean" ? t.enabled : true,
            signingMode,
            replayWindowSec: typeof t.replayWindowSec === "number" ? t.replayWindowSec : 300,
          };
        }
        return {
          kind: "api" as const,
          label: typeof t.label === "string" ? t.label : null,
          enabled: typeof t.enabled === "boolean" ? t.enabled : true,
        };
      });
      const variables = Array.isArray(fm.variables) ? (fm.variables as RoutineVariable[]) : [];

      const payload: CreateRoutineTemplate = {
        name: String(fm.name ?? entry.name),
        description: typeof fm.description === "string" ? fm.description : null,
        routineTitle: String(fm.routineTitle ?? entry.displayName ?? entry.name),
        routineDescription:
          typeof fm.routineDescription === "string"
            ? fm.routineDescription
            : entry.body && entry.body.length > 0
              ? entry.body
              : null,
        priority: (typeof fm.priority === "string" ? fm.priority : "medium") as CreateRoutineTemplate["priority"],
        concurrencyPolicy: (typeof fm.concurrencyPolicy === "string"
          ? fm.concurrencyPolicy
          : "coalesce_if_active") as CreateRoutineTemplate["concurrencyPolicy"],
        catchUpPolicy: (typeof fm.catchUpPolicy === "string"
          ? fm.catchUpPolicy
          : "skip_missed") as CreateRoutineTemplate["catchUpPolicy"],
        variables,
        defaultAssigneeRole: typeof fm.defaultAssigneeRole === "string" ? fm.defaultAssigneeRole : null,
        triggers,
        source,
      };
      return { kind: "routine", payload };
    }

    // skill
    const payload: CreateSkillTemplate = {
      name: String(fm.name ?? entry.name),
      description: typeof fm.description === "string" ? fm.description : null,
      skillKey: entry.name,
      skillName: typeof fm.skillName === "string" ? fm.skillName : String(fm.name ?? entry.name),
      skillDescription:
        typeof fm.skillDescription === "string"
          ? fm.skillDescription
          : typeof fm.description === "string"
            ? fm.description
            : null,
      markdown: entry.body ?? "",
      source,
    };
    return { kind: "skill", payload };
  }

  async function installSingle(
    kind: "agent" | "routine" | "skill",
    name: string,
    actor: { userId?: string | null },
    bundleName?: string,
  ): Promise<{
    status: "created" | "updated" | "skipped";
    template: AgentTemplateDetail | RoutineTemplateDetail | SkillTemplateDetail;
  }> {
    const lib = await fetchLibrary();
    const entry = findEntry(lib, kind, name);
    if (!entry) throw notFound(`Library ${kind} '${name}' not found in the current release.`);
    const { payload } = toCreatePayload(entry, lib.release, bundleName);

    // Idempotency: if a row with the same source.name already exists (in the
    // matching table), update its hash + version rather than creating a
    // duplicate. The shape of "update" depends on kind.
    if (kind === "agent") {
      const installed = await loadInstalledByKind("agent");
      const existing = installed.get(name);
      if (existing) {
        // Bring the existing row up to date without trampling whatever the
        // operator may have edited locally — we only refresh source metadata.
        // For full "pull upstream changes" the operator clicks Update.
        await db
          .update(agentTemplates)
          .set({ source: payload.source ?? null, updatedAt: new Date() })
          .where(eq(agentTemplates.id, existing.id));
        const detail = await tpl.getAgentTemplate(existing.id);
        return { status: "skipped", template: detail! };
      }
      const detail = await tpl.createAgentTemplate(payload as CreateAgentTemplate, actor);
      return { status: "created", template: detail };
    }

    if (kind === "routine") {
      const installed = await loadInstalledByKind("routine");
      const existing = installed.get(name);
      if (existing) {
        await db
          .update(routineTemplates)
          .set({ source: payload.source ?? null, updatedAt: new Date() })
          .where(eq(routineTemplates.id, existing.id));
        const detail = await tpl.getRoutineTemplate(existing.id);
        return { status: "skipped", template: detail! };
      }
      const detail = await tpl.createRoutineTemplate(payload as CreateRoutineTemplate, actor);
      return { status: "created", template: detail };
    }

    // skill
    const installed = await loadInstalledByKind("skill");
    const existing = installed.get(name);
    if (existing) {
      await db
        .update(skillTemplates)
        .set({ source: payload.source ?? null, updatedAt: new Date() })
        .where(eq(skillTemplates.id, existing.id));
      const detail = await tpl.getSkillTemplate(existing.id);
      return { status: "skipped", template: detail! };
    }
    try {
      const detail = await tpl.createSkillTemplate(payload as CreateSkillTemplate, actor);
      return { status: "created", template: detail };
    } catch (err) {
      // Skill templates have a unique constraint on skillKey. If a hand-authored
      // template already claims the same skillKey, surface that explicitly.
      if (err instanceof Error && err.message.includes("already exists")) {
        throw unprocessable(
          `A skill template with skillKey '${name}' already exists. Rename or delete the existing one before re-importing.`,
        );
      }
      throw err;
    }
  }

  /** Pull the latest upstream version into an existing imported row.
   *  Replaces all fields with what the library currently has, keeping the row id. */
  async function updateFromLibrary(
    kind: "agent" | "routine" | "skill",
    name: string,
    actor: { userId?: string | null },
  ): Promise<AgentTemplateDetail | RoutineTemplateDetail | SkillTemplateDetail> {
    const lib = await fetchLibrary(true);
    const entry = findEntry(lib, kind, name);
    if (!entry) throw notFound(`Library ${kind} '${name}' not found in the current release.`);

    const installed = await loadInstalledByKind(kind);
    const existing = installed.get(name);
    if (!existing) throw notFound(`No imported ${kind} template found for '${name}'.`);
    const { payload } = toCreatePayload(entry, lib.release);

    if (kind === "agent") {
      const p = payload as CreateAgentTemplate;
      const updated = await tpl.updateAgentTemplate(
        existing.id,
        {
          name: p.name,
          description: p.description ?? null,
          agentName: p.agentName,
          role: p.role,
          title: p.title ?? null,
          icon: p.icon ?? null,
          capabilities: p.capabilities ?? null,
          adapterType: p.adapterType,
          adapterConfig: p.adapterConfig,
          runtimeConfig: p.runtimeConfig,
          permissions: p.permissions,
          forbiddenWritePaths: p.forbiddenWritePaths,
          budgetMonthlyCents: p.budgetMonthlyCents,
        },
        actor,
      );
      // Refresh source metadata to the new release tag + hash.
      await db
        .update(agentTemplates)
        .set({ source: p.source ?? null, updatedAt: new Date() })
        .where(eq(agentTemplates.id, existing.id));
      if (!updated) throw notFound(`Agent template ${existing.id} disappeared during update`);
      const detail = await tpl.getAgentTemplate(existing.id);
      return detail!;
    }
    if (kind === "routine") {
      const p = payload as CreateRoutineTemplate;
      const updated = await tpl.updateRoutineTemplate(
        existing.id,
        {
          name: p.name,
          description: p.description ?? null,
          routineTitle: p.routineTitle,
          routineDescription: p.routineDescription ?? null,
          priority: p.priority,
          concurrencyPolicy: p.concurrencyPolicy,
          catchUpPolicy: p.catchUpPolicy,
          variables: p.variables,
          defaultAssigneeRole: p.defaultAssigneeRole ?? null,
          triggers: p.triggers,
        },
        actor,
      );
      await db
        .update(routineTemplates)
        .set({ source: p.source ?? null, updatedAt: new Date() })
        .where(eq(routineTemplates.id, existing.id));
      if (!updated) throw notFound(`Routine template ${existing.id} disappeared during update`);
      const detail = await tpl.getRoutineTemplate(existing.id);
      return detail!;
    }
    const p = payload as CreateSkillTemplate;
    const updated = await tpl.updateSkillTemplate(
      existing.id,
      {
        name: p.name,
        description: p.description ?? null,
        skillKey: p.skillKey,
        skillName: p.skillName,
        skillDescription: p.skillDescription ?? null,
        markdown: p.markdown,
      },
      actor,
    );
    await db
      .update(skillTemplates)
      .set({ source: p.source ?? null, updatedAt: new Date() })
      .where(eq(skillTemplates.id, existing.id));
    if (!updated) throw notFound(`Skill template ${existing.id} disappeared during update`);
    const detail = await tpl.getSkillTemplate(existing.id);
    return detail!;
  }

  /** Expand a bundle into its referenced items and install each one. */
  async function installBundle(
    name: string,
    actor: { userId?: string | null },
  ): Promise<{
    bundle: { name: string; displayName: string };
    items: Array<{
      kind: "agent" | "routine" | "skill";
      name: string;
      status: "created" | "updated" | "skipped" | "error" | "missing";
      templateId?: string;
      error?: string;
    }>;
    missingPlugins: string[];
  }> {
    const lib = await fetchLibrary();
    const bundleEntry = findEntry(lib, "bundle", name);
    if (!bundleEntry) throw notFound(`Bundle '${name}' not found in the current release.`);

    const includes = (bundleEntry.frontmatter.includes ?? {}) as Record<string, unknown>;
    const refs: Array<{ kind: "agent" | "routine" | "skill"; name: string }> = [];
    for (const [pluralKind, singularKind] of [
      ["agents", "agent"],
      ["routines", "routine"],
      ["skills", "skill"],
    ] as const) {
      const arr = Array.isArray(includes[pluralKind]) ? (includes[pluralKind] as unknown[]) : [];
      for (const item of arr) {
        if (typeof item === "string") refs.push({ kind: singularKind, name: item });
      }
    }

    const items: Awaited<ReturnType<typeof installBundle>>["items"] = [];
    for (const ref of refs) {
      const target = findEntry(lib, ref.kind, ref.name);
      if (!target) {
        items.push({ kind: ref.kind, name: ref.name, status: "missing" });
        continue;
      }
      try {
        const result = await installSingle(ref.kind, ref.name, actor, name);
        items.push({
          kind: ref.kind,
          name: ref.name,
          status: result.status,
          templateId: result.template.id,
        });
      } catch (err) {
        items.push({
          kind: ref.kind,
          name: ref.name,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const requiresPlugins = Array.isArray(bundleEntry.frontmatter.requiresPlugins)
      ? (bundleEntry.frontmatter.requiresPlugins as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const installedPluginRows = await registry.listInstalled();
    const installedPluginKeys = new Set(installedPluginRows.map((p) => p.pluginKey));
    const missingPlugins = requiresPlugins.filter((p) => !installedPluginKeys.has(p));

    return {
      bundle: { name: bundleEntry.name, displayName: bundleEntry.displayName },
      items,
      missingPlugins,
    };
  }

  return {
    /** Force refresh the in-memory cache. */
    invalidate: () => {
      cached = null;
    },
    listLibrary,
    installSingle,
    updateFromLibrary,
    installBundle,
  };
}

export type TemplatesLibraryService = ReturnType<typeof templatesLibraryService>;
