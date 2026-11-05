// Independent navigation/presentation behavior — no changes to ticket or Firebase data.
(() => {
  'use strict';
  const app = document.getElementById('app');
  const toggle = document.getElementById('mobileMenuBtn');
  const backdrop = document.getElementById('sidebarBackdrop');
  const links = [...document.querySelectorAll('.sidebar-nav a[data-section]')];
  if (!app || !toggle || !backdrop) return;

  function closeMenu(restoreFocus = false) {
    if (!app.classList.contains('sidebar-open')) return;
    app.classList.remove('sidebar-open');
    backdrop.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Menyunu aç');
    if (restoreFocus) toggle.focus();
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
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenu(true);
    if (e.key === 'Tab' && app.classList.contains('sidebar-open')) {
      const sidebar = document.getElementById('dashboardSidebar');
      const controls = [...sidebar.querySelectorAll('a[href],button:not([disabled])')];
      if (!controls.length) return;
      if (e.shiftKey && document.activeElement === controls[0]) {e.preventDefault(); controls[controls.length - 1].focus();}
      else if (!e.shiftKey && document.activeElement === controls[controls.length - 1]) {e.preventDefault(); controls[0].focus();}
    }
  });
  for (const a of links) a.addEventListener('click', () => {
    links.forEach(link => {
      const current = link === a;
      link.classList.toggle('is-active', current);
      if (current) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    closeMenu();
  });
  document.getElementById('logoutBtn')?.addEventListener('click', () => closeMenu());
  const mobile = window.matchMedia('(max-width:800px)');
  if (mobile.addEventListener) mobile.addEventListener('change', () => closeMenu());

  // Keep visual navigation in step with scrolling; never affects scan state.
  if ('IntersectionObserver' in window) {
    const ids = links.map(a => a.dataset.section);
    const sections = ids.map(id => document.getElementById(id)).filter(Boolean);
    const observer = new IntersectionObserver(entries => {
      if (app.classList.contains('sidebar-open')) return;
      const seen = entries.filter(entry => entry.isIntersecting).sort((a,b) => b.intersectionRatio - a.intersectionRatio);
      if (!seen.length) return;
      const sectionId = seen[0].target.id;
      links.forEach(a => {
        const current = a.dataset.section === sectionId;
        a.classList.toggle('is-active',current);
        if (current) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
      });
    }, {rootMargin:'-85px 0px -45% 0px',threshold:[0,.2,.5,.8]});
    sections.forEach(section => observer.observe(section));
  }
})();
