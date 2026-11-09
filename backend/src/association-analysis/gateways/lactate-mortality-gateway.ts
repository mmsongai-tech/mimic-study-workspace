import type { AssociationInput } from "../domain/association-analysis.js";

export interface LactateMortalityGateway {
  load(): Promise<AssociationInput>;
}
