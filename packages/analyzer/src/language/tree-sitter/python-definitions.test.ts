/**
 * C226 (T24.4): the primary location of a Python Symbol made of several defs. The effective definition
 * where syntax shows it (ordinary same-suite redefinition, recognized typing.overload with one
 * implementation); the first definition otherwise. Every definition stays a location of the Symbol.
 */
import { nodeId, type RepoPath } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultAnalyzerRegistry } from "../default-registry.js";
import type { AnalyzerRegistry } from "../registry.js";
import type { SourceAnalysis } from "../types.js";

let registry: AnalyzerRegistry;
beforeAll(async () => {
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new Error(JSON.stringify(created.diagnostics));
  registry = created.value;
});
afterAll(() => registry?.dispose());

function analyze(lines: readonly string[]): SourceAnalysis {
  const r = registry.analyze({ path: "pkg/mod.py" as RepoPath, content: new TextEncoder().encode(lines.join("\n")) });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
}
/** Every Symbol: [identity, primary start line, other start lines]. */
const layout = (lines: readonly string[]) => analyze(lines).symbols.map((s) => [nodeId(s.ref).slice("sym:pkg/mod.py#".length), s.location.startLine, (s.additionalLocations ?? []).map((l) => l.startLine)])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

const OVERLOAD_C = ["from typing import overload", "", "@overload", "def foo(x: int) -> int: ...", "", "@overload", "def foo(x: str) -> str: ...", "", "def foo(x):", "    return x", ""];

describe("Python effective definition (C226)", () => {
  it("A: an ordinary module-level redefinition: the last def is primary", () => {
    expect(layout(["def foo():", "    return 1", "", "def foo():", "    return 2", ""])).toEqual([["foo", 4, [1]]]);
  });

  it("B: a redefined method in one class body: the last def is primary", () => {
    expect(layout(["class A:", "    def foo(self):", "        return 1", "", "    def foo(self):", "        return 2", ""])).toEqual([["A", 1, []], ["A.foo", 5, [2]]]);
  });

  it("C: from typing import overload: the implementation is primary, the stubs stay locations", () => {
    expect(layout(OVERLOAD_C)).toEqual([["foo", 9, [3, 6]]]);
  });

  it("D: import typing + @typing.overload: the implementation is primary", () => {
    expect(layout(["import typing", "", "@typing.overload", "def foo(x: int) -> int: ...", "", "def foo(x):", "    return x", ""])).toEqual([["foo", 6, [3]]]);
  });

  it("E: overload stubs without an implementation: no guess (the first stays primary)", () => {
    expect(layout(["from typing import overload", "@overload", "def foo(x: int) -> int: ...", "@overload", "def foo(x: str) -> str: ...", ""])).toEqual([["foo", 2, [4]]]);
  });

  it("F, G: a property and its setter / deleter are not a redefinition: the getter stays primary", () => {
    const F = ["class A:", "    @property", "    def value(self):", "        return self._v", "", "    @value.setter", "    def value(self, x):", "        self._v = x", ""];
    expect(layout(F)).toEqual([["A", 1, []], ["A.value", 2, [6]]]);
    expect(layout([...F, "    @value.deleter", "    def value(self):", "        del self._v", ""])).toEqual([["A", 1, []], ["A.value", 2, [6, 10]]]);
  });

  it("H: definitions under if / else, TYPE_CHECKING, try, or one if block: no guess", () => {
    expect(layout(["import sys", "if sys.platform == 'win32':", "    def foo():", "        return 1", "else:", "    def foo():", "        return 2", ""])).toEqual([["foo", 3, [6]]]);
    expect(layout(["from typing import TYPE_CHECKING", "if TYPE_CHECKING:", "    def foo(x: int) -> int: ...", "else:", "    def foo(x):", "        return x", ""])).toEqual([["foo", 3, [5]]]);
    expect(layout(["try:", "    def foo():", "        return 1", "except ImportError:", "    def foo():", "        return 2", ""])).toEqual([["foo", 2, [5]]]);
    expect(layout(["if X:", "    def foo():", "        return 1", "    def foo():", "        return 2", ""])).toEqual([["foo", 2, [4]]]);
    // A module-level def and a conditional one: two suites.
    expect(layout(["def foo():", "    return 1", "if X:", "    def foo():", "        return 2", ""])).toEqual([["foo", 1, [4]]]);
  });

  it("I, J: def and async def rebind the same name: the last one is primary", () => {
    expect(layout(["def foo():", "    return 1", "", "async def foo():", "    return 2", ""])).toEqual([["foo", 4, [1]]]);
    expect(layout(["async def foo():", "    return 1", "", "def foo():", "    return 2", ""])).toEqual([["foo", 4, [1]]]);
  });

  it("K, L: nested scopes and different classes are different bindings", () => {
    expect(layout(["def foo():", "    def foo():", "        return 1", "    return foo()", ""])).toEqual([["foo", 1, []]]);
    expect(layout(["def foo():", "    return 1", "", "class A:", "    def foo(self):", "        return 2", ""])).toEqual([["A", 4, []], ["A.foo", 5, []], ["foo", 1, []]]);
    expect(layout(["class A:", "    def foo(self):", "        return 1", "", "class B:", "    def foo(self):", "        return 2", ""])).toEqual([["A", 1, []], ["A.foo", 2, []], ["B", 5, []], ["B.foo", 6, []]]);
  });

  it("an ellipsis body is not an overload stub: without @overload the defs are an ordinary redefinition", () => {
    expect(layout(["def foo(x: int) -> int: ...", "", "def foo(x):", "    return x", ""])).toEqual([["foo", 3, [1]]]);
  });

  it("overload not proved by syntax: alias, no import, typing_extensions, star import, a second binding, class-body shadow: no guess", () => {
    const stubAndImpl = ["@ov", "def foo(x: int) -> int: ...", "def foo(x):", "    return x", ""];
    expect(layout(["from typing import overload as ov", ...stubAndImpl])).toEqual([["foo", 2, [4]]]);
    const plain = ["@overload", "def foo(x: int) -> int: ...", "def foo(x):", "    return x", ""];
    expect(layout(plain)).toEqual([["foo", 1, [3]]]);
    expect(layout(["from typing_extensions import overload", ...plain])).toEqual([["foo", 2, [4]]]);
    expect(layout(["from typing import overload", "from helpers import *", ...plain])).toEqual([["foo", 3, [5]]]);
    expect(layout(["from typing import overload", "overload = lambda f: f", ...plain])).toEqual([["foo", 3, [5]]]);
    expect(layout(["import typing as typing", "@typing.overload", "def foo(x: int) -> int: ...", "def foo(x):", "    return x", ""])).toEqual([["foo", 2, [4]]]);
    expect(layout(["from typing import overload", "class A:", "    overload = staticmethod(lambda f: f)", "    @overload", "    def f(self, x: int) -> int: ...", "    def f(self, x):", "        return x", ""]))
      .toEqual([["A", 2, []], ["A.f", 4, [6]]]);
  });

  it("overload sets that do not end in exactly one implementation: no guess", () => {
    // A stub after the implementation (the stub's dummy is the final binding).
    expect(layout(["from typing import overload", "@overload", "def foo(x: int) -> int: ...", "def foo(x):", "    return x", "@overload", "def foo(x: str) -> str: ...", ""])).toEqual([["foo", 2, [4, 6]]]);
    // Two implementations.
    expect(layout(["from typing import overload", "@overload", "def foo(x: int) -> int: ...", "def foo(x):", "    return x", "def foo(x):", "    return [x]", ""])).toEqual([["foo", 2, [4, 6]]]);
  });

  it("overloaded staticmethods in a class: the implementation is primary", () => {
    expect(layout(["from typing import overload", "class A:", "    @overload", "    @staticmethod", "    def f(x: int) -> int: ...", "    @staticmethod", "    def f(x):", "        return x", ""]))
      .toEqual([["A", 2, []], ["A.static.f", 6, [3]]]);
  });

  it("other decorators, other bindings of the name, and class groups: no guess", () => {
    expect(layout(["@app.get('/a')", "def handler():", "    return 1", "@app.get('/b')", "def handler():", "    return 2", ""])).toEqual([["handler", 1, [4]]]);
    expect(layout(["def foo():", "    return 1", "foo = wrap(foo)", "def foo():", "    return 2", ""])).toEqual([["foo", 1, [4]]]);
    expect(layout(["def foo():", "    return 1", "del foo", "def foo():", "    return 2", ""])).toEqual([["foo", 1, [4]]]);
    expect(layout(["from x import foo", "def foo():", "    return 1", "def foo():", "    return 2", ""])).toEqual([["foo", 2, [4]]]);
    expect(layout(["class A:", "    def foo(self):", "        return 1", "    foo = property(foo)", "    def foo(self):", "        return 2", ""])).toEqual([["A", 1, []], ["A.foo", 2, [5]]]);
    expect(layout(["class Foo:", "    pass", "def Foo():", "    return 1", ""])).toEqual([["Foo", 1, [3]]]);
  });

  it("the choice follows source order, not the order of anything else", () => {
    // Reordering the defs moves the primary with them; a body edit keeps it.
    expect(layout(["def foo():", "    return 2", "", "def foo():", "    return 1", ""])).toEqual([["foo", 4, [1]]]);
    expect(layout(["def foo():", "    return 1", "", "def foo():", "    return 22", ""])).toEqual([["foo", 4, [1]]]);
  });
});

