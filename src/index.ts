import generateFn from '@babel/generator';
import { parse } from '@babel/parser';
import traverseFn, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';

const generate = (typeof generateFn === 'function' ? generateFn : (generateFn as any).default) as typeof generateFn;
const traverse = (typeof traverseFn === 'function' ? traverseFn : (traverseFn as any).default) as typeof traverseFn;

type ScriptKind = 'script' | 'module';
type JsxRuntime = 'classic' | 'automatic';
type ParserPlugins = Exclude<NonNullable<Parameters<typeof parse>[1]>['plugins'], undefined>;

interface TsConfig {
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  jsxRuntime?: JsxRuntime;
  sourceMaps: boolean;
  scriptType: ScriptKind;
}

type UserTsConfig = Pick<Partial<TsConfig>, 'scriptType'> & {
  compilerOptions?: {
    jsx?: string;
    jsxFactory?: string;
    jsxFragmentFactory?: string;
    sourceMap?: boolean;
    erasableSyntaxOnly?: boolean;
    baseUrl?: string;
    rootDir?: string;
    paths?: Record<string, string[]>;
  };
};

const DEFAULT_CONFIG: TsConfig = {
  sourceMaps: true,
  scriptType: 'module',
};

let inlineScriptId = 0;
let currentConfig = { ...DEFAULT_CONFIG };
let runtimeBridgeUrl = '';

const FETCH_OPTIONS: RequestInit = {
  cache: 'default',
  credentials: 'same-origin',
  redirect: 'follow',
};

const configReady: Promise<void> = (async () => {
  const tsconfigSrc = document.currentScript?.getAttribute('tsconfig');
  if (!tsconfigSrc) return;
  try {
    const response = await fetch(resolveUrl(tsconfigSrc), FETCH_OPTIONS);
    if (!response.ok) throw new Error(`[Typescript] failed to fetch tsconfig ${tsconfigSrc}: ${response.status}`);
    const loaded = JSON.parse(await response.text()) as UserTsConfig;
    currentConfig = mergeConfig(currentConfig, loaded);
  } catch (error) {
    console.error('[Typescript] failed to load tsconfig', error);
  }
})();

const RUNTIME_BINDING = '__ts';

const TS_SCRIPT_TYPES = new Set([
  'text/typescript',
  'text/typescript-tsx',
  'application/typescript',
  'application/typescript-tsx',
  'text/ts',
  'application/ts',
]);

const TSX_SRC_RE = /\.[cm]?tsx(?:[?#].*)?$/i;
const TSX_SCRIPT_TYPES = new Set(['text/typescript-tsx', 'application/typescript-tsx']);

const JSX_SRC_RE = /\.[cm]?jsx(?:[?#].*)?$/i;
const PROCESSABLE_SRC_RE = /\.[cm]?[jt]sx?(?:[?#].*)?$/i;

const BASE_PARSER_PLUGINS: ParserPlugins = [
  'typescript',
  'classProperties',
  'classPrivateProperties',
  'decorators-legacy',
  'importMeta',
  'topLevelAwait',
];

function isProcessableScript(script: HTMLScriptElement): boolean {
  const type = script.type.trim().toLowerCase();
  const src = script.getAttribute('src') ?? '';
  return TS_SCRIPT_TYPES.has(type) || PROCESSABLE_SRC_RE.test(src);
}

function isJsxScript(script: HTMLScriptElement): boolean {
  const type = script.type.trim().toLowerCase();
  const src = script.getAttribute('src') ?? '';
  return src ? TSX_SRC_RE.test(src) || JSX_SRC_RE.test(src) : TSX_SCRIPT_TYPES.has(type);
}

function resolveUrl(url: string, base?: string): string {
  return new URL(url, base || document.baseURI).href;
}

function toBlobUrl(code: string): string {
  return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
}

function toSourceMapUrl(map: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(map));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return `data:application/json;base64,${btoa(binary)}`;
}

function runtimeExpression(): t.Identifier {
  return t.identifier(RUNTIME_BINDING);
}

function runtimeBridgeDeclaration(): t.VariableDeclaration {
  return t.variableDeclaration('const', [
    t.variableDeclarator(
      runtimeExpression(),
      t.awaitExpression(
        t.callExpression(
          t.memberExpression(t.callExpression(t.import(), [t.stringLiteral(runtimeBridgeUrl)]), t.identifier('then')),
          [
            t.arrowFunctionExpression(
              [t.identifier('module')],
              t.memberExpression(
                t.memberExpression(t.identifier('module'), t.identifier('default')),
                t.identifier('promise'),
              ),
            ),
          ],
        ),
      ),
    ),
  ]);
}

function mergeConfig(base: TsConfig, user: UserTsConfig): TsConfig {
  const compilerOptions = user.compilerOptions ?? {};

  if (compilerOptions.erasableSyntaxOnly === false) {
    console.warn(
      '[Typescript] Warning: "erasableSyntaxOnly: false" in tsconfig is not supported. ' +
        'typescript-runtime always enforces erasable syntax only. ' +
        'Non-erasable syntax (enum, namespace, decorators) will be rejected.',
    );
  }

  const rootRe = /^\.\/?$/;
  if (compilerOptions.baseUrl !== undefined && !rootRe.test(compilerOptions.baseUrl)) {
    console.warn(
      `[Typescript] Warning: "baseUrl" is set to "${compilerOptions.baseUrl}" in tsconfig, ` +
        "but typescript-runtime always uses the script's effective URL (document.URL) as the import base. " +
        'This setting is ignored.',
    );
  }
  if (compilerOptions.rootDir !== undefined && !rootRe.test(compilerOptions.rootDir)) {
    console.warn(
      `[Typescript] Warning: "rootDir" is set to "${compilerOptions.rootDir}" in tsconfig, ` +
        'but typescript-runtime does not use this setting for import resolution. ' +
        'This setting is ignored.',
    );
  }
  if (compilerOptions.paths !== undefined) {
    console.warn(
      '[Typescript] Warning: "paths" in tsconfig is not supported by typescript-runtime. ' +
        'Import resolution always follows native ESM semantics (relative and absolute URLs).',
    );
  }

  const jsx = compilerOptions.jsx?.toLowerCase();
  const jsxRuntime =
    jsx === 'react-jsx' || jsx === 'react-jsxdev' ? 'automatic' : jsx === 'react' ? 'classic' : base.jsxRuntime;

  return {
    ...base,
    ...user,
    jsxFactory: compilerOptions.jsxFactory ?? base.jsxFactory,
    jsxFragmentFactory: compilerOptions.jsxFragmentFactory ?? base.jsxFragmentFactory,
    jsxRuntime,
    sourceMaps: compilerOptions.sourceMap ?? base.sourceMaps,
    scriptType: user.scriptType ?? base.scriptType,
  };
}

function getJsxConfig(config: TsConfig): { runtime: JsxRuntime; factory?: string; fragmentFactory?: string } | null {
  if (config.jsxRuntime === 'classic' && config.jsxFactory && config.jsxFragmentFactory) {
    return { runtime: 'classic', factory: config.jsxFactory, fragmentFactory: config.jsxFragmentFactory };
  }
  if (config.jsxRuntime === 'automatic') {
    return { runtime: 'automatic' };
  }
  return null;
}

function blockScript(script: HTMLScriptElement): void {
  const src = script.getAttribute('src') ?? '';
  if (!script.hasAttribute('type') && PROCESSABLE_SRC_RE.test(src)) {
    script.setAttribute('type', 'text/plain');
    script.setAttribute('raw', '');
  }
}

function readInlineScript(script: HTMLScriptElement): { code: string; filename: string; baseUrl: string } {
  const ext = isJsxScript(script) ? 'tsx' : 'ts';
  const id = ++inlineScriptId;
  return { code: script.textContent ?? '', filename: `ts://inline/${id}.${ext}`, baseUrl: document.URL };
}

interface TransformContext {
  imports: ImportRef[];
  isModule: boolean;
}

function collectImportSource(source: t.StringLiteral, context: TransformContext, baseUrl: string): void {
  if (!isProcessableSpecifier(source.value, baseUrl)) return;
  context.imports.push({ source, specifier: source.value });
}

function transformAst(
  ast: t.File,
  filename: string,
  jsxConfig: ActiveJsxConfig | null,
  baseUrl: string,
): TransformContext {
  let metaCount = 0;
  let runtimeUseCount = 0;
  const context: TransformContext = { imports: [], isModule: false };
  const runtimeBaseUrl = resolveUrl(baseUrl);

  traverse(ast, {
    TSEnumDeclaration() {
      throw new Error(
        `[Typescript] \`enum\` is not erasable syntax and cannot be transformed to valid JavaScript. File: ${filename}`,
      );
    },

    TSModuleDeclaration(path) {
      if (path.node.declare) {
        path.remove();
        return;
      }
      if (!path.node.body) {
        path.remove();
        return;
      }
      throw new Error(`[Typescript] \`namespace\`/ \`module\` is not erasable syntax. File: ${filename}`);
    },

    Decorator() {
      throw new Error(`[Typescript] Decorators are not erasable syntax and cannot be compiled. File: ${filename}`);
    },

    TSInterfaceDeclaration(path) {
      path.remove();
    },
    TSTypeAliasDeclaration(path) {
      path.remove();
    },
    TSDeclareFunction(path) {
      path.remove();
    },
    TSDeclareMethod(path) {
      path.remove();
    },
    TSImportEqualsDeclaration() {
      throw new Error(`[Typescript] \`import =\` is not erasable syntax. File: ${filename}`);
    },
    TSExportAssignment() {
      throw new Error(`[Typescript] \`export =\` is not erasable syntax. File: ${filename}`);
    },
    TSNamespaceExportDeclaration() {
      throw new Error(`[Typescript] namespace exports are not erasable syntax. File: ${filename}`);
    },
    ImportDeclaration(path) {
      if (path.node.importKind === 'type' || path.node.importKind === 'typeof') {
        path.remove();
        return;
      }
      const hadSpecifiers = path.node.specifiers.length > 0;
      path.node.specifiers = path.node.specifiers.filter((specifier) => {
        return (
          !t.isImportSpecifier(specifier) || (specifier.importKind !== 'type' && specifier.importKind !== 'typeof')
        );
      });
      if (hadSpecifiers && path.node.specifiers.length === 0) {
        path.remove();
        return;
      }
      context.isModule = true;
      collectImportSource(path.node.source, context, baseUrl);
    },
    ExportNamedDeclaration(path) {
      if (path.node.exportKind === 'type') {
        path.remove();
        return;
      }
      if (path.node.declaration && isTypeOnlyDeclaration(path.node.declaration)) {
        path.remove();
        return;
      }
      const hadSpecifiers = path.node.specifiers.length > 0;
      path.node.specifiers = path.node.specifiers.filter((specifier) => {
        return !t.isExportSpecifier(specifier) || specifier.exportKind !== 'type';
      });
      if (hadSpecifiers && path.node.specifiers.length === 0 && !path.node.declaration) {
        path.remove();
        return;
      }
      context.isModule = true;
      if (path.node.source) {
        collectImportSource(path.node.source, context, baseUrl);
      }
    },
    ExportAllDeclaration(path) {
      if (path.node.exportKind === 'type') {
        path.remove();
        return;
      }
      context.isModule = true;
      collectImportSource(path.node.source, context, baseUrl);
    },
    ExportDefaultDeclaration(path) {
      if (isTypeOnlyDeclaration(path.node.declaration)) {
        path.remove();
        return;
      }
      context.isModule = true;
    },
    TSTypeAnnotation(path) {
      path.remove();
    },
    TSTypeParameterDeclaration(path) {
      path.remove();
    },
    TSTypeParameterInstantiation(path) {
      path.remove();
    },
    TSAsExpression(path) {
      path.replaceWith(path.node.expression);
    },
    TSTypeAssertion(path) {
      path.replaceWith(path.node.expression);
    },
    TSSatisfiesExpression(path) {
      path.replaceWith(path.node.expression);
    },
    TSNonNullExpression(path) {
      path.replaceWith(path.node.expression);
    },
    TSInstantiationExpression(path) {
      path.replaceWith(path.node.expression);
    },
    TSParameterProperty() {
      throw new Error(`[Typescript] parameter properties are not erasable syntax. File: ${filename}`);
    },
    VariableDeclaration(path) {
      if (path.node.declare) {
        path.remove();
      }
    },
    VariableDeclarator(path) {
      clearPatternTypes(path.node.id);
      path.node.definite = null;
    },
    ClassDeclaration(path) {
      if (path.node.declare) {
        path.remove();
        return;
      }
      clearClassTypes(path.node);
    },
    ClassExpression(path) {
      clearClassTypes(path.node);
    },
    ClassProperty(path) {
      if (path.node.declare) {
        path.remove();
        return;
      }
      clearClassPropertyTypes(path.node);
    },
    ClassAccessorProperty(path) {
      if (path.node.declare) {
        path.remove();
        return;
      }
      clearClassPropertyTypes(path.node);
    },
    ClassPrivateProperty(path) {
      clearClassPropertyTypes(path.node);
    },
    ClassMethod(path) {
      clearClassMethodTypes(path.node);
    },
    ClassPrivateMethod(path) {
      clearClassMethodTypes(path.node);
    },
    Function(path: NodePath<t.Function>) {
      path.node.returnType = null;
      path.node.typeParameters = null;
      for (const parameter of path.node.params) {
        clearPatternTypes(parameter);
      }
    },
    MetaProperty(path) {
      if (t.isMetaProperty(path.node) && path.node.meta.name === 'import' && path.node.property.name === 'meta') {
        metaCount++;
        runtimeUseCount++;
        path.replaceWith(t.identifier('__import_meta'));
      }
    },
    CallExpression(path) {
      path.node.typeArguments = null;
      path.node.typeParameters = null;
      if (!t.isImport(path.node.callee)) return;
      const [specifier] = path.node.arguments;
      if (!specifier || !t.isExpression(specifier)) return;
      runtimeUseCount++;
      path.replaceWith(
        t.callExpression(t.memberExpression(runtimeExpression(), t.identifier('import')), [
          specifier,
          t.stringLiteral(runtimeBaseUrl),
        ]),
      );
    },
    NewExpression(path) {
      path.node.typeArguments = null;
      path.node.typeParameters = null;
    },
    OptionalCallExpression(path) {
      path.node.typeArguments = null;
      path.node.typeParameters = null;
    },
    TaggedTemplateExpression(path) {
      path.node.typeParameters = null;
    },
    AwaitExpression(path) {
      if (!path.getFunctionParent()) {
        context.isModule = true;
      }
    },
    JSXElement(path: NodePath<t.JSXElement>) {
      if (!jsxConfig) return;
      path.replaceWith(convertJsxElement(path.node, jsxConfig));
    },
    JSXFragment(path: NodePath<t.JSXFragment>) {
      if (!jsxConfig) return;
      path.replaceWith(convertJsxElement(path.node, jsxConfig));
    },
  });

  if (runtimeUseCount > 0) {
    const declarations: t.Statement[] = [runtimeBridgeDeclaration()];
    if (metaCount > 0) {
      declarations.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier('__import_meta'),
            t.objectExpression([
              t.objectProperty(t.identifier('url'), t.stringLiteral(filename)),
              t.objectProperty(
                t.identifier('resolve'),
                t.arrowFunctionExpression(
                  [t.identifier('specifier')],
                  t.callExpression(t.memberExpression(runtimeExpression(), t.identifier('resolve')), [
                    t.stringLiteral(runtimeBaseUrl),
                    t.identifier('specifier'),
                  ]),
                ),
              ),
            ]),
          ),
        ]),
      );
    }
    ast.program.body.unshift(...declarations);
  }

  return context;
}

type ActiveJsxConfig = NonNullable<ReturnType<typeof getJsxConfig>>;
type DefiniteIdentifier = t.Identifier & { definite?: boolean | null };

function isTypeOnlyDeclaration(node: t.Node): boolean {
  return (
    t.isTSInterfaceDeclaration(node) ||
    t.isTSTypeAliasDeclaration(node) ||
    t.isTSDeclareFunction(node) ||
    t.isTSDeclareMethod(node) ||
    (t.isTSModuleDeclaration(node) && Boolean(node.declare)) ||
    (t.isVariableDeclaration(node) && Boolean(node.declare)) ||
    (t.isFunctionDeclaration(node) && Boolean(node.declare)) ||
    (t.isClassDeclaration(node) && Boolean(node.declare))
  );
}

function clearPatternTypes(node: t.Node | null | undefined): void {
  if (!node) return;
  if (t.isIdentifier(node)) {
    node.typeAnnotation = null;
    node.optional = false;
    (node as DefiniteIdentifier).definite = null;
    return;
  }
  if (t.isAssignmentPattern(node)) {
    node.typeAnnotation = null;
    node.optional = false;
    clearPatternTypes(node.left);
    return;
  }
  if (t.isArrayPattern(node)) {
    node.typeAnnotation = null;
    node.optional = false;
    for (const element of node.elements) {
      clearPatternTypes(element);
    }
    return;
  }
  if (t.isObjectPattern(node)) {
    node.typeAnnotation = null;
    node.optional = false;
    for (const property of node.properties) {
      clearPatternTypes(t.isRestElement(property) ? property.argument : property.value);
    }
    return;
  }
  if (t.isRestElement(node)) {
    node.typeAnnotation = null;
    clearPatternTypes(node.argument);
  }
}

function clearClassTypes(node: t.ClassDeclaration | t.ClassExpression): void {
  node.typeParameters = null;
  node.superTypeParameters = null;
  node.implements = null;
  if ('abstract' in node) node.abstract = null;
  if ('declare' in node) node.declare = null;
}

function clearClassPropertyTypes(node: t.ClassProperty | t.ClassAccessorProperty | t.ClassPrivateProperty): void {
  node.typeAnnotation = null;
  node.definite = null;
  node.optional = null;
  node.readonly = null;
  if ('abstract' in node) node.abstract = null;
  if ('accessibility' in node) node.accessibility = null;
  if ('declare' in node) node.declare = null;
  if ('override' in node) node.override = false;
}

function clearClassMethodTypes(node: t.ClassMethod | t.ClassPrivateMethod): void {
  node.returnType = null;
  node.typeParameters = null;
  node.abstract = null;
  node.access = null;
  node.accessibility = null;
  node.optional = null;
  node.override = false;
  for (const parameter of node.params) {
    clearPatternTypes(parameter);
  }
}

async function transform(
  code: string,
  filename: string,
  tsx: boolean,
  config: TsConfig,
  baseUrl: string,
  chain?: Set<string>,
): Promise<TransformedModule> {
  const jsxConfig = tsx ? getJsxConfig(config) : null;
  if (tsx && !jsxConfig) {
    throw new Error(`[Typescript] TSX/JSX requires explicit jsx runtime config in tsconfig: ${filename}`);
  }

  const ast = parseSource(code, filename, tsx, config.scriptType);
  const context = transformAst(ast, filename, jsxConfig, baseUrl);

  await Promise.all(
    context.imports.map(async ({ source, specifier }) => {
      source.value = await preloadStaticDependency(specifier, baseUrl, chain);
      source.extra = undefined;
    }),
  );

  const output = generate(ast, {
    sourceMaps: config.sourceMaps,
    sourceFileName: filename,
  });

  if (config.sourceMaps && output.map) {
    output.map.sources = [filename];
    output.map.sourcesContent = [code];
    return {
      code: `${output.code}\n//# sourceMappingURL=${toSourceMapUrl(output.map)}`,
      isModule: context.isModule,
    };
  }

  return { code: output.code, isModule: context.isModule };
}

function memberExpression(name: string): t.Expression {
  const [root, ...properties] = name.split('.');
  return properties.reduce<t.Expression>((object, property) => {
    return t.memberExpression(object, t.identifier(property));
  }, t.identifier(root));
}

function jsxText(value: string): t.StringLiteral | null {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? t.stringLiteral(normalized) : null;
}

function convertJsxName(
  name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName,
): t.Expression | t.StringLiteral {
  if (t.isJSXIdentifier(name)) {
    return /^[a-z]/.test(name.name) ? t.stringLiteral(name.name) : t.identifier(name.name);
  }
  if (t.isJSXMemberExpression(name)) {
    return t.memberExpression(
      convertJsxName(name.object) as t.Expression,
      convertJsxName(name.property) as t.Expression,
    );
  }
  return t.stringLiteral(`${name.namespace.name}:${name.name.name}`);
}

function convertJsxAttribute(attribute: t.JSXAttribute | t.JSXSpreadAttribute): t.ObjectProperty | t.SpreadElement {
  if (t.isJSXSpreadAttribute(attribute)) {
    return t.spreadElement(attribute.argument);
  }
  const key = t.isJSXIdentifier(attribute.name)
    ? t.identifier(attribute.name.name)
    : t.stringLiteral(attribute.name.name.name);
  const value = attribute.value;
  if (!value) {
    return t.objectProperty(key, t.booleanLiteral(true));
  }
  if (t.isStringLiteral(value)) {
    return t.objectProperty(key, value);
  }
  if (t.isJSXExpressionContainer(value)) {
    return t.objectProperty(key, t.isJSXEmptyExpression(value.expression) ? t.booleanLiteral(true) : value.expression);
  }
  return t.objectProperty(key, value as unknown as t.Expression);
}

function convertJsxElement(node: t.JSXElement | t.JSXFragment, config: ActiveJsxConfig): t.Expression {
  const children = node.children
    .map((child) => {
      if (t.isJSXText(child)) {
        return jsxText(child.value);
      }
      if (t.isJSXExpressionContainer(child)) {
        return t.isJSXEmptyExpression(child.expression) ? null : child.expression;
      }
      if (t.isJSXElement(child) || t.isJSXFragment(child)) {
        return convertJsxElement(child, config);
      }
      return null;
    })
    .filter((child): child is t.Expression | t.StringLiteral => child !== null);

  const tag = t.isJSXElement(node)
    ? convertJsxName(node.openingElement.name)
    : memberExpression(config.fragmentFactory!);
  const props = t.isJSXElement(node)
    ? t.objectExpression(node.openingElement.attributes.map(convertJsxAttribute))
    : t.nullLiteral();

  const factory =
    config.runtime === 'automatic'
      ? t.identifier(children.length > 1 ? 'jsxs' : 'jsx')
      : memberExpression(config.factory!);

  return t.callExpression(factory, [tag, props, ...children]);
}

/* ─── Runtime (injected once into global scope) ─── */

function initRuntime(): void {
  runtimeBridgeUrl = toBlobUrl('export default Promise.withResolvers();\n');

  async function dynamicImport(specifier: string, baseUrl: string): Promise<unknown> {
    const url = resolveUrl(specifier, baseUrl);
    if (PROCESSABLE_EXT_RE.test(url)) {
      const blobUrl = await resolveFile(url);
      return import(blobUrl);
    }
    return import(url);
  }

  async function resolveMeta(baseUrl: string, specifier: string): Promise<string> {
    const url = resolveUrl(specifier, baseUrl);
    if (PROCESSABLE_EXT_RE.test(url)) {
      const blobUrl = await resolveFile(url);
      return blobUrl;
    }
    return url;
  }

  void import(runtimeBridgeUrl).then((module) => {
    module.default.resolve({ import: dynamicImport, resolve: resolveMeta });
  });
}

/* ─── Import resolution (blob URL graph) ─── */

const PROCESSABLE_EXT_RE = /\.[cm]?[jt]sx?(?:[?#].*)?$/i;
const JSX_EXT_RE = /\.[cm]?[jt]sx(?:[?#].*)?$/i;
interface ImportRef {
  source: t.StringLiteral;
  specifier: string;
}

interface ModuleBlob {
  url: string;
  isModule: boolean;
}

interface TransformedModule {
  code: string;
  isModule: boolean;
}

const moduleBlobCache = new Map<string, ModuleBlob>();
const pendingModules = new Map<string, Promise<ModuleBlob>>();

function parseSource(code: string, filename: string, tsx: boolean, scriptType: ScriptKind): t.File {
  return parse(code, {
    sourceFilename: filename,
    sourceType: scriptType === 'module' ? 'module' : 'unambiguous',
    plugins: tsx ? [...BASE_PARSER_PLUGINS, 'jsx'] : BASE_PARSER_PLUGINS,
  });
}

async function transformFile(url: string, chain?: Set<string>): Promise<TransformedModule> {
  const response = await fetch(url, FETCH_OPTIONS);
  if (!response.ok) throw new Error(`[Typescript] failed to fetch ${url}: ${response.status}`);
  const code = await response.text();
  const tsx = JSX_EXT_RE.test(url);
  const transformed = await transform(code, url, tsx, currentConfig, url, chain);
  return { ...transformed, isModule: currentConfig.scriptType === 'module' || transformed.isModule };
}

async function preloadStaticDependency(specifier: string, baseUrl: string, chain?: Set<string>): Promise<string> {
  const url = resolveUrl(specifier, baseUrl);
  try {
    return (await resolveModuleFile(url, chain)).url;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(
      new Error(`[Typescript] failed to resolve dependency ${JSON.stringify(specifier)} from ${baseUrl}: ${message}`),
      { cause: error },
    );
  }
}

function isProcessableSpecifier(specifier: string, baseUrl: string): boolean {
  try {
    return PROCESSABLE_EXT_RE.test(resolveUrl(specifier, baseUrl));
  } catch {
    return PROCESSABLE_EXT_RE.test(specifier);
  }
}

async function resolveFile(url: string, chain?: Set<string>): Promise<string> {
  return (await resolveModuleFile(url, chain)).url;
}

async function resolveModuleFile(url: string, chain?: Set<string>): Promise<ModuleBlob> {
  const cached = moduleBlobCache.get(url);
  if (cached) return cached;

  const currentChain = new Set(chain);
  if (currentChain.has(url)) {
    throw new Error(`[Typescript] circular dependency detected: ${url}`);
  }
  currentChain.add(url);

  const existing = pendingModules.get(url);
  if (existing) return existing;

  const promise = (async (): Promise<ModuleBlob> => {
    const transformed = await transformFile(url, currentChain);
    const moduleBlob = { url: toBlobUrl(transformed.code), isModule: transformed.isModule };
    moduleBlobCache.set(url, moduleBlob);
    return moduleBlob;
  })();

  pendingModules.set(url, promise);
  try {
    return await promise;
  } finally {
    pendingModules.delete(url);
  }
}

/* ─── Script injection ─── */

async function injectScript(url: string, original: HTMLScriptElement, isModule: boolean): Promise<void> {
  const parent = original.parentNode;
  if (!parent) return;

  const script = document.createElement('script');

  script.src = url;

  script.type = isModule ? 'module' : 'text/javascript';

  for (const { name, value } of Array.from(original.attributes)) {
    if (!['src', 'type'].includes(name) && name.startsWith('data-')) {
      script.setAttribute(name, value);
    }
  }

  parent.replaceChild(script, original);
  script.setAttribute('raw', '');
}

function reportProcessingError(error: unknown, script: HTMLScriptElement): void {
  console.error('[Typescript] failed to process script', script, error);
  throw error instanceof Error ? error : new Error(String(error));
}

async function processScript(script: HTMLScriptElement): Promise<void> {
  await configReady;

  try {
    const src = script.getAttribute('src');
    if (src) {
      const moduleBlob = await resolveModuleFile(resolveUrl(src));
      await injectScript(moduleBlob.url, script, moduleBlob.isModule);
      return;
    }

    const { code, filename, baseUrl } = readInlineScript(script);
    const tsx = isJsxScript(script);
    const output = await transform(code, filename, tsx, currentConfig, baseUrl);
    const isModule = currentConfig.scriptType === 'module' || output.isModule;
    await injectScript(toBlobUrl(output.code), script, isModule);
  } catch (error) {
    reportProcessingError(error, script);
  }
}

function visitScript(script: HTMLScriptElement): void {
  if (script.hasAttribute('raw')) return;
  if (!isProcessableScript(script)) return;
  blockScript(script);
  void processScript(script);
}

function scan(root: ParentNode): void {
  if (root instanceof HTMLScriptElement) {
    visitScript(root);
  }
  root.querySelectorAll?.('script').forEach(visitScript);
}

function start(): void {
  scan(document);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element || node instanceof DocumentFragment) {
          scan(node);
        }
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
}

initRuntime();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
