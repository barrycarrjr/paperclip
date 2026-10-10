import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { useBreadcrumbsOptional } from "../context/BreadcrumbContext";
import { useCompanyOptional } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import {
  clippyGreetingName,
  describeClippyPage,
  suggestedClippyPrompts,
  type ClippyPageContext,
} from "../lib/clippy-page-context";
import { resolveRouteCompanyId } from "./useRouteCompany";

/**
 * The page Clippy is opened over: the context chip for a new chat, and the
 * questions its empty state suggests.
 */
export function useClippyPage(): { pageContext: ClippyPageContext | null; suggestions: string[] } {
  const { pathname } = useLocation();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const companyContext = useCompanyOptional();
  const breadcrumbs = useBreadcrumbsOptional()?.breadcrumbs;

  return useMemo(() => {
    const companies = companyContext?.companies ?? [];
    const companyId = resolveRouteCompanyId({ companyPrefix, companies }) ?? companyContext?.selectedCompanyId ?? null;
    const companyName = companies.find((c) => c.id === companyId)?.name ?? null;
    return {
      pageContext: describeClippyPage({ pathname, companyPrefix, companyName, breadcrumbs }),
      suggestions: suggestedClippyPrompts({ pathname, companyPrefix, companyName }),
    };
  }, [pathname, companyPrefix, companyContext?.companies, companyContext?.selectedCompanyId, breadcrumbs]);
}

/** The signed-in person's first name for "How can I help, Pat?", or null. */
export function useClippyGreetingName(): string | null {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  return clippyGreetingName(session?.user?.name);
}
