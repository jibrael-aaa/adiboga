<?php
// ==========================================================================
// api.php - Backend WMS Adiboga
// Menyimpan state aplikasi (yang di script.js ada di appState/localStorage)
// ke MySQL, dengan autentikasi session + hak akses per role.
// ==========================================================================
require_once 'config.php';

$action = $_GET['action'] ?? '';
$raw    = file_get_contents('php://input');
$data   = json_decode($raw, true);
if (!is_array($data)) $data = [];

// --------------------------------------------------------------------------
// HELPER RESPON
// --------------------------------------------------------------------------
function respond($payload, $code = 200) {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit();
}
function fail($message, $code = 400, $extra = []) {
    respond(array_merge(["status" => "error", "message" => $message], $extra), $code);
}

// --------------------------------------------------------------------------
// DEFINISI KEY STATE (sesuai appState di script.js)
//   'all'   = semua user yang login (dibatasi izin CRUD untuk transaksi)
//   'super' = hanya superadmin (data master & pengaturan sistem)
// --------------------------------------------------------------------------
const STATE_KEYS = [
    // Data operasional
    'transactions'         => 'all',
    'pdaScans'             => 'all',
    'manifest'             => 'all',
    'stockOpnameData'      => 'all',
    'draftOpnameData'      => 'all',
    'returRecords'         => 'all',
    'pendingTransfers'     => 'all',
    'awbPrefixRules'       => 'all',
    'skuBarcodeRules'      => 'super',
    // Data master & pengaturan
    'masterBarang'         => 'super',
    'bundleMapping'        => 'super',
    'warehouses'           => 'super',
    'uomList'              => 'super',
    'kategoriProduk'       => 'super',
    'kategoriMasukOptions' => 'super',
    'tujuanKeluarOptions'  => 'super',
    'masterBOM'            => 'super',
    'allowNegativeStock'   => 'super',
    'allowBackdate'        => 'super',
    'pdaEcomWarehouse'     => 'super',
    'pdaRequestWarehouse'  => 'super',
    'pdaEcomTujuan'        => 'super',
    'pdaRequestTujuan'     => 'super',
];
const ALL_ROLES = ['superadmin', 'admin', 'user'];
const USER_SESSION_IDLE_TIMEOUT = 180;

// --------------------------------------------------------------------------
// HELPER USER
// --------------------------------------------------------------------------
function decodeCol($v, $default) {
    if ($v === null || $v === '') return $default;
    $d = json_decode($v, true);
    return $d === null ? $default : $d;
}

function normalizeAllowedWarehouses($warehouses) {
    $warehouses = is_array($warehouses)
        ? array_values(array_unique(array_filter($warehouses, 'is_string')))
        : [];
    $specific = array_values(array_filter($warehouses, fn($warehouse) => $warehouse !== 'ALL'));
    return $specific ?: (in_array('ALL', $warehouses, true) ? ['ALL'] : []);
}

function publicUser(array $row) {
    return [
        'username'           => $row['username'],
        'name'               => $row['name'],
        'role'               => $row['role'],
        'crud'               => array_merge([
            'create'=>true, 'read'=>true, 'update'=>false, 'delete'=>false,
            'export'=>true, 'import'=>true, 'pdf'=>true,
            'pda_ecommerce'=>true, 'pda_retur'=>true,
            'transfer_send'=>true, 'transfer_receive'=>true,
        ], decodeCol($row['crud'], [])),
        'allowed_menus'      => decodeCol($row['allowed_menus'], []),
        'allowed_warehouses' => normalizeAllowedWarehouses(decodeCol($row['allowed_warehouses'], ['ALL'])),
        'password'           => '', // hash tidak pernah dikirim ke klien
    ];
}

function loadUserRow(PDO $pdo, $username) {
    $stmt = $pdo->prepare("SELECT * FROM users WHERE username = ?");
    $stmt->execute([$username]);
    return $stmt->fetch() ?: null;
}

function isSuper($u) {
    return $u && ($u['role'] ?? '') === 'superadmin';
}

function currentSessionHash() {
    return hash('sha256', session_id());
}

function claimUserSession(PDO $pdo, $username, $sessionHash, $previousSessionHash = null) {
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("SELECT session_hash, last_seen,
                                      (last_seen >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL " . USER_SESSION_IDLE_TIMEOUT . " SECOND)) AS is_active
                               FROM user_sessions WHERE username = ? FOR UPDATE");
        $stmt->execute([$username]);
        $active = $stmt->fetch();
        if ($active &&
            !hash_equals($active['session_hash'], $sessionHash) &&
            ($previousSessionHash === null || !hash_equals($active['session_hash'], $previousSessionHash)) &&
            !empty($active['is_active'])) {
            $pdo->rollBack();
            return false;
        }

        $stmt = $pdo->prepare("INSERT INTO user_sessions (username, session_hash, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP)
                               ON DUPLICATE KEY UPDATE session_hash = VALUES(session_hash), last_seen = CURRENT_TIMESTAMP");
        $stmt->execute([$username, $sessionHash]);
        $pdo->commit();
        return true;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

function validateUserSession(PDO $pdo, $username) {
    $sessionHash = currentSessionHash();
    $stmt = $pdo->prepare("SELECT session_hash FROM user_sessions WHERE username = ?");
    $stmt->execute([$username]);
    $active = $stmt->fetch();

    if (!$active) {
        $stmt = $pdo->prepare("INSERT IGNORE INTO user_sessions (username, session_hash, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP)");
        $stmt->execute([$username, $sessionHash]);
        $stmt = $pdo->prepare("SELECT session_hash FROM user_sessions WHERE username = ?");
        $stmt->execute([$username]);
        $active = $stmt->fetch();
    }

    if (!$active || !hash_equals($active['session_hash'], $sessionHash)) return false;
    $stmt = $pdo->prepare("UPDATE user_sessions SET last_seen = CURRENT_TIMESTAMP WHERE username = ? AND session_hash = ?");
    $stmt->execute([$username, $sessionHash]);
    $stmt = $pdo->prepare("SELECT session_hash FROM user_sessions WHERE username = ?");
    $stmt->execute([$username]);
    $active = $stmt->fetch();
    return $active && hash_equals($active['session_hash'], $sessionHash);
}

function canAccessWarehouseForUser(array $user, $warehouse) {
    if (isSuper($user)) return true;
    $allowed = decodeCol($user['allowed_warehouses'] ?? null, ['ALL']);
    return in_array('ALL', $allowed, true) || in_array($warehouse, $allowed, true);
}

function hasUserFeature(array $user, $feature) {
    $crud = decodeCol($user['crud'] ?? null, []);
    return !array_key_exists($feature, $crud) || !empty($crud[$feature]);
}

function checkPendingTransfersPermission(array $old, array $new, array $user) {
    if (isSuper($user)) return null;

    $oldById = [];
    foreach ($old as $transfer) {
        if (!is_array($transfer) || !array_key_exists('id', $transfer)) continue;
        $oldById[json_encode($transfer['id'])] = $transfer;
    }

    $newById = [];
    foreach ($new as $transfer) {
        if (!is_array($transfer) || !array_key_exists('id', $transfer)) {
            return "Data transfer tidak valid.";
        }
        $id = json_encode($transfer['id']);
        if (isset($newById[$id])) return "ID transfer duplikat.";
        $newById[$id] = $transfer;
    }

    foreach ($oldById as $id => $previous) {
        if (!isset($newById[$id])) return "Transfer yang sudah tercatat tidak boleh dihapus.";
        $updated = $newById[$id];
        if ($updated == $previous) continue;

        $expected = $previous;
        $expected['qty_gr'] = $previous['qty_gd'] ?? null;
        $expected['status'] = 'COMPLETED';
        $crud = decodeCol($user['crud'] ?? null, []);
        if (($previous['status'] ?? '') !== 'PENDING GR' ||
            $updated != $expected ||
            empty($crud['create']) ||
            !canAccessWarehouseForUser($user, $previous['gudang_tujuan'] ?? '') ||
            !hasUserFeature($user, 'transfer_receive')) {
            return "Akses ditolak: transfer hanya dapat diterima oleh pengguna berizin di gudang tujuan.";
        }
    }

    foreach ($newById as $id => $transfer) {
        if (isset($oldById[$id])) continue;
        $crud = decodeCol($user['crud'] ?? null, []);
        $source = $transfer['gudang_asal'] ?? '';
        $target = $transfer['gudang_tujuan'] ?? '';
        $qty = $transfer['qty_gd'] ?? null;
        if (empty($crud['create']) ||
            !hasUserFeature($user, 'transfer_send') ||
            ($transfer['status'] ?? '') !== 'PENDING GR' ||
            $source === '' || $target === '' || $source === $target ||
            !canAccessWarehouseForUser($user, $source) ||
            !canAccessWarehouseForUser($user, $target) ||
            !is_numeric($qty) || (float)$qty <= 0 ||
            !is_numeric($transfer['qty_gr'] ?? null) || (float)$transfer['qty_gr'] !== 0.0) {
            return "Akses ditolak atau data Good Delivery tidak valid.";
        }
    }

    return null;
}

// --------------------------------------------------------------------------
// HELPER STATE
// --------------------------------------------------------------------------
function isSettingStateKey($key) {
    return in_array($key, [
        'allowNegativeStock', 'allowBackdate', 'pdaEcomWarehouse', 'pdaRequestWarehouse',
        'pdaEcomTujuan', 'pdaRequestTujuan'
    ], true);
}

function ensureStateMetaRow(PDO $pdo, $key) {
    $stmt = $pdo->prepare("INSERT IGNORE INTO wms_state_meta (state_key, root_type, revision, initialized) VALUES (?, 'array', 0, 0)");
    $stmt->execute([$key]);
}

function settingColumnForStateKey($key) {
    $columns = [
        'allowNegativeStock' => 'allow_negative_stock',
        'allowBackdate' => 'allow_backdate',
        'pdaEcomWarehouse' => 'pda_ecom_warehouse',
        'pdaRequestWarehouse' => 'pda_request_warehouse',
        'pdaEcomTujuan' => 'pda_ecom_tujuan',
        'pdaRequestTujuan' => 'pda_request_tujuan',
    ];
    return $columns[$key] ?? null;
}

function stateChildTable($key) {
    return [
        'bundleMapping' => 'wms_bundle_mapping_items',
        'masterBOM' => 'wms_bom_items',
    ][$key] ?? null;
}

function stateRecordFromRow($key, array $row, array $extras = [], array $items = []) {
    $columns = wms_state_columns()[$key];
    $record = [];
    foreach ($columns as $field => $definition) {
        if (!array_key_exists($field, $row) || $row[$field] === null) continue;
        if (strpos($definition, 'DECIMAL') === 0) {
            $record[$field] = json_decode((string)$row[$field], true);
        } elseif ($field === 'is_bundle') {
            $record[$field] = (bool)$row[$field];
        } else {
            $record[$field] = $row[$field];
        }
    }

    foreach ($extras as $extra) $record[$extra['field_name']] = json_decode($extra['field_value'], true);
    if (stateChildTable($key) !== null) $record['items'] = $items;

    if ($key === 'stockOpnameData' || $key === 'draftOpnameData') {
        return $row['qty'] === null ? null : json_decode((string)$row['qty'], true);
    }
    if (isset($columns['value'])) return $record['value'] ?? null;
    return $record;
}

function stateReadRaw(PDO $pdo, $key) {
    $stmt = $pdo->prepare("SELECT root_type, revision, initialized FROM wms_state_meta WHERE state_key = ?");
    $stmt->execute([$key]);
    $row = $stmt->fetch();
    if (!$row || !(int)$row['initialized']) return [null, $row ? (int)$row['revision'] : 0];

    if (isSettingStateKey($key)) {
        $column = settingColumnForStateKey($key);
        $value = $pdo->query("SELECT `$column` FROM wms_app_settings WHERE setting_id = 1")->fetchColumn();
        if ($value === false || $value === null) return [null, (int)$row['revision']];
        if ($key === 'allowNegativeStock' || $key === 'allowBackdate') $value = (bool)$value;
        return [json_encode($value, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR), (int)$row['revision']];
    }

    $table = wms_state_tables()[$key] ?? null;
    if ($table === null) return [null, (int)$row['revision']];
    $stmt = $pdo->query("SELECT * FROM `$table` ORDER BY record_order ASC");
    $rows = $stmt->fetchAll();
    $extrasByOrder = [];
    $stmt = $pdo->prepare("SELECT record_order, field_name, field_value FROM wms_record_extra_fields
                           WHERE state_key = ? ORDER BY record_order, field_name");
    $stmt->execute([$key]);
    foreach ($stmt->fetchAll() as $extra) $extrasByOrder[(int)$extra['record_order']][] = $extra;

    $itemsByOrder = [];
    $childTable = stateChildTable($key);
    if ($childTable !== null) {
        $stmt = $pdo->query("SELECT record_order, sku, qty FROM `$childTable` ORDER BY record_order, item_order");
        foreach ($stmt->fetchAll() as $item) {
            $itemsByOrder[(int)$item['record_order']][] = [
                'sku' => $item['sku'],
                'qty' => $item['qty'] === null ? null : json_decode((string)$item['qty'], true),
            ];
        }
    }

    $readRecord = function ($record) use ($key, $extrasByOrder, $itemsByOrder) {
        $order = (int)$record['record_order'];
        return stateRecordFromRow($key, $record, $extrasByOrder[$order] ?? [], $itemsByOrder[$order] ?? []);
    };

    if ($row['root_type'] === 'scalar') {
        if (!$rows) return [null, (int)$row['revision']];
        $value = $readRecord($rows[0]);
        return [json_encode($value, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR), (int)$row['revision']];
    }
    if ($row['root_type'] === 'object') {
        $properties = [];
        foreach ($rows as $record) {
            $value = $readRecord($record);
            $properties[] = json_encode($record['record_key'], JSON_UNESCAPED_UNICODE) . ':' .
                json_encode($value, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
        }
        return ['{' . implode(',', $properties) . '}', (int)$row['revision']];
    }

    $values = [];
    foreach ($rows as $record) {
        $values[] = json_encode($readRecord($record), JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    }
    return ['[' . implode(',', $values) . ']', (int)$row['revision']];
}

function stateRead(PDO $pdo, $key) {
    [$json, $revision] = stateReadRaw($pdo, $key);
    return [$json === null ? null : json_decode($json, true), $revision];
}

function stateWriteRaw(PDO $pdo, $key, $jsonString, $by, $revision = null) {
    ensureStateMetaRow($pdo, $key);
    $stmt = $pdo->prepare("SELECT revision FROM wms_state_meta WHERE state_key = ? FOR UPDATE");
    $stmt->execute([$key]);
    $currentRevision = (int)$stmt->fetchColumn();
    $newRevision = $revision === null ? $currentRevision + 1 : (int)$revision;

    if (isSettingStateKey($key)) {
        $column = settingColumnForStateKey($key);
        $value = json_decode($jsonString, true);
        if ($key === 'allowNegativeStock' || $key === 'allowBackdate') $value = $value ? 1 : 0;
        $pdo->exec("INSERT IGNORE INTO wms_app_settings (setting_id) VALUES (1)");
        $stmt = $pdo->prepare("UPDATE wms_app_settings SET `$column` = ? WHERE setting_id = 1");
        $stmt->execute([$value]);
        $rootType = 'scalar';
    } else {
        $table = wms_state_tables()[$key] ?? null;
        if ($table === null) throw new InvalidArgumentException("Storage table for state '$key' is not configured.");
        $decoded = json_decode($jsonString);
        if (json_last_error() !== JSON_ERROR_NONE) throw new InvalidArgumentException("Invalid JSON for state '$key'.");
        $isList = is_array($decoded);
        $rows = [];
        if ($isList) {
            $rootType = 'array';
            foreach ($decoded as $index => $value) {
                $rows[] = [(int)$index, (string)$index, $value];
            }
        } elseif (is_object($decoded)) {
            $rootType = 'object';
            foreach ($decoded as $property => $value) {
                $rows[] = [count($rows), (string)$property, $value];
            }
        } else {
            $rootType = 'scalar';
            $rows[] = [0, '__value', $decoded];
        }

        $pdo->exec("DELETE FROM `$table`");
        $stmt = $pdo->prepare("DELETE FROM wms_record_extra_fields WHERE state_key = ?");
        $stmt->execute([$key]);
        $childTable = stateChildTable($key);
        if ($childTable !== null) $pdo->exec("DELETE FROM `$childTable`");
        $columns = wms_state_columns()[$key];
        $fieldNames = array_keys($columns);
        $insertColumns = array_merge(['record_order', 'record_key'], $fieldNames);
        $placeholders = implode(',', array_fill(0, count($insertColumns), '?'));
        $quotedColumns = implode(',', array_map(function ($name) { return "`$name`"; }, $insertColumns));
        $insert = $pdo->prepare("INSERT INTO `$table` ($quotedColumns) VALUES ($placeholders)");
        $extraInsert = $pdo->prepare("INSERT INTO wms_record_extra_fields (state_key, record_order, field_name, field_value) VALUES (?, ?, ?, ?)");
        $childTable = stateChildTable($key);
        $childInsert = $childTable === null ? null : $pdo->prepare("INSERT INTO `$childTable` (record_order, item_order, sku, qty) VALUES (?, ?, ?, ?)");

        foreach ($rows as $row) {
            [$order, $recordKey, $value] = $row;
            $record = is_object($value) ? get_object_vars($value) : [];
            if ($rootType === 'scalar' || !is_object($value)) {
                if (isset($columns['value'])) $record['value'] = $value;
                elseif ($key === 'stockOpnameData' || $key === 'draftOpnameData') {
                    $parts = explode('::', (string)$recordKey, 2);
                    $record['gudang'] = count($parts) === 2 ? $parts[0] : null;
                    $record['sku'] = count($parts) === 2 ? $parts[1] : (string)$recordKey;
                    $record['qty'] = $value;
                } else {
                    $record['__value'] = $value;
                }
            }

            $sqlValues = [$order, (string)$recordKey];
            foreach ($fieldNames as $field) {
                $fieldValue = $record[$field] ?? null;
                if ($fieldValue === null) {
                    $sqlValues[] = null;
                } elseif ($field === 'is_bundle') {
                    $sqlValues[] = $fieldValue ? 1 : 0;
                } elseif (strpos($columns[$field], 'DECIMAL') === 0) {
                    $sqlValues[] = is_numeric($fieldValue)
                        ? (is_int($fieldValue) || is_float($fieldValue) ? json_encode($fieldValue) : (string)$fieldValue)
                        : null;
                } elseif (is_scalar($fieldValue)) {
                    $sqlValues[] = (string)$fieldValue;
                } else {
                    $sqlValues[] = null;
                }
            }
            $insert->execute($sqlValues);

            foreach ($record as $field => $fieldValue) {
                if ($field === 'items' || array_key_exists($field, $columns) || $field === '__value') continue;
                $extraInsert->execute([$key, $order, $field, json_encode($fieldValue, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR)]);
            }

            if ($childInsert !== null && isset($record['items']) && is_array($record['items'])) {
                foreach ($record['items'] as $itemOrder => $item) {
                    if (!is_object($item)) continue;
                    $qty = isset($item->qty) && is_numeric($item->qty)
                        ? (is_int($item->qty) || is_float($item->qty) ? json_encode($item->qty) : (string)$item->qty)
                        : null;
                    $childInsert->execute([$order, $itemOrder, $item->sku ?? null, $qty]);
                }
            }
        }
    }

    $stmt = $pdo->prepare("UPDATE wms_state_meta
                           SET root_type = ?, revision = ?, initialized = 1, updated_by = ?
                           WHERE state_key = ?");
    $stmt->execute([$rootType, $newRevision, $by, $key]);
    return $newRevision;
}

function migrateLegacyAppState(PDO $pdo) {
    $migrationKey = 'app_state_to_domain_tables_v1';
    $stmt = $pdo->prepare("SELECT 1 FROM wms_schema_migrations WHERE migration_key = ?");
    $stmt->execute([$migrationKey]);
    if ($stmt->fetchColumn()) return;

    try {
        $legacyRows = $pdo->query("SELECT state_key, state_value, revision, updated_by FROM app_state")->fetchAll();
    } catch (PDOException $e) {
        if ($e->getCode() !== '42S02') throw $e;
        $legacyRows = [];
    }

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("INSERT IGNORE INTO wms_schema_migrations (migration_key) VALUES (?)");
        $stmt->execute([$migrationKey]);
        if ($stmt->rowCount() === 0) {
            $pdo->commit();
            return;
        }

        foreach ($legacyRows as $legacy) {
            $key = $legacy['state_key'];
            if (!array_key_exists($key, STATE_KEYS)) continue;
            ensureStateMetaRow($pdo, $key);
            $stmt = $pdo->prepare("SELECT initialized FROM wms_state_meta WHERE state_key = ? FOR UPDATE");
            $stmt->execute([$key]);
            if ((int)$stmt->fetchColumn()) continue;
            stateWriteRaw($pdo, $key, $legacy['state_value'], $legacy['updated_by'], (int)$legacy['revision']);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

function migrateLegacyDomainTables(PDO $pdo) {
    $migrationKey = 'domain_records_to_columns_v2';
    $stmt = $pdo->prepare("SELECT 1 FROM wms_schema_migrations WHERE migration_key = ?");
    $stmt->execute([$migrationKey]);
    if ($stmt->fetchColumn()) return;

    $legacy = [];
    foreach (wms_state_tables() as $key => $table) {
        $legacyTable = preg_replace('/_v2$/', '', $table);
        $stmt = $pdo->prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?");
        $stmt->execute([$legacyTable]);
        if (!$stmt->fetchColumn()) continue;

        $stmt = $pdo->prepare("SELECT root_type, revision, initialized, updated_by FROM wms_state_meta WHERE state_key = ?");
        $stmt->execute([$key]);
        $meta = $stmt->fetch();
        if (!$meta || !(int)$meta['initialized']) continue;
        $rows = $pdo->query("SELECT record_key, record_value FROM `$legacyTable` ORDER BY record_order ASC")->fetchAll();
        if ($meta['root_type'] === 'scalar') {
            $json = $rows[0]['record_value'] ?? null;
        } elseif ($meta['root_type'] === 'object') {
            $properties = [];
            foreach ($rows as $record) {
                $properties[] = json_encode($record['record_key'], JSON_UNESCAPED_UNICODE) . ':' . $record['record_value'];
            }
            $json = '{' . implode(',', $properties) . '}';
        } else {
            $json = '[' . implode(',', array_column($rows, 'record_value')) . ']';
        }
        if ($json !== null) {
            $legacy[$key] = [$json, (int)$meta['revision'], $meta['updated_by']];
        }
    }
    foreach (['allowNegativeStock', 'allowBackdate', 'pdaEcomWarehouse', 'pdaRequestWarehouse', 'pdaEcomTujuan', 'pdaRequestTujuan'] as $key) {
        $stmt = $pdo->prepare("SELECT root_type, revision, initialized, updated_by FROM wms_state_meta WHERE state_key = ?");
        $stmt->execute([$key]);
        $meta = $stmt->fetch();
        if (!$meta || !(int)$meta['initialized']) continue;
        $stmt = $pdo->prepare("SELECT setting_value FROM wms_settings WHERE state_key = ?");
        $stmt->execute([$key]);
        $json = $stmt->fetchColumn();
        if ($json !== false) $legacy[$key] = [$json, (int)$meta['revision'], $meta['updated_by']];
    }

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("INSERT IGNORE INTO wms_schema_migrations (migration_key) VALUES (?)");
        $stmt->execute([$migrationKey]);
        if ($stmt->rowCount() === 0) {
            $pdo->commit();
            return;
        }
        foreach ($legacy as $key => [$json, $revision, $updatedBy]) {
            stateWriteRaw($pdo, $key, $json, $updatedBy, $revision);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

// Validasi tipe nilai per key
function validateStateValue($key, $decoded) {
    $boolKeys   = ['allowNegativeStock', 'allowBackdate'];
    $stringKeys = ['pdaEcomWarehouse', 'pdaRequestWarehouse', 'pdaEcomTujuan', 'pdaRequestTujuan'];
    if (in_array($key, $boolKeys, true))   return is_bool($decoded);
    if (in_array($key, $stringKeys, true)) return is_string($decoded);
    return is_array($decoded); // list atau objek
}

// Cek izin CRUD untuk perubahan array transaksi (create/update/delete)
function checkTransactionsPermission(array $old, array $new, array $user) {
    if (isSuper($user)) return null;
    $crud = decodeCol($user['crud'], []);
    $canCreate = !empty($crud['create']);
    $canUpdate = !empty($crud['update']);
    $canDelete = !empty($crud['delete']);

    $map = function ($list) {
        $m = [];
        foreach ($list as $item) {
            if (is_array($item) && isset($item['id'])) $m[json_encode($item['id'])] = json_encode($item);
        }
        return $m;
    };
    $oldMap = $map($old);
    $newMap = $map($new);

    foreach ($oldMap as $id => $json) {
        if (!isset($newMap[$id])) {
            if (!$canDelete) return "Akses ditolak: izin [Delete] diperlukan untuk menghapus transaksi.";
        } elseif ($newMap[$id] !== $json) {
            if (!$canUpdate) return "Akses ditolak: izin [Update] diperlukan untuk mengubah transaksi.";
        }
    }
    foreach ($newMap as $id => $json) {
        if (!isset($oldMap[$id]) && !$canCreate) {
            return "Akses ditolak: izin [Create] diperlukan untuk membuat transaksi.";
        }
    }
    return null;
}

try {
    migrateLegacyAppState($pdo);
    migrateLegacyDomainTables($pdo);
} catch (Throwable $e) {
    error_log("Gagal memigrasikan data ke tabel domain terstruktur: " . $e->getMessage());
    fail("Gagal menyiapkan penyimpanan tabel terstruktur. Data lama tetap dipertahankan.", 500);
}

// --------------------------------------------------------------------------
// AUTENTIKASI GLOBAL
// --------------------------------------------------------------------------
$public_actions = ['login', 'check_session', 'logout'];
$currentUser = null;

if (!empty($_SESSION['username'])) {
    try {
        $currentUser = loadUserRow($pdo, $_SESSION['username']);
        if ($currentUser && !validateUserSession($pdo, $currentUser['username'])) {
            $currentUser = null;
            $_SESSION = [];
        }
    } catch (PDOException $e) {
        error_log($e->getMessage());
        $currentUser = null;
    }
    if (!$currentUser) { // akun sudah dihapus
        $_SESSION = [];
    }
}

if (!in_array($action, $public_actions, true) && !$currentUser) {
    fail("Akses ditolak. Silakan login terlebih dahulu.", 401);
}

// --------------------------------------------------------------------------
// ROUTER
// --------------------------------------------------------------------------
try {
switch ($action) {

    // ---------------- AUTH ----------------
    case 'login':
        $username = strtolower(trim($data['username'] ?? ''));
        $password = (string)($data['password'] ?? '');

        // Pembatasan percobaan login (5x / 5 menit per session)
        $now = time();
        if (($_SESSION['login_fail'] ?? 0) >= 5 && ($now - ($_SESSION['login_fail_at'] ?? 0)) < 300) {
            fail("Terlalu banyak percobaan login. Coba lagi dalam beberapa menit.", 429);
        }

        $row = $username !== '' ? loadUserRow($pdo, $username) : null;
        if ($row && password_verify($password, $row['password_hash'])) {
            $previousSessionHash = currentSessionHash();
            session_regenerate_id(true);
            if (!claimUserSession($pdo, $row['username'], currentSessionHash(), $previousSessionHash)) {
                fail("Akun ini sedang digunakan di perangkat lain. Coba lagi setelah sesi tersebut logout atau tidak aktif selama 3 menit.", 409);
            }
            $_SESSION = ['username' => $row['username']];
            if (password_needs_rehash($row['password_hash'], PASSWORD_DEFAULT)) {
                $pdo->prepare("UPDATE users SET password_hash = ? WHERE username = ?")
                    ->execute([password_hash($password, PASSWORD_DEFAULT), $row['username']]);
            }
            respond(["status" => "success", "user" => publicUser($row)]);
        }
        $_SESSION['login_fail']    = ($_SESSION['login_fail'] ?? 0) + 1;
        $_SESSION['login_fail_at'] = $now;
        fail("Username atau password salah!", 401);
        break;

    case 'logout':
        if (!empty($_SESSION['username'])) {
            $stmt = $pdo->prepare("DELETE FROM user_sessions WHERE username = ? AND session_hash = ?");
            $stmt->execute([$_SESSION['username'], currentSessionHash()]);
        }
        $_SESSION = [];
        if (ini_get("session.use_cookies")) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $p["path"], $p["domain"], $p["secure"], $p["httponly"]);
        }
        session_destroy();
        respond(["status" => "success", "message" => "Berhasil logout."]);
        break;

    case 'check_session':
        if ($currentUser) respond(["status" => "success", "user" => publicUser($currentUser)]);
        respond(["status" => "unauthenticated"]);
        break;

    // ---------------- STATE (SELURUH DATA APLIKASI) ----------------
    case 'get_state':
        $state = [];
        $revisions = [];
        foreach (STATE_KEYS as $key => $access) {
            [$value, $revision] = stateReadRaw($pdo, $key);
            if ($value === null) continue;
            $state[$key] = $value;
            $revisions[$key] = $revision;
        }
        if (isSuper($currentUser)) {
            $users = array_map('publicUser', $pdo->query("SELECT * FROM users ORDER BY created_at ASC, username ASC")->fetchAll());
        } else {
            $users = [publicUser($currentUser)];
        }
        respond(["status" => "success", "user" => publicUser($currentUser), "state" => $state, "revisions" => $revisions, "users" => $users]);
        break;

    case 'save_state':
        $changes = $data['changes'] ?? null;
        $revs    = $data['revisions'] ?? [];
        if (!is_array($changes) || empty($changes)) fail("Tidak ada perubahan untuk disimpan.");
        if (!is_array($revs)) $revs = [];

        // Validasi key, izin, dan tipe sebelum menyentuh DB
        $decodedMap = [];
        foreach ($changes as $key => $jsonString) {
            if (!array_key_exists($key, STATE_KEYS)) fail("Key data tidak dikenal: " . $key);
            if (STATE_KEYS[$key] === 'super' && !isSuper($currentUser)) {
                fail("Akses ditolak. Role Super Admin diperlukan untuk mengubah data '$key'.", 403);
            }
            if (!is_string($jsonString)) fail("Format data '$key' tidak valid.");
            $decoded = json_decode($jsonString, true);
            if ($decoded === null && trim($jsonString) !== 'null') fail("JSON data '$key' tidak valid.");
            if (!validateStateValue($key, $decoded)) fail("Tipe data '$key' tidak valid.");
            $decodedMap[$key] = $decoded;
        }

        $pdo->beginTransaction();
        $conflicts = [];
        $newRevs = [];
        foreach ($changes as $key => $jsonString) {
            ensureStateMetaRow($pdo, $key);
            $stmt = $pdo->prepare("SELECT revision FROM wms_state_meta WHERE state_key = ? FOR UPDATE");
            $stmt->execute([$key]);
            $serverRev = (int)$stmt->fetchColumn();
            $clientRev = (int)($revs[$key] ?? 0);
            if ($clientRev !== $serverRev) { $conflicts[] = $key; continue; }

            [$oldJson] = stateReadRaw($pdo, $key);
            $old = $oldJson === null ? [] : (json_decode($oldJson, true) ?: []);
            if ($key === 'transactions') {
                $err = checkTransactionsPermission($old, $decodedMap[$key], $currentUser);
                if ($err) { $pdo->rollBack(); fail($err, 403); }
            }
            if ($key === 'pendingTransfers') {
                $err = checkPendingTransfersPermission($old, $decodedMap[$key], $currentUser);
                if ($err) { $pdo->rollBack(); fail($err, 403); }
            }
        }
        if (!empty($conflicts)) {
            $pdo->rollBack();
            fail("Data telah diubah oleh pengguna lain. Data akan dimuat ulang.", 409, ["conflicts" => $conflicts]);
        }
        foreach ($changes as $key => $jsonString) {
            $newRevs[$key] = stateWriteRaw($pdo, $key, $jsonString, $currentUser['username'], (int)($revs[$key] ?? 0) + 1);
        }
        $pdo->commit();
        respond(["status" => "success", "revisions" => $newRevs]);
        break;

    // ---------------- USER MANAGEMENT (Master Akun) ----------------
    case 'save_users':
        if (!isSuper($currentUser)) fail("Akses ditolak. Role Super Admin diperlukan.", 403);
        $incoming = $data['users'] ?? null;
        if (!is_array($incoming)) fail("Data user tidak valid.");

        $existing = [];
        foreach ($pdo->query("SELECT * FROM users")->fetchAll() as $r) $existing[$r['username']] = $r;

        $final = [];      // username baru => data siap simpan
        $renameMap = [];  // username lama => username baru
        foreach ($incoming as $u) {
            if (!is_array($u)) fail("Data user tidak valid.");
            $username = strtolower(trim($u['username'] ?? ''));
            $name     = trim($u['name'] ?? '');
            $role     = $u['role'] ?? 'user';
            if (!preg_match('/^[a-z0-9_.\-]{1,64}$/', $username)) fail("Username '$username' tidak valid (huruf kecil, angka, . _ - maksimal 64 karakter).");
            if ($name === '') fail("Nama pengguna tidak boleh kosong.");
            if (!in_array($role, ALL_ROLES, true)) fail("Role tidak valid.");
            if (isset($final[$username])) fail("Username '$username' duplikat.");

            $crudIn = is_array($u['crud'] ?? null) ? $u['crud'] : [];
            $crud = [
                'create' => !empty($crudIn['create']),
                'read'   => !empty($crudIn['read']),
                'update' => !empty($crudIn['update']),
                'delete' => !empty($crudIn['delete']),
                'export' => array_key_exists('export', $crudIn) ? !empty($crudIn['export']) : true,
                'import' => array_key_exists('import', $crudIn) ? !empty($crudIn['import']) : true,
                'pdf' => array_key_exists('pdf', $crudIn) ? !empty($crudIn['pdf']) : true,
                'pda_ecommerce' => array_key_exists('pda_ecommerce', $crudIn) ? !empty($crudIn['pda_ecommerce']) : true,
                'pda_retur' => array_key_exists('pda_retur', $crudIn) ? !empty($crudIn['pda_retur']) : true,
                'transfer_send' => array_key_exists('transfer_send', $crudIn) ? !empty($crudIn['transfer_send']) : true,
                'transfer_receive' => array_key_exists('transfer_receive', $crudIn) ? !empty($crudIn['transfer_receive']) : true,
            ];
            $menus = array_values(array_filter(is_array($u['allowed_menus'] ?? null) ? $u['allowed_menus'] : [], 'is_string'));
            $whs   = normalizeAllowedWarehouses($u['allowed_warehouses'] ?? []);

            // Tentukan password hash
            $plain = (string)($u['password'] ?? '');
            $oldName = strtolower(trim($u['old_username'] ?? $username));
            if ($plain !== '') {
                $hash = password_hash($plain, PASSWORD_DEFAULT);
            } elseif (isset($existing[$oldName])) {
                $hash = $existing[$oldName]['password_hash'];
            } elseif (isset($existing[$username])) {
                $hash = $existing[$username]['password_hash'];
            } else {
                fail("Password wajib diisi untuk akun baru '$username'.");
            }
            if ($oldName !== $username && isset($existing[$oldName])) $renameMap[$oldName] = $username;

            $final[$username] = [$name, $hash, $role, json_encode($crud), json_encode($menus), json_encode($whs)];
        }

        if (!isset($final['admin'])) fail("Akun 'admin' utama tidak dapat dihapus.");
        if ($final['admin'][2] !== 'superadmin') fail("Akun 'admin' utama harus tetap berperan Superadmin.");

        $pdo->beginTransaction();
        $keep = array_keys($final);
        // Hapus akun yang tidak ada lagi (dan bukan hasil rename)
        foreach (array_keys($existing) as $oldUser) {
            if (!in_array($oldUser, $keep, true)) {
                $pdo->prepare("DELETE FROM users WHERE username = ?")->execute([$oldUser]);
            }
        }
        foreach ($final as $username => $f) {
            $stmt = $pdo->prepare("INSERT INTO users (username, name, password_hash, role, crud, allowed_menus, allowed_warehouses)
                                   VALUES (?,?,?,?,?,?,?)
                                   ON DUPLICATE KEY UPDATE name=VALUES(name), password_hash=VALUES(password_hash), role=VALUES(role),
                                   crud=VALUES(crud), allowed_menus=VALUES(allowed_menus), allowed_warehouses=VALUES(allowed_warehouses)");
            $stmt->execute([$username, $f[0], $f[1], $f[2], $f[3], $f[4], $f[5]]);
        }
        $pdo->commit();

        // Jika akun yang sedang login di-rename, perbarui session
        if (isset($renameMap[$_SESSION['username']])) $_SESSION['username'] = $renameMap[$_SESSION['username']];

        $users = array_map('publicUser', $pdo->query("SELECT * FROM users ORDER BY created_at ASC, username ASC")->fetchAll());
        respond(["status" => "success", "users" => $users, "user" => publicUser(loadUserRow($pdo, $_SESSION['username']))]);
        break;

    // ---------------- LOKASI GUDANG (CRUD; kompatibel dengan api lama) ----------------
    // Disimpan di state 'warehouses' (format: [{nama, ean}]). id = nomor urut (mulai 1).
    case 'get_gudang':
        [$wh] = stateRead($pdo, 'warehouses');
        $out = [];
        foreach ((array)$wh as $i => $w) {
            $out[] = ['id' => $i + 1, 'nama' => $w['nama'] ?? '', 'ean' => $w['ean'] ?? '-'];
        }
        usort($out, fn($a, $b) => strcasecmp($a['nama'], $b['nama']));
        respond($out);
        break;

    case 'add_gudang':
    case 'update_gudang':
    case 'delete_gudang':
        if (!isSuper($currentUser)) fail("Akses ditolak. Role Super Admin diperlukan.", 403);
        $pdo->beginTransaction();
        ensureStateMetaRow($pdo, 'warehouses');
        $stmt = $pdo->prepare("SELECT revision FROM wms_state_meta WHERE state_key = 'warehouses' FOR UPDATE");
        $stmt->execute();
        $warehouseRevision = (int)$stmt->fetchColumn();
        [$cur] = stateReadRaw($pdo, 'warehouses');
        $list = $cur === null ? [] : (json_decode($cur, true) ?: []);

        if ($action === 'add_gudang') {
            $nama = trim($data['nama'] ?? '');
            if ($nama === '') { $pdo->rollBack(); fail("Nama gudang tidak boleh kosong."); }
            foreach ($list as $w) if (strcasecmp($w['nama'] ?? '', $nama) === 0) { $pdo->rollBack(); fail("Nama lokasi gudang sudah terdaftar!"); }
            $list[] = ['nama' => $nama, 'ean' => trim($data['ean'] ?? '') ?: '-'];
            $msg = "Gudang berhasil ditambahkan.";
            $newId = count($list);
        } else {
            $idx = (int)($data['id'] ?? 0) - 1;
            if (!isset($list[$idx])) { $pdo->rollBack(); fail("Data tidak ditemukan.", 404); }
            if ($action === 'update_gudang') {
                $nama = trim($data['nama'] ?? '');
                if ($nama === '') { $pdo->rollBack(); fail("ID dan Nama gudang diperlukan."); }
                foreach ($list as $i => $w) if ($i !== $idx && strcasecmp($w['nama'] ?? '', $nama) === 0) { $pdo->rollBack(); fail("Nama lokasi gudang sudah terdaftar!"); }
                $list[$idx]['nama'] = $nama;
                if (isset($data['ean'])) $list[$idx]['ean'] = trim($data['ean']) ?: '-';
                $msg = "Gudang berhasil diperbarui.";
            } else {
                // Cek penggunaan di transaksi
                [$trx] = stateRead($pdo, 'transactions');
                foreach ((array)$trx as $t) {
                    if (($t['gudang'] ?? null) === ($list[$idx]['nama'] ?? '')) {
                        $pdo->rollBack();
                        fail("Gagal menghapus data. Pastikan gudang tidak sedang digunakan dalam transaksi.", 409);
                    }
                }
                array_splice($list, $idx, 1);
                $msg = "Gudang berhasil dihapus.";
            }
        }
        stateWriteRaw($pdo, 'warehouses', json_encode(array_values($list), JSON_UNESCAPED_UNICODE), $currentUser['username'], $warehouseRevision + 1);
        $pdo->commit();
        $resp = ["status" => "success", "message" => $msg];
        if (isset($newId)) $resp['id'] = $newId;
        respond($resp);
        break;

    // ---------------- TRANSAKSI (baca) ----------------
    case 'get_transaksi':
        [$trx] = stateRead($pdo, 'transactions');
        $trx = is_array($trx) ? $trx : [];
        $allowedWH = decodeCol($currentUser['allowed_warehouses'], ['ALL']);
        $out = [];
        foreach (array_reverse($trx) as $t) {
            if (!isSuper($currentUser) && !in_array('ALL', $allowedWH, true) && !in_array($t['gudang'] ?? '', $allowedWH, true)) continue;
            $t['nama_gudang'] = $t['gudang'] ?? null;
            $out[] = $t;
        }
        respond($out);
        break;

    // ---------------- HANDOFF CETAK SURAT JALAN (pengganti localStorage 'print_sj_data') ----------------
    // Payload disimpan di session milik user yang login; tab surat_jalan.html mengambilnya dengan token sekali pakai.
    case 'save_print':
        $payload = $data['payload'] ?? null;
        if (!is_array($payload)) fail("Data cetak tidak valid.");
        $now   = time();
        $queue = (isset($_SESSION['print_queue']) && is_array($_SESSION['print_queue'])) ? $_SESSION['print_queue'] : [];
        // Buang yang kedaluwarsa (> 10 menit) dan batasi maksimal 20 entri
        $queue = array_filter($queue, fn($q) => is_array($q) && ($now - ($q['at'] ?? 0)) < 600);
        if (count($queue) >= 20) $queue = array_slice($queue, -19, null, true);
        $token = bin2hex(random_bytes(16));
        $queue[$token] = ['payload' => $payload, 'at' => $now];
        $_SESSION['print_queue'] = $queue;
        respond(["status" => "success", "token" => $token]);
        break;

    case 'get_print':
        $token = (string)($_GET['token'] ?? '');
        if (!preg_match('/^[a-f0-9]{32}$/', $token)) fail("Token cetak tidak valid.", 400);
        $q = $_SESSION['print_queue'][$token] ?? null;
        if (!$q || (time() - ($q['at'] ?? 0)) >= 600) fail("Data cetak tidak ditemukan atau sudah kedaluwarsa.", 404);
        unset($_SESSION['print_queue'][$token]); // sekali pakai
        respond(["status" => "success", "payload" => $q['payload']]);
        break;

    default:
        fail("Action tidak valid", 404);
}
} catch (PDOException $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("API error [$action]: " . $e->getMessage());
    fail("Terjadi kesalahan pada server.", 500);
}
?>
