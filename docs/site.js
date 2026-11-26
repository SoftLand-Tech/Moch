(() => {
  'use strict';

  const root = document.documentElement;
  root.classList.add('js');

  const BUILD = Object.freeze({
    versionName: '1.0.53-beta.3',
    versionCode: 58,
  });

  root.querySelectorAll('[data-version]').forEach((node) => {
    node.textContent = BUILD.versionName;
  });
  root.querySelectorAll('[data-version-code]').forEach((node) => {
    node.textContent = String(BUILD.versionCode);
  });
  root.querySelectorAll('a[href="/Moch.apk"]').forEach((link) => {
    link.setAttribute('download', '');
    link.dataset.build = `${BUILD.versionName} (${BUILD.versionCode})`;
  });
  root.querySelectorAll('[data-year]').forEach((node) => {
    node.textContent = String(new Date().getFullYear());
  });

  const navToggle = document.querySelector('[data-nav-toggle]');
  if (navToggle) {
    navToggle.hidden = false;
    const header = navToggle.closest('.site-header');
    const nav = document.getElementById(navToggle.getAttribute('aria-controls'));
    let menuOpen = false;

    const setMenu = (open, returnFocus = false) => {
      menuOpen = open;
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      nav.dataset.open = String(open);
      if (!open && returnFocus) navToggle.focus();
    };

    navToggle.addEventListener('click', () => setMenu(!menuOpen));
    navToggle.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMenu(true);
        const firstLink = nav.querySelector('a');
        if (firstLink) firstLink.focus();
      }
    });

    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) setMenu(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menuOpen) {
        event.preventDefault();
        setMenu(false, true);
      }
    });

    document.addEventListener('pointerdown', (event) => {
      if (menuOpen && header && !header.contains(event.target)) setMenu(false);
    });

    const desktopMenu = window.matchMedia('(min-width: 900px)');
    const handleDesktop = (event) => {
      if (event.matches) setMenu(false);
    };
    if (desktopMenu.addEventListener) desktopMenu.addEventListener('change', handleDesktop);
    else desktopMenu.addListener(handleDesktop);
  }

  let copyStatus = document.querySelector('[data-copy-status]');
  if (!copyStatus) {
    copyStatus = document.createElement('span');
    copyStatus.className = 'sr-only';
    copyStatus.setAttribute('role', 'status');
    copyStatus.setAttribute('aria-live', 'polite');
    copyStatus.setAttribute('data-copy-status', '');
    document.body.appendChild(copyStatus);
  }

  const fallbackCopy = (text) => {
    const previousFocus = document.activeElement;
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.setAttribute('aria-hidden', 'true');
    field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(field);
    field.focus();
    field.select();
    field.setSelectionRange(0, field.value.length);
    let copied = false;
    try {
      copied = Boolean(document.execCommand('copy'));
    } catch {
      copied = false;
    }
    field.remove();
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    return copied;
  };

  const showCopyFallback = (button, text) => {
    let field = button.parentElement.querySelector('.copy-fallback');
    if (!field) {
      field = document.createElement('input');
      field.type = 'text';
      field.readOnly = true;
      field.className = 'copy-fallback';
      field.setAttribute('aria-label', 'Copy value');
      button.after(field);
    }
    field.value = text;
    field.focus();
    field.select();
    return true;
  };

  const writeClipboard = async (text) => {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall through to the selection-based path for blocked clipboard permissions.
      }
    }
    return fallbackCopy(text);
  };

  const copyTimers = new WeakMap();
  document.querySelectorAll('[data-copy], [data-copy-label]').forEach((button) => {
    button.disabled = false;
    const labelNode = button.querySelector('span') || button;
    const originalLabel = button.dataset.copyLabel || labelNode.textContent.trim();
    button.addEventListener('click', async () => {
      const targetId = button.dataset.copyTarget;
      const target = targetId ? document.getElementById(targetId) : null;
      const localCode = button.parentElement.querySelector('code, .copy-value');
      const text = button.dataset.copy || (target && target.textContent) || (localCode && localCode.textContent) || '';
      if (!text) {
        labelNode.textContent = 'Nothing to copy';
        copyStatus.textContent = 'Nothing to copy.';
        return;
      }

      const copied = await writeClipboard(text.trim());
      if (copied) {
        const previous = button.parentElement.querySelector('.copy-fallback');
        if (previous) previous.remove();
      }
      const selected = copied ? false : showCopyFallback(button, text.trim());
      window.clearTimeout(copyTimers.get(button));
      labelNode.textContent = copied ? 'Copied' : selected ? 'Select & copy' : 'Copy failed';
      copyStatus.textContent = copied
        ? 'Copied to clipboard.'
        : selected
          ? 'Clipboard blocked. A copy field is ready for manual copying.'
          : 'Clipboard blocked. Select the value and copy it manually.';
      copyTimers.set(button, window.setTimeout(() => {
        labelNode.textContent = originalLabel;
      }, 2400));
    });
  });

  const proof = document.querySelector('[data-proof]');
  const stepButtons = Array.from(document.querySelectorAll('[data-step-button]'));
  const stepContent = {
    '1': {
      title: 'The APK lands on your phone.',
      copy: 'Download the current beta, allow Android to install it, and open Moch. Use the current CI beta APK: Expo Go does not include the native embedded-runtime bridge.',
    },
    '2': {
      title: 'Moch prepares the workspace.',
      copy: 'Hermes can run without Linux. Install the Ubuntu 24.04 guest for OpenCode, a terminal or Linux tools; you can skip it for Hermes-only use.',
    },
    '3': {
      title: 'You choose the brain that answers.',
      copy: 'Hermes is the default, full-feature thinker. OpenCode is optional and runs inside Moch Linux. Existing chats keep the thinker they were created with.',
    },
    '4': {
      title: 'You connect the model provider.',
      copy: 'Choose a hosted provider, OpenCode’s free hosted models, or a local model endpoint. Hosted inference uses the internet; no local model weights are bundled.',
    },
    '5': {
      title: 'The agent gets to work on this phone.',
      copy: 'Chat, projects, terminal and browser tools use the on-device control plane. Network use depends on the model and tools you choose.',
    },
  };

  if (proof && stepButtons.length) {
    stepButtons.forEach((button) => { button.disabled = false; });
    const title = document.getElementById('proof-step-title');
    const copy = document.getElementById('proof-step-copy');

    const activateStep = (button, moveFocus = false) => {
      const step = button.dataset.stepButton;
      const content = stepContent[step];
      if (!content) return;
      stepButtons.forEach((item) => {
        const active = item === button;
        item.setAttribute('aria-pressed', String(active));
        item.classList.toggle('is-active', active);
      });
      proof.dataset.step = step;
      if (title) title.textContent = content.title;
      if (copy) copy.textContent = content.copy;
      if (moveFocus) button.focus();
    };

    stepButtons.forEach((button) => {
      button.addEventListener('click', () => activateStep(button));
      button.addEventListener('keydown', (event) => {
        const current = stepButtons.indexOf(button);
        let next = current;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % stepButtons.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + stepButtons.length) % stepButtons.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = stepButtons.length - 1;
        else return;
        event.preventDefault();
        activateStep(stepButtons[next], true);
      });
    });
  }

  const modelButtons = Array.from(document.querySelectorAll('[data-model-button]'));
  if (proof && modelButtons.length) {
    modelButtons.forEach((button) => { button.disabled = false; });
    const modelModes = {
      hosted: {
        boundary: 'Hosted · internet',
        node: 'Hosted provider',
        phone: 'Hosted model',
      },
      local: {
        boundary: 'Local · on device',
        node: 'Local endpoint',
        phone: 'Local model',
      },
    };

    const setModel = (mode) => {
      const content = modelModes[mode];
      if (!content) return;
      modelButtons.forEach((button) => {
        const active = button.dataset.modelButton === mode;
        button.setAttribute('aria-pressed', String(active));
        button.classList.toggle('is-active', active);
      });
      proof.dataset.model = mode;
      const boundary = document.getElementById('model-boundary-label');
      const node = document.getElementById('model-node-copy');
      const phone = document.getElementById('phone-model-label');
      if (boundary) boundary.textContent = content.boundary;
      if (node) node.textContent = content.node;
      if (phone) phone.textContent = content.phone;
    };

    modelButtons.forEach((button) => {
      button.addEventListener('click', () => setModel(button.dataset.modelButton));
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const current = modelButtons.indexOf(button);
        const next = (current + 1) % modelButtons.length;
        setModel(modelButtons[next].dataset.modelButton);
        modelButtons[next].focus();
      });
    });
  }

  document.querySelectorAll('[data-faq-group]').forEach((group) => {
    const items = Array.from(group.querySelectorAll('details'));
    items.forEach((item) => {
      item.addEventListener('toggle', () => {
        if (!item.open) return;
        items.forEach((other) => {
          if (other !== item) other.open = false;
        });
      });
    });
  });

  const reveal = () => root.classList.add('motion-ready');
  if (window.requestAnimationFrame) {
    window.requestAnimationFrame(() => window.requestAnimationFrame(reveal));
  } else {
    reveal();
  }
})();
