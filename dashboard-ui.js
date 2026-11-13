// Navigasiya və mobil menyu: bilet məlumatlarını dəyişmir.
(() => {
  'use strict';
  const app = document.getElementById('app');
  const toggle = document.getElementById('mobileMenuBtn');
  const backdrop = document.getElementById('sidebarBackdrop');
  const sidebar = document.getElementById('dashboardSidebar');
  const links = [...document.querySelectorAll('.sidebar-nav a[data-section]')];
  if (!app || !toggle || !backdrop || !sidebar) return;

  function closeMenu(focusToggle = false) {
    app.classList.remove('sidebar-open');
    backdrop.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Menyunu aç');
    if (focusToggle) toggle.focus();
  }
  function openMenu() {
    app.classList.add('sidebar-open');
    backdrop.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Menyunu bağla');
    links[0]?.focus();
  }
  toggle.addEventListener('click', () => app.classList.contains('sidebar-open') ? closeMenu(true) : openMenu());
  backdrop.addEventListener('click', () => closeMenu(true));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMenu(true);
    if (event.key !== 'Tab' || !app.classList.contains('sidebar-open')) return;
    const controls = [...sidebar.querySelectorAll('a[href],button:not([disabled])')];
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) {
      event.preventDefault(); controls[controls.length - 1].focus();
    } else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) {
      event.preventDefault(); controls[0].focus();
    }
  });
  for (const link of links) link.addEventListener('click', () => {
    links.forEach(a => {
      const active = a === link;
      a.classList.toggle('is-active', active);
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    closeMenu();
  });
  document.getElementById('logoutBtn')?.addEventListener('click', () => closeMenu());
  window.matchMedia('(max-width: 800px)').addEventListener('change', () => closeMenu());
  if ('IntersectionObserver' in window) {
    const sections = links.map(a => document.getElementById(a.dataset.section)).filter(Boolean);
    const observer = new IntersectionObserver(entries => {
      if (app.classList.contains('sidebar-open')) return;
      const visible = entries.filter(entry => entry.isIntersecting).sort((a,b) => b.intersectionRatio - a.intersectionRatio);
      if (!visible.length) return;
      links.forEach(a => {
        const active = a.dataset.section === visible[0].target.id;
        a.classList.toggle('is-active', active);
        if (active) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      });
    }, {rootMargin:'-85px 0px -45% 0px',threshold:[0,.2,.5]});
    sections.forEach(s => observer.observe(s));
  }
})();
