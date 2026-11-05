/* Visual reflections of existing DOM state. No writes to Firebase, no side effects on QR lifecycle. */
(() => {
 'use strict';
 const $ = id => document.getElementById(id);
 const sourceList = $('recentList');
 const email = $('userLabel');
 const stats = ['statTotal','statScanned','statAvailable','statCheckinRate'].map($);
 const targetList = $('sidebarTicketList');
 if (!sourceList || !email || stats.some(el => !el) || !targetList) return;
 const plain = node => node?.textContent?.trim() || '';
 function updateMirror() {
   $('featuredTicketTotal').textContent = plain($('statTotal')) || '—';
   const rate = plain($('statCheckinRate')) || '0%';
   const scanned = Math.min(100,Math.max(0,parseInt(rate,10) || 0));
   const available = 100 - scanned;
   $('visualRate').textContent = rate;
   $('visualScannedBar').style.height = (scanned ? Math.max(scanned,5):0)+'%';
   $('visualAvailableBar').style.height = (available ? Math.max(available,5):0)+'%';
   $('statusVisual').setAttribute('aria-label', `${plain($('statScanned'))} giriş edib; ${plain($('statAvailable'))} giriş gözləyir; giriş faizi ${rate}`);
   $('operatorEmail').textContent = plain(email) || 'Admin hesabı';
 }
 function updateRecent() {
   const rows = [...sourceList.querySelectorAll('.recent-item')].slice(0,4);
   targetList.replaceChildren();
   if (!rows.length) {
     const empty = document.createElement('p'); empty.className='side-no-data';
     empty.textContent = sourceList.querySelector('.empty-list')?.textContent?.trim() || 'Hələ bilet yoxdur.';
     targetList.append(empty);return;
   }
   for (const row of rows) {
     const code = plain(row.querySelector('.recent-code'));
     const sold = row.querySelector('.recent-sold.is-sold') !== null;
     const scanned = plain(row.querySelector('.recent-status')) === 'İstifadə olunub';
     const el = document.createElement('div'); el.className = 'side-ticket-row';
     const badge = document.createElement('div'); badge.className = 'side-ticket-emblem';badge.textContent = 'QR';
     const copy = document.createElement('div');copy.className='side-ticket-copy';
     const title=document.createElement('strong');title.textContent=code;
     const sub=document.createElement('small');sub.textContent=scanned ? 'Giriş təsdiqlənib' : 'QR bilet';
     copy.append(title,sub);
     const state=document.createElement('span');state.className='side-ticket-status'+(sold ? ' sold':'');state.textContent=sold ? 'Sold':'Hazır';
     el.append(badge,copy,state);targetList.append(el);
   }
 }
 let queued=false;
 function schedule(){if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;updateMirror();updateRecent();});}
 // App already owns the underlying Firebase onSnapshot listeners and statistics.
 const observer=new MutationObserver(schedule);
 for(const el of [...stats,email]) observer.observe(el,{childList:true,characterData:true,subtree:true});
 observer.observe(sourceList,{childList:true,subtree:true,characterData:true});
 schedule();
})();
