import type { GraphNode } from "../store/types.js";
import { describe, expect, it } from "vitest";
import { nodeLocations } from "./locations.js";

const at = (startLine: number, endLine: number, path = "src/A.java") => ({ path, startLine, startColumn: 3, endLine, endColumn: 4 });
const node = (source: GraphNode["source"], additionalLocations?: unknown): Pick<GraphNode, "source" | "payload"> =>
  ({ source, payload: additionalLocations === undefined ? { name: "foo" } : { name: "foo", additionalLocations } as GraphNode["payload"] });

describe("nodeLocations (T24.1, C217)", () => {
  it("a node with one location: exactly node.source", () => {
    expect(nodeLocations(node(at(4, 6)))).toEqual([at(4, 6)]);
    expect(nodeLocations(node(at(4, 6), []))).toEqual([at(4, 6)]);
    expect(nodeLocations(node(undefined, [at(8, 10)]))).toEqual([]);
  });

  it("source order, independent of which location is primary and of the payload order", () => {
    const want = [at(4, 6), at(8, 10), at(12, 14)];
    expect(nodeLocations(node(at(8, 10), [at(12, 14), at(4, 6)]))).toEqual(want);
    expect(nodeLocations(node(at(12, 14), [at(8, 10), at(4, 6)]))).toEqual(want);
    expect(nodeLocations(node(at(4, 6), [at(8, 10), at(12, 14)]))).toEqual(want);
  });

  it("drops duplicates, a copy of the primary and locations inside another location", () => {
    expect(nodeLocations(node(at(4, 6), [at(4, 6), at(8, 10), at(8, 10)]))).toEqual([at(4, 6), at(8, 10)]);
    expect(nodeLocations(node(at(4, 20), [at(8, 10)]))).toEqual([at(4, 20)]);
    // Same line, different columns: both kept (two declarations on one line).
    const a = { path: "src/A.h", startLine: 3, startColumn: 3, endLine: 3, endColumn: 14 };
    const b = { path: "src/A.h", startLine: 3, startColumn: 15, endLine: 3, endColumn: 30 };
    expect(nodeLocations(node(a, [b]))).toEqual([a, b]);
  });

  it("ignores entries of another file and malformed entries", () => {
    expect(nodeLocations(node(at(4, 6), [at(8, 10, "src/B.java"), { path: "src/A.java" }, { path: "src/A.java", startLine: "8" }, null, 3]))).toEqual([at(4, 6)]);
    expect(nodeLocations(node(at(4, 6), "not an array"))).toEqual([at(4, 6)]);
  });
});

