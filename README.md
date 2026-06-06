# typescript-runtime

English | [简体中文](./README_zh-CN.md)

Run small TypeScript and TSX scripts directly in the browser.

`typescript-runtime` is useful for demos, examples, prototypes, and local experiments. It transforms TypeScript in the browser and injects normal JavaScript scripts back into the page.

## Usage

Load `typescript-runtime` before your TypeScript scripts:

```html
<script src="./dist/typescript-runtime.global.js"></script>

<script type="text/typescript">
  const message: string = 'Hello from TypeScript';
  document.body.append(message);
</script>
```

External files work too:

```html
<script src="./dist/typescript-runtime.global.js"></script>
<script type="text/typescript" src="./app.ts"></script>
```

Supported script markers:

- `type="text/typescript"`
- `type="application/typescript"`
- `type="text/ts"`
- `type="application/ts"`
- `type="text/typescript-tsx"`
- `type="application/typescript-tsx"`
- `src` ending in `.ts`, `.mts`, `.cts`, `.tsx`, `.mtsx`, or `.ctsx`

External scripts are loaded with `fetch`, so normal browser CORS rules apply.

## Imports

Relative imports between TypeScript files are supported:

```ts
import { greet } from './greet.ts';

greet('world');
```

Dynamic imports are also supported:

```ts
const mod = await import('./greet.ts');
```

## Configuration

Add a `<tsconfig>` element before your TypeScript scripts:

```html
<tsconfig src="./tsconfig.browser.json"></tsconfig>
<script src="./dist/typescript-runtime.global.js"></script>
<script type="text/typescript" src="./app.ts"></script>
```

Example:

```json
{
  "compilerOptions": {
    "sourceMap": true
  },
  "scriptType": "module"
}
```

Defaults:

```json
{
  "compilerOptions": {
    "sourceMap": true
  },
  "scriptType": "module"
}
```

## TSX / JSX

TSX/JSX is disabled unless you provide explicit JSX runtime settings.

Classic JSX example:

```json
{
  "compilerOptions": {
    "jsx": "react",
    "jsxFactory": "__ts.jsx",
    "jsxFragmentFactory": "__ts.Fragment"
  }
}
```

Then use `type="text/typescript-tsx"` or a `.tsx` file:

```html
<script type="text/typescript-tsx">
  const el = <div>Hello JSX</div>;
</script>
```

`typescript-runtime` does not provide a JSX runtime. You must provide `__ts.jsx`, React, or another runtime yourself.

## Source Maps

When `compilerOptions.sourceMap` is enabled, transformed scripts include an inline `data:` source map.

External files map back to their original import paths, such as `/example/greet.ts`. Inline scripts appear as virtual files like `ts://inline/1.ts`.

## Example

```sh
pnpm install
pnpm build
pnpm example
```

Open `http://127.0.0.1:8080/example/`.

## Notes

`typescript-runtime` is not a production bundler. It is intended for development, demos, and lightweight browser experiments.
