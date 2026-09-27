/**
 * LanguageAnalyzer contract (TASK-005, ADR-003). Syntax facts only: no Graph, no resolution of
 * imports or call targets (that is the Graph Builder, TASK-007). No Tree-sitter types here.
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
  /** A getter and a setter with the same name: one property symbol. */
  | "accessor";

export interface AnalyzedSymbol {
  /** Identity: core symbolRef(path, qualifiedName). Node IDs come from core nodeId(). */
  readonly ref: SymbolRef;
  readonly name: string;
  /** "AuthService", "AuthService.login", "AuthService.#refresh", "default", "default.render". */
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly exported: boolean;
  /** Class members declared static. */
  readonly static?: true;
  /** qualifiedName of the containing class, for members. */
  readonly parent?: string;
  /** Primary declaration: the one with a body, otherwise the first. */
  readonly location: SourceLocation;
  /** Other declarations of the same symbol (overload signatures, merged declarations), in location order. */
  readonly additionalLocations?: readonly SourceLocation[];
}

export type ModuleReferenceKind = "import" | "export-from" | "dynamic-import" | "require";

/** A literal module specifier as written. Not resolved to a file. */
export interface ModuleReference {
  readonly specifier: string;
  readonly kind: ModuleReferenceKind;
  /** "import type ..." / "export type ... from": the whole statement is type-only. */
  readonly typeOnly: boolean;
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

export type ParseStatus = "complete" | "partial";

/**
 * Result of analyzing one file. Every list is in location order (compareSourceLocations), ties
 * broken by a stable key: qualifiedName, specifier then kind, calleeText, ids.
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
