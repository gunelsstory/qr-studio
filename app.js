import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
  setPersistence, browserSessionPersistence
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, collection, query, orderBy,
  onSnapshot, serverTimestamp, runTransaction
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

// QR formatı: TF1|TF-ABCD-EFGH-JKLM|<192-bit token>
// Firestore QR şəkilini (PNG) deyil, dəqiq eyni şəkli yenidən yaradan qrPayload dəyərini saxlayır.
const TICKET_COLLECTION = 'printTickets';
const CHECKIN_COLLECTION = 'printCheckins';
const ADMIN_COLLECTION = 'tfAdmins';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 simvol, 0/O və 1/I yoxdur.
const $ = id => document.getElementById(id);

let auth, db;
let currentTicket = null;
let unsubscribeRecent = null;
let unsubscribeAdmissions = null;
let scanner = null;
let scannerActive = false;
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
let admissionRecords = [];
let pendingDeleteCode = null;
let deletingTicket = false;
let pausedForResult = false;
let toastTimeout;
let totalTickets = null;
let checkedInTickets = null;
// Satış məlumatı printTickets sənədində, QR giriş statusundan ayrı saxlanılır.
const soldPendingTickets = new Set();
let pendingSale = null;
let savingSale = false;

function updateStats() {
  const ready = Number.isInteger(totalTickets) && Number.isInteger(checkedInTickets);
  const total = ready ? totalTickets : 0;
  const scanned = ready ? Math.min(checkedInTickets, total) : 0;
  const sold = recentTickets.filter(item => item.data.sold === true).length;
  const unused = Math.max(0, total - scanned);
  const percent = total ? Math.round(scanned * 100 / total) : 0;
  $('statTotal').textContent = ready ? total.toLocaleString('az-AZ') : '—';
  $('statSold').textContent = ready ? sold.toLocaleString('az-AZ') : '—';
  $('statReady').textContent = ready ? (total - sold).toLocaleString('az-AZ') : '—';
  $('statScanned').textContent = ready ? scanned.toLocaleString('az-AZ') : '—';
  $('statAvailable').textContent = ready ? unused.toLocaleString('az-AZ') : '—';
  $('statCheckinRate').textContent = percent + '%';
  $('statRateBar').style.width = percent + '%';
}

function openSaleDialog(code, mode) {
  if (savingSale) return;
  const item = recentTickets.find(ticket => ticket.id === code);
  if (!item) { toast('Bilet tapılmadı.'); return; }
  const isSold = item.data.sold === true;
  if (mode === 'sell' && isSold) { toast('Bilet artıq satılıb.'); return; }
  if (mode !== 'sell' && !isSold) { toast('Bu bilet hələ satılmayıb.'); return; }
  pendingSale = { code, mode };
  $('saleTargetCode').textContent = code;
  $('saleMessage').textContent = '';
  $('buyerNameInput').value = mode === 'sell' ? '' : (item.data.buyerName || '');
  $('buyerNameInput').required = mode !== 'revert';
  $('saleNameGroup').classList.toggle('hidden', mode === 'revert');
  if (mode === 'sell') {
    $('saleDialogTitle').textContent = 'Satışı qeydə al';
    $('saleDialogDescription').textContent = 'Bileti alan şəxsin adını və soyadını daxil edin.';
    $('confirmSaleBtn').textContent = 'Satıldı kimi qeyd et';
    $('confirmSaleBtn').className = 'button button-primary';
  } else if (mode === 'edit') {
    $('saleDialogTitle').textContent = 'Alıcı məlumatını düzəlt';
    $('saleDialogDescription').textContent = 'Satılmış biletin alıcı adını yeniləyə bilərsiniz.';
    $('confirmSaleBtn').textContent = 'Yadda saxla';
    $('confirmSaleBtn').className = 'button button-primary';
  } else {
    $('saleDialogTitle').textContent = 'Bileti yenidən hazır et?';
    $('saleDialogDescription').textContent = 'Satış ləğv ediləcək, alıcı adı silinəcək. QR və giriş qeydlərinə toxunulmayacaq.';
    $('confirmSaleBtn').textContent = 'Hazır statusuna qaytar';
    $('confirmSaleBtn').className = 'button button-dark';
  }
  $('saleDialog').showModal();
  if (mode !== 'revert') $('buyerNameInput').focus();
}

async function saveSaleStatus(event) {
  event.preventDefault();
  if (!pendingSale || savingSale) return;
  const { code, mode } = pendingSale;
  const buyerName = $('buyerNameInput').value.trim().replace(/\s+/g, ' ');
  if (mode !== 'revert' && (buyerName.length < 2 || buyerName.length > 120)) {
    $('saleMessage').textContent = 'Ad və soyad 2–120 simvol arasında olmalıdır.';
    return;
  }
  savingSale = true;
  soldPendingTickets.add(code);
  $('confirmSaleBtn').disabled = true;
  $('cancelSaleBtn').disabled = true;
  $('cancelSaleXBtn').disabled = true;
  $('saleMessage').textContent = 'Yadda saxlanılır...';
  renderTicketList();
  try {
    await runTransaction(db, async tx => {
      const ref = doc(db, TICKET_COLLECTION, code);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('NOT_FOUND');
      const record = snap.data();
      if (mode === 'sell') {
        if (record.sold === true) throw new Error('ALREADY_SOLD');
        tx.update(ref, { sold: true, soldAt: serverTimestamp(), buyerName });
      } else if (mode === 'edit') {
        if (record.sold !== true) throw new Error('NOT_SOLD');
        tx.update(ref, { buyerName });
      } else {
        if (record.sold !== true) throw new Error('NOT_SOLD');
        tx.update(ref, { sold: false, soldAt: null, buyerName: null });
      }
    });
    $('saleDialog').close();
    pendingSale = null;
    toast(mode === 'revert' ? `${code} yenidən hazırdır.` : mode === 'edit' ? 'Alıcı adı yeniləndi.' : `${code} satıldı kimi qeyd edildi.`);
  } catch (error) {
    $('saleMessage').textContent = error.message === 'NOT_FOUND' ? 'Bilet tapılmadı.' :
      error.message === 'ALREADY_SOLD' ? 'Bu bilet başqa cihazda artıq satılıb.' :
      error.message === 'NOT_SOLD' ? 'Bu bilet artıq hazır statusundadır.' : friendlyError(error);
  } finally {
    savingSale = false;
    soldPendingTickets.delete(code);
    $('confirmSaleBtn').disabled = false;
    $('cancelSaleBtn').disabled = false;
    $('cancelSaleXBtn').disabled = false;
    renderTicketList();
  }
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => $('toast').classList.add('hidden'), 3300);
}
function friendlyError(error) {
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
  if (!ts?.toDate) return '—';
  return new Intl.DateTimeFormat('az-AZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ts.toDate());
}
function setGenerateLoading(loading) {
  $('generateBtn').disabled = loading;
  $('generateBtn').innerHTML = loading
    ? '<span>Yaradılır...</span>'
    : '<span aria-hidden="true">＋</span> Yeni bilet yarat <span aria-hidden="true">↗</span>';
}
function clearGeneratedTicket() {
  currentTicket = null;
  $('ticketNumber').textContent = 'TF-••••-••••-••••';
  $('ticketMeta').textContent = 'Generasiya etdikdən sonra unikal kod burada görünəcək.';
  $('qrcode').innerHTML = '';
  $('qrEmpty').classList.remove('hidden');
  $('ticketState').textContent = 'SEÇİLMƏYİB';
  $('ticketState').className = 'state-pill state-neutral';
  $('copyBtn').disabled = true;
  $('downloadBtn').disabled = true;
}
function displayTicket(data) {
  currentTicket = data;
  $('ticketNumber').textContent = data.code;
  $('ticketMeta').textContent = data.used
    ? 'Bu bilet artıq istifadə olunub. Eyni QR ikinci dəfə qəbul edilmir.'
    : 'QR kodu çap üçün yükləyə və ya kopyalaya bilərsiniz.';
  $('ticketState').textContent = data.used ? 'GİRİŞ EDİB' : data.sold ? 'SATILDI' : 'HAZIR';
  $('ticketState').className = data.used ? 'state-pill state-used' : data.sold ? 'state-pill state-sold' : 'state-pill state-ready';
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
  setGenerateLoading(true);
  $('generateMessage').textContent = 'Yeni bilet yaradılır...';
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = codeFromCrypto();
      const qrToken = tokenFromCrypto();
      const qrPayload = `TF1|${code}|${qrToken}`;
      const ticketRef = doc(db, TICKET_COLLECTION, code);
      try {
        await runTransaction(db, async tx => {
          const existing = await tx.get(ticketRef);
          if (existing.exists()) throw new Error('CODE_COLLISION');
          tx.set(ticketRef, {
            code, qrToken, qrPayload,
            used: false, usedAt: null,
            createdAt: serverTimestamp()
          });
        });
        // Bilet yalnız bazada uğurla yaradıldıqdan SONRA göstərilir.
        displayTicket({ code, qrToken, qrPayload, used: false });
        $('generateMessage').textContent = 'Yeni bilet uğurla yaradıldı.';
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
    setGenerateLoading(false);
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


// Excel hesabatları Firestore-un mövcud realtime məlumatlarından, yalnız oxuma rejimində hazırlanır.
// QR tokenləri və qrPayload təhlükəsizlik üçün eksport edilmir.
function ticketSearchMatches() {
  const term = $('ticketSearch').value.trim().toLocaleLowerCase('az-AZ');
  const filter = $('ticketStatusFilter').value;
  return recentTickets.filter(({id, data}) => {
    const haystack = `${data.code || id} ${data.buyerName || ''}`.toLocaleLowerCase('az-AZ');
    if (term && !haystack.includes(term)) return false;
    if (filter === 'sold') return data.sold === true;
    if (filter === 'ready') return data.sold !== true;
    if (filter === 'used') return data.used === true;
    return true;
  });
}
function exportWorksheet(headers, rows, widths, sheetName, filename) {
  if (typeof window.XLSX === 'undefined') {
    toast('Excel kitabxanası yüklənmədi. İnternet bağlantısını yoxlayın.');
    return;
  }
  if (!rows.length) { toast('Yükləmək üçün məlumat yoxdur.'); return; }
  try {
    const sheet = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
    sheet['!cols'] = widths.map(wch => ({ wch }));
    sheet['!autofilter'] = { ref: window.XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) };
    const book = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(book, sheet, sheetName);
    window.XLSX.writeFile(book, filename, { bookType: 'xlsx', compression: true });
    toast(`${rows.length} qeyd Excel faylına yükləndi.`);
  } catch (error) {
    console.error('Excel export error:', error);
    toast('Excel faylını yaratmaq mümkün olmadı.');
  }
}
function exportTickets() {
  const rows = ticketSearchMatches().map(({ id, data }) => [
    data.code || id,
    data.used ? 'İstifadə olunub' : 'Aktiv',
    data.createdAt?.toDate ? formatDate(data.createdAt) : '',
    data.usedAt?.toDate ? formatDate(data.usedAt) : '',
    data.sold === true ? 'Satıldı' : 'Hazır',
    data.soldAt?.toDate ? formatDate(data.soldAt) : '',
    data.buyerName || ''
  ]);
  const stamp = new Date().toLocaleDateString('en-CA');
  exportWorksheet(
    ['Bilet nömrəsi', 'Giriş statusu', 'Yaradılma tarixi', 'Giriş tarixi', 'Satış statusu', 'Satış tarixi', 'Alıcının adı və soyadı'],
    rows, [24, 22, 25, 25, 18, 25, 32], 'Yaradılan biletlər', `TicketFlow_Biletler_${stamp}.xlsx`
  );
}
function exportAdmissions() {
  const rows = admissionRecords.map(({ id, data }) => [
    data.code || id,
    data.scannedAt?.toDate ? formatDate(data.scannedAt) : ''
  ]);
  const stamp = new Date().toLocaleDateString('en-CA');
  exportWorksheet(
    ['Bilet nömrəsi', 'Giriş vaxtı'],
    rows, [25, 28], 'Daxilolmalar', `TicketFlow_Daxilolmalar_${stamp}.xlsx`
  );
}

function renderTicketList() {
  const list = $('recentList');
  const filtered = ticketSearchMatches();
  const hasSearch = $('ticketSearch').value.trim() || $('ticketStatusFilter').value !== 'all';
  $('exportTicketsBtn').disabled = filtered.length === 0;
  $('recentCount').textContent = hasSearch ? `${filtered.length} / ${recentTickets.length}` : `${recentTickets.length} bilet`;
  list.replaceChildren();
  if (!filtered.length) {
    const p = document.createElement('p');
    p.className = 'empty-list';
    p.textContent = hasSearch ? 'Bu axtarış və ya filtrə uyğun bilet tapılmadı.' : 'Hələ bilet yoxdur.';
    list.append(p);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const {id, data} of filtered) {
    const codeText = data.code || id;
    const row = document.createElement('div');
    row.className = 'recent-item';

    const identification = document.createElement('div');
    identification.className = 'recent-identification';
    const code = document.createElement('strong');
    code.className = 'recent-code';
    code.textContent = codeText;
    const date = document.createElement('small');
    date.className = 'recent-date';
    date.textContent = formatDate(data.createdAt);
    identification.append(code, date);

    const buyer = document.createElement('div');
    buyer.className = 'recent-buyer';
    const buyerText = document.createElement('span');
    buyerText.className = data.buyerName ? 'buyer-name' : 'buyer-empty';
    buyerText.textContent = data.buyerName || (data.sold ? 'Ad qeyd edilməyib' : '—');
    const buyerCaption = document.createElement('small');
    buyerCaption.className = 'buyer-caption';
    buyerCaption.textContent = data.sold ? (data.soldAt?.toDate ? formatDate(data.soldAt) : 'Satış qeydi') : 'Satış gözləyir';
    buyer.append(buyerText, buyerCaption);

    const states = document.createElement('div');
    states.className = 'recent-status-group';
    const soldStatus = document.createElement('span');
    soldStatus.className = data.sold ? 'ticket-badge is-sold' : 'ticket-badge is-ready';
    soldStatus.textContent = data.sold ? 'Satıldı' : 'Hazır';
    states.append(soldStatus);
    if (data.used) {
      const scanned = document.createElement('span');
      scanned.className = 'ticket-badge is-used';
      scanned.textContent = 'Giriş edib';
      states.append(scanned);
    }

    const actions = document.createElement('div');
    actions.className = 'recent-actions';
    function action(label, extraClass, cb) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `action-button ${extraClass}`;
      button.textContent = label;
      button.setAttribute('aria-label', `${codeText}: ${label}`);
      button.disabled = soldPendingTickets.has(id);
      button.addEventListener('click', cb);
      actions.append(button);
    }
    action('QR', '', async () => {
      try {
        const snap = await getDoc(doc(db, TICKET_COLLECTION, id));
        if (!snap.exists()) { toast('Bilet artıq bazada yoxdur.'); return; }
        displayTicket(snap.data());
        $('tickets').scrollIntoView({behavior:'smooth',block:'center'});
      } catch(error) {toast(friendlyError(error));}
    });
    if (data.sold === true) {
      action('Düzəliş et', '', () => openSaleDialog(id, 'edit'));
      action('Hazır et', 'action-restore', () => openSaleDialog(id, 'revert'));
    } else {
      action('Satıldı', 'action-primary', () => openSaleDialog(id, 'sell'));
    }
    action('Sil', 'action-danger', () => openDeleteDialog(id));
    row.append(identification, buyer, states, actions);
    fragment.append(row);
  }
  list.append(fragment);
}
function openDeleteDialog(code) {
  if (deletingTicket) return;
  pendingDeleteCode = code;
  $('deleteTargetCode').textContent = code;
  $('deleteMessage').textContent = '';
  $('deleteDialog').showModal();
}
async function deleteTicket() {
  if (!pendingDeleteCode || deletingTicket) return;
  const code = pendingDeleteCode;
  deletingTicket = true;
  $('confirmDeleteBtn').disabled = true;
  $('cancelDeleteBtn').disabled = true;
  $('confirmDeleteBtn').textContent = 'Silinir...';
  $('deleteMessage').textContent = 'Bilet və giriş qeydləri silinir...';
  try {
    const ticketRef = doc(db, TICKET_COLLECTION, code);
    const checkinRef = doc(db, CHECKIN_COLLECTION, code);
    // Hər iki sənəd eyni atomik tranzaksiyada silinir. Oxunmuş biletin
    // daxilolma qeydi də silinir; şəbəkə xətasında heç biri silinmir.
    await runTransaction(db, async tx => {
      const ticketSnap = await tx.get(ticketRef);
      const checkinSnap = await tx.get(checkinRef);
      if (!ticketSnap.exists()) throw new Error('NOT_FOUND');
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
    $('confirmDeleteBtn').textContent = 'Bileti sil';
  }
}
function subscribeRecent() {
  unsubscribeRecent?.();
  // Bütün biletlər siyahı və statistikalar üçün real vaxtda dinlənir.
  const q = query(collection(db, TICKET_COLLECTION), orderBy('createdAt', 'desc'));
  unsubscribeRecent = onSnapshot(q, snap => {
    totalTickets = snap.size;
    recentTickets = snap.docs.map(item => ({ id: item.id, data: item.data() }));
    // Açıq QR biletinin satış/giriş etiketi digər cihazdakı dəyişikliklərlə yenilənsin.
    if (currentTicket) {
      const refreshed = recentTickets.find(item => item.id === currentTicket.code);
      if (!refreshed) clearGeneratedTicket();
      else {
        currentTicket = {...currentTicket, ...refreshed.data};
        const state = currentTicket.used ? 'used' : currentTicket.sold ? 'sold' : 'ready';
        $('ticketState').textContent = state === 'used' ? 'GİRİŞ EDİB' : state === 'sold' ? 'SATILDI' : 'HAZIR';
        $('ticketState').className = `state-pill state-${state}`;
      }
    }
    updateStats();
    renderTicketList();
  }, error => {
    totalTickets = null;
    recentTickets = [];
    updateStats();
    $('generateMessage').textContent = friendlyError(error);
    renderTicketList();
  });
}
function subscribeAdmissions() {
  unsubscribeAdmissions?.();
  const q = query(collection(db, CHECKIN_COLLECTION), orderBy('scannedAt', 'desc'));
  unsubscribeAdmissions = onSnapshot(q, snap => {
    checkedInTickets = snap.size;
    admissionRecords = snap.docs.map(item => ({ id: item.id, data: item.data() }));
    $('exportAdmissionsBtn').disabled = snap.empty;
    updateStats();
    $('admissionsCount').replaceChildren();
    $('admissionsCount').append(document.createTextNode(String(snap.size)));
    const suffix = document.createElement('span'); suffix.textContent = ' bilet';
    $('admissionsCount').append(suffix);
    const list = $('admissionsList');
    list.replaceChildren();
    if (snap.empty) {
      const p = document.createElement('div'); p.className = 'empty-admissions';
      p.textContent = 'Hələ təsdiqlənmiş giriş yoxdur.'; list.append(p); return;
    }
    snap.forEach(item => {
      const record = item.data();
      const row = document.createElement('div'); row.className = 'admission-row';
      const code = document.createElement('span'); code.className = 'admission-code'; code.textContent = record.code;
      const time = document.createElement('span'); time.className = 'admission-date'; time.textContent = formatDate(record.scannedAt);
      row.append(code, time); list.append(row);
    });
  }, error => {
    checkedInTickets = null; admissionRecords = [];
    $('exportAdmissionsBtn').disabled = true;
    updateStats();
    const list = $('admissionsList'); list.textContent = friendlyError(error);
  });
}
function scanFeedback(kind, message) {
  const feedback = $('scanFeedback');
  feedback.className = `scan-feedback ${kind}`;
  feedback.textContent = message;
}
async function checkQr(decodedText) {
  if (scanningNow) return;
  scanningNow = true;
  pausedForResult = true;
  try { scanner?.pause(true); } catch { /* başqa bir keçid zamanı dayandırılmış ola bilər */ }
  updateCameraView('paused');
  scanFeedback('warning', 'QR kod yoxlanılır...');
  try {
    const match = /^TF1\|(TF-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})\|([A-Za-z0-9_-]{32})$/.exec(decodedText);
    if (!match) throw new Error('INVALID_QR');
    const [, code, providedToken] = match;
    const ticketRef = doc(db, TICKET_COLLECTION, code);
    const checkinRef = doc(db, CHECKIN_COLLECTION, code);
    await runTransaction(db, async tx => {
      // Firestore transaction: bütün OXUMALAR yazmalardan ƏVVƏL.
      const ticketSnap = await tx.get(ticketRef);
      const checkinSnap = await tx.get(checkinRef);
      if (!ticketSnap.exists()) throw new Error('NOT_FOUND');
      const ticket = ticketSnap.data();
      if (ticket.qrToken !== providedToken || ticket.qrPayload !== decodedText) throw new Error('INVALID_QR');
      if (ticket.used || checkinSnap.exists()) throw new Error('ALREADY_USED');
      tx.update(ticketRef, { used: true, usedAt: serverTimestamp() });
      tx.set(checkinRef, { code, scannedAt: serverTimestamp() });
    });
    scanFeedback('ok', `✓ BİLET TƏSDİQLƏNDİ\n${code}\nGiriş uğurla qeydə alındı.`);
    if (currentTicket?.code === code) currentTicket.used = true;
    if (currentTicket?.code === code) {
      $('ticketState').textContent = 'GİRİŞ EDİB';
      $('ticketState').className = 'state-pill state-used';
      $('ticketMeta').textContent = 'Bu bilet artıq istifadə olunub. Eyni QR ikinci dəfə qəbul edilmir.';
    }
  } catch (error) {
    if (error.message === 'ALREADY_USED') scanFeedback('error', '✕ BİLET ARTIQ OXUNUB\nBu QR ilə ikinci giriş mümkün deyil.');
    else if (error.message === 'INVALID_QR' || error.message === 'NOT_FOUND') scanFeedback('error', '✕ ETİBARSIZ BİLET\nBu QR sistemdə qeydiyyatda deyil və ya məlumatı uyğun gəlmir.');
    else scanFeedback('error', `✕ YOXLAMA BAŞ TUTMADI\n${friendlyError(error)}\nİnterneti yoxlayın və yenidən oxudun.`);
  } finally {
    scanningNow = false;
    if (scannerActive) {
      $('nextScanBtn').classList.remove('hidden');
      $('startScanBtn').classList.add('hidden');
    }
  }
}
async function startScanner() {
  if (scannerActive) return;
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
    // Kamera öz təbii en/hündürlük nisbətində göstərilir; süni 4:3 kəsmə yoxdur.
    // Bütün görüntü skan olunur, ekrandakı nişan yalnız vizual bələdçidir.
    await scanner.start({ facingMode: 'environment' }, {
      fps: 12
    }, checkQr, () => { /* Kod olmayan kadrlarda xəta göstərilmir. */ });
    scannerActive = true;
    pausedForResult = false;
    $('scannerPlaceholder').classList.add('hidden');
    updateCameraView('live');
    $('scanFeedback').classList.add('hidden');
    $('stopScanBtn').classList.remove('hidden');
    $('startScanBtn').classList.add('hidden');
  } catch (error) {
    updateCameraView('idle');
    scanFeedback('error', 'Kamera açıla bilmədi. Kamera icazəsini və başqa tətbiqin kameradan istifadə etmədiyini yoxlayın.');
    try { scanner?.clear(); } catch { /* ignore */ }
    scanner = null;
  } finally {
    $('startScanBtn').disabled = false;
    $('startScanBtn').textContent = 'Kameranı aç';
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
  if (scanner) {
    try { if (scannerActive) await scanner.stop(); } catch { /* ignore */ }
    try { scanner.clear(); } catch { /* ignore */ }
  }
  scanner = null;
  scannerActive = false;
  pausedForResult = false;
  scanningNow = false;
  $('scannerViewport').replaceChildren();
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
  totalTickets = null; checkedInTickets = null; recentTickets = []; admissionRecords = [];
  $('exportTicketsBtn').disabled = true;
  $('exportAdmissionsBtn').disabled = true;
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
  // Sessiya eyni brauzer vərəqində yenilənmədən sonra qalır; vərəq bağlananda bitir.
  // Firebase browserSessionPersistence istifadə olunur, xüsusi localStorage yazılışı yoxdur.
  await setPersistence(auth, browserSessionPersistence);
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
      const admin = await getDoc(doc(db, ADMIN_COLLECTION, user.uid));
      if (!admin.exists() || admin.data().active !== true) {
        $('loginError').textContent = 'Bu hesab aktiv TicketFlow administratoru deyil.';
        await signOut(auth);
        return;
      }
      $('authScreen').classList.add('hidden');
      $('app').classList.remove('hidden');
      $('loginError').textContent = '';
      $('userLabel').textContent = user.email || 'Operator';
      subscribeRecent();
      subscribeAdmissions();
    } catch (error) {
      // Müvəqqəti Firestore/internet xətası admin sessiyasını məcburi bağlamasın.
      // Yoxlama uğursuzdursa panel açılmır; əlaqə bərpa olunanda səhifəni yeniləmək olar.
      $('app').classList.add('hidden');
      $('authScreen').classList.remove('hidden');
      $('loginError').textContent = 'Admin statusu yoxlanmadı: ' + friendlyError(error) + ' Yenidən yoxlamaq üçün səhifəni yeniləyin.';
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
$('ticketSearch').addEventListener('input', renderTicketList);
$('ticketStatusFilter').addEventListener('change', renderTicketList);
$('saleForm').addEventListener('submit', saveSaleStatus);
$('cancelSaleBtn').addEventListener('click', () => $('saleDialog').close());
$('cancelSaleXBtn').addEventListener('click', () => $('saleDialog').close());
$('saleDialog').addEventListener('cancel', event => { if (savingSale) event.preventDefault(); });
$('saleDialog').addEventListener('close', () => { if (!savingSale) pendingSale = null; });
$('exportTicketsBtn').addEventListener('click', exportTickets);
$('exportAdmissionsBtn').addEventListener('click', exportAdmissions);
$('cancelDeleteBtn').addEventListener('click', () => $('deleteDialog').close());
$('confirmDeleteBtn').addEventListener('click', deleteTicket);
$('deleteDialog').addEventListener('cancel', event => { if (deletingTicket) event.preventDefault(); });
$('deleteDialog').addEventListener('close', () => { if (!deletingTicket) pendingDeleteCode = null; });
$('copyBtn').addEventListener('click', copyCode);
$('downloadBtn').addEventListener('click', downloadQr);
$('startScanBtn').addEventListener('click', startScanner);
$('nextScanBtn').addEventListener('click', nextScan);
$('stopScanBtn').addEventListener('click', stopScanner);
