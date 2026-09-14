import ts from 'typescript';
import type {
  AnalysisProfile,
  ExportRef,
  SourceModule,
  SourceRef,
  SourceSnapshot,
} from './contracts.js';
import {refuse} from './snapshot.js';

export interface LocatedNode {
  readonly moduleId: string;
  readonly node: ts.Node;
  readonly localName: string;
}
interface ImportBinding {
  specifier: string;
  exportName: string;
}
interface ExportBinding {
  localName?: string;
  node?: ts.Node;
  specifier?: string;
  exportName?: string;
}
export interface ModuleFacts {
  source: SourceModule;
  ast: ts.SourceFile;
  locals: Map<string, ts.Node[]>;
  imports: Map<string, ImportBinding[]>;
  exports: Map<string, ExportBinding[]>;
  writes: Map<string, ts.Node[]>;
  starExports: boolean;
}
const modifier = (n: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === kind);
const nameOf = (n: ts.Node | undefined) =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined;
const add = <T>(map: Map<string, T[]>, key: string, value: T) =>
  map.set(key, [...(map.get(key) ?? []), value]);
export const unwrap = (node: ts.Node): ts.Node =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isTypeAssertionExpression(node) ||
  ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;

/** Resolves explicit exports/import edges only. Never uses a host filesystem or require(). */
export class SourceResolver {
  readonly referencedModules = new Set<string>();
  private readonly cache = new Map<string, ModuleFacts>();
  private nodes = 0;
  constructor(
    readonly snapshot: SourceSnapshot,
    readonly profile: AnalysisProfile,
  ) {}

  ref(moduleId: string, node?: ts.Node): SourceRef {
    this.referencedModules.add(moduleId);
    const source = this.snapshot.modules.find((m) => m.id === moduleId);
    if (!source) return refuse('source-unavailable', moduleId);
    return {
      moduleId,
      moduleHash: source.hash,
      start: node?.getStart() ?? 0,
      end: node?.getEnd() ?? source.code.length,
    };
  }
  moduleFor(from: string, specifier: string): string {
    const edge = this.snapshot.resolutions.find(
      (e) => e.from === from && e.specifier === specifier,
    );
    if (!edge) return refuse('unresolved-import', from);
    this.referencedModules.add(from);
    this.referencedModules.add(edge.to);
    return edge.to;
  }
  facts(id: string): ModuleFacts {
    this.referencedModules.add(id);
    const cached = this.cache.get(id);
    if (cached) return cached;
    const source = this.snapshot.modules.find((m) => m.id === id);
    if (!source) return refuse('source-unavailable', id);
    const kind = {
      ts: ts.ScriptKind.TS,
      tsx: ts.ScriptKind.TSX,
      js: ts.ScriptKind.JS,
      jsx: ts.ScriptKind.JSX,
    }[source.language];
    const ast = ts.createSourceFile(
      id,
      source.code,
      ts.ScriptTarget.Latest,
      true,
      kind,
    );
    if (
      (ast as ts.SourceFile & {parseDiagnostics?: readonly unknown[]})
        .parseDiagnostics?.length
    )
      return refuse('syntax-error', id);
    const facts: ModuleFacts = {
      source,
      ast,
      locals: new Map(),
      imports: new Map(),
      exports: new Map(),
      writes: new Map(),
      starExports: false,
    };
    const exportLocal = (s: ts.Node, localName: string, node?: ts.Node) => {
      if (modifier(s, ts.SyntaxKind.ExportKeyword))
        add(
          facts.exports,
          modifier(s, ts.SyntaxKind.DefaultKeyword) ? 'default' : localName,
          {localName, node},
        );
    };
    for (const s of ast.statements) {
      if (
        ts.isImportDeclaration(s) &&
        s.importClause &&
        !s.importClause.isTypeOnly
      ) {
        if (!ts.isStringLiteral(s.moduleSpecifier) || s.attributes)
          return refuse('unsupported-import', id);
        const specifier = s.moduleSpecifier.text;
        const c = s.importClause;
        if (c.name)
          add(facts.imports, c.name.text, {specifier, exportName: 'default'});
        if (c.namedBindings && ts.isNamespaceImport(c.namedBindings))
          add(facts.imports, c.namedBindings.name.text, {
            specifier,
            exportName: '*',
          });
        if (c.namedBindings && ts.isNamedImports(c.namedBindings))
          for (const b of c.namedBindings.elements)
            if (!b.isTypeOnly)
              add(facts.imports, b.name.text, {
                specifier,
                exportName: b.propertyName?.text ?? b.name.text,
              });
      } else if (ts.isClassDeclaration(s) || ts.isFunctionDeclaration(s)) {
        if (s.name) {
          add(facts.locals, s.name.text, s);
          exportLocal(s, s.name.text);
        } else if (modifier(s, ts.SyntaxKind.DefaultKeyword))
          add(facts.exports, 'default', {node: s});
      } else if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) {
            add(facts.locals, d.name.text, d);
            exportLocal(s, d.name.text);
          } else if (ts.isObjectBindingPattern(d.name))
            for (const b of d.name.elements)
              if (ts.isIdentifier(b.name)) {
                add(facts.locals, b.name.text, b);
                exportLocal(s, b.name.text);
              }
        }
      } else if (ts.isExportDeclaration(s) && !s.isTypeOnly) {
        if (!s.exportClause || !ts.isNamedExports(s.exportClause)) {
          facts.starExports = true;
          continue;
        }
        for (const e of s.exportClause.elements)
          if (!e.isTypeOnly) {
            if (s.moduleSpecifier) {
              if (!ts.isStringLiteral(s.moduleSpecifier) || s.attributes)
                return refuse('unsupported-export', id);
              add(facts.exports, e.name.text, {
                specifier: s.moduleSpecifier.text,
                exportName: e.propertyName?.text ?? e.name.text,
              });
            } else
              add(facts.exports, e.name.text, {
                localName: e.propertyName?.text ?? e.name.text,
              });
          }
      } else if (ts.isExportAssignment(s) && !s.isExportEquals)
        add(facts.exports, 'default', {node: s.expression});
    }
    const walk = (node: ts.Node): void => {
      if (++this.nodes > this.profile.limits.astNodes) refuse('ast-budget', id);
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const left = unwrap(node.left);
        const key = ts.isIdentifier(left)
          ? left.text
          : ts.isPropertyAccessExpression(left) &&
              ts.isIdentifier(left.expression)
            ? `${left.expression.text}.${left.name.text}`
            : ts.isElementAccessExpression(left) &&
                ts.isIdentifier(left.expression)
              ? `${left.expression.text}.${ts.isStringLiteral(left.argumentExpression) ? left.argumentExpression.text : '*'}`
              : undefined;
        if (key) add(facts.writes, key, node);
      }
      if (
        (ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        const name = nameOf(node.operand);
        if (name) add(facts.writes, name, node);
      }
      node.forEachChild(walk);
    };
    walk(ast);
    this.cache.set(id, facts);
    return facts;
  }
  private next(
    seen: readonly string[],
    key: string,
    id: string,
  ): readonly string[] {
    if (seen.includes(key)) return refuse('cyclic-reference', id);
    if (seen.length >= this.profile.limits.referenceDepth)
      return refuse('reference-budget', id);
    return [...seen, key];
  }
  export(ref: ExportRef, seen: readonly string[] = []): LocatedNode {
    const next = this.next(
      seen,
      `export:${ref.moduleId}:${ref.exportName}`,
      ref.moduleId,
    );
    const f = this.facts(ref.moduleId);
    const bindings = f.exports.get(ref.exportName);
    if (bindings?.length !== 1)
      return refuse(
        f.starExports ? 'unsupported-star-export' : 'ambiguous-export',
        ref.moduleId,
      );
    const b = bindings[0];
    if (b.specifier)
      return this.export(
        {
          moduleId: this.moduleFor(ref.moduleId, b.specifier),
          exportName: b.exportName!,
        },
        next,
      );
    if (b.localName) return this.local(ref.moduleId, b.localName, next);
    return this.expression(ref.moduleId, b.node!, next);
  }
  local(id: string, name: string, seen: readonly string[] = []): LocatedNode {
    const next = this.next(seen, `local:${id}:${name}`, id);
    const f = this.facts(id);
    const locals = f.locals.get(name);
    const imported = f.imports.get(name);
    if (imported?.length === 1 && !locals && !f.writes.has(name)) {
      if (imported[0].exportName === '*')
        return refuse('namespace-is-not-value', id);
      return this.export(
        {
          moduleId: this.moduleFor(id, imported[0].specifier),
          exportName: imported[0].exportName,
        },
        next,
      );
    }
    if (locals?.length !== 1 || imported)
      return refuse('ambiguous-binding', id);
    const node = locals[0];
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isClassExpression(unwrap(node.initializer)))
        return {moduleId: id, node: unwrap(node.initializer), localName: name};
      if (!(node.parent.flags & ts.NodeFlags.Const) || f.writes.has(name))
        return refuse('mutable-binding', id);
      return this.expression(id, node.initializer, next);
    }
    if (ts.isClassDeclaration(node))
      return {moduleId: id, node, localName: name};
    if (f.writes.has(name)) return refuse('mutable-binding', id);
    return {moduleId: id, node, localName: name};
  }
  expression(
    id: string,
    raw: ts.Node,
    seen: readonly string[] = [],
  ): LocatedNode {
    const node = unwrap(raw);
    if (ts.isIdentifier(node)) return this.local(id, node.text, seen);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const imports = this.facts(id).imports.get(node.expression.text);
      if (imports?.length === 1 && imports[0].exportName === '*')
        return this.export(
          {
            moduleId: this.moduleFor(id, imports[0].specifier),
            exportName: node.name.text,
          },
          seen,
        );
    }
    return {
      moduleId: id,
      node,
      localName: (node as ts.ClassDeclaration).name?.getText?.() ?? 'default',
    };
  }
  importRef(id: string, raw: ts.Node): ExportRef | undefined {
    const node = unwrap(raw);
    const f = this.facts(id);
    if (ts.isIdentifier(node)) {
      const imported = f.imports.get(node.text);
      if (
        imported?.length === 1 &&
        !f.locals.has(node.text) &&
        !f.writes.has(node.text)
      )
        return {
          moduleId: this.moduleFor(id, imported[0].specifier),
          exportName: imported[0].exportName,
        };
      const entry = [...f.exports].find(
        ([, bs]) => bs.length === 1 && bs[0].localName === node.text,
      );
      if (entry) return {moduleId: id, exportName: entry[0]};
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const imported = f.imports.get(node.expression.text);
      if (
        imported?.length === 1 &&
        imported[0].exportName === '*' &&
        !f.locals.has(node.expression.text) &&
        !f.writes.has(node.expression.text)
      )
        return {
          moduleId: this.moduleFor(id, imported[0].specifier),
          exportName: node.name.text,
        };
    }
    return undefined;
  }
}
