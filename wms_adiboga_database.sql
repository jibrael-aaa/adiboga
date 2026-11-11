-- =====================================================================
-- WMS Adiboga - SQL untuk import / upload database
-- Skema identik dengan config.php (wms_install_schema) dan dipakai api.php.
-- State aktif menggunakan tabel domain terstruktur; tabel app_state dan
-- tabel wms_* versi lama dipertahankan sebagai backup migrasi.
--
-- CARA PAKAI
--   A. phpMyAdmin (hosting): pilih database tujuan di panel kiri,
--      buka tab "Import", pilih file ini, lalu klik "Go".
--   B. Command line:  mysql -u USER -p NAMA_DATABASE < wms_adiboga_database.sql
--
-- CATATAN
--   - File ini TIDAK membuat database. Buat/pilih database dulu.
--     Nama default: erp_warehouses (samakan dengan WMS_DB_NAME di config.php).
--   - Aman dijalankan ulang: tabel memakai IF NOT EXISTS dan akun yang
--     sudah ada tidak akan ditimpa. Data akses gudang lama yang berisi
--     "ALL" sekaligus nama lokasi akan dinormalisasi ke nama lokasi tersebut.
--   - Membutuhkan MySQL 5.7+ atau MariaDB 10.2+.
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- 1. TABEL AKUN PENGGUNA
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  username VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'user',          -- superadmin | admin | user
  crud TEXT NULL,                                     -- JSON {create,read,update,delete}
  allowed_menus TEXT NULL,                            -- JSON array id menu
  allowed_warehouses TEXT NULL,                       -- JSON array nama gudang / ["ALL"]
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 1b. SESI LOGIN
--     Secara default satu sesi aktif per akun; opsi Master Akun dapat mengizinkan banyak sesi.
-- ---------------------------------------------------------------------
-- Tabel lama dipertahankan untuk migrasi otomatis oleh api.php.
CREATE TABLE IF NOT EXISTS user_sessions (
  username VARCHAR(64) NOT NULL PRIMARY KEY,
  session_hash CHAR(64) NOT NULL,
  last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_sessions_user FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Satu baris per perangkat/session agar opsi akses bersamaan dapat diterapkan.
CREATE TABLE IF NOT EXISTS user_session_devices (
  username VARCHAR(64) NOT NULL,
  session_hash CHAR(64) NOT NULL,
  last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (username, session_hash),
  CONSTRAINT fk_user_session_devices_user FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 1a. NORMALISASI AKSES GUDANG LAMA
--     "ALL" hanya berarti semua gudang jika tidak ada lokasi tertentu
--     yang dipilih. Jangan mengubah akun yang memang hanya berisi ["ALL"].
-- ---------------------------------------------------------------------
UPDATE users
SET allowed_warehouses = JSON_REMOVE(
  allowed_warehouses,
  JSON_SEARCH(allowed_warehouses, 'one', 'ALL')
)
WHERE JSON_VALID(allowed_warehouses)
  AND JSON_TYPE(allowed_warehouses) = 'ARRAY'
  AND JSON_CONTAINS(allowed_warehouses, '"ALL"')
  AND JSON_LENGTH(allowed_warehouses) > 1;

-- ---------------------------------------------------------------------
-- 2. TABEL STATE LEGACY (BACKUP SAJA)
--    API aktif tidak lagi membaca/menulis tabel ini. Data lama akan
--    dipindahkan otomatis ke tabel domain pada akses API pertama.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_state (
  state_key VARCHAR(64) NOT NULL PRIMARY KEY,        -- transactions, masterBarang, warehouses, dst.
  state_value LONGTEXT NOT NULL,                     -- JSON
  revision INT UNSIGNED NOT NULL DEFAULT 1,          -- deteksi konflik multi-user
  updated_by VARCHAR(64) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 2a. METADATA REVISI DAN PENGATURAN
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wms_state_meta (
  state_key VARCHAR(64) NOT NULL PRIMARY KEY,
  root_type VARCHAR(16) NOT NULL DEFAULT 'array',
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  initialized TINYINT(1) NOT NULL DEFAULT 0,
  updated_by VARCHAR(64) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wms_settings (
  state_key VARCHAR(64) NOT NULL PRIMARY KEY,
  setting_value LONGTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wms_app_settings (
  setting_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  allow_negative_stock TINYINT(1) NULL,
  allow_backdate TINYINT(1) NULL,
  pda_ecom_warehouse LONGTEXT NULL,
  pda_request_warehouse LONGTEXT NULL,
  pda_ecom_tujuan LONGTEXT NULL,
  pda_request_tujuan LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 2b. LEGACY DOMAIN TABLES (BACKUP)
--     Bentuk record_key/record_value hanya untuk migrasi versi terdahulu.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wms_transactions (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_pda_scans (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_manifest (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_stock_opname (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_draft_stock_opname (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_returns (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_pending_transfers (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_awb_prefix_rules (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_master_barang (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_bundle_mapping (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_warehouses (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_uom (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_product_categories (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_incoming_categories (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_outgoing_reasons (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_boms (record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, record_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 2c. TABEL DOMAIN TERSTRUKTUR (AKTIF)
--     Setiap atribut domain memiliki kolom sendiri. Relasi BOM dan bundle
--     disimpan pada tabel anak, bukan sebagai payload JSON dalam record.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wms_transactions_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL,
  id DECIMAL(30,15) NULL, no_sj LONGTEXT NULL, tipe LONGTEXT NULL, gudang LONGTEXT NULL, sub_lokasi LONGTEXT NULL,
  kode LONGTEXT NULL, nama_barang LONGTEXT NULL, kode_produksi LONGTEXT NULL, batch_no LONGTEXT NULL, shift LONGTEXT NULL,
  kategori_produk LONGTEXT NULL, kategori_masuk LONGTEXT NULL, tujuan_keluar LONGTEXT NULL,
  qty DECIMAL(30,15) NULL, tanggal LONGTEXT NULL, tanggal_produksi LONGTEXT NULL, foto_bukti LONGTEXT NULL,
  pengirim_kurir LONGTEXT NULL, input_by LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_pda_scans_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL,
  awb LONGTEXT NULL, kode_fg LONGTEXT NULL, qty DECIMAL(30,15) NULL, mode LONGTEXT NULL, `date` LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_manifest_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL,
  tanggal LONGTEXT NULL, awb LONGTEXT NULL, sku LONGTEXT NULL, qty DECIMAL(30,15) NULL,
  is_bundle TINYINT(1) NULL, original_bundle_sku LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_stock_opname_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL,
  gudang LONGTEXT NULL, sku LONGTEXT NULL, qty DECIMAL(30,15) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_draft_stock_opname_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL,
  gudang LONGTEXT NULL, sku LONGTEXT NULL, qty DECIMAL(30,15) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_returns_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL,
  id DECIMAL(30,15) NULL, tanggal LONGTEXT NULL, awb LONGTEXT NULL, status_resi LONGTEXT NULL,
  tpl LONGTEXT NULL, sku LONGTEXT NULL, nama_barang LONGTEXT NULL, qty DECIMAL(30,15) NULL, gudang LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_pending_transfers_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL,
  id DECIMAL(30,15) NULL, no_sj LONGTEXT NULL, gudang_asal LONGTEXT NULL, gudang_tujuan LONGTEXT NULL,
  sku LONGTEXT NULL, nama_barang LONGTEXT NULL, kode_produksi LONGTEXT NULL, batch_no LONGTEXT NULL, shift LONGTEXT NULL, kategori_produk LONGTEXT NULL,
  qty_gd DECIMAL(30,15) NULL, qty_gr DECIMAL(30,15) NULL, status LONGTEXT NULL, tanggal LONGTEXT NULL, tanggal_produksi LONGTEXT NULL,
  pengirim_kurir LONGTEXT NULL, created_by LONGTEXT NULL,
  sub_lokasi_asal LONGTEXT NULL, sub_lokasi_tujuan LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_awb_prefix_rules_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, prefix LONGTEXT NULL, name LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_sku_barcode_rules_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL,
  prefix LONGTEXT NULL, sku LONGTEXT NULL,
  sku_start INT NULL, sku_length INT NULL,
  quantity_start INT NULL, quantity_length INT NULL,
  date_start INT NULL, date_length INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_master_barang_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, sku LONGTEXT NULL, nama LONGTEXT NULL,
  barcode LONGTEXT NULL, kategori_produk LONGTEXT NULL, uom LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_bundle_mapping_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, bundle_sku LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_bundle_mapping_items (
  record_order INT UNSIGNED NOT NULL, item_order INT UNSIGNED NOT NULL, sku LONGTEXT NULL,
  qty DECIMAL(30,15) NULL, PRIMARY KEY (record_order, item_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_warehouses_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, nama LONGTEXT NULL, ean LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_uom_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, kode LONGTEXT NULL, nama LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_product_categories_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, `value` LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_incoming_categories_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, `value` LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_outgoing_reasons_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, `value` LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_boms_v2 (
  record_order INT UNSIGNED NOT NULL PRIMARY KEY, record_key TEXT NOT NULL,
  id DECIMAL(30,15) NULL, nama_bom LONGTEXT NULL, sku_hasil LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_bom_items (
  record_order INT UNSIGNED NOT NULL, item_order INT UNSIGNED NOT NULL, sku LONGTEXT NULL,
  qty DECIMAL(30,15) NULL, PRIMARY KEY (record_order, item_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS wms_record_extra_fields (
  state_key VARCHAR(64) NOT NULL, record_order INT UNSIGNED NOT NULL, field_name VARCHAR(128) NOT NULL,
  field_value LONGTEXT NULL, PRIMARY KEY (state_key, record_order, field_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wms_schema_migrations (
  migration_key VARCHAR(100) NOT NULL PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 3. AKUN DEFAULT
--    admin / admin123  -> Superadmin
--    user  / user123   -> Staff Gudang
--    !! GANTI PASSWORD SEGERA SETELAH LOGIN PERTAMA !!
--    Jika username sudah ada, barisnya TIDAK diubah (password lama aman).
-- ---------------------------------------------------------------------
INSERT INTO users (username, name, password_hash, role, crud, allowed_menus, allowed_warehouses) VALUES
('admin', 'Admin Utama', '$2y$10$TLbpco.X0XQSvWFkSnktF.Eg.CAVRciYcBEgCoRNMQhcQk7Hk2pWi', 'superadmin',
 '{"create":true,"read":true,"update":true,"delete":true}',
 '["dashboardView","masterBarangView","inputView","manufakturView","pdaView","rekonView","rekonReturView","cekStokView","transferApprovalView","laporanStokView"]',
 '["ALL"]'),
('user', 'Staff Gudang', '$2y$10$on60fVC1n8cGpvdtnCsTi.teZnBk3PX57mc/ICTU8AtcV6/CPZIze', 'user',
 '{"create":true,"read":true,"update":false,"delete":false}',
 '["dashboardView","inputView","pdaView","rekonView","rekonReturView","cekStokView","transferApprovalView","laporanStokView"]',
 '["ALL"]')
ON DUPLICATE KEY UPDATE username = username;

-- ---------------------------------------------------------------------
-- VERIFIKASI (opsional, jalankan manual jika perlu)
--   SHOW TABLES;
--   SELECT username, name, role FROM users;
--
-- RESET TOTAL (HATI-HATI: MENGHAPUS SEMUA DATA, hilangkan tanda -- untuk menjalankan)
--   -- DROP TABLE IF EXISTS app_state;
--   -- DROP TABLE IF EXISTS users;
-- =====================================================================
