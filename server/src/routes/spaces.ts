import { Router, type Request, type RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import {
  createSpacePageSchema,
  createSpaceSchema,
  moveSpacePageSchema,
  restoreSpacePageRevisionSchema,
  updateSpacePageSchema,
  updateSpaceSchema,
  type Space,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity, spaceService } from "../services/index.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo, type AccessMode } from "./authz.js";

/**
 * Spaces are for people in this first version. The company check alone would
 * let every agent of the company read and change every page, and agents are
 * to be given access one Space at a time instead, so until that exists they
 * are refused here. So are Clippy's tool sessions: page changes from a chat
 * are to come as proposals the person applies. Someone not signed in is told
 * to sign in (401) first, rather than that they are not a person.
 */
const requirePerson: RequestHandler = (req, _res, next) => {
  assertAuthenticated(req);
  if (req.actor.type !== "board") {
    throw forbidden("Spaces are open to people only for now");
  }
  next();
};

/** The fields a Space update changed, by name, for its activity row. */
function changedSpaceFields(before: Space, after: Space): string[] {
  return (["name", "description", "sortOrder"] as const).filter((field) => before[field] !== after[field]);
}

export function spaceRoutes(db: Db) {
  const router = Router();
  const svc = spaceService(db);

  /** The Space named in the address, once the person may use it this way. */
  async function loadSpace(req: Request, mode: AccessMode) {
    const space = await svc.getById(req.params.spaceId as string);
    if (!space) throw notFound("Space not found");
    assertCompanyAccess(req, space.companyId, mode);
    return space;
  }

  /** A person changes Spaces, so the change is theirs. */
  function personActor(req: Request) {
    const actor = getActorInfo(req);
    return { actor, spaceActor: { agentId: null, userId: actor.actorId } };
  }

  // Activity rows for Spaces carry ids only, never a name, a description or
  // a page title. The activity feed, a person's profile and the live feed are
  // open to every agent of the company (and HQ's agents read across
  // companies), which Spaces are not.

  /** Activity for a change a person made in a Space: ids and numbers only (see above). */
  async function logSpaceActivity(
    req: Request,
    space: Space,
    action: string,
    entity: { type: "space" | "space_page"; id: string },
    details: Record<string, unknown>,
  ) {
    const { actor } = personActor(req);
    await logActivity(db, {
      companyId: space.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action,
      entityType: entity.type,
      entityId: entity.id,
      details,
    });
  }

  // The company's Spaces. With ?archived=true, only its archived ones.
  router.get("/companies/:companyId/spaces", requirePerson, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    res.json(await svc.list(companyId, { archived: req.query.archived === "true" }));
  });

  router.post("/companies/:companyId/spaces", requirePerson, validate(createSpaceSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { actor, spaceActor } = personActor(req);
    const space = await svc.create(companyId, req.body, spaceActor);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "space.created",
      entityType: "space",
      entityId: space.id,
      details: { spaceId: space.id },
    });
    res.status(201).json(space);
  });

  // The Space for an address: /<company>/spaces/<address key>. Its id works too.
  router.get("/companies/:companyId/spaces/:spaceRef", requirePerson, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    const space = await svc.getByRef(companyId, req.params.spaceRef as string);
    if (!space) throw notFound("Space not found");
    res.json(space);
  });

  router.patch("/spaces/:spaceId", requirePerson, validate(updateSpaceSchema), async (req, res) => {
    const existing = await loadSpace(req, "write");
    const result = await svc.update(existing.id, req.body);
    if (!result) throw notFound("Space not found");
    const { before, after: space } = result;
    const entity = { type: "space" as const, id: space.id };
    if (Boolean(before.archivedAt) !== Boolean(space.archivedAt)) {
      await logSpaceActivity(req, space, space.archivedAt ? "space.archived" : "space.unarchived", entity, {
        spaceId: space.id,
      });
    }
    const changed = changedSpaceFields(before, space);
    if (changed.length > 0) {
      await logSpaceActivity(req, space, "space.updated", entity, { spaceId: space.id, changed });
    }
    res.json(space);
  });

  router.get("/spaces/:spaceId/pages", requirePerson, async (req, res) => {
    const space = await loadSpace(req, "read");
    res.json(await svc.listPageTree(space.id));
  });

  router.post("/spaces/:spaceId/pages", requirePerson, validate(createSpacePageSchema), async (req, res) => {
    const space = await loadSpace(req, "write");
    const { actor, spaceActor } = personActor(req);
    const page = await svc.createPage(space, req.body, spaceActor);
    await logActivity(db, {
      companyId: space.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "space.page_created",
      entityType: "space_page",
      entityId: page.id,
      details: { spaceId: space.id, pageId: page.id, parentPageId: page.parentPageId },
    });
    res.status(201).json(page);
  });

  router.get("/spaces/:spaceId/pages/:pageId", requirePerson, async (req, res) => {
    const space = await loadSpace(req, "read");
    const page = await svc.getPage(space.id, req.params.pageId as string);
    if (!page) throw notFound("Page not found");
    res.json(page);
  });

  router.patch(
    "/spaces/:spaceId/pages/:pageId",
    requirePerson,
    validate(updateSpacePageSchema),
    async (req, res) => {
      const space = await loadSpace(req, "write");
      const { actor, spaceActor } = personActor(req);
      const result = await svc.updatePage(space, req.params.pageId as string, req.body, spaceActor);
      // One entry per version. An autosave that folds into the person's own
      // recent version is part of the change already logged.
      if (result.change === "new_version") {
        await logActivity(db, {
          companyId: space.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "space.page_updated",
          entityType: "space_page",
          entityId: result.page.id,
          details: {
            spaceId: space.id,
            pageId: result.page.id,
            revisionNumber: result.page.latestRevisionNumber,
          },
        });
      }
      res.json(result.page);
    },
  );

  // History. Anyone who can read the page can read its versions.
  router.get("/spaces/:spaceId/pages/:pageId/revisions", requirePerson, async (req, res) => {
    const space = await loadSpace(req, "read");
    const revisions = await svc.listRevisions(space.id, req.params.pageId as string);
    if (!revisions) throw notFound("Page not found");
    res.json(revisions);
  });

  router.get("/spaces/:spaceId/pages/:pageId/revisions/:revisionId", requirePerson, async (req, res) => {
    const space = await loadSpace(req, "read");
    const revision = await svc.getRevision(space.id, req.params.pageId as string, req.params.revisionId as string);
    if (!revision) throw notFound("Version not found");
    res.json(revision);
  });

  router.post(
    "/spaces/:spaceId/pages/:pageId/revisions/:revisionId/restore",
    requirePerson,
    validate(restoreSpacePageRevisionSchema),
    async (req, res) => {
      const space = await loadSpace(req, "write");
      const { spaceActor } = personActor(req);
      const result = await svc.restoreRevision(
        space,
        req.params.pageId as string,
        req.params.revisionId as string,
        req.body.baseRevisionId,
        spaceActor,
      );
      await logSpaceActivity(req, space, "space.page_version_restored", { type: "space_page", id: result.page.id }, {
        spaceId: space.id,
        pageId: result.page.id,
        revisionNumber: result.page.latestRevisionNumber,
        restoredFromRevisionNumber: result.restoredFromRevisionNumber,
      });
      res.json(result.page);
    },
  );

  // Order and move: a page with all its subpages, within its Space or to
  // another Space of the same company.
  router.post("/spaces/:spaceId/pages/:pageId/move", requirePerson, validate(moveSpacePageSchema), async (req, res) => {
    const space = await loadSpace(req, "write");
    const result = await svc.movePage(space, req.params.pageId as string, req.body);
    const { page } = result;
    // Putting pages in order under the same parent is not logged; a move is.
    if (page.spaceId !== result.fromSpaceId || page.parentPageId !== result.fromParentPageId) {
      await logSpaceActivity(req, space, "space.page_moved", { type: "space_page", id: page.id }, {
        spaceId: page.spaceId,
        pageId: page.id,
        parentPageId: page.parentPageId,
        fromSpaceId: result.fromSpaceId,
        fromParentPageId: result.fromParentPageId,
      });
    }
    res.json(page);
  });

  // Trash: a page goes with all its subpages, and comes back with them.
  router.delete("/spaces/:spaceId/pages/:pageId", requirePerson, async (req, res) => {
    const space = await loadSpace(req, "write");
    const result = await svc.deletePage(space, req.params.pageId as string);
    await logSpaceActivity(req, space, "space.page_deleted", { type: "space_page", id: result.pageId }, {
      spaceId: space.id,
      pageId: result.pageId,
      subpageCount: result.subpageCount,
    });
    res.json(result);
  });

  router.get("/spaces/:spaceId/trash", requirePerson, async (req, res) => {
    const space = await loadSpace(req, "read");
    res.json(await svc.listTrash(space.id));
  });

  router.post("/spaces/:spaceId/trash/:pageId/restore", requirePerson, async (req, res) => {
    const space = await loadSpace(req, "write");
    const result = await svc.restoreFromTrash(space, req.params.pageId as string);
    await logSpaceActivity(req, space, "space.page_restored", { type: "space_page", id: result.pageId }, {
      spaceId: space.id,
      pageId: result.pageId,
      parentPageId: result.parentPageId,
      subpageCount: result.subpageCount,
    });
    res.json(result);
  });

  // Where a page is now. An address names the page's Space, so after a move
  // to another Space its old address finds no page; the screens ask here.
  router.get("/companies/:companyId/space-pages/:pageId", requirePerson, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    const location = await svc.locatePage(companyId, req.params.pageId as string);
    if (!location) throw notFound("Page not found");
    res.json(location);
  });

  return router;
}
