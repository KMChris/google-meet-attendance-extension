const installed = new WeakSet();
const states = new WeakMap();

const FOCUSABLE = [
  '[autofocus]',
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/** Install backdrop dismissal and focus restoration once for a native dialog. */
export function installDialog(dialog) {
  if (!dialog || installed.has(dialog)) return dialog;
  installed.add(dialog);
  states.set(dialog, { opener: null });

  dialog.addEventListener('click', event => {
    if (event.target === dialog && dialog.open) dialog.close();
  });
  dialog.addEventListener('close', () => {
    const state = states.get(dialog);
    const opener = state && state.opener;
    if (state) state.opener = null;
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
  });
  return dialog;
}

/** Open a native modal dialog, remember its opener, and place focus deliberately. */
export function openDialog(dialog, { opener, initialFocus } = {}) {
  installDialog(dialog);
  const state = states.get(dialog);
  state.opener = opener === undefined && typeof document !== 'undefined'
    ? document.activeElement
    : opener;
  if (!dialog.open) dialog.showModal();

  const target = initialFocus || (typeof dialog.querySelector === 'function' && dialog.querySelector(FOCUSABLE));
  if (target && typeof target.focus === 'function') target.focus();
  return dialog;
}
