import generateFn from '@babel/generator';
import { parse } from '@babel/parser';
import traverseFn, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';

const generate = (typeof generateFn === 'function' ? generateFn : (generateFn as any).default) as typeof generateFn;
const traverse = (typeof traverseFn === 'function' ? traverseFn : (traverseFn as any).default) as typeof traverseFn;

type ScriptKind = 'script' | 'module';
type JsxRuntime = 'classic' | 'automatic';
type ParserPlugins = Exclude<NonNullable<Parameters<typeof parse>[1]>['plugins'], undefined>;

interface TsnowConfig {
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  jsxImportSource?: string;
  jsxRuntime?: JsxRuntime;
  sourceMaps: boolean;
  scriptType: ScriptKind;
}

type UserTsConfig = Pick<Partial<TsnowConfig>, 'scriptType'> & {
  compilerOptions?: {
    jsx?: string;
    jsxFactory?: string;
    jsxFragmentFactory?: string;
    jsxImportSource?: string;
    sourceMap?: boolean;
    erasableSyntaxOnly?: boolean;
  };
};

const DEFAULT_CONFIG: TsnowConfig = {
  sourceMaps: true,
  scriptType: 'module',
};

const seenScripts = new WeakSet<HTMLScriptElement>();
const seenConfigs = new WeakSet<Element>();
const textCache = new Map<string, Promise<string>>();
let inlineScriptId = 0;
let currentConfig = { ...DEFAULT_CONFIG };
let configReady = Promise.resolve();

const TS_SCRIPT_TYPES = new Set([
  'text/typescript',
  'text/typescript-tsx',
  'application/typescript',
  'application/typescript-tsx',
  'text/ts',
  'application/ts',
]);

const TS_SRC_RE = /\.[cm]?tsx?(?:[?#].*)?$/i;
const TSX_SRC_RE = /\.[cm]?tsx(?:[?#].*)?$/i;
const TSX_SCRIPT_TYPES = new Set(['text/typescript-tsx', 'application/typescript-tsx']);

const BASE_PARSER_PLUGINS: ParserPlugins = [
  'typescript',
  'classProperties',
  'classPrivateProperties',
  'decorators-legacy',
  'importMeta',
  'topLevelAwait',
];

const FETCH_OPTIONS: RequestInit = {
  cache: 'default',
  credentials: 'same-origin',
  redirect: 'follow',
};

function isTsScript(script: HTMLScriptElement): boolean {
  const type = script.type.trim().toLowerCase();
  const src = script.getAttribute('src') ?? '';
  return TS_SCRIPT_TYPES.has(type) || TS_SRC_RE.test(src);
}

function isTsxScript(script: HTMLScriptElement): boolean {
  const type = script.type.trim().toLowerCase();
  const src = script.getAttribute('src') ?? '';
  return src ? TSX_SRC_RE.test(src) : TSX_SCRIPT_TYPES.has(type);
}

function resolveUrl(url: string, base?: string): string {
  return new URL(url, base || document.baseURI).href;
}

async function fetchText(url: string, label = url): Promise<string> {
  const existing = textCache.get(url);
  if (existing) return existing;

  const promise = (async (): Promise<string> => {
    const response = await fetch(url, FETCH_OPTIONS);
    if (!response.ok) throw new Error(`[Typescript] failed to fetch ${label}: ${response.status}`);
    return response.text();
  })();

  textCache.set(url, promise);
  try {
    return await promise;
  } catch (error) {
    textCache.delete(url);
    throw error;
  }
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

function mergeConfig(base: TsnowConfig, user: UserTsConfig): TsnowConfig {
  const compilerOptions = user.compilerOptions ?? {};

  if (compilerOptions.erasableSyntaxOnly === false) {
    console.warn(
      '[Typescript] Warning: "erasableSyntaxOnly: false" in tsconfig is not supported. ' +
        'typescript-runtime always enforces erasable syntax only. ' +
        'Non-erasable syntax (enum, namespace, decorators) will be rejected.',
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
    jsxImportSource: compilerOptions.jsxImportSource ?? base.jsxImportSource,
    jsxRuntime,
    sourceMaps: compilerOptions.sourceMap ?? base.sourceMaps,
    scriptType: user.scriptType ?? base.scriptType,
  };
}

function getJsxConfig(
  config: TsnowConfig,
): { runtime: JsxRuntime; factory?: string; fragmentFactory?: string; importSource?: string } | null {
  if (config.jsxRuntime === 'classic' && config.jsxFactory && config.jsxFragmentFactory) {
    return { runtime: 'classic', factory: config.jsxFactory, fragmentFactory: config.jsxFragmentFactory };
  }
  if (config.jsxRuntime === 'automatic' && config.jsxImportSource) {
    return { runtime: 'automatic', importSource: config.jsxImportSource };
  }
  return null;
}

async function loadConfigElement(element: Element): Promise<void> {
  if (seenConfigs.has(element)) return;
  seenConfigs.add(element);
  const src = element.getAttribute('src');
  if (!src) return;
  const loaded = JSON.parse(await fetchText(resolveUrl(src), `tsconfig ${src}`)) as UserTsConfig;
  currentConfig = mergeConfig(currentConfig, loaded);
}

function scheduleConfigLoad(element: Element): void {
  configReady = configReady
    .then(() => loadConfigElement(element))
    .catch((error: unknown) => {
      console.error('[Typescript] failed to load tsconfig', error);
    });
}

function blockTsScript(script: HTMLScriptElement): void {
  if (!script.hasAttribute('type') && TS_SRC_RE.test(script.getAttribute('src') ?? '')) {
    script.setAttribute('type', 'text/plain');
  }
}

async function readScript(script: HTMLScriptElement): Promise<{ code: string; filename: string; baseUrl: string }> {
  const src = script.getAttribute('src');
  if (!src) {
    const ext = isTsxScript(script) ? 'tsx' : 'ts';
    const id = ++inlineScriptId;
    return { code: script.textContent ?? '', filename: `ts://inline/${id}.${ext}`, baseUrl: document.URL };
  }
  const url = resolveUrl(src);
  return { code: await fetchText(url, src), filename: url, baseUrl: url };
}

function removeTypeOnlyNodes(ast: t.File, filename: string): void {
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
    ImportDeclaration(path) {
      if (path.node.importKind === 'type') {
        path.remove();
        return;
      }
      path.node.specifiers = path.node.specifiers.filter((specifier) => {
        return !t.isImportSpecifier(specifier) || specifier.importKind !== 'type';
      });
      if (path.node.specifiers.length === 0 && path.node.importKind !== 'value') {
        path.remove();
      }
    },
    ExportNamedDeclaration(path) {
      if (path.node.exportKind === 'type') {
        path.remove();
      }
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
    TSNonNullExpression(path) {
      path.replaceWith(path.node.expression);
    },
    TSInstantiationExpression(path) {
      path.replaceWith(path.node.expression);
    },
    TSParameterProperty(path) {
      const parameter = path.node.parameter;
      if (t.isIdentifier(parameter) || t.isAssignmentPattern(parameter)) {
        path.replaceWith(parameter);
      }
    },
    ClassProperty(path) {
      path.node.typeAnnotation = null;
      path.node.definite = null;
    },
    ClassPrivateProperty(path) {
      path.node.typeAnnotation = null;
      path.node.definite = null;
    },
    Function(path: NodePath<t.Function>) {
      path.node.returnType = null;
      path.node.typeParameters = null;
      for (const parameter of path.node.params) {
        if (t.isIdentifier(parameter)) {
          parameter.typeAnnotation = null;
          parameter.optional = false;
        }
      }
    },
  });
}

type ActiveJsxConfig = NonNullable<ReturnType<typeof getJsxConfig>>;

function transform(code: string, filename: string, tsx: boolean, config: TsnowConfig): string {
  const jsxConfig = tsx ? getJsxConfig(config) : null;
  if (tsx && !jsxConfig) {
    throw new Error(`[Typescript] TSX/JSX requires explicit jsx runtime config in tsconfig: ${filename}`);
  }

  const ast = parse(code, {
    sourceFilename: filename,
    sourceType: config.scriptType === 'module' ? 'module' : 'unambiguous',
    plugins: tsx ? [...BASE_PARSER_PLUGINS, 'jsx'] : BASE_PARSER_PLUGINS,
  });

  removeTypeOnlyNodes(ast, filename);

  if (jsxConfig) {
    const jsxVisitor = buildJsxVisitor(jsxConfig);
    traverse(ast, jsxVisitor);
  }

  let metaCount = 0;
  const sourceUrl = typeof document !== 'undefined' ? resolveUrl(filename, document.URL) : filename;
  traverse(ast, {
    MetaProperty(path) {
      if (t.isMetaProperty(path.node) && path.node.meta.name === 'import' && path.node.property.name === 'meta') {
        metaCount++;
        path.replaceWith(t.identifier('__import_meta'));
      }
    },
    Program: {
      exit(path) {
        if (metaCount === 0) return;
        path.unshiftContainer(
          'body',
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('__import_meta'),
              t.objectExpression([
                t.objectProperty(t.identifier('url'), t.stringLiteral(sourceUrl)),
                t.objectProperty(
                  t.identifier('resolve'),
                  t.arrowFunctionExpression(
                    [t.identifier('specifier')],
                    t.callExpression(t.memberExpression(t.identifier('__ts'), t.identifier('resolve')), [
                      t.stringLiteral(sourceUrl),
                      t.identifier('specifier'),
                    ]),
                  ),
                ),
              ]),
            ),
          ]),
        );
      },
    },
  });

  const output = generate(ast, {
    sourceMaps: config.sourceMaps,
    sourceFileName: filename,
  });

  if (config.sourceMaps && output.map) {
    output.map.sources = [filename];
    output.map.sourcesContent = [code];
    return `${output.code}\n//# sourceMappingURL=${toSourceMapUrl(output.map)}`;
  }

  return output.code;
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

function buildJsxVisitor(config: ActiveJsxConfig) {
  return {
    Program(path: NodePath<t.Program>) {
      if (config.runtime !== 'automatic') return;
      const importPath = `${config.importSource}/jsx-runtime`;
      const hasRuntimeImport = path.node.body.some(
        (node) => t.isImportDeclaration(node) && node.source.value === importPath,
      );
      if (!hasRuntimeImport) {
        path.unshiftContainer(
          'body',
          t.importDeclaration(
            [
              t.importSpecifier(t.identifier('jsx'), t.identifier('jsx')),
              t.importSpecifier(t.identifier('jsxs'), t.identifier('jsxs')),
            ],
            t.stringLiteral(importPath),
          ),
        );
      }
    },
    JSXElement(path: NodePath<t.JSXElement>) {
      path.replaceWith(convertJsxElement(path.node, config));
    },
    JSXFragment(path: NodePath<t.JSXFragment>) {
      path.replaceWith(convertJsxElement(path.node, config));
    },
  };
}

/* ─── Runtime (injected once into global scope) ─── */

function initRuntime(): void {
  if ((window as any).__ts) return;

  async function dynamicImport(specifier: string, baseUrl: string): Promise<unknown> {
    const url = resolveUrl(specifier, baseUrl);
    if (TS_EXT_RE.test(url)) {
      return import(await resolveFile(url));
    }
    return import(url);
  }

  async function resolveMeta(baseUrl: string, specifier: string): Promise<string> {
    const url = resolveUrl(specifier, baseUrl);
    if (TS_EXT_RE.test(url)) {
      return resolveFile(url);
    }
    return url;
  }

  (window as any).__ts = { import: dynamicImport, resolve: resolveMeta };
}

/* ─── Import resolution (blob URL graph) ─── */

const TS_EXT_RE = /\.(?:ts|mts|cts|tsx|mtsx|ctsx)(?:[?#].*)?$/i;

interface ImportRef {
  full: string;
  replacement: string;
}

const blobCache = new Map<string, string>();
const pendingFiles = new Map<string, Promise<string>>();

function hasImportOrExport(code: string): boolean {
  return /\b(?:import|export)\s/.test(code);
}

async function transformFile(url: string, chain?: Set<string>): Promise<string> {
  const code = await fetchText(url);
  return resolveImports(transform(code, url, TSX_SRC_RE.test(url), currentConfig), url, chain);
}

async function resolveImportSpecifier(specifier: string, baseUrl: string, chain?: Set<string>): Promise<string> {
  return resolveFile(resolveUrl(specifier, baseUrl), chain);
}

async function resolveFile(url: string, chain?: Set<string>): Promise<string> {
  if (blobCache.has(url)) return blobCache.get(url)!;

  const currentChain = new Set(chain);
  if (currentChain.has(url)) {
    throw new Error(`[Typescript] circular dependency detected: ${url}`);
  }
  currentChain.add(url);

  const existing = pendingFiles.get(url);
  if (existing) return existing;

  const promise = (async (): Promise<string> => {
    const blobUrl = toBlobUrl(await transformFile(url, currentChain));
    blobCache.set(url, blobUrl);
    return blobUrl;
  })();

  pendingFiles.set(url, promise);
  try {
    return await promise;
  } finally {
    pendingFiles.delete(url);
  }
}

async function resolveImports(code: string, baseUrl: string, chain?: Set<string>): Promise<string> {
  const replacements: ImportRef[] = [];
  const mapComment = code.match(/\n\/\/# sourceMappingURL=[^\n]*$/);
  const scanLimit = mapComment?.index ?? code.length;
  const scanCode = code.slice(0, scanLimit);

  const staticRe =
    /((?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"])(\.\.?\/[^'"]+\.(?:ts|mts|cts|tsx|mtsx|ctsx))(['"])/gi;
  let match: RegExpExecArray | null;
  while ((match = staticRe.exec(scanCode)) !== null) {
    const blobUrl = await resolveImportSpecifier(match[2], baseUrl, chain);
    replacements.push({ full: match[0], replacement: `${match[1]}${blobUrl}${match[3]}` });
  }

  const dynamicRe = /import\s*\(/g;
  while ((match = dynamicRe.exec(scanCode)) !== null) {
    const start = match.index;
    let depth = 1;
    let end = -1;
    for (let i = match.index + match[0].length; i < scanCode.length; i++) {
      if (scanCode[i] === '(') depth++;
      if (scanCode[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) continue;

    const fullExpr = scanCode.slice(start, end);
    const inner = fullExpr.slice(7, -1).trim();

    const literalQuote =
      inner.length >= 2 && inner[0] === inner[inner.length - 1] && (inner[0] === "'" || inner[0] === '"');
    if (literalQuote) {
      const specifier = inner.slice(1, -1);
      if (TS_EXT_RE.test(specifier)) {
        const blobUrl = await resolveImportSpecifier(specifier, baseUrl, chain);
        replacements.push({ full: fullExpr, replacement: `import(${JSON.stringify(blobUrl)})` });
        continue;
      }
    }
    replacements.push({ full: fullExpr, replacement: `__ts.import(${inner}, ${JSON.stringify(baseUrl)})` });
  }

  replacements.sort((a, b) => b.full.length - a.full.length);
  let result = code;
  for (const { full, replacement } of replacements) {
    result = result.replace(full, replacement);
  }
  return result;
}

/* ─── Script injection ─── */

async function injectScript(
  source: string,
  original: HTMLScriptElement,
  baseUrl: string,
  config: TsnowConfig,
): Promise<void> {
  const parent = original.parentNode;
  if (!parent) return;

  const resolved = await resolveImports(source, baseUrl);

  const script = document.createElement('script');
  script.textContent = resolved;

  const isModule = config.scriptType === 'module' || hasImportOrExport(resolved);
  script.type = isModule ? 'module' : 'text/javascript';

  const requestedType = original.getAttribute('data-typescript-runtime-type');
  if (requestedType) {
    script.type = requestedType;
  }

  for (const { name, value } of Array.from(original.attributes)) {
    if (!['src', 'type'].includes(name) && name.startsWith('data-')) {
      script.setAttribute(name, value);
    }
  }

  parent.replaceChild(script, original);
}

async function processScript(script: HTMLScriptElement): Promise<void> {
  if (seenScripts.has(script)) return;
  seenScripts.add(script);

  await configReady;

  try {
    const { code, filename, baseUrl } = await readScript(script);
    const output = transform(code, filename, isTsxScript(script), currentConfig);
    await injectScript(output, script, baseUrl, currentConfig);
  } catch (error) {
    console.error('[Typescript] failed to process script', script, error);
  }
}

function visitScript(script: HTMLScriptElement): void {
  if (!isTsScript(script)) return;
  blockTsScript(script);
  void processScript(script);
}

function scan(root: ParentNode): void {
  if (root instanceof Element && root.localName.toLowerCase() === 'tsconfig') {
    scheduleConfigLoad(root);
  }
  if (root instanceof HTMLScriptElement) {
    visitScript(root);
  }
  root.querySelectorAll?.('tsconfig[src]').forEach(scheduleConfigLoad);
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
