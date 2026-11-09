import * as React from "react";
import { I18N, type Dict, type Lang } from "@/lib/i18n";

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggle: () => void;
  t: Dict;
  /** Picks the [zh, en] pair member for the current language (e.g. STUDY_TYPE, MEASURE lookup tables). */
  pick: (pair: [string, string] | undefined) => string;
}

const LangContext = React.createContext<LangContextValue | null>(null);

function readStoredLang(): Lang {
  try {
    const stored = window.localStorage.getItem("mimic-lang");
    return stored === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<Lang>(readStoredLang);

  const setLang = React.useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem("mimic-lang", next);
    } catch {
      /* private mode */
    }
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  }, []);

  React.useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  const value = React.useMemo<LangContextValue>(
    () => ({
      lang,
      setLang,
      toggle: () => setLang(lang === "zh" ? "en" : "zh"),
      t: I18N[lang],
      pick: (pair) => (pair ? pair[lang === "zh" ? 0 : 1] : ""),
    }),
    [lang, setLang],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const ctx = React.useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used within LangProvider");
  return ctx;
}
