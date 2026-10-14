import { getLocale } from './i18n.js';

export function recurrenceRuleChanged(before = {}, after = {}) {
  if (before.native || after.native) {
    const a = before.native || {};
    const b = after.native || {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return Boolean(before.native) !== Boolean(after.native)
      || [...keys].some(key => a[key] !== b[key]);
  }
  return (before.type || 'none') !== (after.type || 'none')
    || (before.until || '') !== (after.until || '');
}

function scopeContent(date, changed) {
  const ja = getLocale().startsWith('ja');
  const text = (jp, en) => ja ? jp : en;
  const items = [];
  if (!changed) {
    items.push(['single', text('この予定だけ', 'Only this occurrence'), date]);
  }
  items.push(
    ['future', text('この予定と以降の予定', 'This and following occurrences'),
      text(`${date} から先。過去の予定は変えません。`, `${date} onward. Earlier occurrences stay unchanged.`)],
    ['series', text('過去も含むすべて', 'All occurrences, including past ones'),
      text('この繰り返しに含まれるすべての予定', 'Every occurrence in this series')],
  );
  return {
    title: text('どの日の予定を変更しますか？', 'Which occurrences should change?'),
    note: changed
      ? text('繰り返しルールを変更しています。変更する範囲を選んでください。', 'The recurrence rule changed. Choose the affected occurrences.')
      : text('選んだ範囲に、今回の変更を適用します。', 'Apply your changes to the selected occurrences.'),
    items,
    selected: changed ? 'future' : 'single',
    backLabel: text('入力に戻る', 'Back to editing'),
    confirmLabel: text('この範囲で保存', 'Save these occurrences'),
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scopeChoice([value, title, description], selected) {
  const label = element('label', 'saveScopeChoice');
  const radio = element('input');
  radio.type = 'radio';
  radio.name = 'saveScope';
  radio.value = value;
  radio.checked = value === selected;
  const words = element('span');
  words.append(element('strong', '', title), element('small', '', description));
  label.append(radio, words);
  return label;
}

function scopeDialog(content) {
  const dialog = element('dialog', 'saveScopeDialog');
  dialog.dataset.saveScope = '';
  dialog.setAttribute('aria-label', content.title);
  const heading = element('h2', '', content.title);
  const note = element('p', '', content.note);
  const choices = element('fieldset', 'saveScopeChoices');
  choices.setAttribute('aria-label', content.title);
  for (const item of content.items) {
    choices.append(scopeChoice(item, content.selected));
  }
  const footer = element('footer');
  const back = element('button');
  const confirm = element('button');
  back.type = confirm.type = 'button';
  back.className = 'btn';
  confirm.className = 'btn primary';
  back.dataset.scopeBack = '';
  confirm.dataset.scopeConfirm = '';
  back.textContent = content.backLabel;
  confirm.textContent = content.confirmLabel;
  footer.append(back, confirm);
  dialog.append(heading, note, choices, footer);
  return { dialog, back, confirm };
}

function waitForScope(editor, { dialog, back, confirm }) {
  document.body.append(dialog);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      editor.removeEventListener('close', onEditorClose);
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const onEditorClose = () => finish(null);
    editor.addEventListener('close', onEditorClose, { once: true });
    back.addEventListener('click', () => finish(null));
    confirm.addEventListener('click', () => finish(dialog.querySelector('input:checked').value));
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      finish(null);
    });
    dialog.showModal();
    dialog.querySelector('input:checked').focus();
  });
}

/** Ask only after validation; cancel never writes or clears the editor draft. */
export function chooseSaveScope(editor, patch) {
  const original = editor._eventOriginal || {};
  const recurring = original.recurrence?.native
    || (original.recurrence?.type && original.recurrence.type !== 'none');
  if (!recurring) return Promise.resolve(patch.recurrence?.native ? 'series' : 'single');

  const changed = recurrenceRuleChanged(original.recurrence, patch.recurrence || original.recurrence);
  const content = scopeContent(original.date || '', changed);
  return waitForScope(editor, scopeDialog(content));
}
