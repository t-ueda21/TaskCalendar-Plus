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
    const content = template.content.cloneNode(true);
    // Shared task forms must keep labels inside their own view's dialog.
    const view = slot.closest('[data-view]')?.dataset.view;
    if (view) {
      const ids = new Map([...content.querySelectorAll('[id]')].map(node => [node.id, `${view}-${node.id}`]));
      for (const node of content.querySelectorAll('[id]')) node.id = ids.get(node.id);
      for (const node of content.querySelectorAll('[for],[aria-labelledby],[aria-describedby]')) {
        for (const attribute of ['for', 'aria-labelledby', 'aria-describedby']) {
          if (node.hasAttribute(attribute)) node.setAttribute(attribute, node.getAttribute(attribute).split(' ').map(id => ids.get(id) || id).join(' '));
        }
      }
    }
    slot.replaceWith(content);
  }
}
