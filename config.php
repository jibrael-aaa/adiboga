<?php
// ==========================================================================
// config.php - Konfigurasi, session, CORS, koneksi PDO, dan auto-install skema
// WMS Adiboga
// ==========================================================================

// Presisi float konsisten untuk json_encode (ID transaksi berupa float)
ini_set('serialize_precision', '-1');
// Jangan tampilkan error ke klien (merusak JSON). Error dicatat ke log server.
ini_set('display_errors', '0');
error_reporting(E_ALL);

// Helper membaca environment variable dengan nilai default
function env_or($key, $default = '') {
    $v = getenv($key);
    return ($v === false || $v === '') ? $default : $v;
}

// ---------------------------------------------------------------------------
// KONFIGURASI DATABASE (isi lewat environment variable di produksi)
// ---------------------------------------------------------------------------
$db_host = env_or('WMS_DB_HOST', 'localhost');
$db_user = env_or('WMS_DB_USER', 'root');
$db_pass = env_or('WMS_DB_PASS', '');
$db_name = env_or('WMS_DB_NAME', 'erp_warehouse');

// Auto-buat tabel + akun default (admin & user) bila belum ada.
// Di produksi set env WMS_AUTO_INSTALL=0 setelah skema dibuat/diimpor (dan ganti password default).
define('WMS_AUTO_INSTALL', in_array(strtolower(env_or('WMS_AUTO_INSTALL', '1')), ['1', 'true', 'yes', 'on'], true));

// Daftar origin frontend yang diizinkan (pisahkan dengan koma).
// Kosongkan jika frontend & api.php satu domain (disarankan).
$allowedOrigins = array_filter(array_map('trim', explode(',', env_or('WMS_ALLOWED_ORIGINS', ''))));

// ---------------------------------------------------------------------------
// SESSION
// ---------------------------------------------------------------------------
if (session_status() === PHP_SESSION_NONE) {
    $isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    session_name('WMSSESSID');
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'secure'   => $isHttps,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

// ---------------------------------------------------------------------------
// CORS & HEADER
// ---------------------------------------------------------------------------
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && in_array($origin, $allowedOrigins, true)) {
    header("Access-Control-Allow-Origin: $origin");
    header("Access-Control-Allow-Credentials: true");
    header("Vary: Origin");
}
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, X-Requested-With");
header("Content-Type: application/json; charset=UTF-8");
header("X-Content-Type-Options: nosniff");
header("Cache-Control: no-store");

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// ---------------------------------------------------------------------------
// KONEKSI PDO
// ---------------------------------------------------------------------------
$dsn = "mysql:host=$db_host;dbname=$db_name;charset=utf8mb4";
$options = [
    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES   => false,
];

try {
    $pdo = new PDO($dsn, $db_user, $db_pass, $options);
} catch (PDOException $e) {
    error_log("Kesalahan Koneksi Database: " . $e->getMessage());
    http_response_code(500);
    echo json_encode(["status" => "error", "message" => "Terjadi kesalahan server internal. Silakan coba lagi nanti."]);
    exit();
}

// ---------------------------------------------------------------------------
// AUTO-INSTALL SKEMA & SEED AKUN DEFAULT
// ---------------------------------------------------------------------------
function wms_state_tables() {
    return [
        'transactions' => 'wms_transactions_v2',
        'pdaScans' => 'wms_pda_scans_v2',
        'manifest' => 'wms_manifest_v2',
        'stockOpnameData' => 'wms_stock_opname_v2',
        'draftOpnameData' => 'wms_draft_stock_opname_v2',
        'returRecords' => 'wms_returns_v2',
        'pendingTransfers' => 'wms_pending_transfers_v2',
        'awbPrefixRules' => 'wms_awb_prefix_rules_v2',
        'skuBarcodeRules' => 'wms_sku_barcode_rules_v2',
        'masterBarang' => 'wms_master_barang_v2',
        'bundleMapping' => 'wms_bundle_mapping_v2',
        'warehouses' => 'wms_warehouses_v2',
        'uomList' => 'wms_uom_v2',
        'kategoriProduk' => 'wms_product_categories_v2',
        'kategoriMasukOptions' => 'wms_incoming_categories_v2',
        'tujuanKeluarOptions' => 'wms_outgoing_reasons_v2',
        'masterBOM' => 'wms_boms_v2',
    ];
}

function wms_state_columns() {
    $text = 'LONGTEXT NULL';
    $number = 'DECIMAL(30,15) NULL';
    return [
        'transactions' => ['id' => $number, 'no_sj' => $text, 'tipe' => $text, 'gudang' => $text, 'sub_lokasi' => $text, 'kode' => $text, 'nama_barang' => $text, 'kode_produksi' => $text, 'batch_no' => $text, 'shift' => $text, 'kategori_produk' => $text, 'kategori_masuk' => $text, 'tujuan_keluar' => $text, 'qty' => $number, 'tanggal' => $text, 'tanggal_produksi' => $text, 'foto_bukti' => 'LONGTEXT NULL', 'pengirim_kurir' => $text, 'input_by' => $text],
        'pdaScans' => ['awb' => $text, 'kode_fg' => $text, 'qty' => $number, 'mode' => $text, 'date' => $text],
        'manifest' => ['tanggal' => $text, 'awb' => $text, 'sku' => $text, 'qty' => $number, 'is_bundle' => 'TINYINT(1) NULL', 'original_bundle_sku' => $text],
        'stockOpnameData' => ['gudang' => $text, 'sku' => $text, 'qty' => $number],
        'draftOpnameData' => ['gudang' => $text, 'sku' => $text, 'qty' => $number],
        'returRecords' => ['id' => $number, 'tanggal' => $text, 'awb' => $text, 'status_resi' => $text, 'tpl' => $text, 'sku' => $text, 'nama_barang' => $text, 'qty' => $number, 'gudang' => $text],
        'pendingTransfers' => ['id' => $number, 'no_sj' => $text, 'gudang_asal' => $text, 'gudang_tujuan' => $text, 'sku' => $text, 'nama_barang' => $text, 'kode_produksi' => $text, 'batch_no' => $text, 'shift' => $text, 'kategori_produk' => $text, 'qty_gd' => $number, 'qty_gr' => $number, 'status' => $text, 'tanggal' => $text, 'tanggal_produksi' => $text, 'pengirim_kurir' => $text, 'created_by' => $text, 'sub_lokasi_asal' => $text, 'sub_lokasi_tujuan' => $text],
        'awbPrefixRules' => ['prefix' => $text, 'name' => $text],
        'skuBarcodeRules' => ['prefix' => $text, 'sku' => $text, 'sku_start' => 'INT NULL', 'sku_length' => 'INT NULL', 'quantity_start' => 'INT NULL', 'quantity_length' => 'INT NULL', 'date_start' => 'INT NULL', 'date_length' => 'INT NULL'],
        'masterBarang' => ['sku' => $text, 'nama' => $text, 'barcode' => $text, 'kategori_produk' => $text, 'uom' => $text],
        'bundleMapping' => ['bundle_sku' => $text],
        'warehouses' => ['nama' => $text, 'ean' => $text],
        'uomList' => ['kode' => $text, 'nama' => $text],
        'kategoriProduk' => ['value' => $text],
        'kategoriMasukOptions' => ['value' => $text],
        'tujuanKeluarOptions' => ['value' => $text],
        'masterBOM' => ['id' => $number, 'nama_bom' => $text, 'sku_hasil' => $text],
    ];
}

function wms_install_schema(PDO $pdo) {
    $pdo->exec("CREATE TABLE IF NOT EXISTS users (
        username VARCHAR(64) NOT NULL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'user',
        crud TEXT NULL,
        allowed_menus TEXT NULL,
        allowed_warehouses TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS user_sessions (
        username VARCHAR(64) NOT NULL PRIMARY KEY,
        session_hash CHAR(64) NOT NULL,
        last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_user_sessions_user FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS app_state (
        state_key VARCHAR(64) NOT NULL PRIMARY KEY,
        state_value LONGTEXT NOT NULL,
        revision INT UNSIGNED NOT NULL DEFAULT 1,
        updated_by VARCHAR(64) NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS wms_state_meta (
        state_key VARCHAR(64) NOT NULL PRIMARY KEY,
        root_type VARCHAR(16) NOT NULL DEFAULT 'array',
        revision INT UNSIGNED NOT NULL DEFAULT 0,
        initialized TINYINT(1) NOT NULL DEFAULT 0,
        updated_by VARCHAR(64) NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS wms_settings (
        state_key VARCHAR(64) NOT NULL PRIMARY KEY,
        setting_value LONGTEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS wms_app_settings (
        setting_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        allow_negative_stock TINYINT(1) NULL,
        allow_backdate TINYINT(1) NULL,
        pda_ecom_warehouse LONGTEXT NULL,
        pda_request_warehouse LONGTEXT NULL,
        pda_ecom_tujuan LONGTEXT NULL,
        pda_request_tujuan LONGTEXT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    foreach (wms_state_tables() as $key => $table) {
        $columns = [];
        foreach (wms_state_columns()[$key] as $name => $definition) {
            $columns[] = "`$name` $definition";
        }
        $pdo->exec("CREATE TABLE IF NOT EXISTS `$table` (
            record_order INT UNSIGNED NOT NULL PRIMARY KEY,
            record_key TEXT NOT NULL,
            " . implode(",\n            ", $columns) . "
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    }
    foreach (['transactions' => ['sub_lokasi', 'batch_no', 'shift', 'tanggal_produksi'], 'pendingTransfers' => ['sub_lokasi_asal', 'sub_lokasi_tujuan', 'batch_no', 'shift', 'tanggal_produksi']] as $key => $newColumns) {
        $table = wms_state_tables()[$key];
        foreach ($newColumns as $column) {
            $stmt = $pdo->prepare("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1");
            $stmt->execute([$table, $column]);
            if (!$stmt->fetch()) {
                $pdo->exec("ALTER TABLE `$table` ADD COLUMN `$column` LONGTEXT NULL");
            }
        }
    }

    $pdo->exec("CREATE TABLE IF NOT EXISTS wms_bundle_mapping_items (
        record_order INT UNSIGNED NOT NULL,
        item_order INT UNSIGNED NOT NULL,
        sku LONGTEXT NULL,
        qty DECIMAL(30,15) NULL,
        PRIMARY KEY (record_order, item_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS wms_bom_items (
        record_order INT UNSIGNED NOT NULL,
        item_order INT UNSIGNED NOT NULL,
        sku LONGTEXT NULL,
        qty DECIMAL(30,15) NULL,
        PRIMARY KEY (record_order, item_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS wms_record_extra_fields (
        state_key VARCHAR(64) NOT NULL,
        record_order INT UNSIGNED NOT NULL,
        field_name VARCHAR(128) NOT NULL,
        field_value LONGTEXT NULL,
        PRIMARY KEY (state_key, record_order, field_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS wms_schema_migrations (
        migration_key VARCHAR(100) NOT NULL PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $count = (int)$pdo->query("SELECT COUNT(*) FROM users")->fetchColumn();
    if ($count === 0) {
        $allMenus = ['dashboardView','masterBarangView','inputView','manufakturView','pdaView','rekonView','rekonReturView','cekStokView','transferApprovalView','laporanStokView'];
        $userMenus = ['dashboardView','inputView','pdaView','rekonView','rekonReturView','cekStokView','transferApprovalView','laporanStokView'];
        $stmt = $pdo->prepare("INSERT INTO users (username, name, password_hash, role, crud, allowed_menus, allowed_warehouses) VALUES (?,?,?,?,?,?,?)");
        $stmt->execute(['admin', 'Admin Utama', password_hash('admin123', PASSWORD_DEFAULT), 'superadmin',
            json_encode(['create'=>true,'read'=>true,'update'=>true,'delete'=>true]),
            json_encode($allMenus), json_encode(['ALL'])]);
        $stmt->execute(['user', 'Staff Gudang', password_hash('user123', PASSWORD_DEFAULT), 'user',
            json_encode(['create'=>true,'read'=>true,'update'=>false,'delete'=>false]),
            json_encode($userMenus), json_encode(['ALL'])]);
    }
}

if (WMS_AUTO_INSTALL) {
    try {
        wms_install_schema($pdo);
    } catch (PDOException $e) {
        error_log("Gagal install skema: " . $e->getMessage());
        http_response_code(500);
        echo json_encode(["status" => "error", "message" => "Gagal menyiapkan database."]);
        exit();
    }
}
?>
