import { canonicalSourceText, sliceSource, type RepoPath } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalyzerRegistry } from "../registry.js";
import { createDefaultAnalyzerRegistry } from "../default-registry.js";
import type { SourceAnalysis } from "../types.js";

let registry: AnalyzerRegistry;
beforeAll(async () => {
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new Error(JSON.stringify(created.diagnostics));
  registry = created.value;
});
afterAll(() => registry?.dispose());

function analyze(path: string, lines: readonly string[]): SourceAnalysis {
  const r = registry.analyze({ path: path as RepoPath, content: new TextEncoder().encode(lines.join("\n")) });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
}
const symbols = (a: SourceAnalysis) => a.symbols.map((s) => `${s.kind}:${s.qualifiedName}`).sort();
const modules = (a: SourceAnalysis) => a.moduleReferences.map((m) => `${m.kind}:${m.specifier}`);
const tests = (a: SourceAnalysis) => a.tests.map((t) => `${t.kind}:${t.name}:${t.frameworkHint}:${t.confidence}`);
const calls = (a: SourceAnalysis) => a.callSites.map((c) => c.calleeText);

describe("Java analyzer (T18.0)", () => {
  const SRC = [
    "package com.example.auth;",
    "import java.util.List;",
    "import static org.junit.jupiter.api.Assertions.assertEquals;",
    "import org.junit.jupiter.api.Test;",
    "import com.example.users.*;",
    "// duo: AUTH-01",
    "public class LoginServiceTest {",
    "  private final List<String> names = List.of();",
    "  public LoginServiceTest() {}",
    "  @Test void logsIn() { assertEquals(1, helper()); new Session(); }",
    "  private int helper() { return 1; }",
    "  interface Port { void call(); }",
    "  enum Role { ADMIN }",
    "  record Pair(int a, int b) {}",
    "}",
  ];

  it("extracts symbols, imports, JUnit tests, call sites and annotations", () => {
    const a = analyze("src/test/java/com/example/auth/LoginServiceTest.java", SRC);
    expect(a.language).toBe("java");
    expect(a.parseStatus).toBe("complete");
    expect(symbols(a)).toEqual(expect.arrayContaining([
      "class:LoginServiceTest", "method:LoginServiceTest.logsIn", "method:LoginServiceTest.helper",
      "interface:LoginServiceTest.Port", "enum:LoginServiceTest.Role", "record:LoginServiceTest.Pair",
    ]));
    // Imports stay as written (a wildcard keeps ".*"); packages qualify names and are not symbols.
    expect(modules(a)).toEqual(["import:java.util.List", "import:org.junit.jupiter.api.Assertions.assertEquals", "import:org.junit.jupiter.api.Test", "import:com.example.users.*"]);
    expect(a.moduleReferences.map((m) => m.syntax ?? {})).toEqual([{}, { static: true }, {}, { wildcard: true }]);
    expect(tests(a)).toEqual(["test:logsIn:junit5:explicit"]);
    expect(calls(a)).toEqual(expect.arrayContaining(["assertEquals", "helper", "Session"]));
    expect(a.annotations.map((x) => x.ids)).toEqual([["AUTH-01"]]);
  });

  it("does not call an unbound @Test a test outside a test source set", () => {
    const a = analyze("src/main/java/Custom.java", ["class Custom { @Test void x() {} }"]);
    expect(a.tests).toEqual([]);
    const h = analyze("src/test/java/Custom.java", ["class Custom { @Test void x() {} }"]);
    expect(tests(h)).toEqual(["test:x:unknown:heuristic"]);
  });
});

describe("C# analyzer (T18.0)", () => {
  it("extracts namespaces, types, members, usings and NUnit tests bound by their using", () => {
    const a = analyze("Assets/Tests/PlayerTests.cs", [
      "using System;",
      "using static System.Math;",
      "global using Game.Core;",
      "using Alias = Game.Core.Player;",
      "using NUnit.Framework;",
      "namespace Game.Tests {",
      "  public class PlayerTests {",
      "    public int Health { get; set; }",
      "    public event Action Died;",
      "    public delegate void Hit(int amount);",
      "    ~PlayerTests() {}",
      "    [Test] public void TakesDamage() { Apply(3); new Player(); }",
      "    private void Apply(int n) { Console.WriteLine(n); }",
      "  }",
      "  public struct Point { public int X; }",
      "  public record Score(int Value);",
      "}",
    ]);
    expect(a.language).toBe("csharp");
    expect(a.parseStatus).toBe("complete");
    // A C# namespace qualifies names (like a Java package) and is not a symbol of its own.
    expect(symbols(a)).toEqual([
      "class:Game.Tests.PlayerTests", "delegate:Game.Tests.PlayerTests.Hit", "destructor:Game.Tests.PlayerTests.~PlayerTests",
      "method:Game.Tests.PlayerTests.Apply", "method:Game.Tests.PlayerTests.TakesDamage", "property:Game.Tests.PlayerTests.Health",
      "record:Game.Tests.Score", "struct:Game.Tests.Point",
    ]);
    expect(modules(a)).toEqual(["using:System", "using:System.Math", "using:Game.Core", "using:Game.Core.Player", "using:NUnit.Framework"]);
    expect(a.moduleReferences.map((m) => m.syntax ?? {})).toEqual([{}, { static: true }, { global: true }, { alias: "Alias" }, {}]);
    expect(tests(a)).toEqual(["test:TakesDamage:nunit:explicit"]);
    expect(calls(a)).toEqual(expect.arrayContaining(["Apply", "Player", "Console.WriteLine"]));
  });

  it("does not treat [Test] as a test without a framework using", () => {
    expect(analyze("Tests/X.cs", ["class X { [Test] void A() {} [Fact] void B() {} }"]).tests).toEqual([]);
  });

  it("binds xUnit and MSTest attributes", () => {
    expect(tests(analyze("T.cs", ["using Xunit;", "class T { [Fact] void A() {} [Theory] void B() {} }"]))).toEqual(["test:A:xunit:explicit", "test:B:xunit:explicit"]);
    expect(tests(analyze("T.cs", ["using Microsoft.VisualStudio.TestTools.UnitTesting;", "[TestClass] class T { [TestMethod] void A() {} }"]))).toEqual(["test:A:mstest:explicit"]);
  });
});

describe("C++ analyzer (T18.0)", () => {
  it("extracts namespaces, classes, methods, includes and GoogleTest tests", () => {
    const a = analyze("tests/player_test.cpp", [
      "#include <gtest/gtest.h>",
      '#include "player.h"',
      "namespace game {",
      "class Player {",
      " public:",
      "  Player();",
      "  ~Player();",
      "  int health() const;",
      "};",
      "struct Point { int x; };",
      "int Player::health() const { return clamp(1); }",
      "static int clamp(int v) { return v; }",
      "}",
      "TEST(PlayerSuite, StartsAlive) { game::Player p; EXPECT_EQ(p.health(), 1); }",
    ]);
    expect(a.language).toBe("cpp");
    expect(modules(a)).toEqual(["include:gtest/gtest.h", "include:player.h"]);
    expect(a.moduleReferences.map((m) => m.syntax ?? {})).toEqual([{ system: true }, {}]);
    // Qualified names use "." in every language; fields are not symbols.
    expect(symbols(a)).toEqual([
      "class:game.Player", "constructor:game.Player.Player", "destructor:game.Player.~Player", "function:game.clamp",
      "method:game.Player.health", "namespace:game", "struct:game.Point",
    ]);
    expect(tests(a)).toEqual(["test:StartsAlive:googletest:explicit"]);
    expect(calls(a)).toEqual(expect.arrayContaining(["clamp"]));
  });

  it("parses an Unreal header with its annotation macros masked", () => {
    const path = "Source/Game/Public/MyActor.h" as RepoPath;
    // ".h" is contextual: only a repository-scoped selection claims it (a .uproject makes it C++).
    expect(registry.analyzerFor(path)).toBeUndefined();
    const analyzer = registry.scope([path, "Game.uproject" as RepoPath]).analyzerFor(path);
    expect(analyzer?.id).toBe("cpp");
    const lines = [
      "#pragma once",
      '#include "CoreMinimal.h"',
      '#include "MyActor.generated.h"',
      "UCLASS(Blueprintable)",
      "class GAME_API AMyActor : public AActor {",
      "  GENERATED_BODY()",
      " public:",
      "  UFUNCTION(BlueprintCallable, Category = \"Combat\")",
      "  void Fire(int32 Count);",
      "  UPROPERTY(EditAnywhere)",
      "  int32 Ammo;",
      "};",
    ];
    const raw = lines.join("\n");
    const a = analyzer?.analyze({ path, content: new TextEncoder().encode(raw) }).value;
    expect(a?.parseStatus).toBe("complete");
    expect(a && symbols(a)).toEqual(["class:AMyActor", "method:AMyActor.Fire"]);
    // Masking keeps offsets: the class location still slices the original text.
    const cls = a?.symbols.find((s) => s.name === "AMyActor");
    expect(sliceSource(raw, cls?.location ?? { path: "" }).value?.startsWith("class GAME_API AMyActor")).toBe(true);
  });

  it("does not call TEST(...) a test without a GoogleTest include outside a test path", () => {
    expect(analyze("src/macros.cpp", ["TEST(A, B) { }"]).tests).toEqual([]);
  });
});

describe("Python analyzer (T18.0)", () => {
  it("extracts classes, functions, methods, imports, pytest and unittest tests", () => {
    const a = analyze("tests/test_users.py", [
      "import os",
      "import unittest",
      "from . import helpers",
      "from ..app.users import create_user as make",
      "from app import *",
      "import pytest",
      "# duo: USER-01",
      "class UserService:",
      "    def create(self, name):",
      "        return normalize(name)",
      "def normalize(name):",
      "    return name.strip()",
      "def test_create_user():",
      "    assert UserService().create(' a ') == 'a'",
      "class TestAdmin(unittest.TestCase):",
      "    def test_promote(self):",
      "        self.assertTrue(True)",
      "    def helper(self):",
      "        pass",
      "@pytest.mark.skip",
      "def test_skipped():",
      "    pass",
    ]);
    expect(a.language).toBe("python");
    expect(a.parseStatus).toBe("complete");
    expect(symbols(a)).toEqual(expect.arrayContaining(["class:UserService", "method:UserService.create", "function:normalize", "function:test_create_user", "class:TestAdmin"]));
    // "from . import helpers" names the submodule ".helpers".
    expect(modules(a)).toEqual(["import:os", "import:unittest", "import:.helpers", "import:..app.users", "import:app", "import:pytest"]);
    expect(a.moduleReferences.map((m) => m.syntax ?? {})).toEqual([{}, {}, { relativeLevel: 1 }, { relativeLevel: 2 }, { wildcard: true }, {}]);
    expect(tests(a)).toEqual(expect.arrayContaining(["test:test_create_user:pytest:explicit", "test:test_promote:unittest:explicit"]));
    expect(tests(a).some((t) => t.includes("helper"))).toBe(false);
    expect(calls(a)).toEqual(expect.arrayContaining(["normalize", "UserService"]));
    expect(a.annotations.map((x) => x.ids)).toEqual([["USER-01"]]);
  });

  it("does not call test_* functions tests outside a pytest file", () => {
    expect(analyze("app/users.py", ["def test_like_name():", "    pass"]).tests).toEqual([]);
  });
});

describe("partial parse recovery (T18.0)", () => {
  it.each([
    ["A.java", ["class A {", "  void ok() {}", "  void broken( {", "}"]],
    ["A.cs", ["class A {", "  void Ok() {}", "  void Broken( {", "}"]],
    ["a.cpp", ["int ok() { return 1; }", "int broken( {"]],
    ["a.py", ["def ok():", "    return 1", "def broken(:", "    pass"]],
  ] as const)("%s keeps the facts before the error and reports partial", (path, lines) => {
    const a = analyze(path, lines);
    expect(a.parseStatus).toBe("partial");
    expect(a.symbols.some((s) => s.name.toLowerCase() === "ok")).toBe(true);
  });
});

const VARIANTS = [false, true].flatMap((crlf) => [false, true].map((bom) => ({ crlf, bom })));
const SAMPLES: Record<string, { path: string; lines: string[]; symbol: [string, string, string]; call: string }> = {
  java: { path: "A.java", lines: ["// 한글 😀", "class A {", "  String 표시() { return \"😀\" + helper(); }", "  String helper() { return \"가\"; }", "}"], symbol: ["표시", "String 표시", "helper(); }"], call: "helper()" },
  csharp: { path: "A.cs", lines: ["// 한글 😀", "class A {", "  string 표시() { return \"😀\" + Helper(); }", "  string Helper() { return \"가\"; }", "}"], symbol: ["표시", "string 표시", "Helper(); }"], call: "Helper()" },
  cpp: { path: "a.cpp", lines: ["// 한글 😀", "const char* helper() { return \"가\"; }", "const char* 표시() { return helper(); }"], symbol: ["표시", "const char* 표시", "helper(); }"], call: "helper()" },
  python: { path: "a.py", lines: ["# 한글 😀", "def helper():", "    return \"가\"", "def 표시():", "    return \"😀\" + helper()"], symbol: ["표시", "def 표시", "helper()"], call: "helper()" },
};

describe.each(Object.entries(SAMPLES))("exact slicing for %s (T18.0)", (_lang, s) => {
  it.each(VARIANTS.map((v) => [`${v.crlf ? "CRLF" : "LF"}${v.bom ? " +BOM" : ""}`, v] as const))("%s", (_n, v) => {
    const raw = (v.bom ? "\uFEFF" : "") + s.lines.join(v.crlf ? "\r\n" : "\n");
    const a = registry.analyze({ path: s.path as RepoPath, content: new TextEncoder().encode(raw) }).value;
    expect(a?.parseStatus).toBe("complete");
    const text = canonicalSourceText(raw);
    const [name, start, end] = s.symbol;
    const i = text.indexOf(start);
    const expected = text.slice(i, text.indexOf(end, i) + end.length);
    expect(sliceSource(text, a?.symbols.find((x) => x.name === name)?.location ?? { path: "" }).value).toBe(expected);
    expect(sliceSource(text, a?.callSites.find((c) => `${c.calleeText}()` === s.call)?.location ?? { path: "" }).value).toBe(s.call);
    for (const loc of [...(a?.symbols ?? []).map((x) => x.location), ...(a?.callSites ?? []).map((c) => c.location), ...(a?.moduleReferences ?? []).map((m) => m.location)]) {
      expect(sliceSource(text, loc).diagnostics).toEqual([]);
    }
  });
});

