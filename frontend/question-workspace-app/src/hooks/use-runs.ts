import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { PlanOptionChoice } from "@/lib/api-types";

/**
 * Data hooks for the run lifecycle, built on TanStack Query. Polling intervals match the previous vanilla
 * implementation (5s for the run list, 3s for an in-progress run) but are handled declaratively via
 * `refetchInterval`, which also pauses automatically once a run reaches a terminal status.
 */

const ACTIVE_STATUSES = new Set(["queued", "drafting", "running"]);

export function useRunList() {
  return useQuery({
    queryKey: ["runs"],
    queryFn: api.listRuns,
    refetchInterval: 5000,
  });
}

export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: ["run", id],
    queryFn: () => api.getRun(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data && ACTIVE_STATUSES.has(query.state.data.status) ? 3000 : false),
  });
}

export function usePlanDraft(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["plan", id],
    queryFn: () => api.getPlan(id!),
    enabled: Boolean(id) && enabled,
    // The draft is immutable once written; no polling needed, but keep it fresh across remounts.
    staleTime: 5 * 60 * 1000,
  });
}

export function useRunResult(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["result", id],
    queryFn: () => api.getResult(id!),
    enabled: Boolean(id) && enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useStartRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.startRun,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["runs"] }),
  });
}

export function useReanalyse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.reanalyse,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["runs"] }),
  });
}

export function useDeleteRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.deleteRun,
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: ["run", id] });
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

export function useCancelRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.cancelRun,
    onSuccess: (_record, id) => {
      queryClient.invalidateQueries({ queryKey: ["run", id] });
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

export function useConfirmPlan(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { methods: Record<string, string>; excluded: string[]; options?: Record<string, PlanOptionChoice> }) =>
      api.confirmPlan(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["run", id] });
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}
