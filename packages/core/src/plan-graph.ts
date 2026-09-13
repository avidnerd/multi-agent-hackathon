export interface DependencyNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export interface MissingDependency {
  readonly itemId: string;
  readonly missingId: string;
}

export function findMissingDependencies(nodes: readonly DependencyNode[]): MissingDependency[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes.flatMap((n) =>
    n.dependsOn.filter((dep) => !ids.has(dep)).map((missingId) => ({ itemId: n.id, missingId })),
  );
}

/** Returns the first cycle found as a closed path (first id repeated at the end), or null. */
export function findDependencyCycle(nodes: readonly DependencyNode[]): readonly string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  const visit = (id: string): readonly string[] | null => {
    const seen = state.get(id);
    if (seen === "done") return null;
    if (seen === "visiting") return [...path.slice(path.indexOf(id)), id];
    const node = byId.get(id);
    // Dangling references are reported by findMissingDependencies, not here.
    if (node === undefined) return null;

    state.set(id, "visiting");
    path.push(id);
    for (const dep of node.dependsOn) {
      const cycle = visit(dep);
      if (cycle !== null) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return null;
  };

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle !== null) return cycle;
  }
  return null;
}
