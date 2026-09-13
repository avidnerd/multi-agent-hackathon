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

/** Kahn's algorithm, ties broken by input order so the result is deterministic. Nodes in a cycle are omitted. */
export function topologicalOrder(nodes: readonly DependencyNode[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const remaining = new Map(nodes.map((n) => [n.id, n.dependsOn.filter((d) => ids.has(d)).length]));
  const order: string[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of nodes) {
      if (remaining.get(node.id) !== 0) continue;
      order.push(node.id);
      remaining.delete(node.id);
      for (const other of nodes) {
        const count = remaining.get(other.id);
        if (count !== undefined && other.dependsOn.includes(node.id)) remaining.set(other.id, count - 1);
      }
      progressed = true;
    }
  }
  return order;
}

/** Every node that transitively depends on rootId, in topological order, excluding the root. */
export function downstreamOf(nodes: readonly DependencyNode[], rootId: string): string[] {
  const reached = new Set<string>();
  const frontier = [rootId];
  while (frontier.length > 0) {
    const current = frontier.pop();
    for (const node of nodes) {
      if (current !== undefined && node.dependsOn.includes(current) && !reached.has(node.id)) {
        reached.add(node.id);
        frontier.push(node.id);
      }
    }
  }
  return topologicalOrder(nodes).filter((id) => reached.has(id));
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
