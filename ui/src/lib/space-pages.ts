import type { Space, SpacePageTreeNode } from "@paperclipai/shared";

/** The title a new page starts with, and what a page with no title is called. */
export const NEW_SPACE_PAGE_TITLE = "Untitled";

export function spacePageTitle(title: string) {
  return title.trim() || NEW_SPACE_PAGE_TITLE;
}

/** How far each level of subpages is set in: a full step for six levels, then a smaller one. */
const TREE_INDENT_PX = 14;
const TREE_INDENT_FULL_DEPTH = 6;
const TREE_INDENT_DEEP_PX = 6;

/**
 * How far a page at this depth is set in. Past six levels the step gets
 * smaller rather than stopping, so a subpage never sits level with its
 * parent and reads as its sibling.
 */
export function spacePageIndentPx(depth: number): number {
  const full = Math.min(depth, TREE_INDENT_FULL_DEPTH);
  return full * TREE_INDENT_PX + Math.max(0, depth - TREE_INDENT_FULL_DEPTH) * TREE_INDENT_DEEP_PX;
}

export function spacePageHref(space: Pick<Space, "urlKey">, pageId: string) {
  return `/spaces/${space.urlKey}/${pageId}`;
}

/** A page anywhere in the tree, or null when it is not there. */
export function findSpacePage(nodes: SpacePageTreeNode[], pageId: string): SpacePageTreeNode | null {
  for (const node of nodes) {
    if (node.id === pageId) return node;
    const below = findSpacePage(node.children, pageId);
    if (below) return below;
  }
  return null;
}

/** The pages a page sits among under its parent, in their order, itself included. */
export function spacePageSiblings(tree: SpacePageTreeNode[], page: Pick<SpacePageTreeNode, "parentPageId">) {
  if (!page.parentPageId) return tree;
  return findSpacePage(tree, page.parentPageId)?.children ?? [];
}

/** A page's own id and the ids of every subpage under it. */
export function spacePageSubtreeIds(page: SpacePageTreeNode): Set<string> {
  const ids = new Set<string>();
  const visit = (node: SpacePageTreeNode) => {
    ids.add(node.id);
    node.children.forEach(visit);
  };
  visit(page);
  return ids;
}

/** The tree as one list in reading order, each page with how deep it sits. */
export function flattenSpacePageTree(nodes: SpacePageTreeNode[], depth = 0): Array<{ node: SpacePageTreeNode; depth: number }> {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenSpacePageTree(node.children, depth + 1)]);
}
