import { t } from './i18n.js';

// One modal at a time, including requests made while a settings dialog is open.
const queue = [];
let active = null;
let sequence = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function enqueue(options) {
  return new Promise(resolve => {
    queue.push({ options, resolve, returnFocus: active?.returnFocus ?? document.activeElement });
    showNext();
  });
}

function showNext() {
  if (active || !queue.length) return;
  const request = queue.shift();
  active = request;
  const options = request.options;
  const id = `app-dialog-${++sequence}`;
  const dialog = element('dialog', 'appDialog');
  dialog.dataset.appDialog = '';
  dialog.dataset.tone = options.danger ? 'danger' : options.tone || 'info';
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.setAttribute('aria-describedby', `${id}-message`);
  const form = element('form', 'appDialogForm');
  form.method = 'dialog';
  const header = element('header', 'appDialogHeader');
  const symbol = element('div', 'appDialogSymbol');
  symbol.setAttribute('aria-hidden', 'true');
  symbol.textContent = options.danger || options.tone === 'error' ? '!' : 'i';
  const title = element('h2', 'appDialogTitle', options.title);
  title.id = `${id}-title`;
  const message = element('p', 'appDialogMessage', options.message);
  message.id = `${id}-message`;
  message.dataset.appDialogMessage = '';
  header.append(symbol, title);
  const content = element('div', 'appDialogContent');
  content.append(message);

  if (options.scope) {
    const choices = element('fieldset', 'appDialogChoices');
    const legend = element('legend', 'srOnly', t('dialog.scope.hint'));
    choices.append(legend);
    for (const value of ['single', 'future', 'series']) {
      const label = element('label', 'appDialogChoice');
      const radio = element('input');
      radio.type = 'radio'; radio.name = 'scope'; radio.value = value;
      radio.dataset.appDialogScope = value; radio.checked = value === 'single';
      const text = element('span', 'appDialogChoiceText');
      text.append(element('strong', '', t(`dialog.scope.${value}`)), element('span', '', t(`dialog.scope.${value}Hint`)));
      label.append(radio, text); choices.append(label);
    }
    content.append(choices);
  }
  const error = element('p', 'appDialogError');
  error.dataset.appDialogError = ''; error.hidden = true; error.setAttribute('role', 'alert');
  const status = element('p', 'appDialogStatus');
  status.hidden = true; status.setAttribute('role', 'status');
  content.append(error, status);
  const footer = element('footer', 'appDialogFooter');
  const cancel = element('button', 'btn', options.cancelLabel || t('common.cancel'));
  cancel.type = 'button'; cancel.dataset.appDialogCancel = '';
  const confirm = element('button', `btn ${options.danger ? 'danger appDialogDestructive' : 'primary'}`, options.confirmLabel);
  confirm.type = 'submit'; confirm.dataset.appDialogConfirm = '';
  if (!options.alert) footer.append(cancel);
  footer.append(confirm);
  form.append(header, content, footer); dialog.append(form); document.body.append(dialog);
  let settled = false;
  let busy = false;

  const finish = value => {
    if (settled || busy) return;
    settled = true;
    dialog.close(); dialog.remove(); active = null;
    if (request.returnFocus?.isConnected && !request.returnFocus.closest('[hidden]')) request.returnFocus.focus({ preventScroll: true });
    request.resolve(value);
    queueMicrotask(showNext);
  };
  const cancelValue = options.scope ? null : options.alert ? undefined : false;
  cancel.addEventListener('click', () => finish(cancelValue));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(cancelValue); });
  dialog.addEventListener('close', () => finish(cancelValue));
  let backdropPress = false;
  const outside = event => {
    const bounds = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
  };
  dialog.addEventListener('pointerdown', event => { backdropPress = outside(event); });
  dialog.addEventListener('click', event => { if (backdropPress && outside(event)) finish(cancelValue); backdropPress = false; });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled)')]
      .filter(node => !node.hidden && (node.type !== 'radio' || node.checked));
    if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || event.isComposing) return;
    const value = options.scope ? form.querySelector('input[name="scope"]:checked').value : options.alert ? undefined : true;
    if (options.onConfirm) {
      busy = true; dialog.setAttribute('aria-busy', 'true'); error.hidden = true;
      for (const control of form.querySelectorAll('button,input')) control.disabled = true;
      status.textContent = t('dialog.working'); status.hidden = false;
      try { await options.onConfirm(value); }
      catch (failure) {
        error.textContent = String(failure?.message ?? failure); error.hidden = false;
        return;
      } finally {
        busy = false; dialog.removeAttribute('aria-busy'); status.hidden = true;
        for (const control of form.querySelectorAll('button,input')) control.disabled = false;
        confirm.focus();
      }
    }
    finish(value);
  });
  dialog.showModal();
  (options.alert ? confirm : cancel).focus({ preventScroll: true });
}

export function showAppAlert(message, { title, tone = 'info' } = {}) {
  return enqueue({ alert: true, message, tone, title: title || t(tone === 'error' ? 'dialog.error' : 'dialog.notice'), confirmLabel: t('common.close') });
}

export function showAppConfirm(message, options = {}) {
  return enqueue({ ...options, message, title: options.title || t('dialog.confirm'), confirmLabel: options.confirmLabel || t('dialog.proceed') });
}

export function chooseRecurrenceScope({ title, message, operation = 'edit', onConfirm } = {}) {
  const danger = operation === 'delete';
  return enqueue({ scope: true, danger, onConfirm, title: title || t(danger ? 'dialog.scope.delete' : 'dialog.scope.edit'), message: message || t('dialog.scope.hint'), confirmLabel: t(danger ? 'dialog.delete' : 'dialog.apply') });
}
