/**
 * The signed-in user's connected chat app accounts (Slack, for example).
 *
 * A user pairs a chat account to themselves here by entering the code the
 * chat app's bot sent them; see services/channel-links.ts for the flow. Only
 * the user themselves can see, add or remove their connections. These are
 * user-level, not company-level, so the server log is their audit trail.
 */
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { channelPairingCodeSchema } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { channelLinkService } from "../services/channel-links.js";

function requireSignedInUser(req: Request): string {
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw forbidden("Sign in to manage connected chat apps");
  }
  if (req.actor.source === "local_implicit") {
    throw forbidden("Connected chat apps need a user account, and this instance runs without sign-in");
  }
  return req.actor.userId;
}

export function channelLinkRoutes(db: Db) {
  const router = Router();
  const links = channelLinkService(db);

  router.get("/me/channel-links", async (req, res) => {
    const userId = requireSignedInUser(req);
    res.json({ links: await links.listForUser(userId) });
  });

  router.post("/me/channel-links/preview", validate(channelPairingCodeSchema), async (req, res) => {
    const userId = requireSignedInUser(req);
    res.json({ pairing: await links.previewPairing(userId, req.body.code) });
  });

  router.post("/me/channel-links", validate(channelPairingCodeSchema), async (req, res) => {
    const userId = requireSignedInUser(req);
    const { link, replacedUserId } = await links.claimPairing(userId, req.body.code);
    logger.info(
      {
        userId,
        linkId: link.id,
        pluginKey: link.pluginKey,
        externalWorkspace: link.externalWorkspace,
        externalUserId: link.externalUserId,
        replacedUserId,
      },
      "chat app account connected to a user",
    );
    res.status(201).json({ link });
  });

  router.delete("/me/channel-links/:id", async (req, res) => {
    const userId = requireSignedInUser(req);
    const linkId = req.params.id as string;
    if (!(await links.removeForUser(userId, linkId))) {
      throw notFound("Connection not found");
    }
    logger.info({ userId, linkId }, "chat app account disconnected from a user");
    res.status(204).end();
  });

  return router;
}
