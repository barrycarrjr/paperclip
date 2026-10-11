import { Router, type Request, type RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import {
  createSpacePageSchema,
  createSpaceSchema,
  updateSpacePageSchema,
  updateSpaceSchema,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity, spaceService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo, type AccessMode } from "./authz.js";

/**
 * Spaces are for people in this first version. The company check alone would
 * let every agent of the company read and change every page, and agents are
 * to be given access one Space at a time instead, so until that exists they
 * are refused here. So are Clippy's tool sessions: page changes from a chat
 * are to come as proposals the person applies.
 */
const requirePerson: RequestHandler = (req, _res, next) => {
  if (req.actor.type !== "board") {
    throw forbidden("Spaces are open to people only for now");
  }
  next();
};

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

  router.get("/companies/:companyId/spaces", requirePerson, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    res.json(await svc.list(companyId));
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
      details: { name: space.name, urlKey: space.urlKey },
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
    const space = await svc.update(existing.id, req.body);
    if (!space) throw notFound("Space not found");
    const { actor } = personActor(req);
    await logActivity(db, {
      companyId: space.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "space.updated",
      entityType: "space",
      entityId: space.id,
      details: req.body,
    });
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
      details: { spaceId: space.id, title: page.title, parentPageId: page.parentPageId },
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
            title: result.page.title,
            revisionNumber: result.page.latestRevisionNumber,
          },
        });
      }
      res.json(result.page);
    },
  );

  return router;
}
