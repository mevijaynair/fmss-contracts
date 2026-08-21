// ux.js — UX helpers: loading states, validation, empty states, keyboard shortcuts
import { $ } from './util.js';

// Set button loading state
export function setLoading(btn, isLoading = true) {
  if (!btn) return;
  if (isLoading) {
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

// Form validation helpers
export function showFieldError(inputId, message) {
  const input = $(inputId);
  if (!input) return;

  input.classList.add('error');
  let errorEl = input.nextElementSibling;
  if (!errorEl || !errorEl.classList.contains('form-error')) {
    errorEl = document.createElement('div');
    errorEl.className = 'form-error show';
    input.parentNode.insertBefore(errorEl, input.nextSibling);
  }
  errorEl.textContent = message;
  errorEl.classList.add('show');
}

export function clearFieldError(inputId) {
  const input = $(inputId);
  if (!input) return;

  input.classList.remove('error');
  const errorEl = input.nextElementSibling;
  if (errorEl && errorEl.classList.contains('form-error')) {
    errorEl.classList.remove('show');
  }
}

export function clearAllFieldErrors() {
  document.querySelectorAll('input.error, select.error, textarea.error').forEach(el => {
    el.classList.remove('error');
  });
  document.querySelectorAll('.form-error.show').forEach(el => {
    el.classList.remove('show');
  });
}

// Validate email
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Validate required field
export function validateRequired(value, fieldName = 'This field') {
  if (!value || String(value).trim() === '') {
    return `${fieldName} is required`;
  }
  return null;
}

// Empty state renderer
export function emptyState(container, icon, title, description, ctaText = null, ctaClick = null) {
  const html = `
    <div class="empty-state">
      <div class="empty-state-icon">${icon}</div>
      <div class="empty-state-title">${title}</div>
      <div class="empty-state-desc">${description}</div>
      ${ctaText ? `<button class="btn btn-secondary btn-sm" id="empty-cta">${ctaText}</button>` : ''}
    </div>
  `;

  if (typeof container === 'string') {
    container = $(container);
  }
  container.innerHTML = html;

  if (ctaText && ctaClick) {
    const btn = container.querySelector('#empty-cta');
    if (btn) btn.addEventListener('click', ctaClick);
  }
}

// Keyboard shortcut helpers
export function registerShortcut(key, modifiers, callback) {
  const handler = (e) => {
    const hasCtrl = modifiers.includes('ctrl') && e.ctrlKey;
    const hasShift = modifiers.includes('shift') && e.shiftKey;
    const hasAlt = modifiers.includes('alt') && e.altKey;
    const hasCmd = modifiers.includes('cmd') && e.metaKey;

    const hasRequired = modifiers.length === 0 ||
      (modifiers.includes('ctrl') || modifiers.includes('cmd') ? hasCtrl || hasCmd : true) &&
      (modifiers.includes('shift') ? hasShift : true) &&
      (modifiers.includes('alt') ? hasAlt : true);

    if (e.key.toLowerCase() === key.toLowerCase() && hasRequired) {
      e.preventDefault();
      callback();
    }
  };

  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

// Smooth scroll to element
export function scrollToElement(element, options = {}) {
  const defaultOptions = { behavior: 'smooth', block: 'start' };
  if (typeof element === 'string') {
    element = $(element);
  }
  if (element) {
    element.scrollIntoView({ ...defaultOptions, ...options });
  }
}

// Debounce helper
export function debounce(fn, delay = 300) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Format time ago
export function timeAgo(date) {
  const d = new Date(date);
  const now = new Date();
  const seconds = Math.floor((now - d) / 1000);

  const intervals = {
    year: 31536000,
    month: 2592000,
    week: 604800,
    day: 86400,
    hour: 3600,
    minute: 60
  };

  for (const [name, secondsInInterval] of Object.entries(intervals)) {
    const interval = Math.floor(seconds / secondsInInterval);
    if (interval >= 1) {
      return `${interval} ${name}${interval > 1 ? 's' : ''} ago`;
    }
  }
  return 'just now';
}
