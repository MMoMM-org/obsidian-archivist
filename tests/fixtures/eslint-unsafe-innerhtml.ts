export function render(el: HTMLElement, content: string): void {
  el.innerHTML = content;  // dynamic RHS — should be flagged
}
