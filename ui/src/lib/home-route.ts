/**
 * Where signing in should put you.
 *
 * Paperclip has always landed on one company's Brief - whichever you last
 * looked at, or the first one it found. That is right when you run one company
 * and wrong the moment you run several, because a problem in any of the others
 * is invisible from there.
 *
 * It was wrong in exactly that way today: ten agents across four companies had
 * been failing to sign in for three days, and the Brief on screen covered one
 * of them. Nothing on it was untrue. It simply was not looking anywhere else.
 *
 * So when there is a portfolio root and more than one company to look at, home
 * is the view that covers all of them. A single-company instance is untouched,
 * and every deep link into a company keeps working exactly as before - this
 * only decides the front door.
 */

export interface HomeRouteCompany {
  issuePrefix?: string | null;
  isPortfolioRoot?: boolean | null;
  status?: string | null;
}

/**
 * The path to send someone to for "/". Null when there is nowhere sensible to
 * go, which the caller already handles by showing the no-companies start page.
 */
export function chooseHomeRoute(input: {
  companies: readonly HomeRouteCompany[];
  /** The company they were last on, if any. */
  selectedCompany?: HomeRouteCompany | null;
}): string | null {
  const live = input.companies.filter((company) => company.status !== "archived");

  // An archived HQ is not a home. Nor is one with no prefix to route to.
  const portfolioRoot = live.find(
    (company) => company.isPortfolioRoot && Boolean(company.issuePrefix),
  );
  if (portfolioRoot && live.length > 1) {
    return `/${portfolioRoot.issuePrefix}/portfolio-brief`;
  }

  // Only ever fall back to a company that can actually be routed to. Picking
  // the first one in the list and finding it has no prefix would strand the
  // front door, which is the worst place to strand anyone.
  const routable = (company: HomeRouteCompany | null | undefined) =>
    company?.issuePrefix ? company : null;
  const target =
    routable(input.selectedCompany) ??
    live.find((company) => Boolean(company.issuePrefix)) ??
    input.companies.find((company) => Boolean(company.issuePrefix)) ??
    null;
  if (!target?.issuePrefix) return null;
  return `/${target.issuePrefix}/brief`;
}
