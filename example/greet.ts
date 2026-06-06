export function greet(target: string): void {
  const el = document.createElement('p');
  el.textContent = `Hello, ${target}! (imported from greet.ts)`;
  document.getElementById('output')!.appendChild(el);
}

export function inspectSourceMap(from: string): void {
  console.info('[Typescript example] source-mapped greet.ts call from:', from);
  // eslint-disable-next-line no-debugger
  debugger;
}

console.log('[Typescript example] greet Side effect');
