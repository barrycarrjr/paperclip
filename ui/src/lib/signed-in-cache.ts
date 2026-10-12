import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

const SESSION_KEY = JSON.stringify(queryKeys.auth.session);

/**
 * Forgets everything cached for whoever was signed in, then asks again who is
 * signed in now. Without it, the next person to sign in on the same tab is
 * shown, for a while, what was loaded for the last one, and a settings page
 * could even save the last person's copy of a plugin's config as their own.
 *
 * The session itself stays until its fresh answer arrives, because the sign-in
 * gate reads it to decide where to send the person next.
 */
export async function forgetSignedInData(queryClient: QueryClient): Promise<void> {
  queryClient.removeQueries({ predicate: (query) => JSON.stringify(query.queryKey) !== SESSION_KEY });
  await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
}
