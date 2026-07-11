"use client";

import {
  createContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

/**
 * Shared source-chip selection so the CRM funnel and התנגדויות rail sections
 * filter on ONE set of sources — toggling a source in either section filters
 * both. The two `CrmFunnelClient` instances (view="funnel" + view="analysis")
 * consume this; when it's absent (the classic full-card layout, /morning) they
 * fall back to their own local state.
 *
 * The value is a `useState` tuple, so the consumer's existing functional
 * `setSelected(prev => …)` handlers work against it unchanged. It's seeded to
 * an empty set here and reset to the real `allSources` by the first consumer's
 * source-signature check (the provider can't know the sources itself).
 */
export const CrmSourceFilterContext = createContext<
  [Set<string>, Dispatch<SetStateAction<Set<string>>>] | null
>(null);

export function CrmSourceFilterProvider({ children }: { children: ReactNode }) {
  const state = useState<Set<string>>(() => new Set<string>());
  return (
    <CrmSourceFilterContext.Provider value={state}>
      {children}
    </CrmSourceFilterContext.Provider>
  );
}
