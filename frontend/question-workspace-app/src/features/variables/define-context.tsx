import * as React from "react";

/** Lets any mapping row offer "define this variable" without every view above it passing a callback down. */
const DefineVariableContext = React.createContext<((term: string) => void) | undefined>(undefined);
export const DefineVariableProvider = DefineVariableContext.Provider;
export const useDefineVariable = (): ((term: string) => void) | undefined => React.useContext(DefineVariableContext);
