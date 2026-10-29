import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
  setPersistence, browserSessionPersistence, inMemoryPersistence
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocFromServer, collection, query, orderBy,
  onSnapshot, serverTimestamp, runTransaction, getDocsFromServer
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

// QR formatı: TF1|TF-ABCD-EFGH-JKLM|<192-bit token>
// Firestore QR şəkilini (PNG) deyil, dəqiq eyni şəkli yenidən yaradan qrPayload dəyərini saxlayır.
const TICKET_COLLECTION = 'printTickets';
const CHECKIN_COLLECTION = 'printCheckins';
const ADMIN_COLLECTION = 'tfAdmins';
const EVENT_COLLECTION = 'printEvents';
const AUDIT_COLLECTION = 'printAudit';
const LEGACY_EVENT = 'legacy';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 simvol, 0/O və 1/I yoxdur.
const $ = id => document.getElementById(id);

let auth, db;
let currentTicket = null;
let unsubscribeRecent = null;
let unsubscribeAdmissions = null;
let scanner = null;
let scannerActive = false;
let scannerStartNonce = 0;
let scanningNow = false;
function updateCameraView(state) {
  const frame = $('scannerFrame');
  frame.classList.toggle('is-active', state === 'live' || state === 'paused');
  frame.classList.toggle('is-paused', state === 'paused');
  $('cameraStatusText').textContent = state === 'live' ? 'KAMERA AKTİVDİR' :
    state === 'paused' ? 'YOXLANDI' : state === 'loading' ? 'AÇILIR...' : 'KAMERA BAĞLIDIR';
  $('cameraStatus').classList.toggle('camera-status-live', state === 'live');
}

let recentTickets = [];
let allTickets = [];
let allCheckins = [];
let eventId = LEGACY_EVENT;
let eventRecords = [];
let unsubscribeEvents = null;
let sessionUid = null;
let onlineConfirmedAt = 0;
let heartbeatTimer = null;
let connectionBusy = false;
const TICKETS_PER_PAGE = 12;
let registryPage = 1;
const selectedTicketCodes = new Set();
let torchOn = false;
let pendingDeleteCode = null;
let deletingTicket = false;
let pausedForResult = false;
let toastTimeout;
let totalTickets = null;
let checkedInTickets = null;
let ticketsReady = false;
let admissionsReady = false;

function ticketBelongs(d) { return (d.eventId || LEGACY_EVENT) === eventId; }
function admissionBelongs(d) { return (d.eventId || LEGACY_EVENT) === eventId; }
function recalcEventView() {
  recentTickets = allTickets.filter(item => ticketBelongs(item.data));
  const admissions = allCheckins.filter(item => admissionBelongs(item.data));
  totalTickets = ticketsReady && admissionsReady ? recentTickets.length : null;
  checkedInTickets = ticketsReady && admissionsReady ? admissions.length : null;
  updateStats(); renderTicketList(); renderAdmissions(admissions);
}
function updateStats() {
  const ready = Number.isInteger(totalTickets) && Number.isInteger(checkedInTickets);
  const total = ready ? totalTickets : 0;
  const used = ready ? Math.min(checkedInTickets, total) : 0;
  const unused = Math.max(0, total - used);
  const scannedPct = total ? Math.round(used * 100 / total) : 0;
  const activePct = total ? Math.round(unused * 100 / total) : 0;
  $('statTotal').textContent = ready ? total.toLocaleString('az-AZ') : '—';
  $('statScanned').textContent = ready ? used.toLocaleString('az-AZ') : '—';
  $('statAvailable').textContent = ready ? unused.toLocaleString('az-AZ') : '—';
  $('scannedPercent').textContent = scannedPct + '%';
  $('availablePercent').textContent = activePct + '%';
  $('donutTotal').style.setProperty('--progress', total ? '100%' : '0%');
  $('donutScanned').style.setProperty('--progress', scannedPct + '%');
  $('donutAvailable').style.setProperty('--progress', activePct + '%');
  $('donutTotal').setAttribute('aria-label', `${total} yaradılan bilet`);
  $('donutScanned').setAttribute('aria-label', `${used} yoxlanmış bilet, ${scannedPct} faiz`);
  $('donutAvailable').setAttribute('aria-label', `${unused} aktiv bilet, ${activePct} faiz`);
}
function setConnection(state) {
  const text = state === 'ok' ? 'Firestore ilə bağlı' : state === 'down' ? 'Bağlantı yoxdur' : 'Bağlantı yoxlanılır';
  $('connectionText').textContent = text;
  $('connectionStatus').dataset.state = state;
}
async function requireConnection() {
  if (!navigator.onLine) { setConnection('down'); throw new Error('OFFLINE'); }
  if (!auth?.currentUser || !sessionUid) throw new Error('ADMIN_REQUIRED');
  try {
    // Server oxunuşu: cache-dən "uğur" təsdiqi qəbul edilmir.
    const admin = await getDocFromServer(doc(db, ADMIN_COLLECTION, sessionUid));
    if (!admin.exists() || admin.data().active !== true) throw new Error('ADMIN_REQUIRED');
    onlineConfirmedAt = Date.now(); setConnection('ok');
  } catch(error) { setConnection('down'); throw error; }
}
function watchConnection() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    if (connectionBusy || !sessionUid) return;
    connectionBusy = true;
    try { await requireConnection(); } catch { /* status is shown */ }
    finally { connectionBusy = false; }
  }, 45000);
}
function updateEventNotice() {
  const name = eventId === LEGACY_EVENT ? 'Əvvəlki biletlər (TF1)' : eventRecords.find(e => e.id === eventId)?.name || 'Tədbir seçilməyib';
  $('eventNotice').textContent = eventId === LEGACY_EVENT
    ? 'Köhnə biletlər yalnız bu rejimdə keçərlidir. Yeni QR yaratmaq üçün yeni tədbir seçin.'
    : `Seçilən tədbir: ${name}. Generator və QR skaner yalnız bu tədbirin biletləri ilə işləyir.`;
  $('generateBtn').disabled = eventId === LEGACY_EVENT;
}
function setEvent(nextId) {
  if (eventId === nextId) return;
  if (scannerActive || scanner) stopScanner();
  eventId = nextId;
  registryPage = 1; selectedTicketCodes.clear();
  $('ticketSearch').value = '';
  $('ticketStatusFilter').value = 'all';
  clearGeneratedTicket();
  updateEventNotice(); recalcEventView();
}
function subscribeEvents() {
  unsubscribeEvents?.();
  unsubscribeEvents = onSnapshot(collection(db, EVENT_COLLECTION), snap => {
    eventRecords = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.name||'').localeCompare(b.name||'', 'az'));
    const selector = $('eventSelect');
    const original = eventId;
    selector.replaceChildren(new Option('Əvvəlki biletlər (TF1)', LEGACY_EVENT));
    for (const ev of eventRecords) if (ev.status === 'active') selector.add(new Option(ev.name, ev.id));
    if (original !== LEGACY_EVENT && !eventRecords.some(e => e.id === original && e.status === 'active')) eventId = LEGACY_EVENT;
    selector.value = eventId;
    updateEventNotice(); recalcEventView();
  }, err => { $('eventNotice').textContent = friendlyError(err); });
}
async function createEvent(e) {
  e.preventDefault();
  const name = $('eventName').value.trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 80) { $('eventError').textContent = 'Tədbir adı 3–80 simvol olmalıdır.'; return; }
  $('eventError').textContent = '';
  $('saveEventBtn').disabled = true;
  try {
    await requireConnection();
    const id = 'EV-' + Array.from(crypto.getRandomValues(new Uint8Array(10)), v => CODE_CHARS[v % CODE_CHARS.length]).join('');
    await runTransaction(db, async tx => {
      const r = doc(db, EVENT_COLLECTION, id);
      if ((await tx.get(r)).exists()) throw new Error('CODE_COLLISION');
      tx.set(r, { name, status:'active', createdBy:sessionUid, createdAt:serverTimestamp() });
    });
    if (!eventRecords.some(record => record.id === id)) eventRecords.push({ id, name, status:'active' });
    if (!$('eventSelect').querySelector(`option[value="${id}"]`)) $('eventSelect').add(new Option(name, id));
    $('eventSelect').value = id; setEvent(id);
    $('eventDialog').close(); $('eventName').value = '';
    toast('Tədbir yaradıldı. Yeni biletlər bu tədbirə bağlanacaq.');
  } catch (err) { $('eventError').textContent = friendlyError(err); }
  finally { $('saveEventBtn').disabled = false; }
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => $('toast').classList.add('hidden'), 3300);
}
function friendlyError(error) {
  if (error?.message === 'OFFLINE') return 'İnternet/Firestore bağlantısı yoxdur. Giriş təsdiqlənmir.';
  if (error?.message === 'ADMIN_REQUIRED') return 'Aktiv admin icazəsi yoxdur. Yenidən giriş edin.';
  if (error?.message === 'WRONG_EVENT') return 'Bu QR seçilən tədbirə aid deyil. Tədbiri yoxlayın.';
  if (error?.code === 'permission-denied') return 'Firestore icazəsi yoxdur. Rules və admin statusunu yoxlayın.';
  if (error?.code === 'unavailable') return 'Firestore ilə əlaqə qurulmadı. İnterneti yoxlayın.';
  if (error?.code === 'auth/invalid-credential') return 'E-poçt və ya şifrə yanlışdır.';
  if (error?.code === 'auth/operation-not-allowed') return 'Firebase Authentication → Email/Password girişini aktiv edin.';
  return error?.message || 'Xəta baş verdi. Yenidən cəhd edin.';
}
function codeFromCrypto() {
  // 12 * 5 = 60 bit təsadüfi kod; kolliziya Firestore transaksiya ilə yoxlanır.
  const values = new Uint8Array(12);
  crypto.getRandomValues(values);
  const str = Array.from(values, x => CODE_CHARS[x % CODE_CHARS.length]).join('');
  return `TF-${str.slice(0, 4)}-${str.slice(4, 8)}-${str.slice(8)}`;
}
function tokenFromCrypto() {
  const values = new Uint8Array(24); // 192-bit gizli QR token
  crypto.getRandomValues(values);
  return btoa(String.fromCharCode(...values)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function formatDate(ts) {
  if (!ts?.toDate) return 'Sinxronizasiya...';
  return new Intl.DateTimeFormat('az-AZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ts.toDate());
}
function setGenerateLoading(loading) {
  $('generateBtn').disabled = loading;
  $('generateBtn').innerHTML = loading
    ? '<span>Firestore-a yazılır...</span>'
    : '<span class="plus-sign" aria-hidden="true">＋</span> New Generate <span class="arrow" aria-hidden="true">↗</span>';
}
function clearGeneratedTicket() {
  currentTicket = null;
  $('ticketNumber').textContent = 'TF-••••-••••-••••';
  $('ticketMeta').textContent = 'Generasiya etdikdən sonra unikal kod burada görünəcək.';
  $('qrcode').innerHTML = '';
  $('qrEmpty').classList.remove('hidden');
  $('ticketState').textContent = 'HAZIR DEYİL';
  $('ticketState').className = 'chip chip-muted';
  $('copyBtn').disabled = true;
  $('downloadBtn').disabled = true;
}
function displayTicket(data) {
  currentTicket = data;
  $('ticketNumber').textContent = data.code;
  $('ticketMeta').textContent = data.used
    ? 'Bu bilet artıq istifadə olunub. Eyni QR ikinci dəfə qəbul edilmir.'
    : 'Firestore-da saxlanılıb. QR kodu çap dizaynına əlavə edə bilərsiniz.';
  $('ticketState').textContent = data.used ? 'İSTİFADƏ OLUNUB' : 'FIRESTORE SAVED';
  $('ticketState').className = data.used ? 'chip chip-muted' : 'chip chip-issued';
  if (typeof window.QRCode === 'undefined') {
    $('generateMessage').textContent = 'QR kitabxanası yüklənmədi; internet bağlantısını yoxlayın.';
    return;
  }
  $('qrcode').innerHTML = '';
  new window.QRCode($('qrcode'), {
    text: data.qrPayload,
    width: 384, height: 384,
    colorDark: '#141b18', colorLight: '#ffffff',
    correctLevel: window.QRCode.CorrectLevel.M
  });
  $('qrEmpty').classList.add('hidden');
  $('copyBtn').disabled = false;
  $('downloadBtn').disabled = false;
}

async function createNewTicket() {
  if (eventId === LEGACY_EVENT) { toast('Əvvəlcə yeni tədbir yaradın və seçin.'); return; }
  setGenerateLoading(true);
  $('generateMessage').textContent = 'Unikal bilet yaradılır və Firestore-a yazılır...';
  try {
    await requireConnection();
    const createdEvent = eventId;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = codeFromCrypto();
      const qrToken = tokenFromCrypto();
      const qrPayload = `TF2|${code}|${createdEvent}|${qrToken}`;
      const ticketRef = doc(db, TICKET_COLLECTION, code);
      try {
        await runTransaction(db, async tx => {
          const existing = await tx.get(ticketRef);
          if (existing.exists()) throw new Error('CODE_COLLISION');
          tx.set(ticketRef, {
            code, qrToken, qrPayload, eventId:createdEvent, createdBy:sessionUid,
            used: false, usedAt: null, createdAt: serverTimestamp()
          });
        });
        // Bilet yalnız bazada uğurla yaradıldıqdan SONRA göstərilir.
        if (eventId === createdEvent) displayTicket({ code, qrToken, qrPayload, eventId:createdEvent, used: false });
        $('generateMessage').textContent = '✓ Yeni bilet Firestore-da uğurla saxlanıldı.';
        toast(`${code} — yeni QR yaradıldı.`);
        return;
      } catch (error) {
        if (error.message === 'CODE_COLLISION') continue;
        throw error;
      }
    }
    throw new Error('Unikal kod yaratmaq mümkün olmadı. Yenidən cəhd edin.');
  } catch (error) {
    $('generateMessage').textContent = friendlyError(error);
    toast('Yaradılmadı: ' + friendlyError(error));
  } finally {
    setGenerateLoading(false); updateEventNotice();
  }
}

async function copyCode() {
  if (!currentTicket) return;
  try {
    await navigator.clipboard.writeText(currentTicket.code);
    toast('Bilet nömrəsi kopyalandı.');
  } catch {
    toast('Kopyalama mümkün olmadı. HTTPS və ya localhost istifadə edin.');
  }
}
function downloadQr() {
  if (!currentTicket) return;
  const exportCode = currentTicket.code;
  const sourceCanvas = $('qrcode').querySelector('canvas');
  if (!sourceCanvas) { toast('QR şəkli hələ hazır deyil.'); return; }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1200;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1200, 1200);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, 85, 85, 1030, 1030); // çap üçün ağ sakit zona
  canvas.toBlob(blob => {
    if (!blob) { toast('PNG yaratmaq mümkün olmadı.'); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${exportCode}-QR.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('QR kod PNG formatında yükləndi.');
  }, 'image/png');
}

function filteredRegistryTickets(records = recentTickets) {
  const term = $('ticketSearch').value.trim().toUpperCase();
  const filter = $('ticketStatusFilter').value;
  return records.filter(({id, data}) => {
    const code = String(data.code || id);
    if (term && !code.toUpperCase().includes(term)) return false;
    if (filter === 'active' && data.used === true) return false;
    if (filter === 'used' && data.used !== true) return false;
    return true;
  });
}
function registryDate(timestamp) {
  return timestamp?.toDate ? formatDate(timestamp) : '—';
}
function renderTicketList() {
  const list = $('recentList');
  const filtered = filteredRegistryTickets();
  const pageCount = Math.max(1, Math.ceil(filtered.length / TICKETS_PER_PAGE));
  registryPage = Math.min(Math.max(1, registryPage), pageCount);
  const visible = filtered.slice((registryPage - 1) * TICKETS_PER_PAGE, registryPage * TICKETS_PER_PAGE);
  const allIds = new Set(recentTickets.map(t => t.id));
  for (const code of selectedTicketCodes) if (!allIds.has(code)) selectedTicketCodes.delete(code);
  $('recentCount').textContent = recentTickets.length.toLocaleString('az-AZ');
  $('registryFilterCount').textContent = `${filtered.length.toLocaleString('az-AZ')} nəticə`;
  $('registryPageInfo').textContent = `${registryPage} / ${pageCount}`;
  $('prevTicketsBtn').disabled = registryPage === 1;
  $('nextTicketsBtn').disabled = registryPage >= pageCount;
  $('clearTicketSelection').classList.toggle('hidden', selectedTicketCodes.size === 0);
  $('registrySelectionStatus').textContent = selectedTicketCodes.size
    ? `${selectedTicketCodes.size} bilet seçilib · Excel yalnız seçilənləri yükləyəcək`
    : 'Excel üçün sətirləri seçin və ya filtrin bütün nəticələrini yükləyin';
  const selectAll = $('selectAllTickets');
  selectAll.checked = visible.length > 0 && visible.every(t => selectedTicketCodes.has(t.id));
  selectAll.indeterminate = visible.some(t => selectedTicketCodes.has(t.id)) && !selectAll.checked;
  selectAll.disabled = !visible.length;
  $('exportTicketsBtn').disabled = !ticketsReady || !filtered.length && !selectedTicketCodes.size;
  list.replaceChildren();
  if (!filtered.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'registry-empty';
    cell.textContent = recentTickets.length ? 'Axtarış və filtrə uyğun bilet tapılmadı.' : 'Bu tədbirdə hələ bilet yaradılmayıb.';
    row.append(cell); list.append(row);return;
  }
  const fragment = document.createDocumentFragment();
  for (const item of visible) {
    const data = item.data;
    const row = document.createElement('tr');
    row.className = selectedTicketCodes.has(item.id) ? 'registry-row is-selected' : 'registry-row';
    const selectCell = document.createElement('td');
    selectCell.className = 'registry-checkbox-col';
    const box = document.createElement('input');
    box.type = 'checkbox'; box.checked = selectedTicketCodes.has(item.id);
    box.setAttribute('aria-label', `${data.code || item.id} biletini Excel üçün seç`);
    box.addEventListener('change', () => {
      if (box.checked) selectedTicketCodes.add(item.id); else selectedTicketCodes.delete(item.id);
      renderTicketList();
    });
    selectCell.append(box);
    const codeCell = document.createElement('td');
    codeCell.dataset.label = 'Bilet nömrəsi';
    const code = document.createElement('strong');code.className = 'registry-code';code.textContent = data.code || item.id;
    codeCell.append(code);
    const statusCell = document.createElement('td');
    statusCell.dataset.label = 'Status';
    const status = document.createElement('span');
    status.className = `registry-status ${data.used ? 'is-used' : 'is-available'}`;
    status.textContent = data.used ? 'Daxil olub' : 'Aktiv';statusCell.append(status);
    const createdCell = document.createElement('td');createdCell.dataset.label='Yaradılıb';
    createdCell.className = 'registry-time';createdCell.textContent = registryDate(data.createdAt);
    const usedCell = document.createElement('td');usedCell.dataset.label='Giriş vaxtı';
    usedCell.className = 'registry-time';usedCell.textContent = registryDate(data.usedAt);
    const actionsCell = document.createElement('td');
    actionsCell.className = 'registry-action-col';actionsCell.dataset.label = 'Əməliyyatlar';
    const actionWrap = document.createElement('div');actionWrap.className='registry-actions';
    const viewButton = document.createElement('button'); viewButton.className='registry-view'; viewButton.type='button';
    viewButton.textContent='QR göstər'; viewButton.setAttribute('aria-label',`${data.code} biletinin QR-ni göstər`);
    viewButton.addEventListener('click', async () => {
      try { await requireConnection(); const updated=await getDocFromServer(doc(db,TICKET_COLLECTION,item.id));
        if(updated.exists()) {displayTicket(updated.data());document.querySelector('.ticket-panel')?.scrollIntoView({behavior:'smooth',block:'center'});}
        else toast('Bilet artıq bazada yoxdur.');
      } catch(error) {toast(friendlyError(error));}
    });
    const deleteButton = document.createElement('button');deleteButton.className='registry-delete';deleteButton.type='button';
    deleteButton.textContent='Sil';deleteButton.setAttribute('aria-label',`${data.code} nömrəli bileti sil`);
    deleteButton.addEventListener('click',()=>openDeleteDialog(item.id));
    actionWrap.append(viewButton,deleteButton);actionsCell.append(actionWrap);
    row.append(selectCell,codeCell,statusCell,createdCell,usedCell,actionsCell);fragment.append(row);
  }
  list.append(fragment);
}

function openDeleteDialog(code) {
  if (deletingTicket) return;
  pendingDeleteCode = code;
  $('deleteTargetCode').textContent = code;
  const existing = recentTickets.find(t => t.id === code)?.data;
  $('confirmUsedDelete').checked = false;
  $('usedTicketConfirmWrap').classList.toggle('hidden', !existing?.used);
  $('confirmDeleteBtn').disabled = Boolean(existing?.used);
  $('deleteMessage').textContent = '';
  $('deleteDialog').showModal();
}
async function deleteTicket() {
  if (!pendingDeleteCode || deletingTicket) return;
  const code = pendingDeleteCode;
  if (!$('usedTicketConfirmWrap').classList.contains('hidden') && !$('confirmUsedDelete').checked) return;
  deletingTicket = true;
  $('confirmDeleteBtn').disabled = true;
  $('cancelDeleteBtn').disabled = true;
  $('confirmDeleteBtn').textContent = 'Silinir...';
  $('deleteMessage').textContent = 'Firestore qeydləri silinir...';
  try {
    await requireConnection();
    const ticketRef = doc(db, TICKET_COLLECTION, code);
    const checkinRef = doc(db, CHECKIN_COLLECTION, code);
    const auditRef = doc(db, AUDIT_COLLECTION, code);
    // Hər iki sənəd eyni atomik tranzaksiyada silinir. Oxunmuş biletin
    // daxilolma qeydi də silinir; şəbəkə xətasında heç biri silinmir.
    await runTransaction(db, async tx => {
      const ticketSnap = await tx.get(ticketRef);
      const checkinSnap = await tx.get(checkinRef);
      const auditSnap = await tx.get(auditRef);
      if (!ticketSnap.exists()) throw new Error('NOT_FOUND');
      if (auditSnap.exists()) throw new Error('ALREADY_DELETED');
      const previous = ticketSnap.data();
      if (previous.used && !$('confirmUsedDelete').checked) throw new Error('USED_REQUIRES_ACK');
      tx.set(auditRef, { code, eventId: previous.eventId || LEGACY_EVENT, usedBefore: !!previous.used,
        deletedBy:sessionUid, deletedAt:serverTimestamp() });
      tx.delete(ticketRef);
      if (checkinSnap.exists()) tx.delete(checkinRef);
    });
    if (currentTicket?.code === code) clearGeneratedTicket();
    $('deleteDialog').close();
    pendingDeleteCode = null;
    toast(`${code} silindi; daxilolma qeydi də təmizləndi.`);
  } catch (error) {
    $('deleteMessage').textContent = error?.message === 'NOT_FOUND'
      ? 'Bilet artıq bazada yoxdur. Siyahı yenilənəcək.' : friendlyError(error);
  } finally {
    deletingTicket = false;
    $('confirmDeleteBtn').disabled = false;
    $('cancelDeleteBtn').disabled = false;
    $('confirmDeleteBtn').textContent = 'Bəli, bileti sil';
  }
}
function subscribeRecent() {
  unsubscribeRecent?.();
  const q = query(collection(db, TICKET_COLLECTION), orderBy('createdAt', 'desc'));
  unsubscribeRecent = onSnapshot(q, { includeMetadataChanges:true }, snap => {
    allTickets = snap.docs.map(item => ({ id:item.id, data:item.data() }));
    ticketsReady = true; recalcEventView();
    if (!snap.metadata.fromCache && navigator.onLine) setConnection('ok');
  }, error => {
    totalTickets = null; ticketsReady=false; allTickets = []; recentTickets = [];
    updateStats(); $('generateMessage').textContent = friendlyError(error);
    renderTicketList(); setConnection('down');
  });
}
function renderAdmissions(admissions) {
  $('admissionsCount').replaceChildren();
  $('admissionsCount').append(document.createTextNode(String(admissions.length)));
  const suffix = document.createElement('span'); suffix.textContent = ' bilet';
  $('admissionsCount').append(suffix);
  const list = $('admissionsList'); list.replaceChildren();
  if (!admissions.length) {
    const row = document.createElement('div'); row.className='empty-admissions';
    row.textContent='Bu tədbirdə təsdiqlənmiş giriş yoxdur.';list.append(row);return;
  }
  const fragment = document.createDocumentFragment();
  for (const item of admissions.slice(0,75)) {
    const record = item.data;
    const row = document.createElement('div'); row.className = 'admission-row';
    const code = document.createElement('span'); code.className='admission-code'; code.textContent = record.code;
    const time = document.createElement('span'); time.className='admission-date'; time.textContent=formatDate(record.scannedAt);
    row.append(code,time); fragment.append(row);
  }
  list.append(fragment);
  if (admissions.length > 75) {
    const note = document.createElement('div'); note.className='empty-admissions';
    note.textContent=`Son 75 giriş göstərilir; ümumi: ${admissions.length}.`; list.append(note);
  }
}
function subscribeAdmissions() {
  unsubscribeAdmissions?.();
  const q = query(collection(db, CHECKIN_COLLECTION), orderBy('scannedAt', 'desc'));
  unsubscribeAdmissions = onSnapshot(q, { includeMetadataChanges:true }, snap => {
    allCheckins = snap.docs.map(d => ({id:d.id,data:d.data()}));
    admissionsReady = true; recalcEventView();
    if (!snap.metadata.fromCache && navigator.onLine) setConnection('ok');
  }, error => { checkedInTickets=null; admissionsReady=false; allCheckins=[]; updateStats(); $('admissionsList').textContent=friendlyError(error); setConnection('down'); });
}
function scanFeedback(kind, message) {
  const feedback = $('scanFeedback');
  feedback.className = `scan-feedback ${kind}`;
  feedback.textContent = message;
}
async function checkQr(decodedText) {
  if (scanningNow) return;
  scanningNow = true;
  $('eventSelect').disabled = true;
  pausedForResult = true;
  try { scanner?.pause(true); } catch { /* camera changing state */ }
  updateCameraView('paused');
  scanFeedback('warning', 'QR yoxlanılır — serverin təsdiqi gözlənilir...');
  try {
    await requireConnection();
    const legacyMatch = /^TF1\|(TF-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})\|([A-Za-z0-9_-]{32})$/.exec(decodedText);
    const newMatch = /^TF2\|(TF-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})\|(EV-[A-Z2-9]{10})\|([A-Za-z0-9_-]{32})$/.exec(decodedText);
    if (!legacyMatch && !newMatch) throw new Error('INVALID_QR');
    const code = newMatch ? newMatch[1] : legacyMatch[1];
    const qrEvent = newMatch ? newMatch[2] : LEGACY_EVENT;
    const token = newMatch ? newMatch[3] : legacyMatch[2];
    if (qrEvent !== eventId) throw new Error('WRONG_EVENT');
    const ticketRef = doc(db, TICKET_COLLECTION, code);
    const checkinRef = doc(db, CHECKIN_COLLECTION, code);
    await runTransaction(db, async tx => {
      const ticketSnap = await tx.get(ticketRef);
      const checkinSnap = await tx.get(checkinRef);
      if (!ticketSnap.exists()) throw new Error('NOT_FOUND');
      const ticket = ticketSnap.data();
      if ((ticket.eventId || LEGACY_EVENT) !== eventId) throw new Error('WRONG_EVENT');
      if (ticket.qrToken !== token || ticket.qrPayload !== decodedText) throw new Error('INVALID_QR');
      if (ticket.used || checkinSnap.exists()) throw new Error('ALREADY_USED');
      tx.update(ticketRef, { used:true, usedAt:serverTimestamp() });
      const checkin = { code, scannedAt:serverTimestamp() };
      if (qrEvent !== LEGACY_EVENT) { checkin.eventId = qrEvent; checkin.scannedBy = sessionUid; }
      tx.set(checkinRef, checkin);
    });
    scanFeedback('ok', `✓ BİLET TƏSDİQLƏNDİ\n${code}\nGiriş serverdə qeydə alındı.`);
    if (currentTicket?.code === code) {
      currentTicket.used = true;
      $('ticketState').textContent='İSTİFADƏ OLUNUB';
      $('ticketState').className='chip chip-muted';
      $('ticketMeta').textContent='Bu QR artıq istifadə olunub.';
    }
  } catch(error) {
    if (error.message === 'ALREADY_USED') scanFeedback('error','✕ BİLET ARTIQ OXUNUB\nİkinci giriş mümkün deyil.');
    else if (error.message === 'WRONG_EVENT') scanFeedback('error','✕ BAŞQA TƏDBİRİN BİLETİ\nDüzgün tədbiri seçin.');
    else if (['INVALID_QR','NOT_FOUND'].includes(error.message)) scanFeedback('error','✕ ETİBARSIZ BİLET\nQR bu tədbirin qeydiyyatında tapılmadı.');
    else scanFeedback('error', `✕ YOXLAMA BAŞ TUTMADI\n${friendlyError(error)}\nGiriş qeydə alınmadı.`);
  } finally {
    scanningNow = false;
    $('eventSelect').disabled = false;
    if (scannerActive) { $('nextScanBtn').classList.remove('hidden');$('startScanBtn').classList.add('hidden'); }
  }
}
async function startScanner() {
  if (scannerActive || scanner) return;
  const nonce = ++scannerStartNonce;
  try { await requireConnection(); } catch (error) { scanFeedback('error', friendlyError(error)); return; }
  if (nonce !== scannerStartNonce || !sessionUid) return;
  if (!window.isSecureContext) {
    scanFeedback('error', 'Kamera yalnız HTTPS və ya localhost üzərindən işləyir.'); return;
  }
  if (typeof window.Html5Qrcode === 'undefined') {
    scanFeedback('error', 'QR skaneri kitabxanası yüklənmədi. İnternetə baxın.'); return;
  }
  $('startScanBtn').disabled = true;
  $('startScanBtn').textContent = 'Kamera açılır...';
  updateCameraView('loading');
  try {
    scanner = new window.Html5Qrcode('scannerViewport', {
      formatsToSupport: [window.Html5QrcodeSupportedFormats.QR_CODE], verbose: false
    });
    // Kitabxananın daxilindəki real QR scan çərçivəsi video pikseli ilə üst-üstə düşür.
    await scanner.start({ facingMode: 'environment' }, {
      fps: 12, qrbox: (width,height) => {
        const size = Math.min(270, Math.max(90, Math.floor(Math.min(width,height)*0.66)));
        return { width:size, height:size };
      }
    }, checkQr, () => {});
    if (nonce !== scannerStartNonce || !sessionUid) {
      try { await scanner.stop(); scanner.clear(); } catch { /* stop on logout/switch */ }
      scanner = null;
      return;
    }
    scannerActive = true;
    pausedForResult = false;
    $('scannerPlaceholder').classList.add('hidden');
    updateCameraView('live');
    $('scanFeedback').classList.add('hidden');
    $('stopScanBtn').classList.remove('hidden');
    try { const caps=scanner.getRunningTrackCapabilities(); $('torchBtn').classList.toggle('hidden', !caps.torch); } catch { $('torchBtn').classList.add('hidden'); }
    $('startScanBtn').classList.add('hidden');
  } catch (error) {
    updateCameraView('idle');
    scanFeedback('error', 'Kamera açıla bilmədi. Kamera icazəsini və başqa tətbiqin kameradan istifadə etmədiyini yoxlayın.');
    try { scanner?.clear(); } catch { /* ignore */ }
    scanner = null;
  } finally {
    $('startScanBtn').disabled = false;
    $('startScanBtn').textContent = '◉   Kameranı aç';
  }
}
function nextScan() {
  if (!scannerActive || !scanner || scanningNow) return;
  try {
    scanner.resume();
    pausedForResult = false;
    updateCameraView('live');
    $('nextScanBtn').classList.add('hidden');
    $('scanFeedback').classList.add('hidden');
  } catch { toast('Kamera bərpa edilə bilmədi. Yenidən açın.'); }
}
async function stopScanner() {
  ++scannerStartNonce;
  if (scanner) {
    try { if (scannerActive) await scanner.stop(); } catch { /* ignore */ }
    try { scanner.clear(); } catch { /* ignore */ }
  }
  scanner = null;
  scannerActive = false;
  pausedForResult = false;
  scanningNow = false;
  $('scannerViewport').replaceChildren();
  $('torchBtn').classList.add('hidden'); torchOn=false; $('torchBtn').textContent='İşıqlandırma';
  updateCameraView('idle');
  $('scannerPlaceholder').classList.remove('hidden');
  $('startScanBtn').classList.remove('hidden');
  $('nextScanBtn').classList.add('hidden');
  $('stopScanBtn').classList.add('hidden');
  $('scanFeedback').classList.add('hidden');
}
function cleanupSubscriptions() {
  unsubscribeRecent?.(); unsubscribeRecent = null;
  unsubscribeAdmissions?.(); unsubscribeAdmissions = null;
  unsubscribeEvents?.(); unsubscribeEvents = null;
  clearInterval(heartbeatTimer); heartbeatTimer = null; sessionUid=null;
  eventId=LEGACY_EVENT; allTickets=[];allCheckins=[]; ticketsReady=false;admissionsReady=false;
  $('eventSelect').replaceChildren(new Option('Əvvəlki biletlər (TF1)',LEGACY_EVENT));
  selectedTicketCodes.clear();registryPage = 1;
  totalTickets = null; checkedInTickets = null; recentTickets = [];
  setConnection('checking'); updateEventNotice();
  updateStats();
  renderTicketList();
}

// Firebase təhlükəsizliyi: mövcud TicketFlow admin hesabı + tfAdmins/{uid}.active === true.
const configurationOk = ['apiKey', 'authDomain', 'projectId', 'appId'].every(key =>
  typeof firebaseConfig[key] === 'string' &&
  firebaseConfig[key].trim().length > 0 &&
  !firebaseConfig[key].startsWith('YOUR_')
);
if (!configurationOk) {
  $('loginError').textContent = 'İlk olaraq firebase-config.js faylına layihənizin Firebase config məlumatlarını əlavə edin.';
  $('loginBtn').disabled = true;
} else {
  const firebaseApp = initializeApp(firebaseConfig);
  auth = getAuth(firebaseApp);
  db = getFirestore(firebaseApp);
  // Cari tab sessiyasında giriş saxlanılır; localStorage istifadə edilmir.
  try { await setPersistence(auth, browserSessionPersistence); }
  catch { await setPersistence(auth, inMemoryPersistence); }
  onAuthStateChanged(auth, async user => {
    cleanupSubscriptions();
    if (!user) {
      await stopScanner();
      $('authScreen').classList.remove('hidden');
      $('app').classList.add('hidden');
      clearGeneratedTicket();
      return;
    }
    try {
      const admin = await getDocFromServer(doc(db, ADMIN_COLLECTION, user.uid));
      if (!admin.exists() || admin.data().active !== true) {
        $('loginError').textContent = 'Bu hesab aktiv TicketFlow administratoru deyil.';
        await signOut(auth);
        return;
      }
      $('authScreen').classList.add('hidden');
      $('app').classList.remove('hidden');
      $('loginError').textContent = '';
      $('userLabel').textContent = user.email || 'Operator';
      sessionUid=user.uid; onlineConfirmedAt=Date.now();setConnection('ok'); watchConnection();
      subscribeEvents(); subscribeRecent();
      subscribeAdmissions();
    } catch (error) {
      $('loginError').textContent = friendlyError(error);
      await signOut(auth);
    }
  });
}
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!auth) return;
  $('loginError').textContent = '';
  $('loginBtn').disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value);
    $('password').value = '';
  } catch (error) {
    $('loginError').textContent = friendlyError(error);
  } finally { $('loginBtn').disabled = false; }
});
$('logoutBtn').addEventListener('click', async () => { await stopScanner(); await signOut(auth); });
$('generateBtn').addEventListener('click', createNewTicket);
$('ticketSearch').addEventListener('input', () => { registryPage = 1; renderTicketList(); });
$('ticketStatusFilter').addEventListener('change', () => { registryPage = 1; renderTicketList(); });
$('clearTicketSelection').addEventListener('click', () => { selectedTicketCodes.clear();renderTicketList(); });
$('prevTicketsBtn').addEventListener('click', () => { registryPage -= 1; renderTicketList(); });
$('nextTicketsBtn').addEventListener('click', () => { registryPage += 1; renderTicketList(); });
$('selectAllTickets').addEventListener('change', event => {
  const page = filteredRegistryTickets().slice((registryPage-1)*TICKETS_PER_PAGE,registryPage*TICKETS_PER_PAGE);
  for (const item of page) if(event.target.checked) selectedTicketCodes.add(item.id); else selectedTicketCodes.delete(item.id);
  renderTicketList();
});
$('cancelDeleteBtn').addEventListener('click', () => $('deleteDialog').close());
$('confirmDeleteBtn').addEventListener('click', deleteTicket);
$('deleteDialog').addEventListener('cancel', event => { if (deletingTicket) event.preventDefault(); });
$('deleteDialog').addEventListener('close', () => { if (!deletingTicket) pendingDeleteCode = null; });
$('copyBtn').addEventListener('click', copyCode);
$('downloadBtn').addEventListener('click', downloadQr);
$('startScanBtn').addEventListener('click', startScanner);
$('nextScanBtn').addEventListener('click', nextScan);
$('stopScanBtn').addEventListener('click', stopScanner);

// v8: Tədbir yaratma və operatorun kamerası.
$('eventSelect').addEventListener('change', e => setEvent(e.target.value));
$('addEventBtn').addEventListener('click', () => { $('eventError').textContent=''; $('eventDialog').showModal(); });
$('cancelEventBtn').addEventListener('click', () => $('eventDialog').close());
$('eventForm').addEventListener('submit', createEvent);

$('confirmUsedDelete').addEventListener('change', e => { $('confirmDeleteBtn').disabled=!e.target.checked; });
$('torchBtn').addEventListener('click', async () => {
  if (!scanner || !scannerActive) return;
  try { torchOn=!torchOn; await scanner.applyVideoConstraints({advanced:[{torch:torchOn}]});
    $('torchBtn').textContent=torchOn?'İşığı söndür':'İşıqlandırma'; }
  catch { torchOn=false;$('torchBtn').classList.add('hidden');toast('İşıqlandırma bu cihazda dəstəklənmir.'); }
});
window.addEventListener('offline', () => setConnection('down'));
window.addEventListener('online', () => { if(sessionUid) requireConnection().catch(()=>{}); });
updateEventNotice();

// ExcelJS yalnız ixrac düyməsi basıldıqda yüklənir; ilkin səhifə ağırlaşmır.
let excelJsLoader = null;
async function loadExcelJs() {
  if (window.ExcelJS) return window.ExcelJS;
  if (excelJsLoader) return excelJsLoader;
  excelJsLoader = (async () => {
    const urls = [
      'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js'
    ];
    for (const src of urls) {
      try {
        await new Promise((resolve,reject) => {
          const script = document.createElement('script'); script.src=src;script.async=true;
          const timeout=setTimeout(()=>{script.remove();reject(new Error('EXCEL_TIMEOUT'));},20000);
          script.onload=()=>{clearTimeout(timeout);resolve();};
          script.onerror=()=>{clearTimeout(timeout);script.remove();reject(new Error('EXCEL_SCRIPT_ERROR'));};
          document.head.append(script);
        });
        if(window.ExcelJS) return window.ExcelJS;
      } catch(err) { console.warn('ExcelJS CDN:',err.message); }
    }
    throw new Error('Excel kitabxanası yüklənmədi. İnternet bağlantısını yoxlayın.');
  })();
  try { return await excelJsLoader; } catch(error){excelJsLoader=null;throw error;}
}
function safeExcelText(value) {
  const s=String(value ?? '');
  // Excel formula injection müdafiəsi; hüceyrə mütləq sadə mətn olmalıdır.
  return /^[\s\t\r\n]*[=+@\-]/.test(s) ? "'" + s : s;
}
function excelDate(timestamp) {
  if(!timestamp?.toDate) return null;
  const local = timestamp.toDate();
  // ExcelJS uses UTC serials. Preserve the local calendar date/hour shown in the UI.
  return new Date(Date.UTC(local.getFullYear(),local.getMonth(),local.getDate(),local.getHours(),local.getMinutes(),local.getSeconds()));
}
async function downloadTicketsExcel() {
  const button=$('exportTicketsBtn');
  if(button.disabled) return;
  const originally=button.innerHTML;
  button.disabled=true;
  const exportEventId=eventId;
  $('eventSelect').disabled=true;
  button.textContent='Excel hazırlanır...';
  try {
    await requireConnection();
    // Serverdən təzə snapshot; cached siyahını yekun Excel kimi qəbul etmirik.
    const snapshot=await getDocsFromServer(query(collection(db,TICKET_COLLECTION),orderBy('createdAt','desc')));
    if(eventId!==exportEventId) throw new Error('Tədbir dəyişdi, ixracı yenidən başladın.');
    const eventTickets=snapshot.docs.map(d=>({id:d.id,data:d.data()})).filter(item=>ticketBelongs(item.data));
    const chosen=selectedTicketCodes.size
      ? eventTickets.filter(item=>selectedTicketCodes.has(item.id))
      : filteredRegistryTickets(eventTickets);
    if(!chosen.length) throw new Error('İxrac üçün bilet tapılmadı. Filtri və seçimi yoxlayın.');
    const ExcelJS=await loadExcelJs();
    const wb=new ExcelJS.Workbook();
    wb.creator='TicketFlow QR Studio';wb.lastModifiedBy='TicketFlow';wb.created=new Date();
    const sheet=wb.addWorksheet('Yaradılan biletlər',{views:[{state:'frozen',ySplit:6}],properties:{defaultRowHeight:22}});
    const withQr=$('includeQrPayload').checked;
    const columns=[
      {header:'№',key:'index',width:8},
      {header:'Bilet nömrəsi',key:'code',width:25},
      {header:'Status',key:'status',width:19},
      {header:'Tədbir',key:'event',width:30},
      {header:'Yaradılma vaxtı',key:'created',width:22},
      {header:'Daxilolma vaxtı',key:'used',width:22},
      {header:'Yaradan admin UID',key:'createdBy',width:32}
    ];
    if(withQr)columns.push({header:'QR məlumatı (MƏXFİ)',key:'qrPayload',width:70});
    sheet.columns=columns;
    const lastCol=String.fromCharCode(64+columns.length);
    sheet.mergeCells(`A1:${lastCol}2`);
    const heading=sheet.getCell('A1');heading.value='TICKETFLOW / BİLET REYESTRİ';
    heading.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF17263C'}};
    heading.font={name:'Aptos Display',bold:true,color:{argb:'FFFFFFFF'},size:17};
    heading.alignment={vertical:'middle',indent:1};
    sheet.getRow(1).height=23;sheet.getRow(2).height=23;
    sheet.mergeCells(`A3:${lastCol}3`);
    sheet.getCell('A3').value=`Tədbir: ${safeExcelText(eventId === LEGACY_EVENT ? 'Əvvəlki biletlər (TF1)' : (eventRecords.find(e=>e.id===eventId)?.name||eventId))}    •    İxrac: ${new Intl.DateTimeFormat('az-AZ',{dateStyle:'medium',timeStyle:'short'}).format(new Date())}`;
    sheet.getCell('A3').font={color:{argb:'FF5F7491'},size:10};
    sheet.getRow(3).height=26;
    sheet.mergeCells(`A4:${lastCol}4`);
    sheet.getCell('A4').value=withQr ? 'MƏXFİ: QR məlumatı olan bu Excel faylını ictimai paylaşmayın.' : 'Bilet nömrələri və statuslar · QR açarı ixrac olunmayıb.';
    sheet.getCell('A4').font={color:{argb:withQr?'FFC04E58':'FF6A7A90'},italic:true,size:10};
    sheet.getRow(4).height=25;
    const hdr=sheet.getRow(6);
    columns.forEach((column,idx)=> {const cell=hdr.getCell(idx+1);cell.value=column.header;cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFECF3FB'}};cell.font={name:'Aptos',bold:true,color:{argb:'FF28466E'},size:10};cell.alignment={vertical:'middle',indent:1};cell.border={bottom:{style:'medium',color:{argb:'FF9CB5D7'}}};});
    hdr.height=31;
    const evName=eventId === LEGACY_EVENT ? 'Əvvəlki biletlər (TF1)' : eventRecords.find(e=>e.id===eventId)?.name || eventId;
    chosen.forEach((item,i)=> {
      const d=item.data;
      const row=sheet.addRow({index:i+1,code:safeExcelText(d.code||item.id),status:d.used?'Daxil olub':'Aktiv',event:safeExcelText(evName),created:excelDate(d.createdAt),used:excelDate(d.usedAt),createdBy:safeExcelText(d.createdBy||''), ...(withQr?{qrPayload:safeExcelText(d.qrPayload||'')}: {}) });
      row.height=25;
      row.eachCell({includeEmpty:true},(cell,j)=> {
        cell.font={name:'Aptos',size:10,color:{argb:'FF334762'}};
        cell.alignment={vertical:'middle',indent:1};
        if(i%2===1)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF6F9FE'}};
        cell.border={bottom:{style:'hair',color:{argb:'FFE6EDF5'}}};
        if(j===3){cell.font={name:'Aptos',size:10,bold:true,color:{argb:d.used?'FF0A8069':'FF2669C8'}};}
        if(j===5 || j===6){cell.numFmt='dd.mm.yyyy hh:mm';}
      });
    });
    sheet.autoFilter={from:{row:6,column:1},to:{row:6+chosen.length,column:columns.length}};
    sheet.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:6'};
    const summary=wb.addWorksheet('Xülasə');
    summary.columns=[{width:31},{width:24}];
    summary.mergeCells('A1:B2');summary.getCell('A1').value='TICKETFLOW / XÜLASƏ';
    summary.getCell('A1').fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF17263C'}};
    summary.getCell('A1').font={bold:true,color:{argb:'FFFFFFFF'},size:16};
    summary.addRow([]);summary.addRow(['Tədbir',safeExcelText(evName)]);
    summary.addRow(['İxrac olunan biletlər',chosen.length]);
    summary.addRow(['Aktiv',chosen.filter(t=>!t.data.used).length]);
    summary.addRow(['Daxil olub',chosen.filter(t=>t.data.used).length]);
    summary.addRow(['QR məlumatı',withQr?'Daxildir (MƏXFİ)':'Daxil deyil']);
    for(const num of [4,5,6,7,8]){
      const row=summary.getRow(num);row.height=28;
      row.getCell(1).font={bold:true,color:{argb:'FF50637B'}};
    }
    const bytes=await wb.xlsx.writeBuffer();
    const blob=new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=`TicketFlow-${eventId}-Bilet-Reyestri.xlsx`;document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),3000);
    toast(`${chosen.length} bilet Excel formatında yükləndi.`);
  }catch(error){console.error(error);toast('Excel yüklənmədi: '+friendlyError(error));}
  finally{button.innerHTML=originally;$('eventSelect').disabled=false;renderTicketList();}
}
$('exportTicketsBtn').addEventListener('click',downloadTicketsExcel);

function downloadAdmissionsCsv() {
  const records = allCheckins.filter(item => admissionBelongs(item.data));
  if (!records.length) { toast('Bu tədbirdə CSV üçün daxilolma yoxdur.'); return; }
  const enc = v => '"' + String(v ?? '').replaceAll('"','""').replace(/^[=+@\-]/, "'$&") + '"';
  const rows = [['Bilet nömrəsi','Giriş vaxtı','Tədbir','Operator UID'],
    ...records.map(({data}) => [data.code, formatDate(data.scannedAt), eventId, data.scannedBy || ''])];
  const csv = '\uFEFF' + rows.map(row => row.map(enc).join(',')).join('\r\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href=url;link.download=`TicketFlow-${eventId}-Daxilolmalar.csv`;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
  toast('Daxilolmalar CSV faylı yükləndi.');
}
$('exportCsvBtn').addEventListener('click', downloadAdmissionsCsv);
