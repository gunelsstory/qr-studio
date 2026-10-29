/* TicketFlow QR Studio ONE — no Firestore rules/setup changes.
   Reads/writes ONLY pre-existing printTickets and printCheckins; optional printAudit on delete
   if pre-existing rules already require it. Uses tfAdmins for existing admin role.
   Compatible with TF1 legacy and TF2 existing event tickets, without creating printEvents. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
  setPersistence, browserSessionPersistence } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, collection, doc, getDocFromServer, getDocsFromServer,
  onSnapshot, query, orderBy, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);
const $ = id => document.getElementById(id);
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^TF-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const TF1_RE = /^TF1\|(TF-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})\|([A-Za-z0-9_-]{32})$/;
const TF2_RE = /^TF2\|(TF-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})\|(EV-[A-Z2-9]{10})\|([A-Za-z0-9_-]{32})$/;
const PAGE_SIZE = 12;
const entries = {tickets:[],checkins:[]};
const ready = {tickets:false,checkins:false};
const selected = new Set();
let uid = null, preview = null, currentEvent = 'legacy', view = 'overview';
let page = 1, entryPage = 1, unsubscribeTickets = null, unsubscribeCheckins = null, unsubscribeEvents = null;
let eventNames = new Map();
let heartbeat = null, online = false, toastTimer = null, generateBusy = false, deletionBusy = false;
let scanner = null, scannerRunning = false, scannerStarting = false, scannerLocked = false, scannerNonce = 0;
let deletingCode = null, exportBusy = false, torchEnabled = false;

function notice(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 3500);
}
function errText(e) {
  if (e?.message === 'OFFLINE') return 'Server bağlantısı yoxdur. Bu əməliyyat təsdiqlənmədi.';
  if (e?.message === 'ADMIN_REQUIRED') return 'Aktiv administrator icazəsi yoxdur.';
  if (e?.message === 'BAD_EVENT') return 'Bu QR seçilən tədbirə uyğun deyil.';
  if (e?.message === 'ALREADY_USED') return 'Bilet artıq istifadə olunub.';
  if (e?.message === 'NOT_FOUND') return 'Bilet Firestore-da mövcud deyil.';
  if (e?.message === 'BAD_QR') return 'QR kod etibarsızdır və ya uyğun gəlmir.';
  if (e?.code === 'permission-denied') return 'Firestore icazəsi yoxdur. Mövcud Rules bu əməliyyata icazə vermir. Firebase ayarları dəyişdirilməyib.';
  if (e?.code === 'unavailable') return 'Firestore əlçatan deyil. İnterneti yoxlayın.';
  if (e?.code === 'auth/invalid-credential') return 'E-poçt və ya şifrə yanlışdır.';
  return e?.message || 'Əməliyyat zamanı xəta baş verdi.';
}
function setConnection(state) {
  $('connectionStatus').dataset.state = state;
  $('connectionText').textContent = state === 'ok' ? 'Firestore aktiv' : state === 'down' ? 'Bağlantı yoxdur' : 'Yoxlanılır';
  online = state === 'ok';
}
async function assertOnline() {
  if (!navigator.onLine || !auth.currentUser || !uid) {setConnection('down'); throw new Error('OFFLINE');}
  try {
    const admin = await getDocFromServer(doc(db,'tfAdmins',uid));
    if (!admin.exists() || admin.data().active !== true) throw new Error('ADMIN_REQUIRED');
    setConnection('ok');
  } catch(e) {setConnection('down');throw e;}
}
function cryptoCode() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(b, n=>CHARSET[n % CHARSET.length]).join('');
  return `TF-${s.slice(0,4)}-${s.slice(4,8)}-${s.slice(8)}`;
}
function cryptoToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function timeText(timestamp) {
  if (!timestamp?.toDate) return '—';
  return new Intl.DateTimeFormat('az-AZ',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(timestamp.toDate());
}
function entryEvent(data) { return data.eventId || 'legacy'; }
function visibleEvent(data) { return currentEvent === 'all' || entryEvent(data) === currentEvent; }
function tickets() { return entries.tickets.filter(item => visibleEvent(item.data)); }
function checkins() { return entries.checkins.filter(item => visibleEvent(item.data)); }
function allEvents() {
  const events = new Set(['legacy', ...eventNames.keys()]);
  entries.tickets.forEach(({data})=>{if(data.eventId && /^EV-[A-Z2-9]{10}$/.test(data.eventId)) events.add(data.eventId);});
  return [...events];
}
function refreshEventOptions() {
  const select = $('eventSelect');
  const ids = allEvents();
  select.replaceChildren(new Option('Bütün biletlər · icmal', 'all'),new Option('Əvvəlki biletlər · TF1', 'legacy'));
  for (const id of ids) if(id !== 'legacy') select.add(new Option(eventNames.get(id) ? `${eventNames.get(id)} · ${id}` : `Tədbir · ${id}`,id));
  if (!['all',...ids].includes(currentEvent)) currentEvent='legacy';
  select.value = currentEvent;
  $('eventMode').textContent = currentEvent === 'all' ? 'ÜMUMİ BAXIŞ' : currentEvent === 'legacy' ? 'TF1 QR' : 'TF2 QR';
  $('generateBtn').disabled = generateBusy || currentEvent === 'all';
  $('startScanBtn').disabled = currentEvent === 'all' || scannerStarting;
}
function recalc() {
  const tt = tickets(), cc = checkins();
  const count = tt.length, used = tt.filter(t=>t.data.used === true).length, active = count-used;
  const percent = count ? Math.round(used*100/count):0, percentActive = count?Math.round(active*100/count):0;
  const done = ready.tickets && ready.checkins;
  $('statTotal').textContent = done ? count.toLocaleString('az-AZ') : '—';
  $('statScanned').textContent = done ? used.toLocaleString('az-AZ') : '—';
  $('statActive').textContent = done ? active.toLocaleString('az-AZ') : '—';
  $('scanPercent').textContent = percent+'%';$('activePercent').textContent=percentActive+'%';
  $('ringTotal').style.setProperty('--progress',count?'100%':'0%');
  $('ringScanned').style.setProperty('--progress',percent+'%');
  $('ringActive').style.setProperty('--progress',percentActive+'%');
  $('statsHint').textContent = done ? `${cc.length} daxilolma qeydi · canlı sinxron` : 'Firestore gözlənilir';
  $('navTicketCount').textContent=count;
  renderTickets(); renderAdmissions();
}
function startSubscriptions() {
  unsubscribeTickets?.();unsubscribeCheckins?.();unsubscribeEvents?.();
  // Optional read-only event names. On older v7 rules this collection is inaccessible;
  // ignore permission-denied and keep TF1 + event IDs from existing tickets.
  unsubscribeEvents = onSnapshot(collection(db,'printEvents'),snapshot=>{
    eventNames = new Map(snapshot.docs.filter(d=>d.data().status==='active').map(d=>[d.id,d.data().name||d.id]));
    refreshEventOptions();
  },()=>{eventNames=new Map();refreshEventOptions();});
  ready.tickets=false; ready.checkins=false;
  unsubscribeTickets = onSnapshot(query(collection(db,'printTickets'),orderBy('createdAt','desc')),{includeMetadataChanges:true}, snapshot=>{
    entries.tickets=snapshot.docs.map(d=>({id:d.id,data:d.data()}));ready.tickets=true;
    refreshEventOptions();recalc();
    if(!snapshot.metadata.fromCache && navigator.onLine) setConnection('ok');
  },e=>{ready.tickets=false;entries.tickets=[];recalc();notice(errText(e));setConnection('down');});
  unsubscribeCheckins = onSnapshot(query(collection(db,'printCheckins'),orderBy('scannedAt','desc')),{includeMetadataChanges:true},snapshot=>{
    entries.checkins=snapshot.docs.map(d=>({id:d.id,data:d.data()}));ready.checkins=true;recalc();
    if(!snapshot.metadata.fromCache && navigator.onLine) setConnection('ok');
  },e=>{ready.checkins=false;entries.checkins=[];recalc();notice(errText(e));setConnection('down');});
}
function go(next) {
  if(view==='scanner' && next!=='scanner') stopScanner();
  view=next;
  document.querySelectorAll('.view').forEach(el=>el.classList.toggle('hidden',el.id!==`view-${next}`));
  document.querySelectorAll('.nav-link').forEach(el=>el.classList.toggle('active',el.dataset.view===next));
  $('headerTitle').textContent = {overview:'İcmal və generator',tickets:'Bilet reyestri',scanner:'QR skaneri',admissions:'Daxilolmalar'}[next];
  window.scrollTo({top:0,behavior:'instant'});
}
function clearPreview() {
  preview=null;$('ticketNumber').textContent='TF-••••-••••-••••';
  $('ticketMeta').textContent='Yeni bilet yaradıldıqda QR burada görünəcək.';
  $('qrcode').replaceChildren(); $('qrEmpty').classList.remove('hidden');
  $('ticketState').textContent='HAZIR DEYİL';$('ticketState').className='pill';
  $('copyBtn').disabled=true;$('downloadBtn').disabled=true;
}
function showPreview(item) {
  preview=item;
  $('ticketNumber').textContent=item.code;
  $('ticketMeta').textContent=item.used ? 'Bu QR artıq oxunub və ikinci dəfə keçərli deyil.' : 'Firestore-da qeydiyyatlıdır. QR-ni çap dizaynına yerləşdirə bilərsiniz.';
  $('ticketState').textContent=item.used?'ARTIQ OXUNUB':'FIRESTORE SAVED';
  $('ticketState').className='pill '+(item.used?'':'ok');
  $('qrcode').replaceChildren();
  if(!window.QRCode) { $('ticketMeta').textContent='QR kitabxanası yüklənmədi. İnterneti yoxlayın.';return; }
  new window.QRCode($('qrcode'),{text:item.qrPayload,width:384,height:384,colorDark:'#14233a',colorLight:'#ffffff',correctLevel:window.QRCode.CorrectLevel.M});
  $('qrEmpty').classList.add('hidden');$('copyBtn').disabled=false;$('downloadBtn').disabled=false;
}
async function createTicket() {
  if(generateBusy) return;
  if(currentEvent==='all'){notice('Yeni bilet üçün konkret bilet qrupunu seçin.');return;}
  generateBusy=true;refreshEventOptions();$('generateBtn').textContent='Firestore-a yazılır...';
  $('generateMessage').textContent='Yeni kod təhlükəsiz şəkildə yaradılır...';
  try {
    await assertOnline();
    for(let attempt=0;attempt<6;attempt++) {
      const code=cryptoCode(),qrToken=cryptoToken(),eid=currentEvent;
      const qrPayload=eid==='legacy'?`TF1|${code}|${qrToken}`:`TF2|${code}|${eid}|${qrToken}`;
      const ticketRef=doc(db,'printTickets',code);
      try {
        await runTransaction(db,async tx=>{
          const old=await tx.get(ticketRef);
          if(old.exists())throw new Error('COLLISION');
          const data={code,qrToken,qrPayload,used:false,usedAt:null,createdAt:serverTimestamp()};
          if(eid!=='legacy'){data.eventId=eid;data.createdBy=uid;}
          tx.set(ticketRef,data);
        });
        if(eid===currentEvent)showPreview({code,qrToken,qrPayload,eventId:eid,used:false});
        $('generateMessage').textContent='✓ Bilet Firestore-da uğurla yaradıldı.';
        notice(`${code} — yeni bilet yaradıldı`);return;
      }catch(e){if(e.message==='COLLISION')continue;throw e;}
    }
    throw new Error('Unikal kod yaradılmadı, yenidən cəhd edin.');
  }catch(e){$('generateMessage').textContent=errText(e);notice(errText(e));}
  finally{generateBusy=false;$('generateBtn').innerHTML='＋ &nbsp; New Generate <span>↗</span>';refreshEventOptions();}
}
async function copyCode(){if(!preview)return;try{await navigator.clipboard.writeText(preview.code);notice('Bilet nömrəsi kopyalandı.');}catch{notice('Kopyalama üçün HTTPS tələb olunur.');}}
function downloadQr() {
  if(!preview)return;
  const source=$('qrcode').querySelector('canvas');if(!source){notice('QR hələ hazır deyil.');return;}
  const exportCode=preview.code;
  const cv=document.createElement('canvas');cv.width=cv.height=1200;
  const context=cv.getContext('2d');context.fillStyle='white';context.fillRect(0,0,1200,1200);
  context.imageSmoothingEnabled=false;context.drawImage(source,80,80,1040,1040);
  cv.toBlob(blob=>{if(!blob){notice('PNG yaradıla bilmədi.');return;}
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${exportCode}-QR.png`;
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2500);
  },'image/png');
}
function filteredTickets() {
  const text=$('ticketSearch').value.trim().toUpperCase(), status=$('ticketStatusFilter').value;
  return tickets().filter(t=>(!text||(t.data.code||t.id).toUpperCase().includes(text))&&
    (status==='all'||(status==='active' && !t.data.used)||(status==='used' && !!t.data.used)));
}
function tag(status){const span=document.createElement('span');span.className=`status-chip ${status?'used':'available'}`;span.textContent=status?'Daxil olub':'Aktiv';return span;}
function cell(text,cls){const td=document.createElement('td');td.textContent=text??'—';if(cls)td.className=cls;return td;}
function renderTickets() {
  const list=$('ticketRows'),filtered=filteredTickets();
  const ids=new Set(tickets().map(t=>t.id));for(const id of selected)if(!ids.has(id))selected.delete(id);
  const max=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));page=Math.max(1,Math.min(page,max));
  const rows=filtered.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE);
  $('registryFilterCount').textContent=`${filtered.length} nəticə`;
  $('pageInfo').textContent=`${page} / ${max}`;$('tableSummary').textContent=`${tickets().length} bilet`;
  $('prevPageBtn').disabled=page===1;$('nextPageBtn').disabled=page>=max;
  $('exportTicketsBtn').disabled=!ready.tickets||exportBusy||(!filtered.length && !selected.size);
  $('selectionNote').textContent=selected.size?`${selected.size} bilet seçilib`:'Seçim yoxdursa bütün filtr nəticələri ixrac olunur';
  const sa=$('selectAllTickets');sa.checked=rows.length>0 && rows.every(t=>selected.has(t.id));sa.indeterminate=!sa.checked&&rows.some(t=>selected.has(t.id));sa.disabled=!rows.length;
  list.replaceChildren();if(!filtered.length){const tr=document.createElement('tr');const td=cell(tickets().length?'Axtarış nəticəsi yoxdur.':'Bu qrupda hələ bilet yoxdur.','table-empty');td.colSpan=6;tr.append(td);list.append(tr);return;}
  const frag=document.createDocumentFragment();
  for(const item of rows){const d=item.data,tr=document.createElement('tr');
    const chk=cell('','check-cell'), input=document.createElement('input');input.type='checkbox';input.checked=selected.has(item.id);input.setAttribute('aria-label',`${item.id} seç`);input.addEventListener('change',()=>{if(input.checked)selected.add(item.id);else selected.delete(item.id);renderTickets();});chk.append(input);
    const id=cell(d.code||item.id,'ticket-id'),stat=cell();stat.append(tag(!!d.used));
    const actions=cell();const aw=document.createElement('div');aw.className='row-actions';
    const show=document.createElement('button');show.type='button';show.textContent='QR göstər';show.addEventListener('click',async()=>{try{await assertOnline();const s=await getDocFromServer(doc(db,'printTickets',item.id));if(!s.exists())throw new Error('NOT_FOUND');showPreview(s.data());go('overview');setTimeout(()=>$('qrcode').scrollIntoView({block:'center',behavior:'smooth'}),80);}catch(e){notice(errText(e));}});
    const del=document.createElement('button');del.type='button';del.className='delete';del.textContent='Sil';del.addEventListener('click',()=>openDelete(item.id));aw.append(show,del);actions.append(aw);
    tr.append(chk,id,stat,cell(timeText(d.createdAt)),cell(timeText(d.usedAt)),actions);frag.append(tr);
  }list.append(frag);
}
function filteredAdmissions(){const term=$('admissionsSearch').value.trim().toUpperCase();return checkins().filter(({id,data})=>(data.code||id).toUpperCase().includes(term));}
function renderAdmissions(){const results=filteredAdmissions(),max=Math.max(1,Math.ceil(results.length/PAGE_SIZE));entryPage=Math.max(1,Math.min(entryPage,max));
  $('admissionsCount').textContent=`${results.length} daxilolma`;
  $('admissionsPageSummary').textContent=`${checkins().length} giriş qeydi`;
  $('admissionPageInfo').textContent=`${entryPage} / ${max}`;
  $('prevAdmissionBtn').disabled=entryPage===1;$('nextAdmissionBtn').disabled=entryPage>=max;
  $('exportAdmissionsBtn').disabled=!ready.checkins||exportBusy||!results.length;
  const root=$('admissionRows');root.replaceChildren();if(!results.length){const tr=document.createElement('tr'),td=cell('Hələ daxilolma yoxdur.','table-empty');td.colSpan=3;tr.append(td);root.append(tr);return;}
  const frag=document.createDocumentFragment();for(const item of results.slice((entryPage-1)*PAGE_SIZE,entryPage*PAGE_SIZE)){
    const tr=document.createElement('tr');tr.append(cell(item.data.code||item.id,'ticket-id'),cell(timeText(item.data.scannedAt)));const status=cell();status.append(tag(true));tr.append(status);frag.append(tr);
  }root.append(frag);
}
function openDelete(code){deletingCode=code;$('deleteCode').textContent=code;
  const used=!!entries.tickets.find(t=>t.id===code)?.data.used;
  $('usedDeleteWarning').classList.toggle('hidden',!used);$('confirmUsedDelete').checked=false;
  $('confirmDeleteBtn').disabled=used;$('deleteError').textContent='';$('deleteDialog').showModal();
}
async function performDelete(){if(!deletingCode||deletionBusy)return;const code=deletingCode;
  deletionBusy=true;$('confirmDeleteBtn').disabled=true;$('deleteError').textContent='Server əməliyyatı aparılır...';
  try{
    await assertOnline();
    const ticketRef=doc(db,'printTickets',code),checkRef=doc(db,'printCheckins',code),auditRef=doc(db,'printAudit',code);
    // Adapt to already-published v7 (no audit permissions) vs v8 (audit required).
    let auditSupported=false;
    try{await getDocFromServer(auditRef);auditSupported=true;}catch(e){if(e.code!=='permission-denied')throw e;}
    await runTransaction(db,async tx=>{
      const ticket=await tx.get(ticketRef),check=await tx.get(checkRef);
      const audit=auditSupported?await tx.get(auditRef):null; // all transaction reads before writes
      if(!ticket.exists())throw new Error('NOT_FOUND');
      if(audit?.exists())throw new Error('Bilet artıq silinib.');
      if(ticket.data().used && !$('confirmUsedDelete').checked)throw new Error('Oxunmuş bileti silmək üçün təsdiq tələb olunur.');
      if(auditSupported)tx.set(auditRef,{code,eventId:ticket.data().eventId||'legacy',usedBefore:!!ticket.data().used,deletedBy:uid,deletedAt:serverTimestamp()});
      tx.delete(ticketRef);if(check.exists())tx.delete(checkRef);
    });
    if(preview?.code===code)clearPreview();selected.delete(code);deletingCode=null;$('deleteDialog').close();notice(`${code} silindi.`);
  }catch(e){$('deleteError').textContent=errText(e);}
  finally{deletionBusy=false;$('confirmDeleteBtn').disabled=false;}
}
function scanMessage(kind,text){const el=$('scanFeedback');el.className='scan-feedback '+kind;el.textContent=text;}
function setCameraState(state){$('cameraState').textContent=state;
  $('scannerShell').classList.toggle('is-live',state==='KAMERA AKTİVDİR'||state==='YOXLANILDI');}
async function checkQr(payload){if(scannerLocked)return;scannerLocked=true;
  try{scanner?.pause(true);}catch{}
  setCameraState('YOXLANILDI');scanMessage('wait','QR serverdə yoxlanılır...');
  try{
    await assertOnline();
    const raw=String(payload||'').trim();const legacy=raw.match(TF1_RE),modern=raw.match(TF2_RE);
    if(!legacy&&!modern)throw new Error('BAD_QR');
    const code=legacy?legacy[1]:modern[1], token=legacy?legacy[2]:modern[3], qrEvent=legacy?'legacy':modern[2];
    if(qrEvent!==currentEvent)throw new Error('BAD_EVENT');
    const ticketRef=doc(db,'printTickets',code),checkRef=doc(db,'printCheckins',code);
    await runTransaction(db,async tx=>{
      const t=await tx.get(ticketRef),c=await tx.get(checkRef);
      if(!t.exists())throw new Error('NOT_FOUND');
      const d=t.data();if(entryEvent(d)!==qrEvent)throw new Error('BAD_EVENT');
      if(d.qrToken!==token||d.qrPayload!==raw)throw new Error('BAD_QR');
      if(d.used||c.exists())throw new Error('ALREADY_USED');
      tx.update(ticketRef,{used:true,usedAt:serverTimestamp()});
      const newCheck={code,scannedAt:serverTimestamp()};
      if(qrEvent!=='legacy'){newCheck.eventId=qrEvent;newCheck.scannedBy=uid;}
      tx.set(checkRef,newCheck);
    });
    if(preview?.code===code){preview.used=true;showPreview(preview);}
    scanMessage('ok',`✓ GİRİŞ TƏSDİQLƏNDİ\n${code}\nServer tərəfindən qeydə alındı.`);
  }catch(e){scanMessage('error',e.message==='ALREADY_USED'?'✕ BU BİLET ARTIQ OXUNUB\nİkinci giriş mümkün deyil.':
    e.message==='BAD_EVENT'?'✕ BAŞQA TƏDBİRİN BİLETİ\nDüzgün qr qrupunu seçin.':
    e.message==='NOT_FOUND'||e.message==='BAD_QR'?'✕ ETİBARSIZ QR\nBu kod qeydiyyatda yoxdur.':
    `✕ GİRİŞ TƏSDİQLƏNMƏDİ\n${errText(e)}`);
  }finally{if(scannerRunning){$('nextScanBtn').classList.remove('hidden');$('startScanBtn').classList.add('hidden');}}
}
async function startScanner(){if(scanner||scannerStarting||currentEvent==='all')return;
  scannerStarting=true;const nonce=++scannerNonce;refreshEventOptions();
  $('startScanBtn').textContent='Kamera açılır...';$('scannerPlaceholder').classList.remove('hidden');
  try {
    await assertOnline();
    if(!window.isSecureContext)throw new Error('Kamera üçün HTTPS tələb olunur.');
    if(!window.Html5Qrcode)throw new Error('QR kitabxanası yüklənmədi.');
    if(nonce!==scannerNonce)return;
    scanner=new window.Html5Qrcode('scannerViewport',{formatsToSupport:[window.Html5QrcodeSupportedFormats.QR_CODE],verbose:false});
    // No qrbox cropping: scan the full frame. Overlay is only visual guidance.
    await scanner.start({facingMode:'environment'},{fps:10},checkQr,()=>{});
    if(nonce!==scannerNonce||!uid){await scanner.stop();scanner.clear();scanner=null;return;}
    scannerRunning=true;scannerLocked=false;setCameraState('KAMERA AKTİVDİR');
    $('scannerPlaceholder').classList.add('hidden');$('startScanBtn').classList.add('hidden');
    $('stopScanBtn').classList.remove('hidden');$('nextScanBtn').classList.add('hidden');
    $('scanFeedback').classList.add('hidden');
    try{const c=scanner.getRunningTrackCapabilities();$('torchBtn').classList.toggle('hidden',!c.torch);}catch{$('torchBtn').classList.add('hidden');}
  }catch(e){scanMessage('error',errText(e));if(scanner){try{if(scanner.isScanning)await scanner.stop();scanner.clear();}catch{}scanner=null;}setCameraState('KAMERA BAĞLIDIR');}
  finally{scannerStarting=false;$('startScanBtn').textContent='◉ Kameranı aç';refreshEventOptions();}
}
async function stopScanner(){++scannerNonce;scannerRunning=false;scannerLocked=false;torchEnabled=false;
  const old=scanner;scanner=null;
  if(old){try{if(old.isScanning)await old.stop();old.clear();}catch{}}
  setCameraState('KAMERA BAĞLIDIR');$('scannerPlaceholder').classList.remove('hidden');
  $('startScanBtn').classList.remove('hidden');$('stopScanBtn').classList.add('hidden');
  $('nextScanBtn').classList.add('hidden');$('torchBtn').classList.add('hidden');
}
function nextScan(){if(!scannerRunning)return;scannerLocked=false;try{scanner?.resume();}catch{}setCameraState('KAMERA AKTİVDİR');
  $('nextScanBtn').classList.add('hidden');$('scanFeedback').classList.add('hidden');}
async function toggleTorch(){if(!scannerRunning)return;try{torchEnabled=!torchEnabled;await scanner.applyVideoConstraints({advanced:[{torch:torchEnabled}]});$('torchBtn').textContent=torchEnabled?'Fənəri söndür':'Fənər';}catch{torchEnabled=false;notice('Bu cihaz fənər funksiyasını dəstəkləmir.');}}
function cleanExcelValue(x){const s=String(x??'');return /^[=+@\-\t\r]/.test(s) ? "'"+s : s;}
function loadScript(url){return new Promise((resolve,reject)=>{if(window.ExcelJS){resolve();return;}const el=document.createElement('script');el.src=url;el.onload=resolve;el.onerror=()=>reject(new Error('Excel kitabxanasını yükləmək mümkün olmadı.'));document.head.append(el);});}
async function ensureExcel(){if(window.ExcelJS)return;
  try{await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js');}
  catch{await loadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js');}
  if(!window.ExcelJS)throw new Error('ExcelJS yüklənmədi.');
}
function styleExcel(ws){const row=ws.getRow(1);row.height=28;
  row.eachCell(c=>{c.font={bold:true,color:{argb:'FFFFFFFF'},size:11};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2D4F77'}};c.alignment={vertical:'middle'};});
  ws.views=[{state:'frozen',ySplit:1}];ws.autoFilter={from:{row:1,column:1},to:{row:1,column:ws.columnCount}};
  for(let i=2;i<=ws.rowCount;i++)if(i%2===0)ws.getRow(i).eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF4F8FD'}};});
}
async function saveWorkbook(rows,summary,filename,worksheetName){await ensureExcel();
  const wb=new window.ExcelJS.Workbook();wb.creator='TicketFlow QR Studio';wb.created=new Date();
  const ws=wb.addWorksheet(worksheetName,{properties:{defaultRowHeight:20}});
  const keys=Object.keys(rows[0]||summary[0]||{Bilet:'—'});
  ws.columns=keys.map(k=>({header:k,key:k,width:Math.max(18,Math.min(44,k.length+18))}));
  for(const item of rows){const safe={};for(const [k,v] of Object.entries(item))safe[k]=cleanExcelValue(v);ws.addRow(safe);}styleExcel(ws);
  const s=wb.addWorksheet('Xülasə');s.columns=[{header:'Göstərici',key:'name',width:29},{header:'Dəyər',key:'value',width:29}];
  for(const entry of summary)s.addRow({name:cleanExcelValue(entry.name),value:cleanExcelValue(entry.value)});styleExcel(s);
  const buffer=await wb.xlsx.writeBuffer();const blob=new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),4000);
}
async function exportExcel(type){if(exportBusy)return;exportBusy=true;renderTickets();renderAdmissions();
  const button=type==='tickets'?$('exportTicketsBtn'):$('exportAdmissionsBtn');const old=button.textContent;button.textContent='Excel hazırlanır...';
  try{
    await assertOnline();
    const collectionName=type==='tickets'?'printTickets':'printCheckins';const orderField=type==='tickets'?'createdAt':'scannedAt';
    const fresh=await getDocsFromServer(query(collection(db,collectionName),orderBy(orderField,'desc')));
    const list=fresh.docs.map(d=>({id:d.id,data:d.data()})).filter(({data})=>visibleEvent(data));
    let output;
    if(type==='tickets'){
      const chosen=selected.size>0;
      const term=$('ticketSearch').value.trim().toUpperCase(),status=$('ticketStatusFilter').value;
      const filtered=list.filter(({id,data})=>chosen?selected.has(id):(!term||(data.code||id).includes(term)) && (status==='all'||(status==='active'&&!data.used)||(status==='used'&&!!data.used)));
      const includeQr=$('includeQrPayload').checked;
      output=filtered.map(({id,data})=>({
        'Bilet nömrəsi':data.code||id,'Status':data.used?'Daxil olub':'Aktiv',
        'Yaradılma vaxtı':timeText(data.createdAt),'Giriş vaxtı':timeText(data.usedAt),
        'Tədbir':data.eventId||'legacy',...(includeQr?{'QR məlumatı (MƏXFİ)':data.qrPayload||''}:{})
      }));
    }else{
      const term=$('admissionsSearch').value.trim().toUpperCase();
      output=list.filter(({id,data})=>(data.code||id).toUpperCase().includes(term)).map(({id,data})=>({'Bilet nömrəsi':data.code||id,'Giriş vaxtı':timeText(data.scannedAt),'Tədbir':data.eventId||'legacy','Status':'Təsdiqlənib'}));
    }
    if(!output.length){notice('İxrac üçün heç bir qeyd yoxdur.');return;}
    const name=`TicketFlow-${type==='tickets'?'Bilet-Reyestri':'Daxilolmalar'}-${new Date().toISOString().slice(0,10)}.xlsx`;
    const summary=[{name:'Qeyd növü',value:type==='tickets'?'Biletlər':'Daxilolmalar'},{name:'Yüklənmiş sətir sayı',value:output.length},{name:'Tədbir',value:currentEvent},{name:'İxrac vaxtı',value:new Date().toLocaleString('az-AZ')}];
    await saveWorkbook(output,summary,name,type==='tickets'?'Yaradılan biletlər':'Daxilolmalar');notice('Excel faylı yükləndi.');
  }catch(e){notice(errText(e));}finally{exportBusy=false;button.textContent=old;renderTickets();renderAdmissions();}
}
function clearSession(){unsubscribeTickets?.();unsubscribeCheckins?.();unsubscribeEvents?.();unsubscribeTickets=unsubscribeCheckins=unsubscribeEvents=null;
  clearInterval(heartbeat);stopScanner();uid=null;preview=null;entries.tickets=[];entries.checkins=[];ready.tickets=false;ready.checkins=false;
  $('app').classList.add('hidden');$('auth').classList.remove('hidden');$('password').value='';setConnection('waiting');clearPreview();}
async function handleLogin(event){event.preventDefault();$('loginError').textContent='';$('loginBtn').disabled=true;
  try{await setPersistence(auth,browserSessionPersistence);await signInWithEmailAndPassword(auth,$('email').value.trim(),$('password').value);}
  catch(e){$('loginError').textContent=errText(e);}finally{$('loginBtn').disabled=false;}
}
async function handleAuth(user){if(!user){clearSession();return;}
  try{
    uid=user.uid;await assertOnline();
    $('userLabel').textContent=user.email||'Admin';$('auth').classList.add('hidden');$('app').classList.remove('hidden');
    startSubscriptions();clearInterval(heartbeat);
    heartbeat=setInterval(()=>{if(uid)assertOnline().catch(()=>{});},60000);go('overview');
  }catch(e){clearSession();$('loginError').textContent=errText(e);}
}
function attach(){
  $('loginForm').addEventListener('submit',handleLogin);
  $('logoutBtn').addEventListener('click',async()=>{await signOut(auth);});
  document.querySelectorAll('[data-view]').forEach(btn=>btn.addEventListener('click',()=>go(btn.dataset.view)));
  $('eventSelect').addEventListener('change',()=>{if(view==='scanner')stopScanner();currentEvent=$('eventSelect').value;selected.clear();page=1;entryPage=1;clearPreview();refreshEventOptions();recalc();});
  $('generateBtn').addEventListener('click',createTicket);$('copyBtn').addEventListener('click',copyCode);$('downloadBtn').addEventListener('click',downloadQr);
  $('ticketSearch').addEventListener('input',()=>{page=1;renderTickets();});$('ticketStatusFilter').addEventListener('change',()=>{page=1;renderTickets();});
  $('admissionsSearch').addEventListener('input',()=>{entryPage=1;renderAdmissions();});
  $('prevPageBtn').addEventListener('click',()=>{page--;renderTickets();});$('nextPageBtn').addEventListener('click',()=>{page++;renderTickets();});
  $('prevAdmissionBtn').addEventListener('click',()=>{entryPage--;renderAdmissions();});$('nextAdmissionBtn').addEventListener('click',()=>{entryPage++;renderAdmissions();});
  $('selectAllTickets').addEventListener('change',e=>{const rows=filteredTickets().slice((page-1)*PAGE_SIZE,page*PAGE_SIZE);rows.forEach(x=>e.target.checked?selected.add(x.id):selected.delete(x.id));renderTickets();});
  $('clearSelectionBtn').addEventListener('click',()=>{selected.clear();renderTickets();});
  $('exportTicketsBtn').addEventListener('click',()=>exportExcel('tickets'));$('exportAdmissionsBtn').addEventListener('click',()=>exportExcel('admissions'));
  $('cancelDeleteBtn').addEventListener('click',()=>$('deleteDialog').close());$('confirmDeleteBtn').addEventListener('click',performDelete);
  $('confirmUsedDelete').addEventListener('change',e=>{$('confirmDeleteBtn').disabled=!e.target.checked;});
  $('startScanBtn').addEventListener('click',startScanner);$('nextScanBtn').addEventListener('click',nextScan);
  $('stopScanBtn').addEventListener('click',stopScanner);$('torchBtn').addEventListener('click',toggleTorch);
  addEventListener('offline',()=>setConnection('down'));addEventListener('online',()=>{if(uid)assertOnline().catch(()=>{});});
}
attach();setConnection('waiting');
onAuthStateChanged(auth,user=>{handleAuth(user).catch(console.error);});
