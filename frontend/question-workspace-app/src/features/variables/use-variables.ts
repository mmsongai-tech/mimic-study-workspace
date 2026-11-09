import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SearchKind, VariableDefinition } from "@/lib/variables-types";

export function useVariableSearch(kind: SearchKind, query: string) {
  const trimmed = query.trim();
  return useQuery({ queryKey: ["variable-search", kind, trimmed], queryFn: () => api.searchVariables(kind, trimmed), enabled: trimmed.length >= 2, staleTime: 5 * 60 * 1000, retry: false });
}
export function useVariableLists() { return useQuery({ queryKey: ["variables"], queryFn: api.listVariables, retry: false }); }
export function useCheckVariable() { return useMutation({ mutationFn: (definition: VariableDefinition) => api.checkVariable(definition) }); }
export function useSaveVariable() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (definition: VariableDefinition) => api.saveVariable(definition), onSuccess: () => client.invalidateQueries({ queryKey: ["variables"] }) });
}
export function useDeleteVariable() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.deleteVariable(id), onSuccess: () => client.invalidateQueries({ queryKey: ["variables"] }) });
}
