import type { FaultKind, FaultSpec } from "@trip/clients/contracts";

export interface RequestShape {
  readonly method: string;
  readonly path: string;
}

interface ArmedFault {
  readonly spec: FaultSpec;
  remaining: number;
}

function isOneOf<K extends FaultKind>(spec: FaultSpec, kinds: readonly K[]): spec is Extract<FaultSpec, { kind: K }> {
  return (kinds as readonly FaultKind[]).includes(spec.kind);
}

function matches(spec: FaultSpec, request: RequestShape): boolean {
  return (spec.method === undefined || spec.method === request.method) && (spec.pathPrefix === undefined || request.path.startsWith(spec.pathPrefix));
}

/** Armed faults fire in the order they were armed, each on the next `count` matching requests. */
export class FaultQueue {
  #armed: ArmedFault[] = [];

  arm(spec: FaultSpec): void {
    this.#armed.push({ spec, remaining: spec.count });
  }

  clear(): void {
    this.#armed = [];
  }

  list(): FaultSpec[] {
    return this.#armed.map((a) => ({ ...a.spec, count: a.remaining }));
  }

  take<K extends FaultKind>(kinds: readonly K[], request: RequestShape): Extract<FaultSpec, { kind: K }> | null {
    for (const [index, armed] of this.#armed.entries()) {
      const { spec } = armed;
      if (!isOneOf(spec, kinds) || !matches(spec, request)) continue;
      armed.remaining -= 1;
      if (armed.remaining === 0) this.#armed.splice(index, 1);
      return spec;
    }
    return null;
  }
}
