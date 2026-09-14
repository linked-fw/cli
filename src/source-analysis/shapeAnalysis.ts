import ts from 'typescript';
import {ANALYSIS_SCHEMA_VERSION, ANALYZER_VERSION} from './contracts.js';
import type {
  AccessorEvidence,
  AnalysisEvidence,
  AnalysisFinding,
  AnalysisProfile,
  BindingRole,
  ExportRef,
  RangeRef,
  RdfTerm,
  ShapeEvidence,
  SourceSnapshot,
} from './contracts.js';
import {SourceResolver, unwrap} from './moduleResolution.js';
import {
  AnalysisRefusal,
  freezeData,
  refuse,
  validateSnapshot,
} from './snapshot.js';

const namespace = Symbol('namespace');
type NamespaceValue = {[namespace]: string};
const printer = ts.createPrinter({removeComments: true});
const print = (n: ts.Node) =>
  printer.printNode(ts.EmitHint.Unspecified, n, n.getSourceFile());
const compiledSample = ts.createSourceFile(
  'sample.js',
  ts.transpileModule('@d class C { @p get name(): string { return ""; } }', {
    compilerOptions: {
      target: ts.ScriptTarget.ES2015,
      module: ts.ModuleKind.ESNext,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  }).outputText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const helperPrint = (name: string) => {
  const declaration = compiledSample.statements
    .filter(ts.isVariableStatement)
    .flatMap((s) => [...s.declarationList.declarations])
    .find((d) => d.name.getText() === name);
  return declaration?.initializer ? print(declaration.initializer) : '';
};
const decorateHelper = helperPrint('__decorate');
const metadataHelper = helperPrint('__metadata');
const isClass = (n: ts.Node): n is ts.ClassLikeDeclaration =>
  ts.isClassDeclaration(n) || ts.isClassExpression(n);
const keyName = (n: ts.Node | undefined) =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined;

class Reader {
  readonly resolver: SourceResolver;
  readonly findings: AnalysisFinding[] = [];
  constructor(
    readonly snapshot: SourceSnapshot,
    readonly profile: AnalysisProfile,
  ) {
    this.resolver = new SourceResolver(snapshot, profile);
  }
  issue(error: unknown, entry: ExportRef, node?: ts.Node): void {
    if (!(error instanceof AnalysisRefusal) && !(error instanceof RangeError))
      throw error;
    const code =
      error instanceof AnalysisRefusal ? error.code : 'parser-depth-budget';
    const moduleId =
      error instanceof AnalysisRefusal
        ? (error.moduleId ?? entry.moduleId)
        : entry.moduleId;
    this.findings.push({
      code,
      affectedIds: [`${entry.moduleId}#${entry.exportName}`],
      provenance: [
        this.resolver.ref(
          moduleId,
          node && node.getSourceFile().fileName === moduleId ? node : undefined,
        ),
      ],
    });
  }
  role(id: string, raw: ts.Node, depth = 0): BindingRole | undefined {
    if (depth > this.profile.limits.referenceDepth)
      return refuse('reference-budget', id);
    const node = unwrap(raw);
    const ref = this.resolver.importRef(id, node);
    const trusted =
      ref &&
      this.profile.trustedBindings.find(
        (b) => b.moduleId === ref.moduleId && b.exportName === ref.exportName,
      );
    if (trusted) return trusted.role;
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node))
      return undefined;
    const target = this.resolver.expression(id, node);
    if (target.node === node) return undefined;
    for (const binding of this.profile.trustedBindings) {
      if (
        binding.moduleId === target.moduleId &&
        this.resolver.export(binding).node === target.node
      )
        return binding.role;
    }
    if (ts.isBindingElement(target.node)) {
      const parent = target.node.parent.parent;
      if (
        !ts.isVariableDeclaration(parent) ||
        !parent.initializer ||
        !ts.isCallExpression(parent.initializer)
      )
        return undefined;
      if (
        this.resolver.facts(target.moduleId).writes.has(target.localName) ||
        !(parent.parent.flags & ts.NodeFlags.Const)
      )
        return undefined;
      if (
        this.role(target.moduleId, parent.initializer.expression, depth + 1) !==
        'linkedPackage'
      )
        return undefined;
      const name = keyName(target.node.propertyName ?? target.node.name);
      return name === 'linkedShape' ? name : undefined;
    }
    return undefined;
  }
  value(
    id: string,
    raw: ts.Node,
    depth = 0,
    args: ReadonlyMap<string, unknown> = new Map(),
  ): any {
    if (depth > this.profile.limits.referenceDepth)
      return refuse('reference-budget', id);
    const node = unwrap(raw);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(node) && args.has(node.text))
      return args.get(node.text);
    if (ts.isIdentifier(node)) {
      const target = this.resolver.expression(id, node);
      if (target.node === node) return refuse('unsupported-static-value', id);
      return this.value(target.moduleId, target.node, depth + 1);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const f = this.resolver.facts(id);
      if (ts.isIdentifier(node.expression)) {
        const imported = f.imports.get(node.expression.text);
        if (imported?.length === 1 && imported[0].exportName === '*') {
          const target = this.resolver.expression(id, node);
          return this.value(target.moduleId, target.node, depth + 1);
        }
      }
      const base = this.resolver.expression(id, node.expression);
      if (ts.isObjectLiteralExpression(base.node)) {
        const props = base.node.properties.filter(
          (p) => keyName(p.name) === node.name.text,
        );
        if (
          props.length !== 1 ||
          base.node.properties.some(ts.isSpreadAssignment)
        )
          return refuse('ambiguous-object-value', id);
        const prop = props[0];
        if (ts.isPropertyAssignment(prop))
          return this.value(base.moduleId, prop.initializer, depth + 1);
        if (ts.isShorthandPropertyAssignment(prop))
          return this.value(base.moduleId, prop.name, depth + 1);
      }
      return refuse('unsupported-static-value', id);
    }
    if (ts.isArrayLiteralExpression(node))
      return node.elements.map((e) => this.value(id, e, depth + 1, args));
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.map((p) => {
        if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p))
          return refuse('unsupported-object-value', id);
        const name = keyName(p.name);
        if (!name) return refuse('computed-object-key', id);
        return [
          name,
          this.value(
            id,
            ts.isPropertyAssignment(p) ? p.initializer : p.name,
            depth + 1,
            args,
          ),
        ] as const;
      });
      if (new Set(properties.map((p) => p[0])).size !== properties.length)
        return refuse('duplicate-object-key', id);
      return Object.fromEntries(properties);
    }
    if (ts.isCallExpression(node)) {
      const role = this.role(id, node.expression);
      if (role === 'createNameSpace' && node.arguments.length === 1) {
        const base = this.value(id, node.arguments[0], depth + 1, args);
        if (typeof base !== 'string') return refuse('invalid-namespace', id);
        return {[namespace]: base} as NamespaceValue;
      }
      if (role === 'namedNode' && node.arguments.length === 1)
        return this.iri(this.value(id, node.arguments[0], depth + 1, args), id);
      const target = this.resolver.expression(id, node.expression);
      if (
        ts.isArrowFunction(target.node) &&
        target.node.parameters.length === 1 &&
        ts.isIdentifier(target.node.parameters[0].name) &&
        !ts.isBlock(target.node.body) &&
        node.arguments.length === 1
      ) {
        const arg = this.value(id, node.arguments[0], depth + 1, args);
        return this.value(
          target.moduleId,
          target.node.body,
          depth + 1,
          new Map([[target.node.parameters[0].name.text, arg]]),
        );
      }
      const factory = this.value(target.moduleId, target.node, depth + 1);
      if (factory?.[namespace] && node.arguments.length === 1) {
        const suffix = this.value(id, node.arguments[0], depth + 1, args);
        if (typeof suffix === 'string')
          return this.iri(factory[namespace] + suffix, id);
      }
    }
    return refuse('unsupported-static-value', id);
  }
  iri(value: any, id: string): RdfTerm {
    if (value?.kind === 'iri' && typeof value.value === 'string')
      value = value.value;
    if (
      typeof value !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(value)
    )
      return refuse('invalid-iri', id);
    return {kind: 'iri', value};
  }
  isDecorate(id: string, node: ts.Node): node is ts.CallExpression {
    if (
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      node.expression.text !== '__decorate'
    )
      return false;
    const f = this.resolver.facts(id);
    const bindings = f.locals.get('__decorate');
    if (
      bindings?.length !== 1 ||
      f.writes.has('__decorate') ||
      !ts.isVariableDeclaration(bindings[0]) ||
      !bindings[0].initializer ||
      print(bindings[0].initializer) !== decorateHelper
    )
      return refuse('unrecognized-decorator-helper', id);
    return true;
  }
  range(id: string, node: ts.Node): RangeRef {
    const raw = unwrap(node);
    const ref = this.resolver.importRef(id, raw);
    if (ref) {
      this.resolver.export(ref);
      return {kind: 'export', reference: ref};
    }
    const value = this.value(id, raw);
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((v) => typeof v === 'string' && v.length > 0)
    )
      return {kind: 'package', packageName: value[0], exportName: value[1]};
    return refuse('unsupported-object-range', id);
  }
  shape(entry: ExportRef): ShapeEvidence {
    this.resolver.referencedModules.clear();
    const target = this.resolver.export(entry);
    const id = target.moduleId;
    const node = target.node;
    if (!isClass(node)) return refuse('export-is-not-shape-class', id);
    const f = this.resolver.facts(id);
    const local = target.localName;
    const decorators: ts.Node[] = ts.canHaveDecorators(node)
      ? (ts.getDecorators(node) ?? []).map((d) => d.expression)
      : [];
    const properties: {name: string; decorators: ts.Node[]; node: ts.Node}[] =
      [];
    const targets: ts.Node[] = [];
    for (const m of node.members) {
      if (
        ts.isPropertyDeclaration(m) &&
        m.name.getText() === 'targetClass' &&
        ts
          .getModifiers(m)
          ?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) &&
        m.initializer
      )
        targets.push(m.initializer);
      if (ts.isGetAccessorDeclaration(m) && keyName(m.name))
        properties.push({
          name: keyName(m.name)!,
          node: m,
          decorators: (ts.getDecorators(m) ?? []).map((d) => d.expression),
        });
    }
    const allowedWrites = new Set<ts.Node>();
    for (const s of f.ast.statements)
      if (ts.isExpressionStatement(s)) {
        const e = unwrap(s.expression);
        if (
          ts.isBinaryExpression(e) &&
          e.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          if (
            ts.isPropertyAccessExpression(e.left) &&
            ts.isIdentifier(e.left.expression) &&
            e.left.expression.text === local &&
            e.left.name.text === 'targetClass'
          ) {
            targets.push(e.right);
            allowedWrites.add(e);
          }
          if (
            ts.isIdentifier(e.left) &&
            e.left.text === local &&
            this.isDecorate(id, e.right)
          ) {
            if (
              e.right.arguments.length !== 2 ||
              e.right.arguments[1].getText() !== local ||
              !ts.isArrayLiteralExpression(e.right.arguments[0])
            )
              return refuse('unsupported-decorator-application', id);
            decorators.push(...e.right.arguments[0].elements);
            allowedWrites.add(e);
          }
        }
        if (
          ts.isCallExpression(e) &&
          e.arguments[1]?.getText() === `${local}.prototype`
        ) {
          if (
            !this.isDecorate(id, e) ||
            e.arguments.length !== 4 ||
            !ts.isArrayLiteralExpression(e.arguments[0]) ||
            !ts.isStringLiteral(e.arguments[2])
          )
            return refuse('unsupported-decorator-application', id);
          const propertyName = e.arguments[2].text;
          const accessor = properties.filter((p) => p.name === propertyName);
          if (accessor.length !== 1) return refuse('ambiguous-accessor', id);
          accessor[0].decorators.push(...e.arguments[0].elements);
        }
      }
    for (const write of [
      ...(f.writes.get(local) ?? []),
      ...(f.writes.get(`${local}.targetClass`) ?? []),
      ...(f.writes.get(`${local}.*`) ?? []),
    ])
      if (!allowedWrites.has(write)) return refuse('mutated-shape-binding', id);
    if (targets.length !== 1) return refuse('ambiguous-target-class', id);
    let linked = 0;
    let complete = true;
    for (const d of decorators) {
      const role = this.role(id, ts.isCallExpression(d) ? d.expression : d);
      if (role === 'linkedShape') linked++;
      else {
        complete = false;
        this.issue(
          new AnalysisRefusal('unsupported-class-decorator', id),
          entry,
          d,
        );
      }
    }
    if (linked !== 1) return refuse('missing-proven-linked-decorator', id);
    const targetClass = this.iri(this.value(id, targets[0]), id);
    const heritage = node.heritageClauses?.find(
      (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
    );
    let superclass: ExportRef | undefined;
    if (heritage?.types.length === 1) {
      superclass = this.resolver.importRef(id, heritage.types[0].expression);
      if (!superclass) {
        complete = false;
        this.issue(new AnalysisRefusal('unresolved-superclass', id), entry);
      }
    }
    const accessors: AccessorEvidence[] = [];
    for (const property of properties) {
      for (const d of property.decorators) {
        // TS emits design metadata alongside the semantic decorator. It carries
        // no property correspondence claim and is deliberately not evaluated.
        try {
          if (
            ts.isCallExpression(d) &&
            ts.isIdentifier(d.expression) &&
            d.expression.text === '__metadata'
          ) {
            const helper = f.locals.get('__metadata');
            if (
              helper?.length !== 1 ||
              f.writes.has('__metadata') ||
              !ts.isVariableDeclaration(helper[0]) ||
              !helper[0].initializer ||
              print(helper[0].initializer) !== metadataHelper
            )
              return refuse('unrecognized-metadata-helper', id);
            continue;
          }
          if (!ts.isCallExpression(d))
            return refuse('unsupported-property-decorator', id);
          const role = this.role(id, d.expression);
          if (role !== 'literalProperty' && role !== 'objectProperty')
            return refuse('unsupported-property-decorator', id);
          if (
            d.arguments.length !== 1 ||
            !ts.isObjectLiteralExpression(d.arguments[0])
          )
            return refuse('unsupported-property-options', id);
          const fields = new Map<string, ts.Expression>();
          for (const p of d.arguments[0].properties) {
            if (
              !ts.isPropertyAssignment(p) ||
              !keyName(p.name) ||
              fields.has(keyName(p.name)!)
            )
              return refuse('ambiguous-property-options', id);
            fields.set(keyName(p.name)!, p.initializer);
          }
          if (!fields.has('path')) return refuse('missing-property-path', id);
          const range =
            role === 'objectProperty'
              ? fields.has('shape')
                ? this.range(id, fields.get('shape')!)
                : refuse('missing-object-range', id)
              : undefined;
          accessors.push({
            name: property.name,
            owner: {...entry},
            kind: role === 'objectProperty' ? 'object' : 'literal',
            path: this.iri(this.value(id, fields.get('path')!), id),
            ...(range ? {range} : {}),
            provenance: [
              this.resolver.ref(id, property.node),
              this.resolver.ref(id, d),
            ],
          });
        } catch (error) {
          complete = false;
          this.issue(error, entry, d);
        }
      }
    }
    if (new Set(accessors.map((a) => a.name)).size !== accessors.length)
      return refuse('duplicate-accessor-declaration', id);
    return {
      entry: {...entry},
      declaration: {moduleId: id, localName: local},
      targetClass,
      ...(superclass ? {superclass} : {}),
      accessors,
      coverage: complete ? 'complete' : 'partial',
      provenance: [
        ...[...this.resolver.referencedModules]
          .sort()
          .map((moduleId) => this.resolver.ref(moduleId)),
        this.resolver.ref(id, node),
        this.resolver.ref(id, targets[0]),
      ],
    };
  }
}

export function analyzeSource(
  snapshot: SourceSnapshot,
  profile: AnalysisProfile,
): AnalysisEvidence {
  const basisHash = validateSnapshot(snapshot, profile);
  const reader = new Reader(snapshot, profile);
  const shapes: ShapeEvidence[] = [];
  const queue = [...snapshot.entries];
  const seen = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index];
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    if (seen.size >= profile.limits.modules) {
      reader.issue(new AnalysisRefusal('entry-budget'), entry);
      break;
    }
    seen.add(key);
    try {
      const shape = reader.shape(entry);
      shapes.push(shape);
      if (
        shape.superclass &&
        !profile.trustedBindings.some(
          (b) =>
            b.moduleId === shape.superclass!.moduleId &&
            b.exportName === shape.superclass!.exportName &&
            b.role === 'Shape',
        )
      )
        queue.push(shape.superclass);
      for (const accessor of shape.accessors)
        if (accessor.range?.kind === 'export')
          queue.push(accessor.range.reference);
    } catch (error) {
      reader.issue(error, entry);
    }
  }
  return freezeData({
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    parserVersion: ts.version,
    basisHash,
    coverage: reader.findings.length ? 'partial' : 'complete',
    shapes,
    declarations: JSON.parse(JSON.stringify(snapshot.declarations)),
    findings: reader.findings,
  });
}
