import { greet, inspectSourceMap } from './greet.ts';

export interface CounterConfig {
  label: string;
  initial: number;
}

export function createCounter(config: CounterConfig): HTMLElement {
  let count = config.initial;

  const container = document.createElement('div');
  container.style.margin = '8px 0';

  const label = document.createElement('span');
  label.textContent = `${config.label}: `;
  container.appendChild(label);

  const display = document.createElement('strong');
  display.textContent = String(count);
  container.appendChild(display);

  const btn = document.createElement('button');
  btn.textContent = '+1';
  btn.style.marginLeft = '8px';
  btn.addEventListener('click', () => {
    count++;
    display.textContent = String(count);
  });
  container.appendChild(btn);

  return container;
}

// Use the imported greet function
greet('world from counter.tsx');
inspectSourceMap('counter.tsx static import');
