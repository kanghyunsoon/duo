/**
 * LanguageAnalyzer contract (TASK-005, T05.1, ADR-003). Syntax facts only: no Graph, no resolution
 * of imports, calls or tests (that is the Graph Builder, TASK-007). No Tree-sitter types here.
 */
import type { ParseResult, RepoPath, SourceLocation, SymbolRef } from "@duo-director/core";

/** Language of an analysis. Open-ended so a new analyzer needs no change to this package. */
export type SourceLanguage = "typescript" | "tsx" | "javascript" | (string & {});

export interface SourceInput {
  readonly path: RepoPath;
  /** File bytes as read from the working tree. */
  readonly content: Uint8Array;
}

export type SymbolKind =
  | "class" | "interface" | "type-alias" | "enum" | "function"
  | "method" | "constructor" | "getter" | "setter"
  /** A getter and a setter with the same name in the same member scope: one property symbol. */
  | "accessor";

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

export type ModuleReferenceKind = "import" | "export-from" | "dynamic-import" | "require";

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
  /** The import/export statement, or the import()/require() call. */
  readonly location: SourceLocation;
}

export type CallSiteKind = "identifier" | "member" | "constructor";

/** A call as written. The target is not resolved: "auth.login()" is not claimed to call AuthService.login. */
export interface CallSite {
  readonly kind: CallSiteKind;
  /** Callee source text with line breaks and their indentation removed, e.g. "client.user.login". */
  readonly calleeText: string;
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
export type TestFrameworkHint = "vitest" | "jest" | "node-test" | "unknown";
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
  readonly callSites: readonly CallSite[];
  readonly annotations: readonly DuoAnnotation[];
  readonly tests: readonly AnalyzedTest[];
}

export interface LanguageAnalyzer {
  /** Stable analyzer ID, e.g. "typescript". */
  readonly id: string;
  /** Changes when extraction output changes; files of this analyzer are then re-analyzed (04). */
  readonly version: string;
  /** Path-based and cheap; unsupported files are never parsed. */
  supports(path: RepoPath): boolean;
  analyze(input: SourceInput): ParseResult<SourceAnalysis>;
  /** Releases parser resources. analyze() must not be called afterwards. */
  dispose(): void;
}
