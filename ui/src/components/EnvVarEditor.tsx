import { useEffect, useRef, useState } from "react";
import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import { X } from "lucide-react";
import { InfoPopoverButton } from "@/components/InfoPopoverButton";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

const SECRETS_GUIDE_URL = "https://docs.paperclip.ing/#/reference/guides/board-operator/managing-secrets";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

type Row = {
  key: string;
  source: "plain" | "secret";
  plainValue: string;
  secretId: string;
};

function toRows(rec: Record<string, EnvBinding> | null | undefined): Row[] {
  if (!rec || typeof rec !== "object") {
    return [{ key: "", source: "plain", plainValue: "", secretId: "" }];
  }
  const entries = Object.entries(rec).map(([key, binding]) => {
    if (typeof binding === "string") {
      return { key, source: "plain" as const, plainValue: binding, secretId: "" };
    }
    if (
      typeof binding === "object" &&
      binding !== null &&
      "type" in binding &&
      (binding as { type?: unknown }).type === "secret_ref"
    ) {
      const record = binding as { secretId?: unknown };
      return {
        key,
        source: "secret" as const,
        plainValue: "",
        secretId: typeof record.secretId === "string" ? record.secretId : "",
      };
    }
    if (
      typeof binding === "object" &&
      binding !== null &&
      "type" in binding &&
      (binding as { type?: unknown }).type === "plain"
    ) {
      const record = binding as { value?: unknown };
      return {
        key,
        source: "plain" as const,
        plainValue: typeof record.value === "string" ? record.value : "",
        secretId: "",
      };
    }
    return { key, source: "plain" as const, plainValue: "", secretId: "" };
  });
  return [...entries, { key: "", source: "plain", plainValue: "", secretId: "" }];
}

export function EnvVarEditor({
  value,
  secrets,
  onChange,
}: {
  value: Record<string, EnvBinding>;
  secrets: CompanySecret[];
  onChange: (env: Record<string, EnvBinding> | undefined) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const valueRef = useRef(value);
  const emittingRef = useRef(false);

  useEffect(() => {
    if (emittingRef.current) {
      emittingRef.current = false;
      valueRef.current = value;
      return;
    }
    if (value !== valueRef.current) {
      valueRef.current = value;
      setRows(toRows(value));
    }
  }, [value]);

  function emit(nextRows: Row[]) {
    const rec: Record<string, EnvBinding> = {};
    for (const row of nextRows) {
      const key = row.key.trim();
      if (!key) continue;
      if (row.source === "secret") {
        if (row.secretId) {
          rec[key] = { type: "secret_ref", secretId: row.secretId, version: "latest" };
        }
      } else {
        rec[key] = { type: "plain", value: row.plainValue };
      }
    }
    emittingRef.current = true;
    onChange(Object.keys(rec).length > 0 ? rec : undefined);
  }

  function updateRow(index: number, patch: Partial<Row>) {
    const withPatch = rows.map((row, rowIndex) => {
      if (rowIndex !== index) return row;
      const next = { ...row, ...patch };
      // When source=secret, derive the key from the chosen secret's name.
      if (next.source === "secret") {
        if (next.secretId) {
          const matched = secrets.find((secret) => secret.id === next.secretId);
          next.key = matched ? matched.name : "";
        } else {
          next.key = "";
        }
      }
      return next;
    });
    if (
      withPatch[withPatch.length - 1].key ||
      withPatch[withPatch.length - 1].plainValue ||
      withPatch[withPatch.length - 1].secretId
    ) {
      withPatch.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(withPatch);
    emit(withPatch);
  }

  function removeRow(index: number) {
    const next = rows.filter((_, rowIndex) => rowIndex !== index);
    if (
      next.length === 0 ||
      next[next.length - 1].key ||
      next[next.length - 1].plainValue ||
      next[next.length - 1].secretId
    ) {
      next.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(next);
    emit(next);
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, index) => {
        const isTrailing =
          index === rows.length - 1 &&
          !row.key &&
          !row.plainValue &&
          !row.secretId;
        const keyReadOnly = row.source === "secret";
        return (
          <div key={index} className="flex items-center gap-1.5">
            <select
              className={cn(inputClass, "flex-[1] bg-background")}
              value={row.source}
              onChange={(event) => {
                const nextSource = event.target.value === "secret" ? "secret" : "plain";
                if (nextSource === "secret") {
                  // Plain -> Secret: clear plainValue, key, and secretId.
                  updateRow(index, {
                    source: "secret",
                    plainValue: "",
                    secretId: "",
                    key: "",
                  });
                } else {
                  // Secret -> Plain: clear secretId, keep key as a starting point.
                  updateRow(index, {
                    source: "plain",
                    secretId: "",
                  });
                }
              }}
            >
              <option value="plain">Plain</option>
              <option value="secret">Secret</option>
            </select>
            <input
              className={cn(
                inputClass,
                "flex-[2]",
                keyReadOnly && "bg-muted/30 cursor-not-allowed text-muted-foreground",
              )}
              placeholder="KEY"
              value={row.key}
              readOnly={keyReadOnly}
              onChange={(event) => updateRow(index, { key: event.target.value })}
            />
            {row.source === "secret" ? (
              <select
                className={cn(inputClass, "flex-[3] bg-background")}
                value={row.secretId}
                onChange={(event) => updateRow(index, { secretId: event.target.value })}
              >
                <option value="">Select secret...</option>
                {secrets.map((secret) => (
                  <option key={secret.id} value={secret.id}>
                    {secret.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={cn(inputClass, "flex-[3]")}
                placeholder="value"
                value={row.plainValue}
                onChange={(event) => updateRow(index, { plainValue: event.target.value })}
              />
            )}
            {!isTrailing ? (
              <button
                type="button"
                className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                onClick={() => removeRow(index)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <div className="w-[26px] shrink-0" />
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
        <p>
          PAPERCLIP_* variables are injected automatically at runtime. Secrets are managed in{" "}
          <Link to="/company/settings/secrets" className="underline underline-offset-2 hover:text-foreground">
            Company Settings &gt; Secrets
          </Link>
          .
        </p>
        <InfoPopoverButton
          title="How env bindings work"
          side="top"
          info={
            <>
              <p>
                Each row maps an env-var name to either a plain value or a vault secret. Adding a secret to
                Company Settings doesn't auto-expose it — this editor is where you tell <em>this</em> agent
                or project to inject it as an env var.
              </p>
              <p>
                Pick "Secret" as the source and choose the vault entry. The runtime resolves the value at
                process start.
              </p>
              <p>
                <a
                  href={SECRETS_GUIDE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Learn more →
                </a>
              </p>
            </>
          }
        />
      </div>
    </div>
  );
}
