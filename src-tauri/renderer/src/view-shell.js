/**
 * Shared static view markup. Each view receives its own DOM nodes before handlers bind.
 * Only repository-owned templates are cloned; no task/user content is interpreted here.
 */
export function mountViewTemplates(root = document) {
  for (const slot of root.querySelectorAll('[data-view-template]')) {
    const id = slot.getAttribute('data-view-template');
    const template = root.querySelector('#' + id);
    if (!(template instanceof HTMLTemplateElement)) {
      throw new Error('Shared view template is missing: ' + id);
    }
    slot.replaceWith(template.content.cloneNode(true));
  }
}
