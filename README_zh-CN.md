# typescript-runtime

[English](./README.md) | 简体中文

在浏览器中直接运行小型 TypeScript 和 TSX 脚本。

`typescript-runtime` 适合 demo、示例、原型和本地实验。它会在浏览器中转换 TypeScript，然后把普通 JavaScript 脚本注入回页面。

## 使用

在 TypeScript 脚本之前加载 `typescript-runtime`（添加 `raw` 属性以防止库被自身处理——见下方 [`raw` 属性](#raw-属性)）：

```html
<script src="https://cdn.jsdelivr.net/npm/@furryr/typescript-runtime@latest/dist/typescript-runtime.global.js" raw></script>

<script type="text/typescript">
  const message: string = 'Hello from TypeScript';
  document.body.append(message);
</script>
```

也可以加载外部文件：

```html
<script src="https://cdn.jsdelivr.net/npm/@furryr/typescript-runtime@latest/dist/typescript-runtime.global.js" raw></script>
<script type="text/typescript" src="./app.ts"></script>
```

支持的脚本标记：

- `type="text/typescript"`
- `type="application/typescript"`
- `type="text/ts"`
- `type="application/ts"`
- `type="text/typescript-tsx"`
- `type="application/typescript-tsx"`
- `src` 以 `.ts`、`.mts`、`.cts`、`.tsx`、`.mtsx` 或 `.ctsx` 结尾
- `src` 以 `.js`、`.mjs`、`.cjs`、`.jsx`、`.mjsx` 或 `.cjsx` 结尾（导入解析）

### `raw` 属性

带有 `raw` 属性的 `<script>` 会被运行时跳过。请给库自身的脚本加上 `raw`，防止它被再次处理：

```html
<script src="https://cdn.jsdelivr.net/npm/@furryr/typescript-runtime@latest/dist/typescript-runtime.global.js" raw></script>
```

对于任何你不想被处理的第三方脚本，也可以用此属性。

外部脚本通过 `fetch` 加载，因此会受到浏览器 CORS 规则限制。

## 导入

支持 TypeScript 文件之间的相对导入：

```ts
import { greet } from './greet.ts';

greet('world');
```

也支持动态导入：

```ts
const mod = await import('./greet.ts');
```

## 配置

在运行时 script 标签上添加 `tsconfig` 属性：

```html
<script tsconfig="./tsconfig.browser.json" src="https://cdn.jsdelivr.net/npm/@furryr/typescript-runtime@latest/dist/typescript-runtime.global.js" raw></script>
<script type="text/typescript" src="./app.ts"></script>
```

示例：

```json
{
  "compilerOptions": {
    "sourceMap": true
  },
  "scriptType": "module"
}
```

默认值：

```json
{
  "compilerOptions": {
    "sourceMap": true
  },
  "scriptType": "module"
}
```

## TSX / JSX

默认不启用 TSX/JSX。必须显式提供 JSX runtime 配置。

Classic JSX 示例：

```json
{
  "compilerOptions": {
    "jsx": "react",
    "jsxFactory": "window.jsx",
    "jsxFragmentFactory": "window.Fragment"
  }
}
```

然后使用 `type="text/typescript-tsx"` 或 `.tsx` 文件：

```html
<script type="text/typescript-tsx">
  const el = <div>Hello JSX</div>;
</script>
```

`typescript-runtime` 不提供 JSX runtime。你需要自己提供 `window.jsx`、React 或其他 runtime。
使用 automatic JSX（`"jsx": "react-jsx"`）时，请在源码中自行从 runtime 导入 `jsx`/`jsxs`；`typescript-runtime` 不会自动注入 JSX runtime import。

## Source Map

启用 `compilerOptions.sourceMap` 后，转换后的脚本会包含内联的 `data:` source map。

外部文件会映射回原始导入路径，例如 `/example/greet.ts`。内联脚本会显示为类似 `ts://inline/1.ts` 的虚拟文件。

## 示例

```sh
pnpm install
pnpm build
pnpm example
```

打开 `http://127.0.0.1:8080/example/`。

## 说明

`typescript-runtime` 不是生产环境 bundler。它面向开发、demo 和轻量浏览器实验。
