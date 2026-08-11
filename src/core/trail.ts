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
 *
 * AI-planned routes seed the same graph as `planned` nodes/edges (rendered
 * dim): visiting a node or walking an edge converts it to the normal walked
 * state. Routes coexist; a node belongs to the route that seeded it last.
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
  /** seeded by an AI route and not yet visited — rendered dim */
  planned: boolean;
  /** membership in an AI route; overlapping routes — the latest wins */
  routeId?: string;
  /** what the reader is after — scenario A: the meat of the goal; B: an entry */
  routeCore?: boolean;
  /** the AI's why-note for this hop — tooltip only */
  routeNote?: string;
}

export interface TrailChild {
  node: TrailNode;
  /** earliest known call-site line in the caller */
  callsiteLine: number;
  /** the edge itself was seeded and has not been walked */
  planned: boolean;
}

/** sentinel for a seeded edge whose call site the AI did not give — sorts last */
export const UNKNOWN_CALLSITE = Number.MAX_SAFE_INTEGER;

/** an AI route's identity, shown as the view's header while reading it */
export interface RouteInfo {
  id: string;
  /** scenario A: the goal verbatim; scenario B: `entries → <symbol>` */
  label: string;
}

/** one already-resolved hop, ready to seed */
export interface RouteHopInput {
  node: TrailNodeInput;
  /** 0-based index of the hop this one is called/used from; undefined = root */
  calledFrom?: number;
  /** 0-based call-site line in the calledFrom hop; undefined = unknown */
  callsiteLine?: number;
  /** the AI's why-note */
  note?: string;
  /** scenario A: the meat of the goal; scenario B: an entry — rendered ★ */
  core?: boolean;
}

/**
 * Pre-order positions derived from the hops' calledFrom structure — children
 * ordered by call-site line, roots by input index. Purely a creation-order
 * device so a route's roots display first-hop-on-top; never shown to the
 * reader. Guards against malformed cycles.
 */
function routeSteps(hops: RouteHopInput[]): number[] {
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  hops.forEach((hop, i) => {
    const p = hop.calledFrom;
    if (p === undefined || p === i || p < 0 || p >= hops.length) {
      roots.push(i);
    } else {
      const list = children.get(p);
      if (list) {
        list.push(i);
      } else {
        children.set(p, [i]);
      }
    }
  });
  const bySite = (a: number, b: number): number =>
    (hops[a].callsiteLine ?? UNKNOWN_CALLSITE) - (hops[b].callsiteLine ?? UNKNOWN_CALLSITE) || a - b;
  const steps = new Array<number>(hops.length).fill(0);
  let next = 1;
  const visit = (i: number): void => {
    if (steps[i] !== 0) {
      return;
    }
    steps[i] = next++;
    for (const c of [...(children.get(i) ?? [])].sort(bySite)) {
      visit(c);
    }
  };
  roots.forEach(visit);
  hops.forEach((_, i) => visit(i));
  return steps;
}

export class TrailGraph {
  private nodes = new Map<string, TrailNode>();
  /** callerKey → calleeKey → edge info */
  private outEdges = new Map<
    string,
    Map<string, { callsiteLine: number; lastAt: number; planned: boolean }>
  >();
  private routes = new Map<string, RouteInfo>();
  private clock = 0;
  private seqCounter = 0;
  private routeCounter = 0;

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

  /** Marks a structural arrival on an existing node — arriving lights it up. */
  touch(key: string): boolean {
    const n = this.nodes.get(key);
    if (!n) {
      return false;
    }
    n.lastAt = ++this.clock;
    n.planned = false;
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
      existing.planned = false;
      return existing;
    }
    const node: TrailNode = {
      ...input,
      lastAt: ++this.clock,
      seq: this.seqCounter++,
      pinned,
      planned: false,
    };
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
      if (edge.planned) {
        // the walked call site replaces the seeded guess/sentinel outright
        edge.callsiteLine = callsiteLine;
        edge.planned = false;
      } else {
        edge.callsiteLine = Math.min(edge.callsiteLine, callsiteLine);
      }
      edge.lastAt = this.clock;
    } else {
      edges.set(callee.key, { callsiteLine, lastAt: this.clock, planned: false });
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
        out.push({ node, callsiteLine: edge.callsiteLine, planned: edge.planned });
      }
    }
    return out.sort((a, b) => a.callsiteLine - b.callsiteLine);
  }

  /**
   * Seeds an AI-planned route; earlier routes stay. Already-walked nodes are
   * never dimmed and keep their self-healed positions — they only take the
   * route's badge; a walked edge likewise survives a seeded duplicate.
   */
  seedRoute(hops: RouteHopInput[], label: string): RouteInfo {
    const route: RouteInfo = { id: `route-${++this.routeCounter}`, label };
    this.routes.set(route.id, route);
    const steps = routeSteps(hops);
    // create in descending step order: the first hop lands the highest seq,
    // so roots() (newest first) shows a route's roots in step order
    const byStepDesc = [...hops.keys()].sort((a, b) => steps[b] - steps[a]);
    for (const i of byStepDesc) {
      const hop = hops[i];
      const existing = this.nodes.get(hop.node.key);
      if (existing) {
        if (existing.planned) {
          existing.name = hop.node.name;
          existing.containerName = hop.node.containerName;
          existing.kind = hop.node.kind;
          existing.line = hop.node.line;
          existing.endLine = hop.node.endLine;
        }
        existing.routeId = route.id;
        existing.routeCore = hop.core || undefined;
        existing.routeNote = hop.note;
      } else {
        this.nodes.set(hop.node.key, {
          ...hop.node,
          lastAt: ++this.clock,
          seq: this.seqCounter++,
          pinned: false,
          planned: true,
          routeId: route.id,
          routeCore: hop.core || undefined,
          routeNote: hop.note,
        });
      }
    }
    hops.forEach((hop, i) => {
      const from = hop.calledFrom === undefined ? undefined : hops[hop.calledFrom];
      if (!from || hop.calledFrom === i) {
        return;
      }
      let edges = this.outEdges.get(from.node.key);
      if (!edges) {
        edges = new Map();
        this.outEdges.set(from.node.key, edges);
      }
      const edge = edges.get(hop.node.key);
      const callsiteLine = hop.callsiteLine ?? UNKNOWN_CALLSITE;
      if (edge) {
        if (edge.planned) {
          edge.callsiteLine = callsiteLine;
        }
      } else {
        edges.set(hop.node.key, { callsiteLine, lastAt: this.clock, planned: true });
      }
    });
    return route;
  }

  /** The route a node belongs to — the view's header message source. */
  routeOf(key: string): RouteInfo | undefined {
    const id = this.nodes.get(key)?.routeId;
    return id === undefined ? undefined : this.routes.get(id);
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
      [...sub].filter((k) => {
        if (k === key) {
          return true;
        }
        const node = this.nodes.get(k);
        return !survivors.has(k) && !node?.pinned && !node?.planned;
      }),
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
      const victim = ranked.slice(0, -1).find((r) => !r.root.pinned && !r.root.planned);
      if (!victim) {
        return;
      }
      this.remove(victim.root.key);
    }
  }

  clear(): void {
    this.nodes.clear();
    this.outEdges.clear();
    this.routes.clear();
  }
}
