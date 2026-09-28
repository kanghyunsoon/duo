/**
 * LanguageAnalyzer contract (TASK-005, T05.1, ADR-003). Syntax facts only: no Graph, no resolution
 * of imports, calls or tests (that is the Graph Builder, TASK-007). No Tree-sitter types here.
 */
import type { ParseResult, RepoPath, SourceLocation, SymbolRef } from "@duo-director/core";

/** Language of an analysis. Open-ended so a new analyzer needs no change to this package. */
export type SourceLanguage = "typescript" | "tsx" | "javascript" | "java" | "csharp" | "cpp" | "python" | (string & {});

export interface SourceInput {
  readonly path: RepoPath;
  /** File bytes as read from the working tree. */
  readonly content: Uint8Array;
}

export type SymbolKind =
  | "class" | "interface" | "type-alias" | "enum" | "function"
  | "method" | "constructor" | "getter" | "setter"
  /** A getter and a setter with the same name in the same member scope: one property symbol. */
  | "accessor"
  /** Cross-language structural kinds (T18.0): C#/C++ struct, Java/C# record, C# delegate, C++ namespace, C# property, C++ destructor. */
  | "struct" | "record" | "delegate" | "namespace" | "property" | "destructor";

/** Kinds whose members are symbols (CONTAINS parent → member). */
export const CONTAINER_SYMBOL_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>(["class", "interface", "enum", "struct", "record", "namespace"]);

/** Class members only: static and instance members with the same name are different symbols. */
export type MemberScope = "static" | "instance";

export interface AnalyzedSymbol {
  /**
   * Identity: core symbolRef(path, ref.symbol); Node IDs come from core nodeId(). ref.symbol is
   * the qualifiedName for top-level symbols and instance members ("AuthService.login"), and
   * "Class.static.name" for static members. Member names that are not identifiers are quoted:
   * 'Class["a.b"]', 'Class.static["a.b"]'.
   */
  readonly ref: SymbolRef;
  readonly name: string;
  /** Display name: "AuthService", "AuthService.login", "AuthService.#refresh", "default", "default.render". Not unique across member scopes. */
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly exported: boolean;
  /** Class members only. */
  readonly memberScope?: MemberScope;
  /** qualifiedName of the containing class, for members. */
  readonly parent?: string;
  /** Primary declaration: the one with a body, otherwise the first. */
  readonly location: SourceLocation;
  /** Other declarations of the same symbol (overload signatures, merged declarations), in location order. */
  readonly additionalLocations?: readonly SourceLocation[];
}

/** import/export-from/dynamic-import/require: TypeScript/JavaScript; import: also Java and Python; using: C#; include: C++. */
export type ModuleReferenceKind = "import" | "export-from" | "dynamic-import" | "require" | "using" | "include";

/** Language syntax details of a reference, as written (T18.0). Never resolution facts. */
export interface ModuleReferenceSyntax {
  /** Java "import static", C# "using static". */
  readonly static?: true;
  /** Java "import a.b.*", Python "from m import *". */
  readonly wildcard?: true;
  /** C# "global using". */
  readonly global?: true;
  /** C# "using Alias = A.B". */
  readonly alias?: string;
  /** C++ "#include <x>" (system search path) vs "#include \"x\"". */
  readonly system?: true;
  /** Python relative import depth (the number of leading dots). */
  readonly relativeLevel?: number;
}

/**
 * A local name bound by an import. imported is the exported name, "default", or "*" (namespace
 * import, import x = require(), and the CommonJS module object of const x = require()).
 */
export interface ImportBinding {
  readonly local: string;
  readonly imported: string;
  readonly typeOnly: boolean;
}

/** A name re-exported from another module (export ... from). Not a local binding. exported and imported are "*" for "export * from". */
export interface ReExportBinding {
  readonly exported: string;
  readonly imported: string;
  readonly typeOnly: boolean;
}

/** A literal module specifier as written. Not resolved to a file. */
export interface ModuleReference {
  readonly specifier: string;
  readonly kind: ModuleReferenceKind;
  /** "import type ..." / "export type ... from": the whole statement is type-only. */
  readonly typeOnly: boolean;
  /** Local bindings (import, require). Empty for side-effect imports, dynamic imports and export-from. */
  readonly bindings: readonly ImportBinding[];
  /** Re-exported names (export-from only). */
  readonly reexports: readonly ReExportBinding[];
  /** Language syntax details (Java, C#, C++, Python). */
  readonly syntax?: ModuleReferenceSyntax;
  /** The import/export statement, or the import()/require() call. */
  readonly location: SourceLocation;
}

/**
 * A name this module exports from its own declarations (not a re-export): "export function f",
 * "export default class Foo" (exported "default", local "Foo"), "export { a as b }" (exported "b",
 * local "a"). local is absent when the default export is an expression without a name.
 */
export interface LocalExport {
  readonly exported: string;
  readonly local?: string;
  readonly typeOnly: boolean;
  readonly location: SourceLocation;
}

export type CallSiteKind = "identifier" | "member" | "constructor";

/**
 * A call as written. The target is not resolved: "auth.login()" is not claimed to call AuthService.login.
 * The structured fields let the Graph Builder resolve without reading source text.
 */
export interface CallSite {
  readonly kind: CallSiteKind;
  /** Callee source text with line breaks and their indentation removed, e.g. "client.user.login". */
  readonly calleeText: string;
  /** The callee as a dotted name path when it is one: ["login"], ["Auth", "login"], ["this", "#refresh"]. Absent for computed callees. */
  readonly calleePath?: readonly string[];
  /** The first name of calleePath is declared inside an enclosing function (parameter or local), so it is not a module-level name. */
  readonly rootLocal?: true;
  /** For "this" callees: "member" when "this" belongs to the enclosing class member, "other" inside a nested function or elsewhere. */
  readonly thisBinding?: "member" | "other";
  /** A bare name inside a member function (C++): it can name a member of the class, so it is not linked to a same-file function (T18.0). */
  readonly mayBeMember?: true;
  /** Innermost extracted symbol containing the call; absent at module level. */
  readonly enclosingSymbol?: SymbolRef;
  readonly location: SourceLocation;
}

/** A "duo: ID, ID" comment line. The IDs are candidates; the Graph Builder checks them against Project Truth. */
export interface DuoAnnotation {
  readonly ids: readonly string[];
  readonly location: SourceLocation;
}

export type TestKind = "test" | "suite";
export type TestFrameworkHint =
  | "vitest" | "jest" | "node-test"
  | "junit4" | "junit5" | "nunit" | "xunit" | "mstest" | "googletest" | "catch2" | "unreal-automation" | "pytest" | "unittest"
  | "unknown";
/**
 * explicit: the test function was imported from vitest, @jest/globals or node:test.
 * heuristic: a global test/it/describe/suite call in a *.test.* or *.spec.* file.
 */
export type TestConfidence = "explicit" | "heuristic";
export type TestModifier = "skip" | "only" | "todo";

/** A test or suite call with a literal name. Not a Test Node: the Graph Builder decides that and VALIDATED_BY. */
export interface AnalyzedTest {
  /** The literal name argument. */
  readonly name: string;
  /** Suite names and the name joined by " > ", e.g. "Auth > Refresh > expires". */
  readonly fullName: string;
  readonly kind: TestKind;
  readonly frameworkHint: TestFrameworkHint;
  readonly confidence: TestConfidence;
  readonly modifier?: TestModifier;
  /** fullName of the innermost enclosing suite. */
  readonly enclosingSuite?: string;
  /** Innermost extracted symbol containing the call, if any. */
  readonly enclosingSymbol?: SymbolRef;
  /** The test/suite call. */
  readonly location: SourceLocation;
}

export type ParseStatus = "complete" | "partial";

/**
 * Result of analyzing one file. Every list is in location order (compareSourceLocations), ties
 * broken by a stable key: symbol identity, specifier then kind, calleeText, ids, fullName.
 */
export interface SourceAnalysis {
  readonly path: RepoPath;
  readonly language: SourceLanguage;
  /** Same value as the file's FileFingerprint.contentHash. */
  readonly contentHash: string;
  /** "partial" when the syntax tree has ERROR or MISSING nodes (AST_PARSE_ERROR). */
  readonly parseStatus: ParseStatus;
  readonly symbols: readonly AnalyzedSymbol[];
  readonly moduleReferences: readonly ModuleReference[];
  /** Local exports (re-exports are in moduleReferences). */
  readonly exports: readonly LocalExport[];
  readonly callSites: readonly CallSite[];
  readonly annotations: readonly DuoAnnotation[];
  readonly tests: readonly AnalyzedTest[];
}

export interface LanguageAnalyzer {
  /** Stable analyzer ID, e.g. "typescript". */
  readonly id: string;
  /** Changes when extraction output changes; files of this analyzer are then re-analyzed (04). */
  readonly version: string;
  /** Languages it produces (SourceAnalysis.language values). */
  readonly languages: readonly SourceLanguage[];
  /** File extensions it claims (lowercase, without the dot); contextual extensions (.h) are decided by the registry. */
  readonly extensions: readonly string[];
  /** Extensions it analyzes only when the registry decides the file is its language (C++ ".h", T18.0). */
  readonly contextualExtensions?: readonly string[];
  /** What its analysis can establish (T18.0). A missing relation is only evidence of absence where the capability says so. */
  readonly capabilities: AnalyzerCapabilities;
  /** How the Graph Builder resolves this analyzer's call sites (a strategy the builder already has). */
  readonly callResolution: CallResolutionStrategy;
  /**
   * Stable identity of what the analyzer produces: sha256 of id, version, languages, extensions,
   * capability contract version, capabilities and the grammar files' sha256. A different identity
   * re-analyzes exactly this analyzer's files (a new analyzer re-analyzes files that had none).
   */
  readonly identity: string;
  /** Path-based and cheap; unsupported files are never parsed. */
  supports(path: RepoPath): boolean;
  analyze(input: SourceInput): ParseResult<SourceAnalysis>;
  /** Releases parser resources. analyze() must not be called afterwards. */
  dispose(): void;
}

/**
 * Analysis levels (T18.0): L0 universal repository analysis (files, fingerprints, Git, diff, Truth,
 * evidence: every file), L1 structural language analysis (symbols, declarations, imports as written,
 * tests, syntactic calls, exact source locations), L2 semantic analysis (resolved modules, exact calls,
 * types, frameworks). Capabilities say, per analyzer, how far each relation goes. No scores.
 */
export interface AnalyzerCapabilities {
  readonly files: true;
  readonly symbols: "none" | "structural";
  readonly tests: "none" | "structural";
  /** syntactic: references as written only; partial: some repository-local references resolve to files; resolved: a module resolver decides every reference. */
  readonly imports: "none" | "syntactic" | "partial" | "resolved";
  /** syntactic: call sites as written, no CALLS edges; partial: CALLS only where the target is certain from syntax; exact: every CALLS edge claim is type-checked. */
  readonly calls: "none" | "syntactic" | "partial" | "exact";
  readonly typeResolution: "none" | "partial" | "full";
}

/** Bump when the meaning of a capability value changes. Part of every analyzer identity. */
export const CAPABILITY_CONTRACT_VERSION = "1";

/** Files without an analyzer (L0 only): generic file analysis. */
export const FILE_ONLY_CAPABILITIES: AnalyzerCapabilities = { files: true, symbols: "none", tests: "none", imports: "none", calls: "none", typeResolution: "none" };

/**
 * Analysis levels (T18.0), derived from capabilities, never declared separately:
 *   L0  files: path, fingerprint, Git history and diff, Truth references (every file in a Git repository)
 *   L1  structure: symbols, tests, imports and call sites as written (some references may resolve)
 *   L2  partial semantics: every import resolved by a module resolver, CALLS where bindings make the target certain
 *   L3  type resolution (no analyzer has it yet)
 */
export type AnalysisLevel = "L0" | "L1" | "L2" | "L3";

export function analysisLevelOf(c: AnalyzerCapabilities): AnalysisLevel {
  if (c.symbols === "none") return "L0";
  if (c.typeResolution !== "none") return "L3";
  if (c.imports === "resolved" && (c.calls === "partial" || c.calls === "exact")) return "L2";
  return "L1";
}

/**
 * module-bindings: the TypeScript/JavaScript rules (import bindings, export index, this-members).
 * same-file-functions: a bare-name call to the only callable top-level symbol of the same file.
 * none: call sites are kept as syntax; no CALLS edges.
 */
export type CallResolutionStrategy = "module-bindings" | "same-file-functions" | "none";
