/**
 * Auto-resize a textarea as its content grows.
 * Removes scrollbar and makes it expand downward.
 */
export function autoResize(node: HTMLTextAreaElement) {
  // 读取行高，确保至少能显示一行文字
  const cs = getComputedStyle(node);
  const lineH = parseFloat(cs.lineHeight) || 20;
  const minH = lineH + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 2;

  function resize() {
    node.style.height = 'auto';
    node.style.height = Math.max(node.scrollHeight, minH) + 'px';
  }
  node.addEventListener('input', resize);
  resize();
  return {
    destroy() {
      node.removeEventListener('input', resize);
    }
  };
}
