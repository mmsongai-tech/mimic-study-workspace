import * as React from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { api, UNAUTHORIZED_EVENT } from "@/lib/api";
import { useLang } from "@/hooks/use-lang";
import { Button } from "@/components/ui/button";

const accessStatusQuery = queryOptions({ queryKey: ["access-status"], queryFn: api.accessStatus, staleTime: Infinity });

/**
 * Whether this server asks for an invite code. Read from the same cached status the gate loads before it renders anything,
 * so pages inside the gate get the answer without another request; false while unknown.
 */
export function useInviteGate(): boolean {
  return Boolean(useQuery(accessStatusQuery).data?.gate_enabled);
}

/**
 * Wraps the app: when the server has an invite code configured, nothing is rendered (and no /api/runs request is made)
 * until the visitor holds a valid session token. A 401 from any later call clears the token and brings this back.
 */
export function AccessGate({ children }: { children: React.ReactNode }) {
  const { t, toggle } = useLang();
  const queryClient = useQueryClient();
  const status = useQuery(accessStatusQuery);
  const [unlocked, setUnlocked] = React.useState(api.hasToken());
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const relock = () => setUnlocked(false);
    window.addEventListener(UNAUTHORIZED_EVENT, relock);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, relock);
  }, []);

  if (status.isLoading) return null;
  if (!status.data?.gate_enabled || unlocked) return <>{children}</>;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(false);
    try {
      await api.unlock(code.trim());
      queryClient.clear();
      setUnlocked(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-primary" />
          <h1 className="text-base font-semibold">{t.title}</h1>
        </div>
        <div>
          <h2 className="text-sm font-medium">{t.accessTitle}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t.accessHint}</p>
        </div>
        <input
          type="password"
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-label={t.accessCode}
          placeholder={t.accessCode}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {error && <p role="alert" className="text-xs text-destructive">{t.accessInvalid}</p>}
        <Button type="submit" className="w-full" disabled={busy || !code.trim()}>{t.accessEnter}</Button>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <a href="/how-it-works.html" target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">{t.accessHow}</a>
          <button type="button" onClick={toggle} className="underline-offset-4 hover:underline">{t.switchLang}</button>
        </div>
      </form>
    </div>
  );
}
