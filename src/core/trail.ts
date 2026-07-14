/**
 * Reading trail: the partial call graph a reader discovers by navigating
 * (design.md §3.7). Pure logic, no vscode dependency.
 *
 * The data is a graph — functions plus "caller calls callee" edges — because
 * call structure is one: a callee reached from several callers, recursion.
 * The sidebar tree is a projection computed per render: a callee appears
 * again under every discovered caller (mirror nodes share their subtree
 * lazily), and a node repeating inside its own ancestor chain is cut off as a
 * recursion leaf.
 */

export type TrailNodeKind = 'function' | 'method' | 'class' | 'module';

export interface TrailNodeInput {
  key: string;
  name: string;
  /** owning container (class, outer function) — rendered as `Container.name` */
  containerName?: string;
  kind: TrailNodeKind;
  uriString: string;
  /** header line of the definition; refreshed on every arrival (self-healing) */
  line: number;
  /** last known end line of the body — the scope of marker lookups */
  endLine: number;
}

export interface TrailNode extends TrailNodeInput {
  /** logical clock of the last structural arrival — eviction order */
  lastAt: number;
  /** creation order — root ordering and deterministic cycle coverage */
  seq: number;
  /** explicitly added by the user — exempt from eviction and orphan cleanup */
  pinned: boolean;
}

export interface TrailChild {
  node: TrailNode;
  /** earliest known call-site line in the caller */
  callsiteLine: number;
}

export class TrailGraph {
  private nodes = new Map<string, TrailNode>();
  /** callerKey → calleeKey → edge info */
  private outEdges = new Map<string, Map<string, { callsiteLine: number; lastAt: number }>>();
  private clock = 0;
  private seqCounter = 0;

  get size(): number {
    return this.nodes.size;
  }

  node(key: string): TrailNode | undefined {
    return this.nodes.get(key);
  }

  /** Innermost node whose definition range contains the line of `uriString`. */
  nodeAt(uriString: string, line: number): TrailNode | undefined {
    let best: TrailNode | undefined;
    let bestSize = Number.MAX_SAFE_INTEGER;
    for (const n of this.nodes.values()) {
      if (n.uriString === uriString && n.line <= line && line <= n.endLine) {
        const size = n.endLine - n.line;
        if (size < bestSize) {
          best = n;
          bestSize = size;
        }
      }
    }
    return best;
  }

  /** Marks a structural arrival on an existing node. */
  touch(key: string): boolean {
    const n = this.nodes.get(key);
    if (!n) {
      return false;
    }
    n.lastAt = ++this.clock;
    return true;
  }

  /** Creates or refreshes a node; position info self-heals on every arrival. */
  upsert(input: TrailNodeInput, pinned = false): TrailNode {
    const existing = this.nodes.get(input.key);
    if (existing) {
      existing.name = input.name;
      existing.containerName = input.containerName;
      existing.kind = input.kind;
      existing.line = input.line;
      existing.endLine = input.endLine;
      existing.lastAt = ++this.clock;
      existing.pinned = existing.pinned || pinned;
      return existing;
    }
    const node: TrailNode = { ...input, lastAt: ++this.clock, seq: this.seqCounter++, pinned };
    this.nodes.set(input.key, node);
    return node;
  }

  /**
   * Records "caller calls callee". Re-walking a known edge only refreshes it;
   * the stored call site is the earliest one seen — the callee's first
   * appearance in the caller's narrative, which is what child ordering uses.
   */
  recordEdge(caller: TrailNodeInput, callee: TrailNodeInput, callsiteLine: number): void {
    this.upsert(caller);
    this.upsert(callee);
    let edges = this.outEdges.get(caller.key);
    if (!edges) {
      edges = new Map();
      this.outEdges.set(caller.key, edges);
    }
    const edge = edges.get(callee.key);
    if (edge) {
      edge.callsiteLine = Math.min(edge.callsiteLine, callsiteLine);
      edge.lastAt = this.clock;
    } else {
      edges.set(callee.key, { callsiteLine, lastAt: this.clock });
    }
  }

  /** Number of discovered callers — ≥2 marks a convergence hub in the view. */
  inDegree(key: string): number {
    let n = 0;
    for (const edges of this.outEdges.values()) {
      if (edges.has(key)) {
        n++;
      }
    }
    return n;
  }

  /**
   * Root nodes: no discovered caller, newest first. Components only reachable
   * through a cycle (A→B→A with no outside caller) have no such node, so the
   * earliest-created node of every uncovered component is promoted.
   */
  roots(): TrailNode[] {
    const called = new Set<string>();
    for (const edges of this.outEdges.values()) {
      for (const calleeKey of edges.keys()) {
        called.add(calleeKey);
      }
    }
    const roots = [...this.nodes.values()].filter((n) => !called.has(n.key));
    const covered = new Set<string>();
    const cover = (key: string): void => {
      if (covered.has(key)) {
        return;
      }
      covered.add(key);
      for (const calleeKey of this.outEdges.get(key)?.keys() ?? []) {
        cover(calleeKey);
      }
    };
    roots.forEach((r) => cover(r.key));
    const uncovered = [...this.nodes.values()]
      .filter((n) => !covered.has(n.key))
      .sort((a, b) => a.seq - b.seq);
    for (const n of uncovered) {
      if (!covered.has(n.key)) {
        roots.push(n);
        cover(n.key);
      }
    }
    return roots.sort((a, b) => b.seq - a.seq);
  }

  /** Callees of `key`, ordered by their first call site in the caller. */
  children(key: string): TrailChild[] {
    const out: TrailChild[] = [];
    for (const [calleeKey, edge] of this.outEdges.get(key) ?? []) {
      const node = this.nodes.get(calleeKey);
      if (node) {
        out.push({ node, callsiteLine: edge.callsiteLine });
      }
    }
    return out.sort((a, b) => a.callsiteLine - b.callsiteLine);
  }

  /**
   * Removes a node from the whole trail, along with every descendant that no
   * surviving node can still reach (shared and pinned descendants survive).
   */
  remove(key: string): void {
    if (!this.nodes.has(key)) {
      return;
    }
    const reach = (starts: Iterable<string>, blocked?: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [...starts];
      while (stack.length > 0) {
        const k = stack.pop()!;
        if (seen.has(k) || k === blocked) {
          continue;
        }
        seen.add(k);
        stack.push(...(this.outEdges.get(k)?.keys() ?? []));
      }
      return seen;
    };
    const sub = reach([key]);
    // reachability of the rest of the graph with the node already gone —
    // paths through it must not keep its exclusive descendants alive
    const survivors = reach(
      [...this.nodes.keys()].filter((k) => !sub.has(k)),
      key,
    );
    const drop = new Set(
      [...sub].filter(
        (k) => k === key || (!survivors.has(k) && !this.nodes.get(k)?.pinned),
      ),
    );
    for (const k of drop) {
      this.nodes.delete(k);
      this.outEdges.delete(k);
    }
    for (const edges of this.outEdges.values()) {
      for (const k of drop) {
        edges.delete(k);
      }
    }
  }

  /** Latest arrival anywhere in the tree below `key` (inclusive). */
  private treeRecency(key: string): number {
    let latest = 0;
    const seen = new Set<string>();
    const stack = [key];
    while (stack.length > 0) {
      const k = stack.pop()!;
      if (seen.has(k)) {
        continue;
      }
      seen.add(k);
      latest = Math.max(latest, this.nodes.get(k)?.lastAt ?? 0);
      stack.push(...(this.outEdges.get(k)?.keys() ?? []));
    }
    return latest;
  }

  /** Safety cap: drops the least-recently-visited trees, never the most active one. */
  evict(maxNodes: number): void {
    let guard = this.nodes.size;
    while (this.nodes.size > maxNodes && guard-- > 0) {
      const ranked = this.roots()
        .map((root) => ({ root, recency: this.treeRecency(root.key) }))
        .sort((a, b) => a.recency - b.recency);
      const victim = ranked.slice(0, -1).find((r) => !r.root.pinned);
      if (!victim) {
        return;
      }
      this.remove(victim.root.key);
    }
  }

  clear(): void {
    this.nodes.clear();
    this.outEdges.clear();
  }
}
