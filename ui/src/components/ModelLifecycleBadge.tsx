import type { ModelLifecycleFields } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { modelLifecycleTags, UNAVAILABLE_MODEL_TAG, type ModelTag } from "../lib/model-display";
import { modelTagBadge } from "../lib/status-colors";

interface ModelLifecycleBadgeProps {
  /** The model to tag. */
  model?: ModelLifecycleFields | null;
  /** The saved model is not in the provider's list: shows "Not available" instead. */
  unavailable?: boolean;
  className?: string;
}

/**
 * The small tags beside a model name in every model picker: "New", "Used by default",
 * and "Retires <date>" in a warning tone, or "Not available" for a saved model
 * the provider no longer lists. Renders nothing for a plain current model.
 *
 * Uses a native title for the longer words, because picker rows are buttons
 * and a Tooltip inside one would fight it for the pointer.
 */
export function ModelLifecycleBadge({ model, unavailable, className }: ModelLifecycleBadgeProps) {
  const tags = unavailable ? [UNAVAILABLE_MODEL_TAG] : model ? modelLifecycleTags(model) : [];
  if (tags.length === 0) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {tags.map((tag) => (
        <ModelTagPill key={tag.kind} tag={tag} />
      ))}
    </span>
  );
}

function ModelTagPill({ tag }: { tag: ModelTag }) {
  return (
    <span
      title={tag.title}
      data-model-tag={tag.kind}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border border-transparent px-1.5 py-0.5 text-[10px] font-medium leading-none",
        modelTagBadge[tag.kind],
      )}
    >
      {tag.label}
    </span>
  );
}
