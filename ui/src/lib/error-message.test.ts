import { describe, expect, it } from "vitest";
import {
  describeError,
  failedResponseMessage,
  GENERIC_FAILURE_MESSAGE,
  isNetworkFailure,
  NETWORK_FAILURE_MESSAGE,
  statusFailureMessage,
} from "./error-message";

/** What the server sent for a body that failed its schema: the problem list as JSON, in `error`. */
function zodJson(issues: Array<{ path: Array<string | number>; message: string }>) {
  return JSON.stringify(issues.map((issue) => ({ code: "custom", ...issue })), null, 2);
}

describe("failedResponseMessage: the server sent words", () => {
  it("keeps them as they are", () => {
    expect(failedResponseMessage(409, { error: "A skill with that name already exists." })).toBe(
      "A skill with that name already exists.",
    );
  });

  it("takes the plugin bridge's `message` and the sign-in library's nested one", () => {
    expect(failedResponseMessage(502, { code: "WORKER_ERROR", message: "Help Scout returned 401" })).toBe(
      "Help Scout returned 401",
    );
    expect(failedResponseMessage(401, { error: { code: "X", message: "Invalid email or password" } })).toBe(
      "Invalid email or password",
    );
  });

  it("adds the server's advice on what to do instead", () => {
    const body = {
      error: "Only an instance admin can import skills from folders on this computer.",
      code: "skill_local_import_admin_required",
      details: {
        code: "skill_local_import_admin_required",
        remediation: "Import from a URL, GitHub or skills.sh instead, or ask an instance admin.",
      },
    };

    expect(failedResponseMessage(403, body)).toBe(
      "Only an instance admin can import skills from folders on this computer. "
        + "Import from a URL, GitHub or skills.sh instead, or ask an instance admin.",
    );
  });

  it("keeps the refused names the server lists", () => {
    const body = {
      error: "These names cannot be set for a stage: ANTHROPIC_BASE_URL, PAPERCLIP_API_KEY. They control the agent's sign-in.",
      code: "stage_env_name_protected",
      details: { code: "stage_env_name_protected", names: ["ANTHROPIC_BASE_URL", "PAPERCLIP_API_KEY"] },
    };

    expect(failedResponseMessage(422, body)).toBe(body.error);
  });
});

describe("failedResponseMessage: the server sent only a code", () => {
  it("words a known code sent beside no words", () => {
    expect(failedResponseMessage(403, { code: "skill_local_import_admin_required" })).toBe(
      "Only an instance admin can import skills from folders on this computer.",
    );
    expect(failedResponseMessage(422, { details: { code: "skill_source_path_not_supported" } })).toBe(
      "Skills cannot be imported from a network share or a device path.",
    );
  });

  it("words a known code sent where the words belong", () => {
    expect(failedResponseMessage(403, { error: "skill_file_boundary_denied" })).toBe(
      "Skill file paths must stay inside the skill folder.",
    );
    expect(failedResponseMessage(503, { status: "unhealthy", error: "database_unreachable" })).toBe(
      "Paperclip cannot reach its database. Try again in a moment.",
    );
  });

  it("prefers words the server sent in another field over its code", () => {
    expect(
      failedResponseMessage(503, {
        status: "unhealthy",
        error: "database_unreachable",
        message: "Paperclip cannot reach its database.",
      }),
    ).toBe("Paperclip cannot reach its database.");
  });

  it("keeps the refused names when the stage refusal carries only its code", () => {
    const body = { code: "stage_env_name_protected", details: { code: "stage_env_name_protected", names: ["PATH", "PAPERCLIP_API_KEY"] } };

    expect(failedResponseMessage(422, body)).toBe("These names cannot be set for a stage: PATH, PAPERCLIP_API_KEY.");
  });

  it("says what the status means for a code it does not know, never the code", () => {
    const message = failedResponseMessage(403, { error: "workspace_scope_denied" });

    expect(message).toBe("You do not have permission to do that.");
    expect(message).not.toContain("workspace_scope_denied");
  });
});

describe("failedResponseMessage: the server sent JSON", () => {
  it("names each field a failed validation found, from the JSON sent as the error", () => {
    const body = { error: zodJson([{ path: ["intent"], message: "String must contain at most 4000 character(s)" }]) };

    expect(failedResponseMessage(400, body)).toBe(
      "Some details are not valid. intent: String must contain at most 4000 character(s).",
    );
  });

  it("names the fields of a validation failure sent as details", () => {
    const body = {
      error: "Validation error",
      details: [
        { code: "invalid_type", path: ["name"], message: "Required" },
        { code: "invalid_type", path: ["env", "API_URL", "value"], message: "Expected string, received number" },
      ],
    };

    expect(failedResponseMessage(400, body)).toBe(
      "Some details are not valid. name: Required; env.API_URL.value: Expected string, received number.",
    );
  });

  it("digs the words out of an error that is a JSON reply", () => {
    expect(failedResponseMessage(502, { error: JSON.stringify({ error: "Mailbox not found" }) })).toBe("Mailbox not found");
  });

  it("never shows JSON it cannot find words in", () => {
    expect(failedResponseMessage(500, { error: JSON.stringify({ stack: "at x" }) })).toBe(
      "Something went wrong on the server. Try again in a moment.",
    );
  });
});

describe("failedResponseMessage: the server sent no words", () => {
  it("says something went wrong on the server instead of Internal server error", () => {
    expect(failedResponseMessage(500, { error: "Internal server error" })).toBe(
      "Something went wrong on the server. Try again in a moment.",
    );
  });

  it("words the server's stock words for a status", () => {
    expect(failedResponseMessage(403, { error: "Forbidden" })).toBe("You do not have permission to do that.");
    expect(failedResponseMessage(404, { error: "Not found" })).toBe(
      "That could not be found. It may have been moved or deleted.",
    );
  });

  it("words a reply with no body, or a web page, by its status", () => {
    expect(failedResponseMessage(502, null)).toBe("A service Paperclip depends on did not answer. Try again in a moment.");
    expect(failedResponseMessage(500, "<!DOCTYPE html><html><body>Bad gateway</body></html>")).toBe(
      "Something went wrong on the server. Try again in a moment.",
    );
    expect(failedResponseMessage(418, {})).toBe("That could not be done. Check what you entered and try again.");
  });
});

describe("describeError", () => {
  it("keeps an error's own words", () => {
    expect(describeError(new Error("Name is taken"))).toBe("Name is taken");
    expect(describeError("smtp refused")).toBe("smtp refused");
    expect(describeError({ code: "WORKER_ERROR", message: "The plugin is not running." })).toBe(
      "The plugin is not running.",
    );
  });

  it("says Paperclip could not be reached for the browser's network failure, in any browser's words", () => {
    expect(describeError(new TypeError("Failed to fetch"))).toBe(NETWORK_FAILURE_MESSAGE);
    expect(describeError(new TypeError("NetworkError when attempting to fetch resource."))).toBe(NETWORK_FAILURE_MESSAGE);
    expect(describeError(new TypeError("Load failed"))).toBe(NETWORK_FAILURE_MESSAGE);
  });

  it("leaves other TypeErrors alone", () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch dynamically imported module: /plugins/a.js"))).toBe(false);
    expect(isNetworkFailure(new Error("Failed to fetch"))).toBe(false);
  });

  it("words a code thrown as an error's message", () => {
    expect(describeError(new Error("database_unreachable"))).toBe(
      "Paperclip cannot reach its database. Try again in a moment.",
    );
    expect(describeError(new Error("SOME_UNKNOWN_CODE"))).toBe(GENERIC_FAILURE_MESSAGE);
  });

  it("words JSON thrown as an error's message", () => {
    expect(describeError(new Error(zodJson([{ path: ["text"], message: "Required" }])))).toBe(
      "Some details are not valid. text: Required.",
    );
  });

  it("reads the status and the reply an error carries when its message has no words", () => {
    const error = Object.assign(new Error("Internal server error"), { status: 503 });
    expect(describeError(error)).toBe("Paperclip is not available right now. Try again in a moment.");
    expect(describeError(new Error("Internal server error"))).toBe(
      "Something went wrong on the server. Try again in a moment.",
    );
    expect(
      describeError(Object.assign(new Error(""), { status: 403, body: { code: "skill_file_boundary_denied" } })),
    ).toBe("Skill file paths must stay inside the skill folder.");
  });

  it("says an answer that could not be read in words, not the parser's", () => {
    expect(describeError(new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"))).toBe(
      "Paperclip sent back an answer that could not be read. Try again.",
    );
  });

  it("says the fallback when there is nothing to word", () => {
    expect(describeError(undefined, "Could not save.")).toBe("Could not save.");
    expect(describeError({ nope: true }, "Could not save.")).toBe("Could not save.");
    expect(describeError(new Error("[object Object]"))).toBe(GENERIC_FAILURE_MESSAGE);
    expect(describeError(new Error("   "), "")).toBe("");
  });
});

describe("statusFailureMessage", () => {
  it("has words for every failing status and none for a success", () => {
    expect(statusFailureMessage(429)).toBe("Too many requests. Wait a moment and try again.");
    expect(statusFailureMessage(507)).toBe("Something went wrong on the server. Try again in a moment.");
    expect(statusFailureMessage(200)).toBeNull();
    expect(statusFailureMessage(0)).toBeNull();
  });
});
