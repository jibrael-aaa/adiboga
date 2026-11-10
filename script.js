// ==========================================
// INITIAL USER ACCOUNTS & CONFIGURATION
// ==========================================
const defaultUsers = [
  { 
    username: 'admin', 
    password: '', // password disimpan ter-hash di server (database) 
    name: 'Admin Utama', 
    role: 'superadmin', 
    crud: { create: true, read: true, update: true, delete: true },
    allowed_menus: ['dashboardView', 'masterBarangView', 'inputView', 'manufakturView', 'pdaView', 'rekonView', 'rekonReturView', 'cekStokView', 'transferApprovalView', 'laporanStokView'],
    allowed_warehouses: ['ALL']
  },
  { 
    username: 'user', 
    password: '', 
    name: 'Staff Gudang', 
    role: 'user', 
    crud: { create: true, read: true, update: false, delete: false },
    allowed_menus: ['dashboardView', 'inputView', 'pdaView', 'rekonView', 'rekonReturView', 'cekStokView', 'transferApprovalView', 'laporanStokView'],
    allowed_warehouses: ['ALL']
  }
];

const FEATURE_ACCESS_KEYS = ['export', 'import', 'pdf', 'pda_ecommerce', 'pda_retur', 'transfer_send', 'transfer_receive'];

function hasFeatureAccess(feature) {
  if (!currentUser || currentUser.role === 'superadmin') return true;
  return currentUser.crud?.[feature] !== false;
}

function requireFeatureAccess(feature, label) {
  if (hasFeatureAccess(feature)) return true;
  alert(`Akses ditolak: Anda tidak memiliki izin ${label}.`);
  return false;
}

let currentUser = null;
let deleteCallbackAction = null;
let selectedTransactionActionId = null;
let pendingTransferNoticeKey = '';
let sessionHeartbeatTimer = null;

// ==========================================
// API LAYER (api.php + MySQL)
// ==========================================
const API_URL = 'api.php';

// Daftar key appState yang disinkronkan ke server (users dikelola terpisah via save_users)
const SYNC_KEYS = [
  'transactions', 'pdaScans', 'manifest', 'stockOpnameData', 'draftOpnameData', 'returRecords',
  'pendingTransfers', 'awbPrefixRules', 'skuBarcodeRules', 'masterBarang', 'bundleMapping', 'warehouses', 'uomList',
  'kategoriProduk', 'kategoriMasukOptions', 'tujuanKeluarOptions', 'masterBOM',
  'allowNegativeStock', 'allowBackdate', 'pdaEcomWarehouse', 'pdaRequestWarehouse',
  'pdaEcomTujuan', 'pdaRequestTujuan'
];
// Key yang hanya boleh ditulis superadmin (harus sama dengan STATE_KEYS di api.php)
const SYNC_KEYS_SUPER_ONLY = [
  'skuBarcodeRules', 'masterBarang', 'bundleMapping', 'warehouses', 'uomList', 'kategoriProduk', 'kategoriMasukOptions',
  'tujuanKeluarOptions', 'masterBOM', 'allowNegativeStock', 'allowBackdate',
  'pdaEcomWarehouse', 'pdaRequestWarehouse', 'pdaEcomTujuan', 'pdaRequestTujuan'
];

let serverRevisions = {};   // revision terakhir yang diketahui per key
let serverSnapshot = {};    // JSON terakhir yang sudah tersinkron per key
let syncChain = Promise.resolve();
let isReloadingFromServer = false;

async function apiCall(action, payload = null) {
  let res;
  try {
    res = await fetch(`${API_URL}?action=${encodeURIComponent(action)}`, {
      method: payload === null ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: payload === null ? {} : { 'Content-Type': 'application/json' },
      body: payload === null ? undefined : JSON.stringify(payload)
    });
  } catch (err) {
    return { ok: false, status: 0, body: { status: 'error', message: 'Server tidak dapat dihubungi. Periksa koneksi / api.php.' } };
  }
  let body = {};
  try { body = await res.json(); } catch (err) { body = { status: 'error', message: 'Respon server tidak valid.' }; }
  return { ok: res.ok, status: res.status, body };
}

// Ambil seluruh data dari server dan timpa appState
async function loadServerState() {
  const r = await apiCall('get_state');
  if (!r.ok || r.body.status !== 'success') return r;

  const st = r.body.state || {};
  serverRevisions = r.body.revisions || {};
  serverSnapshot = {};
  appState = buildDefaultAppState(); // mulai dari default agar data user sebelumnya tidak terbawa

  SYNC_KEYS.forEach(key => {
    if (st[key] !== undefined) {
      try {
        appState[key] = JSON.parse(st[key]);
        serverSnapshot[key] = st[key];
      } catch (err) { /* abaikan data rusak, pakai default */ }
    }
  });

  normalizeAppState();
  appState.users = r.body.users || [];
  if (r.body.user) currentUser = r.body.user;
  return r;
}

// Kirim perubahan (hanya key yang berubah) ke server secara berurutan
function pushStateToServer() {
  if (!currentUser || isReloadingFromServer) return;
  const isSuper = currentUser.role === 'superadmin';
  const changes = {};
  const revs = {};

  SYNC_KEYS.forEach(key => {
    if (SYNC_KEYS_SUPER_ONLY.includes(key) && !isSuper) return;
    const json = JSON.stringify(appState[key]);
    if (serverSnapshot[key] !== json) {
      changes[key] = json;
      revs[key] = serverRevisions[key] || 0;
    }
  });
  if (Object.keys(changes).length === 0) return;

  // Anggap sudah tersinkron agar saveData berikutnya tidak mengirim ulang perubahan yang sama
  Object.keys(changes).forEach(k => { serverSnapshot[k] = changes[k]; });

  syncChain = syncChain.then(async () => {
    const r = await apiCall('save_state', { changes, revisions: revs });
    if (r.ok && r.body.status === 'success') {
      Object.assign(serverRevisions, r.body.revisions || {});
      return;
    }
    // Gagal: kembalikan snapshot supaya perubahan terkirim ulang pada saveData berikutnya
    Object.keys(changes).forEach(k => { delete serverSnapshot[k]; });
    if (r.status === 401) {
      alert('Sesi login berakhir. Silakan login kembali.');
      currentUser = null;
      showLogin();
    } else if (r.status === 409) {
      alert((r.body.message || 'Data diubah pengguna lain.') + '\nPerubahan terakhir Anda tidak tersimpan, silakan ulangi.');
      await reloadFromServer();
    } else {
      alert('GAGAL MENYIMPAN KE SERVER: ' + (r.body.message || 'Kesalahan tidak diketahui'));
      await reloadFromServer();
    }
  });
  return syncChain;
}

async function reloadFromServer() {
  isReloadingFromServer = true;
  try {
    const r = await loadServerState();
    if (r && r.ok && r.body.status === 'success') showApp();
  } finally {
    isReloadingFromServer = false;
  }
}

// Manajemen Akun hanya untuk Superadmin (server juga menolak role lain)
function requireSuperadminAccount() {
  if (currentUser && currentUser.role === 'superadmin') return true;
  alert('Akses ditolak. Manajemen Akun hanya untuk Superadmin.');
  return false;
}

// Simpan daftar akun (password plaintext hanya dikirim sekali, server yang meng-hash)
async function saveUsersToServer() {
  if (!requireSuperadminAccount()) return false;
  const payload = appState.users.map(u => ({ ...u }));
  const r = await apiCall('save_users', { users: payload });
  if (r.ok && r.body.status === 'success') {
    appState.users = r.body.users || [];
    if (r.body.user) {
      currentUser = r.body.user;
      document.getElementById('txtLoggedInUser').textContent = currentUser.name;
    }
    renderUsersTabel(pageUsers);
    return true;
  }
  alert('GAGAL MENYIMPAN AKUN: ' + (r.body.message || 'Kesalahan tidak diketahui'));
  await reloadFromServer();
  return false;
}

// Halaman yang dipakai: index.html = tampilan user, admin.html = tampilan admin & superadmin
function getCurrentLayoutType() {
  const file = (window.location.pathname.split('/').pop() || '').toLowerCase();
  return file === 'admin.html' ? 'admin' : 'user';
}

function redirectToCorrectLayout() {
  const wanted = ['admin', 'superadmin'].includes(currentUser.role) ? 'admin' : 'user';
  if (getCurrentLayoutType() === wanted) return false;
  window.location.replace(wanted === 'admin' ? 'admin.html' : 'index.html');
  return true;
}

function getGreetingText(name) {
  const h = new Date().getHours();
  const sapaan = h < 11 ? 'Selamat Pagi' : (h < 15 ? 'Selamat Siang' : (h < 18 ? 'Selamat Sore' : 'Selamat Malam'));
  const firstName = String(name || '').trim().split(/\s+/)[0] || '';
  return `${sapaan}${firstName ? ', ' + firstName : ''}!`;
}

async function handleLogin() {
  const userIn = document.getElementById('loginUsername').value.trim();
  const passIn = document.getElementById('loginPassword').value.trim();

  const r = await apiCall('login', { username: userIn, password: passIn });
  if (!(r.ok && r.body.status === 'success')) {
    return alert(r.body.message || 'Username atau password salah!');
  }

  currentUser = r.body.user;
  const s = await loadServerState();
  if (!s.ok || s.body.status !== 'success') {
    return alert(s.body.message || 'Gagal memuat data dari server.');
  }
  if (redirectToCorrectLayout()) return;
  await finishLoginSync();
}

async function handleLogout() {
  await apiCall('logout', {});
  currentUser = null;
  serverRevisions = {};
  serverSnapshot = {};
  appState = buildDefaultAppState();
  showLogin();
}

function showLogin() {
  if (sessionHeartbeatTimer) {
    clearInterval(sessionHeartbeatTimer);
    sessionHeartbeatTimer = null;
  }
  document.getElementById('loginContainer').style.display = 'flex';
  document.getElementById('appContainer').style.display = 'none';
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
}

function toggleLoginPassword() {
  const input = document.getElementById('loginPassword');
  const button = document.querySelector('.password-toggle');
  if (!input || !button) return;
  const showing = input.type === 'password';
  input.type = showing ? 'text' : 'password';
  button.textContent = showing ? 'Sembunyikan password' : 'Tampilkan password';
  button.setAttribute('aria-label', showing ? 'Sembunyikan password' : 'Tampilkan password');
}

function showApp() {
  document.body.classList.toggle('admin-layout', getCurrentLayoutType() === 'admin' && currentUser.role !== 'user');
  const greetEl = document.getElementById('adminGreeting');
  if (greetEl) greetEl.textContent = getGreetingText(currentUser.name);
  document.getElementById('loginContainer').style.display = 'none';
  document.getElementById('appContainer').style.display = document.body.classList.contains('admin-layout') ? 'grid' : 'block';
  
  document.getElementById('txtLoggedInUser').textContent = currentUser.name;
  let roleLabel = 'User Staff';
  if (currentUser.role === 'superadmin') roleLabel = 'Superadmin';
  else if (currentUser.role === 'admin') roleLabel = 'Admin Staf';
  document.getElementById('txtLoggedInRole').textContent = roleLabel;

  renderUserFormGudangCheckboxes();
  applyPermissions();
  renderAllowNegativeStockUI();
  renderAllowBackdateUI();
  renderUsersTabel();
  renderMasterDropdowns();
  renderMasterGudangTabel(pageGudang);
  renderBarangDropdownOptions();
  renderMasterGudangTabel(1);
  renderMasterTujuanKeluarTabel(1);
  renderMasterKategoriTabel(1);
  renderMasterUomTabel(1);
  renderMasterBarangTabel(1);
  renderMasterBOMTabel(1);
  renderBOMDropdownOptions();
  renderBundleMappingTabel(1);
  renderRekonsiliasi(1);
  renderTabelPrefixAWB();
  renderTabelRetur(1);
  renderTransferApproval(1);
  renderLaporanStok(1);
  updatePDAScanViewDefaults();

  const bomContainer = document.getElementById("bomItemsContainer");
  if (bomContainer && bomContainer.children.length === 0) {
    tambahBarisBOMItem();
  }
  const mfgContainer = document.getElementById("mfgItemsContainer");
  if (mfgContainer && mfgContainer.children.length === 0) {
    tambahBarisMfg();
  }

  const today = new Date().toISOString().split("T")[0];
  const tglTrans = document.getElementById("tanggalTrans");
  if(tglTrans) {
    tglTrans.value = today;
    tglTrans.onchange = updateAllRowKodeProduksiOnDateChange;
  }
  const mfgTgl = document.getElementById("mfgTanggal");
  if(mfgTgl) mfgTgl.value = today;

  openTab('dashboardView', 'Dashboard');
}

function applyPermissions() {
  const role = currentUser.role;
  const allowedMenus = currentUser.allowed_menus || ['dashboardView', 'inputView', 'pdaView', 'rekonView', 'rekonReturView', 'cekStokView', 'transferApprovalView', 'laporanStokView'];

  const menuNavMap = {
    'dashboardView': 'navDashboard',
    'masterBarangView': 'navMasterData',
    'inputView': 'navInputTrans',
    'manufakturView': 'navManufaktur',
    'pdaView': 'navPdaScan',
    'rekonView': 'navRekon',
    'rekonReturView': 'navRekonRetur',
    'cekStokView': 'navCekStok',
    'laporanStokView': 'navLaporanStok'
  };

  Object.keys(menuNavMap).forEach(viewId => {
    const btnId = menuNavMap[viewId];
    const btnEl = document.getElementById(btnId);
    if (btnEl) {
      if (role === 'superadmin' || allowedMenus.includes(viewId)) {
        btnEl.style.display = 'inline-block';
      } else {
        btnEl.style.display = 'none';
      }
    }
  });

  const saElements = document.querySelectorAll('.superadmin-only');
  saElements.forEach(el => {
    el.style.display = (role === 'superadmin') ? 'inline-block' : 'none';
  });

  // Kartu Master Akun (Manajemen Akun) hanya tampil untuk Superadmin
  const userMgmtCard = document.getElementById('tabelUsers')?.closest('.card');
  if (userMgmtCard) userMgmtCard.style.display = (role === 'superadmin') ? '' : 'none';

  document.getElementById('mainNav').style.display = 'flex';
  applyFeatureAccessUI();
  applyPdaModeAccess();
}

// Sembunyikan tombol export / import / pdf / PDA / transfer sesuai izin user (atribut data-feature)
function applyFeatureAccessUI() {
  document.querySelectorAll('[data-feature]').forEach(el => {
    const features = el.getAttribute('data-feature').split(',').map(f => f.trim());
    const allowed = features.some(f => hasFeatureAccess(f));
    el.classList.toggle('feature-locked', !allowed);
  });
}

function applyPdaModeAccess() {
  if (!hasFeatureAccess('pda_ecommerce') && hasFeatureAccess('pda_retur')) setPDAMode('Retur');
  else if (!hasFeatureAccess('pda_retur') && hasFeatureAccess('pda_ecommerce')) setPDAMode('Ecommerce');
}

async function checkSession() {
  const r = await apiCall('check_session');
  if (r.ok && r.body.status === 'success') {
    currentUser = r.body.user;
    if (redirectToCorrectLayout()) return;
    const s = await loadServerState();
    if (s.ok && s.body.status === 'success') {
      await finishLoginSync();
      return;
    }
    alert(s.body.message || 'Gagal memuat data dari server. Sesi Anda tetap aktif; silakan muat ulang halaman.');
    return;
  }
  if (r.ok && r.body.status === 'unauthenticated') {
    showLogin();
    return;
  }
  if (!r.ok || r.body.status !== 'success') {
    alert(r.body.message || 'Tidak dapat memeriksa sesi. Periksa koneksi server lalu muat ulang halaman.');
    return;
  }
}

const passInput = document.getElementById('loginPassword');
if (passInput) {
  passInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') handleLogin();
  });
}

// ==========================================
// MASTER INITIAL DATA & DATA SANITIZATION
// ==========================================
const defaultInitialMasterBarang = [
  { sku: "SKU-001", nama: "Kemasan Botol 500ml", barcode: "-", kategori_produk: "Kemasan" },
  { sku: "SKU-002", nama: "Gula Cair Sirup", barcode: "-", kategori_produk: "Bahan Baku" },
  { sku: "FG-001", nama: "Oseng Mercon Daging Gini", barcode: "-", kategori_produk: "Finish Good" },
  { sku: "FG-002", nama: "Cumi Cabe Ijo", barcode: "8993883610072", kategori_produk: "Finish Good" },
  { sku: "FG-003", nama: "Oseng Mercon Cakalang", barcode: "8993883610041", kategori_produk: "Finish Good" },
  { sku: "FG-004", nama: "Oseng Mercon Daging Rawit", barcode: "8993883610010", kategori_produk: "Finish Good" }
];

const defaultInitialBundle = [
  {
    bundle_sku: "TrioMercon-OMD2",
    items: [
      { sku: "FG-004", qty: 1 },
      { sku: "FG-003", qty: 1 },
      { sku: "FG-002", qty: 1 }
    ]
  }
];

const defaultPrefixAWB = [
  { prefix: "^SPX", name: "SHOPEE" },
  { prefix: "^JX", name: "JNT" },
  { prefix: "^JY", name: "JNT NDD" },
  { prefix: "^OS", name: "OFFLINE STORE" },
  { prefix: "^GTL", name: "GTL" },
  { prefix: "^NJVT", name: "NINJA" },
  { prefix: "^(LXA|JZ|169|007|JNAP)", name: "LAZADA" },
  { prefix: "^JJ", name: "BLIBLI" },
  { prefix: "^(MGT|MANUAL)", name: "MANUAL ORDER" },
  { prefix: "KOL", name: "KOL" },
  { prefix: "^26", name: "INSTANT SHOPEE" },
  { prefix: "^58", name: "INSTANT TIKTOK" },
  { prefix: "^(CO|TSPX)", name: "PAXEL" },
  { prefix: "^TSA", name: "ANTER AJA" },
  { prefix: "^KOMPLAIN", name: "KIRIM ULANG" },
  { prefix: "^SAMPLE", name: "PERMINTAAN" },
  { prefix: "^(57|201|PLW)", name: "JNT CARGO" },
  { prefix: "^(106|001)", name: "SENTRAL CARGO" }
];

const defaultInitialWarehouses = [
  { nama: 'Gudang Utama', ean: '8993883600001' },
  { nama: 'Gudang B', ean: '8993883600002' },
  { nama: 'Gudang C', ean: '8993883600003' }
];

function sanitizeWarehouses(rawList) {
  if (!Array.isArray(rawList)) return defaultInitialWarehouses;
  return rawList.map(item => {
    if (typeof item === 'string') {
      return { nama: item, ean: '-', sublokasi: [], subLokasiEan: {} };
    } else if (typeof item === 'object' && item !== null) {
      return {
        nama: item.nama || 'Gudang Tanpa Nama',
        ean: item.ean || '-',
        sublokasi: Array.isArray(item.sublokasi) ? item.sublokasi.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()) : [],
        subLokasiEan: item.subLokasiEan && typeof item.subLokasiEan === 'object' && !Array.isArray(item.subLokasiEan)
          ? { ...item.subLokasiEan }
          : {},
        subLokasiEanSequence: Number(item.subLokasiEanSequence) || 0
      };
    }
    return { nama: 'Gudang Utama', ean: '-', sublokasi: [], subLokasiEan: {} };
  });
}

function sanitizeBundleMapping(rawList) {
  if (!Array.isArray(rawList)) return defaultInitialBundle;
  return rawList.map(item => {
    const bSku = item.bundle_sku || item.sku_combo || item.sku || "UNKNOWN_BUNDLE";
    return {
      bundle_sku: bSku,
      items: Array.isArray(item.items) ? item.items : []
    };
  });
}

const defaultUomList = [
  { kode: 'PCS', nama: 'Pieces' }, { kode: 'BOX', nama: 'Box' }, { kode: 'PACK', nama: 'Pack' },
  { kode: 'ROLL', nama: 'Roll' }, { kode: 'KG', nama: 'Kilogram' }, { kode: 'GR', nama: 'Gram' },
  { kode: 'LTR', nama: 'Liter' }, { kode: 'MTR', nama: 'Meter' }
];

function sanitizeUomList(rawList) {
  if (!Array.isArray(rawList) || rawList.length === 0) return defaultUomList.map(u => ({ ...u }));
  return rawList.filter(u => u && u.kode).map(u => ({ kode: String(u.kode).trim().toUpperCase(), nama: u.nama || u.kode }));
}

// ==========================================
// STATE APLIKASI (sumber data utama = database via api.php)
// localStorage TIDAK lagi dipakai untuk data. Hanya dibaca sekali
// untuk migrasi dari versi lama (lihat importLegacyLocalStorage).
// ==========================================
const cloneDefault = (v) => JSON.parse(JSON.stringify(v));

function buildDefaultAppState() {
  return {
    users: [], // diisi dari server (api.php) setelah login; password tidak pernah disimpan di klien
    transactions: [],
    masterBarang: cloneDefault(defaultInitialMasterBarang),
    bundleMapping: cloneDefault(sanitizeBundleMapping(null)),
    warehouses: cloneDefault(sanitizeWarehouses(null)),
    uomList: cloneDefault(sanitizeUomList(null)),
    kategoriProduk: ['Kemasan', 'Bahan Baku', 'WIP', 'Semi Finished Good', 'Finish Good', 'Supplies'],
    kategoriMasukOptions: ['Pembelian', 'Retur Customer', 'Transfer Antar Gudang', 'Hasil Manufaktur', 'Sealing', 'Penyesuaian Stok Opname (Surplus)'],
    tujuanKeluarOptions: ['Penjualan E-Commerce', 'Pengiriman Permintaan', 'Proses Manufaktur', 'Sample Produk', 'Penyesuaian Stok Opname (Defisit)'],
    pdaScans: [],
    manifest: [],
    stockOpnameData: {},
    draftOpnameData: {},
    awbPrefixRules: cloneDefault(defaultPrefixAWB),
    skuBarcodeRules: [],
    returRecords: [],
    pendingTransfers: [],
    masterBOM: [],
    allowNegativeStock: false,
    allowBackdate: false,
    pdaEcomWarehouse: 'Gudang Utama',
    pdaRequestWarehouse: 'Gudang Utama',
    pdaEcomTujuan: 'Penjualan E-Commerce',
    pdaRequestTujuan: 'Pengiriman Permintaan'
  };
}

let appState = buildDefaultAppState();

// Normalisasi data setelah dimuat dari server / hasil impor
function normalizeAppState() {
  appState.warehouses = sanitizeWarehouses(appState.warehouses);
  ensureSubLocationBarcodes();
  appState.bundleMapping = sanitizeBundleMapping(appState.bundleMapping);
  appState.skuBarcodeRules = Array.isArray(appState.skuBarcodeRules) ? appState.skuBarcodeRules : [];
  appState.uomList = sanitizeUomList(appState.uomList);
  appState.masterBarang.forEach(b => { if (!b.uom) b.uom = 'PCS'; });
  migrateOpnameKeys();
}

// ------------------------------------------------------------
// MIGRASI SATU KALI: data lama di localStorage -> database
// Hanya untuk key yang BELUM ada di server. Server selalu menang.
// ------------------------------------------------------------
const LEGACY_LOCAL_KEYS = {
  transactions: 'erp_transactions',
  masterBarang: 'erp_master_barang',
  bundleMapping: 'erp_bundle_mapping',
  warehouses: 'erp_warehouses',
  uomList: 'erp_uom_list',
  kategoriProduk: 'erp_kategori_produk',
  kategoriMasukOptions: 'erp_kategori_masuk_opt',
  tujuanKeluarOptions: 'erp_tujuan_keluar_opt',
  pdaScans: 'erp_pda_scans',
  manifest: 'erp_manifest',
  stockOpnameData: 'erp_stock_opname',
  draftOpnameData: 'erp_draft_opname',
  awbPrefixRules: 'erp_awb_prefix_rules',
  returRecords: 'erp_retur_records',
  pendingTransfers: 'erp_pending_transfers',
  masterBOM: 'erp_master_bom',
  allowNegativeStock: 'erp_allow_negative_stock',
  allowBackdate: 'erp_allow_backdate',
  pdaEcomWarehouse: 'erp_pda_ecom_warehouse',
  pdaRequestWarehouse: 'erp_pda_request_warehouse',
  pdaEcomTujuan: 'erp_pda_ecom_tujuan',
  pdaRequestTujuan: 'erp_pda_request_tujuan'
};
const LEGACY_STRING_KEYS = ['pdaEcomWarehouse', 'pdaRequestWarehouse', 'pdaEcomTujuan', 'pdaRequestTujuan'];
const LEGACY_BOOL_KEYS = ['allowNegativeStock', 'allowBackdate'];

function importLegacyLocalStorage() {
  const imported = [];
  if (!currentUser || currentUser.role !== 'superadmin') return imported;

  Object.keys(LEGACY_LOCAL_KEYS).forEach(key => {
    if (key in serverRevisions) return; // sudah ada di server
    let raw;
    try { raw = localStorage.getItem(LEGACY_LOCAL_KEYS[key]); } catch (e) { return; }
    if (raw === null) return;

    let value;
    if (LEGACY_STRING_KEYS.includes(key)) {
      value = raw;
    } else {
      try { value = JSON.parse(raw); } catch (e) { return; }
    }
    if (value === null || value === undefined) return;
    if (LEGACY_STRING_KEYS.includes(key) && typeof value !== 'string') return;
    if (LEGACY_BOOL_KEYS.includes(key) && typeof value !== 'boolean') return;
    if (!LEGACY_STRING_KEYS.includes(key) && !LEGACY_BOOL_KEYS.includes(key) && typeof value !== 'object') return;

    appState[key] = value;
    imported.push(key);
  });

  if (imported.length) normalizeAppState();
  return imported;
}

function clearLegacyLocalStorage() {
  try {
    Object.values(LEGACY_LOCAL_KEYS).forEach(k => localStorage.removeItem(k));
    ['erp_users', 'wms_session', 'print_sj_data'].forEach(k => localStorage.removeItem(k));
  } catch (e) { /* abaikan */ }
}

// Dipanggil setelah loadServerState berhasil (login maupun pemulihan sesi)
async function finishLoginSync() {
  importLegacyLocalStorage();
  showApp();
  if (sessionHeartbeatTimer) clearInterval(sessionHeartbeatTimer);
  sessionHeartbeatTimer = setInterval(async () => {
    if (!currentUser) return;
    const r = await apiCall('check_session');
    if (r.ok && r.body.status === 'success') return;
    if (r.ok && r.body.status === 'unauthenticated') {
      currentUser = null;
      showLogin();
      alert('Sesi akun ini telah berakhir atau dibuka di perangkat lain. Silakan login kembali.');
    } else if (!r.ok && r.status !== 0) {
      console.error('Gagal memperbarui sesi:', r.body.message || 'Kesalahan server.');
    }
  }, 60 * 1000);
  if (currentUser.role === 'superadmin') {
    // Seed key yang belum ada di server + kirim hasil impor legacy
    pushStateToServer();
    await syncChain;
    const pending = Object.keys(LEGACY_LOCAL_KEYS).filter(k =>
      !(k in serverRevisions) && localStorage.getItem(LEGACY_LOCAL_KEYS[k]) !== null
    );
    if (pending.length === 0) clearLegacyLocalStorage();
  }
}

appState.masterBarang.forEach(b => { if (!b.uom) b.uom = 'PCS'; });
let pageUom = 1;
let currentPage = 1;
let pageGudang = 1;
let pageTujuanKeluar = 1;
let pageTujuanMasuk = 1;
let pageKategori = 1;
let pageBarang = 1;
let pageBundle = 1;
let pageRekon = 1;
let pageUsers = 1;
let pageRetur = 1;
let pageTransfer = 1;
let pageLaporanStok = 1;
let pageBOM = 1;

let currentUploadedBase64Image = "";

function saveData() {
  // Sumber data utama = database (api.php). Tidak ada cache localStorage lagi.
  pushStateToServer();
}

function findMasterBarang(skuOrBarcode) {
  if (!skuOrBarcode) return null;
  const clean = skuOrBarcode.trim().toLowerCase();
  return appState.masterBarang.find(b => 
    b.sku.toLowerCase() === clean || (b.barcode && b.barcode.trim().toLowerCase() === clean)
  );
}

// HELPER PECEKAN CUSTOM BACKDATE
function isBackdate(dateStr) {
  if (!dateStr) return false;
  const todayStr = new Date().toISOString().split("T")[0];
  return dateStr < todayStr;
}

// ==========================================
// FITUR KONTROL BOLEH MINUS & CUSTOM BACKDATE
// ==========================================
function toggleAllowNegativeStock() {
  appState.allowNegativeStock = !appState.allowNegativeStock;
  saveData();
  renderAllowNegativeStockUI();
  updateAllRowStockAlerts();
  alert(`Fitur Stok Minus seluruh transaksi telah di-set menjadi: ${appState.allowNegativeStock ? 'AKTIF (Boleh Minus)' : 'NON-AKTIF (Di-Blok)'}`);
}

function renderAllowNegativeStockUI() {
  const btn = document.getElementById("btnToggleAllowMinus");
  if (!btn) return;
  if (appState.allowNegativeStock) {
    btn.textContent = "Status Stok Minus: AKTIF (Boleh Minus)";
    btn.className = "btn-danger";
  } else {
    btn.textContent = "Status Stok Minus: NON-AKTIF (Di-Blok)";
    btn.className = "btn-primary";
  }
}

function toggleAllowBackdate() {
  appState.allowBackdate = !appState.allowBackdate;
  saveData();
  renderAllowBackdateUI();
  alert(`Fitur Custom Backdate seluruh transaksi telah di-set menjadi: ${appState.allowBackdate ? 'AKTIF (Diizinkan)' : 'NON-AKTIF (Di-Blok)'}`);
}

function renderAllowBackdateUI() {
  const btn = document.getElementById("btnToggleAllowBackdate");
  if (!btn) return;
  if (appState.allowBackdate) {
    btn.textContent = "Status Custom Backdate: AKTIF (Diizinkan)";
    btn.className = "btn-danger";
  } else {
    btn.textContent = "Status Custom Backdate: NON-AKTIF (Di-Blok)";
    btn.className = "btn-primary";
  }
}

function setPdaEcomWarehouse(gudangNama) {
  appState.pdaEcomWarehouse = gudangNama || '';
  saveData();
  updatePDAScanViewDefaults();
  alert('Transaksi berhasil. Pengaturan default gudang PDA E-Commerce tersimpan.');
}

function setPdaEcomTujuan(tujuanNama) {
  appState.pdaEcomTujuan = tujuanNama || '';
  saveData();
  updatePDAScanViewDefaults();
  alert('Transaksi berhasil. Pengaturan default tujuan PDA E-Commerce tersimpan.');
}

function updatePDAScanViewDefaults() {
  const lblWh = document.getElementById("lblPdaEcomWh");
  if (lblWh) lblWh.textContent = appState.pdaEcomWarehouse || 'Tidak diterapkan';

  const lblEcomTuj = document.getElementById("lblPdaEcomTujuan");
  if (lblEcomTuj) lblEcomTuj.textContent = appState.pdaEcomTujuan || 'Tidak diterapkan';

  const pdaEcomWarehouseDefault = document.getElementById("pdaEcomWarehouseDefault");
  if (pdaEcomWarehouseDefault) pdaEcomWarehouseDefault.value = appState.pdaEcomWarehouse || '';
  const pdaEcomTujuanDefault = document.getElementById("pdaEcomTujuanDefault");
  if (pdaEcomTujuanDefault) pdaEcomTujuanDefault.value = appState.pdaEcomTujuan || '';

  const pdaEcomWhSel = document.getElementById("pdaEcomGudangPilih");
  if (pdaEcomWhSel) pdaEcomWhSel.value = appState.pdaEcomWarehouse || '';
  const pdaEcomTujuanSel = document.getElementById("pdaEcomTujuanPilih");
  if (pdaEcomTujuanSel) pdaEcomTujuanSel.value = appState.pdaEcomTujuan || '';
  renderSubLocationPicker('pdaEcomSubLokasi', pdaEcomWhSel?.value || '');
}

// MODAL POP-UP GENERAL DELETE & CREATE HANDLERS
function bukaModalGeneralDelete(message, actionCallback) {
  deleteCallbackAction = actionCallback;
  document.getElementById("txtDeleteConfirmMessage").textContent = message;
  document.getElementById("modalGeneralDelete").style.display = "flex";
}

function tutupModalGeneralDelete() {
  deleteCallbackAction = null;
  document.getElementById("modalGeneralDelete").style.display = "none";
}

const btnConfirmYes = document.getElementById("btnConfirmDeleteYes");
if(btnConfirmYes) {
  btnConfirmYes.onclick = function() {
    if (typeof deleteCallbackAction === 'function') {
      deleteCallbackAction();
    }
    tutupModalGeneralDelete();
  };
}

// FUNGSI KONTROL POP-UP (MODAL) TAMBAH DATA BARU
function openModalTambahUser() {
  if (!requireSuperadminAccount()) return;
  document.getElementById("modalTambahUser").style.display = "flex";
}
function closeModalTambahUser() {
  document.getElementById("modalTambahUser").style.display = "none";
}

function openModalTambahGudang() {
  document.getElementById("modalTambahGudang").style.display = "flex";
}
function closeModalTambahGudang() {
  document.getElementById("modalTambahGudang").style.display = "none";
}

function openModalTambahTujuanKeluar() {
  document.getElementById("modalTambahTujuanKeluar").style.display = "flex";
}
function closeModalTambahTujuanKeluar() {
  document.getElementById("modalTambahTujuanKeluar").style.display = "none";
}

function openModalTambahKategori() {
  document.getElementById("modalTambahKategori").style.display = "flex";
}
function closeModalTambahKategori() {
  document.getElementById("modalTambahKategori").style.display = "none";
}

function openModalTambahMasterBarang() {
  document.getElementById("modalTambahMasterBarang").style.display = "flex";
}
function closeModalTambahMasterBarang() {
  document.getElementById("modalTambahMasterBarang").style.display = "none";
}

function openModalTambahBOM() {
  document.getElementById("modalTambahBOM").style.display = "flex";
}
function closeModalTambahBOM() {
  document.getElementById("modalTambahBOM").style.display = "none";
}

function openModalTambahBundle() {
  resetFormBundle();
  document.getElementById("modalTambahBundle").style.display = "flex";
}
function closeModalTambahBundle() {
  document.getElementById("modalTambahBundle").style.display = "none";
}

function openModalMasterTujuanKeluar() {
  renderMasterTujuanKeluarTabel(pageTujuanKeluar);
  document.getElementById("modalMasterTujuanKeluar").style.display = "flex";
}

function closeModalMasterTujuanKeluar() {
  document.getElementById("modalMasterTujuanKeluar").style.display = "none";
}

function openModalPDADefaults() {
  updatePDAScanViewDefaults();
  document.getElementById("modalPDADefaults").style.display = "flex";
}

function closeModalPDADefaults() {
  document.getElementById("modalPDADefaults").style.display = "none";
}

function simpanPDADefaults() {
  appState.pdaEcomWarehouse = document.getElementById("pdaEcomWarehouseDefault").value || '';
  appState.pdaEcomTujuan = document.getElementById("pdaEcomTujuanDefault").value || '';
  saveData();
  updatePDAScanViewDefaults();
  closeModalPDADefaults();
  alert("Transaksi berhasil. Pengaturan default PDA tersimpan.");
}

function openModalMasterTujuanMasuk() {
  renderMasterTujuanMasukTabel();
  document.getElementById("modalMasterTujuanMasuk").style.display = "flex";
}

function closeModalMasterTujuanMasuk() {
  document.getElementById("modalMasterTujuanMasuk").style.display = "none";
}

function openModalMasterKategori() {
  renderMasterKategoriTabel(pageKategori);
  document.getElementById("modalMasterKategori").style.display = "flex";
}

function closeModalMasterKategori() {
  document.getElementById("modalMasterKategori").style.display = "none";
}

function openModalMasterUom() {
  renderMasterUomTabel(pageUom);
  document.getElementById("modalMasterUom").style.display = "flex";
}

function closeModalMasterUom() {
  document.getElementById("modalMasterUom").style.display = "none";
}

function openModalMasterBundle() {
  renderBundleMappingTabel(pageBundle);
  document.getElementById("modalMasterBundle").style.display = "flex";
}

function closeModalMasterBundle() {
  document.getElementById("modalMasterBundle").style.display = "none";
}

function openModalTambahTujuanMasuk() {
  document.getElementById("tujuanMasukNama").value = "";
  document.getElementById("modalTambahTujuanMasuk").style.display = "flex";
}

function closeModalTambahTujuanMasuk() {
  document.getElementById("modalTambahTujuanMasuk").style.display = "none";
}

function openModalEditTujuanMasuk(index) {
  const tujuan = appState.kategoriMasukOptions[index];
  if (tujuan === undefined) return;
  document.getElementById("editTujuanMasukIndex").value = index;
  document.getElementById("editTujuanMasukNama").value = tujuan;
  document.getElementById("modalEditTujuanMasuk").style.display = "flex";
}

function closeModalEditTujuanMasuk() {
  document.getElementById("modalEditTujuanMasuk").style.display = "none";
}

// FORMULA KODE PRODUKSI
function generateKodeProduksi(namaBarang, dateStr = null) {
  if (!namaBarang) return '-';
  const words = namaBarang.trim().split(/\s+/);
  let prefix = words.map(w => w.charAt(0).toUpperCase()).join('');
  if (prefix.length === 1 && namaBarang.length >= 3) {
    prefix = namaBarang.substring(0, 3).toUpperCase();
  }

  let d = new Date();
  if (dateStr) {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      d = new Date(parts[0], parts[1] - 1, parts[2]);
    } else {
      d = new Date(dateStr);
    }
  }

  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);

  return `${prefix}-${mm}${dd}${yy}`;
}

// TAB NAVIGATION
function openTab(tabId, tabTitle) {
  const allowedMenus = currentUser.allowed_menus || [];
  if (currentUser.role !== 'superadmin' && !allowedMenus.includes(tabId)) {
    alert('Anda tidak memiliki hak akses untuk membuka menu ini.');
    return;
  }

  document.querySelectorAll('.main-nav button').forEach(btn => btn.classList.remove('active-nav'));
  const navBtn = Array.from(document.querySelectorAll('.main-nav button')).find(btn => btn.textContent.trim().includes(tabTitle.trim()));
  if(navBtn) navBtn.classList.add('active-nav');

  let existingTab = document.querySelector(`.tab-item[data-target="${tabId}"]`);
  if (existingTab) {
    switchTab(tabId);
    return;
  }
  const tabBar = document.getElementById("tabBar");
  const newTab = document.createElement("div");
  newTab.className = "tab-item";
  newTab.setAttribute("data-target", tabId);
  newTab.innerHTML = `${tabTitle} <span class="close-tab" onclick="closeTab(event, '${tabId}')">&times;</span>`;
  newTab.addEventListener("click", () => switchTab(tabId));
  tabBar.appendChild(newTab);
  switchTab(tabId);
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-item").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-page").forEach(p => {
    p.classList.remove("active");
    p.classList.add("hidden");
  });
  const activeTab = document.querySelector(`.tab-item[data-target="${tabId}"]`);
  const activePage = document.getElementById(tabId);
  if (activeTab) activeTab.classList.add("active");
  if (activePage) {
    activePage.classList.remove("hidden");
    activePage.classList.add("active");
  }

  if (tabId === 'dashboardView') renderDashboard(1);
  if (tabId === 'rekonView') renderRekonsiliasi(1);
  if (tabId === 'rekonReturView') renderTabelRetur(1);
  if (tabId === 'laporanStokView') renderLaporanStok(1);
  if (tabId === 'cekStokView') {
    renderCekPendingBanner();
    notifyPendingTransfers(false);
  }
  if (tabId === 'inputView' || tabId === 'cekStokView') syncTransferApprovalPanel();
}

function canAccessWarehouseName(nama) {
  if (!currentUser || currentUser.role === 'superadmin') return true;
  const allowed = currentUser.allowed_warehouses || ['ALL'];
  return allowed.includes('ALL') || allowed.includes(nama);
}

function getPendingTransferList() {
  return (appState.pendingTransfers || []).filter(transfer =>
    !String(transfer.status || '').includes('COMPLETED') &&
    (canAccessWarehouseName(transfer.gudang_asal) || canAccessWarehouseName(transfer.gudang_tujuan))
  );
}

function getPendingTransferCount() {
  return getPendingTransferList().length;
}

function notifyPendingTransfers(force = false) {
  const pending = getPendingTransferList();
  if (pending.length === 0) {
    pendingTransferNoticeKey = '';
    return;
  }
  const noticeKey = pending.map(transfer => String(transfer.id)).sort().join('|');
  if (!force && noticeKey === pendingTransferNoticeKey) return;
  pendingTransferNoticeKey = noticeKey;
  alert(`Ada ${pending.length} transaksi transfer yang masih menunggu penerimaan. Silakan proses pada panel Approval Transfer di bawah halaman ini.`);
}

function renderCekPendingBanner() {
  const box = document.getElementById('cekPendingBanner');
  if (!box) return;
  const n = getPendingTransferCount();
  if (n === 0) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  box.style.display = 'flex';
  box.innerHTML = `<span>⚠️ Ada <b>${n}</b> transaksi transfer yang masih menunggu / belum selesai. Selesaikan pada panel Approval Transfer di bawah.</span>` +
    `<button type="button" class="btn-warning" onclick="openTransferApproval()">Lihat Approval Transfer</button>`;
}

// Panel Approval Transfer bukan menu: dipasang di bawah halaman yang sedang aktif
// (Input Transaksi atau Cek Stok & Lokasi) selama ada transaksi transfer antar lokasi.
function syncTransferApprovalPanel() {
  const panel = document.getElementById('transferApprovalPanel');
  const store = document.getElementById('approvalPanelStore');
  if (!panel || !store) return;
  const total = (appState.pendingTransfers || []).length;
  const pending = getPendingTransferCount();

  const activeId = document.querySelector('.tab-page.active')?.id || '';
  const host = activeId === 'cekStokView' ? document.getElementById('approvalHostCek')
             : (activeId === 'inputView' ? document.getElementById('approvalHostInput') : null);

  if (host && total > 0) {
    if (panel.parentElement !== host) host.appendChild(panel);
    panel.style.display = 'block';
  } else {
    if (panel.parentElement !== store) store.appendChild(panel);
    panel.style.display = 'none';
  }

  const badge = document.getElementById('approvalPendingBadge');
  if (badge) {
    badge.style.display = pending > 0 ? 'inline-block' : 'none';
    badge.textContent = `${pending} menunggu`;
  }
}

function openTransferApproval() {
  notifyPendingTransfers(true);
  syncTransferApprovalPanel();
  const panel = document.getElementById('transferApprovalPanel');
  if (panel && panel.style.display !== 'none' && typeof panel.scrollIntoView === 'function') {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function closeTab(event, tabId) {
  event.stopPropagation();
  const tabElement = document.querySelector(`.tab-item[data-target="${tabId}"]`);
  const pageElement = document.getElementById(tabId);
  if (tabElement) tabElement.remove();
  if (pageElement) {
    pageElement.classList.remove("active");
    pageElement.classList.add("hidden");
  }
  
  if(tabElement.classList.contains('active')) {
    document.querySelectorAll('.main-nav button').forEach(btn => btn.classList.remove('active-nav'));
    switchTab("dashboardView");
    const dashNav = document.querySelector(".main-nav button[onclick*='dashboardView']");
    if(dashNav) dashNav.classList.add('active-nav');
  }
}

// ==========================================
// USER MANAGEMENT & FORM CHECKBOXES
// ==========================================
function normalizeAllowedWarehouseAccess(warehouses) {
  const selected = Array.isArray(warehouses) ? warehouses.filter(warehouse => typeof warehouse === 'string') : [];
  const specific = Array.from(new Set(selected.filter(warehouse => warehouse !== 'ALL')));
  return specific.length ? specific : (selected.includes('ALL') ? ['ALL'] : []);
}

function handleWarehouseAccessChange(checkbox) {
  const groupClass = checkbox.classList.contains('edit-chk-wh-access') ? 'edit-chk-wh-access' : 'chk-wh-access';
  const checkboxes = Array.from(document.querySelectorAll(`.${groupClass}`));
  const allCheckbox = checkboxes.find(item => item.value === 'ALL');

  if (!checkbox.checked) return;
  if (checkbox.value === 'ALL') {
    checkboxes.forEach(item => {
      if (item !== checkbox) item.checked = false;
    });
  } else if (allCheckbox) {
    allCheckbox.checked = false;
  }
}

function renderUserFormGudangCheckboxes() {
  const containerAdd = document.getElementById("userGudangAccessBox");
  const containerEdit = document.getElementById("editUserGudangAccessBox");

  let html = `<label style="font-weight:normal; cursor:pointer;"><input type="checkbox" class="chk-wh-access" value="ALL" checked onchange="handleWarehouseAccessChange(this)"> <b>Akses Semua Gudang</b></label>`;
  appState.warehouses.forEach(w => {
    html += `<label style="font-weight:normal; cursor:pointer;"><input type="checkbox" class="chk-wh-access" value="${cekEsc(w.nama)}" onchange="handleWarehouseAccessChange(this)"> ${cekEsc(w.nama)}</label>`;
  });
  if(containerAdd) containerAdd.innerHTML = html;

  let htmlEdit = `<label style="font-weight:normal; cursor:pointer;"><input type="checkbox" class="edit-chk-wh-access" value="ALL" onchange="handleWarehouseAccessChange(this)"> <b>Akses Semua Gudang</b></label>`;
  appState.warehouses.forEach(w => {
    htmlEdit += `<label style="font-weight:normal; cursor:pointer;"><input type="checkbox" class="edit-chk-wh-access" value="${cekEsc(w.nama)}" onchange="handleWarehouseAccessChange(this)"> ${cekEsc(w.nama)}</label>`;
  });
  if(containerEdit) containerEdit.innerHTML = htmlEdit;
}

function tambahUserBaru(e) {
  e.preventDefault();
  if (!requireSuperadminAccount()) return;
  const name = document.getElementById("usrNama").value.trim();
  const username = document.getElementById("usrUsername").value.trim().toLowerCase();
  const password = document.getElementById("usrPassword").value.trim();
  const role = document.getElementById("usrRole").value;

  const crud = {
    create: document.getElementById("chkCreate").checked,
    read: document.getElementById("chkRead").checked,
    update: document.getElementById("chkUpdate").checked,
    delete: document.getElementById("chkDelete").checked,
    ...Object.fromEntries(Array.from(document.querySelectorAll("#userFeatureAccessBox .user-feature-access"))
      .map(checkbox => [checkbox.value, checkbox.checked]))
  };

  const allowed_menus = Array.from(document.querySelectorAll("#userMenuAccessBox .chk-menu-access:checked")).map(c => c.value);
  const allowed_warehouses = normalizeAllowedWarehouseAccess(
    Array.from(document.querySelectorAll("#userGudangAccessBox .chk-wh-access:checked")).map(c => c.value)
  );

  if (appState.users.some(u => u.username === username)) {
    return alert("Username sudah digunakan!");
  }

  appState.users.push({ name, username, password, role, crud, allowed_menus, allowed_warehouses });
  saveUsersToServer().then(ok => { if (ok) alert("Akun Pengguna Berhasil Ditambahkan!"); });

  document.getElementById("usrNama").value = "";
  document.getElementById("usrUsername").value = "";
  document.getElementById("usrPassword").value = "";
  closeModalTambahUser();
  renderUsersTabel(1);
}

function renderUsersTabel(page = 1) {
  pageUsers = page;
  const tbody = document.getElementById("tabelUsers");
  if (!tbody) return;
  tbody.innerHTML = "";

  const pageSize = parseInt(document.getElementById("pageSizeUsers")?.value) || 5;
  const totalItems = appState.users.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  if (pageUsers > totalPages) pageUsers = totalPages;
  if (pageUsers < 1) pageUsers = 1;

  const startIndex = (pageUsers - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginated = sortDisplayItems(appState.users, u => u.username).slice(startIndex, endIndex);

  paginated.forEach((u, index) => {
    const realIndex = startIndex + index + 1;
    const crudBadge = [
      u.crud?.create ? '<span style="color:#16a34a; font-weight:bold;">C</span>' : '-',
      u.crud?.read ? '<span style="color:#0284c7; font-weight:bold;">R</span>' : '-',
      u.crud?.update ? '<span style="color:#d97706; font-weight:bold;">U</span>' : '-',
      u.crud?.delete ? '<span style="color:#dc2626; font-weight:bold;">D</span>' : '-'
    ].join(' | ');

    const whText = (u.allowed_warehouses && u.allowed_warehouses.includes('ALL')) ? 'Semua Gudang' : (u.allowed_warehouses ? u.allowed_warehouses.join(', ') : 'Semua Gudang');
    const menuCount = u.allowed_menus ? u.allowed_menus.length : 10;

    tbody.innerHTML += `
      <tr>
        <td class="text-center">${realIndex}</td>
        <td><b>${cekEsc(u.name)}</b></td>
        <td><code>${cekEsc(u.username)}</code></td>
        <td><span class="badge ${u.role === 'superadmin' ? 'badge-primary' : (u.role === 'admin' ? 'badge-info' : 'badge-secondary')}">${u.role.toUpperCase()}</span></td>
        <td class="text-center">${crudBadge}</td>
        <td style="font-size:12px;">
          <div><b>Menu:</b> ${menuCount} Menu Terbuka</div>
          <div><b>Gudang:</b> ${whText}</div>
        </td>
        <td class="text-center">
          <div class="action-btn-group">
            <button class="btn-warning" onclick="openModalEditUser('${u.username}')">Edit</button>
            ${u.username !== 'admin' ? `<button class="btn-danger" onclick="hapusUser('${u.username}')">Hapus</button>` : ''}
          </div>
        </td>
      </tr>
    `;
  });

  const infoEl = document.getElementById("infoUsersPage");
  const indicatorEl = document.getElementById("indicatorUsersPage");
  const btnPrev = document.getElementById("btnPrevUsers");
  const btnNext = document.getElementById("btnNextUsers");

  updatePaginationControls(pageUsers, totalPages, btnPrev, btnNext, indicatorEl, infoEl, startIndex, endIndex, totalItems);
}

function changeUsersPage(delta) {
  renderUsersTabel(pageUsers + delta);
}

function openModalEditUser(username) {
  if (!requireSuperadminAccount()) return;
  const user = appState.users.find(u => u.username === username);
  if (!user) return;

  document.getElementById("editUserOldUsername").value = user.username;
  document.getElementById("editUserNama").value = user.name;
  document.getElementById("editUserUsername").value = user.username;
  document.getElementById("editUserPassword").value = "";
  document.getElementById("editUserRole").value = user.role || 'user';

  document.getElementById("editChkCreate").checked = !!user.crud?.create;
  document.getElementById("editChkRead").checked = !!user.crud?.read;
  document.getElementById("editChkUpdate").checked = !!user.crud?.update;
  document.getElementById("editChkDelete").checked = !!user.crud?.delete;
  document.querySelectorAll("#editUserFeatureAccessBox .edit-user-feature-access").forEach(checkbox => {
    checkbox.checked = user.crud?.[checkbox.value] !== false;
  });

  const userMenus = user.allowed_menus || ['dashboardView', 'inputView', 'pdaView', 'rekonView', 'rekonReturView', 'cekStokView', 'transferApprovalView', 'laporanStokView'];
  document.querySelectorAll("#editUserMenuAccessBox .edit-chk-menu-access").forEach(chk => {
    chk.checked = userMenus.includes(chk.value);
  });

  const userWH = normalizeAllowedWarehouseAccess(user.allowed_warehouses || ['ALL']);
  document.querySelectorAll("#editUserGudangAccessBox .edit-chk-wh-access").forEach(chk => {
    chk.checked = userWH.includes(chk.value);
  });

  document.getElementById("modalEditUser").style.display = "flex";
}

function closeModalEditUser() {
  document.getElementById("modalEditUser").style.display = "none";
}

function simpanEditUser(e) {
  e.preventDefault();
  if (!requireSuperadminAccount()) return;
  const oldUsername = document.getElementById("editUserOldUsername").value;
  const newUsername = document.getElementById("editUserUsername").value.trim().toLowerCase();
  const newName = document.getElementById("editUserNama").value.trim();
  const newPassword = document.getElementById("editUserPassword").value.trim();
  const newRole = document.getElementById("editUserRole").value;

  const user = appState.users.find(u => u.username === oldUsername);
  if (user) {
    if (oldUsername !== newUsername && appState.users.some(u => u.username === newUsername)) {
      return alert("Username baru sudah terpakai!");
    }

    user.old_username = oldUsername; // agar server menjaga hash password saat username diganti
    user.name = newName;
    user.username = newUsername;
    user.password = newPassword || '';
    user.role = newRole;
    user.crud = {
      create: document.getElementById("editChkCreate").checked,
      read: document.getElementById("editChkRead").checked,
      update: document.getElementById("editChkUpdate").checked,
      delete: document.getElementById("editChkDelete").checked,
      ...Object.fromEntries(Array.from(document.querySelectorAll("#editUserFeatureAccessBox .edit-user-feature-access"))
        .map(checkbox => [checkbox.value, checkbox.checked]))
    };
    user.allowed_menus = Array.from(document.querySelectorAll("#editUserMenuAccessBox .edit-chk-menu-access:checked")).map(c => c.value);
    user.allowed_warehouses = normalizeAllowedWarehouseAccess(
      Array.from(document.querySelectorAll("#editUserGudangAccessBox .edit-chk-wh-access:checked")).map(c => c.value)
    );

    closeModalEditUser();
    renderUsersTabel(pageUsers);
    saveUsersToServer().then(ok => { if (ok) alert("Akun pengguna berhasil diperbarui!"); });
  }
}

function hapusUser(username) {
  if (!requireSuperadminAccount()) return;
  if (username === 'admin') return alert("Akun admin utama tidak dapat dihapus!");
  bukaModalGeneralDelete(`Apakah Anda yakin ingin menghapus akun pengguna "${username}"?`, () => {
    appState.users = appState.users.filter(u => u.username !== username);
    renderUsersTabel(pageUsers);
    saveUsersToServer();
  });
}

// ==========================================
// MASTER LOKASI GUDANG
// ==========================================
function tambahGudangViaMaster(e) {
  e.preventDefault();
  const nama = document.getElementById("mgNamaGudang").value.trim();
  const ean = document.getElementById("mgEanGudang").value.trim() || "-";
  if (!nama) return;

  if (appState.warehouses.some(w => w.nama.toLowerCase() === nama.toLowerCase())) {
    return alert("Nama lokasi gudang sudah terdaftar!");
  }

  appState.warehouses.push({ nama, ean, sublokasi: [], subLokasiEan: {}, subLokasiEanSequence: 0 });
  saveData();
  alert("Lokasi Gudang Berhasil Ditambahkan!");
  document.getElementById("mgNamaGudang").value = "";
  document.getElementById("mgEanGudang").value = "";
  
  closeModalTambahGudang();
  renderUserFormGudangCheckboxes();
  renderMasterGudangTabel(1);
  renderMasterDropdowns();
}

function renderMasterGudangTabel(page = 1) {
  pageGudang = page;
  const tbody = document.getElementById("tabelMasterGudang");
  if (!tbody) return;
  tbody.innerHTML = "";

  const pageSize = parseInt(document.getElementById("pageSizeGudang")?.value) || 5;
  const sortedWarehouses = appState.warehouses.map((warehouse, index) => ({ warehouse, index }))
    .sort((a, b) => a.warehouse.nama.localeCompare(b.warehouse.nama, 'id', { numeric: true, sensitivity: 'base' }));
  const totalItems = sortedWarehouses.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  if (pageGudang > totalPages) pageGudang = totalPages;
  if (pageGudang < 1) pageGudang = 1;

  const startIndex = (pageGudang - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginated = sortedWarehouses.slice(startIndex, endIndex);

  if (paginated.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#94a3b8;">Belum ada lokasi gudang yang terdaftar.</td></tr>`;
  } else {
    paginated.forEach(({ warehouse: w, index: dataIndex }, index) => {
      const displayIndex = startIndex + index + 1;

      tbody.innerHTML += `
        <tr>
          <td class="text-center">${displayIndex}</td>
          <td><b>${w.nama}</b></td>
          <td><code>${w.ean || '-'}</code></td>
          <td class="text-center">
            <div class="action-btn-group">
              <button class="btn-warning" onclick="openModalEditGudang(${dataIndex})">Edit</button>
              <button class="btn-danger" onclick="hapusMasterGudang(${dataIndex})">Hapus</button>
            </div>
          </td>
        </tr>
      `;
    });
  }

  const infoEl = document.getElementById("infoGudangPage");
  const indicatorEl = document.getElementById("indicatorGudangPage");
  const btnPrev = document.getElementById("btnPrevGudang");
  const btnNext = document.getElementById("btnNextGudang");

  updatePaginationControls(pageGudang, totalPages, btnPrev, btnNext, indicatorEl, infoEl, startIndex, endIndex, totalItems);
}

function changeMasterGudangPage(delta) {
  renderMasterGudangTabel(pageGudang + delta);
}

let subLokasiEditWarehouseIndex = -1;
let pageSubLokasi = 1;

function ean13CheckDigit(firstTwelveDigits) {
  const digits = String(firstTwelveDigits);
  if (!/^\d{12}$/.test(digits)) return '';
  const sum = Array.from(digits).reduce((total, digit, index) =>
    total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
}

function isValidEan13(value) {
  const code = String(value || '');
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === code[12];
}

function generateSubLocationEan(warehouse) {
  if (!warehouse || !/^\d{13}$/.test(String(warehouse.ean || ''))) return '';
  const prefix = warehouse.ean.slice(0, 9);
  const used = new Set(appState.warehouses.flatMap(item => [
    item.ean,
    ...Object.values(item.subLokasiEan || {})
  ]).concat(appState.masterBarang.map(product => String(product.barcode || ''))));
  let sequence = Math.max(0, Number(warehouse.subLokasiEanSequence) || 0);
  while (sequence < 999) {
    sequence += 1;
    const body = `${prefix}${String(sequence).padStart(3, '0')}`;
    const code = `${body}${ean13CheckDigit(body)}`;
    if (!used.has(code)) {
      warehouse.subLokasiEanSequence = sequence;
      return code;
    }
  }
  return '';
}

function ensureSubLocationBarcodes() {
  appState.warehouses.forEach(warehouse => {
    if (!warehouse.subLokasiEan || typeof warehouse.subLokasiEan !== 'object') warehouse.subLokasiEan = {};
    (warehouse.sublokasi || []).forEach(name => {
      if (isValidEan13(warehouse.subLokasiEan[name])) return;
      const code = generateSubLocationEan(warehouse);
      if (code) warehouse.subLokasiEan[name] = code;
    });
  });
}

function openModalSubLokasi(index = -1) {
  const warehouseSelect = document.getElementById('subLokasiGudangSelect');
  if (warehouseSelect) {
    warehouseSelect.innerHTML = sortDisplayItems(
      appState.warehouses.map((warehouse, warehouseIndex) => ({ warehouse, warehouseIndex })),
      item => item.warehouse.nama
    ).map(({ warehouse, warehouseIndex }) =>
      `<option value="${warehouseIndex}">${cekEsc(warehouse.nama)}</option>`
    ).join('');
  }
  if (index < 0 && appState.warehouses.length) index = 0;
  if (warehouseSelect && index >= 0) warehouseSelect.value = String(index);
  pilihGudangSubLokasi(index, false);
  pageSubLokasi = 1;
  renderSubLokasiTable(pageSubLokasi);
  document.getElementById('modalSubLokasi').style.display = 'flex';
}

function pilihGudangSubLokasi(index, resetPage = true) {
  const warehouseIndex = Number(index);
  const warehouse = Number.isInteger(warehouseIndex) ? appState.warehouses[warehouseIndex] : null;
  subLokasiEditWarehouseIndex = warehouse ? warehouseIndex : -1;
  document.getElementById('subLokasiGudangInfo').textContent =
    warehouse ? `Gudang: ${warehouse.nama}` : 'Tambahkan lokasi gudang terlebih dahulu.';
  document.getElementById('subLokasiNama').disabled = !warehouse;
  document.getElementById('btnSimpanSubLokasi').disabled = !warehouse;
  if (resetPage) pageSubLokasi = 1;
  resetSubLokasiForm();
  renderSubLokasiTable(pageSubLokasi);
}

function closeModalSubLokasi() {
  document.getElementById('modalSubLokasi').style.display = 'none';
  subLokasiEditWarehouseIndex = -1;
}

function resetSubLokasiForm() {
  document.getElementById('subLokasiNama').value = '';
  document.getElementById('subLokasiEditIndex').value = '';
  document.getElementById('btnSimpanSubLokasi').textContent = '+ Tambah Sub Lokasi';
}

function renderSubLokasiTable(page = 1) {
  const warehouse = appState.warehouses[subLokasiEditWarehouseIndex];
  const tbody = document.getElementById('tabelSubLokasi');
  if (!tbody) return;
  const entries = warehouse && Array.isArray(warehouse.sublokasi) ? warehouse.sublokasi : [];
  const sortedEntries = entries.map((name, index) => ({ name, index }))
    .sort((a, b) => compareDisplayValues(a.name, b.name));
  const pageSize = parseInt(document.getElementById('pageSizeSubLokasi')?.value, 10) || 5;
  const totalItems = sortedEntries.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  pageSubLokasi = Math.min(Math.max(page, 1), totalPages);
  const startIndex = (pageSubLokasi - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginated = sortedEntries.slice(startIndex, endIndex);

  tbody.innerHTML = paginated.length ? paginated.map(({ name, index }, rowIndex) => `
    <tr>
      <td>${startIndex + rowIndex + 1}</td><td>${cekEsc(name)}</td>
      <td><code>${cekEsc(warehouse.subLokasiEan?.[name] || '-')}</code></td>
      <td class="text-center"><div class="action-btn-group">
        <button type="button" class="btn-warning" onclick="editSubLokasi(${index})">Edit</button>
        <button type="button" class="btn-danger" onclick="hapusSubLokasi(${index})">Hapus</button>
      </div></td>
    </tr>`).join('') : '<tr><td colspan="4" class="cek-empty">Belum ada sub lokasi. Penggunaan sub lokasi bersifat opsional.</td></tr>';

  updatePaginationControls(
    pageSubLokasi, totalPages,
    document.getElementById('btnPrevSubLokasi'), document.getElementById('btnNextSubLokasi'),
    document.getElementById('indicatorSubLokasiPage'), document.getElementById('infoSubLokasiPage'),
    startIndex, endIndex, totalItems
  );
}

function changeSubLokasiPage(delta) {
  renderSubLokasiTable(pageSubLokasi + delta);
}

function simpanSubLokasi(event) {
  event.preventDefault();
  const warehouse = appState.warehouses[subLokasiEditWarehouseIndex];
  const name = document.getElementById('subLokasiNama').value.trim();
  if (!warehouse || !name) return;
  if (!Array.isArray(warehouse.sublokasi)) warehouse.sublokasi = [];
  if (!warehouse.subLokasiEan || typeof warehouse.subLokasiEan !== 'object') warehouse.subLokasiEan = {};
  const editIndex = document.getElementById('subLokasiEditIndex').value;
  const oldName = editIndex === '' ? '' : warehouse.sublokasi[Number(editIndex)];
  if (warehouse.sublokasi.some((item, index) => item.toLowerCase() === name.toLowerCase() && index !== Number(editIndex))) {
    return alert('Nama sub lokasi sudah terdaftar di gudang ini.');
  }
  if (editIndex === '') {
    const barcode = generateSubLocationEan(warehouse);
    if (!barcode) {
      return alert('EAN sub lokasi tidak dapat dibuat. Pastikan EAN gudang terdiri dari 13 digit angka dan nomor sub lokasi belum mencapai batas 999.');
    }
    warehouse.sublokasi.push(name);
    warehouse.subLokasiEan[name] = barcode;
  } else {
    warehouse.sublokasi[Number(editIndex)] = name;
    if (warehouse.subLokasiEan[oldName]) {
      warehouse.subLokasiEan[name] = warehouse.subLokasiEan[oldName];
      delete warehouse.subLokasiEan[oldName];
    }
    appState.transactions.forEach(transaction => {
      if (transaction.gudang === warehouse.nama && transaction.sub_lokasi === oldName) transaction.sub_lokasi = name;
    });
    appState.pendingTransfers.forEach(transfer => {
      if (transfer.gudang_asal === warehouse.nama && transfer.sub_lokasi_asal === oldName) transfer.sub_lokasi_asal = name;
      if (transfer.gudang_tujuan === warehouse.nama && transfer.sub_lokasi_tujuan === oldName) transfer.sub_lokasi_tujuan = name;
    });
  }
  saveData();
  resetSubLokasiForm();
  renderSubLokasiTable();
  renderSubLocationPickers();
}

function editSubLokasi(index) {
  const warehouse = appState.warehouses[subLokasiEditWarehouseIndex];
  if (!warehouse || !warehouse.sublokasi[index]) return;
  document.getElementById('subLokasiNama').value = warehouse.sublokasi[index];
  document.getElementById('subLokasiEditIndex').value = String(index);
  document.getElementById('btnSimpanSubLokasi').textContent = 'Simpan Perubahan';
}

function hapusSubLokasi(index) {
  const warehouse = appState.warehouses[subLokasiEditWarehouseIndex];
  if (!warehouse || !warehouse.sublokasi[index]) return;
  const name = warehouse.sublokasi[index];
  if (appState.transactions.some(transaction => transaction.gudang === warehouse.nama && transaction.sub_lokasi === name) ||
      appState.pendingTransfers.some(transfer =>
        (transfer.gudang_asal === warehouse.nama && transfer.sub_lokasi_asal === name) ||
        (transfer.gudang_tujuan === warehouse.nama && transfer.sub_lokasi_tujuan === name)
      )) {
    return alert('Sub lokasi ini sudah dipakai pada transaksi dan tidak dapat dihapus. Edit nama jika perlu.');
  }
  bukaModalGeneralDelete(`Hapus sub lokasi "${name}" dari ${warehouse.nama}?`, () => {
    warehouse.sublokasi.splice(index, 1);
    delete warehouse.subLokasiEan[name];
    saveData();
    renderSubLokasiTable();
    renderSubLocationPickers();
  });
}

function renderSubLocationPicker(selectId, warehouseName, selectedValue = '') {
  const select = document.getElementById(selectId);
  if (!select) return;
  const warehouse = appState.warehouses.find(item => item.nama === warehouseName);
  const names = warehouse && Array.isArray(warehouse.sublokasi) ? warehouse.sublokasi : [];
  const options = ['<option value="">-- Tanpa Sub Lokasi --</option>'].concat(names.map(name =>
    `<option value="${cekEsc(name)}">${cekEsc(name)}</option>`
  ));
  select.innerHTML = options.join('');
  select.value = names.includes(selectedValue) ? selectedValue : '';
  const wrapper = select.closest('div');
  if (wrapper) {
    const isTransferDestination = selectId === 'selectSubLokasiTujuan';
    const show = names.length && (!isTransferDestination || document.getElementById('tipeTrans')?.value === 'TRANSFER');
    wrapper.style.display = show ? '' : 'none';
  }
}

function getSubLocations(warehouseName) {
  const warehouse = appState.warehouses.find(item => item.nama === warehouseName);
  return warehouse && Array.isArray(warehouse.sublokasi) ? warehouse.sublokasi : [];
}

function renderSubLocationPickers() {
  [
    ['selectSubLokasiMain', document.getElementById('selectGudangMain')?.value || ''],
    ['mfgSubLokasi', document.getElementById('mfgGudang')?.value || ''],
    ['cekTrfSubLokasi', document.getElementById('cekTrfGudang')?.value || ''],
    ['cekTrfTujuanSubLokasi', document.getElementById('cekTrfTujuan')?.value || ''],
    ['selectSubLokasiTujuan', document.getElementById('selectGudangTujuan')?.value || ''],
    ['cekScanSubLokasi', document.getElementById('cekScanWarehouse')?.value || ''],
    ['cekScanDestinationSubLokasi', document.getElementById('cekScanDestination')?.value || ''],
    ['pdaEcomSubLokasi', document.getElementById('pdaEcomGudangPilih')?.value || ''],
    ['pdaReturSubLokasi', document.getElementById('pdaReturGudang')?.value || '']
  ].forEach(([id, warehouse]) => renderSubLocationPicker(id, warehouse));
}

function openModalEditGudang(index) {
  const gudang = appState.warehouses[index];
  if (!gudang) return;
  document.getElementById("editGudangIndex").value = index;
  document.getElementById("editGudangNama").value = gudang.nama;
  document.getElementById("editGudangEan").value = gudang.ean !== '-' ? gudang.ean : '';
  document.getElementById("modalEditGudang").style.display = "flex";
}

function closeModalEditGudang() {
  document.getElementById("modalEditGudang").style.display = "none";
}

function simpanEditMasterGudang(e) {
  e.preventDefault();
  const index = parseInt(document.getElementById("editGudangIndex").value);
  const namaBaru = document.getElementById("editGudangNama").value.trim();
  const eanBaru = document.getElementById("editGudangEan").value.trim() || "-";

  if (namaBaru && index >= 0 && index < appState.warehouses.length) {
    const isDuplicate = appState.warehouses.some((w, idx) => idx !== index && w.nama.toLowerCase() === namaBaru.toLowerCase());
    if (isDuplicate) return alert("Nama lokasi gudang sudah terdaftar!");

    const oldNama = appState.warehouses[index].nama;
    appState.warehouses[index] = { ...appState.warehouses[index], nama: namaBaru, ean: eanBaru };

    if (oldNama !== namaBaru) {
      if (appState.pdaEcomWarehouse === oldNama) appState.pdaEcomWarehouse = namaBaru;
      if (appState.pdaRequestWarehouse === oldNama) appState.pdaRequestWarehouse = namaBaru;

      appState.transactions.forEach(t => {
        if (t.gudang === oldNama) t.gudang = namaBaru;
      });
      appState.pendingTransfers.forEach(transfer => {
        if (transfer.gudang_asal === oldNama) transfer.gudang_asal = namaBaru;
        if (transfer.gudang_tujuan === oldNama) transfer.gudang_tujuan = namaBaru;
      });
    }

    saveData();
    closeModalEditGudang();
    renderUserFormGudangCheckboxes();
    renderMasterGudangTabel(pageGudang);
    renderMasterDropdowns();
    updatePDAScanViewDefaults();
    alert("Lokasi gudang berhasil diperbarui!");
  }
}

function hapusMasterGudang(index) {
  const gudangObj = appState.warehouses[index];
  bukaModalGeneralDelete(`Apakah Anda yakin ingin menghapus lokasi gudang "${gudangObj.nama}"?`, () => {
    appState.warehouses.splice(index, 1);
    saveData();
    renderUserFormGudangCheckboxes();
    renderMasterGudangTabel(pageGudang);
    renderMasterDropdowns();
    updatePDAScanViewDefaults();
  });
}

// ==========================================
// MASTER TUJUAN KELUAR
// ==========================================
function tambahTujuanKeluarMaster(e) {
  e.preventDefault();
  const nama = document.getElementById("mtNamaTujuan").value.trim();
  if (!nama) return;

  if (appState.tujuanKeluarOptions.some(t => t.toLowerCase() === nama.toLowerCase())) {
    return alert("Nama Tujuan Keluar sudah terdaftar!");
  }

  appState.tujuanKeluarOptions.push(nama);
  saveData();
  alert("Tujuan Keluar Berhasil Ditambahkan!");
  document.getElementById("mtNamaTujuan").value = "";

  closeModalTambahTujuanKeluar();
  renderMasterTujuanKeluarTabel(1);
}

function renderMasterTujuanKeluarTabel(page = 1) {
  pageTujuanKeluar = page;
  const tbody = document.getElementById("tabelMasterTujuanKeluar");
  if (!tbody) return;
  tbody.innerHTML = "";

  const pageSize = parseInt(document.getElementById("pageSizeTujuanKeluar")?.value) || 5;
  const sortedTujuan = appState.tujuanKeluarOptions.map((tujuan, index) => ({ tujuan, index }))
    .sort((a, b) => compareDisplayValues(a.tujuan, b.tujuan));
  const totalItems = sortedTujuan.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  if (pageTujuanKeluar > totalPages) pageTujuanKeluar = totalPages;
  if (pageTujuanKeluar < 1) pageTujuanKeluar = 1;

  const startIndex = (pageTujuanKeluar - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginated = sortedTujuan.slice(startIndex, endIndex);

  if (paginated.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#94a3b8;">Belum ada master tujuan keluar terdaftar.</td></tr>`;
  } else {
    paginated.forEach(({ tujuan: t, index: dataIndex }, index) => {
      const displayIndex = startIndex + index;

      tbody.innerHTML += `
        <tr>
          <td class="text-center">${displayIndex + 1}</td>
          <td><b>${t}</b></td>
          <td class="text-center">
            <div class="action-btn-group">
              <button class="btn-warning" onclick="openModalEditTujuanKeluar(${dataIndex})">Edit</button>
              <button class="btn-danger" onclick="hapusMasterTujuanKeluar(${dataIndex})">Hapus</button>
            </div>
          </td>
        </tr>
      `;
    });
  }

  const infoEl = document.getElementById("infoTujuanKeluarPage");
  const indicatorEl = document.getElementById("indicatorTujuanKeluarPage");
  const btnPrev = document.getElementById("btnPrevTujuanKeluar");
  const btnNext = document.getElementById("btnNextTujuanKeluar");

  updatePaginationControls(pageTujuanKeluar, totalPages, btnPrev, btnNext, indicatorEl, infoEl, startIndex, endIndex, totalItems);
}

function changeMasterTujuanKeluarPage(delta) {
  renderMasterTujuanKeluarTabel(pageTujuanKeluar + delta);
}

function openModalEditTujuanKeluar(index) {
  const nama = appState.tujuanKeluarOptions[index];
  if (nama === undefined) return;
  document.getElementById("editTujuanIndex").value = index;
  document.getElementById("editTujuanNama").value = nama;
  document.getElementById("modalEditTujuanKeluar").style.display = "flex";
}

function closeModalEditTujuanKeluar() {
  document.getElementById("modalEditTujuanKeluar").style.display = "none";
}

function simpanEditMasterTujuanKeluar(e) {
  e.preventDefault();
  const index = parseInt(document.getElementById("editTujuanIndex").value);
  const namaBaru = document.getElementById("editTujuanNama").value.trim();

  if (namaBaru && index >= 0 && index < appState.tujuanKeluarOptions.length) {
    const isDuplicate = appState.tujuanKeluarOptions.some((t, idx) => idx !== index && t.toLowerCase() === namaBaru.toLowerCase());
    if (isDuplicate) return alert("Nama tujuan keluar sudah terdaftar!");

    const oldNama = appState.tujuanKeluarOptions[index];
    appState.tujuanKeluarOptions[index] = namaBaru;

    if (appState.pdaEcomTujuan === oldNama) appState.pdaEcomTujuan = namaBaru;
    if (appState.pdaRequestTujuan === oldNama) appState.pdaRequestTujuan = namaBaru;

    saveData();
    closeModalEditTujuanKeluar();
    renderMasterTujuanKeluarTabel(pageTujuanKeluar);
    updatePDAScanViewDefaults();
    alert("Tujuan Keluar berhasil diperbarui!");
  }
}

function hapusMasterTujuanKeluar(index) {
  const nama = appState.tujuanKeluarOptions[index];
  bukaModalGeneralDelete(`Apakah Anda yakin ingin menghapus Tujuan Keluar "${nama}"?`, () => {
    appState.tujuanKeluarOptions.splice(index, 1);
    saveData();
    renderMasterTujuanKeluarTabel(pageTujuanKeluar);
    updatePDAScanViewDefaults();
  });
}

function renderMasterTujuanMasukTabel(page = 1) {
  pageTujuanMasuk = page;
  const tbody = document.getElementById("tabelMasterTujuanMasuk");
  if (!tbody) return;
  const sortedItems = appState.kategoriMasukOptions.map((nama, index) => ({ nama, index }))
    .sort((a, b) => compareDisplayValues(a.nama, b.nama));
  const pageSize = parseInt(document.getElementById("pageSizeTujuanMasuk")?.value) || 5;
  const totalItems = sortedItems.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  pageTujuanMasuk = Math.min(Math.max(pageTujuanMasuk, 1), totalPages);
  const startIndex = (pageTujuanMasuk - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  if (sortedItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="cek-empty">Belum ada tujuan masuk.</td></tr>`;
  } else {
    tbody.innerHTML = sortedItems.slice(startIndex, endIndex).map(({ nama, index }, rowIndex) => `<tr>
      <td>${startIndex + rowIndex + 1}</td>
      <td>${cekEsc(nama)}</td>
      <td class="text-center"><div class="action-btn-group">
        <button class="btn-warning" onclick="openModalEditTujuanMasuk(${index})">Edit</button>
        <button class="btn-danger" onclick="hapusTujuanMasuk(${index})">Hapus</button>
      </div></td>
    </tr>`).join('');
  }

  updatePaginationControls(
    pageTujuanMasuk, totalPages,
    document.getElementById("btnPrevTujuanMasuk"), document.getElementById("btnNextTujuanMasuk"),
    document.getElementById("indicatorTujuanMasukPage"), document.getElementById("infoTujuanMasukPage"),
    startIndex, endIndex, totalItems
  );
}

function changeMasterTujuanMasukPage(delta) {
  renderMasterTujuanMasukTabel(pageTujuanMasuk + delta);
}

function tambahTujuanMasuk(e) {
  e.preventDefault();
  const nama = document.getElementById("tujuanMasukNama").value.trim();
  if (!nama) return;
  if (appState.kategoriMasukOptions.some(item => item.toLowerCase() === nama.toLowerCase())) {
    return alert("Nama tujuan masuk sudah terdaftar!");
  }
  appState.kategoriMasukOptions.push(nama);
  saveData();
  closeModalTambahTujuanMasuk();
  renderMasterTujuanMasukTabel(1);
  renderMasterDropdowns();
  alert("Tujuan masuk berhasil ditambahkan.");
}

function simpanEditTujuanMasuk(e) {
  e.preventDefault();
  const index = Number(document.getElementById("editTujuanMasukIndex").value);
  const nama = document.getElementById("editTujuanMasukNama").value.trim();
  if (!nama || index < 0 || index >= appState.kategoriMasukOptions.length) return;
  if (appState.kategoriMasukOptions.some((item, itemIndex) => itemIndex !== index && item.toLowerCase() === nama.toLowerCase())) {
    return alert("Nama tujuan masuk sudah terdaftar!");
  }
  appState.kategoriMasukOptions[index] = nama;
  saveData();
  closeModalEditTujuanMasuk();
  renderMasterTujuanMasukTabel(pageTujuanMasuk);
  renderMasterDropdowns();
  alert("Tujuan masuk berhasil diperbarui.");
}

function hapusTujuanMasuk(index) {
  const nama = appState.kategoriMasukOptions[index];
  if (nama === undefined) return;
  bukaModalGeneralDelete(`Apakah Anda yakin ingin menghapus Tujuan Masuk "${nama}"?`, () => {
    appState.kategoriMasukOptions.splice(index, 1);
    saveData();
    renderMasterTujuanMasukTabel(pageTujuanMasuk);
    renderMasterDropdowns();
  });
}

// ==========================================
// MASTER KATEGORI PRODUK
// ==========================================
function tambahKategoriViaMaster(e) {
  e.preventDefault();
  const nama = document.getElementById("mkNamaKategori").value.trim();
  if (!nama) return;

  if (appState.kategoriProduk.some(k => k.toLowerCase() === nama.toLowerCase())) {
    return alert("Nama Kategori Produk sudah terdaftar!");
  }

  appState.kategoriProduk.push(nama);
  saveData();
  alert("Kategori Produk Berhasil Ditambahkan!");
  document.getElementById("mkNamaKategori").value = "";

  closeModalTambahKategori();
  renderMasterKategoriTabel(1);
  renderMasterDropdowns();
}

function renderMasterKategoriTabel(page = 1) {
  pageKategori = page;
  const tbody = document.getElementById("tabelMasterKategori");
  if (!tbody) return;
  tbody.innerHTML = "";

  const pageSize = parseInt(document.getElementById("pageSizeKategori")?.value) || 5;
  const searchTerm = (document.getElementById("searchMasterKategori")?.value || '').trim().toLowerCase();
  const usageFilter = document.getElementById("filterMasterKategoriUsage")?.value || '';
  const sortedKategori = appState.kategoriProduk.map((kategori, index) => ({ kategori, index }))
    .filter(({ kategori }) => {
      const isUsed = appState.masterBarang.some(product => product.kategori_produk === kategori);
      return (!searchTerm || kategori.toLowerCase().includes(searchTerm)) &&
        (!usageFilter || (usageFilter === 'used' ? isUsed : !isUsed));
    })
    .sort((a, b) => compareDisplayValues(a.kategori, b.kategori));
  const totalItems = sortedKategori.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  if (pageKategori > totalPages) pageKategori = totalPages;
  if (pageKategori < 1) pageKategori = 1;

  const startIndex = (pageKategori - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginated = sortedKategori.slice(startIndex, endIndex);

  if (paginated.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#94a3b8;">Belum ada kategori produk terdaftar.</td></tr>`;
  } else {
    paginated.forEach(({ kategori: k, index: dataIndex }, index) => {
      const displayIndex = startIndex + index;
      tbody.innerHTML += `
        <tr>
          <td class="text-center">${displayIndex + 1}</td>
          <td><b>${k}</b></td>
          <td class="text-center">
            <div class="action-btn-group">
              <button class="btn-warning" onclick="openModalEditKategori(${dataIndex})">Edit</button>
              <button class="btn-danger" onclick="hapusMasterKategori(${dataIndex})">Hapus</button>
            </div>
          </td>
        </tr>
      `;
    });
  }

  const infoEl = document.getElementById("infoKategoriPage");
  const indicatorEl = document.getElementById("indicatorKategoriPage");
  const btnPrev = document.getElementById("btnPrevKategori");
  const btnNext = document.getElementById("btnNextKategori");

  updatePaginationControls(pageKategori, totalPages, btnPrev, btnNext, indicatorEl, infoEl, startIndex, endIndex, totalItems);
}

function changeMasterKategoriPage(delta) {
  renderMasterKategoriTabel(pageKategori + delta);
}

function openModalEditKategori(index) {
  const katNama = appState.kategoriProduk[index];
  if (katNama === undefined) return;

  document.getElementById("editKategoriIndex").value = index;
  document.getElementById("editKategoriNama").value = katNama;
  document.getElementById("modalEditKategori").style.display = "flex";
}

function closeModalEditKategori() {
  document.getElementById("modalEditKategori").style.display = "none";
}

function simpanEditMasterKategori(e) {
  e.preventDefault();
  const index = parseInt(document.getElementById("editKategoriIndex").value);
  const namaBaru = document.getElementById("editKategoriNama").value.trim();

  if (namaBaru && index >= 0 && index < appState.kategoriProduk.length) {
    const oldNama = appState.kategoriProduk[index];
    const isDuplicate = appState.kategoriProduk.some((k, idx) => idx !== index && k.toLowerCase() === namaBaru.toLowerCase());
    if (isDuplicate) return alert("Nama kategori produk sudah terdaftar!");

    appState.kategoriProduk[index] = namaBaru;

    appState.masterBarang.forEach(b => {
      if (b.kategori_produk === oldNama) b.kategori_produk = namaBaru;
    });

    saveData();
    closeModalEditKategori();
    renderMasterKategoriTabel(pageKategori);
    renderMasterBarangTabel(pageBarang);
    renderMasterDropdowns();
    alert("Kategori Produk berhasil diperbarui!");
  }
}

function hapusMasterKategori(index) {
  const namaKat = appState.kategoriProduk[index];
  bukaModalGeneralDelete(`Apakah Anda yakin ingin menghapus Kategori Produk "${namaKat}"?`, () => {
    appState.kategoriProduk.splice(index, 1);
    saveData();
    renderMasterKategoriTabel(pageKategori);
    renderMasterDropdowns();
  });
}

// ==========================================
// MASTER UNIT OF MATERIAL (UoM)
// ==========================================
function uomOf(sku) {
  const b = sku ? findMasterBarang(String(sku)) : null;
  return b && b.uom ? b.uom : 'PCS';
}

function sumByUom(list, skuKey, qtyKey) {
  const totals = {};
  list.forEach(x => {
    const u = uomOf(x[skuKey]);
    totals[u] = (totals[u] || 0) + Number(x[qtyKey] || 0);
  });
  const parts = Object.keys(totals).map(u => `${Math.round(totals[u] * 10000) / 10000} ${u}`);
  return parts.length ? parts.join(', ') : '0 PCS';
}

function getUomOptionsHtml(selected) {
  if (appState.uomList.length === 0) return `<option value="PCS">PCS - Pieces</option>`;
  return sortDisplayItems(appState.uomList, u => u.kode).map(u => `<option value="${cekEsc(u.kode)}"${u.kode === selected ? ' selected' : ''}>${cekEsc(u.kode)} - ${cekEsc(u.nama)}</option>`).join('');
}

function refreshRowUomTags() {
  document.querySelectorAll(".row-uom-tag").forEach(tag => {
    const row = tag.closest(".item-row, .bundle-row, .bom-item-row, .edit-bom-item-row");
    const sel = row ? row.querySelector("select.row-sku-select") : null;
    tag.textContent = sel && sel.value ? `(${uomOf(sel.value)})` : '(UoM)';
  });
}

document.addEventListener('change', function(e) {
  if (e.target && e.target.classList && e.target.classList.contains('row-sku-select')) refreshRowUomTags();
});

function openModalTambahUom() {
  document.getElementById("modalTambahUom").style.display = "flex";
}

function closeModalTambahUom() {
  document.getElementById("modalTambahUom").style.display = "none";
}

function tambahUomViaMaster(e) {
  e.preventDefault();
  const kode = document.getElementById("muKode").value.trim().toUpperCase();
  const nama = document.getElementById("muNama").value.trim();
  if (!kode || !nama) return;

  if (appState.uomList.some(u => u.kode === kode)) return alert("Kode UoM sudah terdaftar!");

  appState.uomList.push({ kode, nama });
  saveData();
  document.getElementById("muKode").value = "";
  document.getElementById("muNama").value = "";
  closeModalTambahUom();
  renderMasterUomTabel(1);
  renderMasterDropdowns();
  alert("Unit of Material (UoM) berhasil ditambahkan!");
}

function renderMasterUomTabel(page = 1) {
  pageUom = page;
  const tbody = document.getElementById("tabelMasterUom");
  if (!tbody) return;
  tbody.innerHTML = "";

  const pageSize = parseInt(document.getElementById("pageSizeUom")?.value) || 5;
  const searchTerm = (document.getElementById("searchMasterUom")?.value || '').trim().toLowerCase();
  const usageFilter = document.getElementById("filterMasterUomUsage")?.value || '';
  const sortedUom = appState.uomList.map((uom, index) => ({ uom, index }))
    .filter(({ uom }) => {
      const isUsed = appState.masterBarang.some(product => (product.uom || 'PCS') === uom.kode);
      const searchable = `${uom.kode || ''} ${uom.nama || ''}`.toLowerCase();
      return (!searchTerm || searchable.includes(searchTerm)) &&
        (!usageFilter || (usageFilter === 'used' ? isUsed : !isUsed));
    })
    .sort((a, b) => compareDisplayValues(a.uom.kode, b.uom.kode));
  const totalItems = sortedUom.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  if (pageUom > totalPages) pageUom = totalPages;
  if (pageUom < 1) pageUom = 1;

  const startIndex = (pageUom - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginated = sortedUom.slice(startIndex, endIndex);

  if (paginated.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#94a3b8;">Tidak ada UoM yang cocok dengan filter.</td></tr>`;
  } else {
    paginated.forEach(({ uom: u, index: dataIndex }, index) => {
      const displayIndex = startIndex + index;
      const used = appState.masterBarang.filter(b => (b.uom || 'PCS') === u.kode).length;
      tbody.innerHTML += `
        <tr>
          <td class="text-center">${displayIndex + 1}</td>
          <td><span class="badge badge-info">${cekEsc(u.kode)}</span></td>
          <td><b>${cekEsc(u.nama)}</b></td>
          <td class="text-center">${used} produk</td>
          <td class="text-center">
            <div class="action-btn-group">
              <button class="btn-warning" onclick="openModalEditUom(${dataIndex})">Edit</button>
              <button class="btn-danger" onclick="hapusMasterUom(${dataIndex})">Hapus</button>
            </div>
          </td>
        </tr>
      `;
    });
  }

  updatePaginationControls(
    pageUom, totalPages,
    document.getElementById("btnPrevUom"), document.getElementById("btnNextUom"),
    document.getElementById("indicatorUomPage"), document.getElementById("infoUomPage"),
    startIndex, endIndex, totalItems
  );
}

function changeMasterUomPage(delta) {
  renderMasterUomTabel(pageUom + delta);
}

function openModalEditUom(index) {
  const u = appState.uomList[index];
  if (!u) return;
  document.getElementById("editUomIndex").value = index;
  document.getElementById("editUomKode").value = u.kode;
  document.getElementById("editUomNama").value = u.nama;
  document.getElementById("modalEditUom").style.display = "flex";
}

function closeModalEditUom() {
  document.getElementById("modalEditUom").style.display = "none";
}

function simpanEditMasterUom(e) {
  e.preventDefault();
  const index = parseInt(document.getElementById("editUomIndex").value);
  const kodeBaru = document.getElementById("editUomKode").value.trim().toUpperCase();
  const namaBaru = document.getElementById("editUomNama").value.trim();
  if (!kodeBaru || !namaBaru || !(index >= 0 && index < appState.uomList.length)) return;

  const oldKode = appState.uomList[index].kode;
  if (appState.uomList.some((u, i) => i !== index && u.kode === kodeBaru)) return alert("Kode UoM sudah terdaftar!");

  appState.uomList[index] = { kode: kodeBaru, nama: namaBaru };
  if (oldKode !== kodeBaru) {
    appState.masterBarang.forEach(b => { if ((b.uom || 'PCS') === oldKode) b.uom = kodeBaru; });
  }

  saveData();
  closeModalEditUom();
  renderMasterUomTabel(pageUom);
  renderMasterBarangTabel(pageBarang);
  renderMasterDropdowns();
  refreshRowUomTags();
  alert("Unit of Material (UoM) berhasil diperbarui!");
}

function hapusMasterUom(index) {
  const u = appState.uomList[index];
  if (!u) return;
  const used = appState.masterBarang.filter(b => (b.uom || 'PCS') === u.kode).length;
  if (used > 0) {
    return alert(`UoM "${u.kode}" masih dipakai oleh ${used} master produk dan tidak dapat dihapus. Ubah UoM produk tersebut terlebih dahulu.`);
  }
  bukaModalGeneralDelete(`Apakah Anda yakin ingin menghapus UoM "${u.kode}" (${u.nama})?`, () => {
    appState.uomList.splice(index, 1);
    saveData();
    renderMasterUomTabel(pageUom);
    renderMasterDropdowns();
  });
}

// ==========================================
// MASTER BARANG & IMPORT/EXPORT STOK EXCEL
// ==========================================
function tambahMasterBarang(e) {
  e.preventDefault();
  const sku = document.getElementById("mbSKU").value.trim();
  const nama = document.getElementById("mbNama").value.trim();
  const barcode = document.getElementById("mbBarcode").value.trim() || "-";
  const kat = document.getElementById("mbKategoriProduk").value;
  const uom = document.getElementById("mbUom").value || 'PCS';

  if (appState.masterBarang.some(b => b.sku.toLowerCase() === sku.toLowerCase())) {
    return alert("Kode SKU sudah terdaftar!");
  }

  appState.masterBarang.push({ sku, nama, barcode, kategori_produk: kat, uom });
  saveData();
  alert("Master Barang Berhasil Disimpan!");
  document.getElementById("mbSKU").value = "";
  document.getElementById("mbNama").value = "";
  document.getElementById("mbBarcode").value = "";
  
  closeModalTambahMasterBarang();
  renderMasterBarangTabel(1);
  renderBarangDropdownOptions();
  renderLaporanStok(1);
}

function openModalSetSku(baseSku = '') {
  const componentSelect = document.getElementById('setSkuKomponen');
  componentSelect.innerHTML = `<option value="">-- Pilih Produk Komponen --</option>` +
    sortDisplayItems(appState.masterBarang, product => product.sku).map(product =>
      `<option value="${cekEsc(product.sku)}">${cekEsc(product.sku)} - ${cekEsc(product.nama)}</option>`
    ).join('');
  componentSelect.value = baseSku;
  document.getElementById('setSkuJumlah').value = '';
  document.getElementById('setSkuBarcode').value = '';
  document.getElementById('setSkuNama').value = '';
  document.getElementById('setSkuUom').innerHTML = getUomOptionsHtml('BOX');
  updateSetSkuPreview();
  document.getElementById('modalSetSku').style.display = 'flex';
}

function closeModalSetSku() {
  document.getElementById('modalSetSku').style.display = 'none';
}

function openModalSkuBarcodeRules() {
  if (!currentUser || currentUser.role !== 'superadmin') return alert('Akses ditolak. Master Prefix SKU hanya untuk Superadmin.');
  const productSelect = document.getElementById('skuBarcodeProduct');
  productSelect.innerHTML = '<option value="">-- Pilih SKU Master --</option>' +
    sortDisplayItems(appState.masterBarang, product => product.sku).map(product =>
      `<option value="${cekEsc(product.sku)}">${cekEsc(product.sku)} - ${cekEsc(product.nama)}</option>`
    ).join('');
  renderSkuBarcodeRules();
  resetSkuBarcodeRuleForm();
  document.getElementById('modalSkuBarcodeRules').style.display = 'flex';
}

function closeModalSkuBarcodeRules() {
  document.getElementById('modalSkuBarcodeRules').style.display = 'none';
}

function resetSkuBarcodeRuleForm() {
  document.getElementById('skuBarcodeRuleEditIndex').value = '';
  document.getElementById('skuBarcodePrefix').value = '';
  document.getElementById('skuBarcodeProduct').value = '';
  document.getElementById('skuBarcodeSkuStart').value = '1';
  document.getElementById('skuBarcodeSkuLength').value = '5';
  document.getElementById('skuBarcodeQtyStart').value = '6';
  document.getElementById('skuBarcodeQtyLength').value = '2';
  document.getElementById('skuBarcodeDateStart').value = '8';
  document.getElementById('skuBarcodeDateLength').value = '6';
  document.getElementById('btnSaveSkuBarcodeRule').textContent = '+ Tambah Aturan';
  updateSkuBarcodeRulePreview();
}

function updateSkuBarcodeRulePreview() {
  const prefix = document.getElementById('skuBarcodePrefix')?.value.trim().toUpperCase() || 'FG001';
  const sku = document.getElementById('skuBarcodeProduct')?.value || 'SKU';
  const skuStart = Number(document.getElementById('skuBarcodeSkuStart')?.value) || 1;
  const skuLength = Number(document.getElementById('skuBarcodeSkuLength')?.value) || prefix.length;
  const qtyStart = Number(document.getElementById('skuBarcodeQtyStart')?.value) || 6;
  const qtyLength = Number(document.getElementById('skuBarcodeQtyLength')?.value) || 2;
  const dateStart = Number(document.getElementById('skuBarcodeDateStart')?.value) || 8;
  const dateLength = Number(document.getElementById('skuBarcodeDateLength')?.value) || 6;
  const preview = document.getElementById('skuBarcodeRulePreview');
  if (!preview) return;
  const qtyExample = '24'.padStart(qtyLength, '0');
  const dateExample = '261015'.padStart(dateLength, '0');
  const sampleLength = Math.max(skuStart + skuLength - 1, qtyStart + qtyLength - 1, dateStart + dateLength - 1);
  const sample = Array(sampleLength).fill('_');
  Array.from(prefix).forEach((character, index) => { sample[skuStart - 1 + index] = character; });
  Array.from(qtyExample).forEach((character, index) => { sample[qtyStart - 1 + index] = character; });
  Array.from(dateExample).forEach((character, index) => { sample[dateStart - 1 + index] = character; });
  preview.textContent = `Contoh scan: ${sample.join('')} → ${sku}, Qty ${qtyExample}, tanggal produksi 20YY-MM-DD.`;
}

function skuBarcodeRangeLabel(start, length) {
  const first = Number(start);
  const size = Number(length);
  return first > 0 && size > 0 ? `${first}-${first + size - 1}` : '-';
}

function renderSkuBarcodeRules() {
  const tbody = document.getElementById('tabelSkuBarcodeRules');
  if (!tbody) return;
  const rules = Array.isArray(appState.skuBarcodeRules) ? appState.skuBarcodeRules : [];
  tbody.innerHTML = rules.length ? rules.map((rule, index) => {
    const product = findMasterBarang(rule.sku);
    return `<tr>
      <td><code>${cekEsc(rule.prefix || '')}</code></td>
      <td>${cekEsc(rule.sku || '')} - ${cekEsc(product?.nama || 'SKU tidak ditemukan')}</td>
      <td>${skuBarcodeRangeLabel(rule.sku_start, rule.sku_length)}</td>
      <td>${skuBarcodeRangeLabel(rule.quantity_start, rule.quantity_length)}</td>
      <td>${skuBarcodeRangeLabel(rule.date_start, rule.date_length)}</td>
      <td class="text-center"><div class="action-btn-group">
        <button type="button" class="btn-warning" onclick="editSkuBarcodeRule(${index})">Edit</button>
        <button type="button" class="btn-danger" onclick="hapusSkuBarcodeRule(${index})">Hapus</button>
      </div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="cek-empty">Belum ada aturan prefix SKU.</td></tr>';
}

function editSkuBarcodeRule(index) {
  const rule = appState.skuBarcodeRules?.[index];
  if (!rule) return;
  document.getElementById('skuBarcodeRuleEditIndex').value = String(index);
  document.getElementById('skuBarcodePrefix').value = rule.prefix || '';
  document.getElementById('skuBarcodeProduct').value = rule.sku || '';
  document.getElementById('skuBarcodeSkuStart').value = String(rule.sku_start || 1);
  document.getElementById('skuBarcodeSkuLength').value = String(rule.sku_length || (rule.prefix || '').length);
  document.getElementById('skuBarcodeQtyStart').value = String(rule.quantity_start || 6);
  document.getElementById('skuBarcodeQtyLength').value = String(rule.quantity_length || 2);
  document.getElementById('skuBarcodeDateStart').value = String(rule.date_start || 8);
  document.getElementById('skuBarcodeDateLength').value = String(rule.date_length || 6);
  document.getElementById('btnSaveSkuBarcodeRule').textContent = 'Simpan Perubahan';
  updateSkuBarcodeRulePreview();
}

function simpanSkuBarcodeRule(event) {
  event.preventDefault();
  if (!currentUser || currentUser.role !== 'superadmin') return alert('Akses ditolak. Master Prefix SKU hanya untuk Superadmin.');
  const rule = {
    prefix: document.getElementById('skuBarcodePrefix').value.trim().toUpperCase(),
    sku: document.getElementById('skuBarcodeProduct').value,
    sku_start: Number(document.getElementById('skuBarcodeSkuStart').value),
    sku_length: Number(document.getElementById('skuBarcodeSkuLength').value),
    quantity_start: Number(document.getElementById('skuBarcodeQtyStart').value),
    quantity_length: Number(document.getElementById('skuBarcodeQtyLength').value),
    date_start: Number(document.getElementById('skuBarcodeDateStart').value),
    date_length: Number(document.getElementById('skuBarcodeDateLength').value)
  };
  const editIndex = document.getElementById('skuBarcodeRuleEditIndex').value;
  const ranges = [
    { start: rule.sku_start, length: rule.sku_length },
    { start: rule.quantity_start, length: rule.quantity_length },
    { start: rule.date_start, length: rule.date_length }
  ];
  const rangesValid = ranges.every(range => Number.isInteger(range.start) && range.start > 0 &&
    Number.isInteger(range.length) && range.length > 0);
  const rangesOverlap = ranges.some((range, index) => ranges.slice(index + 1).some(other =>
    range.start < other.start + other.length && other.start < range.start + range.length
  ));
  if (!rule.prefix || !findMasterBarang(rule.sku) || !rangesValid ||
      rule.prefix.length !== rule.sku_length || rule.date_length !== 6) {
    return alert('Isi prefix, pilih SKU master, samakan panjang range SKU dengan jumlah karakter prefix, dan gunakan tanggal 6 digit YYMMDD.');
  }
  if (rangesOverlap) return alert('Range SKU, jumlah, dan tanggal tidak boleh saling tumpang tindih.');
  const editingIndex = editIndex === '' ? -1 : Number(editIndex);
  if (appState.skuBarcodeRules.some((existing, index) =>
    index !== editingIndex && String(existing.prefix || '').toUpperCase() === rule.prefix
  )) return alert('Prefix barcode tersebut sudah digunakan.');

  if (editIndex === '') appState.skuBarcodeRules.push(rule);
  else appState.skuBarcodeRules[Number(editIndex)] = rule;
  saveData();
  renderSkuBarcodeRules();
  resetSkuBarcodeRuleForm();
  alert(editIndex === '' ? 'Aturan Master Prefix SKU berhasil ditambahkan.' : 'Aturan Master Prefix SKU berhasil diperbarui.');
}

function hapusSkuBarcodeRule(index) {
  const rule = appState.skuBarcodeRules?.[index];
  if (!rule) return;
  bukaModalGeneralDelete(`Hapus aturan prefix barcode "${rule.prefix}"?`, () => {
    appState.skuBarcodeRules.splice(index, 1);
    saveData();
    renderSkuBarcodeRules();
    resetSkuBarcodeRuleForm();
  });
}

function updateSetSkuOptions() {
  const select = document.getElementById('setSkuUom');
  if (select) select.innerHTML = getUomOptionsHtml(select.value || 'BOX');
}

function updateSetSkuPreview() {
  const skuInput = document.getElementById('setSkuKode');
  const componentSku = document.getElementById('setSkuKomponen')?.value || '';
  const component = findMasterBarang(componentSku);
  const qty = parseLocalizedNumber(document.getElementById('setSkuJumlah')?.value);
  if (!component) {
    skuInput.value = '';
    return;
  }
  const setCount = appState.masterBarang.reduce((max, product) =>
    product.set_component_sku === component.sku ? Math.max(max, Number(product.set_number) || 0) : max, 0) + 1;
  const safeSku = component.sku.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
  skuInput.value = `SET-${safeSku}-${setCount}`;
  const nameInput = document.getElementById('setSkuNama');
  if (nameInput && (!nameInput.value || nameInput.dataset.generated === 'true')) {
    const qtyLabel = Number.isFinite(qty) ? formatQtyDisplay(qty) : '';
    const uom = document.getElementById('setSkuUom')?.value || 'BOX';
    nameInput.value = qtyLabel ? `${qtyLabel} ${component.uom || 'PCS'} ${component.nama} / ${uom} (SET ${setCount})` : `${component.nama} (SET ${setCount})`;
    nameInput.dataset.generated = 'true';
  }
}

function simpanSetSku(event) {
  event.preventDefault();
  const component = findMasterBarang(document.getElementById('setSkuKomponen').value);
  const quantity = parseLocalizedNumber(document.getElementById('setSkuJumlah').value);
  const sku = document.getElementById('setSkuKode').value.trim();
  const name = document.getElementById('setSkuNama').value.trim();
  const barcode = document.getElementById('setSkuBarcode').value.trim() || '-';
  const uom = document.getElementById('setSkuUom').value || 'BOX';
  if (!component || !Number.isFinite(quantity) || quantity <= 0 || !sku || !name) {
    return alert('Pilih produk dan masukkan jumlah set yang valid (lebih dari 0).');
  }
  if (appState.masterBarang.some(product => product.sku.toLowerCase() === sku.toLowerCase())) {
    return alert(`SKU set "${sku}" sudah ada. Perbarui data lalu coba lagi.`);
  }
  if (!barcode || barcode === '-') return alert('EAN unik wajib diisi untuk setiap Set SKU.');
  if (appState.masterBarang.some(product => String(product.barcode || '').toLowerCase() === barcode.toLowerCase())) {
    return alert('EAN set sudah digunakan oleh produk lain.');
  }
  const setNumber = Number(sku.slice(sku.lastIndexOf('-') + 1));
  appState.masterBarang.push({
    sku, nama: name, barcode, kategori_produk: component.kategori_produk, uom,
    set_component_sku: component.sku, set_component_qty: quantity, set_number: setNumber
  });
  appState.bundleMapping = (appState.bundleMapping || []).filter(bundle =>
    String(bundle.bundle_sku || bundle.sku_combo || bundle.sku || '').toLowerCase() !== sku.toLowerCase()
  );
  appState.bundleMapping.push({ bundle_sku: sku, items: [{ sku: component.sku, qty: quantity }] });
  saveData();
  closeModalSetSku();
  renderMasterBarangTabel(pageBarang);
  renderBarangDropdownOptions();
  renderBundleMappingTabel(pageBundle);
  renderLaporanStok(1);
  alert(`Set SKU ${sku} berhasil dibuat sebagai ${formatQtyDisplay(quantity)} ${component.uom || 'PCS'} per ${uom}.`);
}

function parseLocalizedNumber(value) {
  const normalized = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!normalized) return NaN;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : NaN;
}

function formatQtyDisplay(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('id-ID', { maximumFractionDigits: 6 }).format(number) : String(value ?? '');
}

function renderMasterBarangTabel(page = 1) {
  pageBarang = page;
  const tbody = document.getElementById("tabelMasterBarang");
  if (!tbody) return;
  tbody.innerHTML = "";

  const pageSize = parseInt(document.getElementById("pageSizeBarang")?.value) || 10;
  const searchTerm = (document.getElementById("searchMasterBarang")?.value || '').trim().toLowerCase();
  const categoryFilter = document.getElementById("filterMasterBarangKategori")?.value || '';
  const sortedBarang = sortDisplayItems(appState.masterBarang.filter(product => {
    const searchable = `${product.sku || ''} ${product.nama || ''} ${product.barcode || ''}`.toLowerCase();
    return (!searchTerm || searchable.includes(searchTerm)) &&
      (!categoryFilter || product.kategori_produk === categoryFilter);
  }), b => b.sku);
  const totalItems = sortedBarang.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  if (pageBarang > totalPages) pageBarang = totalPages;
  if (pageBarang < 1) pageBarang = 1;

  const startIndex = (pageBarang - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginated = sortedBarang.slice(startIndex, endIndex);

  if (paginated.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#94a3b8;">Tidak ada master produk yang cocok dengan filter.</td></tr>`;
  } else {
    paginated.forEach((b, index) => {
      const realIndex = startIndex + index + 1;
      tbody.innerHTML += `
        <tr>
          <td class="text-center">${realIndex}</td>
          <td><code>${b.sku}</code></td>
          <td><b>${b.nama}</b></td>
          <td><code>${b.barcode || '-'}</code></td>
          <td>${b.kategori_produk}</td>
          <td><span class="badge badge-info">${b.uom || 'PCS'}</span></td>
          <td class="text-center">
            <div class="action-btn-group">
              <button class="btn-warning" onclick="openModalEditMaster('${b.sku}')">Edit</button>
              <button class="btn-danger" onclick="hapusMasterBarang('${b.sku}')">Hapus</button>
            </div>
          </td>
        </tr>
      `;
    });
  }

  const infoEl = document.getElementById("infoBarangPage");
  const indicatorEl = document.getElementById("indicatorBarangPage");
  const btnPrev = document.getElementById("btnPrevBarang");
  const btnNext = document.getElementById("btnNextBarang");

  updatePaginationControls(pageBarang, totalPages, btnPrev, btnNext, indicatorEl, infoEl, startIndex, endIndex, totalItems);
}

function changeMasterBarangPage(delta) {
  renderMasterBarangTabel(pageBarang + delta);
}

function openModalEditMaster(sku) {
  const b = appState.masterBarang.find(item => item.sku === sku);
  if (!b) return;

  document.getElementById("editMasterOldSKU").value = b.sku;
  document.getElementById("editMasterSKU").value = b.sku;
  document.getElementById("editMasterNama").value = b.nama;
  document.getElementById("editMasterBarcode").value = b.barcode !== '-' ? b.barcode : '';
  document.getElementById("editMasterKategori").value = b.kategori_produk;
  document.getElementById("editMasterUom").innerHTML = getUomOptionsHtml(b.uom || 'PCS');

  document.getElementById("modalEditMaster").style.display = "flex";
}

function closeModalEditMaster() {
  document.getElementById("modalEditMaster").style.display = "none";
}

function simpanEditMasterBarang(e) {
  e.preventDefault();
  const oldSKU = document.getElementById("editMasterOldSKU").value;
  const newSKU = document.getElementById("editMasterSKU").value.trim();
  const newNama = document.getElementById("editMasterNama").value.trim();
  const newBarcode = document.getElementById("editMasterBarcode").value.trim() || "-";
  const newKat = document.getElementById("editMasterKategori").value;
  const newUom = document.getElementById("editMasterUom").value;

  const item = appState.masterBarang.find(b => b.sku === oldSKU);
  if (item) {
    if (oldSKU !== newSKU && appState.masterBarang.some(b => b.sku.toLowerCase() === newSKU.toLowerCase())) {
      return alert("Kode SKU baru sudah digunakan!");
    }
    if (oldSKU !== newSKU) {
      (appState.skuBarcodeRules || []).forEach(rule => {
        if (rule.sku === oldSKU) rule.sku = newSKU;
      });
    }
    item.sku = newSKU;
    item.nama = newNama;
    item.barcode = newBarcode;
    item.kategori_produk = newKat;
    item.uom = newUom || item.uom || 'PCS';

    saveData();
    closeModalEditMaster();
    renderMasterBarangTabel(pageBarang);
    renderBarangDropdownOptions();
    renderLaporanStok(1);
    alert("Master barang berhasil diperbarui!");
  }
}

function hapusMasterBarang(sku) {
  if ((appState.skuBarcodeRules || []).some(rule => rule.sku === sku)) {
    return alert(`SKU "${sku}" masih digunakan pada Master Prefix SKU. Hapus atau ubah aturan prefix terlebih dahulu.`);
  }
  bukaModalGeneralDelete(`Apakah Anda yakin ingin menghapus barang SKU "${sku}"?`, () => {
    appState.masterBarang = appState.masterBarang.filter(b => b.sku !== sku);
    saveData();
    renderMasterBarangTabel(pageBarang);
    renderBarangDropdownOptions();
    renderLaporanStok(1);
  });
}

function downloadTemplateMasterBarang() {
  if (!requireFeatureAccess('export', 'Export')) return;
  const templateData = [
    { "Kode SKU": "SKU-SAMPLE-01", "Nama Barang": "Sample Produk A", "Barcode": "8991234567890", "Kategori Produk": "Finish Good", "UoM": "PCS" },
    { "Kode SKU": "SKU-SAMPLE-02", "Nama Barang": "Bahan Baku B", "Barcode": "-", "Kategori Produk": "Bahan Baku", "UoM": "KG" }
  ];
  const ws = XLSX.utils.json_to_sheet(templateData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Template Master Barang");
  XLSX.writeFile(wb, "Template_Master_Barang.xlsx");
}

function exportMasterBarangExcel() {
  if (!requireFeatureAccess('export', 'Export')) return;
  if (appState.masterBarang.length === 0) return alert("Belum ada data master barang!");
  const data = appState.masterBarang.map(b => ({
    "Kode SKU": b.sku,
    "Nama Barang": b.nama,
    "Barcode": b.barcode || "-",
    "Kategori Produk": b.kategori_produk,
    "UoM": b.uom || "PCS"
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Master Barang");
  XLSX.writeFile(wb, `Master_Barang_${new Date().toISOString().split('T')[0]}.xlsx`);
}

function uploadStokExcelBatch() {
  if (!requireFeatureAccess('import', 'Import')) return;
  const fileInput = document.getElementById("importStokExcelFile");
  if (!fileInput.files.length) return alert("Pilih file Excel stok barang!");

  const reader = new FileReader();
  reader.onload = function(e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonRows = XLSX.utils.sheet_to_json(sheet);

    if (jsonRows.length === 0) return alert("File Excel kosong!");

    let countAdded = 0;
    let countBlockedMinus = 0;
    const today = new Date().toISOString().split("T")[0];

    jsonRows.forEach(row => {
      const skuRaw = String(row['Kode SKU'] || row.SKU || row.sku || '').trim();
      const qty = Number(row.Qty || row.QTY || row.qty || 0);
      const gudang = String(row.Gudang || row.gudang || appState.warehouses[0]?.nama || 'Gudang Utama').trim();
      const tipe = String(row.Tipe || row.tipe || 'MASUK').trim().toUpperCase() === 'KELUAR' ? 'KELUAR' : 'MASUK';
      const tanggal = String(row.Tanggal || row.tanggal || today).trim();

      if (skuRaw && !isNaN(qty)) {
        const barang = findMasterBarang(skuRaw);
        const skuFinal = barang ? barang.sku : skuRaw;
        const namaBarang = barang ? barang.nama : skuRaw;
        const katProd = barang ? barang.kategori_produk : 'Finish Good';
        const kodeProd = (katProd === 'Finish Good') ? generateKodeProduksi(namaBarang, tanggal) : '-';

        // Blok stok minus untuk baris KELUAR jika fitur Stok Minus NON-AKTIF
        if (tipe === 'KELUAR' && !appState.allowNegativeStock) {
          const stokAda = calculateStockRealtime(skuFinal, gudang);
          if (stokAda < qty) {
            countBlockedMinus++;
            return;
          }
        }

        appState.transactions.push({
          id: Date.now() + Math.random(),
          no_sj: `IMPORT-STOCK-${Date.now()}`,
          tipe: tipe,
          gudang: gudang,
          kode: skuFinal,
          nama_barang: namaBarang,
          kode_produksi: kodeProd,
          kategori_produk: katProd,
          kategori_masuk: tipe === 'MASUK' ? 'Upload Stok Excel' : '',
          tujuan_keluar: tipe === 'KELUAR' ? 'Upload Stok Excel' : '',
          qty: qty,
          tanggal: tanggal,
          foto_bukti: '',
          pengirim_kurir: 'Batch Excel Upload',
          input_by: currentUser.name
        });
        countAdded++;
      }
    });

    saveData();
    renderDashboard(1);
    renderLaporanStok(1);
    alert(`Berhasil mengupload ${countAdded} transaksi stok barang dari Excel!` + (countBlockedMinus > 0 ? `\n${countBlockedMinus} baris KELUAR dilewati karena stok tidak mencukupi (Stok Minus NON-AKTIF).` : ''));
    fileInput.value = "";
  };
  reader.readAsArrayBuffer(fileInput.files[0]);
}

// ==========================================
// MASTER BOM (BILL OF MATERIALS)
// ==========================================
function autoFillNamaBOM(selectEl) {
  const selectedOpt = selectEl.options[selectEl.selectedIndex];
  const skuVal = selectEl.value;
  const namaBarang = selectedOpt ? selectedOpt.getAttribute("data-nama") : "";
  const inputNamaBom = document.getElementById("bomNama");
  
  if (skuVal && inputNamaBom) {
    inputNamaBom.value = `BOM - ${skuVal} (${namaBarang})`;
  } else if (inputNamaBom) {
    inputNamaBom.value = "BOM - ";
  }
}

function autoFillEditNamaBOM(selectEl) {
  const selectedOpt = selectEl.options[selectEl.selectedIndex];
  const skuVal = selectEl.value;
  const namaBarang = selectedOpt ? selectedOpt.getAttribute("data-nama") : "";
  const inputNamaBom = document.getElementById("editBOMNama");
  
  if (skuVal && inputNamaBom) {
    inputNamaBom.value = `BOM - ${skuVal} (${namaBarang})`;
  } else if (inputNamaBom) {
    inputNamaBom.value = "BOM - ";
  }
}

function tambahBarisBOMItem(skuDefault = "", qtyDefault = 1) {
  const container = document.getElementById("bomItemsContainer");
  if(!container) return;
  const rowId = "bom_row_" + Date.now() + "_" + Math.floor(Math.random()*1000);

  const html = `
    <div class="bom-item-row" id="${rowId}" style="display:flex; gap:10px; margin-bottom:8px; align-items:center;">
      <div style="flex:3;">
        <label>Pilih SKU Komponen / Bahan Asal</label>
        <select class="bom-row-sku row-sku-select" required></select>
      </div>
      <div style="flex:1;">
        <label>Qty Dibutuhkan <span class="row-uom-tag">(UoM)</span></label>
        <input class="bom-row-qty" type="text" inputmode="decimal" value="${String(qtyDefault).replace('.', ',')}" required>
      </div>
      <div>
        <button type="button" class="btn-danger" style="margin-top:20px;" onclick="document.getElementById('${rowId}').remove()">Hapus</button>
      </div>
    </div>
  `;
  container.insertAdjacentHTML("beforeend", html);
  renderBarangDropdownOptions();

  if (skuDefault) {
    const newlyAddedRow = document.getElementById(rowId);
    if(newlyAddedRow) {
      const selectEl = newlyAddedRow.querySelector(".bom-row-sku");
      if(selectEl) selectEl.value = skuDefault;
    }
  }
}

function tambahBarisEditBOMItem(skuDefault = "", qtyDefault = 1) {
  const container = document.getElementById("editBOMItemsContainer");
  if(!container) return;
  const rowId = "edit_bom_row_" + Date.now() + "_" + Math.floor(Math.random()*1000);

  let htmlOptions = `<option value="">-- Pilih SKU Komponen --</option>`;
  if(appState && appState.masterBarang) {
    appState.masterBarang.forEach(b => {
      htmlOptions += `<option value="${b.sku}" data-nama="${b.nama}">${b.sku} - ${b.nama}</option>`;
    });
  }

  const html = `
    <div class="edit-bom-item-row" id="${rowId}" style="display:flex; gap:10px; margin-bottom:8px; align-items:center;">
      <div style="flex:3;">
        <label>Pilih SKU Komponen / Bahan Asal</label>
        <select class="edit-bom-row-sku row-sku-select" required>${htmlOptions}</select>
      </div>
      <div style="flex:1;">
        <label>Qty Dibutuhkan <span class="row-uom-tag">(UoM)</span></label>
        <input class="edit-bom-row-qty" type="text" inputmode="decimal" value="${String(qtyDefault).replace('.', ',')}" required>
      </div>
      <div>
        <button type="button" class="btn-danger" style="margin-top:20px;" onclick="document.getElementById('${rowId}').remove()">Hapus</button>
      </div>
    </div>
  `;
  container.insertAdjacentHTML("beforeend", html);

  if (skuDefault) {
    const newlyAddedRow = document.getElementById(rowId);
    if(newlyAddedRow) {
      const selectEl = newlyAddedRow.querySelector(".edit-bom-row-sku");
      if(selectEl) selectEl.value = skuDefault;
    }
  }
}

function tambahMasterBOM(e) {
  e.preventDefault();
  const namaBom = document.getElementById("bomNama").value.trim();
  const skuHasil = document.getElementById("bomSkuHasil").value;
  const rows = document.querySelectorAll(".bom-item-row");

  if (!namaBom || !skuHasil || rows.length === 0) {
    return alert("Lengkapi Nama BOM, SKU Hasil, dan Komponen Bahan!");
  }

  const items = [];
  let valid = true;
  rows.forEach(r => {
    const sku = r.querySelector(".bom-row-sku").value;
    const qty = parseLocalizedNumber(r.querySelector(".bom-row-qty").value);
    if (!Number.isFinite(qty) || qty <= 0) valid = false;
    if (sku) items.push({ sku, qty });
  });
  if (!valid) return alert("Qty komponen BOM harus berupa angka lebih dari 0. Gunakan koma atau titik untuk desimal, misalnya 10,1.");

  if (!appState.masterBOM) appState.masterBOM = [];

  appState.masterBOM.push({ id: Date.now(), nama_bom: namaBom, sku_hasil: skuHasil, items });
  saveData();
  alert("Master BOM Berhasil Disimpan!");
  
  document.getElementById("bomNama").value = "";
  document.getElementById("bomSkuHasil").value = "";
  document.getElementById("bomItemsContainer").innerHTML = "";
  tambahBarisBOMItem();

  closeModalTambahBOM();
  renderMasterBOMTabel(1);
  renderBOMDropdownOptions();
}

function openModalEditBOM(id) {
  const bom = (appState.masterBOM || []).find(b => b.id == id);
  if (!bom) return;

  document.getElementById("editBOMId").value = bom.id;
  document.getElementById("editBOMNama").value = bom.nama_bom;
  
  const selectSkuHasil = document.getElementById("editBOMSkuHasil");
  let htmlOpts = `<option value="">-- Pilih SKU Hasil --</option>`;
  appState.masterBarang.forEach(b => {
    htmlOpts += `<option value="${b.sku}" data-nama="${b.nama}">${b.sku} - ${b.nama}</option>`;
  });
  selectSkuHasil.innerHTML = htmlOpts;
  selectSkuHasil.value = bom.sku_hasil;

  const container = document.getElementById("editBOMItemsContainer");
  container.innerHTML = "";

  if (Array.isArray(bom.items)) {
    bom.items.forEach(item => {
      tambahBarisEditBOMItem(item.sku, item.qty);
    });
  }

  document.getElementById("modalEditBOM").style.display = "flex";
}

function closeModalEditBOM() {
  document.getElementById("modalEditBOM").style.display = "none";
}

function simpanEditMasterBOM(e) {
  e.preventDefault();
  const id = document.getElementById("editBOMId").value;
  const namaBom = document.getElementById("editBOMNama").value.trim();
  const skuHasil = document.getElementById("editBOMSkuHasil").value;
  const rows = document.querySelectorAll(".edit-bom-item-row");

  if (!namaBom || !skuHasil || rows.length === 0) {
    return alert("Lengkapi Nama BOM, SKU Hasil, dan Komponen Bahan!");
  }

  const items = [];
  let valid = true;
  rows.forEach(r => {
    const sku = r.querySelector(".edit-bom-row-sku").value;
    const qty = parseLocalizedNumber(r.querySelector(".edit-bom-row-qty").value);
    if (!Number.isFinite(qty) || qty <= 0) valid = false;
    if (sku) items.push({ sku, qty });
  });
  if (!valid) return alert("Qty komponen BOM harus berupa angka lebih dari 0. Gunakan koma atau titik untuk desimal, misalnya 10,1.");

  const bomObj = (appState.masterBOM || []).find(b => b.id == id);
  if (bomObj) {
    bomObj.nama_bom = namaBom;
    bomObj.sku_hasil = skuHasil;
    bomObj.items = items;
    saveData();
    closeModalEditBOM();
    renderMasterBOMTabel(pageBOM);
    renderBOMDropdownOptions();
    alert("Master BOM Berhasil Diperbarui!");
  }
}

function renderMasterBOMTabel(page = 1) {
  pageBOM = page;
  const tbody = document.getElementById("tabelMasterBOM");
  if (!tbody) return;
  tbody.innerHTML = "";
  
  if (!appState.masterBOM || appState.masterBOM.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#94a3b8; padding:15px;">Belum ada Master BOM terdaftar.</td></tr>`;
    const infoEl = document.getElementById("infoBOMPage");
    const indicatorEl = document.getElementById("indicatorBOMPage");
    if(infoEl) infoEl.textContent = "Menampilkan 0 - 0 dari 0 data";
    if(indicatorEl) indicatorEl.textContent = "Halaman 1 / 1";
    return;
  }

  const pageSize = parseInt(document.getElementById("pageSizeBOM")?.value) || 5;
  const searchTerm = (document.getElementById("searchMasterBOM")?.value || '').trim().toLowerCase();
  const categoryFilter = document.getElementById("filterMasterBOMCategory")?.value || '';
  const filteredBOM = appState.masterBOM.filter(bom => {
    const items = Array.isArray(bom.items) ? bom.items : [];
    const searchable = `${bom.nama_bom || ''} ${bom.sku_hasil || ''} ${items.map(item => {
      const product = findMasterBarang(item.sku);
      return `${item.sku || ''} ${product ? product.nama : ''}`;
    }).join(' ')}`.toLowerCase();
    const output = findMasterBarang(bom.sku_hasil);
    return (!searchTerm || searchable.includes(searchTerm)) &&
      (!categoryFilter || (output && output.kategori_produk === categoryFilter));
  });
  const sortedBOM = sortDisplayItems(filteredBOM, b => b.sku_hasil);
  const totalItems = sortedBOM.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  if (pageBOM > totalPages) pageBOM = totalPages;
  if (pageBOM < 1) pageBOM = 1;

  const startIndex = (pageBOM - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginated = sortedBOM.slice(startIndex, endIndex);

  if (paginated.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#94a3b8;">Tidak ada Master BOM yang cocok dengan filter.</td></tr>`;
  } else {
    paginated.forEach((b, idx) => {
      const realIndex = startIndex + idx + 1;
      const detail = (b.items || []).map(i => `${formatQtyDisplay(i.qty)}x ${i.sku}`).join(" + ");
      tbody.innerHTML += `
        <tr>
          <td class="text-center">${realIndex}</td>
          <td><b>${b.nama_bom}</b></td>
          <td><code>${b.sku_hasil}</code></td>
          <td>${detail}</td>
          <td class="text-center">
            <div class="action-btn-group">
              <button class="btn-warning" onclick="openModalEditBOM(${b.id})">Edit</button>
              <button class="btn-danger" onclick="hapusMasterBOM(${b.id})">Hapus</button>
            </div>
          </td>
        </tr>
      `;
    });
  }

  const infoEl = document.getElementById("infoBOMPage");
  const indicatorEl = document.getElementById("indicatorBOMPage");
  const btnPrev = document.getElementById("btnPrevBOM");
  const btnNext = document.getElementById("btnNextBOM");

  updatePaginationControls(pageBOM, totalPages, btnPrev, btnNext, indicatorEl, infoEl, startIndex, endIndex, totalItems);
}

function openModalMasterBOM() {
  renderMasterBOMTabel(pageBOM);
  document.getElementById("modalMasterBOM").style.display = "flex";
}

function closeModalMasterBOM() {
  document.getElementById("modalMasterBOM").style.display = "none";
}

function downloadTemplateBOMExcel() {
  if (!requireFeatureAccess('export', 'Export')) return;
  const output = appState.masterBarang.find(product => product.kategori_produk === 'Finish Good') || appState.masterBarang[0];
  const component = appState.masterBarang.find(product => output && product.sku !== output.sku) || output;
  if (!output || !component) return alert("Tambahkan master produk terlebih dahulu untuk membuat template BOM.");
  const rows = [
    { "Nama BOM": `BOM - ${output.sku} (${output.nama})`, "SKU Hasil": output.sku, "SKU Komponen": component.sku, "Qty Dibutuhkan": 1 }
  ];
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Template Master BOM");
  XLSX.writeFile(workbook, "Template_Master_BOM.xlsx");
}

function exportBOMExcel() {
  if (!requireFeatureAccess('export', 'Export')) return;
  if (!Array.isArray(appState.masterBOM) || appState.masterBOM.length === 0) {
    return alert("Belum ada data Master BOM untuk di-export!");
  }
  const rows = [];
  sortDisplayItems(appState.masterBOM, bom => bom.sku_hasil).forEach(bom => {
    (bom.items || []).forEach(item => rows.push({
      "Nama BOM": bom.nama_bom,
      "SKU Hasil": bom.sku_hasil,
      "SKU Komponen": item.sku,
      "Qty Dibutuhkan": item.qty,
      "UoM Komponen": uomOf(item.sku)
    }));
  });
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Master BOM");
  XLSX.writeFile(workbook, `Master_BOM_${new Date().toISOString().split('T')[0]}.xlsx`);
}

function uploadBOMExcelBatch() {
  if (!requireFeatureAccess('import', 'Import')) return;
  const fileInput = document.getElementById("importBOMExcelFile");
  if (!fileInput.files.length) return alert("Pilih file Excel Master BOM!");

  const reader = new FileReader();
  reader.onload = function(event) {
    const workbook = XLSX.read(new Uint8Array(event.target.result), { type: 'array' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(worksheet);
    if (rows.length === 0) return alert("File Excel kosong!");

    const grouped = new Map();
    let skipped = 0;
    rows.forEach(row => {
      const rawOutputSku = String(row['SKU Hasil'] || row.sku_hasil || row.SKU || '').trim();
      const rawComponentSku = String(row['SKU Komponen'] || row.sku_komponen || row.Komponen || '').trim();
      const output = findMasterBarang(rawOutputSku);
      const component = findMasterBarang(rawComponentSku);
      const rawQty = row['Qty Dibutuhkan'] ?? row.qty_dibutuhkan ?? row.Qty ?? row.qty;
      const qty = Number(rawQty);
      if (!output || !component || !Number.isFinite(qty) || qty <= 0) {
        skipped++;
        return;
      }

      const namaBOM = String(row['Nama BOM'] || row.nama_bom || `BOM - ${output.sku} (${output.nama})`).trim();
      const key = `${output.sku.toLowerCase()}|${namaBOM.toLowerCase()}`;
      if (!grouped.has(key)) grouped.set(key, { nama_bom: namaBOM, sku_hasil: output.sku, items: new Map() });
      const group = grouped.get(key);
      group.items.set(component.sku, (group.items.get(component.sku) || 0) + qty);
    });

    if (grouped.size === 0) {
      return alert(`Tidak ada BOM valid untuk diimpor.${skipped ? ` ${skipped} baris tidak valid dilewati.` : ''}`);
    }

    grouped.forEach(group => {
      const items = Array.from(group.items, ([sku, qty]) => ({ sku, qty }));
      const existing = appState.masterBOM.find(b =>
        String(b.sku_hasil).toLowerCase() === group.sku_hasil.toLowerCase() &&
        String(b.nama_bom).toLowerCase() === group.nama_bom.toLowerCase()
      );
      if (existing) {
        existing.items = items;
      } else {
        appState.masterBOM.push({ id: Date.now() + Math.random(), nama_bom: group.nama_bom, sku_hasil: group.sku_hasil, items });
      }
    });

    saveData();
    renderMasterBOMTabel(1);
    renderBOMDropdownOptions();
    fileInput.value = "";
    alert(`Berhasil mengimpor ${grouped.size} Master BOM.${skipped ? ` ${skipped} baris tidak valid dilewati.` : ''}`);
  };
  reader.readAsArrayBuffer(fileInput.files[0]);
}

function changeMasterBOMPage(delta) {
  renderMasterBOMTabel(pageBOM + delta);
}

function hapusMasterBOM(id) {
  bukaModalGeneralDelete("Apakah Anda yakin ingin menghapus Master BOM ini?", () => {
    appState.masterBOM = appState.masterBOM.filter(b => b.id != id);
    saveData();
    renderMasterBOMTabel(pageBOM);
    renderBOMDropdownOptions();
  });
}

function renderBOMDropdownOptions() {
  let html = `<option value="">-- Pilih BOM / Resep Manufaktur --</option>`;
  if (appState.masterBOM) {
    sortDisplayItems(appState.masterBOM, b => b.sku_hasil).forEach(b => {
      html += `<option value="${b.id}">${b.nama_bom} (Hasil SKU: ${b.sku_hasil})</option>`;
    });
  }
  document.querySelectorAll(".mfg-row-bom").forEach(select => {
    const selectedValue = select.value;
    select.innerHTML = html;
    select.value = selectedValue;
  });
  const legacySelect = document.getElementById("mfgPilihBOM");
  if (legacySelect) legacySelect.innerHTML = html;
  toggleMfgKodeProduksi();
}

// ==========================================
// MASTER BUNDLE / COMBO MAPPING
// ==========================================
function downloadTemplateBundleExcel() {
  if (!requireFeatureAccess('export', 'Export')) return;
  const templateData = [
    { "SKU Combo": "TrioMercon-Sample", "SKU Komponen": "FG-004", "Qty Komponen": 1 },
    { "SKU Combo": "TrioMercon-Sample", "SKU Komponen": "FG-003", "Qty Komponen": 1 },
    { "SKU Combo": "TrioMercon-Sample", "SKU Komponen": "FG-002", "Qty Komponen": 1 }
  ];
  const ws = XLSX.utils.json_to_sheet(templateData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Template SKU Bundle");
  XLSX.writeFile(wb, "Template_Mapping_Bundle.xlsx");
}

function exportBundleExcel() {
  if (!requireFeatureAccess('export', 'Export')) return;
  if (appState.bundleMapping.length === 0) return alert("Belum ada data pemetaan SKU bundle!");
  
  const exportRows = [];
  appState.bundleMapping.forEach(b => {
    const bSku = b.bundle_sku || b.sku_combo || b.sku || "-";
    if (Array.isArray(b.items)) {
      b.items.forEach(item => {
        exportRows.push({
          "SKU Combo": bSku,
          "SKU Komponen": item.sku,
          "Qty Komponen": item.qty
        });
      });
    }
  });

  const ws = XLSX.utils.json_to_sheet(exportRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Master Bundle Mapping");
  XLSX.writeFile(wb, `Master_Bundle_Mapping_${new Date().toISOString().split('T')[0]}.xlsx`);
}

function uploadBundleExcelBatch() {
  if (!requireFeatureAccess('import', 'Import')) return;
  const fileInput = document.getElementById("importBundleExcelFileInput");
  if (!fileInput.files.length) return alert("Pilih file Excel SKU Bundle!");

  const reader = new FileReader();
  reader.onload = function(e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonRows = XLSX.utils.sheet_to_json(sheet);

    if (jsonRows.length === 0) return alert("File Excel kosong!");

    const bundleGroup = {};
    jsonRows.forEach(row => {
      const bundleSku = String(row['SKU Combo'] || row.bundle_sku || row.sku_combo || row.Bundle || '').trim();
      const componentSku = String(row['SKU Komponen'] || row.sku_komponen || row.Komponen || '').trim();
      const qty = Number(row['Qty Komponen'] || row.qty || row.Qty || 1);

      if (bundleSku && componentSku && qty > 0) {
        if (!bundleGroup[bundleSku]) {
          bundleGroup[bundleSku] = [];
        }
        bundleGroup[bundleSku].push({ sku: componentSku, qty: qty });
      }
    });

    let countAdded = 0;
    Object.keys(bundleGroup).forEach(bundleSku => {
      appState.bundleMapping = appState.bundleMapping.filter(b => {
        const currentBSku = b.bundle_sku || b.sku_combo || b.sku || '';
        return currentBSku.toLowerCase() !== bundleSku.toLowerCase();
      });
      appState.bundleMapping.push({
        bundle_sku: bundleSku,
        items: bundleGroup[bundleSku]
      });
      countAdded++;
    });

    saveData();
    renderBundleMappingTabel(1);
    alert(`Berhasil mengimpor/memperbarui ${countAdded} Konfigurasi Bundle Combo dari Excel!`);
    fileInput.value = "";
  };
  reader.readAsArrayBuffer(fileInput.files[0]);
}

function tambahBarisItemBundle(skuDefault = "", qtyDefault = 1) {
  const container = document.getElementById("bundleItemsContainer");
  if(!container) return;
  const rowId = "bundle_row_" + Date.now() + "_" + Math.floor(Math.random()*1000);

  const html = `
    <div class="bundle-row" id="${rowId}" style="display:flex; gap:10px; margin-bottom:8px; align-items:center;">
      <div style="flex:3;">
        <label>Pilih SKU Finish Good Komponen</label>
        <select class="bundle-item-sku row-sku-select" required></select>
      </div>
      <div style="flex:1;">
        <label>Qty <span class="row-uom-tag">(UoM)</span></label>
        <input class="bundle-item-qty" type="number" min="1" value="${qtyDefault}" required>
      </div>
      <div>
        <button type="button" class="btn-danger" style="margin-top:20px;" onclick="document.getElementById('${rowId}').remove()">Hapus</button>
      </div>
    </div>
  `;
  container.insertAdjacentHTML("beforeend", html);
  renderBarangDropdownOptions();

  if (skuDefault) {
    const newlyAddedRow = document.getElementById(rowId);
    if(newlyAddedRow) {
      const selectEl = newlyAddedRow.querySelector(".bundle-item-sku");
      if(selectEl) selectEl.value = skuDefault;
    }
  }
}

function resetFormBundle() {
  const editOldSku = document.getElementById("bundleEditOldSKU");
  const bundleSkuInput = document.getElementById("bundleSKU");
  const container = document.getElementById("bundleItemsContainer");
  const btnSimpan = document.getElementById("btnSimpanBundle");
  const btnBatal = document.getElementById("btnBatalEditBundle");

  if (editOldSku) editOldSku.value = "";
  if (bundleSkuInput) bundleSkuInput.value = "";
  if (container) {
    container.innerHTML = "";
    tambahBarisItemBundle();
  }
  if (btnSimpan) btnSimpan.textContent = "Simpan Konfigurasi Bundle";
  if (btnBatal) btnBatal.style.display = "none";
}

function editBundleMapping(bundleSkuTarget) {
  const bundle = appState.bundleMapping.find(b => {
    const bSku = b.bundle_sku || b.sku_combo || b.sku || '';
    return bSku === bundleSkuTarget;
  });
  if (!bundle) return;

  const bSkuFinal = bundle.bundle_sku || bundle.sku_combo || bundle.sku;

  const editOldSku = document.getElementById("bundleEditOldSKU");
  const bundleSkuInput = document.getElementById("bundleSKU");
  const container = document.getElementById("bundleItemsContainer");
  const btnSimpan = document.getElementById("btnSimpanBundle");
  const btnBatal = document.getElementById("btnBatalEditBundle");

  if (editOldSku) editOldSku.value = bSkuFinal;
  if (bundleSkuInput) bundleSkuInput.value = bSkuFinal;
  if (container) container.innerHTML = "";

  if (Array.isArray(bundle.items)) {
    bundle.items.forEach(item => {
      tambahBarisItemBundle(item.sku, item.qty);
    });
  }

  if (btnSimpan) btnSimpan.textContent = "Update Konfigurasi Bundle";
  if (btnBatal) btnBatal.style.display = "inline-block";
  document.getElementById("modalTambahBundle").style.display = "flex";
}

function tambahBundleMapping(e) {
  e.preventDefault();
  const oldSku = document.getElementById("bundleEditOldSKU") ? document.getElementById("bundleEditOldSKU").value : "";
  const bundleSku = document.getElementById("bundleSKU") ? document.getElementById("bundleSKU").value.trim() : "";
  const rows = document.querySelectorAll(".bundle-row");

  if (!bundleSku) return alert("Masukkan Kode SKU Combo / Bundle Manifest!");
  if (rows.length === 0) return alert("Tambahkan kelengkapan minimal 1 item komponen bundle!");

  const items = [];
  let valid = true;
  rows.forEach(r => {
    const skuSelect = r.querySelector(".bundle-item-sku");
    const qtyInput = r.querySelector(".bundle-item-qty");
    
    const sku = skuSelect ? skuSelect.value : "";
    const qty = qtyInput ? Number(qtyInput.value) : 1;

    if (!sku || qty <= 0) valid = false;
    items.push({ sku, qty });
  });

  if (!valid) return alert("Pilih SKU Komponen secara valid!");

  if (oldSku) {
    appState.bundleMapping = appState.bundleMapping.filter(b => {
      const bSku = b.bundle_sku || b.sku_combo || b.sku || '';
      return bSku.toLowerCase() !== oldSku.toLowerCase();
    });
  }

  appState.bundleMapping = appState.bundleMapping.filter(b => {
    const bSku = b.bundle_sku || b.sku_combo || b.sku || '';
    return bSku.toLowerCase() !== bundleSku.toLowerCase();
  });

  appState.bundleMapping.push({ bundle_sku: bundleSku, items: items });

  saveData();
  alert("Konfigurasi Bundle SKU Berhasil Disimpan!");
  closeModalTambahBundle();
  resetFormBundle();
  renderBundleMappingTabel(1);
}

function renderBundleMappingTabel(page = 1) {
  pageBundle = page;
  const tbody = document.getElementById("tabelBundleMapping");
  if (!tbody) return;
  tbody.innerHTML = "";

  const pageSize = parseInt(document.getElementById("pageSizeBundle")?.value) || 5;
  const searchTerm = (document.getElementById("searchMasterBundle")?.value || '').trim().toLowerCase();
  const componentFilter = document.getElementById("filterMasterBundleComponent")?.value || '';
  const filteredBundles = appState.bundleMapping.filter(bundle => {
    const bundleSku = bundle.bundle_sku || bundle.sku_combo || bundle.sku || '';
    const items = Array.isArray(bundle.items) ? bundle.items : [];
    const searchable = `${bundleSku} ${items.map(item => {
      const product = findMasterBarang(item.sku);
      return `${item.sku || ''} ${product ? product.nama : ''}`;
    }).join(' ')}`.toLowerCase();
    return (!searchTerm || searchable.includes(searchTerm)) &&
      (!componentFilter || items.some(item => item.sku === componentFilter));
  });
  const sortedBundles = sortDisplayItems(filteredBundles, b => b.bundle_sku || b.sku_combo || b.sku || '');
  const totalItems = sortedBundles.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  if (pageBundle > totalPages) pageBundle = totalPages;
  if (pageBundle < 1) pageBundle = 1;

  const startIndex = (pageBundle - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginated = sortedBundles.slice(startIndex, endIndex);

  if (paginated.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#94a3b8;">Tidak ada bundle yang cocok dengan filter.</td></tr>`;
  } else {
    paginated.forEach((b, idx) => {
      const realIndex = startIndex + idx + 1;
      const bSku = b.bundle_sku || b.sku_combo || b.sku || "N/A";
      const itemsList = Array.isArray(b.items) ? b.items : [];

      const detailText = itemsList.map(i => {
        const mb = appState.masterBarang.find(m => m.sku === i.sku);
        return `${i.qty}x ${i.sku} (${mb ? mb.nama : i.sku})`;
      }).join(" + ");

      tbody.innerHTML += `
        <tr>
          <td class="text-center">${realIndex}</td>
          <td><code><b>${bSku}</b></code></td>
          <td>${detailText || '-'}</td>
          <td class="text-center"><b style="color:#0284c7;">${sumByUom(itemsList, 'sku', 'qty')}</b></td>
          <td class="text-center">
            <div class="action-btn-group">
              <button class="btn-warning" onclick="editBundleMapping('${bSku}')">Edit</button>
              <button class="btn-danger" onclick="hapusBundleMapping('${bSku}')">Hapus</button>
            </div>
          </td>
        </tr>
      `;
    });
  }

  const infoEl = document.getElementById("infoBundlePage");
  const indicatorEl = document.getElementById("indicatorBundlePage");
  const btnPrev = document.getElementById("btnPrevBundle");
  const btnNext = document.getElementById("btnNextBundle");

  updatePaginationControls(pageBundle, totalPages, btnPrev, btnNext, indicatorEl, infoEl, startIndex, endIndex, totalItems);
}

function changeMasterBundlePage(delta) {
  renderBundleMappingTabel(pageBundle + delta);
}

function hapusBundleMapping(bundleSkuTarget) {
  bukaModalGeneralDelete(`Apakah Anda yakin ingin menghapus pemetaan bundle "${bundleSkuTarget}"?`, () => {
    appState.bundleMapping = appState.bundleMapping.filter(b => {
      const bSku = b.bundle_sku || b.sku_combo || b.sku || '';
      return bSku !== bundleSkuTarget;
    });
    saveData();
    renderBundleMappingTabel(pageBundle);
  });
}

function renderBarangDropdownOptions() {
  let html = `<option value="">-- Pilih SKU / Nama Barang --</option>`;
  sortDisplayItems(appState.masterBarang, b => b.sku).forEach(b => {
    html += `<option value="${b.sku}" data-nama="${b.nama}" data-kat="${b.kategori_produk}">${b.sku} - ${b.nama}</option>`;
  });

  const selectBomHasil = document.getElementById("bomSkuHasil");
  if (selectBomHasil) {
    const selectedSku = selectBomHasil.value;
    selectBomHasil.innerHTML = html;
    selectBomHasil.value = selectedSku;
  }

  const selectEditBomHasil = document.getElementById("editBOMSkuHasil");
  if (selectEditBomHasil) {
    const selectedSku = selectEditBomHasil.value;
    selectEditBomHasil.innerHTML = html;
    selectEditBomHasil.value = selectedSku;
  }

  document.querySelectorAll(".row-sku-select, .bundle-item-sku, .bom-row-sku").forEach(sel => {
    const currentVal = sel.value;
    sel.innerHTML = html;
    sel.value = currentVal;
  });
  refreshRowUomTags();
}

function renderMasterDropdowns() {
  const selectMain = document.getElementById("selectGudangMain");
  const selectTujuan = document.getElementById("selectGudangTujuan");
  const selectMfg = document.getElementById("mfgGudang");
  const filterGudangDash = document.getElementById("filterGudangDashboard");
  const filterGudangStok = document.getElementById("filterGudangStok");
  const selectMbKat = document.getElementById("mbKategoriProduk");
  const editKatProd = document.getElementById("editKategoriProduk");
  const editMasterKat = document.getElementById("editMasterKategori");
  const filterMasterBarangKategori = document.getElementById("filterMasterBarangKategori");
  const filterMasterBOMCategory = document.getElementById("filterMasterBOMCategory");
  const filterMasterBundleComponent = document.getElementById("filterMasterBundleComponent");
  const pdaReturGudang = document.getElementById("pdaReturGudang");
  const pdaEcomWarehouseDefault = document.getElementById("pdaEcomWarehouseDefault");
  const pdaEcomTujuanDefault = document.getElementById("pdaEcomTujuanDefault");
  const pdaEcomGudangPilih = document.getElementById("pdaEcomGudangPilih");
  const pdaEcomTujuanPilih = document.getElementById("pdaEcomTujuanPilih");
  const previousStokWarehouse = filterGudangStok?.value || '';

  let userAllowedWH = currentUser ? (currentUser.allowed_warehouses || ['ALL']) : ['ALL'];
  let filteredWHList = appState.warehouses;
  if (currentUser && currentUser.role !== 'superadmin' && !userAllowedWH.includes('ALL')) {
    filteredWHList = appState.warehouses.filter(w => userAllowedWH.includes(w.nama));
  }
  filteredWHList = sortDisplayItems(filteredWHList, w => w.nama);

  let htmlGudang = "";
  let htmlFilterGudang = `<option value="semua">Semua Gudang</option>`;
  let htmlFilterGudangStok = `<option value="">-- Pilih Gudang --</option><option value="semua">Semua Gudang</option>`;
  
  if (filteredWHList.length === 0) {
    htmlGudang = `<option value="">-- Belum Ada Gudang --</option>`;
  } else {
    filteredWHList.forEach(w => {
      htmlGudang += `<option value="${w.nama}">${w.nama}</option>`;
      htmlFilterGudang += `<option value="${w.nama}">${w.nama}</option>`;
      htmlFilterGudangStok += `<option value="${cekEsc(w.nama)}">${cekEsc(w.nama)}</option>`;
    });
  }
  
  if (selectMain) selectMain.innerHTML = htmlGudang;
  if (selectTujuan) selectTujuan.innerHTML = htmlGudang;
  if (selectMfg) selectMfg.innerHTML = htmlGudang;
  if (filterGudangDash) filterGudangDash.innerHTML = htmlFilterGudang;
  if (filterGudangStok) {
    filterGudangStok.innerHTML = htmlFilterGudangStok;
    filterGudangStok.value = Array.from(filterGudangStok.options).some(option => option.value === previousStokWarehouse)
      ? previousStokWarehouse
      : '';
  }
  if (pdaReturGudang) pdaReturGudang.innerHTML = htmlGudang;
  const scanWarehouse = document.getElementById('cekScanWarehouse');
  if (scanWarehouse) scanWarehouse.innerHTML = htmlGudang;
  const scanDestination = document.getElementById('cekScanDestination');
  if (scanDestination) scanDestination.innerHTML = htmlGudang;

  const sortedWarehouses = appState.warehouses.slice().sort((a, b) =>
    a.nama.localeCompare(b.nama, 'id', { numeric: true, sensitivity: 'base' })
  );
  const defaultWarehouseOptions = `<option value="">-- Tidak diterapkan --</option>` + sortedWarehouses.map(w =>
    `<option value="${cekEsc(w.nama)}">${cekEsc(w.nama)}</option>`
  ).join('');
  const runtimeWarehouseOptions = `<option value="">-- Pilih Lokasi Gudang --</option>` + sortDisplayItems(filteredWHList, w => w.nama).map(w =>
    `<option value="${cekEsc(w.nama)}">${cekEsc(w.nama)}</option>`
  ).join('');
  if (pdaEcomWarehouseDefault) {
    pdaEcomWarehouseDefault.innerHTML = defaultWarehouseOptions;
    pdaEcomWarehouseDefault.value = appState.pdaEcomWarehouse || '';
  }
  if (pdaEcomGudangPilih) pdaEcomGudangPilih.innerHTML = runtimeWarehouseOptions;

  const sortedTujuanOptions = sortDisplayItems(appState.tujuanKeluarOptions, tujuan => tujuan);
  const defaultTujuanOptions = `<option value="">-- Tidak diterapkan --</option>` + sortedTujuanOptions
    .map(tujuan => `<option value="${cekEsc(tujuan)}">${cekEsc(tujuan)}</option>`)
    .join('');
  const runtimeTujuanOptions = `<option value="">-- Pilih Tujuan Keluar --</option>` + sortedTujuanOptions
    .map(tujuan => `<option value="${cekEsc(tujuan)}">${cekEsc(tujuan)}</option>`)
    .join('');
  if (pdaEcomTujuanDefault) {
    pdaEcomTujuanDefault.innerHTML = defaultTujuanOptions;
    pdaEcomTujuanDefault.value = appState.pdaEcomTujuan || '';
  }
  if (pdaEcomTujuanPilih) pdaEcomTujuanPilih.innerHTML = runtimeTujuanOptions;

  let htmlKatProd = "";
  if (appState.kategoriProduk.length === 0) {
    htmlKatProd = `<option value="">-- Belum Ada Kategori --</option>`;
  } else {
    sortDisplayItems(appState.kategoriProduk, k => k).forEach(k => htmlKatProd += `<option value="${k}">${k}</option>`);
  }
  
  if(selectMbKat) selectMbKat.innerHTML = htmlKatProd;
  if(editKatProd) editKatProd.innerHTML = htmlKatProd;
  if(editMasterKat) editMasterKat.innerHTML = htmlKatProd;

  const filterCategoryOptions = `<option value="">Semua Kategori</option>` + sortDisplayItems(appState.kategoriProduk, category => category)
    .map(category => `<option value="${cekEsc(category)}">${cekEsc(category)}</option>`)
    .join('');
  [filterMasterBarangKategori, filterMasterBOMCategory].forEach(select => {
    if (!select) return;
    const previousValue = select.value;
    select.innerHTML = filterCategoryOptions;
    select.value = Array.from(select.options).some(option => option.value === previousValue) ? previousValue : '';
  });

  if (filterMasterBundleComponent) {
    const previousValue = filterMasterBundleComponent.value;
    filterMasterBundleComponent.innerHTML = `<option value="">Semua Komponen</option>` + sortDisplayItems(appState.masterBarang, product => product.sku)
      .map(product => `<option value="${cekEsc(product.sku)}">${cekEsc(product.sku)} - ${cekEsc(product.nama)}</option>`)
      .join('');
    filterMasterBundleComponent.value = Array.from(filterMasterBundleComponent.options).some(option => option.value === previousValue)
      ? previousValue
      : '';
  }

  const selectMbUom = document.getElementById("mbUom");
  const editMasterUom = document.getElementById("editMasterUom");
  if (selectMbUom) selectMbUom.innerHTML = getUomOptionsHtml(selectMbUom.value || 'PCS');
  if (editMasterUom) editMasterUom.innerHTML = getUomOptionsHtml(editMasterUom.value);

  renderSubLocationPickers();
  updateSetSkuOptions();
  updatePDAScanViewDefaults();
}

function getKategoriMasukOptionsHtml() {
  let html = `<option value="">-- Pilih Kategori Masuk --</option>`;
  sortDisplayItems(appState.kategoriMasukOptions, k => k).forEach(k => html += `<option value="${k}">${k}</option>`);
  return html;
}

function getTujuanKeluarOptionsHtml() {
  let html = `<option value="">-- Pilih Tujuan Keluar --</option>`;
  sortDisplayItems(appState.tujuanKeluarOptions, k => k).forEach(k => html += `<option value="${k}">${k}</option>`);
  return html;
}

function calculateStockRealtime(sku, gudang = null) {
  let totalMasuk = 0;
  let totalKeluar = 0;

  appState.transactions.forEach(t => {
    if (String(t.kode || '').toLowerCase() === String(sku || '').toLowerCase()) {
      if (!gudang || t.gudang === gudang) {
        if (t.tipe === 'MASUK') totalMasuk += Number(t.qty);
        if (t.tipe === 'KELUAR') totalKeluar += Number(t.qty);
      }
    }
  });

  return totalMasuk - totalKeluar;
}

function getStockBatchesFIFO(sku, gudang) {
  const batches = {};

  appState.transactions.forEach(t => {
    if (t.kode.toLowerCase() === sku.toLowerCase() && t.gudang === gudang) {
      const batchKey = t.kode_produksi && t.kode_produksi !== '-' ? t.kode_produksi : `TGL-${t.tanggal}`;
      if (!batches[batchKey]) {
        batches[batchKey] = { batch: batchKey, qty: 0, tanggal: t.tanggal };
      }
      if (t.tipe === 'MASUK') batches[batchKey].qty += Number(t.qty);
      if (t.tipe === 'KELUAR') batches[batchKey].qty -= Number(t.qty);
    }
  });

  return Object.values(batches)
    .filter(b => b.qty > 0)
    .sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal));
}

function previewBatchImage(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function(e) {
      currentUploadedBase64Image = e.target.result;
      document.getElementById("imgPreview").src = currentUploadedBase64Image;
      document.getElementById("imagePreviewContainer").style.display = "block";
    };
    reader.readAsDataURL(input.files[0]);
  }
}

function updateAllRowStockAlerts() {
  document.querySelectorAll(".item-row").forEach(rowEl => {
    const selectEl = rowEl.querySelector(".row-sku-select");
    if(selectEl && selectEl.value) {
      autofillBarangRow(selectEl, rowEl.id);
    }
  });
}

function autofillBarangRow(selectEl, rowId) {
  const selectedOpt = selectEl.options[selectEl.selectedIndex];
  const rowEl = document.getElementById(rowId);
  const namaInput = rowEl.querySelector(".row-nama-barang");
  const katInput = rowEl.querySelector(".row-kat-produk");
  const groupKodeProd = rowEl.querySelector(".group-kode-prod");
  const kodeProdInput = rowEl.querySelector(".row-kode-prod");
  const statusAlert = rowEl.querySelector(".status-stock-alert");

  if (selectedOpt && selectedOpt.value) {
    const sku = selectedOpt.value;
    const nama = selectedOpt.getAttribute("data-nama") || "";
    const kat = selectedOpt.getAttribute("data-kat") || "Bahan Baku";
    const gudang = document.getElementById("selectGudangMain").value;
    const tipe = document.getElementById("tipeTrans").value;
    
    namaInput.value = nama;
    katInput.value = kat;

    const currentStock = calculateStockRealtime(sku, gudang);

    if (tipe === 'KELUAR' || tipe === 'TRANSFER') {
      if (currentStock <= 0) {
        statusAlert.style.display = 'block';
        statusAlert.style.background = '#fee2e2';
        statusAlert.style.color = '#b91c1c';
        statusAlert.innerHTML = `⚠️ BARANG BELUM TERSEDIA / STOK KOSONG di <b>${gudang}</b> (Sisa: ${currentStock} ${uomOf(sku)})`;
      } else {
        const fifoBatches = getStockBatchesFIFO(sku, gudang);
        const oldestBatch = fifoBatches.length > 0 ? fifoBatches[0].batch : '-';
        statusAlert.style.display = 'block';
        statusAlert.style.background = '#dcfce7';
        statusAlert.style.color = '#15803d';
        statusAlert.innerHTML = `✅ Stok Available di <b>${gudang}</b>: ${currentStock} ${uomOf(sku)} (FIFO Batch Paling Lama: ${oldestBatch})`;
      }
    } else {
      statusAlert.style.display = 'none';
    }

    if (kat === 'Finish Good' && currentStock > 0) {
      groupKodeProd.style.display = 'block';
      const tglTrans = document.getElementById("tanggalTrans").value;
      kodeProdInput.value = generateKodeProduksi(nama, tglTrans);
    } else {
      groupKodeProd.style.display = 'none';
      kodeProdInput.value = '-';
    }
  } else {
    namaInput.value = "";
    katInput.value = "Bahan Baku";
    groupKodeProd.style.display = 'none';
    kodeProdInput.value = "-";
    statusAlert.style.display = 'none';
  }
}

function updateAllRowKodeProduksiOnDateChange() {
  const tglTrans = document.getElementById("tanggalTrans").value;
  const gudang = document.getElementById("selectGudangMain").value;
  document.querySelectorAll(".item-row").forEach(rowEl => {
    const skuSelect = rowEl.querySelector(".row-sku-select");
    const katInput = rowEl.querySelector(".row-kat-produk");
    const namaInput = rowEl.querySelector(".row-nama-barang");
    const groupKodeProd = rowEl.querySelector(".group-kode-prod");
    const kodeProdInput = rowEl.querySelector(".row-kode-prod");
    
    if (skuSelect && skuSelect.value && katInput && katInput.value === 'Finish Good') {
      const currentStock = calculateStockRealtime(skuSelect.value, gudang);
      if (currentStock > 0) {
        groupKodeProd.style.display = 'block';
        kodeProdInput.value = generateKodeProduksi(namaInput.value, tglTrans);
      } else {
        groupKodeProd.style.display = 'none';
        kodeProdInput.value = '-';
      }
    }
  });
}

function tambahBarisInput() {
  const container = document.getElementById("itemsContainer");
  const rowId = "row_" + Date.now() + "_" + Math.floor(Math.random()*1000);
  const tipe = document.getElementById("tipeTrans").value;

  const rowHtml = `
    <div class="item-row" id="${rowId}">
      <div style="flex:2;">
        <label>Pilih SKU / Kode Barang</label>
        <select class="row-sku-select" onchange="handleTransactionSkuChange(this, '${rowId}')" required></select>
        <div class="status-stock-alert" style="display:none; font-size:11px; margin-top:4px; padding:4px; background:#fee2e2; color:#b91c1c; border-radius:4px;"></div>
        <small class="row-production-meta" style="display:none; color:#64748b;"></small>
      </div>
      <div style="flex:2;">
        <label>Nama Barang</label>
        <input class="row-nama-barang" type="text" placeholder="Otomatis..." readonly style="background:#f1f5f9;">
      </div>
      <div class="group-kode-prod" style="display: none; flex:1.5;">
        <label style="color:#2563eb;">Kode Produksi</label>
        <input class="row-kode-prod" type="text" placeholder="Auto FG..." readonly style="background:#f1f5f9; font-weight:bold; cursor:not-allowed;">
      </div>
      <div style="flex:1.5;">
        <label>Kategori Produk</label>
        <input class="row-kat-produk" type="text" placeholder="Otomatis..." readonly style="background:#f1f5f9;">
      </div>
      <div class="col-masuk" style="flex:1.5; display: ${tipe === 'MASUK' ? 'block' : 'none'};">
        <label>Kategori Masuk</label>
        <select class="row-kategori-masuk-select">
          ${getKategoriMasukOptionsHtml()}
        </select>
      </div>
      <div class="col-keluar" style="flex:1.5; display: ${tipe === 'KELUAR' ? 'block' : 'none'};">
        <label>Tujuan Keluar</label>
        <select class="row-tujuan-keluar-select">
          ${getTujuanKeluarOptionsHtml()}
        </select>
      </div>
      <div style="flex:1;">
        <label>Qty <span class="row-uom-tag">(UoM)</span></label>
        <input class="row-qty" type="number" step="any" value="1" required>
      </div>
      <div>
        <button type="button" class="btn-danger" onclick="document.getElementById('${rowId}').remove()">Hapus</button>
      </div>
    </div>
  `;
  container.insertAdjacentHTML("beforeend", rowHtml);
  renderBarangDropdownOptions();
}

function handleTransactionSkuChange(selectEl, rowId) {
  const row = document.getElementById(rowId);
  if (row?.dataset.barcodeSku && row.dataset.barcodeSku !== selectEl.value) {
    delete row.dataset.barcodeSku;
    delete row.dataset.batchNo;
    delete row.dataset.shift;
    delete row.dataset.tanggalProduksi;
    const metadata = row.querySelector('.row-production-meta');
    metadata.textContent = '';
    metadata.style.display = 'none';
  }
  autofillBarangRow(selectEl, rowId);
}

function parseProductionBarcode(rawValue) {
  const barcode = String(rawValue || '').replace(/\s/g, '').toUpperCase();
  const configuredRules = Array.isArray(appState.skuBarcodeRules) ? appState.skuBarcodeRules : [];
  const matchedRules = configuredRules.filter(rule => {
    const start = Number(rule.sku_start);
    const length = Number(rule.sku_length);
    return rule.prefix && Number.isInteger(start) && start > 0 &&
      Number.isInteger(length) && length > 0 &&
      barcode.slice(start - 1, start - 1 + length) === String(rule.prefix).toUpperCase();
  });
  if (matchedRules.length > 1) {
    return { error: 'Barcode cocok dengan lebih dari satu aturan Master Prefix SKU. Periksa prefix dan range SKU.' };
  }
  if (matchedRules.length === 1) {
    const rule = matchedRules[0];
    const ranges = [
      { start: Number(rule.sku_start), length: Number(rule.sku_length) },
      { start: Number(rule.quantity_start), length: Number(rule.quantity_length) },
      { start: Number(rule.date_start), length: Number(rule.date_length) }
    ];
    const rangesValid = ranges.every(range => Number.isInteger(range.start) && range.start > 0 &&
      Number.isInteger(range.length) && range.length > 0);
    const rangesOverlap = ranges.some((range, index) => ranges.slice(index + 1).some(other =>
      range.start < other.start + other.length && other.start < range.start + range.length
    ));
    if (!rangesValid || rangesOverlap || String(rule.prefix).length !== ranges[0].length ||
        ranges[2].length !== 6 || barcode.length < Math.max(...ranges.map(range => range.start + range.length - 1))) {
      return { error: 'Pengaturan range Master Prefix SKU tidak valid atau barcode terlalu pendek.' };
    }
    const product = findMasterBarang(rule.sku);
    const quantityStart = Number(rule.quantity_start);
    const quantityLength = Number(rule.quantity_length);
    const dateStart = Number(rule.date_start);
    const dateLength = Number(rule.date_length);
    const quantityPart = barcode.slice(quantityStart - 1, quantityStart - 1 + quantityLength);
    const datePart = barcode.slice(dateStart - 1, dateStart - 1 + dateLength);
    const quantity = /^\d+$/.test(quantityPart) ? Number(quantityPart) : NaN;
    if (!product) return { error: `SKU "${rule.sku}" pada aturan prefix tidak ditemukan di Master Barang.` };
    if (!Number.isInteger(quantity) || quantity <= 0) return { error: 'Jumlah pada barcode harus berupa angka bulat lebih dari 0.' };
    if (dateLength !== 6 || !/^\d{6}$/.test(datePart)) return { error: 'Tanggal produksi pada barcode harus berformat YYMMDD (6 digit).' };
    const year = 2000 + Number(datePart.slice(0, 2));
    const month = Number(datePart.slice(2, 4));
    const day = Number(datePart.slice(4, 6));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return { error: 'Tanggal produksi pada barcode tidak valid.' };
    }
    return {
      product,
      quantity,
      date: `${year}-${datePart.slice(2, 4)}-${datePart.slice(4, 6)}`,
      batch: '',
      shift: '',
      source: 'sku-prefix'
    };
  }

  const products = appState.masterBarang.slice().sort((a, b) => String(b.sku || '').length - String(a.sku || '').length);
  const candidates = [];

  products.forEach(product => {
    const sku = String(product.sku || '').trim().toUpperCase();
    if (!sku || !barcode.startsWith(sku)) return;
    const suffix = barcode.slice(sku.length);
    const shiftMatch = suffix.match(/^(\d+)([A-Z])$/);
    if (!shiftMatch) return;
    const numericPart = shiftMatch[1];
    const shift = shiftMatch[2];

    for (let qtyLength = 1; qtyLength <= Math.min(4, numericPart.length - 7); qtyLength++) {
      const datePart = numericPart.slice(qtyLength, qtyLength + 6);
      const batch = numericPart.slice(qtyLength + 6);
      if (!/^\d{6}$/.test(datePart) || !/^\d{1,3}$/.test(batch)) continue;
      const quantity = Number(numericPart.slice(0, qtyLength));
      const year = 2000 + Number(datePart.slice(0, 2));
      const month = Number(datePart.slice(2, 4));
      const day = Number(datePart.slice(4, 6));
      const date = new Date(Date.UTC(year, month - 1, day));
      if (!quantity || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;

      candidates.push({
        product,
        quantity,
        date: `${year}-${datePart.slice(2, 4)}-${datePart.slice(4, 6)}`,
        batch,
        shift
      });
    }
  });

  if (!candidates.length) return { error: 'Barcode tidak cocok. Format yang didukung: SKU + qty + tanggal YYMMDD + batch + shift (contoh OMD2242610153P).' };
  const longestSkuLength = Math.max(...candidates.map(candidate => String(candidate.product.sku).length));
  const bestCandidates = candidates.filter(candidate => String(candidate.product.sku).length === longestSkuLength);
  if (bestCandidates.length !== 1) return { error: 'Barcode memiliki lebih dari satu kemungkinan pembacaan. Periksa format SKU, qty, tanggal, batch, dan shift.' };
  return bestCandidates[0];
}

function handleProductionBarcodeEnter(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  prosesProductionBarcode();
}

function prosesProductionBarcode() {
  const input = document.getElementById('productionBarcodeScan');
  const parsed = parseProductionBarcode(input.value);
  if (parsed.error) return alert(parsed.error);

  const dateInput = document.getElementById('tanggalTrans');
  const existingRows = Array.from(document.querySelectorAll('.item-row')).filter(row =>
    row.querySelector('.row-sku-select')?.value
  );
  if (parsed.source !== 'sku-prefix' && existingRows.length && dateInput.value !== parsed.date) {
    return alert('Tanggal barcode berbeda dari transaksi yang sedang disusun. Simpan transaksi saat ini terlebih dahulu.');
  }
  if (parsed.source !== 'sku-prefix') dateInput.value = parsed.date;

  let row = Array.from(document.querySelectorAll('.item-row')).find(item =>
    !item.querySelector('.row-sku-select')?.value
  );
  if (!row) {
    tambahBarisInput();
    row = document.querySelector('.item-row:last-child');
  }
  const skuSelect = row?.querySelector('.row-sku-select');
  if (!skuSelect || !Array.from(skuSelect.options).some(option => option.value === parsed.product.sku)) {
    return alert(`SKU ${parsed.product.sku} tidak tersedia pada pilihan transaksi.`);
  }

  skuSelect.value = parsed.product.sku;
  autofillBarangRow(skuSelect, row.id);
  row.querySelector('.row-qty').value = String(parsed.quantity);
  row.dataset.batchNo = parsed.batch;
  row.dataset.shift = parsed.shift;
  row.dataset.tanggalProduksi = parsed.source === 'sku-prefix' ? parsed.date : '';
  row.dataset.barcodeSku = parsed.product.sku;
  const metadata = row.querySelector('.row-production-meta');
  metadata.textContent = parsed.source === 'sku-prefix'
    ? `Barcode produksi: ${parsed.product.sku} - ${parsed.product.nama} | Qty ${parsed.quantity} | Tanggal produksi ${parsed.date}`
    : `Barcode produksi: Batch ${parsed.batch} | Shift ${parsed.shift}${parsed.shift === 'P' ? ' (Pagi)' : ''}`;
  metadata.style.display = 'block';
  input.value = '';
  input.focus();
}

function toggleTipeForm() {
  const tipe = document.getElementById("tipeTrans").value;
  document.querySelectorAll(".col-masuk").forEach(e => e.style.display = tipe === 'MASUK' ? 'block' : 'none');
  document.querySelectorAll(".col-keluar").forEach(e => e.style.display = tipe === 'KELUAR' ? 'block' : 'none');
  
  const wrpTujuan = document.getElementById("wrapperGudangTujuan");
  const lblMain = document.getElementById("lblGudangMain");

  if (tipe === 'TRANSFER') {
    wrpTujuan.style.display = 'block';
    const targetSubLocs = getSubLocations(document.getElementById('selectGudangTujuan').value);
    document.getElementById('wrapperSubLokasiTujuan').style.display = targetSubLocs.length ? 'block' : 'none';
    lblMain.innerText = 'Pilih Gudang Pengirim';
  } else {
    wrpTujuan.style.display = 'none';
    document.getElementById('wrapperSubLokasiTujuan').style.display = 'none';
    lblMain.innerText = 'Pilih Gudang';
  }

  const lblUpload = document.getElementById("lblUploadFoto");
  if (tipe === 'MASUK') {
    lblUpload.innerText = "Upload Foto/Gambar Penerimaan Barang (Bukti Fisik/Faktur):";
  } else {
    lblUpload.innerText = "Upload Foto/Gambar Pengeluaran Barang (Bukti Fisik Outbound):";
  }

  updateAllRowStockAlerts();
}

// SIMPAN TRANSAKSI DENGAN INTEGRASI BOLEH MINUS & CUSTOM BACKDATE
function simpanBatchTransaksi(shouldPrintSuratJalan = false) {
  if (currentUser && currentUser.crud && currentUser.crud.create === false) {
    return alert("Akses Ditolak: Anda tidak memiliki izin [Create] untuk membuat transaksi baru!");
  }

  const tipe = document.getElementById("tipeTrans").value;
  if (tipe === 'TRANSFER' && !requireFeatureAccess('transfer_send', 'Kirim Transfer')) return;
  const gudang = document.getElementById("selectGudangMain").value;
  const gudangTujuan = document.getElementById("selectGudangTujuan").value;
  const subLokasi = document.getElementById("selectSubLokasiMain")?.value || '';
  const subLokasiTujuan = document.getElementById("selectSubLokasiTujuan")?.value || '';
  const tanggal = document.getElementById("tanggalTrans").value;
  let noSJ = document.getElementById("noSuratJalan").value.trim();
  const pengirim = document.getElementById("pengirimKurir").value.trim() || "-";
  const rows = document.querySelectorAll(".item-row");

  if (!gudang) return alert("Pilih Lokasi Gudang terlebih dahulu!");
  if (tipe === 'TRANSFER' && gudang === gudangTujuan) return alert("Gudang Asal dan Gudang Tujuan tidak boleh sama!");
  if (!tanggal) return alert("Pilih Tanggal Transaksi!");
  if (rows.length === 0) return alert("Tambahkan minimal 1 baris barang!");

  // PENGECEKAN CUSTOM BACKDATE (PENERIMAAN, PENGELUARAN, TRANSFER)
  if (!appState.allowBackdate && isBackdate(tanggal)) {
    return alert(`ERROR: Transaksi tanggal mundur (Backdate: ${tanggal}) tidak diizinkan karena Fitur Custom Backdate sedang NON-AKTIF!`);
  }

  if (!noSJ) {
    const formattedDate = tanggal.replace(/-/g, "");
    noSJ = `SJ-${tipe === 'TRANSFER' ? 'TRF' : (tipe === 'MASUK' ? 'IN' : 'OUT')}-${formattedDate}-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  const accumulatedRequestQty = {};
  rows.forEach(r => {
    const sku = r.querySelector(".row-sku-select").value;
    const qty = Number(r.querySelector(".row-qty").value) || 0;
    if (sku) {
      accumulatedRequestQty[sku] = (accumulatedRequestQty[sku] || 0) + qty;
    }
  });

  // Pengecekan Blok Stok Minus hanya jika allowNegativeStock = false
  if ((tipe === 'KELUAR' || tipe === 'TRANSFER') && !appState.allowNegativeStock) {
    for (const sku in accumulatedRequestQty) {
      const availStock = calculateStockRealtime(sku, gudang);
      const reqQty = accumulatedRequestQty[sku];
      if (availStock < reqQty) {
        alert(`ERROR: Barang SKU "${sku}" belum tersedia / stok tidak mencukupi di ${gudang}! (Stok Ada: ${availStock}, Diminta: ${reqQty})`);
        return;
      }
    }
  }

  let isValid = true;
  const savedBatchItems = [];

  rows.forEach(r => {
    const sku = r.querySelector(".row-sku-select").value;
    const nama = r.querySelector(".row-nama-barang").value;
    const katProd = r.querySelector(".row-kat-produk").value;
    let kodeProd = r.querySelector(".row-kode-prod").value.trim();
    const qty = Number(r.querySelector(".row-qty").value);
    const batchNo = r.dataset.batchNo || '';
    const shift = r.dataset.shift || '';
    const tanggalProduksi = r.dataset.tanggalProduksi || '';

    if (!sku) { isValid = false; return; }
    
    if (katProd === 'Finish Good' && kodeProd && kodeProd !== '-') {
      // Kode produksi valid
    } else {
      kodeProd = '-';
    }

    const katMasukSelect = r.querySelector(".row-kategori-masuk-select");
    const katMasuk = katMasukSelect ? katMasukSelect.value : '';
    
    const tujKeluarSelect = r.querySelector(".row-tujuan-keluar-select");
    const tujKeluar = tujKeluarSelect ? tujKeluarSelect.value : '';

    if(tipe === 'MASUK' && !katMasuk) { isValid=false; alert('Pilih Kategori Masuk!'); return; }
    if(tipe === 'KELUAR' && !tujKeluar) { isValid=false; alert('Pilih Tujuan Keluar!'); return; }

    if (tipe === 'TRANSFER') {
      appState.pendingTransfers.push({
        id: Date.now() + Math.random(),
        no_sj: noSJ,
        gudang_asal: gudang,
        gudang_tujuan: gudangTujuan,
        sub_lokasi_asal: subLokasi,
        sub_lokasi_tujuan: subLokasiTujuan,
        sku: sku,
        nama_barang: nama,
        kode_produksi: kodeProd,
        batch_no: batchNo,
        shift,
        kategori_produk: katProd,
        qty_gd: qty,
        qty_gr: 0,
        status: 'PENDING GR',
        tanggal: tanggal,
        tanggal_produksi: tanggalProduksi,
        pengirim_kurir: pengirim,
        created_by: currentUser ? currentUser.name : 'System'
      });

      const transferItem = {
        id: Date.now() + Math.random(),
        no_sj: noSJ,
        tipe: 'KELUAR',
        gudang: gudang,
        sub_lokasi: subLokasi,
        kode: sku,
        nama_barang: nama,
        kode_produksi: kodeProd,
        batch_no: batchNo,
        shift,
        kategori_produk: katProd,
        tujuan_keluar: `Transfer Ke ${gudangTujuan}`,
        qty: qty,
        tanggal: tanggal,
        tanggal_produksi: tanggalProduksi,
        foto_bukti: currentUploadedBase64Image || '',
        pengirim_kurir: pengirim,
        input_by: currentUser ? currentUser.name : 'System'
      };
      appState.transactions.push(transferItem);
      savedBatchItems.push(transferItem);

    } else {
      const item = {
        id: Date.now() + Math.random(),
        no_sj: noSJ,
        tipe: tipe,
        gudang: gudang,
        sub_lokasi: subLokasi,
        kode: sku,
        nama_barang: nama,
        kode_produksi: kodeProd,
        batch_no: batchNo,
        shift,
        kategori_produk: katProd,
        kategori_masuk: tipe === 'MASUK' ? katMasuk : '',
        tujuan_keluar: tipe === 'KELUAR' ? tujKeluar : '',
        qty: qty,
        tanggal: tanggal,
        tanggal_produksi: tanggalProduksi,
        foto_bukti: currentUploadedBase64Image || '',
        pengirim_kurir: pengirim,
        input_by: currentUser ? currentUser.name : 'System'
      };
      appState.transactions.push(item);
      savedBatchItems.push(item);
    }
  });

  if (!isValid) return;

  saveData();

  if (shouldPrintSuratJalan) {
    cetakSuratJalanExternal(noSJ, savedBatchItems, gudang, gudangTujuan, tipe, pengirim, tanggal);
  } else {
    alert(`Transaksi ${tipe} Berhasil Disimpan! (No. SJ: ${noSJ})`);
  }

  document.getElementById("itemsContainer").innerHTML = "";
  document.getElementById("uploadFotoInput").value = "";
  document.getElementById("imgPreview").src = "";
  document.getElementById("imagePreviewContainer").style.display = "none";
  currentUploadedBase64Image = "";
  document.getElementById("noSuratJalan").value = "";
  document.getElementById("pengirimKurir").value = "";

  tambahBarisInput();
  renderDashboard(1);
  renderLaporanStok(1);
  renderTransferApproval(1);
  openTab('dashboardView', 'Dashboard');
}

function cetakSuratJalanExternal(noSJ, items, gudangAsal, gudangTujuan, tipe, kurir, tanggal) {
  const payload = {
    title: `BERITA SERAH TERIMA BARANG ${tipe.toUpperCase()}`,
    no_sj: noSJ,
    tanggal: tanggal,
    gudang: gudangAsal,
    gudang_tujuan: gudangTujuan || '-',
    tipe: tipe,
    pengirim_kurir: kurir,
    items: items
  };
  // Tab dibuka dulu (agar tidak diblokir popup blocker), lalu diarahkan setelah payload tersimpan di server
  const win = window.open('about:blank', '_blank');
  if (!win) return alert('Pop-up diblokir browser. Izinkan pop-up untuk situs ini lalu coba lagi.');
  apiCall('save_print', { payload }).then(r => {
    if (r.ok && r.body.status === 'success') {
      win.location.href = `surat_jalan.html?token=${encodeURIComponent(r.body.token)}`;
    } else {
      win.close();
      alert('Gagal menyiapkan surat jalan: ' + (r.body.message || 'Kesalahan tidak diketahui'));
    }
  });
}

function cetakUlangSJByNo(noSJ) {
  const items = appState.transactions.filter(t => t.no_sj === noSJ);
  if (items.length > 0) {
    const first = items[0];
    cetakSuratJalanExternal(noSJ, items, first.gudang, '-', first.tipe, first.pengirim_kurir, first.tanggal);
  } else {
    alert("Data Surat Jalan tidak ditemukan!");
  }
}

function showPhotoPreviewModal(base64Image) {
  if (!base64Image) return alert("Tidak ada foto lampiran.");
  document.getElementById("modalPreviewImg").src = base64Image;
  document.getElementById("modalPhotoPreview").style.display = "flex";
}

function openModalTransactionActions(id) {
  const item = appState.transactions.find(transaction => transaction.id == id);
  if (!item) return;
  selectedTransactionActionId = item.id;

  const canEdit = !currentUser || currentUser.role === 'superadmin' || (currentUser.crud && currentUser.crud.update);
  const canDelete = !currentUser || currentUser.role === 'superadmin' || (currentUser.crud && currentUser.crud.delete);
  document.getElementById("transactionPreviewSummary").textContent =
    `${item.no_sj || 'Tanpa SJ'} | ${item.tanggal || '-'} | Produksi ${item.tanggal_produksi || '-'} | ${item.kode || '-'} | ${item.gudang || '-'} | Qty ${item.qty ?? '-'}`;
  document.getElementById("btnPreviewTransactionEdit").style.display = canEdit ? 'inline-block' : 'none';
  document.getElementById("btnPreviewTransactionDelete").style.display = canDelete ? 'inline-block' : 'none';
  document.getElementById("btnPreviewTransactionPhoto").style.display = item.foto_bukti ? 'inline-block' : 'none';
  document.getElementById("btnPreviewTransactionSJ").style.display = item.no_sj ? 'inline-block' : 'none';
  document.getElementById("transactionPreviewReadOnly").style.display = !canEdit && !canDelete ? 'block' : 'none';
  document.getElementById("modalTransactionActions").style.display = "flex";
}

function closeModalTransactionActions() {
  document.getElementById("modalTransactionActions").style.display = "none";
}

function jalankanAksiPreviewTransaksi(action) {
  const item = appState.transactions.find(transaction => transaction.id == selectedTransactionActionId);
  if (!item) return closeModalTransactionActions();
  closeModalTransactionActions();
  if (action === 'edit') openEditModal(item.id);
  if (action === 'delete') hapusTransaksi(item.id);
  if (action === 'photo' && item.foto_bukti) showPhotoPreviewModal(item.foto_bukti);
  if (action === 'sj' && item.no_sj) cetakUlangSJByNo(item.no_sj);
}

function exportTransferApprovalExcel() {
  if (!requireFeatureAccess('export', 'Export')) return;
  if (!appState.pendingTransfers || appState.pendingTransfers.length === 0) {
    return alert("Belum ada data approval transfer untuk di-export!");
  }
  const exportRows = appState.pendingTransfers.map((tr, idx) => ({
    "No": idx + 1,
    "No SJ / Transfer ID": tr.no_sj || '-',
    "Tanggal": tr.tanggal || '-',
    "Tanggal Produksi": tr.tanggal_produksi || '-',
    "Gudang Pengirim": tr.gudang_asal || '-',
    "Gudang Penerima": tr.gudang_tujuan || '-',
    "Kode SKU": tr.sku,
    "Nama Barang": tr.nama_barang || '-',
    "Kode Produksi": tr.kode_produksi || '-',
    "Kategori Produk": tr.kategori_produk || '-',
    "UoM": uomOf(tr.sku),
    "Qty Kirim (GD)": tr.qty_gd,
    "Qty Terima (GR)": tr.qty_gr,
    "Status Approval": tr.status,
    "Pengirim / Kurir": tr.pengirim_kurir || '-',
    "Created By": tr.created_by || '-'
  }));
  const ws = XLSX.utils.json_to_sheet(exportRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Approval Transfer");
  XLSX.writeFile(wb, `Report_Approval_Transfer_${new Date().toISOString().split('T')[0]}.xlsx`);
}

function renderTransferApproval(page = 1) {
  pageTransfer = page;
  syncTransferApprovalPanel();
  renderCekPendingBanner();
  const tbody = document.getElementById("tabelTransferApproval");
  if (!tbody) return;
  tbody.innerHTML = "";

  const pageSize = parseInt(document.getElementById("pageSizeTransfer")?.value) || 10;
  const sortedTransfers = sortDisplayItems(
    (appState.pendingTransfers || []).filter(tr =>
      canAccessWarehouseName(tr.gudang_asal) || canAccessWarehouseName(tr.gudang_tujuan)
    ),
    tr => `${tr.tanggal || ''}_${tr.no_sj || ''}_${tr.sku || ''}`
  );
  const totalItems = sortedTransfers.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  if (pageTransfer > totalPages) pageTransfer = totalPages;
  if (pageTransfer < 1) pageTransfer = 1;

  const startIndex = (pageTransfer - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

  if (totalItems === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#94a3b8; padding:20px;">Belum ada antrean transfer barang.</td></tr>`;
  } else {
    const paginated = sortedTransfers.slice(startIndex, endIndex);
    paginated.forEach(tr => {
      let badge = 'badge-warning';
      const isCompleted = String(tr.status || '').includes('COMPLETED');
      if (isCompleted) {
        badge = 'badge-success';
      } else {
        badge = 'badge-warning';
      }

      let actionBtn = '-';
      if (!isCompleted && canAccessWarehouseName(tr.gudang_tujuan) && hasFeatureAccess('transfer_receive') &&
          (!currentUser || !currentUser.crud || currentUser.crud.create !== false)) {
        actionBtn = `<button class="btn-success" style="padding:4px 8px; font-size:11px;" onclick="bukaModalProsesReceipt(${tr.id})">Proses GR</button>`;
      } else if (isCompleted) {
        actionBtn = `<span style="color:#16a34a; font-size:12px;">✔ Selesai Diterima</span>`;
      }

      tbody.innerHTML += `
        <tr>
          <td><code>${tr.no_sj}</code><br><small>${tr.tanggal || '-'}</small></td>
          <td><b>${tr.gudang_asal}</b></td>
          <td><b>${tr.gudang_tujuan}</b></td>
          <td><b>${tr.sku}</b> - ${tr.nama_barang}</td>
          <td class="text-center">${tr.qty_gd} ${uomOf(tr.sku)}</td>
          <td class="text-center">${tr.qty_gr} ${uomOf(tr.sku)}</td>
          <td class="text-center">${actionBtn}</td>
          <td class="text-center"><span class="badge ${badge}">${tr.status}</span></td>
        </tr>
      `;
    });
  }

  const infoEl = document.getElementById("infoTransferPage");
  const indicatorEl = document.getElementById("indicatorTransferPage");
  const btnPrev = document.getElementById("btnPrevTransfer");
  const btnNext = document.getElementById("btnNextTransfer");

  updatePaginationControls(pageTransfer, totalPages, btnPrev, btnNext, indicatorEl, infoEl, startIndex, endIndex, totalItems);
}

function changeTransferPage(delta) {
  renderTransferApproval(pageTransfer + delta);
}

function bukaModalProsesReceipt(id) {
  if (!requireFeatureAccess('transfer_receive', 'Terima Transfer')) return;
  if (currentUser && currentUser.crud && currentUser.crud.create === false) {
    return alert("Akses ditolak: Anda tidak memiliki izin [Create] untuk mencatat penerimaan transfer.");
  }
  const item = appState.pendingTransfers.find(p => p.id == id);
  if(!item) return;
  if (String(item.status || '').includes('COMPLETED')) return alert("Transfer ini sudah selesai diterima.");
  if (!canAccessWarehouseName(item.gudang_tujuan)) return alert("Anda tidak memiliki akses ke gudang tujuan transfer ini.");
  if (!Number.isFinite(Number(item.qty_gd)) || Number(item.qty_gd) <= 0) return alert("Qty transfer tidak valid.");
  
  item.qty_gr = item.qty_gd;
  item.status = 'COMPLETED';

  appState.transactions.push({
    id: Date.now() + Math.random(),
    no_sj: item.no_sj,
    tipe: 'MASUK',
    gudang: item.gudang_tujuan,
    sub_lokasi: item.sub_lokasi_tujuan || '',
    kode: item.sku,
    nama_barang: item.nama_barang,
    kode_produksi: item.kode_produksi,
    batch_no: item.batch_no || '',
    shift: item.shift || '',
    tanggal_produksi: item.tanggal_produksi || '',
    kategori_produk: item.kategori_produk,
    kategori_masuk: `Transfer Dari ${item.gudang_asal}`,
    qty: item.qty_gr,
    tanggal: new Date().toISOString().split("T")[0],
    pengirim_kurir: item.pengirim_kurir,
    input_by: currentUser ? currentUser.name : 'System'
  });

  saveData();
  renderTransferApproval(pageTransfer);
  renderDashboard(1);
  renderLaporanStok(1);
  alert("Transfer barang berhasil diterima (Good Receipt) di gudang tujuan!");
}

function prosesManufaktur(e) {
  e.preventDefault();
  if (currentUser && currentUser.crud && currentUser.crud.create === false) {
    return alert("Akses ditolak: Anda tidak memiliki izin [Create] untuk proses manufaktur.");
  }
  const tahap = document.getElementById("mfgTahap").value;
  const gudang = document.getElementById("mfgGudang").value;
  const subLokasi = document.getElementById("mfgSubLokasi")?.value || '';
  const tanggal = document.getElementById("mfgTanggal").value;
  const rows = Array.from(document.querySelectorAll(".mfg-input-row"));
  const productionInputs = rows.map(row => ({
    bomId: row.querySelector(".mfg-row-bom").value,
    qty: Number(row.querySelector(".mfg-row-qty").value),
    bom: (appState.masterBOM || []).find(item => item.id == row.querySelector(".mfg-row-bom").value)
  }));

  if (!gudang || productionInputs.length === 0 || productionInputs.some(input => !input.bom || !Number.isFinite(input.qty) || input.qty <= 0)) {
    return alert("Pilih gudang dan lengkapi setiap baris BOM serta Qty.");
  }
  if (!tanggal) return alert("Pilih Tanggal Manufaktur!");

  // PENGECEKAN CUSTOM BACKDATE (MANUFAKTUR)
  if (!appState.allowBackdate && isBackdate(tanggal)) {
    return alert(`ERROR: Transaksi Manufaktur tanggal mundur (Backdate: ${tanggal}) tidak diizinkan karena Fitur Custom Backdate sedang NON-AKTIF!`);
  }

  const requiredBySku = {};
  productionInputs.forEach(({ bom, qty }) => {
    (bom.items || []).forEach(component => {
      requiredBySku[component.sku] = (requiredBySku[component.sku] || 0) + Number(component.qty) * qty;
    });
  });
  if (!appState.allowNegativeStock) {
    for (const sku in requiredBySku) {
      const currentStock = calculateStockRealtime(sku, gudang);
      if (currentStock < requiredBySku[sku]) {
        return alert(`Stok komponen "${sku}" tidak mencukupi di ${gudang}! Diperlukan: ${requiredBySku[sku]}, Tersedia: ${currentStock}`);
      }
    }
  }

  const batchIdMfg = `MFG-${Date.now()}`;
  productionInputs.forEach(({ bom, qty }) => {
    (bom.items || []).forEach(component => {
      const requiredTotal = Number(component.qty) * qty;
      const masterComponent = findMasterBarang(component.sku);
      appState.transactions.push({
        id: Date.now() + Math.random(), no_sj: batchIdMfg, tipe: 'KELUAR', gudang,
        sub_lokasi: subLokasi,
        kode: component.sku, nama_barang: masterComponent ? masterComponent.nama : component.sku,
        kode_produksi: '-', kategori_produk: masterComponent ? masterComponent.kategori_produk : 'Bahan Baku',
        tujuan_keluar: `Proses Manufaktur (${bom.nama_bom})`, qty: requiredTotal, tanggal,
        pengirim_kurir: 'Manufaktur Internal', input_by: currentUser ? currentUser.name : 'System'
      });
    });

    const masterOutput = findMasterBarang(bom.sku_hasil);
    const outputName = masterOutput ? masterOutput.nama : bom.sku_hasil;
    const outputCategory = masterOutput ? masterOutput.kategori_produk :
      (tahap === 'WIP' ? 'WIP' : (tahap === 'Semi Finished Good' ? 'Semi Finished Good' : 'Finish Good'));
    const outputProductionCode = outputCategory === 'Finish Good' ? generateKodeProduksi(outputName, tanggal) : '-';
    appState.transactions.push({
      id: Date.now() + Math.random(), no_sj: batchIdMfg, tipe: 'MASUK', gudang,
      sub_lokasi: subLokasi,
      kode: bom.sku_hasil, nama_barang: outputName, kode_produksi: outputProductionCode,
      kategori_produk: outputCategory, kategori_masuk: `Hasil Manufaktur (${bom.nama_bom})`,
      qty, tanggal, pengirim_kurir: 'Manufaktur Internal', input_by: currentUser ? currentUser.name : 'System'
    });
  });

  saveData();
  const outputSummary = productionInputs.map(({ bom, qty }) => `${qty} ${uomOf(bom.sku_hasil)} SKU ${bom.sku_hasil}`).join('; ');
  alert(`Proses Manufaktur Berhasil Dijalankan! Menghasilkan ${outputSummary}`);
  resetMfgRowsSetelahProses();
  renderDashboard(1);
  renderLaporanStok(1);
  openTab('dashboardView', 'Dashboard');
}

function openEditModal(id) {
  if (currentUser && currentUser.crud && currentUser.crud.update === false) {
    return alert("Akses Ditolak: Anda tidak memiliki izin [Update/Edit] untuk mengubah data transaksi!");
  }

  const item = appState.transactions.find(t => t.id == id);
  if (!item) return;

  document.getElementById("editTransId").value = item.id;
  document.getElementById("editTipe").value = item.tipe;
  document.getElementById("editKode").value = `${item.kode} - ${item.nama_barang || ''}`;
  document.getElementById("editKodeProduksi").value = item.kode_produksi || '-';
  document.getElementById("editKategoriProduk").value = item.kategori_produk;
  document.getElementById("editKategoriMasuk").value = item.kategori_masuk || '';
  document.getElementById("editTujuanKeluar").value = item.tujuan_keluar || '';
  document.getElementById("editQty").value = item.qty;
  document.getElementById("editTanggalProduksi").value = item.tanggal_produksi || '';
  document.getElementById("editTanggal").value = item.tanggal;

  toggleEditTipeFields();
  document.getElementById("modalEdit").style.display = "flex";
}

function toggleEditTipeFields() {
  const tipe = document.getElementById("editTipe").value;
  const katProd = document.getElementById("editKategoriProduk").value;
  
  document.getElementById("groupEditKodeProd").style.display = katProd === 'Finish Good' ? 'block' : 'none';
  document.getElementById("groupEditKatMasuk").style.display = tipe === 'MASUK' ? 'block' : 'none';
  document.getElementById("groupEditTujKeluar").style.display = tipe === 'KELUAR' ? 'block' : 'none';
}

function closeModalEdit() {
  document.getElementById("modalEdit").style.display = "none";
}

function simpanEditTransaksi(e) {
  e.preventDefault();
  const id = document.getElementById("editTransId").value;
  const item = appState.transactions.find(t => t.id == id);

  if (item) {
    const newTanggal = document.getElementById("editTanggal").value;

    // PENGECEKAN CUSTOM BACKDATE EDIT TRANSAKSI
    if (!appState.allowBackdate && isBackdate(newTanggal)) {
      return alert(`ERROR: Perubahan tanggal ke tanggal mundur (Backdate: ${newTanggal}) tidak diizinkan karena Fitur Custom Backdate sedang NON-AKTIF!`);
    }

    // PENGECEKAN STOK MINUS EDIT TRANSAKSI
    const newTipeEdit = document.getElementById("editTipe").value;
    const newQtyEdit = Number(document.getElementById("editQty").value);
    if (!appState.allowNegativeStock) {
      const stokSekarang = calculateStockRealtime(item.kode, item.gudang);
      const efekLama = item.tipe === 'MASUK' ? Number(item.qty) : (item.tipe === 'KELUAR' ? -Number(item.qty) : 0);
      const efekBaru = newTipeEdit === 'MASUK' ? newQtyEdit : (newTipeEdit === 'KELUAR' ? -newQtyEdit : 0);
      const stokSetelahEdit = stokSekarang - efekLama + efekBaru;
      if (stokSetelahEdit < 0 && stokSetelahEdit < stokSekarang) {
        return alert(`ERROR: Perubahan ini membuat stok SKU "${item.kode}" di ${item.gudang} menjadi minus (${stokSetelahEdit}). Fitur Stok Minus sedang NON-AKTIF!`);
      }
    }

    item.tipe = newTipeEdit;
    item.kategori_produk = document.getElementById("editKategoriProduk").value;
    
    if (item.kategori_produk === 'Finish Good') {
      item.kode_produksi = document.getElementById("editKodeProduksi").value.trim();
    } else {
      item.kode_produksi = '-';
    }

    item.kategori_masuk = item.tipe === 'MASUK' ? document.getElementById("editKategoriMasuk").value.trim() : '';
    item.tujuan_keluar = item.tipe === 'KELUAR' ? document.getElementById("editTujuanKeluar").value.trim() : '';
    item.qty = Number(document.getElementById("editQty").value);
    item.tanggal_produksi = document.getElementById("editTanggalProduksi").value;
    item.tanggal = newTanggal;
    item.last_edit_by = currentUser ? currentUser.name : 'System';

    saveData();
    closeModalEdit();
    renderDashboard(currentPage);
    renderLaporanStok(1);
    alert("Data transaksi berhasil diperbarui!");
  }
}

function toggleExportDateRange() {
  const mode = document.getElementById("modeExport").value;
  document.getElementById("exportDateGroup").style.display = mode === 'custom' ? 'flex' : 'none';
  renderDashboard(1);
}

function isDateInFilter(dateStr, mode, tglAwalId, tglAkhirId) {
  if (mode === 'semua') return true;
  if (!dateStr) return false;

  const itemDate = new Date(dateStr);
  itemDate.setHours(0,0,0,0);

  if (mode === 'custom') {
    const startVal = document.getElementById(tglAwalId).value;
    const endVal = document.getElementById(tglAkhirId).value;
    if (!startVal || !endVal) return true;

    const startDate = new Date(startVal);
    const endDate = new Date(endVal);
    startDate.setHours(0,0,0,0);
    endDate.setHours(0,0,0,0);

    return itemDate.getTime() >= startDate.getTime() && itemDate.getTime() <= endDate.getTime();
  }
  return true;
}

function exportToExcel() {
  if (!requireFeatureAccess('export', 'Export')) return;
  const mode = document.getElementById("modeExport").value;
  const selectedGudang = document.getElementById("filterGudangDashboard").value;
  
  const filteredData = appState.transactions.filter(t => {
    const matchDate = isDateInFilter(t.tanggal, mode, 'tglExportAwal', 'tglExportAkhir');
    const matchGudang = selectedGudang === 'semua' || t.gudang === selectedGudang;
    return matchDate && matchGudang;
  });

  if (filteredData.length === 0) return alert("Tidak ada data transaksi untuk di-export!");

  const excelRows = filteredData.map((t, idx) => ({
    "No": idx + 1,
    "No Surat Jalan": t.no_sj || '-',
    "Tipe": t.tipe,
    "Gudang": t.gudang,
    "Sub Lokasi": t.sub_lokasi || '',
    "Kode SKU": t.kode,
    "Nama Barang": t.nama_barang || '-',
    "Kode Produksi": t.kode_produksi || '-',
    "Tanggal Produksi": t.tanggal_produksi || '-',
    "Kategori Produk": t.kategori_produk,
    "UoM": uomOf(t.kode),
    "Kategori/Tujuan": t.tipe === 'MASUK' ? (t.kategori_masuk || '-') : (t.tujuan_keluar || '-'),
    "Qty": t.qty,
    "Tanggal": t.tanggal,
    "Pengirim/Kurir": t.pengirim_kurir || '-',
    "Input Oleh": t.input_by || '-'
  }));

  const worksheet = XLSX.utils.json_to_sheet(excelRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Riwayat Transaksi");
  XLSX.writeFile(workbook, `Report_Pergudangan_${new Date().toISOString().split('T')[0]}.xlsx`);
}

function bukaModalHapusSemuaData() {
  if (currentUser && currentUser.crud && currentUser.crud.delete === false) {
    return alert("Akses Ditolak: Anda tidak memiliki izin [Delete]!");
  }
  bukaModalGeneralDelete("Apakah Anda yakin ingin MENGHAPUS SEMUA DATA TRANSAKSI? Tindakan ini tidak dapat dibatalkan.", () => {
    appState.transactions = [];
    saveData();
    renderDashboard(1);
    renderLaporanStok(1);
    alert("Semua data transaksi telah dihapus.");
  });
}

function renderDashboard(page = 1) {
  currentPage = page;
  const tbody = document.getElementById("tabelDashboard");
  if(!tbody) return;

  const keyword = document.getElementById("search").value.toLowerCase();
  const selectedGudang = document.getElementById("filterGudangDashboard").value;
  const modeExport = document.getElementById("modeExport").value;
  const pageSize = parseInt(document.getElementById("pageSizeSelect").value) || 25;

  tbody.innerHTML = "";
  let tMasuk = 0, tKeluar = 0;

  let userAllowedWH = currentUser ? (currentUser.allowed_warehouses || ['ALL']) : ['ALL'];

  const filtered = appState.transactions.filter(t => {
    const matchSearch = t.kode.toLowerCase().includes(keyword) || 
      (t.nama_barang && t.nama_barang.toLowerCase().includes(keyword)) ||
      (t.no_sj && t.no_sj.toLowerCase().includes(keyword)) ||
      t.kategori_produk.toLowerCase().includes(keyword) || 
      (t.kategori_masuk && t.kategori_masuk.toLowerCase().includes(keyword)) ||
      (t.tujuan_keluar && t.tujuan_keluar.toLowerCase().includes(keyword));

    const matchGudangFilter = selectedGudang === 'semua' || t.gudang === selectedGudang;
    const matchUserWHPermission = !currentUser || currentUser.role === 'superadmin' || userAllowedWH.includes('ALL') || userAllowedWH.includes(t.gudang);
    const matchDate = isDateInFilter(t.tanggal, modeExport, 'tglExportAwal', 'tglExportAkhir');

    return matchSearch && matchGudangFilter && matchUserWHPermission && matchDate;
  }).sort((a, b) => compareDisplayValues(`${a.tanggal || ''}_${a.no_sj || ''}_${a.kode || ''}`, `${b.tanggal || ''}_${b.no_sj || ''}_${b.kode || ''}`));

  filtered.forEach(item => {
    if (item.tipe === "MASUK") tMasuk += Number(item.qty);
    else tKeluar += Number(item.qty);
  });

  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginatedData = filtered.slice(startIndex, endIndex);

  const canEdit = !currentUser || currentUser.role === 'superadmin' || (currentUser.crud && currentUser.crud.update);
  const canDelete = !currentUser || currentUser.role === 'superadmin' || (currentUser.crud && currentUser.crud.delete);

  if (paginatedData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; color:#94a3b8; padding: 20px;">Tidak ada data transaksi yang ditemukan.</td></tr>`;
  } else {
    paginatedData.forEach((item, index) => {
      const realIndex = startIndex + index + 1;

      tbody.innerHTML += `
        <tr>
          <td class="text-center">${realIndex}</td>
          <td class="text-center"><b style="color:${item.tipe === 'MASUK' ? '#16a34a' : '#dc2626'}">${item.tipe}</b></td>
          <td><b>${cekEsc(item.gudang || '-')}</b>${item.sub_lokasi ? `<br><small>${cekEsc(item.sub_lokasi)}</small>` : ''}</td>
          <td><code>${item.kode}</code></td>
          <td><b>${item.nama_barang || '-'}</b></td>
          <td>${item.kode_produksi || '-'}</td>
          <td>${item.kategori_produk}</td>
          <td>${item.tipe === 'MASUK' ? (item.kategori_masuk || '-') : (item.tujuan_keluar || '-')}</td>
          <td class="text-center"><b>${item.qty}</b> <span class="uom-tag">${uomOf(item.kode)}</span></td>
          <td>${item.tanggal_produksi || '-'}</td>
          <td>${item.tanggal}</td>
          <td class="text-center">
            <button type="button" class="btn-info" onclick="openModalTransactionActions(${JSON.stringify(item.id)})">Preview</button>
          </td>
        </tr>
      `;
    });
  }

  const btnPrev = document.getElementById("btnPrevPage");
  const btnNext = document.getElementById("btnNextPage");
  const indicatorEl = document.getElementById("pageIndicator");
  const infoEl = document.getElementById("paginationInfo");

  updatePaginationControls(currentPage, totalPages, btnPrev, btnNext, indicatorEl, infoEl, startIndex, endIndex, totalItems);

  document.getElementById("totalMasuk").textContent = tMasuk.toLocaleString('id-ID');
  document.getElementById("totalKeluar").textContent = tKeluar.toLocaleString('id-ID');
  document.getElementById("totalStok").textContent = (tMasuk - tKeluar).toLocaleString('id-ID');
  document.getElementById("jenisProduk").textContent = new Set(appState.transactions.map(d => d.kode)).size;
}

function changePage(delta) {
  renderDashboard(currentPage + delta);
}

function hapusTransaksi(id) {
  if (currentUser && currentUser.crud && currentUser.crud.delete === false) {
    return alert("Akses Ditolak: Anda tidak memiliki izin [Delete]!");
  }
  bukaModalGeneralDelete("Apakah Anda yakin ingin menghapus transaksi barang ini?", () => {
    appState.transactions = appState.transactions.filter(t => t.id != id);
    saveData();
    renderDashboard(currentPage);
    renderLaporanStok(1);
  });
}

function updatePaginationControls(page, totalPages, btnPrevEl, btnNextEl, indicatorEl, infoEl, startIndex, endIndex, totalItems, infoTextPrefix = "Menampilkan") {
  if (infoEl) infoEl.textContent = `${infoTextPrefix} ${totalItems === 0 ? 0 : startIndex + 1} - ${endIndex} dari ${totalItems} data`;
  if (indicatorEl) indicatorEl.textContent = `Halaman ${page} / ${totalPages}`;

  if (btnPrevEl) {
    if (page <= 1 || totalPages <= 1) {
      btnPrevEl.style.display = 'none';
    } else {
      btnPrevEl.style.display = 'inline-block';
    }
  }

  if (btnNextEl) {
    if (page >= totalPages || totalPages <= 1) {
      btnNextEl.style.display = 'none';
    } else {
      btnNextEl.style.display = 'inline-block';
    }
  }
}

function compareDisplayValues(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), 'id', { numeric: true, sensitivity: 'base' });
}

function sortDisplayItems(items, getValue) {
  return items.slice().sort((a, b) => compareDisplayValues(getValue(a), getValue(b)));
}

// MANUFAKTUR KODE PRODUKSI HELPER
function tambahBarisMfg(bomId = '', qty = 1) {
  const container = document.getElementById("mfgItemsContainer");
  if (!container) return;
  const rowId = `mfg_input_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  container.insertAdjacentHTML("beforeend", `
    <div class="mfg-input-row" id="${rowId}">
      <div class="mfg-input-bom">
        <label>Pilih Master BOM</label>
        <select class="mfg-row-bom" onchange="updateMfgKodeProduksiAuto()" required></select>
      </div>
      <div class="mfg-input-qty">
        <label>Qty Dihasilkan</label>
        <input class="mfg-row-qty" type="number" step="any" min="0.0001" value="${qty}" oninput="updateMfgKodeProduksiAuto()" required>
        <small class="mfg-row-kode-prod"></small>
      </div>
      <button type="button" class="btn-danger" onclick="document.getElementById('${rowId}').remove(); updateMfgKodeProduksiAuto()">Hapus</button>
    </div>`);
  renderBOMDropdownOptions();
  if (bomId) document.getElementById(rowId).querySelector(".mfg-row-bom").value = bomId;
  updateMfgKodeProduksiAuto();
}

function tambahBanyakBarisMfg() {
  const n = Math.min(50, Math.max(1, parseInt(document.getElementById('mfgJumlahBaris')?.value, 10) || 1));
  for (let i = 0; i < n; i++) tambahBarisMfg();
}

function hapusSemuaBarisMfg() {
  if (!confirm('Kosongkan semua baris input manufaktur?')) return;
  const c = document.getElementById('mfgItemsContainer');
  if (c) c.innerHTML = '';
  renderMfgSummary();
}

function resetMfgRowsSetelahProses() {
  const c = document.getElementById('mfgItemsContainer');
  if (c) c.innerHTML = '';
  tambahBarisMfg();
}

// Ringkasan multi input: total bahan yang dibutuhkan dari seluruh baris + cek ketersediaan stok
function renderMfgSummary() {
  const box = document.getElementById('mfgSummaryBox');
  if (!box) return;
  const gudang = document.getElementById('mfgGudang')?.value || '';
  const rows = Array.from(document.querySelectorAll('.mfg-input-row'));
  if (rows.length === 0) {
    box.innerHTML = `<div class="mfg-summary-empty">Belum ada baris input. Tambahkan baris BOM untuk melihat ringkasan bahan.</div>`;
    return;
  }
  const totals = {};
  const outputs = [];
  rows.forEach(row => {
    const bomId = row.querySelector('.mfg-row-bom')?.value;
    const qty = Number(row.querySelector('.mfg-row-qty')?.value);
    const bom = (appState.masterBOM || []).find(item => item.id == bomId);
    if (!bom || !Number.isFinite(qty) || qty <= 0) return;
    (bom.items || []).forEach(c => { totals[c.sku] = (totals[c.sku] || 0) + Number(c.qty) * qty; });
    outputs.push({ sku: bom.sku_hasil, nama: bom.nama_bom, qty });
  });
  const compRows = Object.keys(totals).map(sku => {
    const m = findMasterBarang(sku);
    const tersedia = gudang && gudang !== 'semua' ? calculateStockRealtime(sku, gudang) : null;
    const cukup = tersedia === null || appState.allowNegativeStock || tersedia >= totals[sku];
    return `<tr><td><code>${cekEsc(sku)}</code></td><td>${cekEsc(m ? m.nama : sku)}</td>` +
      `<td class="text-center"><b>${totals[sku]}</b></td>` +
      `<td class="text-center">${tersedia === null ? '-' : tersedia}</td>` +
      `<td class="text-center">${cukup ? '<span class="badge badge-success">Cukup</span>' : '<span class="badge badge-danger">Kurang</span>'}</td></tr>`;
  }).join('');
  const outRows = outputs.map(o =>
    `<li>${cekEsc(o.qty)} ${cekEsc(uomOf(o.sku))} &middot; <code>${cekEsc(o.sku)}</code> (${cekEsc(o.nama)})</li>`
  ).join('');
  box.innerHTML = `<div class="mfg-summary-head"><b>Ringkasan Multi Input</b>` +
    `<span>${rows.length} baris &middot; ${outputs.length} hasil produksi</span></div>` +
    `<div class="table-wrap"><table><thead><tr><th>SKU Bahan</th><th>Nama</th>` +
    `<th class="text-center">Total Dibutuhkan</th><th class="text-center">Stok di Gudang</th><th class="text-center">Status</th></tr></thead>` +
    `<tbody>${compRows || '<tr><td colspan="5" class="text-center">Belum ada komponen.</td></tr>'}</tbody></table></div>` +
    (outRows ? `<ul class="mfg-output-list">${outRows}</ul>` : '');
}

function toggleMfgKodeProduksi() {
  updateMfgKodeProduksiAuto();
}

function updateMfgKodeProduksiAuto() {
  renderMfgSummary();
  const mfgTahap = document.getElementById("mfgTahap") ? document.getElementById("mfgTahap").value : "";
  const tglInput = document.getElementById("mfgTanggal")?.value;
  document.querySelectorAll(".mfg-input-row").forEach(row => {
    const preview = row.querySelector(".mfg-row-kode-prod");
    const bomId = row.querySelector(".mfg-row-bom")?.value;
    const bom = (appState.masterBOM || []).find(item => item.id == bomId);
    if (!preview) return;
    const masterOutput = bom ? findMasterBarang(bom.sku_hasil) : null;
    const outputCategory = masterOutput ? masterOutput.kategori_produk : mfgTahap;
    if (!bom || outputCategory !== "Finish Good") {
      preview.textContent = "";
      return;
    }
    preview.textContent = `Kode Produksi: ${generateKodeProduksi(masterOutput ? masterOutput.nama : bom.sku_hasil, tglInput)}`;
  });
}

// ==========================================
// PDA SCANNER HARDWARE SCAN
// ==========================================
let pdaMode = 'Ecommerce';
let currentLockedAWB = "";
let scannedItemsList = [];
let currentAWBRequiredItems = {};

let currentLockedReturAWB = "";
let scannedReturItemsList = [];

function exportPDAScanData() {
  if (!requireFeatureAccess('export', 'Export')) return;
  if (!appState.pdaScans || appState.pdaScans.length === 0) {
    return alert("Belum ada data scan PDA untuk di-export!");
  }
  const exportRows = appState.pdaScans.map((s, idx) => ({
    "No": idx + 1,
    "Tanggal Scan": s.date || '-',
    "Mode Scan": s.mode || 'Ecommerce',
    "Air Way Bill (AWB)": s.awb || '-',
    "Kode SKU Finish Good": s.kode_fg,
    "Qty": s.qty
  }));
  const ws = XLSX.utils.json_to_sheet(exportRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Scan PDA Report");
  XLSX.writeFile(wb, `Scan_PDA_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
}

function setPDAMode(mode) {
  const requestedMode = mode === 'Retur' ? 'Retur' : 'Ecommerce';
  const permission = requestedMode === 'Retur' ? 'pda_retur' : 'pda_ecommerce';
  if (!requireFeatureAccess(permission, requestedMode === 'Retur' ? 'PDA Retur' : 'PDA E-Commerce')) return;
  pdaMode = requestedMode;
  document.getElementById('btnEcom').classList.toggle('active', pdaMode === 'Ecommerce');
  document.getElementById('btnPdaRetur').classList.toggle('active', pdaMode === 'Retur');

  document.getElementById('pdaEcomContainer').style.display = pdaMode === 'Ecommerce' ? 'block' : 'none';
  document.getElementById('pdaReturContainer').style.display = pdaMode === 'Retur' ? 'block' : 'none';

  updatePDAScanViewDefaults();
}

function detect3PL(awb) {
  if (!awb) return "LAINNYA";
  const v = String(awb).trim().toUpperCase();

  for (let rule of appState.awbPrefixRules) {
    try {
      const regex = new RegExp(rule.prefix, "i");
      if (regex.test(v)) return rule.name;
    } catch(e) {
      if (v.startsWith(rule.prefix.toUpperCase())) return rule.name;
    }
  }
  return "LAINNYA";
}

function handleAWBScanEnter(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    lockAWB();
  }
}

function lockAWB() {
  if (!getPDAEcomWarehouse()) return alert("Pilih gudang pemotong stok PDA E-Commerce terlebih dahulu.");
  if (!document.getElementById("pdaEcomTujuanPilih")?.value) return alert("Pilih tujuan keluar PDA E-Commerce terlebih dahulu.");

  const awbInput = document.getElementById("pdaAWBMulti").value.trim();
  if (!awbInput) return;

  const alreadyCompleted = appState.pdaScans.some(s => String(s.awb).toLowerCase() === awbInput.toLowerCase());
  if (alreadyCompleted) {
    alert(`ERROR PDA: Resi / AWB "${awbInput}" SUDAH SELESAI DI-SCAN sebelumnya! Tidak dapat di-scan 2 kali.`);
    document.getElementById("pdaAWBMulti").value = "";
    return;
  }

  const manifestMatches = appState.manifest.filter(m => String(m.awb).trim().toLowerCase() === awbInput.toLowerCase());
  
  currentAWBRequiredItems = {};
  if (manifestMatches.length > 0) {
    manifestMatches.forEach(m => {
      const rawSku = m.sku.trim();

      const bundleConfig = appState.bundleMapping.find(b => {
        const bSku = b.bundle_sku || b.sku_combo || b.sku || '';
        return bSku.toLowerCase() === rawSku.toLowerCase();
      });

      if (bundleConfig && Array.isArray(bundleConfig.items)) {
        bundleConfig.items.forEach(comp => {
          const compSkuClean = comp.sku.toLowerCase();
          currentAWBRequiredItems[compSkuClean] = (currentAWBRequiredItems[compSkuClean] || 0) + (comp.qty * m.qty);
        });
      } else {
        const skuClean = rawSku.toLowerCase();
        currentAWBRequiredItems[skuClean] = (currentAWBRequiredItems[skuClean] || 0) + m.qty;
      }
    });
  }

  currentLockedAWB = awbInput;
  scannedItemsList = [];
  
  document.getElementById("pdaAWBMulti").disabled = true;
  document.getElementById("btnResetAWB").style.display = "inline-block";
  document.getElementById("pdaKodeMulti").disabled = false;
  document.getElementById("pdaKodeMulti").focus();
  document.getElementById("awbStatusText").innerHTML = `<b style="color:#4ade80;">Locked AWB: ${currentLockedAWB} (${detect3PL(currentLockedAWB)})</b>`;
  
  renderScanList();
}

function resetPDAScanState() {
  currentLockedAWB = "";
  scannedItemsList = [];
  currentAWBRequiredItems = {};

  document.getElementById("pdaAWBMulti").disabled = false;
  document.getElementById("pdaAWBMulti").value = "";
  document.getElementById("btnResetAWB").style.display = "none";
  document.getElementById("pdaKodeMulti").disabled = true;
  document.getElementById("pdaKodeMulti").value = "";
  document.getElementById("awbStatusText").innerHTML = "Status: Scan resi AWB untuk mulai";
  renderScanList();
}

function handleItemScanEnter(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    const rawInput = document.getElementById("pdaKodeMulti").value.trim();
    if (!rawInput) return;

    const master = findMasterBarang(rawInput);
    const finalSKU = master ? master.sku : rawInput;
    const finalSKULower = finalSKU.toLowerCase();

    const hasManifestRules = Object.keys(currentAWBRequiredItems).length > 0;

    if (hasManifestRules) {
      if (currentAWBRequiredItems[finalSKULower] === undefined) {
        alert(`ERROR SCAN PDA: SKU "${finalSKU}" (Barcode: ${rawInput}) TIDAK TERTERA pada Rekonsiliasi E-Commerce AWB "${currentLockedAWB}"!`);
        document.getElementById("pdaKodeMulti").value = "";
        return;
      }

      const targetQty = currentAWBRequiredItems[finalSKULower];
      const scannedQty = scannedItemsList.filter(s => s.toLowerCase() === finalSKULower).length;

      if (scannedQty >= targetQty) {
        alert(`ERROR SCAN PDA: Kuota SKU "${finalSKU}" sudah terpenuhi (${targetQty} ${uomOf(finalSKU)})! Tidak dapat di-scan lagi.`);
        document.getElementById("pdaKodeMulti").value = "";
        return;
      }
    }

    // Pengecekan Stok Minus saat scan item (hanya jika allowNegativeStock = false)
    if (!appState.allowNegativeStock) {
      const whScan = getPDAEcomWarehouse();
      const stokAda = calculateStockRealtime(finalSKU, whScan);
      const sudahDiScan = scannedItemsList.filter(s => s.toLowerCase() === finalSKULower).length;
      if (stokAda - sudahDiScan < 1) {
        alert(`ERROR STOK: SKU "${finalSKU}" tidak tersedia / stok kosong di ${whScan}! (Stok Ada: ${stokAda}, Sudah di-scan: ${sudahDiScan}). Fitur Stok Minus NON-AKTIF.`);
        document.getElementById("pdaKodeMulti").value = "";
        return;
      }
    }

    scannedItemsList.push(finalSKU);
    renderScanList();
    document.getElementById("pdaKodeMulti").value = "";

    if (hasManifestRules) {
      let isFullyCompleted = true;
      for (const sku in currentAWBRequiredItems) {
        const required = currentAWBRequiredItems[sku];
        const count = scannedItemsList.filter(s => s.toLowerCase() === sku).length;
        if (count < required) {
          isFullyCompleted = false;
          break;
        }
      }

      if (isFullyCompleted) {
        setTimeout(() => {
          alert(`✅ AWB ${currentLockedAWB} TERPENUHI 100%! Sistem melakukan simpan otomatis.`);
          submitMultiScanEcom();
        }, 150);
        return;
      }
    }

    document.getElementById("pdaKodeMulti").focus();
  }
}

function renderScanList() {
  const ul = document.getElementById("pdaScanList");
  ul.innerHTML = "";

  const hasManifestRules = Object.keys(currentAWBRequiredItems).length > 0;
  if (hasManifestRules && currentLockedAWB) {
    let manifestHeaderHtml = `<div style="background:#1e293b; border:1px solid #334155; padding:8px; border-radius:6px; margin-bottom:10px;">`;
    manifestHeaderHtml += `<b style="color:#38bdf8; font-size:12px;">📋 TARGET REKONSILIASI E-COMMERCE FOR AWB:</b><ul style="margin:4px 0 0 16px; padding:0; font-size:12px;">`;

    for (const skuKey in currentAWBRequiredItems) {
      const target = currentAWBRequiredItems[skuKey];
      const count = scannedItemsList.filter(s => s.toLowerCase() === skuKey).length;
      const mb = findMasterBarang(skuKey);
      const skuDisplay = mb ? mb.sku : skuKey.toUpperCase();
      const namaDisplay = mb ? mb.nama : '';

      const isDone = count >= target;
      const badgeStyle = isDone ? 'color:#4ade80; font-weight:bold;' : 'color:#fbbf24;';
      
      manifestHeaderHtml += `<li style="${badgeStyle}">${skuDisplay} (${namaDisplay}) &rarr; Scan: <b>${count}</b> / <b>${target} ${uomOf(skuKey)}</b> ${isDone ? '✅ MATCH' : ''}</li>`;
    }
    manifestHeaderHtml += `</ul></div>`;
    ul.innerHTML = manifestHeaderHtml;
  }

  if (scannedItemsList.length > 0) {
    ul.innerHTML += `<div style="font-size:12px; font-weight:bold; color:#cbd5e1; margin-top:6px;">Barang Ter-Scan Saat Ini:</div>`;
    scannedItemsList.forEach((sku, index) => {
      const master = findMasterBarang(sku);
      const nama = master ? master.nama : sku;
      ul.innerHTML += `<li style="font-size:12px;">Item ${index + 1}: <b>${sku}</b> (${nama})</li>`;
    });
  } else if (!hasManifestRules) {
    ul.innerHTML = `<li style="font-size:12px; color:#94a3b8;">Belum ada item ter-scan.</li>`;
  }
}

function getPDAEcomWarehouse() {
  const selector = document.getElementById("pdaEcomGudangPilih");
  return selector ? selector.value : (appState.pdaEcomWarehouse || '');
}

function submitMultiScanEcom() {
  if (!requireFeatureAccess('pda_ecommerce', 'PDA E-Commerce')) return;
  if (!currentLockedAWB) return alert("AWB belum terkunci!");
  if (scannedItemsList.length === 0) return alert("Belum ada barang yang di-scan!");

  const today = new Date().toISOString().split("T")[0];
  const targetWh = getPDAEcomWarehouse();
  const targetTujuan = document.getElementById("pdaEcomTujuanPilih")?.value || '';
  if (!targetWh) return alert("Pilih gudang pemotong stok PDA E-Commerce terlebih dahulu.");
  if (!targetTujuan) return alert("Pilih tujuan keluar PDA E-Commerce terlebih dahulu.");

  // Pengecekan Stok Minus sebelum simpan (hanya jika allowNegativeStock = false)
  if (!appState.allowNegativeStock) {
    const needBySku = {};
    scannedItemsList.forEach(sk => {
      const mb = findMasterBarang(sk);
      const key = mb ? mb.sku : sk;
      needBySku[key] = (needBySku[key] || 0) + 1;
    });
    for (const sku in needBySku) {
      const stokAda = calculateStockRealtime(sku, targetWh);
      if (stokAda < needBySku[sku]) {
        return alert(`ERROR STOK: SKU "${sku}" tidak mencukupi di ${targetWh}! (Stok Ada: ${stokAda}, Dibutuhkan: ${needBySku[sku]}). Fitur Stok Minus NON-AKTIF, AWB tidak disimpan.`);
      }
    }
  }

  scannedItemsList.forEach(skuScanned => {
    const barang = findMasterBarang(skuScanned);
    const skuFinal = barang ? barang.sku : skuScanned;
    const namaBarang = barang ? barang.nama : 'Barang Scan Outbound';
    const kodeProd = barang && barang.kategori_produk === 'Finish Good' ? generateKodeProduksi(namaBarang, today) : '-';

    appState.pdaScans.push({ awb: currentLockedAWB, kode_fg: skuFinal, qty: 1, mode: 'Ecommerce', date: today });

    appState.transactions.push({
      id: Date.now() + Math.random(),
      no_sj: `SJ-OUT-${currentLockedAWB}`,
      tipe: 'KELUAR',
      gudang: targetWh,
      sub_lokasi: document.getElementById('pdaEcomSubLokasi')?.value || '',
      kode: skuFinal,
      nama_barang: namaBarang,
      kode_produksi: kodeProd,
      kategori_produk: barang ? barang.kategori_produk : 'Finish Good',
      tujuan_keluar: `${targetTujuan} - ${detect3PL(currentLockedAWB)}`,
      qty: 1,
      tanggal: today,
      pengirim_kurir: detect3PL(currentLockedAWB),
      input_by: (currentUser ? currentUser.name : 'System') + ' (PDA)'
    });
  });

  saveData();
  resetPDAScanState();
  renderDashboard(1);
  renderRekonsiliasi(1);
  renderLaporanStok(1);
}

function handleReturAWBScanEnter(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    const awb = document.getElementById("pdaReturAWB").value.trim();
    if (!awb) return;

    currentLockedReturAWB = awb;
    scannedReturItemsList = [];
    const status3PL = detect3PL(awb);

    document.getElementById("pdaReturAWB").disabled = true;
    document.getElementById("btnResetReturAWB").style.display = "inline-block";
    document.getElementById("pdaReturKodeItem").disabled = false;
    document.getElementById("pdaReturKodeItem").focus();
    document.getElementById("pdaReturStatusText").innerHTML = `<b style="color:#34d399;">Retur Resi: ${awb} (${status3PL})</b>`;
  }
}

function resetPDAReturState() {
  currentLockedReturAWB = "";
  scannedReturItemsList = [];
  document.getElementById("pdaReturAWB").disabled = false;
  document.getElementById("pdaReturAWB").value = "";
  document.getElementById("btnResetReturAWB").style.display = "none";
  document.getElementById("pdaReturKodeItem").disabled = true;
  document.getElementById("pdaReturKodeItem").value = "";
  document.getElementById("pdaReturStatusText").innerHTML = "Status: Scan resi retur untuk auto-detect 3PL";
  document.getElementById("pdaReturScanList").innerHTML = "";
}

function handleReturItemScanEnter(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    const rawInput = document.getElementById("pdaReturKodeItem").value.trim();
    if (!rawInput) return;

    const master = findMasterBarang(rawInput);
    const skuFinal = master ? master.sku : rawInput;

    scannedReturItemsList.push(skuFinal);
    const ul = document.getElementById("pdaReturScanList");
    ul.innerHTML += `<li>Retur Item ${scannedReturItemsList.length}: <b>${skuFinal}</b></li>`;
    document.getElementById("pdaReturKodeItem").value = "";
  }
}

function submitPDAScanRetur() {
  if (!requireFeatureAccess('pda_retur', 'PDA Retur')) return;
  if (!currentLockedReturAWB) return alert("Scan AWB Retur terlebih dahulu!");
  if (scannedReturItemsList.length === 0) return alert("Belum ada barang retur di-scan!");

  const gudang = document.getElementById("pdaReturGudang").value;
  if (!gudang) return alert("Pilih Gudang Masuk Retur!");

  const today = new Date().toISOString().split("T")[0];
  const status3PL = detect3PL(currentLockedReturAWB);

  scannedReturItemsList.forEach(sku => {
    const barang = findMasterBarang(sku);
    const namaBarang = barang ? barang.nama : sku;

    appState.returRecords.push({
      id: Date.now() + Math.random(),
      tanggal: today,
      awb: currentLockedReturAWB,
      status_resi: 'RESI TERDETEKSI',
      tpl: status3PL,
      sku: sku,
      nama_barang: namaBarang,
      qty: 1,
      gudang: gudang
    });

    appState.transactions.push({
      id: Date.now() + Math.random(),
      no_sj: `RETUR-${currentLockedReturAWB}`,
      tipe: 'MASUK',
      gudang: gudang,
      sub_lokasi: document.getElementById('pdaReturSubLokasi')?.value || '',
      kode: sku,
      nama_barang: namaBarang,
      kode_produksi: generateKodeProduksi(namaBarang, today),
      kategori_produk: barang ? barang.kategori_produk : 'Finish Good',
      kategori_masuk: `Retur Customer (${status3PL})`,
      qty: 1,
      tanggal: today,
      input_by: (currentUser ? currentUser.name : 'System') + ' (PDA Retur)'
    });
  });

  saveData();
  alert(`Barang Retur Berhasil Dimasukkan Ke Gudang ${gudang}!`);
  resetPDAReturState();
  renderDashboard(1);
  renderTabelRetur(1);
  renderLaporanStok(1);
}

// MODAL ATURAN AWB
function openModalTambahAWB() {
  document.getElementById("modalTambahAWB").style.display = "flex";
}

function closeModalTambahAWB() {
  document.getElementById("modalTambahAWB").style.display = "none";
  document.getElementById("prefixCodeInput").value = "";
  document.getElementById("prefixNameInput").value = "";
}

function tambahPrefixAWB(e) {
  e.preventDefault();
  const prefix = document.getElementById("prefixCodeInput").value.trim();
  const name = document.getElementById("prefixNameInput").value.trim().toUpperCase();

  if (!prefix || !name) return alert("Lengkapi Prefix & Nama 3PL!");

  appState.awbPrefixRules.push({ prefix, name });
  saveData();
  renderTabelPrefixAWB();
  
  closeModalTambahAWB();
  alert("Aturan Prefix AWB Berhasil Ditambahkan!");
}

function renderTabelPrefixAWB() {
  const tbody = document.getElementById("tabelPrefixAWB");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!appState.awbPrefixRules || appState.awbPrefixRules.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#94a3b8;">Belum ada aturan prefix AWB.</td></tr>`;
    return;
  }

  appState.awbPrefixRules.forEach((rule, idx) => {
    tbody.innerHTML += `
      <tr>
        <td><code>${rule.prefix}</code></td>
        <td><b>${rule.name}</b></td>
        <td class="text-center">
          <div class="action-btn-group" style="justify-content: center;">
            <button class="btn-warning" style="padding:3px 8px; font-size:11px;" onclick="openModalEditAWB(${idx})">Edit</button>
            <button class="btn-danger" style="padding:3px 8px; font-size:11px;" onclick="hapusPrefixAWB(${idx})">Hapus</button>
          </div>
        </td>
      </tr>
    `;
  });
}

function openModalEditAWB(index) {
  const rule = appState.awbPrefixRules[index];
  if (!rule) return;

  document.getElementById("editPrefixIndex").value = index;
  document.getElementById("editPrefixCodeInput").value = rule.prefix;
  document.getElementById("editPrefixNameInput").value = rule.name;
  
  document.getElementById("modalEditAWB").style.display = "flex";
}

function closeModalEditAWB() {
  document.getElementById("modalEditAWB").style.display = "none";
}

function simpanEditPrefixAWB(e) {
  e.preventDefault();
  const index = parseInt(document.getElementById("editPrefixIndex").value);
  const prefixBaru = document.getElementById("editPrefixCodeInput").value.trim();
  const nameBaru = document.getElementById("editPrefixNameInput").value.trim().toUpperCase();

  if (!prefixBaru || !nameBaru) return alert("Lengkapi Prefix & Nama 3PL!");

  if (index >= 0 && index < appState.awbPrefixRules.length) {
    appState.awbPrefixRules[index] = { prefix: prefixBaru, name: nameBaru };
    saveData();
    renderTabelPrefixAWB();
    closeModalEditAWB();
    alert("Aturan Prefix AWB Berhasil Diperbarui!");
  }
}

function hapusPrefixAWB(idx) {
  bukaModalGeneralDelete("Apakah Anda yakin ingin menghapus aturan prefix AWB ini?", () => {
    appState.awbPrefixRules.splice(idx, 1);
    saveData();
    renderTabelPrefixAWB();
  });
}

function exportRekonReturExcel() {
  if (!requireFeatureAccess('export', 'Export')) return;
  if (!appState.returRecords || appState.returRecords.length === 0) {
    return alert("Belum ada data rekonsiliasi retur!");
  }
  const rows = appState.returRecords.map((r, idx) => {
    const statusKelengkapan = hitungKelengkapanRetur(r.awb, r.sku, r.qty);
    return {
      "No": idx + 1,
      "Tanggal Retur": r.tanggal,
      "No. Resi (AWB)": r.awb,
      "Status Resi": r.status_resi,
      "3PL": r.tpl,
      "Kode SKU": r.sku,
      "UoM": uomOf(r.sku),
      "Nama Barang": r.nama_barang,
      "Qty Retur": r.qty,
      "Gudang Masuk": r.gudang,
      "Status Kelengkapan Retur": statusKelengkapan
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Rekonsiliasi Retur");
  XLSX.writeFile(wb, `Rekonsiliasi_Retur_${new Date().toISOString().split('T')[0]}.xlsx`);
}

function hitungKelengkapanRetur(awb, skuRetur, qtyRetur) {
  const manifestMatch = appState.manifest.find(m => 
    String(m.awb).trim().toLowerCase() === String(awb).trim().toLowerCase() && 
    String(m.sku).trim().toLowerCase() === String(skuRetur).trim().toLowerCase()
  );

  if (manifestMatch) {
    if (Number(qtyRetur) < Number(manifestMatch.qty)) {
      return "RETUR TIDAK LENGKAP";
    }
    return "RETUR LENGKAP";
  }

  const transMatch = appState.transactions.find(t => 
    t.no_sj && String(t.no_sj).toLowerCase().includes(String(awb).toLowerCase()) &&
    String(t.kode).toLowerCase() === String(skuRetur).toLowerCase()
  );

  if (transMatch) {
    if (Number(qtyRetur) < Number(transMatch.qty)) {
      return "RETUR TIDAK LENGKAP";
    }
    return "RETUR LENGKAP";
  }

  return "RETUR TIDAK LENGKAP";
}

function renderTabelRetur(page = 1) {
  pageRetur = page;
  const tbody = document.getElementById("tabelReturList");
  if (!tbody) return;
  tbody.innerHTML = "";

  const pageSize = parseInt(document.getElementById("pageSizeRetur")?.value) || 10;
  const sortedRetur = sortDisplayItems(appState.returRecords, r => `${r.tanggal || ''}_${r.awb || ''}_${r.sku || ''}`);
  const totalItems = sortedRetur.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  if (pageRetur > totalPages) pageRetur = totalPages;
  if (pageRetur < 1) pageRetur = 1;

  const startIndex = (pageRetur - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

  if (totalItems === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; color:#94a3b8; padding:20px;">Belum ada riwayat retur barang.</td></tr>`;
  } else {
    const paginated = sortedRetur.slice(startIndex, endIndex);
    paginated.forEach((r, idx) => {
      const realIndex = startIndex + idx + 1;
      const statusKelengkapan = hitungKelengkapanRetur(r.awb, r.sku, r.qty);
      const kelengkapanBadge = statusKelengkapan === 'RETUR LENGKAP' ? 'badge-success' : 'badge-danger';

      tbody.innerHTML += `
        <tr>
          <td class="text-center">${realIndex}</td>
          <td>${r.tanggal}</td>
          <td><code><b>${r.awb}</b></code></td>
          <td class="text-center"><span class="badge ${r.status_resi === 'RESI TERDETEKSI' ? 'badge-success' : 'badge-danger'}">${r.status_resi}</span></td>
          <td class="text-center"><span class="badge badge-info">${r.tpl}</span></td>
          <td><code>${r.sku}</code></td>
          <td><b>${r.nama_barang}</b></td>
          <td class="text-center"><b>${r.qty}</b> <span class="uom-tag">${uomOf(r.sku)}</span></td>
          <td><b>${r.gudang}</b></td>
          <td class="text-center"><span class="badge ${kelengkapanBadge}">${statusKelengkapan}</span></td>
          <td class="text-center"><button class="btn-danger" onclick="hapusRecordRetur(${r.id})">Hapus</button></td>
        </tr>
      `;
    });
  }

  const infoEl = document.getElementById("infoReturPage");
  const indicatorEl = document.getElementById("indicatorReturPage");
  const btnPrev = document.getElementById("btnPrevRetur");
  const btnNext = document.getElementById("btnNextRetur");

  updatePaginationControls(pageRetur, totalPages, btnPrev, btnNext, indicatorEl, infoEl, startIndex, endIndex, totalItems);
}

function changeReturPage(delta) {
  renderTabelRetur(pageRetur + delta);
}

function hapusRecordRetur(id) {
  bukaModalGeneralDelete("Apakah Anda yakin ingin menghapus catatan retur ini?", () => {
    appState.returRecords = appState.returRecords.filter(r => r.id != id);
    saveData();
    renderTabelRetur(pageRetur);
  });
}

function handleCekEanEnter(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    prosesCekEan();
  }
}

// ==========================================
// CEK STOK & LOKASI: scan lokasi (search + pagination) & popup Transfer / Keluar / Terima
// ==========================================
let cekState = { mode: '', gudang: '', sku: '', items: [] };
let cekScanPendingProduct = null;
let cekScanSession = null;
let pageCekLokasi = 1;
let cekFotoBase64 = "";
let cekTrfSku = "";

function cekEsc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cekStokBadge(n, sku) {
  const cls = n < 0 ? 'badge-danger' : (n === 0 ? 'badge-secondary' : 'badge-success');
  return `<span class="badge ${cls}">${n} ${uomOf(sku)}</span>`;
}

let selectedMoveProductSkus = new Set();

function getWarehouseStockRows(warehouse, category = '') {
  if (!warehouse) return [];
  return sortDisplayItems(appState.masterBarang, product => product.sku)
    .map(product => ({ ...product, stok: calculateStockRealtime(product.sku, warehouse) }))
    .filter(product => product.stok > 0 && (!category || product.kategori_produk === category));
}

function fillWarehousePicker(selectId, placeholder, warehouses = appState.warehouses, selectedValue = '') {
  const select = document.getElementById(selectId);
  if (!select) return;
  const options = `<option value="">${placeholder}</option>` + sortDisplayItems(warehouses, warehouse => warehouse.nama)
    .map(warehouse => `<option value="${cekEsc(warehouse.nama)}">${cekEsc(warehouse.nama)}</option>`)
    .join('');
  select.innerHTML = options;
  select.value = selectedValue || '';
}

function fillCategoryPicker(selectId, includeAll = true) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const placeholder = includeAll ? `<option value="">-- SEMUA KATEGORI --</option>` : `<option value="">-- Pilih Kategori --</option>`;
  select.innerHTML = placeholder + sortDisplayItems(appState.kategoriProduk, category => category)
    .map(category => `<option value="${cekEsc(category)}">${cekEsc(category)}</option>`)
    .join('');
}

function openModalPindahMasterProduk() {
  if (!currentUser || currentUser.role !== 'superadmin') return alert("Akses ditolak. Fitur pindah master produk hanya untuk Superadmin.");
  if (appState.warehouses.length < 2) return alert("Minimal harus ada dua lokasi gudang untuk memindahkan produk.");
  selectedMoveProductSkus = new Set();
  fillWarehousePicker("pindahLokasiAsal", "-- Pilih Lokasi Asal --");
  fillWarehousePicker("pindahLokasiTujuan", "-- Pilih Lokasi Tujuan --");
  fillCategoryPicker("pindahKategoriProduk");
  document.getElementById("pindahPilihSemua").checked = false;
  document.getElementById("pindahLokasiAsalInfo").textContent = "Pilih lokasi asal, kategori, dan produk yang akan dipindahkan.";
  renderPindahProdukList();
  document.getElementById("modalPindahMasterProduk").style.display = "flex";
}

function closeModalPindahMasterProduk() {
  document.getElementById("modalPindahMasterProduk").style.display = "none";
}

function changePindahLokasiAsal() {
  selectedMoveProductSkus = new Set();
  document.getElementById("pindahPilihSemua").checked = false;
  renderPindahProdukList();
}

function renderPindahProdukList() {
  const warehouse = document.getElementById("pindahLokasiAsal")?.value || '';
  const category = document.getElementById("pindahKategoriProduk")?.value || '';
  const list = document.getElementById("pindahProdukList");
  const preview = document.getElementById("pindahPreviewStok");
  const rows = getWarehouseStockRows(warehouse, category);
  const title = document.getElementById("pindahLokasiAsalInfo");
  if (title) title.innerHTML = warehouse ? `Lokasi Asal: <b>${cekEsc(warehouse)}</b>` : "Pilih lokasi asal untuk melihat produk.";

  if (!list || !preview) return;
  if (!warehouse) {
    list.innerHTML = `<div class="move-empty">Pilih lokasi asal untuk menampilkan produk yang tersedia.</div>`;
    preview.textContent = "Tidak ada stok untuk ditampilkan.";
    return;
  }
  if (rows.length === 0) {
    list.innerHTML = `<div class="move-empty">Tidak ada stok produk pada kategori dan lokasi ini.</div>`;
    preview.textContent = "Tidak ada stok produk sesuai filter.";
    document.getElementById("pindahPilihSemua").checked = false;
    return;
  }

  list.innerHTML = rows.map(product => `
    <label class="move-product-row">
      <input type="checkbox" data-move-sku="${cekEsc(product.sku)}" ${selectedMoveProductSkus.has(product.sku) ? 'checked' : ''} onchange="toggleProdukPindah(this)">
      <span class="move-product-name"><b>${cekEsc(product.sku)}</b><small>${cekEsc(product.nama)}</small></span>
      <span class="move-product-category">${cekEsc(product.kategori_produk)}</span>
      <span class="move-product-stock">${product.stok} ${cekEsc(uomOf(product.sku))}</span>
    </label>`).join('');

  const visibleSelected = rows.filter(product => selectedMoveProductSkus.has(product.sku)).length;
  document.getElementById("pindahPilihSemua").checked = visibleSelected === rows.length;
  preview.textContent = `${rows.length} produk tersedia; total stok ${sumByUom(rows, 'sku', 'stok')}. ${visibleSelected} produk dipilih.`;
}

function toggleProdukPindah(checkbox) {
  if (checkbox.checked) selectedMoveProductSkus.add(checkbox.dataset.moveSku);
  else selectedMoveProductSkus.delete(checkbox.dataset.moveSku);
  renderPindahProdukList();
}

function togglePilihSemuaPindah(checked) {
  const warehouse = document.getElementById("pindahLokasiAsal")?.value || '';
  const category = document.getElementById("pindahKategoriProduk")?.value || '';
  getWarehouseStockRows(warehouse, category).forEach(product => {
    if (checked) selectedMoveProductSkus.add(product.sku);
    else selectedMoveProductSkus.delete(product.sku);
  });
  renderPindahProdukList();
}

function pindahkanMasterProdukSekarang() {
  if (!currentUser || currentUser.role !== 'superadmin') return alert("Akses ditolak. Fitur pindah master produk hanya untuk Superadmin.");
  const source = document.getElementById("pindahLokasiAsal").value;
  const target = document.getElementById("pindahLokasiTujuan").value;
  if (!source) return alert("Pilih lokasi asal terlebih dahulu.");
  if (!target) return alert("Pilih lokasi tujuan terlebih dahulu.");
  if (source === target) return alert("Lokasi asal dan tujuan tidak boleh sama.");
  if (selectedMoveProductSkus.size === 0) return alert("Pilih minimal satu produk untuk dipindahkan.");

  const products = Array.from(selectedMoveProductSkus).map(sku => ({
    product: findMasterBarang(sku),
    qty: calculateStockRealtime(sku, source)
  }));
  if (products.some(item => !item.product || item.qty <= 0)) {
    return alert("Stok salah satu produk berubah atau sudah tidak tersedia. Perbarui pilihan produk terlebih dahulu.");
  }

  const today = new Date().toISOString().split("T")[0];
  const reference = `MOVE-${Date.now()}`;
  products.forEach(({ product, qty }) => {
    let remainingQty = qty;
    const batches = getStockBatchesFIFO(product.sku, source);
    const allocations = [];
    batches.forEach(batch => {
      if (remainingQty <= 0) return;
      const batchQty = Math.min(batch.qty, remainingQty);
      if (batchQty > 0) {
        allocations.push({ qty: batchQty, kode_produksi: batch.batch.startsWith('TGL-') ? '-' : batch.batch });
        remainingQty -= batchQty;
      }
    });
    if (remainingQty > 0) allocations.push({ qty: remainingQty, kode_produksi: '-' });

    allocations.forEach(allocation => {
      const base = {
        no_sj: reference,
        kode: product.sku,
        nama_barang: product.nama,
        kode_produksi: allocation.kode_produksi,
        kategori_produk: product.kategori_produk,
        qty: allocation.qty,
        tanggal: today,
        foto_bukti: '',
        pengirim_kurir: 'Transfer Antar Lokasi',
        input_by: currentUser.name
      };
      appState.transactions.push({
        ...base, id: Date.now() + Math.random(), tipe: 'KELUAR', gudang: source,
        kategori_masuk: '', tujuan_keluar: `Transfer Ke ${target}`
      });
      appState.transactions.push({
        ...base, id: Date.now() + Math.random(), tipe: 'MASUK', gudang: target,
        kategori_masuk: `Transfer Dari ${source}`, tujuan_keluar: ''
      });
    });
  });

  saveData();
  closeModalPindahMasterProduk();
  renderDashboard(1);
  renderLaporanStok(1);
  prosesCekEan(true);
  alert(`Transaksi berhasil. ${products.length} produk dipindahkan dari ${source} ke ${target}.`);
}

function openModalCekKategoriGudang() {
  pageCekKategori = 1;
  fillWarehousePicker("cekKategoriLokasi", "-- Pilih Lokasi Gudang --", getAccessibleWarehouses());
  fillCategoryPicker("cekKategoriFilter");
  renderCekKategoriGudang(1);
  document.getElementById("modalCekKategoriGudang").style.display = "flex";
}

function closeModalCekKategoriGudang() {
  document.getElementById("modalCekKategoriGudang").style.display = "none";
}

let pageCekKategori = 1;

function renderCekKategoriGudang(page = 1) {
  pageCekKategori = page;
  const warehouse = document.getElementById("cekKategoriLokasi")?.value || '';
  const category = document.getElementById("cekKategoriFilter")?.value || '';
  const tbody = document.getElementById("cekKategoriProdukList");
  if (!tbody) return;
  const pageSize = parseInt(document.getElementById("pageSizeCekKategori")?.value) || 10;
  const rows = warehouse ? getWarehouseStockRows(warehouse, category) : [];
  const totalItems = rows.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  pageCekKategori = Math.min(Math.max(pageCekKategori, 1), totalPages);
  const startIndex = (pageCekKategori - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

  if (!warehouse) {
    tbody.innerHTML = `<tr><td colspan="5" class="cek-empty">Pilih lokasi gudang untuk melihat produk.</td></tr>`;
  } else if (totalItems === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="cek-empty">Tidak ada stok produk pada lokasi dan kategori ini.</td></tr>`;
  } else {
    tbody.innerHTML = rows.slice(startIndex, endIndex).map((product, index) => `<tr>
      <td>${startIndex + index + 1}</td><td><code>${cekEsc(product.sku)}</code></td>
      <td>${cekEsc(product.nama)}</td><td>${cekEsc(product.kategori_produk)}</td>
      <td class="text-center">${product.stok} ${cekEsc(uomOf(product.sku))}</td>
    </tr>`).join('');
  }

  updatePaginationControls(
    pageCekKategori, totalPages,
    document.getElementById("btnPrevCekKategori"), document.getElementById("btnNextCekKategori"),
    document.getElementById("indicatorCekKategoriPage"), document.getElementById("infoCekKategoriPage"),
    startIndex, endIndex, totalItems
  );
}

function changeCekKategoriPage(delta) {
  renderCekKategoriGudang(pageCekKategori + delta);
}

function getAccessibleWarehouses() {
  const allowedWH = currentUser ? (currentUser.allowed_warehouses || ['ALL']) : ['ALL'];
  if (!currentUser || currentUser.role === 'superadmin' || allowedWH.includes('ALL')) {
    return appState.warehouses.slice();
  }
  return appState.warehouses.filter(w => allowedWH.includes(w.nama));
}

function prosesCekEan(silent = false) {
  const input = document.getElementById("inputCekEan").value.trim().toLowerCase();
  const container = document.getElementById("hasilCekEanContainer");
  const detailContent = document.getElementById("cekEanDetailContent");
  const btnMain = document.getElementById("btnCekTransferMain");
  const accessibleWarehouses = getAccessibleWarehouses();

  if (!silent) renderCekPendingBanner();
  if (!input) {
    if (!silent) alert("Masukkan Barcode EAN-13, SKU, atau Barcode / Nama Lokasi Gudang!");
    return;
  }

  if (!silent) notifyPendingTransfers(false);

  const subLocationMatch = accessibleWarehouses.flatMap(warehouse =>
    (warehouse.sublokasi || []).map(name => ({
      warehouse,
      name,
      ean: warehouse.subLokasiEan?.[name] || ''
    }))
  ).find(item => item.name.toLowerCase() === input || item.ean.toLowerCase() === input);
  const gudangObj = accessibleWarehouses.find(w =>
    w.nama.toLowerCase() === input || (w.ean && w.ean.toLowerCase() === input)
  ) || subLocationMatch?.warehouse;
  const inaccessibleWarehouse = appState.warehouses.some(w =>
    (w.nama.toLowerCase() === input || (w.ean && w.ean.toLowerCase() === input)) &&
    !accessibleWarehouses.some(allowed => allowed.nama === w.nama)
  ) || appState.warehouses.some(warehouse =>
    (warehouse.sublokasi || []).some(name =>
      (name.toLowerCase() === input || String(warehouse.subLokasiEan?.[name] || '').toLowerCase() === input) &&
      !accessibleWarehouses.some(allowed => allowed.nama === warehouse.nama)
    )
  );

  if (!gudangObj && inaccessibleWarehouse) {
    if (!silent) alert("Anda tidak memiliki akses ke lokasi gudang ini.");
    container.style.display = "none";
    return;
  }

  if (gudangObj) {
    const targetWH = gudangObj.nama;
    const targetSubLocation = subLocationMatch?.warehouse.nama === targetWH ? subLocationMatch.name : '';
    const whStockMap = {};

    appState.transactions.forEach(t => {
      if (t.gudang.toLowerCase() === targetWH.toLowerCase() &&
          (!targetSubLocation || (t.sub_lokasi || '') === targetSubLocation)) {
        if (!whStockMap[t.kode]) {
          const mb = findMasterBarang(t.kode);
          whStockMap[t.kode] = { sku: t.kode, nama: t.nama_barang || (mb ? mb.nama : t.kode), barcode: mb && mb.barcode ? mb.barcode : '', kategori: (mb && mb.kategori_produk) || t.kategori_produk || '-', stok: 0, sub_stok: {} };
        }
        const row = whStockMap[t.kode];
        const subLocation = t.sub_lokasi || 'Tanpa Sub Lokasi';
        if (t.tipe === 'MASUK') {
          row.stok += Number(t.qty);
          row.sub_stok[subLocation] = (row.sub_stok[subLocation] || 0) + Number(t.qty);
        }
        if (t.tipe === 'KELUAR') {
          row.stok -= Number(t.qty);
          row.sub_stok[subLocation] = (row.sub_stok[subLocation] || 0) - Number(t.qty);
        }
      }
    });

    const items = Object.values(whStockMap).sort((a, b) => a.sku.localeCompare(b.sku, 'id', { numeric: true, sensitivity: 'base' }));
    const keepSearch = silent && document.getElementById("searchCekLokasi") ? document.getElementById("searchCekLokasi").value : "";
    const keepKategori = silent && cekState.mode === 'LOKASI' && cekState.gudang === targetWH && document.getElementById("filterCekLokasiKategori") ? document.getElementById("filterCekLokasiKategori").value : "";
    const keepPage = silent && cekState.mode === 'LOKASI' && cekState.gudang === targetWH ? pageCekLokasi : 1;
    cekState = { mode: 'LOKASI', gudang: targetWH, sku: '', items };

    detailContent.innerHTML = `
      <div class="cek-summary">
        <div class="cek-chip"><span>${targetSubLocation ? 'Sub Lokasi' : 'Lokasi Gudang'}</span><b>${cekEsc(targetSubLocation || targetWH)}</b></div>
        <div class="cek-chip"><span>Barcode ${targetSubLocation ? 'Sub Lokasi' : 'Gudang'} (EAN-13)</span><code>${cekEsc(targetSubLocation ? (gudangObj.subLokasiEan?.[targetSubLocation] || '-') : (gudangObj.ean || '-'))}</code></div>
        <div class="cek-chip"><span>Total SKU Terdaftar</span><b>${items.length}</b></div>
        <div class="cek-chip cek-chip-total"><span>Total Stok Fisik</span><b>${sumByUom(items, 'sku', 'stok')}</b></div>
      </div>
      <div class="cek-toolbar">
        <input type="text" id="searchCekLokasi" placeholder="Cari SKU / Nama Barang / EAN-13..." oninput="renderCekLokasiTable(1)" autocomplete="off">
        <div class="cek-toolbar-right">
          <label for="filterCekLokasiKategori">Kategori:</label>
          <select id="filterCekLokasiKategori" onchange="renderCekLokasiTable(1)"></select>
          <label for="pageSizeCekLokasi">Per halaman:</label>
          <select id="pageSizeCekLokasi" onchange="renderCekLokasiTable(1)">
            <option value="10" selected>10</option>
            <option value="25">25</option>
            <option value="50">50</option>
          </select>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th class="text-center">No</th><th>Kode SKU</th><th>Nama Barang</th><th class="text-center">Sisa Stok Fisik</th><th>Rincian Sub Lokasi</th><th class="text-center">Aksi</th></tr></thead>
          <tbody id="tabelCekLokasi"></tbody>
        </table>
      </div>
      <div class="pagination-bar">
        <div class="pagination-info-group"><span id="infoCekLokasiPage">Menampilkan 0 - 0 dari 0 data</span></div>
        <div class="pagination-controls">
          <button id="btnPrevCekLokasi" class="btn-secondary" onclick="changeCekLokasiPage(-1)">&laquo; Sebelumnya</button>
          <span id="indicatorCekLokasiPage">Halaman 1 / 1</span>
          <button id="btnNextCekLokasi" class="btn-secondary" onclick="changeCekLokasiPage(1)">Selanjutnya &raquo;</button>
        </div>
      </div>`;

    document.getElementById("searchCekLokasi").value = keepSearch;
    fillCategoryPicker("filterCekLokasiKategori", true);
    document.getElementById("filterCekLokasiKategori").value = keepKategori;
    document.getElementById("cekEanJudul").textContent = targetSubLocation
      ? `Hasil Pengecekan Sub Lokasi: ${targetSubLocation} (${targetWH})`
      : `Hasil Pengecekan Lokasi Gudang: ${targetWH}`;
    btnMain.style.display = "none";
    container.style.display = "block";
    renderCekLokasiTable(keepPage);
    return;
  }

  const master = findMasterBarang(input);
  if (master) {
    if (cekScanSession) {
      tambahBarangKeSesiScan(master);
      return;
    }
    if (master.set_component_sku) {
      bukaPilihanAksiScan(master);
      return;
    }
    const locationsMap = {};
    accessibleWarehouses.forEach(w => locationsMap[w.nama] = 0);

    appState.transactions.forEach(t => {
      if (t.kode.toLowerCase() === master.sku.toLowerCase() && locationsMap[t.gudang] !== undefined) {
        if (t.tipe === 'MASUK') locationsMap[t.gudang] += Number(t.qty);
        if (t.tipe === 'KELUAR') locationsMap[t.gudang] -= Number(t.qty);
      }
    });

    const totalStokAll = Object.values(locationsMap).reduce((a, b) => a + b, 0);
    cekState = { mode: 'SKU', gudang: '', sku: master.sku, items: [] };

    let rows = '';
    Object.keys(locationsMap).sort((a, b) => a.localeCompare(b, 'id', { numeric: true, sensitivity: 'base' })).forEach((wh, idx) => {
      rows += `<tr>
        <td class="text-center">${idx + 1}</td>
        <td><b>${cekEsc(wh)}</b></td>
        <td class="text-center">${cekStokBadge(locationsMap[wh], master.sku)}</td>
        <td class="text-center"><button class="btn-warning" data-feature="transfer_send,transfer_receive" data-sku="${cekEsc(master.sku)}" data-wh="${cekEsc(wh)}" onclick="bukaModalCekTransfer(this.dataset.sku, this.dataset.wh)">Transfer / Keluar / Terima</button></td>
      </tr>`;
    });

    detailContent.innerHTML = `
      <div class="cek-summary">
        <div class="cek-chip cek-chip-wide"><span>Nama Barang</span><b>${cekEsc(master.nama)}</b></div>
        <div class="cek-chip"><span>Kode SKU</span><code>${cekEsc(master.sku)}</code></div>
        <div class="cek-chip"><span>EAN-13 Barcode</span><code>${cekEsc(master.barcode || '-')}</code></div>
        <div class="cek-chip"><span>Kategori Produk</span><b>${cekEsc(master.kategori_produk)}</b></div>
        <div class="cek-chip"><span>Unit of Material (UoM)</span><b>${cekEsc(uomOf(master.sku))}</b></div>
        <div class="cek-chip cek-chip-total"><span>Total Sisa Stok Gudang Terakses</span><b>${totalStokAll} ${cekEsc(uomOf(master.sku))}</b></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th class="text-center">No</th><th>Lokasi Gudang</th><th class="text-center">Sisa Stok di Gudang Ini</th><th class="text-center">Aksi</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    document.getElementById("cekEanJudul").textContent = `Hasil Pengecekan Barang SKU: ${master.sku}`;
    btnMain.style.display = "inline-block";
    container.style.display = "block";
    applyFeatureAccessUI();
  } else {
    if (!silent) alert("Barcode EAN-13, SKU, atau Lokasi Gudang tidak terdaftar!");
    container.style.display = "none";
  }
}

function bukaPilihanAksiScan(product) {
  if (!currentUser || currentUser.crud?.create === false) {
    return alert('Akses ditolak: Anda tidak memiliki izin Create untuk transaksi scan.');
  }
  cekScanPendingProduct = product;
  document.getElementById('cekScanFirstSkuInfo').textContent =
    `Produk hasil scan: ${product.sku} - ${product.nama}. Pilih jenis transaksi untuk sesi scan berikutnya.`;
  const warehouses = getAccessibleWarehouses();
  const options = warehouses.map(warehouse =>
    `<option value="${cekEsc(warehouse.nama)}">${cekEsc(warehouse.nama)}</option>`
  ).join('');
  document.getElementById('cekScanWarehouse').innerHTML = options;
  document.getElementById('cekScanDestination').innerHTML = options;
  document.getElementById('cekScanActionType').value =
    hasFeatureAccess('transfer_receive') ? 'MASUK' : (hasFeatureAccess('transfer_send') ? 'KELUAR' : 'MASUK');
  toggleCekScanActionFields();
  renderSubLocationPicker('cekScanSubLokasi', warehouses[0]?.nama || '');
  document.getElementById('modalCekScanAction').style.display = 'flex';
}

function toggleCekScanActionFields() {
  const type = document.getElementById('cekScanActionType').value;
  const destination = document.getElementById('cekScanDestination').value;
  renderSubLocationPicker('cekScanDestinationSubLokasi', destination);
  document.getElementById('cekScanDestinationWrap').style.display = type === 'TRANSFER' ? '' : 'none';
  document.getElementById('cekScanDestinationSubLocationWrap').style.display =
    type === 'TRANSFER' && getSubLocations(destination).length ? '' : 'none';
}

function batalCekScanAction() {
  cekScanPendingProduct = null;
  document.getElementById('modalCekScanAction').style.display = 'none';
  document.getElementById('inputCekEan').focus();
}

function mulaiCekScanAction() {
  const type = document.getElementById('cekScanActionType').value;
  const feature = type === 'MASUK' ? 'transfer_receive' : 'transfer_send';
  if (!requireFeatureAccess(feature, type === 'MASUK' ? 'Terima Barang' : 'Kirim / Transfer Barang')) return;
  const warehouse = document.getElementById('cekScanWarehouse').value;
  const destination = type === 'TRANSFER' ? document.getElementById('cekScanDestination').value : '';
  if (!warehouse) return alert('Pilih gudang untuk sesi scan.');
  if (type === 'TRANSFER' && (!destination || destination === warehouse)) {
    return alert('Pilih gudang tujuan yang berbeda dari gudang asal.');
  }
  cekScanSession = {
    type,
    warehouse,
    destination,
    sub_lokasi: document.getElementById('cekScanSubLokasi').value || '',
    sub_lokasi_tujuan: document.getElementById('cekScanDestinationSubLokasi').value || '',
    items: {}
  };
  document.getElementById('modalCekScanAction').style.display = 'none';
  if (cekScanPendingProduct) tambahBarangKeSesiScan(cekScanPendingProduct);
  cekScanPendingProduct = null;
  document.getElementById('inputCekEan').value = '';
  document.getElementById('inputCekEan').focus();
}

function tambahBarangKeSesiScan(product) {
  if (!cekScanSession) return;
  const sku = product.sku;
  if (!cekScanSession.items[sku]) cekScanSession.items[sku] = { sku, nama: product.nama, qty: 0 };
  cekScanSession.items[sku].qty += 1;
  const input = document.getElementById('inputCekEan');
  if (input) {
    input.value = '';
    input.focus();
  }
  renderCekScanSession();
}

function renderCekScanSession() {
  if (!cekScanSession) return;
  const items = Object.values(cekScanSession.items);
  const typeLabel = { MASUK: 'Terima Barang', TRANSFER: 'Transfer', KELUAR: 'Kirim Barang' }[cekScanSession.type];
  document.getElementById('cekEanJudul').textContent = `Sesi Scan: ${typeLabel}`;
  document.getElementById('cekEanDetailContent').innerHTML = `
    <div class="cek-summary">
      <div class="cek-chip"><span>Jenis</span><b>${typeLabel}</b></div>
      <div class="cek-chip"><span>Gudang</span><b>${cekEsc(cekScanSession.warehouse)}</b></div>
      ${cekScanSession.destination ? `<div class="cek-chip"><span>Tujuan</span><b>${cekEsc(cekScanSession.destination)}</b></div>` : ''}
      <div class="cek-chip"><span>Item Terscan</span><b>${items.reduce((sum, item) => sum + item.qty, 0)}</b></div>
    </div>
    <div class="cek-scan-session-actions">
      <button type="button" class="btn-primary" onclick="bukaRingkasanCekScan()">Selesai Scan / Lihat Item</button>
      <button type="button" class="btn-danger" onclick="batalCekScanSession()">Batalkan Sesi</button>
    </div>`;
  document.getElementById('hasilCekEanContainer').style.display = 'block';
}

function bukaRingkasanCekScan() {
  if (!cekScanSession) return;
  const rows = Object.values(cekScanSession.items);
  document.getElementById('cekScanSessionInfo').textContent =
    `${rows.length} SKU, ${rows.reduce((sum, item) => sum + item.qty, 0)} unit di ${cekScanSession.warehouse}.`;
  document.getElementById('cekScanSessionRows').innerHTML = rows.map(item => `
    <tr><td><code>${cekEsc(item.sku)}</code></td><td>${cekEsc(item.nama)}</td>
    <td>${formatQtyDisplay(item.qty)}</td><td>${cekEsc(uomOf(item.sku))}</td></tr>`).join('');
  document.getElementById('modalCekScanFinish').style.display = 'flex';
}

function batalCekScanSession() {
  cekScanSession = null;
  document.getElementById('modalCekScanFinish').style.display = 'none';
  document.getElementById('hasilCekEanContainer').style.display = 'none';
  document.getElementById('inputCekEan').value = '';
  document.getElementById('inputCekEan').focus();
}

function selesaiCekScanSession() {
  if (!cekScanSession) return;
  if (currentUser?.crud?.create === false) return alert('Akses ditolak: izin Create diperlukan.');
  const session = cekScanSession;
  const items = Object.values(session.items);
  if (!items.length) return alert('Belum ada SKU yang dipindai.');
  if (!canAccessWarehouseName(session.warehouse) ||
      (session.type === 'TRANSFER' && !canAccessWarehouseName(session.destination))) {
    return alert('Akses ke salah satu gudang tidak diizinkan.');
  }
  if ((session.type === 'TRANSFER' || session.type === 'KELUAR') && !appState.allowNegativeStock) {
    const insufficient = items.find(item => calculateStockRealtime(item.sku, session.warehouse) < item.qty);
    if (insufficient) return alert(`Stok ${insufficient.sku} tidak cukup di ${session.warehouse}.`);
  }
  const today = new Date().toISOString().split('T')[0];
  if (!appState.allowBackdate && isBackdate(today)) return alert('Transaksi tanggal mundur tidak diizinkan.');
  const noSJ = `SJ-SCAN-${today.replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
  const userName = currentUser ? currentUser.name : 'System';
  items.forEach(item => {
    const master = findMasterBarang(item.sku);
    const kodeProd = master?.kategori_produk === 'Finish Good' ? generateKodeProduksi(master.nama, today) : '-';
    const base = {
      id: Date.now() + Math.random(), no_sj: noSJ, gudang: session.warehouse,
      sub_lokasi: session.sub_lokasi, kode: item.sku, nama_barang: item.nama,
      kode_produksi: kodeProd, kategori_produk: master?.kategori_produk || '-',
      qty: item.qty, tanggal: today, pengirim_kurir: 'Scan Cek Stok',
      input_by: userName
    };
    if (session.type === 'TRANSFER') {
      appState.pendingTransfers.push({
        id: Date.now() + Math.random(), no_sj: noSJ,
        gudang_asal: session.warehouse, gudang_tujuan: session.destination,
        sku: item.sku, nama_barang: item.nama, kode_produksi: kodeProd,
        kategori_produk: master?.kategori_produk || '-', qty_gd: item.qty, qty_gr: 0,
        status: 'PENDING GR', tanggal: today, pengirim_kurir: 'Scan Cek Stok',
        created_by: userName, sub_lokasi_asal: session.sub_lokasi,
        sub_lokasi_tujuan: session.sub_lokasi_tujuan
      });
      appState.transactions.push({
        ...base, tipe: 'KELUAR', tujuan_keluar: `Transfer Ke ${session.destination}`
      });
    } else {
      appState.transactions.push({
        ...base, tipe: session.type,
        kategori_masuk: session.type === 'MASUK' ? (appState.kategoriMasukOptions[0] || 'Penerimaan') : '',
        tujuan_keluar: session.type === 'KELUAR' ? (appState.tujuanKeluarOptions[0] || 'Pengeluaran') : ''
      });
    }
  });
  saveData();
  cekScanSession = null;
  document.getElementById('modalCekScanFinish').style.display = 'none';
  document.getElementById('hasilCekEanContainer').style.display = 'none';
  renderDashboard(1);
  renderLaporanStok(1);
  renderTransferApproval(1);
  alert(`${items.length} SKU berhasil disimpan (${noSJ}).`);
  document.getElementById('inputCekEan').value = '';
  document.getElementById('inputCekEan').focus();
}

function exportCekStokPdf() {
  if (!requireFeatureAccess('pdf', 'Export PDF')) return;
  const detail = document.getElementById("cekEanDetailContent");
  const title = document.getElementById("cekEanJudul")?.textContent || "Laporan Cek Stok & Lokasi";
  if (!detail || !cekState.mode || !detail.innerHTML.trim()) return alert("Tampilkan hasil cek stok terlebih dahulu.");

  let reportHtml = detail.innerHTML;
  if (cekState.mode === 'LOKASI') {
    const query = (document.getElementById("searchCekLokasi")?.value || '').trim().toLowerCase();
    const kategoriPdf = document.getElementById("filterCekLokasiKategori")?.value || '';
    const rows = sortDisplayItems(cekState.items, item => item.sku).filter(item =>
      (!query || String(item.sku).toLowerCase().includes(query) || String(item.nama).toLowerCase().includes(query) || String(item.barcode || '').toLowerCase().includes(query)) &&
      (!kategoriPdf || item.kategori === kategoriPdf)
    );
    const tableRows = rows.length ? rows.map((item, index) => `<tr>
      <td>${index + 1}</td><td><code>${cekEsc(item.sku)}</code></td><td>${cekEsc(item.nama)}</td>
      <td>${cekStokBadge(item.stok, item.sku)}</td>
    </tr>`).join('') : `<tr><td colspan="4">Tidak ada produk sesuai filter.</td></tr>`;
    reportHtml = reportHtml.replace(/<tbody id="tabelCekLokasi">[\s\S]*?<\/tbody>/, `<tbody>${tableRows}</tbody>`);
  }

  const printWindow = window.open('', '_blank');
  if (!printWindow) return alert("Pop-up diblokir browser. Izinkan pop-up untuk mengekspor PDF.");
  printWindow.onload = () => printWindow.print();
  printWindow.document.write(`<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${cekEsc(title)}</title>
    <style>
      body{font:12px Arial,sans-serif;color:#111827;margin:24px}h1{font-size:18px;margin:0 0 16px}
      .cek-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
      .cek-chip{border:1px solid #cbd5e1;padding:8px}.cek-chip span{display:block;color:#475569;font-size:10px}
      table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #94a3b8;padding:7px;text-align:left}
      th{background:#e2e8f0}.cek-toolbar,button,.pagination-bar{display:none!important}
      @media print{body{margin:12mm}}
    </style></head><body><h1>${cekEsc(title)}</h1>${reportHtml}</body></html>`);
  printWindow.document.close();
  printWindow.focus();
}

function renderCekLokasiTable(page = 1) {
  const tbody = document.getElementById("tabelCekLokasi");
  if (!tbody) return;

  const q = (document.getElementById("searchCekLokasi")?.value || "").trim().toLowerCase();
  const pageSize = parseInt(document.getElementById("pageSizeCekLokasi")?.value) || 10;
  const kategoriFilter = document.getElementById("filterCekLokasiKategori")?.value || "";
  const filtered = cekState.items.filter(i =>
    (!q || String(i.sku).toLowerCase().includes(q) || String(i.nama).toLowerCase().includes(q) || String(i.barcode || '').toLowerCase().includes(q)) &&
    (!kategoriFilter || i.kategori === kategoriFilter)
  ).sort((a, b) => String(a.sku).localeCompare(String(b.sku), 'id', { numeric: true, sensitivity: 'base' }));

  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  pageCekLokasi = Math.min(Math.max(page, 1), totalPages);
  const startIndex = (pageCekLokasi - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

  if (totalItems === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="cek-empty">${(q || kategoriFilter) ? 'Tidak ada barang yang cocok dengan pencarian / filter kategori.' : 'Tidak ada barang di lokasi gudang ini.'}</td></tr>`;
  } else {
    tbody.innerHTML = filtered.slice(startIndex, endIndex).map((item, i) => `<tr>
      <td class="text-center">${startIndex + i + 1}</td>
      <td><code>${cekEsc(item.sku)}</code></td>
      <td><b>${cekEsc(item.nama)}</b></td>
      <td class="text-center">${cekStokBadge(item.stok, item.sku)}</td>
      <td>${Object.entries(item.sub_stok || {}).map(([name, qty]) => `${cekEsc(name)}: ${formatQtyDisplay(qty)} ${cekEsc(uomOf(item.sku))}`).join('<br>') || '-'}</td>
      <td class="text-center"><button class="btn-warning" data-feature="transfer_send,transfer_receive" data-sku="${cekEsc(item.sku)}" data-wh="${cekEsc(cekState.gudang)}" onclick="bukaModalCekTransfer(this.dataset.sku, this.dataset.wh)">Transfer / Keluar / Terima</button></td>
    </tr>`).join('');
  }

  updatePaginationControls(
    pageCekLokasi, totalPages,
    document.getElementById("btnPrevCekLokasi"), document.getElementById("btnNextCekLokasi"),
    document.getElementById("indicatorCekLokasiPage"), document.getElementById("infoCekLokasiPage"),
    startIndex, endIndex, totalItems
  );
  applyFeatureAccessUI();
}

function changeCekLokasiPage(delta) {
  renderCekLokasiTable(pageCekLokasi + delta);
}

function resetCekFoto() {
  cekFotoBase64 = "";
  document.getElementById("cekTrfFoto").value = "";
  document.getElementById("cekTrfFotoImg").src = "";
  document.getElementById("cekTrfFotoWrap").style.display = "none";
}

function previewCekFoto(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function(e) {
      cekFotoBase64 = e.target.result;
      document.getElementById("cekTrfFotoImg").src = cekFotoBase64;
      document.getElementById("cekTrfFotoWrap").style.display = "block";
    };
    reader.readAsDataURL(input.files[0]);
  }
}

function bukaModalCekTransfer(sku, gudang) {
  if (!hasFeatureAccess('transfer_send') && !hasFeatureAccess('transfer_receive')) return alert("Akses ditolak: Anda tidak memiliki izin Kirim maupun Terima Barang.");
  if (currentUser && currentUser.crud && currentUser.crud.create === false) {
    return alert("Akses Ditolak: Anda tidak memiliki izin [Create] untuk membuat transaksi baru!");
  }
  const master = findMasterBarang(sku);
  if (!master) return alert("Barang tidak ditemukan di Master Barang!");

  const accessibleWarehouses = getAccessibleWarehouses();
  const srcList = accessibleWarehouses;
  if (srcList.length === 0) return alert("Tidak ada lokasi gudang yang dapat Anda akses!");

  const opts = (list, selected) => list.map(v => `<option value="${cekEsc(v)}"${v === selected ? ' selected' : ''}>${cekEsc(v)}</option>`).join('');
  document.getElementById("cekTrfGudang").innerHTML = opts(srcList.map(w => w.nama), gudang);
  document.getElementById("cekTrfTujuan").innerHTML = opts(accessibleWarehouses.map(w => w.nama), '');
  renderSubLocationPicker('cekTrfSubLokasi', gudang);
  document.getElementById("cekTrfKatMasuk").innerHTML = opts(appState.kategoriMasukOptions, '');
  document.getElementById("cekTrfTujKeluar").innerHTML = opts(appState.tujuanKeluarOptions, '');

  cekTrfSku = master.sku;
  document.getElementById("cekTrfUomLbl").textContent = uomOf(master.sku);
  document.getElementById("cekTrfBarangInfo").textContent = `${master.sku} - ${master.nama}`;
  document.getElementById("cekTrfTipe").value = "TRANSFER";
  document.getElementById("cekTrfQty").value = 1;
  document.getElementById("cekTrfTanggal").value = new Date().toISOString().split("T")[0];
  document.getElementById("cekTrfNoSJ").value = "";
  document.getElementById("cekTrfKurir").value = "";
  document.getElementById("cekTrfKodeProd").value = "";
  document.getElementById("cekTrfWrapKodeProd").style.display = master.kategori_produk === 'Finish Good' ? 'flex' : 'none';
  resetCekFoto();
  toggleCekTipe();
  document.getElementById("modalCekTransfer").style.display = "flex";
}

function tutupModalCekTransfer() {
  document.getElementById("modalCekTransfer").style.display = "none";
  resetCekFoto();
}

function toggleCekTipe() {
  const tipe = document.getElementById("cekTrfTipe").value;
  const src = document.getElementById("cekTrfGudang").value;
  document.getElementById("cekTrfLblGudang").textContent = tipe === 'MASUK' ? 'Lokasi Penerima' : 'Lokasi Asal';
  document.getElementById("cekTrfWrapTujuan").style.display = tipe === 'TRANSFER' ? 'flex' : 'none';
  document.getElementById("cekTrfWrapTujuanSubLokasi").style.display = tipe === 'TRANSFER' ? 'flex' : 'none';
  document.getElementById("cekTrfWrapKatMasuk").style.display = tipe === 'MASUK' ? 'flex' : 'none';
  document.getElementById("cekTrfWrapTujKeluar").style.display = tipe === 'KELUAR' ? 'flex' : 'none';

  const tuj = document.getElementById("cekTrfTujuan");
  if (tuj.value === src) {
    const alt = Array.from(tuj.options).find(o => o.value !== src);
    if (alt) tuj.value = alt.value;
  }
  renderSubLocationPicker('cekTrfTujuanSubLokasi', tuj.value);
  updateCekStokInfo();
}

function updateCekStokInfo() {
  const gudang = document.getElementById("cekTrfGudang").value;
  const tipe = document.getElementById("cekTrfTipe").value;
  const stok = calculateStockRealtime(cekTrfSku, gudang);
  const blocked = tipe !== 'MASUK' && stok <= 0 && !appState.allowNegativeStock;
  const box = document.getElementById("cekTrfStokInfo");
  box.className = 'cek-stock-note' + (blocked ? ' is-warn' : '');
  box.textContent = `Stok tersedia di ${gudang}: ${stok} ${uomOf(cekTrfSku)}` + (blocked ? ' - stok tidak cukup untuk dikeluarkan.' : '');
}

function simpanCekTransfer(e) {
  e.preventDefault();
  if (currentUser && currentUser.crud && currentUser.crud.create === false) {
    return alert("Akses Ditolak: Anda tidak memiliki izin [Create] untuk membuat transaksi baru!");
  }

  const master = findMasterBarang(cekTrfSku);
  const tipe = document.getElementById("cekTrfTipe").value;
  if ((tipe === 'TRANSFER' || tipe === 'KELUAR') && !requireFeatureAccess('transfer_send', 'Kirim / Keluar Barang')) return;
  if (tipe === 'MASUK' && !requireFeatureAccess('transfer_receive', 'Terima Barang')) return;
  const gudang = document.getElementById("cekTrfGudang").value;
  const tujuan = document.getElementById("cekTrfTujuan").value;
  const tanggal = document.getElementById("cekTrfTanggal").value;
  const qty = Number(document.getElementById("cekTrfQty").value);
  const pengirim = document.getElementById("cekTrfKurir").value.trim() || "-";
  let noSJ = document.getElementById("cekTrfNoSJ").value.trim();
  const katMasuk = document.getElementById("cekTrfKatMasuk").value;
  const tujKeluar = document.getElementById("cekTrfTujKeluar").value;

  if (!master) return alert("Barang tidak ditemukan di Master Barang!");
  if (!gudang) return alert("Pilih Lokasi Gudang terlebih dahulu!");
  if (!canAccessWarehouseName(gudang) || (tipe === 'TRANSFER' && !canAccessWarehouseName(tujuan))) {
    return alert("Anda tidak memiliki akses ke lokasi gudang yang dipilih.");
  }
  if (!tanggal) return alert("Pilih Tanggal Transaksi!");
  if (!qty || qty <= 0) return alert("Qty harus lebih dari 0!");
  if (tipe === 'TRANSFER' && gudang === tujuan) return alert("Gudang Asal dan Gudang Tujuan tidak boleh sama!");
  if (!appState.allowBackdate && isBackdate(tanggal)) {
    return alert(`ERROR: Transaksi tanggal mundur (Backdate: ${tanggal}) tidak diizinkan karena Fitur Custom Backdate sedang NON-AKTIF!`);
  }
  if (tipe !== 'MASUK' && !appState.allowNegativeStock) {
    const avail = calculateStockRealtime(master.sku, gudang);
    if (avail < qty) {
      return alert(`ERROR: Barang SKU "${master.sku}" belum tersedia / stok tidak mencukupi di ${gudang}! (Stok Ada: ${avail}, Diminta: ${qty})`);
    }
  }
  if (tipe === 'MASUK' && !katMasuk) return alert('Pilih Kategori Masuk!');
  if (tipe === 'KELUAR' && !tujKeluar) return alert('Pilih Tujuan Keluar!');

  let kodeProd = document.getElementById("cekTrfKodeProd").value.trim();
  if (!(master.kategori_produk === 'Finish Good' && kodeProd)) kodeProd = '-';
  if (!noSJ) {
    noSJ = `SJ-${tipe === 'TRANSFER' ? 'TRF' : (tipe === 'MASUK' ? 'IN' : 'OUT')}-${tanggal.replace(/-/g, "")}-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  const userName = currentUser ? currentUser.name : 'System';
  const base = {
    no_sj: noSJ, gudang: gudang, sub_lokasi: document.getElementById('cekTrfSubLokasi').value || '', kode: master.sku, nama_barang: master.nama,
    kode_produksi: kodeProd, kategori_produk: master.kategori_produk,
    qty: qty, tanggal: tanggal, foto_bukti: cekFotoBase64 || '',
    pengirim_kurir: pengirim, input_by: userName
  };

  if (tipe === 'TRANSFER') {
    appState.pendingTransfers.push({
      id: Date.now() + Math.random(), no_sj: noSJ, gudang_asal: gudang, gudang_tujuan: tujuan,
      sku: master.sku, nama_barang: master.nama, kode_produksi: kodeProd, kategori_produk: master.kategori_produk,
      qty_gd: qty, qty_gr: 0, status: 'PENDING GR', tanggal: tanggal, pengirim_kurir: pengirim, created_by: userName,
      sub_lokasi_asal: document.getElementById('cekTrfSubLokasi').value || '',
      sub_lokasi_tujuan: document.getElementById('cekTrfTujuanSubLokasi').value || ''
    });
    appState.transactions.push({ ...base, id: Date.now() + Math.random(), tipe: 'KELUAR', tujuan_keluar: `Transfer Ke ${tujuan}` });
  } else {
    appState.transactions.push({
      ...base, id: Date.now() + Math.random(), tipe: tipe,
      kategori_masuk: tipe === 'MASUK' ? katMasuk : '',
      tujuan_keluar: tipe === 'KELUAR' ? tujKeluar : ''
    });
  }

  saveData();
  tutupModalCekTransfer();
  renderDashboard(1);
  renderLaporanStok(1);
  renderTransferApproval(1);
  prosesCekEan(true);
  alert(tipe === 'TRANSFER'
    ? `Transfer berhasil dikeluarkan (Good Delivery)! Menunggu Good Receipt di ${tujuan}. (No. SJ: ${noSJ})`
    : `Transaksi ${tipe} berhasil disimpan! (No. SJ: ${noSJ})`);
}

function downloadTemplateManifestExcel() {
  if (!requireFeatureAccess('export', 'Export')) return;
  const templateData = [
    { "Tanggal Manifest": "11/07/2026", "Air Way Bill (AWB)": "SPX102938475", "SKU / Kode Barang": "FG-002", "Qty": 1 },
    { "Tanggal Manifest": "11/07/2026", "Air Way Bill (AWB)": "JX992019283", "SKU / Kode Barang": "TrioMercon-OMD2", "Qty": 1 }
  ];
  const ws = XLSX.utils.json_to_sheet(templateData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Template Manifest Outbound");
  XLSX.writeFile(wb, "Template_Manifest_Ecommerce.xlsx");
}

function clearRekonData() {
  if (confirm("Apakah Anda yakin ingin menghapus seluruh data Manifest & Rekonsiliasi saat ini?")) {
    appState.manifest = [];
    appState.pdaScans = [];
    saveData();
    renderRekonsiliasi(1);
    alert("Data Manifest berhasil dibersihkan.");
  }
}

function uploadManifestExcel() {
  if (!requireFeatureAccess('import', 'Import')) return;
  const fileInput = document.getElementById("excelFile");
  if (!fileInput.files.length) return alert("Pilih file Excel Manifest!");

  const reader = new FileReader();
  reader.onload = function(e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonRows = XLSX.utils.sheet_to_json(sheet);

    if (jsonRows.length === 0) return alert("File Excel kosong!");

    appState.manifest = [];
    let importedCount = 0;

    jsonRows.forEach(row => {
      const awbVal = String(row['Air Way Bill (AWB)'] || row.AWB || row.awb || row.Resi || '').trim();
      const rawSku = String(row['SKU / Kode Barang'] || row.SKU || row.sku || '').trim();
      const baseQty = Number(row.Qty || row.qty || 1);
      const tgl = String(row['Tanggal Manifest'] || row.Tanggal || new Date().toLocaleDateString('en-US')).trim();

      if (awbVal && rawSku) {
        const bundleConfig = appState.bundleMapping.find(b => {
          const bSku = b.bundle_sku || b.sku_combo || b.sku || '';
          return bSku.toLowerCase() === rawSku.toLowerCase();
        });

        if (bundleConfig && Array.isArray(bundleConfig.items)) {
          bundleConfig.items.forEach(bItem => {
            appState.manifest.push({
              tanggal: tgl,
              awb: awbVal,
              sku: bItem.sku,
              qty: bItem.qty * baseQty,
              is_bundle: true,
              original_bundle_sku: rawSku
            });
          });
        } else {
          const master = findMasterBarang(rawSku);
          const finalSku = master ? master.sku : rawSku;
          appState.manifest.push({
            tanggal: tgl,
            awb: awbVal,
            sku: finalSku,
            qty: baseQty,
            is_bundle: false
          });
        }
        importedCount++;
      }
    });

    saveData();
    alert(`Berhasil mengimpor ${importedCount} baris data Manifest!`);
    renderRekonsiliasi(1);
    fileInput.value = "";
  };
  reader.readAsArrayBuffer(fileInput.files[0]);
}

// Hitung hasil scan sebuah baris manifest. Jika SKU manifest adalah bundle (belum dipecah saat import),
// scan PDA yang tersimpan per SKU komponen dicocokkan lewat pemetaan bundle.
function getManifestScanResult(m) {
  const awbKey = String(m.awb).trim().toLowerCase();
  const sumScan = (sku) => appState.pdaScans
    .filter(s => String(s.awb).trim().toLowerCase() === awbKey && String(s.kode_fg).trim().toLowerCase() === String(sku).trim().toLowerCase())
    .reduce((sum, s) => sum + Number(s.qty), 0);

  const direct = sumScan(m.sku);
  const rawSku = String(m.sku).trim().toLowerCase();
  const bundleConfig = appState.bundleMapping.find(b => {
    const bSku = b.bundle_sku || b.sku_combo || b.sku || '';
    return bSku.toLowerCase() === rawSku;
  });

  if (!m.is_bundle && bundleConfig && Array.isArray(bundleConfig.items) && bundleConfig.items.length > 0 && direct === 0) {
    let allMatch = true, anyScanned = false, minSets = Infinity;
    bundleConfig.items.forEach(comp => {
      const required = Number(comp.qty) * Number(m.qty);
      const scanned = sumScan(comp.sku);
      if (scanned > 0) anyScanned = true;
      if (scanned !== required) allMatch = false;
      minSets = Math.min(minSets, Math.floor(scanned / (Number(comp.qty) || 1)));
    });
    const scannedQty = anyScanned ? (allMatch ? Number(m.qty) : (isFinite(minSets) ? minSets : 0)) : 0;
    return { scannedQty, status: allMatch ? 'MATCH' : (anyScanned ? 'MISMATCH' : 'UNSCANNED') };
  }

  let status = 'UNSCANNED';
  if (direct === Number(m.qty)) status = 'MATCH';
  else if (direct > 0) status = 'MISMATCH';
  return { scannedQty: direct, status };
}

function renderRekonsiliasi(page = 1) {
  pageRekon = page;
  const tbody = document.getElementById("tabelRekon");
  if (!tbody) return;
  tbody.innerHTML = "";

  const sortedManifest = sortDisplayItems(appState.manifest || [], m => `${m.tanggal || ''}_${m.awb || ''}_${m.sku || ''}`);
  const totalItems = sortedManifest.length;
  const pageSize = parseInt(document.getElementById("pageSizeRekon")?.value) || 50;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  if (pageRekon > totalPages) pageRekon = totalPages;
  if (pageRekon < 1) pageRekon = 1;

  const startIndex = (pageRekon - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

  if (!appState.manifest || appState.manifest.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#94a3b8; padding:20px;">Belum ada data manifest yang di-import.</td></tr>`;
  } else {
    const paginatedData = sortedManifest.slice(startIndex, endIndex);

    paginatedData.forEach(m => {
      const scanResult = getManifestScanResult(m);
      const scannedQty = scanResult.scannedQty;
      const status = scanResult.status;
      const badge = status === 'MATCH' ? 'badge-success' : (status === 'MISMATCH' ? 'badge-danger' : 'badge-warning');

      const master = findMasterBarang(m.sku);
      const namaBarang = master ? master.nama : m.sku;
      const bundleLabel = m.is_bundle ? `<small style="color:#0284c7; display:block;">(Pecahan Bundle: ${m.original_bundle_sku})</small>` : '';

      tbody.innerHTML += `
        <tr>
          <td class="text-center">${m.tanggal || '-'}</td>
          <td><code><b>${m.awb}</b></code></td>
          <td><b>${m.sku}</b> - ${namaBarang} ${bundleLabel}</td>
          <td class="text-center"><b>${m.qty}</b> <span class="uom-tag">${uomOf(m.sku)}</span></td>
          <td class="text-center"><b>${scannedQty}</b></td>
          <td class="text-center"><span class="badge ${badge}">${status}</span></td>
        </tr>
      `;
    });
  }

  const infoEl = document.getElementById("infoRekonPage");
  const indicatorEl = document.getElementById("indicatorRekonPage");
  const btnPrev = document.getElementById("btnPrevRekon");
  const btnNext = document.getElementById("btnNextRekon");

  updatePaginationControls(pageRekon, totalPages, btnPrev, btnNext, indicatorEl, infoEl, startIndex, endIndex, totalItems);
}

function changeRekonPage(delta) {
  renderRekonsiliasi(pageRekon + delta);
}

// ==========================================
// LAPORAN STOK & STOCK OPNAME (per gudang)
// Data opname disimpan dengan key "NAMA_GUDANG::SKU" agar stok fisik
// tiap gudang tidak tercampur satu sama lain.
// ==========================================
const OPNAME_SEP = '::';

function opnameKey(gudang, sku) {
  return `${gudang}${OPNAME_SEP}${sku}`;
}

function parseOpnameKey(key) {
  const idx = String(key).indexOf(OPNAME_SEP);
  if (idx < 0) return null;
  return { gudang: key.slice(0, idx), sku: key.slice(idx + OPNAME_SEP.length) };
}

function getOpnameValue(gudang, sku) {
  const k = opnameKey(gudang, sku);
  if (appState.draftOpnameData && appState.draftOpnameData[k] !== undefined) return appState.draftOpnameData[k];
  if (appState.stockOpnameData && appState.stockOpnameData[k] !== undefined) return appState.stockOpnameData[k];
  return undefined;
}

function setOpnameValue(gudang, sku, value) {
  if (!appState.draftOpnameData) appState.draftOpnameData = {};
  if (!appState.stockOpnameData) appState.stockOpnameData = {};
  const k = opnameKey(gudang, sku);
  if (value === '' || value === null || value === undefined || isNaN(Number(value))) {
    delete appState.draftOpnameData[k];
    delete appState.stockOpnameData[k];
  } else {
    appState.draftOpnameData[k] = Number(value);
    appState.stockOpnameData[k] = Number(value);
  }
}

// Data opname lama (key hanya SKU) dipindahkan ke gudang pertama agar tidak hilang
function migrateOpnameKeys() {
  const defaultWH = appState.warehouses[0]?.nama || 'Gudang Utama';
  ['stockOpnameData', 'draftOpnameData'].forEach(field => {
    const src = (appState[field] && typeof appState[field] === 'object') ? appState[field] : {};
    const migrated = {};
    Object.keys(src).forEach(k => {
      migrated[k.includes(OPNAME_SEP) ? k : opnameKey(defaultWH, k)] = src[k];
    });
    appState[field] = migrated;
  });
}

function assertXlsxReady() {
  if (typeof XLSX === 'undefined') {
    alert("Library Excel (SheetJS) belum termuat. Periksa koneksi internet lalu muat ulang halaman.");
    return false;
  }
  return true;
}

function renderOpnameSkuPicker() {
  const sel = document.getElementById("opnameTambahSku");
  if (!sel) return;
  const list = sortDisplayItems(appState.masterBarang || [], b => b.sku);
  const sig = list.map(b => `${b.sku}|${b.nama}`).join(';');
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  sel.innerHTML = `<option value="">-- Pilih Barang --</option>` + list.map(b =>
    `<option value="${cekEsc(b.sku)}">${cekEsc(b.sku)} - ${cekEsc(b.nama)}</option>`
  ).join('');
}

function renderLaporanStok(page = 1) {
  pageLaporanStok = page;
  const tbody = document.getElementById("tabelLaporanStok");
  if (!tbody) return;
  tbody.innerHTML = "";
  renderOpnameSkuPicker();

  const selectedGudang = document.getElementById("filterGudangStok")?.value || '';
  const tglAwal = document.getElementById("tglStokAwal")?.value || '';
  const tglAkhir = document.getElementById("tglStokAkhir")?.value || '';
  const searchKW = (document.getElementById("searchStok")?.value || '').toLowerCase();
  const pageSize = parseInt(document.getElementById("pageSizeLaporanStok")?.value) || 10;

  if (!selectedGudang) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; color:#64748b; padding:20px;">Pilih gudang untuk menampilkan laporan stok dan opname.</td></tr>`;
    updatePaginationControls(
      1, 1,
      document.getElementById("btnPrevLaporanStok"), document.getElementById("btnNextLaporanStok"),
      document.getElementById("indicatorLaporanStokPage"), document.getElementById("infoLaporanStokPage"),
      0, 0, 0
    );
    return;
  }

  const isSemua = selectedGudang === 'semua';
  const userAllowedWH = currentUser ? (currentUser.allowed_warehouses || ['ALL']) : ['ALL'];
  const canSeeWH = gudang => !currentUser || currentUser.role === 'superadmin' || userAllowedWH.includes('ALL') || userAllowedWH.includes(gudang);

  const totalStockSystemMap = {};
  appState.transactions.forEach(t => {
    if ((isSemua || t.gudang === selectedGudang) && canSeeWH(t.gudang)) {
      if (!totalStockSystemMap[t.kode]) totalStockSystemMap[t.kode] = 0;
      if (t.tipe === 'MASUK') totalStockSystemMap[t.kode] += Number(t.qty);
      if (t.tipe === 'KELUAR') totalStockSystemMap[t.kode] -= Number(t.qty);
    }
  });

  const dateGroupMap = {};
  appState.transactions.forEach(t => {
    const matchDate = (!tglAwal || !t.tanggal || t.tanggal >= tglAwal) && (!tglAkhir || !t.tanggal || t.tanggal <= tglAkhir);
    if ((isSemua || t.gudang === selectedGudang) && canSeeWH(t.gudang) && matchDate) {
      const key = `${t.kode}_${t.tanggal}`;
      if (!dateGroupMap[key]) {
        const barangObj = findMasterBarang(t.kode);
        dateGroupMap[key] = {
          sku: t.kode,
          nama: t.nama_barang || (barangObj ? barangObj.nama : t.kode),
          kategori: t.kategori_produk || (barangObj ? barangObj.kategori_produk : 'Finish Good'),
          masuk: 0,
          keluar: 0,
          tanggal: t.tanggal || '-'
        };
      }
      if (t.tipe === 'MASUK') dateGroupMap[key].masuk += Number(t.qty);
      if (t.tipe === 'KELUAR') dateGroupMap[key].keluar += Number(t.qty);
    }
  });

  // SKU yang sudah diinput stok fisik (opname) di gudang ini namun belum punya mutasi ikut ditampilkan
  if (!isSemua) {
    Object.keys(appState.stockOpnameData || {}).forEach(k => {
      const p = parseOpnameKey(k);
      if (!p || p.gudang !== selectedGudang) return;
      const sudahAda = Object.values(dateGroupMap).some(r => r.sku === p.sku);
      if (!sudahAda) {
        const barangObj = findMasterBarang(p.sku);
        dateGroupMap[`${p.sku}_OPNAME`] = {
          sku: p.sku,
          nama: barangObj ? barangObj.nama : p.sku,
          kategori: barangObj ? barangObj.kategori_produk : 'Finish Good',
          masuk: 0,
          keluar: 0,
          tanggal: '-'
        };
      }
    });
  }

  let rowsList = Object.values(dateGroupMap);
  rowsList = rowsList.filter(item =>
    String(item.sku ?? '').toLowerCase().includes(searchKW) ||
    String(item.nama ?? '').toLowerCase().includes(searchKW) ||
    String(item.tanggal ?? '').includes(searchKW)
  );
  rowsList.sort((a, b) => compareDisplayValues(`${a.tanggal}_${a.sku}`, `${b.tanggal}_${b.sku}`));

  const totalItems = rowsList.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  if (pageLaporanStok > totalPages) pageLaporanStok = totalPages;
  if (pageLaporanStok < 1) pageLaporanStok = 1;

  const startIndex = (pageLaporanStok - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginatedData = rowsList.slice(startIndex, endIndex);

  if (paginatedData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; color:#94a3b8; padding:20px;">Tidak ada data pergerakan stok per tanggal transaksi.</td></tr>`;
  } else {
    paginatedData.forEach((s, idx) => {
      const realIndex = startIndex + idx + 1;
      const sisaStokSistemTotal = totalStockSystemMap[s.sku] !== undefined ? totalStockSystemMap[s.sku] : (s.masuk - s.keluar);

      const savedVal = isSemua ? undefined : getOpnameValue(selectedGudang, s.sku);
      const draftVal = savedVal !== undefined ? savedVal : '';
      const opnameVal = draftVal !== '' ? Number(draftVal) : null;

      let varianceText = '-';
      let statusBadge = '<span class="badge badge-secondary">Belum Opname</span>';
      if (opnameVal !== null) {
        const diff = opnameVal - sisaStokSistemTotal;
        varianceText = diff > 0 ? `+${diff}` : `${diff}`;
        if (diff === 0) {
          statusBadge = '<span class="badge badge-success">MATCH</span>';
        } else if (diff > 0) {
          statusBadge = '<span class="badge badge-info">SURPLUS (+ ' + diff + ')</span>';
        } else {
          statusBadge = '<span class="badge badge-danger">DEFISIT (' + diff + ')</span>';
        }
      }

      const disabledAttr = isSemua ? 'disabled title="Pilih gudang tertentu untuk mengisi stok fisik"' : '';
      tbody.innerHTML += `
        <tr>
          <td class="text-center">${realIndex}</td>
          <td><code>${cekEsc(s.sku)}</code></td>
          <td><b>${cekEsc(s.nama)}</b></td>
          <td>${cekEsc(s.kategori)}</td>
          <td class="text-center"><span class="badge badge-info">${cekEsc(uomOf(s.sku))}</span></td>
          <td class="text-center" style="color:#16a34a;"><b>${s.masuk || ''}</b></td>
          <td class="text-center" style="color:#dc2626;"><b>${s.keluar || ''}</b></td>
          <td class="text-center">${cekEsc(s.tanggal)}</td>
          <td class="text-center"><b style="font-size:14px;">${sisaStokSistemTotal}</b></td>
          <td class="text-center" style="background:#f0f9ff;">
            <input type="number" step="any" style="width:90px; text-align:center; padding:4px;"
              placeholder="Input Fisik" value="${draftVal}" data-sku="${cekEsc(s.sku)}" ${disabledAttr}
              onchange="updateStockOpnameVal(this.dataset.sku, this.value)">
          </td>
          <td class="text-center"><b>${varianceText}</b></td>
          <td class="text-center">${statusBadge}</td>
        </tr>
      `;
    });
  }

  updatePaginationControls(
    pageLaporanStok, totalPages,
    document.getElementById("btnPrevLaporanStok"), document.getElementById("btnNextLaporanStok"),
    document.getElementById("indicatorLaporanStokPage"), document.getElementById("infoLaporanStokPage"),
    startIndex, endIndex, totalItems
  );
}

function changeLaporanStokPage(delta) {
  renderLaporanStok(pageLaporanStok + delta);
}

function updateStockOpnameVal(sku, value) {
  const gudang = document.getElementById("filterGudangStok")?.value || '';
  if (!gudang || gudang === 'semua') {
    alert("Pilih satu gudang tertentu (bukan 'Semua Gudang') untuk mengisi stok fisik.");
    return renderLaporanStok(pageLaporanStok);
  }
  setOpnameValue(gudang, sku, value);
  saveData();
  renderLaporanStok(pageLaporanStok);
}

// Tambah item ke stock opname secara manual (untuk barang yang belum punya mutasi di gudang ini)
function tambahItemOpnameManual() {
  if (currentUser && currentUser.crud && currentUser.crud.create === false) {
    return alert("Akses Ditolak: Anda tidak memiliki izin [Create] untuk input stok opname!");
  }
  const gudang = document.getElementById("filterGudangStok")?.value || '';
  if (!gudang || gudang === 'semua') return alert("Pilih satu gudang tertentu di Filter Gudang sebelum menambah item opname.");
  const skuInput = document.getElementById("opnameTambahSku")?.value || '';
  const qtyInput = document.getElementById("opnameTambahQty")?.value;
  if (!skuInput) return alert("Pilih barang terlebih dahulu.");
  if (qtyInput === '' || qtyInput === undefined || isNaN(Number(qtyInput)) || Number(qtyInput) < 0) {
    return alert("Masukkan jumlah stok fisik yang valid (0 atau lebih).");
  }
  const master = findMasterBarang(skuInput);
  const skuFinal = master ? master.sku : skuInput;
  setOpnameValue(gudang, skuFinal, qtyInput);
  saveData();
  document.getElementById("opnameTambahQty").value = '';
  renderLaporanStok(1);
  alert(`Stok fisik ${skuFinal} di ${gudang} berhasil ditambahkan ke Stock Opname.`);
}

function simpanDraftOpname() {
  saveData();
  alert("Draft Hasil Stock Opname Berhasil Disimpan!");
}

function resetOpnameTerpilih() {
  if (currentUser?.crud?.create === false) return alert('Akses ditolak: Anda tidak memiliki izin untuk mengubah data opname.');
  const warehouse = document.getElementById('filterGudangStok')?.value || '';
  if (!warehouse) return alert('Pilih gudang terlebih dahulu sebelum reset opname.');
  const matches = key => {
    const parsed = parseOpnameKey(key);
    return parsed && (warehouse === 'semua' || parsed.gudang === warehouse);
  };
  const keys = new Set([
    ...Object.keys(appState.stockOpnameData || {}).filter(matches),
    ...Object.keys(appState.draftOpnameData || {}).filter(matches)
  ]);
  if (!keys.size) return alert('Tidak ada data opname untuk direset pada pilihan gudang ini.');
  const label = warehouse === 'semua' ? 'semua gudang' : warehouse;
  bukaModalGeneralDelete(`Hapus ${keys.size} data Stock Opname pada ${label}? Stok dan transaksi tidak akan berubah.`, () => {
    keys.forEach(key => {
      delete appState.stockOpnameData[key];
      delete appState.draftOpnameData[key];
    });
    saveData();
    renderLaporanStok(1);
    alert(`Data Stock Opname pada ${label} berhasil direset.`);
  });
}

function downloadTemplateOpnameExcel() {
  if (!requireFeatureAccess('export', 'Export')) return;
  if (!assertXlsxReady()) return;
  const selectedGudang = document.getElementById("filterGudangStok")?.value || '';
  const defaultGudang = (selectedGudang && selectedGudang !== 'semua') ? selectedGudang : '';
  // Kolom stok fisik dikosongkan: baris yang tidak diisi TIDAK akan mengubah stok
  const templateRows = appState.masterBarang.map(b => ({
    "Kode SKU": b.sku,
    "Nama Barang": b.nama,
    "Gudang": defaultGudang,
    "Stock Opname (Fisik)": ""
  }));

  const ws = XLSX.utils.json_to_sheet(templateRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Template Stock Opname");
  XLSX.writeFile(wb, "Template_Stock_Opname.xlsx");
}

function importOpnameExcel(input) {
  if (!requireFeatureAccess('import', 'Import')) return;
  if (!input || !input.files || !input.files.length) return alert("Pilih file Excel Stock Opname (.xlsx / .xls) terlebih dahulu.");
  if (!assertXlsxReady()) return;

  const selectedGudang = document.getElementById("filterGudangStok")?.value || '';
  const defaultGudang = (selectedGudang && selectedGudang !== 'semua') ? selectedGudang : '';

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (jsonRows.length === 0) return alert("File Excel kosong!");

      let countUpdated = 0, skipEmpty = 0, skipNoWH = 0, skipBadWH = 0, skipUnknownSku = 0;
      const touchedGudang = new Set();

      jsonRows.forEach(row => {
        const skuRaw = String(row['Kode SKU'] || row.SKU || row.sku || '').trim();
        if (!skuRaw) return;
        const opnameRaw = row['Stock Opname (Fisik)'] !== undefined ? row['Stock Opname (Fisik)'] : (row.Opname ?? row.Fisik ?? row.qty);
        if (opnameRaw === undefined || opnameRaw === null || String(opnameRaw).trim() === '') { skipEmpty++; return; }
        const valNum = Number(opnameRaw);
        if (isNaN(valNum) || valNum < 0) { skipEmpty++; return; }

        const gudangRaw = String(row.Gudang || row.gudang || defaultGudang || '').trim();
        if (!gudangRaw) { skipNoWH++; return; }
        const wh = appState.warehouses.find(w => w.nama.toLowerCase() === gudangRaw.toLowerCase());
        if (!wh) { skipBadWH++; return; }

        const master = findMasterBarang(skuRaw);
        if (!master) { skipUnknownSku++; return; }

        setOpnameValue(wh.nama, master.sku, valNum);
        touchedGudang.add(wh.nama);
        countUpdated++;
      });

      saveData();

      // Jika seluruh data berasal dari satu gudang, otomatis pilih gudang tersebut di filter
      if (touchedGudang.size === 1) {
        const only = [...touchedGudang][0];
        const filterEl = document.getElementById("filterGudangStok");
        if (filterEl && Array.from(filterEl.options).some(o => o.value === only)) filterEl.value = only;
      }
      renderLaporanStok(1);
      input.value = "";

      let msg = `Berhasil mengimpor ${countUpdated} data Stock Opname Fisik.`;
      if (skipEmpty) msg += `\n${skipEmpty} baris dilewati (kolom Stock Opname kosong / tidak valid).`;
      if (skipNoWH) msg += `\n${skipNoWH} baris dilewati: pilih Filter Gudang atau isi kolom "Gudang" di Excel.`;
      if (skipBadWH) msg += `\n${skipBadWH} baris dilewati: nama gudang tidak ditemukan di Master Gudang.`;
      if (skipUnknownSku) msg += `\n${skipUnknownSku} baris dilewati: SKU tidak ditemukan di Master Barang.`;
      alert(msg);
    } catch (err) {
      alert("Gagal membaca file Excel: " + (err && err.message ? err.message : err));
    }
  };
  reader.readAsArrayBuffer(input.files[0]);
}

function bukaModalKonfirmasiOpname() {
  if (currentUser && currentUser.crud && currentUser.crud.create === false) {
    return alert("Akses Ditolak: Anda tidak memiliki izin [Create] untuk penyesuaian stok!");
  }
  if (!document.getElementById("filterGudangStok")?.value) return alert("Pilih gudang terlebih dahulu sebelum melakukan penyesuaian stok.");
  document.getElementById("modalConfirmOpname").style.display = "flex";
}

function tutupModalKonfirmasiOpname() {
  document.getElementById("modalConfirmOpname").style.display = "none";
}

function eksekusiOpnameYa() {
  tutupModalKonfirmasiOpname();
  prosesPenyesuaianStokOpname();
}

// Penyesuaian dihitung per gudang: setiap entri opname dibandingkan dengan stok sistem gudang tersebut
function prosesPenyesuaianStokOpname() {
  const selectedGudang = document.getElementById("filterGudangStok")?.value || '';
  if (!selectedGudang) return alert("Pilih gudang terlebih dahulu sebelum melakukan penyesuaian stok.");

  const today = new Date().toISOString().split("T")[0];
  const adjustmentBatchId = `ADJ-${Date.now()}`;

  const entries = Object.keys(appState.stockOpnameData || {})
    .map(k => ({ key: k, ...(parseOpnameKey(k) || {}) }))
    .filter(e => e.gudang && e.sku && (selectedGudang === 'semua' || e.gudang === selectedGudang));

  if (entries.length === 0) {
    return alert("Belum ada data Stock Opname (stok fisik) untuk gudang ini.\nUpload Excel Opname atau tambahkan item fisik terlebih dahulu.");
  }

  let adjustedCount = 0;
  entries.forEach(({ key, gudang, sku }) => {
    const opnameFisik = Number(appState.stockOpnameData[key]);
    const sisaStokSistem = calculateStockRealtime(sku, gudang);
    const diff = opnameFisik - sisaStokSistem;

    if (diff !== 0) {
      const barangMaster = findMasterBarang(sku);
      const namaBarang = barangMaster ? barangMaster.nama : sku;
      const katProd = barangMaster ? barangMaster.kategori_produk : 'Finish Good';
      const kodeProd = katProd === 'Finish Good' ? generateKodeProduksi(namaBarang, today) : '-';
      const isSurplus = diff > 0;

      appState.transactions.push({
        id: Date.now() + Math.random(),
        no_sj: adjustmentBatchId,
        tipe: isSurplus ? 'MASUK' : 'KELUAR',
        gudang: gudang,
        kode: sku,
        nama_barang: namaBarang,
        kode_produksi: kodeProd,
        kategori_produk: katProd,
        kategori_masuk: isSurplus ? 'Penyesuaian Stok Opname (Surplus)' : '',
        tujuan_keluar: isSurplus ? '' : 'Penyesuaian Stok Opname (Defisit)',
        qty: Math.abs(diff),
        tanggal: today,
        pengirim_kurir: 'System Adjustment',
        input_by: (currentUser ? currentUser.name : 'System') + ' (Opname Adjustment)'
      });
      adjustedCount++;
    }

    // Entri yang sudah diproses dibersihkan dari data opname
    delete appState.stockOpnameData[key];
    delete appState.draftOpnameData[key];
  });

  saveData();
  renderDashboard(1);
  renderLaporanStok(1);

  if (adjustedCount === 0) {
    return alert("Tidak ada selisih stok (Variance) yang perlu disesuaikan. Data opname yang sudah sesuai telah dibersihkan.");
  }
  alert(`STATUS SUCCESS: Berhasil mengeksekusi penyesuaian stok untuk ${adjustedCount} item SKU!`);
}

function exportLaporanStokExcel() {
  if (!requireFeatureAccess('export', 'Export')) return;
  const selectedGudang = document.getElementById("filterGudangStok")?.value || '';
  if (!selectedGudang) return alert("Pilih gudang terlebih dahulu sebelum meng-export laporan stok.");
  const tglAwal = document.getElementById("tglStokAwal")?.value || '';
  const tglAkhir = document.getElementById("tglStokAkhir")?.value || '';
  const userAllowedWH = currentUser ? (currentUser.allowed_warehouses || ['ALL']) : ['ALL'];
  const canAccessWarehouse = warehouse => !currentUser || currentUser.role === 'superadmin' || userAllowedWH.includes('ALL') || userAllowedWH.includes(warehouse);
  const dateGroupMap = {};
  appState.transactions.forEach(t => {
    const matchGudang = (selectedGudang === 'semua' || t.gudang === selectedGudang) && canAccessWarehouse(t.gudang);
    if (matchGudang) {
      const key = `${t.kode}_${t.tanggal}`;
      if (!dateGroupMap[key]) {
        const barangObj = findMasterBarang(t.kode);
        dateGroupMap[key] = {
          sku: t.kode,
          nama: t.nama_barang || (barangObj ? barangObj.nama : t.kode),
          kategori: t.kategori_produk || (barangObj ? barangObj.kategori_produk : 'Finish Good'),
          masuk: 0,
          keluar: 0,
          tanggal: t.tanggal
        };
      }
      if (t.tipe === 'MASUK') dateGroupMap[key].masuk += Number(t.qty);
      if (t.tipe === 'KELUAR') dateGroupMap[key].keluar += Number(t.qty);
    }
  });

  const sortedMovements = Object.values(dateGroupMap).sort((a, b) =>
    compareDisplayValues(`${a.tanggal}_${a.sku}`, `${b.tanggal}_${b.sku}`)
  );
  const runningStockBySku = {};
  const exportRows = [];
  sortedMovements.forEach(s => {
    const sisa = (runningStockBySku[s.sku] || 0) + s.masuk - s.keluar;
    runningStockBySku[s.sku] = sisa;
    if ((tglAwal && s.tanggal < tglAwal) || (tglAkhir && s.tanggal > tglAkhir)) return;

    const savedOpname = selectedGudang === 'semua' ? undefined : getOpnameValue(selectedGudang, s.sku);
    const opnameVal = savedOpname !== undefined ? savedOpname : null;
    const diff = opnameVal !== null ? (opnameVal - sisa) : '-';

    let statusText = 'Belum Opname';
    if (opnameVal !== null) {
      if (diff === 0) statusText = 'MATCH';
      else if (diff > 0) statusText = `SURPLUS (+${diff})`;
      else statusText = `DEFISIT (${diff})`;
    }

    exportRows.push({
      "No": exportRows.length + 1,
      "Kode SKU": s.sku,
      "Nama Barang": s.nama,
      "Kategori Produk": s.kategori,
      "UoM": uomOf(s.sku),
      "Masuk": s.masuk || 0,
      "Keluar": s.keluar || 0,
      "Tanggal": s.tanggal,
      "Stok Sistem": sisa,
      "Stock Opname (Fisik)": opnameVal !== null ? opnameVal : '-',
      "Selisih / Variance": diff,
      "Status Matching": statusText
    });
  });

  if (exportRows.length === 0) return alert("Tidak ada pergerakan stok pada gudang dan periode yang dipilih.");
  if (!assertXlsxReady()) return;

  const ws = XLSX.utils.json_to_sheet(exportRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Laporan Stok Per Tanggal");
  XLSX.writeFile(wb, `Laporan_Stok_Per_Tanggal_${new Date().toISOString().split('T')[0]}.xlsx`);
}

window.onload = function() {
  checkSession();
};