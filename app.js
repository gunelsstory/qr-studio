import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
  setPersistence, inMemoryPersistence
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
let pausedForResult = false;
let toastTimeout;
let totalTickets = null;
let checkedInTickets = null;

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
  setGenerateLoading(true);
  $('generateMessage').textContent = 'Unikal bilet yaradılır və Firestore-a yazılır...';
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

function subscribeRecent() {
  unsubscribeRecent?.();
  // Canlı göstəricilər üçün bütün çap biletlərini dinləyirik; son siyahıda yalnız 8-i göstərilir.
  // Böyük həcmli tədbirlərdə bu göstəriciləri server-side sayğaclara keçirmək məsləhətdir.
  const q = query(collection(db, TICKET_COLLECTION), orderBy('createdAt', 'desc'));
  unsubscribeRecent = onSnapshot(q, snap => {
    totalTickets = snap.size;
    updateStats();
    $('recentCount').textContent = snap.size ? `SON ${Math.min(snap.size, 8)}` : '0';
    const list = $('recentList');
    list.replaceChildren();
    if (snap.empty) {
      const p = document.createElement('p'); p.className = 'empty-list'; p.textContent = 'Hələ bilet yoxdur.';
      list.append(p); return;
    }
    for (const item of snap.docs.slice(0, 8)) {
      const data = item.data();
      const row = document.createElement('button');
      row.className = 'recent-item'; row.type = 'button';
      const code = document.createElement('span'); code.textContent = data.code;
      const status = document.createElement('span'); status.textContent = data.used ? 'İstifadə olunub' : 'QR-ni göstər ↗';
      row.append(code, status);
      row.addEventListener('click', async () => {
        try {
          const updated = await getDoc(doc(db, TICKET_COLLECTION, data.code));
          if (updated.exists()) displayTicket(updated.data());
        } catch (error) { toast(friendlyError(error)); }
      });
      list.append(row);
    }
  }, error => { totalTickets = null; updateStats(); $('generateMessage').textContent = friendlyError(error); });
}
function subscribeAdmissions() {
  unsubscribeAdmissions?.();
  const q = query(collection(db, CHECKIN_COLLECTION), orderBy('scannedAt', 'desc'));
  unsubscribeAdmissions = onSnapshot(q, snap => {
    checkedInTickets = snap.size;
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
    checkedInTickets = null; updateStats();
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
  scanFeedback('warning', 'QR yoxlanılır. Firestore ilə əlaqə qurulur...');
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
      $('ticketState').textContent = 'İSTİFADƏ OLUNUB';
      $('ticketState').className = 'chip chip-muted';
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
  try {
    scanner = new window.Html5Qrcode('scannerViewport', {
      formatsToSupport: [window.Html5QrcodeSupportedFormats.QR_CODE], verbose: false
    });
    await scanner.start({ facingMode: 'environment' }, {
      fps: 10, qrbox: { width: 210, height: 210 }
    }, checkQr, () => { /* scan başarısız kadrlar normaldır */ });
    scannerActive = true;
    pausedForResult = false;
    $('scannerPlaceholder').classList.add('hidden');
    $('scanFeedback').classList.add('hidden');
    $('stopScanBtn').classList.remove('hidden');
    $('startScanBtn').classList.add('hidden');
  } catch (error) {
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
  $('scannerPlaceholder').classList.remove('hidden');
  $('startScanBtn').classList.remove('hidden');
  $('nextScanBtn').classList.add('hidden');
  $('stopScanBtn').classList.add('hidden');
  $('scanFeedback').classList.add('hidden');
}
function cleanupSubscriptions() {
  unsubscribeRecent?.(); unsubscribeRecent = null;
  unsubscribeAdmissions?.(); unsubscribeAdmissions = null;
  totalTickets = null; checkedInTickets = null;
  updateStats();
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
  // Sessiya yalnız cari səhifənin yaddaşındadır; LocalStorage-a login yazılmır.
  await setPersistence(auth, inMemoryPersistence);
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
$('copyBtn').addEventListener('click', copyCode);
$('downloadBtn').addEventListener('click', downloadQr);
$('startScanBtn').addEventListener('click', startScanner);
$('nextScanBtn').addEventListener('click', nextScan);
$('stopScanBtn').addEventListener('click', stopScanner);
