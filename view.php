<?php
declare(strict_types=1);

$storageDir = getenv('STORAGE_DIR') ?: __DIR__ . '/app/temp';
$staticUrl = rtrim(getenv('STATIC_URL') ?: '/app/static', '/');

function fail_response(int $status, string $message): void
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    echo $message;
    exit;
}

function h(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function is_uuid(string $value): bool
{
    return (bool) preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $value);
}

function path_starts_with(string $path, string $base): bool
{
    $base = rtrim($base, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
    return strncmp($path, $base, strlen($base)) === 0;
}

function project_id_from_request(): string
{
    $projectId = trim((string) ($_GET['project'] ?? ''));
    if ($projectId !== '') {
        return $projectId;
    }

    $pathInfo = trim((string) ($_SERVER['PATH_INFO'] ?? ''), '/');
    if ($pathInfo === '') {
        return '';
    }
    $parts = explode('/', $pathInfo);
    return trim((string) ($parts[0] ?? ''));
}

function scene_id_from_request(): string
{
    $sceneId = trim((string) ($_GET['scene'] ?? ''));
    if ($sceneId !== '') {
        return $sceneId;
    }

    $pathInfo = trim((string) ($_SERVER['PATH_INFO'] ?? ''), '/');
    if ($pathInfo === '') {
        return '';
    }
    $parts = explode('/', $pathInfo, 3);
    return trim((string) ($parts[1] ?? ''));
}

function project_dir(string $storageDir, string $projectId): string
{
    if (!is_uuid($projectId)) {
        fail_response(404, 'Projeto nao encontrado.');
    }
    $base = realpath($storageDir);
    if ($base === false) {
        fail_response(500, 'Storage nao encontrado.');
    }
    $projectDir = realpath($base . DIRECTORY_SEPARATOR . $projectId);
    if ($projectDir === false || !is_dir($projectDir) || !path_starts_with($projectDir, $base)) {
        fail_response(404, 'Projeto nao encontrado.');
    }
    return $projectDir;
}

function mime_type_for(string $filePath): string
{
    $extension = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
    $types = [
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'png' => 'image/png',
        'gif' => 'image/gif',
        'webp' => 'image/webp',
        'tif' => 'image/tiff',
        'tiff' => 'image/tiff',
        'json' => 'application/json',
    ];
    return $types[$extension] ?? 'application/octet-stream';
}

function serve_project_asset(string $projectDir, string $asset): void
{
    $asset = str_replace('\\', '/', rawurldecode($asset));
    if ($asset === '' || $asset[0] === '/' || strpos($asset, "\0") !== false) {
        fail_response(404, 'Arquivo nao encontrado.');
    }
    $filePath = realpath($projectDir . DIRECTORY_SEPARATOR . $asset);
    if ($filePath === false || !is_file($filePath) || !path_starts_with($filePath, $projectDir)) {
        fail_response(404, 'Arquivo nao encontrado.');
    }
    header('Content-Type: ' . mime_type_for($filePath));
    header('Content-Length: ' . filesize($filePath));
    header('Cache-Control: public, max-age=86400');
    readfile($filePath);
    exit;
}

function trusted_proxy_headers_enabled(): bool
{
    $value = strtolower(trim((string) (getenv('TRUST_PROXY_HEADERS') ?: 'true')));
    return !in_array($value, ['0', 'false', 'no', 'off'], true);
}

function normalized_client_ip(string $value): string
{
    $value = trim($value);
    return filter_var($value, FILTER_VALIDATE_IP) !== false ? $value : '';
}

function request_client_ip(): string
{
    if (trusted_proxy_headers_enabled()) {
        $forwarded = explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''));
        foreach ($forwarded as $candidate) {
            $address = normalized_client_ip($candidate);
            if ($address !== '') {
                return $address;
            }
        }
        $realIp = normalized_client_ip((string) ($_SERVER['HTTP_X_REAL_IP'] ?? ''));
        if ($realIp !== '') {
            return $realIp;
        }
    }
    return normalized_client_ip((string) ($_SERVER['REMOTE_ADDR'] ?? '')) ?: '0.0.0.0';
}

function metrics_sqlite_path(string $storageDir): string
{
    $configured = trim((string) (getenv('METRICS_SQLITE_PATH') ?: ''));
    return $configured !== '' ? $configured : rtrim($storageDir, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'projects.sqlite3';
}

function insert_photo_access_metric(string $databasePath, string $projectId, string $photoId, string $ipAddress, int $accessedAt): bool
{
    $createTable = 'CREATE TABLE IF NOT EXISTS photo_access_logs ('
        . 'id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,'
        . 'project_id VARCHAR(36) NOT NULL,'
        . 'photo_id VARCHAR(255) NOT NULL,'
        . 'ip_address VARCHAR(45) NOT NULL,'
        . 'accessed_at BIGINT NOT NULL)';
    $indexes = [
        'CREATE INDEX IF NOT EXISTS ix_photo_access_logs_project_id ON photo_access_logs (project_id)',
        'CREATE INDEX IF NOT EXISTS ix_photo_access_logs_photo_id ON photo_access_logs (photo_id)',
        'CREATE INDEX IF NOT EXISTS ix_photo_access_logs_accessed_at ON photo_access_logs (accessed_at)',
    ];

    try {
        if (class_exists('SQLite3')) {
            $database = new SQLite3($databasePath);
            $database->busyTimeout(3000);
            if (!$database->exec($createTable)) {
                return false;
            }
            foreach ($indexes as $sql) {
                $database->exec($sql);
            }
            $statement = $database->prepare(
                'INSERT INTO photo_access_logs (project_id, photo_id, ip_address, accessed_at) '
                . 'VALUES (:project_id, :photo_id, :ip_address, :accessed_at)'
            );
            if ($statement === false) {
                return false;
            }
            $statement->bindValue(':project_id', $projectId, SQLITE3_TEXT);
            $statement->bindValue(':photo_id', $photoId, SQLITE3_TEXT);
            $statement->bindValue(':ip_address', $ipAddress, SQLITE3_TEXT);
            $statement->bindValue(':accessed_at', $accessedAt, SQLITE3_INTEGER);
            $result = $statement->execute();
            if ($result !== false) {
                $result->finalize();
            }
            $database->close();
            return $result !== false;
        }

        if (class_exists('PDO') && in_array('sqlite', PDO::getAvailableDrivers(), true)) {
            $database = new PDO('sqlite:' . $databasePath);
            $database->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $database->exec('PRAGMA busy_timeout = 3000');
            $database->exec($createTable);
            foreach ($indexes as $sql) {
                $database->exec($sql);
            }
            $statement = $database->prepare(
                'INSERT INTO photo_access_logs (project_id, photo_id, ip_address, accessed_at) '
                . 'VALUES (:project_id, :photo_id, :ip_address, :accessed_at)'
            );
            return $statement->execute([
                ':project_id' => $projectId,
                ':photo_id' => $photoId,
                ':ip_address' => $ipAddress,
                ':accessed_at' => $accessedAt,
            ]);
        }
    } catch (Throwable $error) {
        return false;
    }
    return false;
}

function record_photo_access_metric(string $storageDir, string $projectId, array $project): void
{
    if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'POST') {
        fail_response(405, 'Metodo nao permitido.');
    }
    $raw = (string) file_get_contents('php://input');
    if (strlen($raw) > 4096) {
        fail_response(413, 'Payload de metrica muito grande.');
    }
    $payload = json_decode($raw, true);
    $photoId = is_array($payload) ? trim((string) ($payload['photoId'] ?? '')) : '';
    if ($photoId === '' || strlen($photoId) > 255) {
        fail_response(400, 'ID da foto invalido.');
    }
    $photoExists = false;
    foreach (($project['scenes'] ?? []) as $scene) {
        if (is_array($scene) && (string) ($scene['id'] ?? '') === $photoId) {
            $photoExists = true;
            break;
        }
    }
    if (!$photoExists) {
        fail_response(404, 'Foto nao encontrada neste projeto.');
    }
    if (!insert_photo_access_metric(metrics_sqlite_path($storageDir), $projectId, $photoId, request_client_ip(), time())) {
        fail_response(503, 'Nao foi possivel salvar a metrica.');
    }
    http_response_code(204);
    header('Cache-Control: no-store');
    exit;
}

$projectId = project_id_from_request();
$projectDir = project_dir($storageDir, $projectId);

if (array_key_exists('asset', $_GET)) {
    serve_project_asset($projectDir, (string) $_GET['asset']);
}

$projectFile = $projectDir . DIRECTORY_SEPARATOR . 'project.json';
if (!is_file($projectFile)) {
    fail_response(404, 'project.json nao encontrado.');
}

$project = json_decode((string) file_get_contents($projectFile), true);
if (!is_array($project)) {
    fail_response(500, 'project.json invalido.');
}
$project['settings'] = is_array($project['settings'] ?? null) ? $project['settings'] : [];
$project['scenes'] = is_array($project['scenes'] ?? null) ? $project['scenes'] : [];

if ((string) ($_GET['metric'] ?? '') === 'photo_access') {
    record_photo_access_metric($storageDir, $projectId, $project);
}

$projectJson = json_encode(
    $project,
    JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
);
if ($projectJson === false) {
    fail_response(500, 'Falha ao gerar JSON do projeto.');
}

$scriptName = (string) ($_SERVER['SCRIPT_NAME'] ?? '/view.php');
$assetBase = $scriptName . '?project=' . rawurlencode($projectId) . '&asset=';
$metricsUrl = $scriptName . '?project=' . rawurlencode($projectId) . '&metric=photo_access';
$initialSceneId = scene_id_from_request();
$showBtnList = strtolower((string) ($_GET['showBtnList'] ?? 'true')) === 'false' ? 'false' : 'true';
?>
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Visualizar tour</title>
  <link rel="stylesheet" href="<?= h($staticUrl) ?>/viewer.css?v=project-view-27">
</head>
<body class="tour-view" data-project-id="<?= h($projectId) ?>" data-initial-scene-id="<?= h($initialSceneId) ?>" data-show-btn-list="<?= h($showBtnList) ?>" data-project-file-base="<?= h($assetBase) ?>" data-metrics-url="<?= h($metricsUrl) ?>">
  <div id="pano"></div>
  <svg id="annotationOverlay" class="annotation-overlay" aria-label="Anotações da vista"></svg>
  <div id="sketchToolbar" class="sketch-toolbar" aria-label="Ferramentas de esboço">
    <span>Esboço</span>
    <button type="button" data-sketch-mode="draw">Rabisco</button>
    <button type="button" data-sketch-mode="text">Texto</button>
    <button type="button" data-sketch-mode="polygon">Polígono</button>
    <button type="button" data-sketch-mode="edit">Editar</button>
    <button type="button" id="sketchFinishPolygon">Fechar</button>
    <button type="button" id="sketchUndo">Desfazer</button>
    <button type="button" id="sketchClear">Limpar</button>
  </div>

  <section id="emptyState" class="empty-state" hidden>
    <div id="emptyCover" class="empty-cover"></div>
    <div class="empty-copy">
      <strong id="emptyTitle">Tour 360</strong>
      <span id="emptyMessage">Nenhum panorama processado neste projeto.</span>
    </div>
  </section>

  <nav id="sceneList" aria-label="Cenas do tour">
    <ul class="scenes" id="sceneItems"></ul>
  </nav>

  <header id="titleBar" aria-label="Cabecalho do tour">
    <div class="brandTitle">
      <img class="brandLogo" src="<?= h($staticUrl) ?>/logo.png" alt="">
      <div class="brandText">
        <span class="brandName" id="projectName">Tour 360</span>
        <span class="sceneName" id="sceneName"></span>
      </div>
    </div>
    <div class="viewerActions" aria-label="Acoes do tour">
      <button type="button" id="sceneListToggle" class="header-button scene-list-toggle" aria-label="Alternar lista de cenas">☰</button>
      <button type="button" id="metadataToggle" class="header-button metadata-toggle" aria-controls="metadataPanel" aria-expanded="true">Mapa</button>
      <button type="button" id="sketchToggle" class="header-button sketch-button" aria-label="Ativar esboço">Esboço</button>
      <button type="button" id="printGeoButton" class="header-button print-button" aria-label="Imprimir layout georreferenciado">Print</button>
      <button type="button" id="autorotateToggle" class="header-button autorotate-button" aria-label="Alternar autorrotacao" aria-pressed="false">▶</button>
      <button type="button" id="fullscreenToggle" class="header-button fullscreen-button" aria-label="Alternar tela cheia">⛶</button>
    </div>
  </header>

  <section id="metadataPanel" class="metadata-panel" aria-label="Mapa e metadados da foto">
    <div class="metadata-panel-header">
      <strong>Local da foto</strong>
      <button type="button" id="metadataClose">Ocultar</button>
    </div>
    <div id="photoMap" class="photo-map" aria-label="Mapa da foto">
      <div id="mapTiles" class="map-tiles"></div>
      <div id="mapMarkers" class="map-markers"></div>
      <div class="photo-map-controls" aria-label="Controles do mapa">
        <button type="button" id="mapZoomIn" aria-label="Aproximar mapa">+</button>
        <button type="button" id="mapZoomOut" aria-label="Afastar mapa">-</button>
        <button type="button" id="mapRecenter" aria-label="Centralizar mapa">•</button>
        <button type="button" id="mapExpandToggle" aria-label="Ampliar mapa" aria-pressed="false">⛶</button>
      </div>
    </div>
    <dl class="metadata-list">
      <div>
        <dt>Coordenadas</dt>
        <dd id="metadataCoords">Sem coordenadas</dd>
      </div>
      <div>
        <dt>Altitude</dt>
        <dd id="metadataAltitude">Sem altitude</dd>
      </div>
      <div>
        <dt>Altura</dt>
        <dd id="metadataHeight">Sem altura</dd>
      </div>
      <div>
        <dt>Data</dt>
        <dd id="metadataDate">Sem data</dd>
      </div>
      <div id="metadataPhotoRow">
        <dt>Foto</dt>
        <dd id="metadataPhoto">Sem foto</dd>
      </div>
    </dl>
  </section>

  <div id="viewControls" class="view-controls" aria-label="Controles de navegacao">
    <button type="button" id="viewUp" class="viewControlButton viewControlButton-1" aria-label="Olhar para cima">▲</button>
    <button type="button" id="viewDown" class="viewControlButton viewControlButton-2" aria-label="Olhar para baixo">▼</button>
    <button type="button" id="viewLeft" class="viewControlButton viewControlButton-3" aria-label="Olhar para esquerda">◀</button>
    <button type="button" id="viewRight" class="viewControlButton viewControlButton-4" aria-label="Olhar para direita">▶</button>
    <button type="button" id="viewIn" class="viewControlButton viewControlButton-5" aria-label="Aproximar">+</button>
    <button type="button" id="viewOut" class="viewControlButton viewControlButton-6" aria-label="Afastar">-</button>
  </div>

  <div class="viewer-watermark" aria-hidden="true">
    Departamento de Geotecnologia
  </div>

  <section id="printLayout" class="print-layout" aria-hidden="true">
    <header class="print-header">
      <img class="print-logo" src="<?= h($staticUrl) ?>/logo.png" alt="">
      <div class="print-title">
        <span>Departamento de Geotecnologia</span>
        <h1>Registro fotografico georreferenciado</h1>
        <p id="printProjectName">Tour 360</p>
      </div>
      <div class="print-system">
        <strong>WGS84</strong>
        <span>EPSG:4326</span>
        <span id="printGeneratedAt"></span>
      </div>
    </header>

    <main class="print-main">
      <section class="print-card print-pano-card">
        <div class="print-card-title">
          <h2>Vista 360</h2>
          <span id="printSceneTitle"></span>
        </div>
        <div class="print-pano-frame">
          <div id="printPanoLive" class="print-pano-live" aria-label="Vista atual do panorama"></div>
          <svg id="printAnnotationOverlay" class="print-annotation-overlay" aria-label="Anotações impressas"></svg>
          <div id="printPanoFallback" class="print-fallback">Preparando vista 360.</div>
        </div>
      </section>

      <section class="print-grid">
        <div class="print-card">
          <div class="print-card-title">
            <h2>Mapa georreferenciado</h2>
            <span>Norte acima</span>
          </div>
          <div id="printMap" class="print-map">
            <div id="printMapTiles" class="print-map-tiles"></div>
            <div id="printMapMarker" class="print-map-marker">
              <span id="printMapView" class="print-map-view">
                <span id="printMapCone" class="print-map-cone"></span>
              </span>
            </div>
            <div id="printMapFallback" class="print-map-fallback">Sem coordenadas para mapa.</div>
            <div class="print-map-north">N</div>
            <div class="print-map-crs">WGS84 / EPSG:4326</div>
          </div>
        </div>

        <div class="print-card">
          <div class="print-card-title">
            <h2>Dados da foto</h2>
            <span id="printPhotoName"></span>
          </div>
          <dl class="print-fields">
            <div><dt>Ponto ArcGIS</dt><dd id="printArcgisPoint">-</dd></div>
            <div><dt>Coordenadas</dt><dd id="printCoords">Sem coordenadas</dd></div>
            <div><dt>Latitude</dt><dd id="printLatitude">-</dd></div>
            <div><dt>Longitude</dt><dd id="printLongitude">-</dd></div>
            <div><dt>Altitude</dt><dd id="printAltitude">-</dd></div>
            <div><dt>Altura</dt><dd id="printHeight">-</dd></div>
            <div><dt>Data da foto</dt><dd id="printPhotoDate">-</dd></div>
            <div><dt>Yaw camera</dt><dd id="printCameraYaw">-</dd></div>
            <div><dt>Yaw visual</dt><dd id="printViewYaw">-</dd></div>
            <div><dt>FOV</dt><dd id="printFov">-</dd></div>
          </dl>
        </div>

      </section>
    </main>

    <footer class="print-footer">
      <span id="printUrl"></span>
      <strong>Departamento de Geotecnologia</strong>
    </footer>
  </section>

  <script src="<?= h($staticUrl) ?>/marzipano.js"></script>
  <script>
    window.__PROJECT_DATA__ = <?= $projectJson ?>;
  </script>
  <script src="<?= h($staticUrl) ?>/viewer.js?v=project-view-32"></script>
</body>
</html>
